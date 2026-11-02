# paperclip-plugin-decision-notifier

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that pushes pending **board decisions** and **failed agent runs** to whoever is listening on a board-authenticated plugin stream. It exists so an operator session can wait for decisions instead of polling, and hear about broken runs before a card quietly ends up `blocked`.

A decision is one of:

| kind | pending when | source |
|---|---|---|
| `approval` | approval status is `pending` | `approval.created` / `approval.decided` events, plus the scan job |
| `interaction` | a thread interaction (decision card) is `pending`, not addressed to an agent, on a card that is not done or cancelled | the scan job, and `issue.created` / `issue.updated` events for that card |
| `owner_card` | an open card (`todo`, `in_progress`, `in_review`, `blocked`) is assigned to an owner user | `issue.created` / `issue.updated` events, plus the scan job |

Agent-addressed interactions are left out on purpose: Paperclip already wakes that agent.

The stream also carries one non-decision kind:

| kind | pending when | source |
|---|---|---|
| `run_failure` | an agent run ended `failed` or `timed_out` in the last 24 hours | `agent.run.failed` events, plus a reconciliation in the scan job every 5 minutes |

Failures are grouped: one item per normalised error signature and fixed window (30 minutes by default), across agents. Retries that hit the same error, such as an adapter rejecting the configured model three times before Paperclip's bounded retry blocks the card, become one item with a `count`, not three, and an outage that fails runs on many agents at once is one item listing those agents. A company gets at most 5 new items per window; further distinct failures in that window share one overflow item. Cancelled runs are never announced: someone chose to stop them.

Thread interactions are not plugin events in Paperclip 2026.1023.0. Until [paperclipai/paperclip#4990](https://github.com/paperclipai/paperclip/pull/4990) ships, a scan job (`* * * * *`) finds them, so a new interaction reaches the stream within about a minute. Approvals and owner cards arrive as soon as Paperclip delivers the event.

The scan covers the companies the plugin has been invoked for — via events, `company.created`, or the catch-up route — remembered in plugin state, with the full company list re-read as a refresh at most every 15 minutes when the host allows it. A scheduled job runs without a company invocation scope, and listing all companies is exactly the call such a caller may not be granted, so the scan never depends on it.

## Events

Every decision event (`approval`, `interaction`, `owner_card`) on the `decisions` channel has exactly this shape:

```json
{"kind":"interaction","id":"…","issueIdentifier":"TWO-214","url":"https://paperclip.example.com/TWO/issues/TWO-214","createdAt":"2026-10-31T11:00:00.000Z","audience":"board","interactionKind":"request_confirmation","originKind":null,"originId":null}
```

There is no title, summary, payload or comment text. That text is written by agents and users and is untrusted, so a consumer must re-read the item from Paperclip before acting on it. `issueIdentifier` is `null` for approvals. For owner cards `createdAt` is the card's last update when it was first seen.

The four routing fields are host-derived hints for wake-up/skip decisions, never authorization:

- `audience` is one of `owner`, `board` or `anyone`. An interaction addressed to a user is `owner`; otherwise an interaction whose effective resolver policy is `human_only` is `board`; anything else is `anyone`. Approvals are `board`; owner-assigned cards are `owner`.
- `interactionKind` is the interaction's kind (`request_confirmation`, `ask_user_questions`, …) for interactions, `null` otherwise.
- `originKind` / `originId` are the issue's origin, passed through verbatim and never parsed by this plugin; they are `null` for approvals, which belong to no issue. Events on cards the board council created carry `originKind: "plugin:board-council"`.

Consumer rules (binding on the operator session and any stream consumer):

- `audience` is advisory routing only. A consumer re-reads the interaction (addressee, effective policy, status) before acting; events from older plugin versions have no audience and must still be announced, never silently dropped.
- `originKind: "plugin:board-council"` means hands off: never resolve, skip or cancel such an event. The announcement exists so a human-facing session can see that an owner window is open.
- `audience: "owner"` means only that user resolves it. Agent consumers take no action except, where their instructions allow, reminding the owner out-of-band.
- Once the council is live, `audience: "anyone"` interactions in board-decision categories are instruction-compliance failures (the requesting agent skipped the council route). The operator does not resolve them; it comments with the correct route and the creator withdraws and reopens as a matter. These events are countable from the catch-up list (`audience: "anyone"`, `originKind` not `plugin:board-council`, by `interactionKind` and `createdAt`); the plugin keeps no counters of its own.

A `run_failure` adds grouping fields and a short error excerpt, because a failed run is useless to the operator without at least a hint of why:

```json
{"kind":"run_failure","id":"3f9a…@2026-10-31T11:00:00.000Z","issueIdentifier":"TWO-214","url":"https://paperclip.example.com/TWO/agents/<agentId>/runs/<lastRunId>","createdAt":"2026-10-31T11:00:00.000Z","agentId":"…","agentIds":["…"],"count":3,"firstRunId":"…","lastRunId":"…","firstFailedAt":"2026-10-31T11:02:10.000Z","lastFailedAt":"2026-10-31T11:09:45.000Z","errorCode":"adapter_failed","error":"ACP agent reported a terminal service failure: …"}
```

- `id` is `<group>@<window start>`, where the group is a hash of the error signature. `createdAt` is the window start, so `kind` + `id` + `createdAt` dedupes exactly like the other kinds. Later failures in the same group raise `count` and extend `agentIds` in the stored item (seen on catch-up) but are not announced again. `agentId` is the agent of the latest failed run; `agentIds` lists every agent in the group in first-seen order.
- The signature is the redacted, lower-cased error with temp paths (`/tmp/…`, `/var/folders/…`, Windows `…\Temp\…`), UUIDs, prefixed IDs (`req_…`, `msg_…`, `toolu_…`, `run_…`, `call_…`, `chatcmpl-…` and similar), any other token of 12 or more characters mixing letters and digits, hex strings and numbers replaced, so retries that differ only in request IDs, temp directories, attempt numbers or durations group together. Version numbers fold too.
- Once a window has 5 groups, every further distinct signature in that window goes to one `overflow@<window start>` item instead, announced once. Its `error` is `"N more distinct failures"` (N grows in the stored item), its `errorCode` is `null`, and its other fields work as for any group. Open the runs to see the individual errors.
- `error` is the first run's error with control characters flattened, credentials redacted (bearer tokens of any length and basic tokens, `key=value` and JSON pairs whose key names a token, secret, password, cookie or session, `NAME_KEY=`, `NAME_TOKEN=` and `NAME_SECRET=` values, `pwd=` and `pass=`, space-separated flags such as `--api-key X` and `--token X`, with a quoted value redacted through its closing quote, credentials in URLs, common API key and token formats including `sk-` and `sk_` keys, JWTs, email addresses and long opaque strings), then cut to 200 characters. Redaction runs before truncation. It is still untrusted text: open the run before acting.
- `url` points at the latest failed run. `issueIdentifier` is that run's card, or `null` when the run had none or the plugin cannot read the card. `errorCode` comes only from the event; a group found only by reconciliation has `null` until an event fills it in.

Each decision is announced once. The set of pending decisions is kept per company in `plugin.state`, so a worker restart does not re-announce. A decision that is resolved and later becomes pending again is announced again. Run failure groups are kept the same way, with the run IDs they counted, so an event and the reconciliation never count one run twice; a group leaves the set 24 hours after its last failure.

## Consuming the stream

```
GET  /api/plugins/togetherweown.decision-notifier/bridge/stream/decisions?companyId=<companyId>
POST /api/plugins/togetherweown.decision-notifier/api/catch-up   {"companyId":"<companyId>"}
```

Both need a board credential (a board API key or browser session). The stream is Server-Sent Events. Decisions are the plain `data:` frames. Ignore `event: open`. On `event: close` the plugin worker has stopped and Paperclip leaves the response open with nothing behind it: disconnect, reconnect, and call catch-up again. The wait client exits 1 on `close` so its caller re-arms.

Paperclip does not tell a plugin when a client connects, so catch-up is an explicit call: open the stream, wait for the server's `:ok` comment, then `POST /catch-up`. The plugin rescans, replays every pending decision and every run failure group still in its 24-hour retention onto the stream, and also returns them as `{"pending":[…]}`. Subscribing first means nothing falls between the replay and live events. Catch-up calls for a company within 10 s of its last catch-up scan, with the same config and issue prefix, replay the stored set instead of rescanning, so a client calling in a loop costs one scan per 10 s. Approval and card events keep that set current. Thread interactions have no event: one raised since the last scan is missing from such a replay until the next scan job announces it on the stream, within about a minute. A polling client sees it on its next catch-up outside the window.

### `paperclip-decision-wait`

`bin/decision-wait.mjs` does the above and exits on the first decision or run failure group it has not seen before, printing it as one JSON line (for `run_failure`, with the fields above; the excerpt is capped at 200 characters again on the client). It is meant to run as a background command that wakes a session when it exits:

```sh
PAPERCLIP_API_URL=https://paperclip.example.com \
PAPERCLIP_BOARD_TOKEN_FILE=$HOME/.paperclip/board-token \
paperclip-decision-wait --company <companyId> --seen $HOME/.cache/paperclip-decisions-seen
```

- `--company` is required. `--api` overrides `PAPERCLIP_API_URL`; a trailing `/api` is stripped from either. `--plugin` overrides the plugin ID (default `togetherweown.decision-notifier`). `--audience <csv>` wakes only for decisions with one of the listed audiences (`owner`, `board`, `anyone`); anything else is silently skipped and never marked seen. `--exclude-origin-kind <csv>` skips events whose `originKind` is listed (for example `plugin:board-council`), also without marking them seen. With neither flag the waiter behaves exactly as before. Events with no audience (older plugins) always pass `--audience`, and `run_failure` items ignore it entirely.
- The token is read from a file, never from argv.
- `--seen` lists announced decisions as `kind:id:createdAt`. Replayed decisions already in it do not wake the caller; entries that are no longer pending are pruned on connect. A card that is unassigned and reassigned gets a new `createdAt`, so it announces again. Use one waiter per `--seen` file; the file is not locked across processes.
- A decision is marked seen only after stdout has accepted it.
- Events are hints: a decision can resolve between the replay and your read. Re-read it from Paperclip before acting.
- The catch-up call, the wait for stream headers and the wait for the first frame after them time out after 30 s (`PAPERCLIP_DECISION_WAIT_TIMEOUT_MS`, a whole number of ms; invalid values fall back to the default). The open stream itself has no deadline: Paperclip sends no heartbeat, so the client reads the stream with Node's `http` module, which has no idle limit (fetch would abort after 300 s of silence), and turns on TCP keepalive so a dead connection still fails the stream.
- The stream request does not follow redirects. Point `--api` at the final URL.
- If the stream answers HTTP 501 ("Plugin stream bridge is not enabled"), the host has no plugin stream bus; stock Paperclip 2026.1023.0 does not wire one. The client then polls `POST /catch-up` every 30 s (`PAPERCLIP_DECISION_WAIT_POLL_MS`) with the same `--seen` handling and exits on the first unseen decision. A new decision then wakes the caller within the poll interval plus the plugin's one-minute scan for interactions. Hosts that wire the bus keep the push stream.
- Exit 0 means a decision was printed. Exit 1 means a required setting is missing, the connection or auth failed, or the stream ended or broke; the reason is one `decision-wait: …` line on stderr. An unreadable token file or an unknown flag also exits 1, but with Node's own error instead of that line.

## Configuration

| key | default | meaning |
|---|---|---|
| `publicBaseUrl` | `""` | Web app base URL for event links. Links are relative paths when empty. |
| `ownerUserIds` | `[]` | User IDs whose assigned open cards count as decisions. Empty means any card assigned to a user. |
| `runFailures.enabled` | `true` | Announce failed and timed-out agent runs. When `false`, run failures are neither collected nor replayed. |
| `runFailures.windowMinutes` | `30` | Length of the fixed grouping window, 1 to 1440. Invalid values fall back to 30. |

## Capabilities

`companies.read`, `issues.read`, `issue.interactions.read`, `approvals.read`, `issues.orchestration.read` (to read a card's runs during reconciliation), `events.subscribe`, `jobs.schedule`, `plugin.state.read`, `plugin.state.write`, `api.routes.register`. The plugin only reads; it never decides, comments or changes anything.

## Limits

- Private cards the plugin cannot read are not scanned.
- The scan reads interactions for every card that is not done or cancelled (including `backlog`) each minute. That is fine for hundreds of such cards; it is temporary until #4990 lets the plugin subscribe instead.
- Card lists are read without `limit`/`offset`: in Paperclip 2026.1023.0 the host applies `offset` twice for plugin issue lists, so paging past the first page returns nothing.
- Run failure reconciliation reads the runs of open cards assigned to an agent (`ctx.issues.summaries.getOrchestration`, up to 100 runs per card), at most once every 5 minutes per company, from a cursor stored in `plugin.state`. The plugin SDK has no company-wide run list, so a dropped `agent.run.failed` event for a run with no card, or whose card is already done, cancelled or assigned to a user, is not recovered. The cursor only advances after a pass in which every read succeeded. On first start it looks back one window.
- Runs beyond the first 100 on a card are not read (`getOrchestration` takes no paging parameter). A dropped `agent.run.failed` event for such a run is not recovered; the plugin logs a `run page full` warning when a card returns a full page.
- Delivery is at-least-once. Consumers should dedupe on `kind` + `id` + `createdAt`, as the wait client does; `createdAt` changes when an owner card starts a new pending cycle.

## Development

```sh
npm ci
npm run check   # typecheck, tests, build
```

## License

MIT
