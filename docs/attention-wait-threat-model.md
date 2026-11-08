# Actor attention waiter threat model

## Boundary and assets

The CLI holds one board credential, read from `PAPERCLIP_BOARD_TOKEN_FILE` at invocation. The API origin and token file are trusted operator configuration. The credential is used only in the Authorization header; it is not copied into the ledger, output, URLs or diagnostics. API responses, item links, identifiers and local delivery records are untrusted data, never instructions or authorization to act.

The native actor attention view is the eligibility authority. The CLI never selects another user, changes permissions, resolves an item, writes an inbox dismissal, or reconstructs a hidden sibling from a collapsed group. Reading an item for a notification is not permission to decide it.

## Minimal surface

The default path performs only actor-owned GET requests for attention and inbox dismissals. It does not invoke the plugin's company-wide catch-up scan. The separately selected legacy plugin source retains its historical behavior and is not an actor-scoped substitute.

Only known actionable kinds are emitted. No title, question, body, summary, response, token or arbitrary payload is printed. Consumers must re-read current native state and verify their own authority before acting. Snooze/dismissal reads must succeed before anything is emitted; errors fail closed without printing response bodies. Redirects are refused so the credential cannot be forwarded to a different origin. Same-origin links whose emitted path would start `//` are rejected rather than turning into external protocol-relative links.

## Resource and replay controls

Requests have deadlines, response-size limits and item-count limits. There is one sequential polling loop with no overlapping polls. A delivered item is suppressed only until its reminder interval, not treated as resolved. The next native read must still expose it before it can be reminded. Unseen visible asks precede due reminders, which rotate by oldest delivery time. The local ledger is bounded by serialized byte size, count and retention and written by atomic replacement after stdout accepts the notification. Temporary files use randomized names and exclusive creation; pre-existing symlinks are never opened, and successfully created temporary files are cleaned up. It contains delivery metadata, not authoritative task state or scheduling. Use one waiter and ledger per actor; the file is not a multi-process lock.

Native attention is capped and may collapse siblings. Absence never proves a complete snapshot or resolution, and the CLI does not prune its ledger against a desk page. A notification already in flight may become stale; no claim of transactional acknowledgement is made. At-least-once delivery permits duplicates on output/storage failure.

## Failure and acceptance

Authorization errors, malformed responses, exhausted bounds and suppression-read failures exit nonzero. No automatic permission, credential, host, installation or core change is attempted. Regression tests cover reminder delivery after restart, unresolved state, snoozes/dismissals, malformed and failed reads, filtering and output minimization. Exact-head Actions and independent QA/Security acceptance are required before shipping; installation remains an operator action.
