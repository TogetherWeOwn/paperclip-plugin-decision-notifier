# paperclip-plugin-decision-notifier

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that pushes pending **board decisions** to whoever is listening on a board-authenticated plugin stream. It exists so an operator session can wait for decisions instead of polling.

A decision is one of:

| kind | pending when | source |
|---|---|---|
| `approval` | approval status is `pending` | `approval.created` / `approval.decided` events, plus the scan job |
| `interaction` | a thread interaction (decision card) is `pending` and not addressed to an agent | the scan job, and `issue.created` / `issue.updated` events for that card |
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

Both need a board credential (a board API key or browser session). The stream is Server-Sent Events. Ignore frames with an `event:` line (`open`, `close`); decisions are the plain `data:` frames.

Paperclip does not tell a plugin when a client connects, so catch-up is an explicit call: open the stream, wait for the server's `:ok` comment, then `POST /catch-up`. The plugin rescans, replays every pending decision onto the stream, and also returns them as `{"pending":[…]}`. Subscribing first means nothing falls between the replay and live events.

### `paperclip-decision-wait`

`bin/decision-wait.mjs` does the above and exits on the first decision it has not seen before, printing it as one JSON line. It is meant to run as a background command that wakes a session when it exits:

```sh
PAPERCLIP_API_URL=https://paperclip.example.com \
PAPERCLIP_BOARD_TOKEN_FILE=$HOME/.paperclip/board-token \
paperclip-decision-wait --company <companyId> --seen $HOME/.cache/paperclip-decisions-seen
```

- The token is read from a file, never from argv.
- `--seen` lists announced decisions. Replayed decisions already in it do not wake the caller; entries that are no longer pending are pruned on connect.
- Exit 0 means a decision was printed. Exit 1 means the connection or auth failed; the reason is on stderr.

## Configuration

| key | default | meaning |
|---|---|---|
| `publicBaseUrl` | `""` | Web app base URL for event links. Links are relative paths when empty. |
| `ownerUserIds` | `[]` | User IDs whose assigned open cards count as decisions. Empty means any card assigned to a user. |

## Capabilities

`companies.read`, `issues.read`, `issue.interactions.read`, `approvals.read`, `events.subscribe`, `jobs.schedule`, `plugin.state.read`, `plugin.state.write`, `api.routes.register`. The plugin only reads; it never decides, comments or changes anything.

## Limits

- Private cards the plugin cannot read are not scanned.
- The scan reads interactions for every open card each minute. That is fine for hundreds of open cards; it is temporary until #4990 lets the plugin subscribe instead.
- Delivery is at-least-once. Consumers should dedupe on `kind` + `id` (the wait client does).

## Development

```sh
npm ci
npm run check   # typecheck, tests, build
```

## License

MIT
