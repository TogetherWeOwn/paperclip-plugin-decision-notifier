import { deliveryState } from "./attention-state.mjs";

const KINDS = new Set(["issue_thread_interaction", "approval", "decision"]);
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 5;
const MAX_DISMISSALS = 10_000;
const text = (value, max = 512) => typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Read only the authenticated board actor's native view; never select or impersonate a user. */
export async function waitForAttention({ apiBase, token, companyId, seenFile, timeoutMs, pollMs, reminderMs }) {
  const base = new URL(apiBase);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("invalid API origin");
  const headers = { Authorization: `Bearer ${token}` };
  async function read(path, signal) {
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, { headers, signal, redirect: "error" });
    } catch {
      throw new Error("attention request failed or timed out");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`attention request failed: HTTP ${response.status}`);
    }
    let raw = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) throw new Error("oversized response");
        raw += decoder.decode(chunk, { stream: true });
      }
      raw += decoder.decode();
      return JSON.parse(raw);
    } catch {
      throw new Error("invalid, oversized or timed-out attention response");
    }
  }

  const identity = await read("/api/auth/get-session", AbortSignal.timeout(timeoutMs));
  const userId = identity?.session?.userId;
  if (!text(userId)) throw new Error("attention requires an authenticated board user");
  const state = deliveryState(seenFile, JSON.stringify([base.origin, companyId, userId]));
  const path = `/api/companies/${encodeURIComponent(companyId)}`;
  let warned = false;
  for (;;) {
    // One shared deadline for all pages plus suppressions; no full-company plugin scans.
    const signal = AbortSignal.timeout(timeoutMs);
    const items = [];
    const cursors = new Set();
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ limit: "100", sort: "activity" });
      if (cursor) query.set("cursor", cursor);
      const feed = await read(`${path}/attention?${query}`, signal);
      if (feed?.companyId !== companyId || !Array.isArray(feed.items) || feed.items.length > 100 ||
          !(feed.nextCursor === null || text(feed.nextCursor, 4096))) throw new Error("invalid attention feed");
      items.push(...feed.items);
      cursor = feed.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error("repeated attention cursor");
      cursors.add(cursor);
    }
    if (cursor && !warned) {
      process.stderr.write("decision-wait: attention page budget reached; coverage is partial\n");
      warned = true;
    }
    // Read suppressions AFTER the desk snapshot, before producing any notification.
    const rows = await read(`${path}/inbox-dismissals`, signal);
    if (!Array.isArray(rows) || rows.length > MAX_DISMISSALS) throw new Error("invalid or oversized inbox dismissals");
    const dismissals = new Map();
    for (const row of rows) {
      if (row?.companyId !== companyId || row.userId !== userId || !text(row.itemKey, 2048) ||
          !["dismiss", "snooze"].includes(row.kind) || !timestamp(row.dismissedAt) ||
          (row.kind === "snooze" && !timestamp(row.snoozedUntil))) throw new Error("invalid inbox dismissal");
      dismissals.set(row.itemKey, row);
    }
    const now = Date.now();
    const eligible = [];
    for (const item of items) {
      if (!KINDS.has(item?.sourceKind)) continue;
      const subject = item.subject;
      if (item.companyId !== companyId || subject?.companyId !== companyId || !text(subject.id) ||
          !text(item.dismissalKey, 2048) || !timestamp(item.createdAt) || !timestamp(item.activityAt)) throw new Error("invalid actionable attention item");
      if (subject.status !== (item.sourceKind === "decision" ? "open" : "pending") || item.archivedAt) continue;
      const audience = item.resolverAudience;
      if (item.sourceKind === "issue_thread_interaction" && audience?.addresseeUserId && audience.addresseeUserId !== userId) continue;
      if (item.snoozedUntil != null && !timestamp(item.snoozedUntil)) throw new Error("invalid attention snooze");
      if (Date.parse(item.snoozedUntil) > now || item.dismissal?.isActive === true) continue;
      if (item.sourceKind === "decision" && item.expiresAt != null) {
        if (!timestamp(item.expiresAt)) throw new Error("invalid decision expiry");
        if (Date.parse(item.expiresAt) <= now) continue;
      }
      // Approvals can also be suppressed from the ordinary inbox, under its own key.
      const keys = [item.dismissalKey];
      if (item.sourceKind === "approval") keys.push(`approval:${subject.id}`);
      if (keys.some((key) => {
        const dismissal = dismissals.get(key);
        return dismissal && (dismissal.kind === "snooze" ? Date.parse(dismissal.snoozedUntil) > now : Date.parse(dismissal.dismissedAt) >= Date.parse(item.activityAt));
      })) continue;
      const legacyKind = item.sourceKind === "issue_thread_interaction" ? "interaction" : item.sourceKind;
      const key = `${legacyKind}:${subject.id}:${item.createdAt}`;
      const previous = state.previous(key);
      // Future local timestamps (clock rollback or malformed state) must not silence an ask indefinitely.
      if (previous !== null && previous <= now && now - previous < reminderMs) continue;
      if (!text(subject.href, 2048)) throw new Error("attention item has no valid link");
      let url;
      try { url = new URL(subject.href, base); } catch { throw new Error("invalid attention item link"); }
      if (url.origin !== base.origin || url.username || url.password || url.pathname.startsWith("//")) throw new Error("invalid attention item link");
      const event = {
        kind: item.sourceKind,
        id: subject.id,
        issueIdentifier: typeof item.relatedIssue?.identifier === "string" ? item.relatedIssue.identifier.slice(0, 128) : null,
        url: `${url.pathname}${item.sourceKind === "decision" ? `?${new URLSearchParams({ decisionId: subject.id })}` : ""}${url.hash}`,
        createdAt: item.createdAt,
        reminder: previous !== null,
        ageMs: Math.max(0, now - Date.parse(item.createdAt)),
        interactionKind: item.sourceKind === "issue_thread_interaction" && text(subject.metadata?.kind) ? subject.metadata.kind : null,
        addresseeUserId: text(audience?.addresseeUserId) ? audience.addresseeUserId : null,
      };
      eligible.push({ event, key, previous });
    }
    // A regularly re-armed waiter must not let a due reminder starve unseen work.
    eligible.sort((a, b) => (a.previous === null ? -Infinity : a.previous) - (b.previous === null ? -Infinity : b.previous));
    const next = eligible[0];
    if (next) {
      // Native attention has no plugin audience/origin hints. Unknown hints pass the old advisory filters.
      await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(next.event)}\n`, (err) => err ? reject(err) : resolve()));
      state.delivered(next.key, Date.now());
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
