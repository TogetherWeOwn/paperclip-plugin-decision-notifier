#!/usr/bin/env node
// By default, wait on the authenticated user's native attention desk with interval
// reminders and snooze/dismissal filtering (attention-wait.mjs).
// With --source plugin, block until the decision stream announces a decision (or a failed-run group)
// this client has not seen, print it as one JSON line, and exit 0. Exit 1 on stream or
// auth failure, or after bounded catch-up retries, so the caller re-arms instead of hanging.
// If the host answers the stream with HTTP 501 (no plugin stream bus, as in
// stock Paperclip 2026.1023.0), poll the catch-up route every 30 s instead.
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
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseArgs } from "node:util";

const DEFAULT_PLUGIN = "togetherweown.decision-notifier";
/** setTimeout treats anything outside 1..2^31-1 ms as 1 ms, so fall back to the default instead. */
function delayFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 1 && value <= 2 ** 31 - 1 ? value : fallback;
}
/** Deadline for the catch-up call, the stream's response headers and its first frame, not for the idle stream. */
const REQUEST_TIMEOUT_MS = delayFromEnv("PAPERCLIP_DECISION_WAIT_TIMEOUT_MS", 120_000);
/** At most three catch-up attempts, with 500 ms then 1000 ms backoff; auth and other client failures fail fast. */
const CATCH_UP_ATTEMPTS = 3;
const CATCH_UP_BACKOFF_MS = 500;
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
/** Catch-up interval when the host has no stream bridge. */
const POLL_INTERVAL_MS = delayFromEnv("PAPERCLIP_DECISION_WAIT_POLL_MS", 30_000);
/** Idle time before TCP keepalive probes start, so a dead connection still fails the stream. */
const KEEPALIVE_MS = 60_000;
const KINDS = new Set(["approval", "interaction", "owner_card", "run_failure"]);
/** The plugin caps run failure excerpts at 200 characters; enforce it here too. */
const ERROR_EXCERPT_CHARS = 200;
/** Advisory routing audiences on decision events. */
const AUDIENCES = new Set(["owner", "operator", "board", "anyone"]);

const { values: args } = parseArgs({
  options: {
    company: { type: "string" },
    plugin: { type: "string", default: DEFAULT_PLUGIN },
    seen: { type: "string" },
    api: { type: "string" },
    audience: { type: "string" },
    "exclude-origin-kind": { type: "string" },
    source: { type: "string", default: "attention" },
  },
});

function fail(message) {
  process.stderr.write(`decision-wait: ${message}\n`);
  process.exit(1);
}

const parseCsv = (value) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

let audienceFilter = null;
if (args.audience !== undefined) {
  const values = parseCsv(args.audience);
  if (values.length === 0 || values.some((value) => !AUDIENCES.has(value))) {
    fail(`--audience must be a comma-separated list of ${[...AUDIENCES].join(", ")}`);
  }
  audienceFilter = new Set(values);
}
// Origin kinds to skip. Any string is a valid kind; an empty list skips nothing.
const excludeOriginKinds = args["exclude-origin-kind"] !== undefined ? new Set(parseCsv(args["exclude-origin-kind"])) : null;

const apiBase = (args.api ?? process.env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
const tokenFile = process.env.PAPERCLIP_BOARD_TOKEN_FILE;
if (!apiBase) fail("set PAPERCLIP_API_URL or --api");
if (!args.company) fail("--company is required");
if (!tokenFile) fail("set PAPERCLIP_BOARD_TOKEN_FILE");
const token = readFileSync(tokenFile, "utf8").trim();
if (!token) fail("token file is empty");

if (!["attention", "plugin"].includes(args.source)) fail("--source must be attention or plugin");
if (args.source === "attention") {
  const { waitForAttention } = await import("./attention-wait.mjs");
  await waitForAttention({ apiBase, token, companyId: args.company, seenFile: args.seen,
    timeoutMs: delayFromEnv("PAPERCLIP_DECISION_WAIT_TIMEOUT_MS", 30_000), pollMs: POLL_INTERVAL_MS,
    reminderMs: delayFromEnv("PAPERCLIP_DECISION_WAIT_REMINDER_MS", 30 * 60_000) }).catch((err) => fail(err.message));
  process.exit(0);
}

const headers = { Authorization: `Bearer ${token}` };
const plugin = encodeURIComponent(args.plugin);
const company = encodeURIComponent(args.company);

const readSeen = () =>
  args.seen && existsSync(args.seen) ? new Set(readFileSync(args.seen, "utf8").split("\n").filter(Boolean)) : new Set();
const seen = readSeen();
// A previously seen hint needs snapshot confirmation after pruning: live and
// replay frames have identical identities, including reopened approvals.
const startupSeen = new Set(seen);

/** Accept only the documented shape; anything else on the wire is ignored. */
function parseDecision(data) {
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const { kind, id, issueIdentifier, url, createdAt, audience, interactionKind, originKind, originId } = event;
  if (!KINDS.has(kind) || typeof id !== "string" || typeof url !== "string") return null;
  const decision = {
    kind,
    id,
    issueIdentifier: typeof issueIdentifier === "string" ? issueIdentifier : null,
    url,
    createdAt: typeof createdAt === "string" ? createdAt : null,
  };
  if (kind === "run_failure") return parseRunFailure(decision, event);
  // Routing fields are advisory: an unknown or missing audience reads as null
  // (announce it anyway; mixed-version rollouts must never drop a decision).
  // originId is host text; cap it like the error excerpt.
  return {
    ...decision,
    audience: AUDIENCES.has(audience) ? audience : null,
    interactionKind: typeof interactionKind === "string" ? interactionKind : null,
    originKind: typeof originKind === "string" ? originKind : null,
    originId: typeof originId === "string" ? originId.slice(0, ERROR_EXCERPT_CHARS) : null,
  };
}

/** Run failures add grouping fields and a redacted error excerpt (still untrusted text). */
function parseRunFailure(decision, event) {
  const { agentId, agentIds, count, firstRunId, lastRunId, firstFailedAt, lastFailedAt, errorCode, error } = event;
  const str = (value) => (typeof value === "string" ? value : null);
  if (typeof agentId !== "string" || typeof lastRunId !== "string" || !Number.isInteger(count) || count < 1) return null;
  const ids = Array.isArray(agentIds) ? agentIds.filter((id) => typeof id === "string") : [];
  return {
    ...decision,
    agentId,
    agentIds: ids.length > 0 ? ids : [agentId],
    count,
    firstRunId: str(firstRunId) ?? lastRunId,
    lastRunId,
    firstFailedAt: str(firstFailedAt),
    lastFailedAt: str(lastFailedAt),
    errorCode: str(errorCode),
    error: (str(error) ?? "").slice(0, ERROR_EXCERPT_CHARS),
  };
}

// createdAt is part of the key: an owner card that is unassigned and
// reassigned between two runs gets a new createdAt, so it announces again.
const seenKey = (decision) => `${decision.kind}:${decision.id}:${decision.createdAt ?? ""}`;

/**
 * Advisory routing: a filtered-out decision is neither announced nor marked
 * seen, so changing flags between runs does not lose it. Events with no
 * audience (older plugins) always pass the audience filter, and run failures
 * ignore it entirely.
 */
function passesFilters(decision) {
  if (decision.kind === "run_failure") return true;
  if (audienceFilter && decision.audience !== null && !audienceFilter.has(decision.audience)) return false;
  if (excludeOriginKinds && decision.originKind !== null && excludeOriginKinds.has(decision.originKind)) return false;
  return true;
}

let announcing = false;

/** Print an unseen decision; mark it seen only once stdout has taken it, then exit 0. */
function announce(decision) {
  if (announcing) return true;
  if (!passesFilters(decision)) return false;
  const key = seenKey(decision);
  if (seen.has(key)) return false;
  announcing = true;
  process.stdout.write(`${JSON.stringify(decision)}\n`, (err) => {
    if (err) fail(`stdout write failed: ${err.message}`);
    if (args.seen) appendFileSync(args.seen, `${key}\n`);
    process.exit(0);
  });
  return true;
}

/** Retry only transport failures, timeouts and explicitly transient HTTP statuses. */
async function fetchCatchUp() {
  for (let attempt = 1; attempt <= CATCH_UP_ATTEMPTS; attempt += 1) {
    // One deadline per attempt, including the body, not just response headers.
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let retryable;
    let reason;
    try {
      const response = await fetch(`${apiBase}/api/plugins/${plugin}/api/catch-up`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: args.company }),
        signal,
      });
      if (response.ok) return await response.json();
      reason = `HTTP ${response.status}`;
      retryable = RETRYABLE_HTTP.has(response.status);
      // Do not read or log error bodies: they can contain credentials or host text.
      await response.body?.cancel().catch(() => {});
    } catch (err) {
      retryable = signal.aborted || err instanceof TypeError;
      // Neither fetch errors nor JSON parse errors are safe to echo verbatim.
      reason = signal.aborted ? "request timed out" : err instanceof SyntaxError ? "invalid JSON response" : "network error";
    }
    if (!retryable || attempt === CATCH_UP_ATTEMPTS) throw new Error(`catch-up failed: ${reason}`);
    await new Promise((resolve) => setTimeout(resolve, CATCH_UP_BACKOFF_MS * 2 ** (attempt - 1)));
  }
}

async function catchUp() {
  const body = await fetchCatchUp();
  if (!Array.isArray(body?.pending)) throw new Error("catch-up failed: invalid pending snapshot");
  const pending = body.pending.map((e) => parseDecision(JSON.stringify(e)));
  // A missing or malformed snapshot is not evidence that a seen decision was resolved.
  if (pending.some((event) => !event || !event.id || !event.url || !event.createdAt || !Number.isFinite(Date.parse(event.createdAt)))) {
    throw new Error("catch-up failed: invalid pending snapshot");
  }
  if (args.seen && !announcing) {
    // Forget decisions that were resolved, so they announce again if they come back.
    const pendingKeys = new Set(pending.map(seenKey));
    const kept = [...readSeen()].filter((key) => pendingKeys.has(key));
    writeFileSync(args.seen, kept.length ? `${kept.join("\n")}\n` : "");
    for (const key of seen) if (!pendingKeys.has(key)) seen.delete(key);
  }
  return pending;
}

let streamCatchUpRunning = false;
const oldHints = new Set();
let confirmedPending = new Map();

/** Coalesce old hints into one snapshot read; keep SSE responsive throughout. */
async function refreshStream() {
  if (streamCatchUpRunning || announcing) return;
  streamCatchUpRunning = true;
  try {
    do {
      // This read is requested after all currently queued hints. Hints arriving
      // during it need another read unless its snapshot confirms their payload.
      oldHints.clear();
      // A prior snapshot cannot confirm hints arriving during a newer read.
      confirmedPending.clear();
      const pending = await catchUp();
      if (!announcing) pending.some(announce);
      // Confirm excluded work without marking it seen. Keep the payload so a
      // replay delivered after HTTP does not start another read; a different
      // routing update received during this read still needs confirmation.
      confirmedPending = new Map(pending.filter((decision) => startupSeen.has(seenKey(decision)))
        .map((decision) => [seenKey(decision), JSON.stringify(decision)]));
      for (const payload of confirmedPending.values()) oldHints.delete(payload);
    } while (!announcing && oldHints.size > 0);
  } catch (err) {
    if (!announcing) fail(err.message);
  } finally {
    streamCatchUpRunning = false;
  }
}

/** Poll mode: catch-up returns the pending list, so announce from it directly. */
async function poll() {
  for (;;) {
    const pending = await catchUp();
    if (pending.some(announce)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

const decoder = new TextDecoder();
let buffer = "";
let pendingCr = "";
let caughtUp = false;
/** Deadline for the first frame after the headers; until it arrives, catch-up has not run. */
let firstFrameTimer;

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
      clearTimeout(firstFrameTimer);
      // Catch-up may need retries, but a healthy stream must keep delivering
      // live decisions and close frames while that request is in flight.
      void refreshStream();
    }
    if (type === "close") {
      if (!announcing) fail("stream closed by the plugin worker");
      return true;
    }
    if (type !== "message" || data.length === 0) continue;
    const payload = data.join("\n");
    const decision = parseDecision(payload);
    if (!decision) continue;
    const key = seenKey(decision);
    if (startupSeen.has(key) && (streamCatchUpRunning || !seen.has(key))) {
      // Never guess whether an old frame is a replay or a reopened cycle. A
      // read requested after this hint confirms it is still pending. Queue
      // hints during the initial snapshot too, rather than losing that race.
      const payload = JSON.stringify(decision);
      if (confirmedPending.get(key) === payload) continue;
      oldHints.add(payload);
      void refreshStream();
      continue;
    }
    if (announce(decision)) return true;
  }
  return false;
}

async function readStream(stream) {
  let announced = false;
  for await (const chunk of stream) {
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
  if (!announced && !announcing) fail("stream ended");
}

/**
 * Open the stream with node:http rather than fetch. Fetch (undici) aborts a
 * body that sends nothing for 300 s, and Paperclip sends no SSE heartbeat, so
 * an idle fetch stream died every five minutes. Here only the wait for
 * response headers has a deadline; TCP keepalive notices a dead peer.
 */
function openStream(href) {
  // A throw in here (bad URL, unsupported protocol) rejects the promise, so it reaches fail().
  return new Promise((resolve, reject) => {
    const url = new URL(href);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { headers: { ...headers, Accept: "text/event-stream" } },
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    );
    const timer = setTimeout(() => request.destroy(new Error("timed out waiting for the stream")), REQUEST_TIMEOUT_MS);
    request.on("socket", (socket) => socket.setKeepAlive(true, KEEPALIVE_MS));
    request.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}

const response = await openStream(`${apiBase}/api/plugins/${plugin}/bridge/stream/decisions?companyId=${company}`).catch((err) => fail(`stream failed: ${err.message}`));
// Headers arrived: once the first frame is in, the stream may idle for as long as no decision is pending.
const status = response.statusCode;
if (status === 501) {
  // "Plugin stream bridge is not enabled": the host never wires a stream bus.
  response.destroy();
  process.stderr.write(`decision-wait: stream bridge not enabled; polling catch-up every ${POLL_INTERVAL_MS / 1000} s\n`);
  await poll().catch((err) => fail(err.message));
} else {
  if (status < 200 || status > 299) fail(`stream failed: HTTP ${status}`);
  firstFrameTimer = setTimeout(() => fail("stream failed: no frame after the headers"), REQUEST_TIMEOUT_MS);
  await readStream(response).catch((err) => {
    if (!announcing) fail(`stream failed: ${err.message}`);
  });
}
