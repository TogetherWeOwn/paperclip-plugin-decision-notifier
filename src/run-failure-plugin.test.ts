import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginIssueRunSummary } from "@paperclipai/plugin-sdk";
import manifest, { SCAN_JOB_KEY } from "./manifest.js";
import plugin from "./plugin.js";
import { RUN_RECONCILE_INTERVAL_MS, type NotifierEvent, type RunFailureEvent } from "./notifier.js";

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

  it("keeps different errors and different agents apart", async () => {
    const { failures, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    await fail("run-2", "2026-11-01T10:02:00.000Z", { error: "spawn claude ENOENT" });
    await fail("run-3", "2026-11-01T10:03:00.000Z", { agentId: "agent-2" });
    expect(new Set(failures().map((f) => f.id)).size).toBe(3);
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

  it("does nothing when disabled", async () => {
    const { failures, fail, harness, runs, reads } = await setup({ runFailures: { enabled: false } });
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    runs["i-1"] = [runSummary("run-2", "2026-11-01T10:02:00.000Z")];
    await harness.runJob(SCAN_JOB_KEY);
    expect(failures()).toEqual([]);
    expect(reads).toEqual([]);
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
      expect(Object.keys(event).sort()).toEqual(["createdAt", "id", "issueIdentifier", "kind", "url"]);
    }
    expect(pending.map((e) => e.kind).sort()).toEqual(["owner_card", "run_failure"]);
  });

  it("never leaks stored-only fields", async () => {
    const { emitted, fail } = await setup();
    await fail("run-1", "2026-11-01T10:01:00.000Z");
    const pending = await catchUp();
    for (const event of [...emitted, ...pending]) {
      expect(event).not.toHaveProperty("runIds");
      expect(event).not.toHaveProperty("issueId");
    }
  });

  it("asks for orchestration reads to reconcile runs", () => {
    expect(manifest.capabilities).toContain("issues.orchestration.read");
  });
});
