import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginIssueRunSummary } from "@paperclipai/plugin-sdk";
import manifest, { SCAN_JOB_KEY } from "./manifest.js";
import plugin from "./plugin.js";
import { RUN_RECONCILE_INTERVAL_MS, RUN_RECONCILE_OVERLAP_MS, type NotifierEvent, type RunFailureEvent } from "./notifier.js";

type Seed = Parameters<TestHarness["seed"]>[0];
type Company = NonNullable<Seed["companies"]>[number];
type Issue = NonNullable<Seed["issues"]>[number];

const COMPANY = "c-1";
const NOW = Date.parse("2026-11-01T10:10:00.000Z");
const MODEL_ERROR = "ACP agent reported a terminal service failure: Claude Code 2.1.257 does not support this model";

const issue = (id: string, identifier: string, extra: Partial<Issue> = {}) =>
  ({
    id,
    companyId: COMPANY,
    identifier,
    title: "untrusted",
    status: "blocked",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdAt: new Date("2026-11-01T09:00:00Z"),
    updatedAt: new Date("2026-11-01T10:00:00Z"),
    ...extra,
  }) as unknown as Issue;

const failedPayload = (runId: string, finishedAt: string, extra: Record<string, unknown> = {}) => ({
  runId,
  agentId: "agent-1",
  status: "failed",
  invocationSource: "assignment",
  triggerDetail: null,
  error: `${MODEL_ERROR} (attempt ${runId})`,
  errorCode: "adapter_failed",
  issueId: "i-1",
  startedAt: finishedAt,
  finishedAt,
  ...extra,
});

const runSummary = (id: string, finishedAt: string, extra: Partial<PluginIssueRunSummary> = {}): PluginIssueRunSummary => ({
  id,
  issueId: "i-1",
  agentId: "agent-1",
  status: "failed",
  invocationSource: "assignment",
  triggerDetail: null,
  startedAt: finishedAt,
  finishedAt,
  error: `${MODEL_ERROR} (attempt ${id})`,
  createdAt: finishedAt,
  ...extra,
});

async function setup(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://pc.example.com", ...config } });
  const emitted: NotifierEvent[] = [];
  harness.ctx.streams.open = () => {};
  harness.ctx.streams.emit = (_channel, event) => {
    emitted.push(event as NotifierEvent);
  };
  harness.seed({
    companies: [{ id: COMPANY, name: "Co", issuePrefix: "TWO" } as unknown as Company],
    issues: [issue("i-1", "TWO-7")],
  });
  const runs: Record<string, PluginIssueRunSummary[]> = {};
  const reads: string[] = [];
  harness.ctx.issues.summaries.getOrchestration = async ({ issueId }) => {
    reads.push(issueId);
    return { runs: runs[issueId] ?? [] } as Awaited<ReturnType<TestHarness["ctx"]["issues"]["summaries"]["getOrchestration"]>>;
  };
  await plugin.definition.setup(harness.ctx);
  const failures = () => emitted.filter((e): e is RunFailureEvent => e.kind === "run_failure");
  const fail = (runId: string, finishedAt: string, extra: Record<string, unknown> = {}) =>
    harness.emit("agent.run.failed", failedPayload(runId, finishedAt, extra), {
      companyId: COMPANY,
      entityId: runId,
      entityType: "heartbeat_run",
      occurredAt: finishedAt,
    });
  return { harness, emitted, failures, runs, reads, fail };
}

const catchUp = async () => {
  const response = await plugin.definition.onApiRequest!({
    routeKey: "catch-up",
    method: "POST",
    path: "/catch-up",
    params: {},
    query: {},
    body: { companyId: COMPANY },
    actor: { actorType: "user", actorId: "u-1", userId: "u-1" },
    companyId: COMPANY,
    headers: {},
  });
  return (response.body as { pending: NotifierEvent[] }).pending;
};

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("run failures from events", () => {
  it("groups retries of one error into one item, announced once", async () => {
    const { failures, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await fail("run-2", "2026-11-01T10:03:00.000Z");
    await fail("run-3", "2026-11-01T10:05:00.000Z");

    expect(failures()).toHaveLength(1);
    const [first] = failures();
    expect(first).toMatchObject({ count: 1, firstRunId: "run-1", lastRunId: "run-1" });

    const pending = (await catchUp()).filter((e) => e.kind === "run_failure");
    expect(pending).toEqual([
      {
        kind: "run_failure",
        id: first.id,
        issueIdentifier: "TWO-7",
        url: "https://pc.example.com/TWO/agents/agent-1/runs/run-3",
        createdAt: "2026-11-01T10:00:00.000Z",
        agentId: "agent-1",
        agentIds: ["agent-1"],
        count: 3,
        firstRunId: "run-1",
        lastRunId: "run-3",
        firstFailedAt: "2026-11-01T10:01:00.000Z",
        lastFailedAt: "2026-11-01T10:05:00.000Z",
        errorCode: "adapter_failed",
        error: `${MODEL_ERROR} (attempt run-1)`,
      },
    ]);
    expect(first.id).toMatch(/^[0-9a-f]{16}@2026-11-01T10:00:00\.000Z$/);
  });

  it("keeps different errors apart", async () => {
    const { failures, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await fail("run-2", "2026-11-01T10:02:00.000Z", { error: "spawn claude ENOENT" });
    expect(new Set(failures().map((f) => f.id)).size).toBe(2);
  });

  it("makes one item for one error across agents, listing them", async () => {
    const { failures, fail } = await setup();
    const error = "Reconnect or validate the selected AI account";
    await fail("run-1", "2026-11-01T10:01:00.000Z", { error, agentId: "agent-1" });
    await fail("run-2", "2026-11-01T10:02:00.000Z", { error, agentId: "agent-2" });
    await fail("run-3", "2026-11-01T10:03:00.000Z", { error, agentId: "agent-3" });
    await fail("run-4", "2026-11-01T10:04:00.000Z", { error, agentId: "agent-1" });
    expect(failures()).toHaveLength(1);
    const [group] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(group).toMatchObject({
      count: 4,
      agentId: "agent-1",
      agentIds: ["agent-1", "agent-2", "agent-3"],
      lastRunId: "run-4",
      url: "https://pc.example.com/TWO/agents/agent-1/runs/run-4",
    });
  });

  it("groups 529 overloaded retries that differ only in request and message ids", async () => {
    const { failures, fail } = await setup();
    const overloaded = (requestId: string, messageId: string) =>
      `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"${requestId}"} ${messageId}`;
    await fail("run-1", "2026-11-01T10:01:00.000Z", { error: overloaded("req_011CUa7b3kZ9QwErTyUiOpAs", "msg_01XFDUDYJgAACzvnptvVoYEL") });
    await fail("run-2", "2026-11-01T10:02:00.000Z", {
      error: overloaded("req_011CUb9QpLmNoPqRsTuVwXyZ", "msg_01AbCdEfGhIjKlMnOpQrStUv"),
      agentId: "agent-2",
    });
    expect(failures()).toHaveLength(1);
    const [group] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(group).toMatchObject({ count: 2, agentIds: ["agent-1", "agent-2"] });
  });

  it("caps new items per window and folds the rest into one overflow item", async () => {
    const { failures, fail } = await setup();
    const errors = ["spawn ENOENT", "EACCES", "quota exceeded", "model not found", "bad gateway", "socket hang up", "auth failed", "disk full"];
    for (const [i, error] of errors.entries()) {
      await fail(`run-${i}`, `2026-11-01T10:0${i}:00.000Z`, { error, agentId: `agent-${i}` });
    }
    // A repeat of a capped group and of an overflowed signature: neither is a new item.
    await fail("run-again-1", "2026-11-01T10:20:00.000Z", { error: "EACCES" });
    await fail("run-again-7", "2026-11-01T10:21:00.000Z", { error: "disk full" });

    expect(failures()).toHaveLength(6);
    const overflowId = "overflow@2026-11-01T10:00:00.000Z";
    expect(failures().map((f) => f.id).filter((id) => id.startsWith("overflow@"))).toEqual([overflowId]);
    expect(failures().find((f) => f.id === overflowId)).toMatchObject({ error: "1 more distinct failure", count: 1 });

    const pending = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(pending).toHaveLength(6);
    expect(pending.find((f) => f.id === overflowId)).toMatchObject({
      error: "3 more distinct failures",
      errorCode: null,
      count: 4,
      agentIds: ["agent-5", "agent-6", "agent-7", "agent-1"],
      lastRunId: "run-again-7",
    });
    expect(pending.find((f) => f.error === "EACCES")).toMatchObject({ count: 2 });

    // The next window starts with a fresh allowance. (Catch-up replayed the stored items onto the stream.)
    const replayed = failures().length;
    await fail("run-next", "2026-11-01T10:31:00.000Z", { error: "socket hang up" });
    expect(failures().slice(replayed)).toMatchObject([{ error: "socket hang up", createdAt: "2026-11-01T10:30:00.000Z" }]);
  });

  it("starts a new item in the next window", async () => {
    const { failures, fail } = await setup();
    await fail("run-1", "2026-11-01T10:29:00.000Z");
    await fail("run-2", "2026-11-01T10:31:00.000Z");
    expect(failures().map((f) => f.createdAt)).toEqual(["2026-11-01T10:00:00.000Z", "2026-11-01T10:30:00.000Z"]);
    expect(failures()[0].id.split("@")[0]).toBe(failures()[1].id.split("@")[0]);
  });

  it("honours a configured window length", async () => {
    const { failures, fail } = await setup({ runFailures: { windowMinutes: 5 } });
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await fail("run-2", "2026-11-01T10:06:00.000Z");
    expect(failures().map((f) => f.createdAt)).toEqual(["2026-11-01T10:00:00.000Z", "2026-11-01T10:05:00.000Z"]);
  });

  it("falls back to the default window for an invalid length", async () => {
    const { failures, fail } = await setup({ runFailures: { windowMinutes: 0 } });
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await fail("run-2", "2026-11-01T10:20:00.000Z");
    expect(failures()).toHaveLength(1);
  });

  it("counts a redelivered event once and does not re-announce after a worker restart", async () => {
    const { harness, failures, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await plugin.definition.setup(harness.ctx);
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await fail("run-2", "2026-11-01T10:02:00.000Z");
    expect(failures()).toHaveLength(1);
    const [group] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(group.count).toBe(2);
  });

  it("never announces cancelled runs", async () => {
    const { harness, failures, fail, runs } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z", { status: "cancelled" });
    await harness.emit("agent.run.cancelled", failedPayload("run-2", "2026-11-01T10:02:00.000Z", { status: "cancelled" }), {
      companyId: COMPANY,
    });
    runs["i-1"] = [runSummary("run-3", "2026-11-01T10:03:00.000Z", { status: "cancelled" })];
    await harness.runJob(SCAN_JOB_KEY);
    expect(failures()).toEqual([]);
    expect((await catchUp()).some((e) => e.kind === "run_failure")).toBe(false);
  });

  it("announces timed-out runs", async () => {
    const { failures, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z", { status: "timed_out", error: "Timed out after 900s" });
    expect(failures()).toHaveLength(1);
  });

  it("redacts secrets in the excerpt and caps it at 200 characters", async () => {
    const { failures, fail } = await setup();
    const error = `401 from upstream: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv contact ops@example.com ${"padding ".repeat(40)}`;
    await fail("run-1", "2026-11-01T10:01:00.000Z", { error });
    const [group] = failures();
    expect(group.error.length).toBeLessThanOrEqual(200);
    expect(group.error).not.toContain("abcdefghijklmnop");
    expect(group.error).not.toContain("sk-ant");
    expect(group.error).not.toContain("ops@example.com");
    expect(group.error).toContain("[redacted]");
  });

  it("announces a failure without an identifier when the card cannot be read", async () => {
    const { failures, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z", { issueId: "i-private" });
    await fail("run-2", "2026-11-01T10:02:00.000Z", { issueId: null, error: "no issue" });
    expect(failures().map((f) => f.issueIdentifier)).toEqual([null, null]);
  });

  it("drops the card identifier when the latest run in a group has no card", async () => {
    const { fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await fail("run-2", "2026-11-01T10:02:00.000Z", { issueId: null });
    const [group] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(group).toMatchObject({ count: 2, lastRunId: "run-2", issueIdentifier: null });
  });

  it("takes the excerpt from whichever run failed first, whatever the arrival order", async () => {
    const { fail } = await setup();
    await fail("run-2", "2026-11-01T10:04:00.000Z");
    await fail("run-1", "2026-11-01T10:02:00.000Z");
    const [group] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(group).toMatchObject({
      firstRunId: "run-1",
      firstFailedAt: "2026-11-01T10:02:00.000Z",
      error: `${MODEL_ERROR} (attempt run-1)`,
    });
  });

  it("does nothing when disabled", async () => {
    const { failures, fail, harness, runs, reads } = await setup({ runFailures: { enabled: false } });
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    runs["i-1"] = [runSummary("run-2", "2026-11-01T10:02:00.000Z")];
    await harness.runJob(SCAN_JOB_KEY);
    expect(failures()).toEqual([]);
    expect(reads).toEqual([]);
    expect((await catchUp()).some((e) => e.kind === "run_failure")).toBe(false);
  });

  it("ignores runs older than the retention", async () => {
    const { failures, fail } = await setup();
    await fail("run-1", "2026-10-31T10:00:00.000Z");
    expect(failures()).toEqual([]);
  });

  it("prunes stored groups 24 hours after their last failure", async () => {
    const { harness, fail } = await setup();
    const stored = () =>
      Object.keys(harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "run-failures" }) as object);
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    const [oldId] = stored();
    advance(24 * 60 * 60_000);
    await fail("run-2", "2026-11-02T10:05:00.000Z");
    expect(stored()).toHaveLength(1);
    expect(stored()).not.toContain(oldId);
  });

  it("stops replaying stored groups once disabled", async () => {
    const { harness, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    expect((await catchUp()).some((e) => e.kind === "run_failure")).toBe(true);
    harness.setConfig({ publicBaseUrl: "https://pc.example.com", runFailures: { enabled: false } });
    expect((await catchUp()).some((e) => e.kind === "run_failure")).toBe(false);
  });

  it("drops groups from catch-up 24 hours after their last failure", async () => {
    const { fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    expect((await catchUp()).filter((e) => e.kind === "run_failure")).toHaveLength(1);
    advance(24 * 60 * 60_000);
    expect((await catchUp()).filter((e) => e.kind === "run_failure")).toHaveLength(0);
  });
});

describe("run failure reconciliation", () => {
  it("finds failed runs with no event at all", async () => {
    const { harness, failures, runs } = await setup();
    runs["i-1"] = [
      runSummary("run-2", "2026-11-01T10:04:00.000Z"),
      runSummary("run-1", "2026-11-01T10:02:00.000Z"),
      runSummary("run-ok", "2026-11-01T10:03:00.000Z", { status: "succeeded", error: null }),
    ];
    await harness.runJob(SCAN_JOB_KEY);
    expect(failures()).toHaveLength(1);
    const [group] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(group).toMatchObject({
      issueIdentifier: "TWO-7",
      count: 2,
      firstRunId: "run-1",
      lastRunId: "run-2",
      errorCode: null,
      url: "https://pc.example.com/TWO/agents/agent-1/runs/run-2",
    });
  });

  it("does not double count runs the event already reported, and keeps the event's error code", async () => {
    const { harness, failures, runs, fail } = await setup();
    await fail("run-1", "2026-11-01T10:02:00.000Z");
    runs["i-1"] = [runSummary("run-1", "2026-11-01T10:02:00.000Z"), runSummary("run-2", "2026-11-01T10:04:00.000Z")];
    await harness.runJob(SCAN_JOB_KEY);
    expect(failures()).toHaveLength(1);
    const [group] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(group).toMatchObject({ count: 2, lastRunId: "run-2", errorCode: "adapter_failed" });
  });

  it("fills in the error code when the event arrives after the reconciliation", async () => {
    const { harness, failures, runs, fail } = await setup();
    runs["i-1"] = [runSummary("run-1", "2026-11-01T10:02:00.000Z")];
    await harness.runJob(SCAN_JOB_KEY);
    expect(failures()[0].errorCode).toBeNull();
    await fail("run-1", "2026-11-01T10:02:00.000Z");
    expect(failures()).toHaveLength(1);
    const [group] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(group).toMatchObject({ count: 1, errorCode: "adapter_failed" });
  });

  it("re-reads the overlap before its cursor, so a run that finished mid-read is counted", async () => {
    const { harness, failures, runs } = await setup();
    await harness.runJob(SCAN_JOB_KEY);
    // Both finished before the cursor (NOW) but were not visible to the first pass.
    runs["i-1"] = [
      runSummary("run-mid-read", new Date(NOW - RUN_RECONCILE_OVERLAP_MS / 2).toISOString()),
      runSummary("run-too-old", new Date(NOW - RUN_RECONCILE_OVERLAP_MS * 2).toISOString(), { error: "too old" }),
    ];
    advance(RUN_RECONCILE_INTERVAL_MS);
    await harness.runJob(SCAN_JOB_KEY);
    expect(failures().map((f) => f.lastRunId)).toEqual(["run-mid-read"]);
  });

  it("only reads agent-assigned open cards, at most once per interval, and only runs since its cursor", async () => {
    const { harness, failures, runs, reads } = await setup();
    harness.seed({
      issues: [
        issue("i-1", "TWO-7"),
        issue("i-user", "TWO-2", { assigneeAgentId: null, assigneeUserId: "u-1" } as Partial<Issue>),
        issue("i-done", "TWO-3", { status: "done" } as Partial<Issue>),
      ],
    });
    // Older than the first lookback (one window before now, minus the overlap).
    runs["i-1"] = [runSummary("run-old", "2026-11-01T09:30:00.000Z", { error: "old" })];
    await harness.runJob(SCAN_JOB_KEY);
    expect(reads).toEqual(["i-1"]);
    expect(failures()).toEqual([]);

    runs["i-1"].push(runSummary("run-new", "2026-11-01T10:11:00.000Z"));
    advance(60_000);
    await harness.runJob(SCAN_JOB_KEY);
    expect(reads).toEqual(["i-1"]);

    advance(RUN_RECONCILE_INTERVAL_MS);
    await harness.runJob(SCAN_JOB_KEY);
    expect(reads).toEqual(["i-1", "i-1"]);
    expect(failures().map((f) => f.lastRunId)).toEqual(["run-new"]);
  });

  it("fills in a missing card identifier when the scan sees the run again", async () => {
    const { harness, runs, fail } = await setup();
    const real = harness.ctx.issues.get;
    harness.ctx.issues.get = async () => {
      throw new Error("db busy");
    };
    await fail("run-1", "2026-11-01T10:02:00.000Z");
    harness.ctx.issues.get = real;
    runs["i-1"] = [runSummary("run-1", "2026-11-01T10:02:00.000Z")];
    await harness.runJob(SCAN_JOB_KEY);
    const [group] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(group).toMatchObject({ count: 1, issueIdentifier: "TWO-7" });
  });

  it("counts a run once even when the event had no error text and the scan has some", async () => {
    const { harness, failures, runs, fail } = await setup();
    await fail("run-1", "2026-11-01T10:02:00.000Z", { error: null });
    runs["i-1"] = [runSummary("run-1", "2026-11-01T10:02:00.000Z")];
    await harness.runJob(SCAN_JOB_KEY);
    expect(failures()).toHaveLength(1);
    const pending = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(pending).toHaveLength(1);
    expect(pending[0].count).toBe(1);
  });

  it("upgrades an empty-error group to the recovered error, so later runs join it instead of splitting", async () => {
    const { harness, failures, runs, fail } = await setup();
    await fail("run-1", "2026-11-01T10:02:00.000Z", { error: null });
    const [blank] = failures();
    expect(blank.error).toBe("");
    runs["i-1"] = [runSummary("run-1", "2026-11-01T10:02:00.000Z")];
    await harness.runJob(SCAN_JOB_KEY);
    // The group was already announced; the upgrade does not announce it again.
    expect(failures()).toHaveLength(1);

    const [upgraded] = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(upgraded).toMatchObject({
      count: 1,
      firstRunId: "run-1",
      lastRunId: "run-1",
      errorCode: "adapter_failed",
      error: `${MODEL_ERROR} (attempt run-1)`,
      createdAt: blank.createdAt,
    });
    expect(upgraded.id).not.toBe(blank.id);

    // A later run with the recovered error joins the upgraded group.
    await fail("run-2", "2026-11-01T10:04:00.000Z");
    const pending = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: upgraded.id, count: 2, lastRunId: "run-2" });
  });

  it("folds an upgraded empty-error group into the group that later runs already formed", async () => {
    const { harness, failures, runs, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z", { error: null });
    // The later run formed its group without an error code; the earlier blank
    // run's event code is the only one known, so the merge must keep it.
    await fail("run-2", "2026-11-01T10:03:00.000Z", { errorCode: null });
    expect(failures()).toHaveLength(2);
    const formedId = failures()[1].id;
    runs["i-1"] = [runSummary("run-2", "2026-11-01T10:03:00.000Z"), runSummary("run-1", "2026-11-01T10:01:00.000Z")];
    await harness.runJob(SCAN_JOB_KEY);

    const pending = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: formedId,
      count: 2,
      firstRunId: "run-1",
      firstFailedAt: "2026-11-01T10:01:00.000Z",
      lastRunId: "run-2",
      errorCode: "adapter_failed",
      error: `${MODEL_ERROR} (attempt run-1)`,
    });
  });

  it("keeps first-seen agent order when an upgraded group folds into an earlier-timestamped group", async () => {
    const { harness, runs, fail } = await setup();
    // agent-2's blank failure is seen first, although agent-1's matching
    // failure is timestamped earlier and so owns the first/last fields.
    await fail("run-2", "2026-11-01T10:04:00.000Z", { error: null, agentId: "agent-2" });
    await fail("run-1", "2026-11-01T10:02:00.000Z", { agentId: "agent-1" });
    runs["i-1"] = [
      runSummary("run-2", "2026-11-01T10:04:00.000Z", { agentId: "agent-2" }),
      runSummary("run-1", "2026-11-01T10:02:00.000Z", { agentId: "agent-1" }),
    ];
    await harness.runJob(SCAN_JOB_KEY);

    const pending = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      count: 2,
      firstRunId: "run-1",
      lastRunId: "run-2",
      agentId: "agent-2",
      agentIds: ["agent-2", "agent-1"],
    });
  });

  it("takes the upgraded excerpt from the first run when the scan returns runs newest first", async () => {
    const { harness, runs, fail } = await setup();
    await fail("run-1", "2026-11-01T10:02:00.000Z", { error: null });
    await fail("run-2", "2026-11-01T10:04:00.000Z", { error: null });
    runs["i-1"] = [runSummary("run-2", "2026-11-01T10:04:00.000Z"), runSummary("run-1", "2026-11-01T10:02:00.000Z")];
    await harness.runJob(SCAN_JOB_KEY);

    const pending = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      count: 2,
      firstRunId: "run-1",
      lastRunId: "run-2",
      error: `${MODEL_ERROR} (attempt run-1)`,
    });
  });

  it("folds an upgraded empty-error group into the overflow item standing in for its recovered error", async () => {
    const { harness, runs, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z", { error: null });
    for (const [i, error] of ["spawn ENOENT", "EACCES", "quota exceeded", "model not found"].entries()) {
      await fail(`run-other-${i}`, "2026-11-01T10:02:00.000Z", { error });
    }
    // The window is at its cap, so this distinct error goes to the overflow item.
    await fail("run-disk", "2026-11-01T10:03:00.000Z", { error: "disk full" });
    runs["i-1"] = [runSummary("run-1", "2026-11-01T10:01:00.000Z", { error: "disk full" })];
    await harness.runJob(SCAN_JOB_KEY);

    const pending = (await catchUp()).filter((e): e is RunFailureEvent => e.kind === "run_failure");
    // The blank group is gone; its run now counts under the overflow item.
    expect(pending.some((f) => f.error === "")).toBe(false);
    expect(pending).toHaveLength(5);
    expect(pending.find((f) => f.id.startsWith("overflow@"))).toMatchObject({
      error: "1 more distinct failure",
      errorCode: null,
      count: 2,
      firstRunId: "run-1",
      lastRunId: "run-disk",
    });
  });

  it("skips backlog cards", async () => {
    const { harness, reads } = await setup();
    harness.seed({ issues: [issue("i-1", "TWO-7"), issue("i-back", "TWO-4", { status: "backlog" } as Partial<Issue>)] });
    await harness.runJob(SCAN_JOB_KEY);
    expect(reads).toEqual(["i-1"]);
  });

  it("warns when a card's run page is full, since older runs may be unread", async () => {
    const { harness, runs } = await setup();
    const warn = vi.spyOn(harness.ctx.logger, "warn");
    runs["i-1"] = Array.from({ length: 100 }, (_, n) =>
      runSummary(`run-ok-${n}`, "2026-11-01T10:01:00.000Z", { status: "succeeded", error: null }),
    );
    await harness.runJob(SCAN_JOB_KEY);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("run page full"), expect.objectContaining({ issueId: "i-1" }));
  });

  it("keeps its cursor when a read fails, so the next pass retries", async () => {
    const { harness, failures, runs } = await setup();
    const real = harness.ctx.issues.summaries.getOrchestration;
    harness.ctx.issues.summaries.getOrchestration = async () => {
      throw new Error("db busy");
    };
    await harness.runJob(SCAN_JOB_KEY);
    harness.ctx.issues.summaries.getOrchestration = real;
    runs["i-1"] = [runSummary("run-1", "2026-11-01T09:45:00.000Z")];
    advance(RUN_RECONCILE_INTERVAL_MS);
    await harness.runJob(SCAN_JOB_KEY);
    expect(failures()).toHaveLength(1);
  });
});

describe("existing kinds", () => {
  it("keep their exact shape next to run failures", async () => {
    const { harness, emitted, fail } = await setup();
    harness.seed({
      issues: [issue("i-1", "TWO-7"), issue("i-2", "TWO-2", { assigneeAgentId: null, assigneeUserId: "u-1" } as Partial<Issue>)],
    });
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await harness.runJob(SCAN_JOB_KEY);
    const pending = await catchUp();
    const decisions = [...emitted, ...pending].filter((e) => e.kind !== "run_failure");
    expect(decisions.length).toBeGreaterThan(0);
    for (const event of decisions) {
      expect(Object.keys(event).sort()).toEqual([
        "audience",
        "createdAt",
        "id",
        "interactionKind",
        "issueIdentifier",
        "kind",
        "originId",
        "originKind",
        "url",
      ]);
    }
    expect(pending.map((e) => e.kind).sort()).toEqual(["owner_card", "run_failure"]);
  });

  it("never leaks stored-only fields", async () => {
    const { emitted, fail } = await setup();
    for (const [i, error] of ["a", "b", "c", "d", "e", "f"].entries()) {
      await fail(`run-${i}`, "2026-11-01T10:01:00.000Z", { error: `error ${error}` });
    }
    const pending = await catchUp();
    expect(pending.some((e) => e.id.startsWith("overflow@"))).toBe(true);
    for (const event of [...emitted, ...pending]) {
      expect(event).not.toHaveProperty("runIds");
      expect(event).not.toHaveProperty("issueId");
      expect(event).not.toHaveProperty("groupIds");
    }
  });

  it("asks for orchestration reads to reconcile runs", () => {
    expect(manifest.capabilities).toContain("issues.orchestration.read");
  });
});
