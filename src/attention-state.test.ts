import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));
vi.mock("node:crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("node:crypto")>() }));

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

  it("bounds actual reads even when the file exceeds its descriptor's initial size", () => {
    const file = ledger(); const limit = 4 * 1024 * 1024;
    writeFileSync(file, "x".repeat(limit + 1024));
    const initialStat = statSync(file);
    const metadata = vi.spyOn(fs, "fstatSync").mockReturnValueOnce(Object.assign(initialStat, { size: 0 }));
    const reads = vi.spyOn(fs, "readSync"); const closes = vi.spyOn(fs, "closeSync");
    try {
      expect(() => deliveryState(file, "actor")).toThrow("seen ledger exceeds 4 MiB");
      const bytes = reads.mock.results.reduce((total, result) => total + (result.type === "return" ? Number(result.value) : 0), 0);
      expect(bytes).toBe(limit + 1);
      expect(closes).toHaveBeenCalledTimes(1);
    } finally {
      metadata.mockRestore(); reads.mockRestore(); closes.mockRestore();
    }
  });

  it("accepts a regular ledger exactly at the byte cap", () => {
    const file = ledger(); const limit = 4 * 1024 * 1024;
    const record = JSON.stringify({ version: 1, scope: "actor", key: "ask", deliveredAt: 123 });
    writeFileSync(file, `${record}\n${" ".repeat(limit - Buffer.byteLength(record) - 1)}`);
    expect(deliveryState(file, "actor").previous("ask")).toBe(123);
  });

  it("refuses symlinks and non-regular ledger inputs without blocking", () => {
    const file = ledger(); const target = `${file}-target`;
    writeFileSync(target, "untouched"); symlinkSync(target, file);
    expect(() => deliveryState(file, "actor")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(() => deliveryState(join(file, ".."), "actor")).toThrow("seen ledger must be a regular file");
    const fifo = `${file}-fifo`;
    execFileSync("mkfifo", [fifo]);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { deliveryState } from ${JSON.stringify(modulePath)};
      try { deliveryState(process.argv[1], "actor"); process.exitCode = 2; }
      catch (error) { if (error.message !== "seen ledger must be a regular file") throw error; }
    `, fifo], { timeout: 3000, encoding: "utf8" });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  });

  it("keeps serialized output within its own read budget", () => {
    const file = ledger(); const now = Date.now();
    writeFileSync(file, JSON.stringify({ version: 1, scope: "actor", key: "x".repeat(4 * 1024 * 1024 - 250), deliveredAt: now }) + "\n");
    expect(statSync(file).size).toBeLessThan(4 * 1024 * 1024);
    const key = "new".repeat(100);
    deliveryState(file, "actor").delivered(key, now + 1);
    expect(statSync(file).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(deliveryState(file, "actor").previous(key)).toBe(now + 1);
  });

  it("does not follow a planted predictable temporary symlink or leave new temporary files", () => {
    const file = ledger(); const target = `${file}-target`;
    writeFileSync(target, "untouched");
    const planted = `${file}.${process.pid}.tmp`;
    symlinkSync(target, planted);
    deliveryState(file, "actor").delivered("ask", Date.now());
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(statSync(file).isFile()).toBe(true);
    expect(readdirSync(join(file, ".."))).toHaveLength(3);
  });

  it("refuses a symlink at the exact generated temporary path without touching its target", () => {
    const file = ledger(); const target = `${file}-target`;
    const uuid = "00000000-0000-4000-8000-000000000000";
    const random = vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
    try {
      writeFileSync(target, "untouched");
      const planted = `${file}.${process.pid}.${uuid}.tmp`;
      symlinkSync(target, planted);
      expect(() => deliveryState(file, "actor").delivered("ask", Date.now())).toThrow();
      expect(readFileSync(target, "utf8")).toBe("untouched");
      expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      random.mockRestore();
    }
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
