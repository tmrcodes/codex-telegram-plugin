# Contributing

Keep the public repository free of bot tokens, private account identifiers,
machine-specific paths, runtime state, session data, and production fixtures.
Use synthetic IDs and dedicated test bots.

Before opening a pull request, run:

```sh
python3 scripts/verify-public-source.py
python3 scripts/verify-public-source.test.py
(
  cd plugins/telegram-channel
  bun install --frozen-lockfile
  bun audit
  bun run typecheck
  CODEX_TELEGRAM_BUN_TEST_TIMEOUT_SECONDS=30 bun run test
)
```

Never run a second poller for a bot used by another profile. Runtime acceptance
must use an isolated Codex home and a dedicated bot. Unit tests and a successful
MCP connection do not replace a real Telegram inbound → model → origin-bound
reply check followed by a clean health check.

Changes to admission, ownership, access policy, signed handles, attachments,
or process shutdown need focused tests for both their success and fail-closed
paths. Do not add a message database, receipt journal, retry scheduler, or
history/search surface without an explicit architecture decision.
