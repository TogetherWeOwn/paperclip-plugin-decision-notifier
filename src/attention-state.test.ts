import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = new URL("../bin/attention-state.mjs", import.meta.url).href;
const { deliveryState } = await import(modulePath);
const directories: string[] = [];
const ledger = () => {
  const directory = mkdtempSync(join(tmpdir(), "attention-state-"));
  directories.push(directory);
  return join(directory, "seen");
};
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("actor delivery ledger", () => {
  it("persists timestamps across restarts without sharing suppression across actor scopes", () => {
    const file = ledger();
    const first = deliveryState(file, "actor-a");
    expect(first.previous("interaction:i:date")).toBeNull();
    first.delivered("interaction:i:date", 100);
    expect(deliveryState(file, "actor-a").previous("interaction:i:date")).toBe(100);
    expect(deliveryState(file, "actor-b").previous("interaction:i:date")).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("migrates legacy keys as immediately reminder-eligible, not permanently acknowledged", () => {
    const file = ledger();
    writeFileSync(file, "interaction:one:date\napproval:two:date\n");
    const state = deliveryState(file, "actor");
    expect(state.previous("interaction:one:date")).toBe(0);
    state.delivered("interaction:one:date", Date.now());
    const restored = deliveryState(file, "actor");
    expect(restored.previous("approval:two:date")).toBe(0);
    expect(restored.previous("interaction:one:date")).toBeGreaterThan(0);
  });

  it("does not erase entries when an incomplete desk page omits them", () => {
    const file = ledger();
    const now = Date.now();
    deliveryState(file, "actor").delivered("hidden-sibling", now);
    deliveryState(file, "actor").delivered("visible-item", now + 1);
    expect(deliveryState(file, "actor").previous("hidden-sibling")).toBe(now);
  });

  it("ignores malformed ledger records and refuses oversized files", () => {
    const file = ledger();
    writeFileSync(file, 'not-json\n{"version":1,"scope":"actor","key":"bad","deliveredAt":"forever"}\n');
    expect(deliveryState(file, "actor").previous("bad")).toBeNull();
    writeFileSync(file, "x".repeat(4 * 1024 * 1024 + 1));
    expect(() => deliveryState(file, "actor")).toThrow("seen ledger exceeds 4 MiB");
  });

  it("caps retained delivery records and retires timestamps older than thirty days", () => {
    const file = ledger();
    const now = Date.now();
    const lines = Array.from({ length: 10_010 }, (_, i) => JSON.stringify({ version: 1, scope: "actor", key: `k-${i}`, deliveredAt: now - i }));
    lines.push(JSON.stringify({ version: 1, scope: "actor", key: "expired", deliveredAt: 1 }));
    writeFileSync(file, lines.join("\n"));
    deliveryState(file, "actor").delivered("new", now + 1);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(10_000);
    expect(deliveryState(file, "actor").previous("expired")).toBeNull();
  });
});
