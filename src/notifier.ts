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

interface NotifierConfig {
  publicBaseUrl: string;
  ownerUserIds: string[];
}

/** Statuses whose cards can hold a pending decision. Backlog, done and cancelled cards cannot. */
export const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
const PAGE_SIZE = 200;
const INTERACTION_READ_CONCURRENCY = 8;

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
  private readonly prefixes = new Map<string, string>();
  /** Company the stream channel is currently opened for; emit() routes to it. */
  private openedCompanyId: string | null = null;

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
    return this.withLock(companyId, async () => {
      const current = await this.collect(companyId);
      const stored = await this.load(companyId);
      const next: PendingMap = {};
      const fresh: StoredDecision[] = [];
      for (const [key, decision] of Object.entries(current)) {
        // Keep the first-seen record so createdAt stays stable across scans.
        next[key] = stored[key] ?? decision;
        if (!stored[key]) fresh.push(decision);
      }
      await this.save(companyId, next);
      if (options.emitNew !== false) {
        for (const decision of fresh) this.emit(companyId, decision);
      }
      return Object.values(next).map(toEvent);
    });
  }

  /**
   * Catch-up for a client that just connected to the stream: rescan, then
   * replay every pending decision onto the stream and return the same list.
   */
  async catchUp(companyId: string): Promise<DecisionEvent[]> {
    const pending = await this.scanCompany(companyId, { emitNew: false });
    for (const event of pending) this.emitEvent(companyId, event);
    return pending;
  }

  async onApprovalEvent(companyId: string, approvalId: string | undefined): Promise<void> {
    if (!approvalId) return;
    const approval = await this.ctx.approvals.get(approvalId, companyId);
    const decision = approval && approval.status === "pending" ? await this.approvalDecision(companyId, approval) : null;
    await this.reconcile(companyId, (map) => {
      const key = decisionKey("approval", approvalId);
      if (decision) map[key] ??= decision;
      else delete map[key];
    });
  }

  /** Re-evaluate one card: its owner assignment and its thread interactions. */
  async onIssueEvent(companyId: string, issueId: string | undefined): Promise<void> {
    if (!issueId) return;
    const config = await this.config(companyId);
    const issue = await this.ctx.issues.get(issueId, companyId);
    const open = issue !== null && (OPEN_ISSUE_STATUSES as readonly string[]).includes(issue.status);
    const ownerCard = open && this.isOwnerCard(issue, config) ? await this.ownerCardDecision(companyId, issue, config) : null;
    const interactions = open ? await this.interactionDecisions(companyId, issue, config) : {};
    await this.reconcile(companyId, (map) => {
      const ownerKey = decisionKey("owner_card", issueId);
      if (ownerCard) map[ownerKey] ??= ownerCard;
      else delete map[ownerKey];
      for (const [key, decision] of Object.entries(map)) {
        if (decision.kind === "interaction" && decision.issueId === issueId && !interactions[key]) delete map[key];
      }
      for (const [key, decision] of Object.entries(interactions)) map[key] ??= decision;
    });
  }

  /** Apply a change to the stored set under the company lock and emit what it added. */
  private async reconcile(companyId: string, mutate: (map: PendingMap) => void): Promise<void> {
    await this.withLock(companyId, async () => {
      const stored = await this.load(companyId);
      const next: PendingMap = { ...stored };
      mutate(next);
      const fresh = Object.entries(next).filter(([key]) => !stored[key]).map(([, decision]) => decision);
      const changed = fresh.length > 0 || Object.keys(stored).some((key) => !next[key]);
      if (!changed) return;
      await this.save(companyId, next);
      for (const decision of fresh) this.emit(companyId, decision);
    });
  }

  private async collect(companyId: string): Promise<PendingMap> {
    const config = await this.config(companyId);
    const out: PendingMap = {};
    for (const approval of await this.ctx.approvals.list({ companyId, status: "pending" })) {
      out[decisionKey("approval", approval.id)] = await this.approvalDecision(companyId, approval);
    }
    const issues = await this.listOpenIssues(companyId);
    for (const issue of issues) {
      if (this.isOwnerCard(issue, config)) {
        out[decisionKey("owner_card", issue.id)] = await this.ownerCardDecision(companyId, issue, config);
      }
    }
    const perIssue = await mapLimit(issues, INTERACTION_READ_CONCURRENCY, (issue) =>
      this.interactionDecisions(companyId, issue, config),
    );
    for (const decisions of perIssue) Object.assign(out, decisions);
    return out;
  }

  private async listOpenIssues(companyId: string): Promise<Issue[]> {
    const out: Issue[] = [];
    for (const status of OPEN_ISSUE_STATUSES) {
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await this.ctx.issues.list({ companyId, status, limit: PAGE_SIZE, offset });
        out.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
    }
    return out;
  }

  private isOwnerCard(issue: Issue, config: NotifierConfig): boolean {
    if (!issue.assigneeUserId) return false;
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
        url: await this.issueUrl(companyId, issue, config),
        createdAt: isoString(interaction.createdAt),
      };
    }
    return out;
  }

  private async ownerCardDecision(companyId: string, issue: Issue, config: NotifierConfig): Promise<StoredDecision> {
    return {
      kind: "owner_card",
      id: issue.id,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      url: await this.issueUrl(companyId, issue, config),
      // The card's last change is the closest available stamp for the assignment.
      createdAt: isoString(issue.updatedAt),
    };
  }

  private async approvalDecision(companyId: string, approval: Approval): Promise<StoredDecision> {
    const config = await this.config(companyId);
    const prefix = await this.prefix(companyId);
    return {
      kind: "approval",
      id: approval.id,
      issueId: null,
      issueIdentifier: null,
      url: `${config.publicBaseUrl}/${prefix}/approvals/${encodeURIComponent(approval.id)}`,
      createdAt: isoString(approval.createdAt),
    };
  }

  private async issueUrl(companyId: string, issue: Issue, config: NotifierConfig): Promise<string> {
    const prefix = await this.prefix(companyId);
    return `${config.publicBaseUrl}/${prefix}/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`;
  }

  private async prefix(companyId: string): Promise<string> {
    let prefix = this.prefixes.get(companyId);
    if (prefix === undefined) {
      const company = await this.ctx.companies.get(companyId);
      prefix = encodeURIComponent(company?.issuePrefix ?? companyId);
      this.prefixes.set(companyId, prefix);
    }
    return prefix;
  }

  private async config(companyId: string): Promise<NotifierConfig> {
    const raw = await this.ctx.config.get(companyId);
    const base = typeof raw.publicBaseUrl === "string" ? raw.publicBaseUrl.trim().replace(/\/+$/, "") : "";
    const owners = Array.isArray(raw.ownerUserIds)
      ? raw.ownerUserIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return { publicBaseUrl: base, ownerUserIds: owners };
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
