import { describe, expect, it } from "vitest";
import {
  RUN_FAILURE_EXCERPT_CHARS,
  errorExcerpt,
  errorSignature,
  failedRunFromEvent,
  failureGroupId,
  redact,
  windowStart,
} from "./run-failures.js";

const MODEL_ERROR =
  "ACP agent reported a terminal service failure: Claude Code 2.1.257 does not support this model (request 7f3c2a91-1b2d-4e5f-8a9b-0c1d2e3f4a5b)";

describe("redact", () => {
  it.each([
    ["Authorization: Bearer abcdefghijklmnop1234", "abcdefghijklmnop1234"],
    ["key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv rejected", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"],
    ["push failed with ghp_0123456789abcdefghijABCDEFGHIJ", "ghp_0123456789abcdefghijABCDEFGHIJ"],
    ["token github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"],
    ['config {"api_key": "hunter2-very-secret"}', "hunter2-very-secret"],
    ["PASSWORD=correct-horse-battery", "correct-horse-battery"],
    ["clone https://bot:s3cr3tpass@git.example.com/repo.git", "s3cr3tpass"],
    ["slack xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
    ["aws AKIAABCDEFGHIJKLMNOP denied", "AKIAABCDEFGHIJKLMNOP"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGciOiJIUzI1NiJ9"],
    ["notify ops@example.com about it", "ops@example.com"],
    [`blob ${"Zm9vYmFy".repeat(8)}`, "Zm9vYmFy".repeat(8)],
    ["claude --api-key hunter2xyz -p hi", "hunter2xyz"],
    ["gh --token abc123 api", "abc123"],
    ["--auth-token 'q1w2e3' denied", "q1w2e3"],
    ["ANTHROPIC_KEY=abcd1234 rejected", "abcd1234"],
    ["DEPLOY_TOKEN = zz9-qq8 rejected", "zz9-qq8"],
    ["MY_APP_SECRET=s3cr3t!", "s3cr3t!"],
    ["stripe sk_live_AbCdEfGhIjKlMnOpQr declined", "sk_live_AbCdEfGhIjKlMnOpQr"],
    ["key sk-AbCdEfGhIjKlMnOpQr rejected", "sk-AbCdEfGhIjKlMnOpQr"],
    ["mysql pwd=hunter2 refused", "hunter2"],
    ["db_pass: hunter2 refused", "hunter2"],
    ["Authorization: Bearer abc", " abc"],
  ])("removes the secret from %j", (input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/\[redacted\]|\[email\]/);
  });

  it("leaves ordinary error text alone and flattens control characters", () => {
    expect(redact("line one\n\tline two\u0007  done")).toBe("line one line two done");
    expect(redact(MODEL_ERROR)).toBe(MODEL_ERROR);
    expect(redact("tests passed: 3, bypass=on, --token-file ./t --verbose")).toBe("tests passed: 3, bypass=on, --token-file [redacted] --verbose");
  });

  it("keeps the flag and key names it redacts", () => {
    expect(redact("claude --api-key hunter2xyz -p hi")).toBe("claude --api-key [redacted] -p hi");
    expect(redact("ANTHROPIC_KEY=abcd1234 rejected")).toBe("ANTHROPIC_KEY=[redacted] rejected");
    expect(redact("--token --verbose")).toBe("--token --verbose");
  });
});

describe("errorExcerpt", () => {
  it("caps the excerpt at 200 characters, redacting before it truncates", () => {
    const secret = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
    // The secret straddles the cut: truncating first would leave a prefix of it behind.
    const error = `${"x ".repeat(95)}${secret} ${"tail ".repeat(40)}`;
    const out = errorExcerpt(error);
    expect(out.length).toBeLessThanOrEqual(RUN_FAILURE_EXCERPT_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("sk-proj-AbCd");
  });

  it("returns an empty string for a missing error", () => {
    expect(errorExcerpt(null)).toBe("");
  });
});

describe("errorSignature", () => {
  it("ignores ids, numbers and secrets that change between retries", () => {
    const a = errorSignature(MODEL_ERROR);
    const b = errorSignature(MODEL_ERROR.replace("7f3c2a91-1b2d-4e5f-8a9b-0c1d2e3f4a5b", "00000000-1111-2222-3333-444444444444"));
    const c = errorSignature("exit code 137 after 41s with token=abc123def");
    const d = errorSignature("exit code 1 after 9s with token=zzz999");
    expect(a).toBe(b);
    expect(c).toBe(d);
    expect(a).not.toBe(c);
  });

  const overloaded = (requestId: string, messageId: string) =>
    `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"${requestId}"} (${messageId})`;

  it("folds the request and message ids of a 529 overloaded retry", () => {
    const a = errorSignature(overloaded("req_011CUa7b3kZ9QwErTyUiOpAs", "msg_01XFDUDYJgAACzvnptvVoYEL"));
    const b = errorSignature(overloaded("req_011CUb9QpLmNoPqRsTuVwXyZ", "msg_01AbCdEfGhIjKlMnOpQrStUv"));
    expect(a).toBe(b);
    expect(a).toContain("overloaded_error");
    expect(a).not.toContain("req_");
    expect(a).not.toBe(errorSignature("API Error: 401 authentication_error"));
  });

  it.each([
    ["tool use ids", "tool toolu_01A09q90qw90lq917835lq9 failed", "tool toolu_01B77zz12ab34cd56ef78gh9 failed"],
    ["call and run ids", "call_8fK2mQ9xLp run_Z81kq0Vb7c aborted", "call_3Hn7tRa2Wq run_A19bC4dE6f aborted"],
    ["completion ids", "chatcmpl-9XyZ8wV7uT6s rejected", "chatcmpl-1AbC2dEf3GhI rejected"],
    ["temp paths", "ENOENT /tmp/paperclip-run-Xk3pQz/out.log", "ENOENT /tmp/paperclip-run-Ab9TzQ/out.log"],
    ["macOS temp paths", "cannot open /var/folders/x1/abc_def/T/run-Kq/out", "cannot open /var/folders/y7/qrs_tuv/T/run-Zp/out"],
    ["Windows temp paths", "cannot open C:\\Users\\a\\AppData\\Local\\Temp\\pc-Xk3pQz\\x", "cannot open C:\\Users\\b\\AppData\\Local\\Temp\\pc-Q7wErT\\x"],
    ["mixed tokens", "lease Kq7ZpX2mWv9RtY lost", "lease Bz1QnM8cLs4DfG lost"],
    ["mixed tokens inside snake_case", "slot abc_Kq7ZpX2mWv9RtY busy", "slot abc_Bz1QnM8cLs4DfG busy"],
  ])("folds %s", (_label, a, b) => {
    expect(errorSignature(a)).toBe(errorSignature(b));
  });

  it("keeps ordinary words and paths outside temp dirs", () => {
    expect(errorSignature("run-finished hook failed in /home/u/tmp/x")).toBe("run-finished hook failed in /home/u/tmp/x");
    expect(errorSignature("ENOENT /tmp/a")).not.toBe(errorSignature("EACCES /tmp/a"));
  });

  it("gives empty errors one shared signature", () => {
    expect(errorSignature(null)).toBe(errorSignature("   "));
  });
});

describe("grouping keys", () => {
  it("keys groups by signature only, so one outage across agents is one group", () => {
    const sig = errorSignature(MODEL_ERROR);
    expect(failureGroupId(sig)).toBe(failureGroupId(errorSignature(MODEL_ERROR)));
    expect(failureGroupId(sig)).not.toBe(failureGroupId(errorSignature("spawn claude ENOENT")));
    expect(failureGroupId(sig)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("uses fixed windows", () => {
    const thirty = 30 * 60_000;
    const base = Date.parse("2026-11-01T10:00:00.000Z");
    expect(windowStart(base + 29 * 60_000, thirty)).toBe(base);
    expect(windowStart(base + 30 * 60_000, thirty)).toBe(base + thirty);
  });
});

describe("failedRunFromEvent", () => {
  const payload = {
    runId: "run-1",
    agentId: "agent-1",
    status: "failed",
    error: MODEL_ERROR,
    errorCode: "adapter_failed",
    issueId: "i-1",
    finishedAt: "2026-11-01T10:05:00.000Z",
  };

  it("reads the host payload", () => {
    expect(failedRunFromEvent(payload, "2026-11-01T10:06:00.000Z")).toEqual({
      runId: "run-1",
      agentId: "agent-1",
      status: "failed",
      error: MODEL_ERROR,
      errorCode: "adapter_failed",
      issueId: "i-1",
      failedAt: "2026-11-01T10:05:00.000Z",
    });
  });

  it("accepts timed-out runs and falls back to the event time", () => {
    const run = failedRunFromEvent({ ...payload, status: "timed_out", finishedAt: null }, "2026-11-01T10:06:00.000Z");
    expect(run).toMatchObject({ status: "timed_out", failedAt: "2026-11-01T10:06:00.000Z" });
  });

  it.each([
    ["cancelled", { ...payload, status: "cancelled" }],
    ["succeeded", { ...payload, status: "succeeded" }],
    ["no agent", { ...payload, agentId: undefined }],
    ["no run id", { ...payload, runId: undefined }],
    ["not an object", "failed"],
  ])("ignores a %s payload", (_label, input) => {
    expect(failedRunFromEvent(input, "2026-11-01T10:06:00.000Z")).toBeNull();
  });
});
