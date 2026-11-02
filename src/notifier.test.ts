import { describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import {
  DecisionNotifier,
  INTERACTION_ISSUE_STATUSES,
  OPEN_ISSUE_STATUSES,
  toEvent,
  toPublic,
  toRunFailureEvent,
  type DecisionEvent,
  type NotifierEvent,
  type RunFailureEvent,
} from "./notifier.js";

type Seed = Parameters<TestHarness["seed"]>[0];
type Company = NonNullable<Seed["companies"]>[number];
type Issue = NonNullable<Seed["issues"]>[number];
type Approval = NonNullable<Seed["approvals"]>[number];

const COMPANY = "c-1";
const OWNER = "user-owner";

const company = (id = COMPANY, issuePrefix = "TWO") => ({ id, name: "Co", issuePrefix }) as unknown as Company;

const issue = (id: string, identifier: string, extra: Partial<Issue> = {}) =>
  ({
    id,
    companyId: COMPANY,
    identifier,
    title: "untrusted",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdAt: new Date("2026-10-31T09:00:00Z"),
    updatedAt: new Date("2026-10-31T10:00:00Z"),
    ...extra,
  }) as unknown as Issue;

const approval = (id: string, extra: Partial<Approval> = {}) =>
  ({
    id,
    companyId: COMPANY,
    type: "hire_agent",
    status: "pending",
    payload: {},
    decisionNote: null,
    createdAt: new Date("2026-10-31T12:00:00Z"),
    updatedAt: new Date("2026-10-31T12:00:00Z"),
    ...extra,
  }) as unknown as Approval;

/** A notifier on a harness context, without going through the plugin wiring. */
function setup(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config });
  const emitted: NotifierEvent[] = [];
  harness.ctx.streams.open = () => {};
  harness.ctx.streams.emit = (_channel, event) => {
    emitted.push(event as NotifierEvent);
  };
  harness.seed({ companies: [company()] });
  return { harness, emitted, notifier: new DecisionNotifier(harness.ctx) };
}

describe("public event shapes", () => {
  it("toEvent keeps only the nine public fields, dropping the stored issue id", () => {
    const stored = {
      kind: "interaction",
      id: "ix-1",
      issueId: "i-1",
      issueIdentifier: "TWO-1",
      url: "https://pc.example.com/TWO/issues/TWO-1",
      createdAt: "2026-10-31T11:00:00.000Z",
      audience: "board",
      interactionKind: "request_confirmation",
      originKind: null,
      originId: null,
      title: "untrusted",
    } as unknown as DecisionEvent;
    const event = toEvent(stored);
    expect(event).toEqual({
      kind: "interaction",
      id: "ix-1",
      issueIdentifier: "TWO-1",
      url: "https://pc.example.com/TWO/issues/TWO-1",
      createdAt: "2026-10-31T11:00:00.000Z",
      audience: "board",
      interactionKind: "request_confirmation",
      originKind: null,
      originId: null,
    });
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
  });

  it("toEvent normalizes a stored 0.2.0 entry missing the routing fields", () => {
    const stored = {
      kind: "approval",
      id: "ap-1",
      issueId: null,
      issueIdentifier: null,
      url: "/TWO/approvals/ap-1",
      createdAt: "2026-10-31T12:00:00.000Z",
    } as unknown as DecisionEvent;
    expect(toEvent(stored)).toEqual({
      kind: "approval",
      id: "ap-1",
      issueIdentifier: null,
      url: "/TWO/approvals/ap-1",
      createdAt: "2026-10-31T12:00:00.000Z",
      // Fail-safe: a human looks, never "anyone".
      audience: "board",
      interactionKind: null,
      originKind: null,
      originId: null,
    });
  });

  it("toEvent resets a stored audience outside the three known strings", () => {
    const stored = {
      kind: "interaction",
      id: "ix-1",
      issueId: "i-1",
      issueIdentifier: "TWO-1",
      url: "/TWO/issues/TWO-1",
      createdAt: "2026-10-31T11:00:00.000Z",
      audience: "everyone",
      interactionKind: 7,
      originKind: "plugin:board-council",
      originId: 42,
    } as unknown as DecisionEvent;
    expect(toEvent(stored)).toEqual({
      kind: "interaction",
      id: "ix-1",
      issueIdentifier: "TWO-1",
      url: "/TWO/issues/TWO-1",
      createdAt: "2026-10-31T11:00:00.000Z",
      audience: "board",
      interactionKind: null,
      originKind: "plugin:board-council",
      originId: null,
    });
  });

  it("toRunFailureEvent drops the stored-only bookkeeping fields", () => {
    const stored = {
      kind: "run_failure",
      id: "g1@2026-11-01T10:00:00.000Z",
      issueId: "i-1",
      issueIdentifier: "TWO-7",
      url: "https://pc.example.com/TWO/agents/agent-1/runs/run-2",
      createdAt: "2026-11-01T10:00:00.000Z",
      agentId: "agent-1",
      agentIds: ["agent-1", "agent-2"],
      count: 3,
      firstRunId: "run-1",
      lastRunId: "run-2",
      firstFailedAt: "2026-11-01T10:01:00.000Z",
      lastFailedAt: "2026-11-01T10:05:00.000Z",
      errorCode: "adapter_failed",
      error: "boom",
      runIds: ["run-1", "run-2"],
      groupIds: ["g1"],
    } as unknown as RunFailureEvent;
    const event = toRunFailureEvent(stored);
    expect(event).toMatchObject({ kind: "run_failure", count: 3, error: "boom" });
    expect(Object.keys(event).sort()).toEqual([
      "agentId",
      "agentIds",
      "count",
      "createdAt",
      "error",
      "errorCode",
      "firstFailedAt",
      "firstRunId",
      "id",
      "issueIdentifier",
      "kind",
      "lastFailedAt",
      "lastRunId",
      "url",
    ]);
    expect(JSON.stringify(event)).not.toContain("runIds");
  });

  it("toPublic routes each kind through its own stripper", () => {
    const decision = toPublic({
      kind: "approval",
      id: "ap-1",
      issueId: null,
      issueIdentifier: null,
      url: "/TWO/approvals/ap-1",
      createdAt: "2026-10-31T12:00:00.000Z",
    } as unknown as NotifierEvent);
    expect(decision.kind).toBe("approval");
    expect(decision).not.toHaveProperty("issueId");

    const failure = toPublic({
      kind: "run_failure",
      id: "overflow@2026-11-01T10:00:00.000Z",
      issueId: null,
      issueIdentifier: null,
      url: "/TWO/agents/a/runs/r",
      createdAt: "2026-11-01T10:00:00.000Z",
      agentId: "a",
      agentIds: ["a"],
      count: 1,
      firstRunId: "r",
      lastRunId: "r",
      firstFailedAt: "2026-11-01T10:01:00.000Z",
      lastFailedAt: "2026-11-01T10:01:00.000Z",
      errorCode: null,
      error: "1 more distinct failure",
      runIds: ["r"],
      groupIds: ["g1"],
    } as unknown as NotifierEvent);
    expect(failure.kind).toBe("run_failure");
    expect(failure).not.toHaveProperty("runIds");
    expect(failure).not.toHaveProperty("groupIds");
  });
});

describe("status sets", () => {
  it("owner cards count only in open statuses", () => {
    expect([...OPEN_ISSUE_STATUSES]).toEqual(["todo", "in_progress", "in_review", "blocked"]);
  });

  it("interactions can also sit on backlog cards, and neither set is terminal", () => {
    expect([...INTERACTION_ISSUE_STATUSES]).toEqual(["backlog", ...OPEN_ISSUE_STATUSES]);
    for (const statuses of [OPEN_ISSUE_STATUSES, INTERACTION_ISSUE_STATUSES]) {
      expect(statuses).not.toContain("done");
      expect(statuses).not.toContain("cancelled");
    }
  });
});

describe("event guards", () => {
  it("ignores approval and issue events without an entity id", async () => {
    const { harness, emitted, notifier } = setup();
    harness.ctx.approvals.get = async () => {
      throw new Error("must not read");
    };
    harness.ctx.issues.get = async () => {
      throw new Error("must not read");
    };

    await notifier.onApprovalEvent(COMPANY, undefined);
    await notifier.onIssueEvent(COMPANY, undefined);

    expect(emitted).toEqual([]);
    expect(harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "pending" })).toBeUndefined();
  });

  it.each([
    ["a non-object payload", "failed", "run-1"],
    ["a cancelled run", { runId: "run-1", agentId: "agent-1", status: "cancelled", error: "x", finishedAt: "2026-11-01T10:00:00.000Z" }, "run-1"],
    // With an entity id the payload may omit runId; with neither there is nothing to count.
    ["a payload with no run id anywhere", { agentId: "agent-1", status: "failed", error: "x", finishedAt: "2026-11-01T10:00:00.000Z" }, undefined],
  ])("ignores %s without touching the host", async (_label, payload, entityId) => {
    const { harness, emitted, notifier } = setup();
    harness.ctx.issues.get = async () => {
      throw new Error("must not read");
    };

    await notifier.onRunFailedEvent(COMPANY, payload, "2026-11-01T10:01:00.000Z", entityId);

    expect(emitted).toEqual([]);
    expect(harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: "run-failures" })).toBeUndefined();
  });
});

describe("scanCompany", () => {
  it("with emitNew: false records the pending set without announcing it", async () => {
    const { harness, emitted, notifier } = setup();
    harness.seed({ approvals: [approval("ap-1")] });

    const pending = await notifier.scanCompany(COMPANY, { emitNew: false });
    expect(pending.map((e) => `${e.kind}:${e.id}`)).toEqual(["approval:ap-1"]);
    expect(emitted).toEqual([]);

    // Recorded means a later ordinary scan does not announce it either.
    await notifier.scanCompany(COMPANY);
    expect(emitted).toEqual([]);
  });

  it("announces new decisions by default", async () => {
    const { harness, emitted, notifier } = setup();
    harness.seed({ approvals: [approval("ap-1")] });
    await notifier.scanCompany(COMPANY);
    expect(emitted.map((e) => e.id)).toEqual(["ap-1"]);
  });

  it("treats a non-object stored pending set as empty instead of crashing", async () => {
    const { harness, emitted, notifier } = setup();
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "pending" }, "corrupt" as never);
    harness.seed({ approvals: [approval("ap-1")] });

    const pending = await notifier.scanCompany(COMPANY);
    expect(pending.map((e) => e.id)).toEqual(["ap-1"]);
    expect(emitted.map((e) => e.id)).toEqual(["ap-1"]);
  });
});

describe("config parsing", () => {
  it("trims whitespace and trailing slashes from publicBaseUrl", async () => {
    const { harness, notifier } = setup({ publicBaseUrl: "  https://pc.example.com/// " });
    harness.seed({ approvals: [approval("ap-1")] });
    const [event] = await notifier.scanCompany(COMPANY, { emitNew: false });
    expect(event.url).toBe("https://pc.example.com/TWO/approvals/ap-1");
  });

  it("treats a non-string publicBaseUrl as unset", async () => {
    const { harness, notifier } = setup({ publicBaseUrl: 42 });
    harness.seed({ approvals: [approval("ap-1")] });
    const [event] = await notifier.scanCompany(COMPANY, { emitNew: false });
    expect(event.url).toBe("/TWO/approvals/ap-1");
  });

  it("keeps only non-empty strings from ownerUserIds", async () => {
    const { harness, notifier } = setup({ ownerUserIds: [OWNER, 42, "", null] });
    harness.seed({
      issues: [
        issue("i-1", "TWO-1", { assigneeUserId: OWNER } as Partial<Issue>),
        issue("i-2", "TWO-2", { assigneeUserId: "someone-else" } as Partial<Issue>),
      ],
    });
    const pending = await notifier.scanCompany(COMPANY, { emitNew: false });
    expect(pending.map((e) => e.id)).toEqual(["i-1"]);
  });

  it("treats a non-array ownerUserIds as no restriction", async () => {
    const { harness, notifier } = setup({ ownerUserIds: OWNER });
    harness.seed({ issues: [issue("i-1", "TWO-1", { assigneeUserId: "anyone" } as Partial<Issue>)] });
    const pending = await notifier.scanCompany(COMPANY, { emitNew: false });
    expect(pending.map((e) => e.id)).toEqual(["i-1"]);
  });
});

describe("scanAll error isolation", () => {
  it("logs a failed run reconciliation and still scans the next company", async () => {
    const { harness, emitted, notifier } = setup();
    harness.seed({
      companies: [company(), company("c-2", "OTH")],
      approvals: [approval("ap-2", { companyId: "c-2" } as Partial<Approval>)],
    });
    const get = harness.ctx.state.get.bind(harness.ctx.state);
    harness.ctx.state.get = async (key) => {
      if (key.scopeId === COMPANY && key.stateKey === "run-failure-cursor") throw new Error("state down");
      return get(key);
    };

    await notifier.scanAll();

    expect(emitted.map((e) => e.id)).toEqual(["ap-2"]);
    expect(harness.logs).toContainEqual({
      level: "error",
      message: "run failure reconciliation failed",
      meta: { companyId: COMPANY, error: "Error: state down" },
    });
  });
});
