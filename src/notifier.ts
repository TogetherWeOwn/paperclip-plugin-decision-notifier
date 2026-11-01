import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STREAM_CHANNEL } from "./manifest.js";
import {
  DEFAULT_RUN_FAILURE_WINDOW_MINUTES,
  MAX_RUN_FAILURE_GROUPS_PER_WINDOW,
  MAX_RUN_FAILURE_WINDOW_MINUTES,
  RUN_FAILURE_RETENTION_MS,
  RUN_FAILURE_STATUSES,
  errorExcerpt,
  errorSignature,
  failedRunFromEvent,
  failureGroupId,
  validIso,
  windowStart,
  type FailedRun,
} from "./run-failures.js";

type Issue = Awaited<ReturnType<PluginContext["issues"]["list"]>>[number];
type Interaction = Awaited<ReturnType<PluginContext["issues"]["listInteractions"]>>[number];
type Approval = Awaited<ReturnType<PluginContext["approvals"]["list"]>>[number];

export type DecisionKind = "approval" | "interaction" | "owner_card";
export type EventKind = DecisionKind | "run_failure";

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

/**
 * Failed agent runs, grouped per (error signature, fixed window) across all
 * agents, so one outage is one item. The one event kind that carries text:
 * `error` is a redacted excerpt of at most 200 characters. It is still
 * untrusted, so re-read the run before acting.
 */
export interface RunFailureEvent {
  kind: "run_failure";
  /**
   * `<group id>@<window start>`: one id per error signature and window. Past
   * the per-window cap, `overflow@<window start>` collects the remaining
   * distinct failures of that window.
   */
  id: string;
  issueIdentifier: string | null;
  /** The latest failed run in the group. */
  url: string;
  /** Window start; stable for the group, so dedupe on kind + id + createdAt works as for decisions. */
  createdAt: string;
  /** Agent of the latest failed run. */
  agentId: string;
  /** Every agent with a failed run in the group, in first-seen order. */
  agentIds: string[];
  count: number;
  firstRunId: string;
  lastRunId: string;
  firstFailedAt: string;
  lastFailedAt: string;
  errorCode: string | null;
  error: string;
}

export type NotifierEvent = DecisionEvent | RunFailureEvent;

interface StoredRunFailure extends RunFailureEvent {
  issueId: string | null;
  /** Every run counted, so the event and the scan never count one run twice. */
  runIds: string[];
  /** Overflow item only: the signature groups it stands in for. */
  groupIds?: string[];
}

type RunFailureMap = Record<string, StoredRunFailure>;

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
  runFailures: { enabled: boolean; windowMs: number };
}

/** Statuses where an owner-assigned card counts as a decision. */
export const OPEN_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
/** Statuses that can hold a pending interaction: Paperclip expires them only on done/cancelled. */
export const INTERACTION_ISSUE_STATUSES = ["backlog", ...OPEN_ISSUE_STATUSES] as const;
const INTERACTION_READ_CONCURRENCY = 8;
/** A catch-up this soon after the previous catch-up scan replays the stored set instead of rescanning. */
export const CATCH_UP_RESCAN_MS = 10_000;
/** Failed runs are reconciled at most this often per company; the cursor makes the interval lossless. */
export const RUN_RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Each reconciliation re-reads this far before its cursor, so a run finishing mid-read is not skipped. */
export const RUN_RECONCILE_OVERLAP_MS = 60_000;
/** Runs `ctx.issues.summaries.getOrchestration` returns per card; it takes no paging parameter. */
const RUN_PAGE_LIMIT = 100;
/** Group id of the item that collects a window's distinct failures past the cap. */
const OVERFLOW_GROUP = "overflow";
const overflowError = (distinct: number) => `${distinct} more distinct failure${distinct === 1 ? "" : "s"}`;

const decisionKey = (kind: DecisionKind, id: string) => `${kind}:${id}`;
const companyStateKey = (companyId: string, stateKey: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  stateKey,
});
const pendingStateKey = (companyId: string) => companyStateKey(companyId, "pending");
const runFailuresStateKey = (companyId: string) => companyStateKey(companyId, "run-failures");
const runCursorStateKey = (companyId: string) => companyStateKey(companyId, "run-failure-cursor");

export function toEvent(decision: DecisionEvent): DecisionEvent {
  const { kind, id, issueIdentifier, url, createdAt } = decision;
  return { kind, id, issueIdentifier, url, createdAt };
}

export function toRunFailureEvent(group: RunFailureEvent): RunFailureEvent {
  const { kind, id, issueIdentifier, url, createdAt, agentId, agentIds, count, firstRunId, lastRunId, firstFailedAt, lastFailedAt, errorCode, error } =
    group;
  return {
    kind,
    id,
    issueIdentifier,
    url,
    createdAt,
    agentId,
    agentIds,
    count,
    firstRunId,
    lastRunId,
    firstFailedAt,
    lastFailedAt,
    errorCode,
    error,
  };
}

/** The public form of any stored item. */
export function toPublic(item: NotifierEvent): NotifierEvent {
  return item.kind === "run_failure" ? toRunFailureEvent(item) : toEvent(item);
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
  /** Each company's last catch-up scan: when it finished and the config it used. */
  private readonly lastCatchUpScan = new Map<string, { at: number; config: string }>();
  /** When each company's failed runs were last reconciled. */
  private readonly lastRunReconcile = new Map<string, number>();

  constructor(private readonly ctx: PluginContext) {}

  /** Reconcile every company. One failing company, or one failing part, does not stop the others. */
  async scanAll(): Promise<void> {
    const companies = await this.ctx.companies.list();
    for (const company of companies) {
      try {
        await this.scanCompany(company.id);
      } catch (err) {
        this.ctx.logger.error("decision scan failed", { companyId: company.id, error: String(err) });
      }
      try {
        await this.reconcileRunFailures(company.id);
      } catch (err) {
        this.ctx.logger.error("run failure reconciliation failed", { companyId: company.id, error: String(err) });
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
   * Catch-ups within CATCH_UP_RESCAN_MS of the last catch-up scan, with the
   * same config and prefix, reuse the stored set instead, so a client calling
   * in a loop cannot make the worker rescan the whole company each time.
   * Approval and card events keep that set current; a thread interaction has
   * no event, so the reused set lacks one raised since the last scan until the
   * scan job announces it. Run failure groups still within their retention
   * are replayed too; they are kept current by events and the scan job.
   */
  async catchUp(companyId: string): Promise<NotifierEvent[]> {
    const pending = await this.withLock(companyId, async () => {
      const config = await this.config(companyId);
      const configKey = JSON.stringify(config);
      const last = this.lastCatchUpScan.get(companyId);
      // A negative age means the clock moved back; rescan rather than trust the window.
      const age = last ? Date.now() - last.at : -1;
      let decisions: DecisionEvent[];
      if (last && last.config === configKey && age >= 0 && age < CATCH_UP_RESCAN_MS) {
        decisions = Object.values(await this.load(companyId)).map(toEvent);
      } else {
        decisions = await this.scanLocked(companyId, false);
        this.lastCatchUpScan.set(companyId, { at: Date.now(), config: configKey });
      }
      const cutoff = Date.now() - RUN_FAILURE_RETENTION_MS;
      const failures = config.runFailures.enabled
        ? Object.values(await this.loadRunFailures(companyId))
            .filter((group) => Date.parse(group.lastFailedAt) >= cutoff)
            .map(toRunFailureEvent)
        : [];
      return [...decisions, ...failures];
    });
    for (const event of pending) this.emitEvent(companyId, event);
    return pending;
  }

  /** Count one failed run from an `agent.run.failed` event. Cancelled runs never get here. */
  async onRunFailedEvent(companyId: string, payload: unknown, occurredAt: string, entityId?: string): Promise<void> {
    const run = failedRunFromEvent(payload, occurredAt, entityId);
    if (!run) return;
    await this.withLock(companyId, async () => {
      const config = await this.config(companyId);
      if (!config.runFailures.enabled) return;
      // A card the plugin cannot read still gets its failure announced, just without an identifier.
      const issue = run.issueId ? await this.ctx.issues.get(run.issueId, companyId).catch(() => null) : null;
      await this.recordRunFailures(companyId, [{ run, issueIdentifier: issue?.identifier ?? null }], config);
    });
  }

  /**
   * Safety net for dropped `agent.run.failed` events: read the runs of every
   * open agent-assigned card and count failures since the last cursor. Runs at
   * most once per RUN_RECONCILE_INTERVAL_MS; the cursor only advances after a
   * complete read, and run ids dedupe the overlap with events.
   */
  async reconcileRunFailures(companyId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastRunReconcile.get(companyId);
    if (last !== undefined && now - last >= 0 && now - last < RUN_RECONCILE_INTERVAL_MS) return;
    const config = await this.config(companyId);
    if (!config.runFailures.enabled) return;
    const storedCursor = await this.ctx.state.get(runCursorStateKey(companyId));
    const cursor = validIso(typeof storedCursor === "string" ? storedCursor : null);
    const since = (cursor ? Date.parse(cursor) : now - config.runFailures.windowMs) - RUN_RECONCILE_OVERLAP_MS;
    const issues = (await this.listIssues(companyId)).filter(
      (issue) => issue.assigneeAgentId && hasStatus(issue, OPEN_ISSUE_STATUSES),
    );
    let complete = true;
    // Read outside the lock: this is the slow part, and recording is idempotent per run id.
    const perIssue = await mapLimit(issues, INTERACTION_READ_CONCURRENCY, async (issue) => {
      try {
        const summary = await this.ctx.issues.summaries.getOrchestration({ issueId: issue.id, companyId });
        if (summary.runs.length >= RUN_PAGE_LIMIT) {
          // The SDK call has no paging, so a dropped event for an older run is not recovered.
          this.ctx.logger.warn("run page full; older runs may be unread", { companyId, issueId: issue.id, runs: summary.runs.length });
        }
        const found: Array<{ run: FailedRun; issueIdentifier: string | null }> = [];
        for (const run of summary.runs) {
          const failedAt = validIso(run.finishedAt) ?? validIso(run.createdAt);
          if (!RUN_FAILURE_STATUSES.includes(run.status) || !failedAt || Date.parse(failedAt) < since) continue;
          found.push({
            run: { runId: run.id, agentId: run.agentId, status: run.status, error: run.error, errorCode: null, issueId: issue.id, failedAt },
            issueIdentifier: issue.identifier,
          });
        }
        return found;
      } catch (err) {
        complete = false;
        this.ctx.logger.warn("run read failed", { companyId, issueId: issue.id, error: String(err) });
        return [];
      }
    });
    await this.withLock(companyId, () => this.recordRunFailures(companyId, perIssue.flat(), config));
    if (complete) await this.ctx.state.set(runCursorStateKey(companyId), new Date(now).toISOString());
    this.lastRunReconcile.set(companyId, now);
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

  /**
   * Add failed runs to their groups, drop groups past retention, and emit the
   * groups this call created. A group is announced once; later runs only
   * raise its count. A window holds at most MAX_RUN_FAILURE_GROUPS_PER_WINDOW
   * groups; further distinct failures go to one overflow item for the window.
   * Call with the company lock held.
   */
  private async recordRunFailures(
    companyId: string,
    found: Array<{ run: FailedRun; issueIdentifier: string | null }>,
    config: NotifierConfig,
  ): Promise<void> {
    const stored = await this.loadRunFailures(companyId);
    const cutoff = Date.now() - RUN_FAILURE_RETENTION_MS;
    const next: RunFailureMap = {};
    for (const [key, group] of Object.entries(stored)) {
      if (Date.parse(group.lastFailedAt) >= cutoff) next[key] = group;
    }
    const groupsIn = (start: string) =>
      Object.values(next).filter((group) => group.createdAt === start && !group.groupIds).length;
    // Run id -> group key across all groups: a run whose error text differs
    // between the event and the scan would otherwise land in a second group.
    const seenIn = new Map<string, string>();
    for (const [key, group] of Object.entries(next)) for (const runId of group.runIds) seenIn.set(runId, key);
    const fresh: string[] = [];
    // A group created in this call is announced at the end of it; when an
    // upgrade below retires its key, the fresh list must follow or drop it.
    const dropFresh = (key: string) => {
      const index = fresh.indexOf(key);
      if (index !== -1) fresh.splice(index, 1);
    };
    for (const { run, issueIdentifier } of found) {
      const seenKey = seenIn.get(run.runId);
      if (seenKey) {
        // Seen before (event and scan overlap). Fill in what the first sighting lacked:
        // only the event knows errorCode, and the event's card read may have failed.
        let seen = next[seenKey];
        const patch: Partial<StoredRunFailure> = {};
        if (!seen.groupIds && run.errorCode && !seen.errorCode) patch.errorCode = run.errorCode;
        if (seen.lastRunId === run.runId && seen.issueId === run.issueId && issueIdentifier && !seen.issueIdentifier) {
          patch.issueIdentifier = issueIdentifier;
        }
        if (Object.keys(patch).length > 0) {
          seen = { ...seen, ...patch };
          next[seenKey] = seen;
        }
        const excerpt = errorExcerpt(run.error);
        if (!seen.groupIds && excerpt) {
          if (seen.error === "") {
            // The first sighting had no error text, so the group sits under the
            // shared "<no error>" signature with a blank excerpt. Adopt the
            // recovered error: without text the group's runs were
            // indistinguishable, so the whole group moves to the recovered
            // signature in its existing window (or folds into the group, or
            // overflow item, that already stands in for that signature). Later
            // runs with this error then join it instead of splitting the
            // failure mode into a second group. The group was already
            // announced, so it is not announced again under its new id.
            const groupId = failureGroupId(errorSignature(run.error));
            const targetKey = `${groupId}@${seen.createdAt}`;
            const overflowKey = `${OVERFLOW_GROUP}@${seen.createdAt}`;
            const destKey = next[targetKey]
              ? targetKey
              : next[overflowKey]?.groupIds?.includes(groupId)
                ? overflowKey
                : null;
            if (targetKey === seenKey) {
              next[seenKey] = { ...seen, error: excerpt };
            } else if (!destKey) {
              delete next[seenKey];
              next[targetKey] = { ...seen, id: targetKey, error: excerpt };
              for (const runId of seen.runIds) seenIn.set(runId, targetKey);
              const index = fresh.indexOf(seenKey);
              if (index !== -1) fresh[index] = targetKey;
            } else {
              const dest = next[destKey];
              const sourceFirst = seen.firstFailedAt < dest.firstFailedAt;
              const firstAgents = sourceFirst ? seen.agentIds : dest.agentIds;
              const merged: StoredRunFailure = {
                ...dest,
                agentIds: [...firstAgents, ...(sourceFirst ? dest.agentIds : seen.agentIds).filter((id) => !firstAgents.includes(id))],
                count: dest.count + seen.count,
                runIds: [...dest.runIds, ...seen.runIds.filter((id) => !dest.runIds.includes(id))],
              };
              if (sourceFirst) {
                merged.firstRunId = seen.firstRunId;
                merged.firstFailedAt = seen.firstFailedAt;
                if (!dest.groupIds) merged.error = excerpt;
              }
              if (seen.lastFailedAt >= dest.lastFailedAt) {
                merged.agentId = seen.agentId;
                merged.lastRunId = seen.lastRunId;
                merged.lastFailedAt = seen.lastFailedAt;
                merged.url = seen.url;
                merged.issueId = seen.issueId;
                merged.issueIdentifier = seen.issueIdentifier;
                if (!dest.groupIds) merged.errorCode = seen.errorCode ?? dest.errorCode;
              }
              delete next[seenKey];
              next[destKey] = merged;
              for (const runId of seen.runIds) seenIn.set(runId, destKey);
              dropFresh(seenKey);
            }
          } else if (
            seen.firstRunId === run.runId &&
            seen.error !== excerpt &&
            failureGroupId(errorSignature(run.error)) === seen.id.split("@")[0]
          ) {
            // The excerpt belongs to the first run; if the group adopted a
            // later run's recovered text first, the first run's own text,
            // arriving in the same scan, replaces it.
            next[seenKey] = { ...seen, error: excerpt };
          }
        }
        continue;
      }
      const failedMs = Date.parse(run.failedAt);
      if (failedMs < cutoff) continue;
      const start = new Date(windowStart(failedMs, config.runFailures.windowMs)).toISOString();
      const groupId = failureGroupId(errorSignature(run.error));
      const overflow = !next[`${groupId}@${start}`] && groupsIn(start) >= MAX_RUN_FAILURE_GROUPS_PER_WINDOW;
      const id = `${overflow ? OVERFLOW_GROUP : groupId}@${start}`;
      const group = next[id];
      if (!group) {
        next[id] = {
          kind: "run_failure",
          id,
          issueId: run.issueId,
          issueIdentifier,
          url: this.runUrl(run, config),
          createdAt: start,
          agentId: run.agentId,
          agentIds: [run.agentId],
          count: 1,
          firstRunId: run.runId,
          lastRunId: run.runId,
          firstFailedAt: run.failedAt,
          lastFailedAt: run.failedAt,
          // The overflow item mixes errors, so it has no single code or excerpt.
          errorCode: overflow ? null : run.errorCode,
          error: overflow ? overflowError(1) : errorExcerpt(run.error),
          runIds: [run.runId],
          ...(overflow ? { groupIds: [groupId] } : {}),
        };
        seenIn.set(run.runId, id);
        fresh.push(id);
        continue;
      }
      const updated: StoredRunFailure = {
        ...group,
        agentIds: group.agentIds.includes(run.agentId) ? group.agentIds : [...group.agentIds, run.agentId],
        count: group.count + 1,
        runIds: [...group.runIds, run.runId],
      };
      if (group.groupIds && !group.groupIds.includes(groupId)) {
        updated.groupIds = [...group.groupIds, groupId];
        updated.error = overflowError(updated.groupIds.length);
      }
      if (run.failedAt < group.firstFailedAt) {
        // The earliest run owns all first-run fields, whatever the arrival order.
        updated.firstRunId = run.runId;
        updated.firstFailedAt = run.failedAt;
        if (!updated.groupIds) updated.error = errorExcerpt(run.error);
      }
      if (run.failedAt >= group.lastFailedAt) {
        updated.agentId = run.agentId;
        updated.lastRunId = run.runId;
        updated.lastFailedAt = run.failedAt;
        updated.url = this.runUrl(run, config);
        if (!overflow) updated.errorCode = run.errorCode ?? group.errorCode;
        // The card follows the latest run, including when that run has none.
        updated.issueId = run.issueId;
        updated.issueIdentifier = run.issueId ? issueIdentifier : null;
      }
      next[id] = updated;
      seenIn.set(run.runId, id);
    }
    if (JSON.stringify(next) !== JSON.stringify(stored)) await this.ctx.state.set(runFailuresStateKey(companyId), next);
    for (const id of fresh) this.emitEvent(companyId, next[id]);
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

  private runUrl(run: FailedRun, config: NotifierConfig): string {
    return `${config.publicBaseUrl}/${config.prefix}/agents/${encodeURIComponent(run.agentId)}/runs/${encodeURIComponent(run.runId)}`;
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
    const runFailures =
      raw.runFailures && typeof raw.runFailures === "object" ? (raw.runFailures as Record<string, unknown>) : {};
    const minutes = runFailures.windowMinutes;
    const windowMinutes =
      typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_RUN_FAILURE_WINDOW_MINUTES
        ? minutes
        : DEFAULT_RUN_FAILURE_WINDOW_MINUTES;
    return {
      publicBaseUrl: base,
      ownerUserIds: owners,
      prefix,
      runFailures: { enabled: runFailures.enabled !== false, windowMs: windowMinutes * 60_000 },
    };
  }

  private emit(companyId: string, decision: StoredDecision): void {
    this.emitEvent(companyId, toEvent(decision));
  }

  private emitEvent(companyId: string, event: NotifierEvent): void {
    // emit() has no company argument: the worker routes it to the company the
    // channel was last opened for. Open only on a company change, so a client
    // sees a single `open` event rather than one per decision.
    if (this.openedCompanyId !== companyId) {
      this.ctx.streams.open(STREAM_CHANNEL, companyId);
      this.openedCompanyId = companyId;
    }
    this.ctx.streams.emit(STREAM_CHANNEL, toPublic(event));
  }

  private async load(companyId: string): Promise<PendingMap> {
    const value = await this.ctx.state.get(pendingStateKey(companyId));
    return value && typeof value === "object" ? (value as PendingMap) : {};
  }

  private async loadRunFailures(companyId: string): Promise<RunFailureMap> {
    const value = await this.ctx.state.get(runFailuresStateKey(companyId));
    return value && typeof value === "object" ? (value as RunFailureMap) : {};
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
