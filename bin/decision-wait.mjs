#!/usr/bin/env node
// Block until the decision stream announces a decision this client has not
// seen, print it as one JSON line, and exit 0. Exit 1 on any connection or
// auth failure, so the caller re-arms (or reports) instead of hanging.
//
//   PAPERCLIP_API_URL=https://paperclip.example.com \
//   PAPERCLIP_BOARD_TOKEN_FILE=~/.paperclip/board-token \
//   paperclip-decision-wait --company <companyId> --seen ~/.cache/decisions-seen
//
// The token is read from a file, never from argv, so it stays out of `ps`.
// On connect the script asks the plugin to replay every pending decision
// (catch-up); --seen remembers announced ones so a replay only wakes the
// caller for new work, and entries that are no longer pending are pruned.
// Run one waiter per --seen file; the file is not locked across processes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const DEFAULT_PLUGIN = "togetherweown.decision-notifier";
const KINDS = new Set(["approval", "interaction", "owner_card"]);

const { values: args } = parseArgs({
  options: {
    company: { type: "string" },
    plugin: { type: "string", default: DEFAULT_PLUGIN },
    seen: { type: "string" },
    api: { type: "string" },
  },
});

function fail(message) {
  process.stderr.write(`decision-wait: ${message}\n`);
  process.exit(1);
}

const apiBase = (args.api ?? process.env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
const tokenFile = process.env.PAPERCLIP_BOARD_TOKEN_FILE;
if (!apiBase) fail("set PAPERCLIP_API_URL or --api");
if (!args.company) fail("--company is required");
if (!tokenFile) fail("set PAPERCLIP_BOARD_TOKEN_FILE");
const token = readFileSync(tokenFile, "utf8").trim();
if (!token) fail("token file is empty");

const headers = { Authorization: `Bearer ${token}` };
const plugin = encodeURIComponent(args.plugin);
const company = encodeURIComponent(args.company);

const readSeen = () =>
  args.seen && existsSync(args.seen) ? new Set(readFileSync(args.seen, "utf8").split("\n").filter(Boolean)) : new Set();
const seen = readSeen();

/** Accept only the documented shape; anything else on the wire is ignored. */
function parseDecision(data) {
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const { kind, id, issueIdentifier, url, createdAt } = event;
  if (!KINDS.has(kind) || typeof id !== "string" || typeof url !== "string") return null;
  return {
    kind,
    id,
    issueIdentifier: typeof issueIdentifier === "string" ? issueIdentifier : null,
    url,
    createdAt: typeof createdAt === "string" ? createdAt : null,
  };
}

// createdAt is part of the key: an owner card that is unassigned and
// reassigned between two runs gets a new createdAt, so it announces again.
const seenKey = (decision) => `${decision.kind}:${decision.id}:${decision.createdAt ?? ""}`;

/** Print an unseen decision; mark it seen only once stdout has taken it, then exit 0. */
function announce(decision) {
  const key = seenKey(decision);
  if (seen.has(key)) return false;
  process.stdout.write(`${JSON.stringify(decision)}\n`, (err) => {
    if (err) fail(`stdout write failed: ${err.message}`);
    if (args.seen) appendFileSync(args.seen, `${key}\n`);
    process.exit(0);
  });
  return true;
}

async function catchUp() {
  const response = await fetch(`${apiBase}/api/plugins/${plugin}/api/catch-up`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ companyId: args.company }),
  });
  if (!response.ok) fail(`catch-up failed: HTTP ${response.status}`);
  const body = await response.json();
  const pending = Array.isArray(body?.pending) ? body.pending.map((e) => parseDecision(JSON.stringify(e))).filter(Boolean) : [];
  if (args.seen) {
    // Forget decisions that were resolved, so they announce again if they come back.
    const pendingKeys = new Set(pending.map(seenKey));
    const kept = [...readSeen()].filter((key) => pendingKeys.has(key));
    writeFileSync(args.seen, kept.length ? `${kept.join("\n")}\n` : "");
    for (const key of seen) if (!pendingKeys.has(key)) seen.delete(key);
  }
}

const response = await fetch(`${apiBase}/api/plugins/${plugin}/bridge/stream/decisions?companyId=${company}`, {
  headers: { ...headers, Accept: "text/event-stream" },
});
if (!response.ok || !response.body) fail(`stream failed: HTTP ${response.status}`);

const decoder = new TextDecoder();
let buffer = "";
let pendingCr = "";
let caughtUp = false;

/** Handle every complete frame in the buffer. Returns true once a decision is announced. */
async function drainFrames() {
  let boundary;
  while ((boundary = buffer.indexOf("\n\n")) !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    let type = "message";
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!caughtUp) {
      // The server's first frame (":ok") means we are subscribed; replay now so nothing falls in a gap.
      caughtUp = true;
      await catchUp();
    }
    if (type === "close") fail("stream closed by the plugin worker");
    if (type !== "message" || data.length === 0) continue;
    const decision = parseDecision(data.join("\n"));
    if (decision && announce(decision)) return true;
  }
  return false;
}

let announced = false;
for await (const chunk of response.body) {
  // SSE allows CRLF or CR line endings; the host sends LF, but normalise anyway.
  // A trailing CR waits for the next chunk, in case it is the first half of CRLF.
  let text = pendingCr + decoder.decode(chunk, { stream: true });
  pendingCr = text.endsWith("\r") ? "\r" : "";
  if (pendingCr) text = text.slice(0, -1);
  buffer += text.replace(/\r\n?/g, "\n");
  // announce() exits once stdout has flushed; stop reading in the meantime.
  if ((announced = await drainFrames())) break;
}
if (!announced && pendingCr) {
  // The stream ended on a lone CR: it was a line ending, not half of CRLF.
  buffer += "\n";
  announced = await drainFrames();
}
if (!announced) fail("stream ended");
