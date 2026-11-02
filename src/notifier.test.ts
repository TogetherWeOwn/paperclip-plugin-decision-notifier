import { describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import {
  COMPANY_LIST_REFRESH_MS,
  DecisionNotifier,
  EVENT_SCAN_INTERVAL_MS,
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

describe("event-triggered scans", () => {
  it("scans on the first event, throttles within the interval, and scans again after it", async () => {
    const { harness, emitted, notifier } = setup();
    harness.seed({ approvals: [approval("ap-1")] });
    const start = Date.now();
    let now = start;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await notifier.scanFromEventIfDue(COMPANY);
      harness.seed({ approvals: [approval("ap-1"), approval("ap-2")] });
      now = start + EVENT_SCAN_INTERVAL_MS - 1;
      await notifier.scanFromEventIfDue(COMPANY); // throttled: ap-2 not yet found
      now = start + EVENT_SCAN_INTERVAL_MS;
      await notifier.scanFromEventIfDue(COMPANY);
    } finally {
      spy.mockRestore();
    }

    expect(emitted.map((e) => e.id)).toEqual(["ap-1", "ap-2"]);
    expect(
      harness.logs.filter((log) => log.message === "decision scan completed"),
    ).toEqual([
      { level: "info", message: "decision scan completed", meta: { companyId: COMPANY, source: "event", pending: 1 } },
      { level: "info", message: "decision scan completed", meta: { companyId: COMPANY, source: "event", pending: 2 } },
    ]);
  });

  it("logs a failed event-triggered scan instead of throwing into the event handler", async () => {
    const { harness, notifier } = setup();
    harness.ctx.config.get = async () => {
      throw new Error("config down");
    };

    await expect(notifier.scanFromEventIfDue(COMPANY)).resolves.toBeUndefined();

    expect(harness.logs).toContainEqual({
      level: "error",
      message: "decision scan failed",
      meta: { companyId: COMPANY, error: "Error: config down" },
    });
  });

  it("ignores a missing company id", async () => {
    const { harness, notifier } = setup();
    await notifier.scanFromEventIfDue(null);
    await notifier.scanFromEventIfDue(undefined);
    expect(harness.logs.filter((log) => log.message === "decision scan completed")).toEqual([]);
  });
});

describe("job-context scope denials", () => {
  it("warns once per company instead of erroring every run when the host denies the job's calls", async () => {
    const { harness, notifier } = setup();
    harness.ctx.config.get = async () => {
      throw new Error(
        'Plugin "p" is not allowed to perform "config.get": the worker referenced a missing, expired, or unknown invocation scope',
      );
    };

    await notifier.scanAll();
    await notifier.scanAll();

    const warnings = harness.logs.filter(
      (log) => log.message === "scan unavailable from job context; relying on event-driven scans",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe("warn");
    expect(warnings[0].meta?.companyId).toBe(COMPANY);
    expect(harness.logs.filter((log) => log.level === "error")).toEqual([]);
  });
});

describe("scanAll company enumeration", () => {
  const denyList = (harness: TestHarness) => {
    harness.ctx.companies.list = async () => {
      throw new Error("the worker referenced a missing, expired, or unknown invocation scope");
    };
  };

  it("reads the company list at most once per refresh window", async () => {
    const { harness, notifier } = setup();
    let calls = 0;
    const list = harness.ctx.companies.list.bind(harness.ctx.companies);
    harness.ctx.companies.list = async (...args) => {
      calls++;
      return list(...args);
    };

    await notifier.scanAll();
    await notifier.scanAll();

    expect(calls).toBe(1);
  });

  it("keeps scanning known companies when the host denies companies.list", async () => {
    const { harness, emitted, notifier } = setup();
    harness.seed({ approvals: [approval("ap-1")] });
    await notifier.scanAll(); // list still readable: learns and persists the company set
    expect(emitted.map((e) => e.id)).toEqual(["ap-1"]);

    denyList(harness);
    harness.seed({ approvals: [approval("ap-1"), approval("ap-2")] });
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + COMPANY_LIST_REFRESH_MS + 1);
    try {
      await notifier.scanAll();
    } finally {
      now.mockRestore();
    }

    expect(emitted.map((e) => e.id)).toEqual(["ap-1", "ap-2"]);
    expect(harness.logs).toContainEqual({
      level: "warn",
      message: "company list unavailable; scanning known companies",
      meta: {
        error: "Error: the worker referenced a missing, expired, or unknown invocation scope",
        knownCompanies: 1,
      },
    });
  });

  it("scans a company learned from an event, across a worker restart, without companies.list", async () => {
    const { harness, emitted, notifier } = setup();
    denyList(harness);
    harness.seed({ approvals: [approval("ap-1")] });

    await notifier.onApprovalEvent(COMPANY, "ap-1");
    harness.seed({ approvals: [approval("ap-1"), approval("ap-2")] });
    await notifier.scanAll();
    expect(emitted.map((e) => e.id)).toEqual(["ap-1", "ap-2"]);

    // A new notifier on the same store (worker restart) reloads the remembered set.
    const restarted = new DecisionNotifier(harness.ctx);
    harness.seed({ approvals: [approval("ap-1"), approval("ap-2"), approval("ap-3")] });
    await restarted.scanAll();
    expect(emitted.map((e) => e.id)).toEqual(["ap-1", "ap-2", "ap-3"]);
  });

  it("does not let an empty company list wipe the remembered companies", async () => {
    const { harness, emitted, notifier } = setup();
    await notifier.noteCompany(COMPANY);
    harness.ctx.companies.list = async () => [];
    harness.seed({ approvals: [approval("ap-1")] });

    await notifier.scanAll();

    expect(emitted.map((e) => e.id)).toEqual(["ap-1"]);
  });

  it("retries a denied company list at most once per refresh window, even knowing no company", async () => {
    const { harness, notifier } = setup();
    let calls = 0;
    harness.ctx.companies.list = async () => {
      calls++;
      throw new Error("the worker referenced a missing, expired, or unknown invocation scope");
    };

    await notifier.scanAll();
    await notifier.scanAll();

    expect(calls).toBe(1);
  });

  it("persists concurrent company notes without an older snapshot overwriting a newer one", async () => {
    const { harness, notifier } = setup();
    const set = harness.ctx.state.set.bind(harness.ctx.state);
    let first = true;
    harness.ctx.state.set = async (key, value) => {
      // The first known-companies write lands last; unserialised, its stale
      // snapshot would replace the second note's fuller one.
      if (key.stateKey === "known-companies" && first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return set(key, value);
    };

    await Promise.all([notifier.noteCompany("c-a"), notifier.noteCompany("c-b")]);

    const persisted = await harness.ctx.state.get({ scopeKind: "instance", stateKey: "known-companies" });
    expect([...(persisted as string[])].sort()).toEqual(["c-a", "c-b"]);
  });

  it("retries a failed read of the remembered companies instead of caching empty", async () => {
    const { harness, emitted, notifier } = setup();
    await harness.ctx.state.set({ scopeKind: "instance", stateKey: "known-companies" }, [COMPANY]);
    const get = harness.ctx.state.get.bind(harness.ctx.state);
    let failRead = true;
    harness.ctx.state.get = async (key) => {
      if (key.stateKey === "known-companies" && failRead) {
        failRead = false;
        throw new Error("state down");
      }
      return get(key);
    };
    denyList(harness);
    harness.seed({
      companies: [company(), company("c-2", "OTH")],
      approvals: [approval("ap-1"), approval("ap-2", { companyId: "c-2" } as Partial<Approval>)],
    });

    // Noted while the remembered set is unreadable: kept for the session, and
    // the stored set is not overwritten by the partial one.
    await notifier.noteCompany("c-2");
    await notifier.scanAll();
    expect(emitted.map((e) => e.id)).toEqual(["ap-2"]);

    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      await notifier.scanAll();
    } finally {
      now.mockRestore();
    }
    expect(emitted.map((e) => e.id)).toEqual(["ap-2", "ap-1"]);
    const persisted = await harness.ctx.state.get({ scopeKind: "instance", stateKey: "known-companies" });
    expect([...(persisted as string[])].sort()).toEqual([COMPANY, "c-2"].sort());
  });
});
