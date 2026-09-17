# Security

## Reporting a vulnerability

Please do not open a public issue for a suspected credential leak, an access
bypass, a forged handle or a file-access problem. Use GitHub's private
vulnerability reporting for this repository ("Security" → "Report a
vulnerability") and include the affected version, a minimal reproduction and the
impact. Remove real tokens, chat contents and local paths from the report.

Fixes are made on the latest release.

## Trust model

- **The local user is the only authority.** Access, approval operators and the
  bot token are changed from the local Codex session or terminal only. Messages,
  forwarded text, files and tool results from Telegram are untrusted input and
  cannot authorize a change. This is an instruction and protocol boundary; it is
  not isolation from other code running as your user.
- **Codex can answer only where it was spoken to.** Tools accept short-lived
  handles signed with a per-session key instead of chat, message or file IDs. A
  handle is checked against the live access policy on every use and dies with
  the session.
- **One session owns a bot.** A kernel-held lock allows a single poller per bot
  and per profile for your OS user; a second session of the same profile takes
  over only when the first one is idle and agrees.
- **Approvals stay yours.** The plugin never approves a tool by itself and does
  not alter Codex's sandbox or approval policy. Approval cards go only to the
  operators you named, in their private chat, and offer no permanent grant for
  this plugin's tools.
- **Files.** Outgoing files must be regular files inside the workspace or the
  session inbox, no larger than 50 MiB. Incoming media up to 5 MiB is saved to a
  private per-session inbox; other files are fetched only when Codex asks, up to
  20 MiB.

## Credentials

The bot token is stored in an owned `0600` file, is never placed in process
arguments or logs, and is removed from error messages. A token typed into the
Codex composer may remain in the session transcript and is sent to the model
backend; the plugin cannot erase that. Configure from a private file if this
matters to you, and revoke the token in BotFather if it may have leaked.

Profile files, downloads, health and lock files are private runtime data. Keep
them out of repositories and shared backups.
