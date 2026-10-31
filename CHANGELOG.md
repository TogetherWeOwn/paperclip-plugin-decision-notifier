# Changelog

## 0.1.1

- `paperclip-decision-wait` falls back to polling the catch-up route every 30 s when the stream answers HTTP 501 (stock Paperclip 2026.1023.0 does not wire the plugin stream bus). Stream mode is unchanged on hosts that do.

## 0.1.0

- First release. Approval, thread-interaction and owner-card decisions on the `decisions` plugin stream, IDs and URLs only.
- `POST /api/plugins/togetherweown.decision-notifier/api/catch-up` replays everything pending onto the stream.
- `paperclip-decision-wait` client that blocks until an unseen decision arrives.
