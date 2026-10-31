import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../bin/decision-wait.mjs", import.meta.url));
const TOKEN = "board-token-123";

const decision = (kind: string, id: string) => ({
  kind,
  id,
  issueIdentifier: "TWO-1",
  url: "/TWO/issues/TWO-1",
  createdAt: "2026-10-31T12:00:00.000Z",
});

interface FakeOptions {
  /** Pending list returned by catch-up, and replayed onto the stream. */
  pending: object[];
  /** Frames sent after the replay, as raw SSE text. */
  later?: string[];
}

let server: Server | null = null;
afterEach(() => server?.close());

async function fakePaperclip(options: FakeOptions) {
  const seenAuth: string[] = [];
  let stream: ServerResponse | null = null;
  server = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/plugins/togetherweown.decision-notifier/bridge/stream/decisions?companyId=c-1")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(":ok\n\n");
      stream = res;
      return;
    }
    if (req.method === "POST" && req.url === "/api/plugins/togetherweown.decision-notifier/api/catch-up") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        expect(JSON.parse(raw)).toEqual({ companyId: "c-1" });
        // Like the worker: replay onto the stream first, then answer.
        stream?.write(`event: open\ndata: {"type":"open"}\n\n`);
        for (const event of options.pending) stream?.write(`data: ${JSON.stringify(event)}\n\n`);
        for (const frame of options.later ?? []) stream?.write(frame);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pending: options.pending }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, seenAuth };
}

function run(apiUrl: string, seenFile: string, token = TOKEN) {
  const dir = mkdtempSync(join(tmpdir(), "dw-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, `${token}\n`);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--company", "c-1", "--seen", seenFile], {
      env: { PATH: process.env.PATH, PAPERCLIP_API_URL: `${apiUrl}/api`, PAPERCLIP_BOARD_TOKEN_FILE: tokenFile },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 5000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "dw-seen-")), "seen");

describe("decision-wait", () => {
  it("wakes on a pending decision from catch-up and records it as seen", async () => {
    const fake = await fakePaperclip({ pending: [decision("approval", "ap-1")] });
    const seen = tmpFile();
    const result = await run(fake.url, seen);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(decision("approval", "ap-1"));
    expect(readFileSync(seen, "utf8")).toBe("approval:ap-1:2026-10-31T12:00:00.000Z\n");
  });

  it("skips replayed decisions it already saw and waits for a new one", async () => {
    const fake = await fakePaperclip({
      pending: [decision("approval", "ap-1")],
      later: [`data: ${JSON.stringify(decision("interaction", "ix-9"))}\n\n`],
    });
    const seen = tmpFile();
    writeFileSync(seen, "approval:ap-1:2026-10-31T12:00:00.000Z\nowner_card:resolved:2026-10-31T12:00:00.000Z\n");
    const result = await run(fake.url, seen);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).id).toBe("ix-9");
    // The resolved entry is pruned; the still-pending one is kept.
    expect(readFileSync(seen, "utf8").split("\n").filter(Boolean).sort()).toEqual(["approval:ap-1:2026-10-31T12:00:00.000Z", "interaction:ix-9:2026-10-31T12:00:00.000Z"]);
  });

  it("ignores frames that are not decisions", async () => {
    const fake = await fakePaperclip({
      pending: [],
      later: [`data: {"kind":"other","id":"x"}\n\n`, `data: not-json\n\n`, `data: ${JSON.stringify(decision("owner_card", "i-1"))}\n\n`],
    });
    const result = await run(fake.url, tmpFile());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).id).toBe("i-1");
  });

  it("announces a card again when it starts a new pending cycle", async () => {
    // Same card id, new createdAt: it was unassigned and reassigned between runs.
    const reassigned = { ...decision("owner_card", "i-1"), createdAt: "2026-10-31T15:00:00.000Z" };
    const fake = await fakePaperclip({ pending: [reassigned] });
    const seen = tmpFile();
    writeFileSync(seen, "owner_card:i-1:2026-10-31T12:00:00.000Z\n");
    const result = await run(fake.url, seen);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).createdAt).toBe("2026-10-31T15:00:00.000Z");
  });

  it("parses CRLF-framed streams", async () => {
    const fake = await fakePaperclip({
      pending: [],
      later: [`data: ${JSON.stringify(decision("approval", "ap-crlf"))}\r\n\r\n`],
    });
    const result = await run(fake.url, tmpFile());
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).id).toBe("ap-crlf");
  });

  it("exits 1 on an auth failure and keeps the token out of the output", async () => {
    const fake = await fakePaperclip({ pending: [] });
    const result = await run(fake.url, tmpFile(), "wrong-token");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTP 403");
    expect(result.stderr + result.stdout).not.toContain("wrong-token");
  });
});
