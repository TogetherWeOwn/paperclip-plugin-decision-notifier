# Changelog

## 0.1.2

- `paperclip-decision-wait` reads the stream with `node:http` instead of `fetch`, so an idle stream no longer dies after 300 s. Only the wait for response headers and for the first frame keeps the `PAPERCLIP_DECISION_WAIT_TIMEOUT_MS` deadline; TCP keepalive catches a dead peer. The stream request no longer follows redirects.
- Stream read errors and bad URLs exit 1 with one `decision-wait: stream failed: …` line instead of a stack trace.
- Catch-up calls for a company within 10 s of its last catch-up scan, with unchanged config and issue prefix, replay the stored pending set instead of rescanning.

## 0.1.1

- `paperclip-decision-wait` falls back to polling the catch-up route every 30 s when the stream answers HTTP 501 (stock Paperclip 2026.1023.0 does not wire the plugin stream bus). Stream mode is unchanged on hosts that do.

## 0.1.0

- First release. Approval, thread-interaction and owner-card decisions on the `decisions` plugin stream, IDs and URLs only.
- `POST /api/plugins/togetherweown.decision-notifier/api/catch-up` replays everything pending onto the stream.
- `paperclip-decision-wait` client that blocks until an unseen decision arrives.
