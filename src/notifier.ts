import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STREAM_CHANNEL } from "./manifest.js";

type Issue = Awaited<ReturnType<PluginContext["issues"]["list"]>>[number];
type Interaction = Awaited<ReturnType<PluginContext["issues"]["listInteractions"]>>[number];
type Approval = Awaited<ReturnType<PluginContext["approvals"]["list"]>>[number];

export type DecisionKind = "approval" | "interaction" | "owner_card";

/**
 * The only shape that ever leaves the plugin. IDs and URLs only: titles,
 * summaries, payloads and comments are untrusted text and stay in Paperclip.
 */
export interface DecisionEvent {
  kind: DecisionKind;
  id: string;
  issueIdentifier: string | null;
  url: string;
  createdAt: string;
}

/** Stored form: the public event plus the issue it belongs to, for per-issue reconciliation. */
interface StoredDecision extends DecisionEvent {
  issueId: string | null;
}

type PendingMap = Record<string, StoredDecision>;

/** Per-operation settings: plugin config plus the company's current URL prefix. */
interface NotifierConfig {
  publicBaseUrl: string;
  ownerUserIds: string[];
  prefix: string;
}

/** Statuses where an owner-assigned card counts as a decision. */
export const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
/** Statuses that can hold a pending interaction: Paperclip expires them only on done/cancelled. */
export const INTERACTION_ISSUE_STATUSES = ["backlog", ...OPEN_ISSUE_STATUSES] as const;
const INTERACTION_READ_CONCURRENCY = 8;
/** A catch-up this soon after the previous catch-up scan replays the stored set instead of rescanning. */
export const CATCH_UP_RESCAN_MS = 10_000;

const decisionKey = (kind: DecisionKind, id: string) => `${kind}:${id}`;
const pendingStateKey = (companyId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  stateKey: "pending",
});

export function toEvent(decision: DecisionEvent): DecisionEvent {
  const { kind, id, issueIdentifier, url, createdAt } = decision;
  return { kind, id, issueIdentifier, url, createdAt };
}

const isoString = (value: Date | string | null | undefined): string =>
  value ? new Date(value).toISOString() : new Date().toISOString();

const hasStatus = (issue: Issue, statuses: readonly string[]) => statuses.includes(issue.status);

/** Compare pending sets by key and value; key order is not meaningful. */
function samePending(a: PendingMap, b: PendingMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => b[key] !== undefined && JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class DecisionNotifier {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Company the stream channel is currently opened for; emit() routes to it. */
  private openedCompanyId: string | null = null;
  /** When each company's last catch-up scan finished, so a burst of catch-ups costs one scan. */
  private readonly lastCatchUpScanAt = new Map<string, number>();

  constructor(private readonly ctx: PluginContext) {}

  /** Reconcile every company. One failing company does not stop the others. */
  async scanAll(): Promise<void> {
    const companies = await this.ctx.companies.list();
    for (const company of companies) {
      try {
        await this.scanCompany(company.id);
      } catch (err) {
        this.ctx.logger.error("decision scan failed", { companyId: company.id, error: String(err) });
      }
    }
  }

  /**
   * Read every pending decision for a company, emit the ones not seen before,
   * and forget the ones that are no longer pending. Returns all pending events.
   */
  async scanCompany(companyId: string, options: { emitNew?: boolean } = {}): Promise<DecisionEvent[]> {
    // Collect under the lock too, so an event landing mid-scan is not dropped
    // from the stored set and re-announced by the next scan.
    return this.withLock(companyId, () => this.scanLocked(companyId, options.emitNew !== false));
  }

  /**
   * Catch-up for a client that just connected to the stream: rescan, then
   * replay every pending decision onto the stream and return the same list.
   * Catch-ups within CATCH_UP_RESCAN_MS of the last catch-up scan reuse the
   * stored set, which events keep current, so a client calling in a loop
   * cannot make the worker rescan the whole company each time.
   */
  async catchUp(companyId: string): Promise<DecisionEvent[]> {
    const pending = await this.withLock(companyId, async () => {
      const lastScan = this.lastCatchUpScanAt.get(companyId);
      if (lastScan !== undefined && Date.now() - lastScan < CATCH_UP_RESCAN_MS) {
        return Object.values(await this.load(companyId)).map(toEvent);
      }
      const scanned = await this.scanLocked(companyId, false);
      this.lastCatchUpScanAt.set(companyId, Date.now());
      return scanned;
    });
    for (const event of pending) this.emitEvent(companyId, event);
    return pending;
  }

  async onApprovalEvent(companyId: string, approvalId: string | undefined): Promise<void> {
    if (!approvalId) return;
    // Read inside the lock: a read taken before a concurrent scan could
    // otherwise restore a decision the scan just saw resolved.
    await this.withLock(companyId, async () => {
      const approval = await this.ctx.approvals.get(approvalId, companyId);
      const decision =
        approval && approval.status === "pending" ? this.approvalDecision(approval, await this.config(companyId)) : null;
      await this.commit(companyId, (stored) => {
        const next = { ...stored };
        const key = decisionKey("approval", approvalId);
        if (decision) next[key] = decision;
        else delete next[key];
        return next;
      });
    });
  }

  /** Re-evaluate one card: its owner assignment and its thread interactions. */
  async onIssueEvent(companyId: string, issueId: string | undefined): Promise<void> {
    if (!issueId) return;
    await this.withLock(companyId, async () => {
      const config = await this.config(companyId);
      const issue = await this.ctx.issues.get(issueId, companyId);
      const ownerCard = issue && this.isOwnerCard(issue, config) ? this.ownerCardDecision(issue, config) : null;
      const canHoldInteractions = issue !== null && hasStatus(issue, INTERACTION_ISSUE_STATUSES);
      const interactions = canHoldInteractions ? await this.interactionDecisions(companyId, issue, config) : {};
      await this.commit(companyId, (stored) => {
        const next: PendingMap = {};
        for (const [key, decision] of Object.entries(stored)) {
          if (decision.issueId !== issueId || decision.kind === "approval") next[key] = decision;
        }
        if (ownerCard) next[decisionKey("owner_card", issueId)] = ownerCard;
        Object.assign(next, interactions);
        return next;
      });
    });
  }

  /** Collect and commit one company. Call with the company lock held. */
  private async scanLocked(companyId: string, emitNew: boolean): Promise<DecisionEvent[]> {
    const current = await this.collect(companyId);
    const next = await this.commit(companyId, () => current, emitNew);
    return Object.values(next).map(toEvent);
  }

  /**
   * Replace the stored set with `build(stored)` and emit the decisions it adds.
   * Fields are refreshed from the latest read (URL config may have changed);
   * only the first-seen createdAt is kept. Call with the company lock held.
   */
  private async commit(
    companyId: string,
    build: (stored: PendingMap) => PendingMap,
    emitNew = true,
  ): Promise<PendingMap> {
    const stored = await this.load(companyId);
    const next: PendingMap = {};
    const fresh: StoredDecision[] = [];
    for (const [key, decision] of Object.entries(build(stored))) {
      const previous = stored[key];
      next[key] = previous ? { ...decision, createdAt: previous.createdAt } : decision;
      if (!previous) fresh.push(decision);
    }
    if (!samePending(next, stored)) await this.save(companyId, next);
    if (emitNew) for (const decision of fresh) this.emit(companyId, decision);
    return next;
  }

  private async collect(companyId: string): Promise<PendingMap> {
    const config = await this.config(companyId);
    const out: PendingMap = {};
    for (const approval of await this.ctx.approvals.list({ companyId, status: "pending" })) {
      out[decisionKey("approval", approval.id)] = this.approvalDecision(approval, config);
    }
    const issues = await this.listIssues(companyId);
    for (const issue of issues) {
      if (this.isOwnerCard(issue, config)) {
        out[decisionKey("owner_card", issue.id)] = this.ownerCardDecision(issue, config);
      }
    }
    const perIssue = await mapLimit(issues, INTERACTION_READ_CONCURRENCY, (issue) =>
      this.interactionDecisions(companyId, issue, config),
    );
    for (const decisions of perIssue) Object.assign(out, decisions);
    return out;
  }

  private async listIssues(companyId: string): Promise<Issue[]> {
    // No limit/offset: in 2026.1023.0 the host applies `offset` twice for
    // plugin issue lists (SQL, then again in applyWindow), so page 2 is always
    // empty. Without a limit the host returns every matching row.
    const out: Issue[] = [];
    for (const status of INTERACTION_ISSUE_STATUSES) {
      out.push(...(await this.ctx.issues.list({ companyId, status })));
    }
    return out;
  }

  private isOwnerCard(issue: Issue, config: NotifierConfig): boolean {
    if (!issue.assigneeUserId || !hasStatus(issue, OPEN_ISSUE_STATUSES)) return false;
    return config.ownerUserIds.length === 0 || config.ownerUserIds.includes(issue.assigneeUserId);
  }

  /**
   * A board decision is a pending interaction not addressed to an agent.
   * Agent-addressed interactions already wake that agent natively.
   */
  private isBoardInteraction(interaction: Interaction): boolean {
    return interaction.status === "pending" && !interaction.addresseeAgentId;
  }

  private async interactionDecisions(companyId: string, issue: Issue, config: NotifierConfig): Promise<PendingMap> {
    const out: PendingMap = {};
    const interactions = await this.ctx.issues.listInteractions(issue.id, companyId);
    for (const interaction of interactions) {
      if (!this.isBoardInteraction(interaction)) continue;
      out[decisionKey("interaction", interaction.id)] = {
        kind: "interaction",
        id: interaction.id,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        url: this.issueUrl(issue, config),
        createdAt: isoString(interaction.createdAt),
      };
    }
    return out;
  }

  private ownerCardDecision(issue: Issue, config: NotifierConfig): StoredDecision {
    return {
      kind: "owner_card",
      id: issue.id,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      url: this.issueUrl(issue, config),
      // The card's last change is the closest available stamp for the assignment.
      createdAt: isoString(issue.updatedAt),
    };
  }

  private approvalDecision(approval: Approval, config: NotifierConfig): StoredDecision {
    return {
      kind: "approval",
      id: approval.id,
      issueId: null,
      issueIdentifier: null,
      url: `${config.publicBaseUrl}/${config.prefix}/approvals/${encodeURIComponent(approval.id)}`,
      createdAt: isoString(approval.createdAt),
    };
  }

  private issueUrl(issue: Issue, config: NotifierConfig): string {
    return `${config.publicBaseUrl}/${config.prefix}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`;
  }

  private async config(companyId: string): Promise<NotifierConfig> {
    const raw = await this.ctx.config.get(companyId);
    const base = typeof raw.publicBaseUrl === "string" ? raw.publicBaseUrl.trim().replace(/\/+$/, "") : "";
    const owners = Array.isArray(raw.ownerUserIds)
      ? raw.ownerUserIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    // Read the prefix per operation, not once per worker: a company rename changes it.
    const company = await this.ctx.companies.get(companyId);
    const prefix = encodeURIComponent(company?.issuePrefix ?? companyId);
    return { publicBaseUrl: base, ownerUserIds: owners, prefix };
  }

  private emit(companyId: string, decision: StoredDecision): void {
    this.emitEvent(companyId, toEvent(decision));
  }

  private emitEvent(companyId: string, event: DecisionEvent): void {
    // emit() has no company argument: the worker routes it to the company the
    // channel was last opened for. Open only on a company change, so a client
    // sees a single `open` event rather than one per decision.
    if (this.openedCompanyId !== companyId) {
      this.ctx.streams.open(STREAM_CHANNEL, companyId);
      this.openedCompanyId = companyId;
    }
    this.ctx.streams.emit(STREAM_CHANNEL, toEvent(event));
  }

  private async load(companyId: string): Promise<PendingMap> {
    const value = await this.ctx.state.get(pendingStateKey(companyId));
    return value && typeof value === "object" ? (value as PendingMap) : {};
  }

  private async save(companyId: string, map: PendingMap): Promise<void> {
    await this.ctx.state.set(pendingStateKey(companyId), map);
  }

  /** Serialise read-modify-write of one company's pending set (scan vs. events). */
  private withLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(companyId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(companyId, settled);
    void settled.then(() => {
      if (this.locks.get(companyId) === settled) this.locks.delete(companyId);
    });
    return run;
  }
}
