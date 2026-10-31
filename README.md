# paperclip-plugin-decision-notifier

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that pushes pending **board decisions** to whoever is listening on a board-authenticated plugin stream. It exists so an operator session can wait for decisions instead of polling.

A decision is one of:

| kind | pending when | source |
|---|---|---|
| `approval` | approval status is `pending` | `approval.created` / `approval.decided` events, plus the scan job |
| `interaction` | a thread interaction (decision card) is `pending`, not addressed to an agent, on a card that is not done or cancelled | the scan job, and `issue.created` / `issue.updated` events for that card |
| `owner_card` | an open card (`todo`, `in_progress`, `in_review`, `blocked`) is assigned to an owner user | `issue.created` / `issue.updated` events, plus the scan job |

Agent-addressed interactions are left out on purpose: Paperclip already wakes that agent.

Thread interactions are not plugin events in Paperclip 2026.1023.0. Until [paperclipai/paperclip#4990](https://github.com/paperclipai/paperclip/pull/4990) ships, a scan job (`* * * * *`) finds them, so a new interaction reaches the stream within about a minute. Approvals and owner cards arrive as soon as Paperclip delivers the event.

## Events

Every event on the `decisions` channel has exactly this shape:

```json
{"kind":"interaction","id":"…","issueIdentifier":"TWO-214","url":"https://paperclip.example.com/TWO/issues/TWO-214","createdAt":"2026-10-31T11:00:00.000Z"}
```

There is no title, summary, payload or comment text. That text is written by agents and users and is untrusted, so a consumer must re-read the item from Paperclip before acting on it. `issueIdentifier` is `null` for approvals. For owner cards `createdAt` is the card's last update when it was first seen.

Each decision is announced once. The set of pending decisions is kept per company in `plugin.state`, so a worker restart does not re-announce. A decision that is resolved and later becomes pending again is announced again.

## Consuming the stream

```
GET  /api/plugins/togetherweown.decision-notifier/bridge/stream/decisions?companyId=<companyId>
POST /api/plugins/togetherweown.decision-notifier/api/catch-up   {"companyId":"<companyId>"}
```

Both need a board credential (a board API key or browser session). The stream is Server-Sent Events. Decisions are the plain `data:` frames. Ignore `event: open`. On `event: close` the plugin worker has stopped and Paperclip leaves the response open with nothing behind it: disconnect, reconnect, and call catch-up again. The wait client exits 1 on `close` so its caller re-arms.

Paperclip does not tell a plugin when a client connects, so catch-up is an explicit call: open the stream, wait for the server's `:ok` comment, then `POST /catch-up`. The plugin rescans, replays every pending decision onto the stream, and also returns them as `{"pending":[…]}`. Subscribing first means nothing falls between the replay and live events. Catch-up calls for a company within 10 s of its last catch-up scan, with the same config and issue prefix, replay the stored set instead of rescanning, so a client calling in a loop costs one scan per 10 s. Approval and card events keep that set current. Thread interactions have no event: one raised since the last scan is missing from such a replay until the next scan job announces it on the stream, within about a minute. A polling client sees it on its next catch-up outside the window.

### `paperclip-decision-wait`

`bin/decision-wait.mjs` does the above and exits on the first decision it has not seen before, printing it as one JSON line. It is meant to run as a background command that wakes a session when it exits:

```sh
PAPERCLIP_API_URL=https://paperclip.example.com \
PAPERCLIP_BOARD_TOKEN_FILE=$HOME/.paperclip/board-token \
paperclip-decision-wait --company <companyId> --seen $HOME/.cache/paperclip-decisions-seen
```

- `--company` is required. `--api` overrides `PAPERCLIP_API_URL`; a trailing `/api` is stripped from either. `--plugin` overrides the plugin ID (default `togetherweown.decision-notifier`).
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

## Capabilities

`companies.read`, `issues.read`, `issue.interactions.read`, `approvals.read`, `events.subscribe`, `jobs.schedule`, `plugin.state.read`, `plugin.state.write`, `api.routes.register`. The plugin only reads; it never decides, comments or changes anything.

## Limits

- Private cards the plugin cannot read are not scanned.
- The scan reads interactions for every card that is not done or cancelled (including `backlog`) each minute. That is fine for hundreds of such cards; it is temporary until #4990 lets the plugin subscribe instead.
- Card lists are read without `limit`/`offset`: in Paperclip 2026.1023.0 the host applies `offset` twice for plugin issue lists, so paging past the first page returns nothing.
- Delivery is at-least-once. Consumers should dedupe on `kind` + `id` + `createdAt`, as the wait client does; `createdAt` changes when an owner card starts a new pending cycle.

## Development

```sh
npm ci
npm run check   # typecheck, tests, build
```

## License

MIT
