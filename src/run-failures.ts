import { createHash } from "node:crypto";

/** Run statuses that count as failures. `cancelled` is never one: someone chose to stop the run. */
export const RUN_FAILURE_STATUSES: readonly string[] = ["failed", "timed_out"];
export const DEFAULT_RUN_FAILURE_WINDOW_MINUTES = 30;
export const MAX_RUN_FAILURE_WINDOW_MINUTES = 1440;
/** How long a failure group stays in the pending set after its last failure. */
export const RUN_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RUN_FAILURE_EXCERPT_CHARS = 200;
const SIGNATURE_CHARS = 300;
const REDACTED = "[redacted]";

/** A failed run, as the `agent.run.failed` event and the reconciliation read both report it. */
export interface FailedRun {
  runId: string;
  agentId: string;
  status: string;
  error: string | null;
  /** Only the event carries it. */
  errorCode: string | null;
  issueId: string | null;
  /** ISO 8601. */
  failedAt: string;
}

/**
 * Patterns for credentials that adapters and CLIs tend to echo into error
 * text. Order matters: the key=value rule runs before the generic long-string
 * rule so the key name survives. Over-redaction is fine; the excerpt is a hint.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Credentials in URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Authorization header values
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // key=value and "key": "value" where the key names a secret
  [
    /\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|credential|cookie|session|auth)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Well-known token formats
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Any other long opaque string (keys, hashes, base64 blobs)
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, REDACTED],
];

/** Control characters become spaces, runs of whitespace collapse, then secrets are redacted. */
export function redact(text: string): string {
  let out = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** A redacted excerpt of at most RUN_FAILURE_EXCERPT_CHARS characters. Redaction runs before truncation. */
export function errorExcerpt(error: string | null): string {
  const text = redact(error ?? "");
  return text.length > RUN_FAILURE_EXCERPT_CHARS ? `${text.slice(0, RUN_FAILURE_EXCERPT_CHARS - 1)}…` : text;
}

/**
 * The part of an error that stays the same across retries: redacted,
 * lower-cased, with ids, hashes and numbers replaced by placeholders.
 * Version numbers fold too, which is fine for grouping within one agent.
 */
export function errorSignature(error: string | null): string {
  const text = redact(error ?? "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .slice(0, SIGNATURE_CHARS);
  return text || "<no error>";
}

/** Stable id for one agent's failures with one signature, independent of the window. */
export function failureGroupId(agentId: string, signature: string): string {
  return createHash("sha256").update(`${agentId}\n${signature}`).digest("hex").slice(0, 16);
}

/** Start of the fixed window holding `at`. Fixed windows give the event and the scan the same key. */
export function windowStart(at: number, windowMs: number): number {
  return Math.floor(at / windowMs) * windowMs;
}

/** Normalise an `agent.run.failed` payload. Returns null for anything that is not a failure. */
export function failedRunFromEvent(payload: unknown, occurredAt: string, entityId?: string): FailedRun | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  const runId = str(p.runId) ?? str(entityId);
  const agentId = str(p.agentId);
  const status = str(p.status);
  if (!runId || !agentId || !status || !RUN_FAILURE_STATUSES.includes(status)) return null;
  return {
    runId,
    agentId,
    status,
    error: str(p.error),
    errorCode: str(p.errorCode),
    issueId: str(p.issueId),
    failedAt: validIso(str(p.finishedAt)) ?? validIso(occurredAt) ?? new Date().toISOString(),
  };
}

export function validIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
