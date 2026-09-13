# Telegram for Codex

Talk to one stock Codex session through a Telegram bot. Incoming text and
photos enter the visible Codex conversation; the assistant can reply, react,
edit its own messages, and download the attachment that arrived with the
current message.

This is an independent project, not an OpenAI or Anthropic official plugin.
Its setup follows the same understandable BotFather → install → configure →
relaunch → verify shape as Anthropic's
[Telegram plugin](https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/telegram/README.md),
but the commands and runtime are native to stock Codex and its
[App Server](https://learn.chatgpt.com/docs/app-server).

## What it guarantees

- One terminal launch owns one stock App Server and one Telegram `getUpdates`
  poller. Another plugin launch under the same OS user using the same bot or
  state directory is rejected; it never evicts the current owner. Do not run
  the same bot token on another OS account or machine at the same time.
- Replies and attachment access use short-lived signed handles bound to the
  admitted Telegram chat, topic, message, sender policy, and Codex root. The
  model cannot choose arbitrary Telegram IDs or local files.
- `/new`, resume, and fork are fenced before the stock root operation. A
  successful change keeps the same poller and provider offset. If Codex rejects
  the change, only the foreground TUI is restored on the exact previous root;
  the host, poller, and admitted work stay alive.
- Shutdown drains already-started channel work before releasing ownership.
- There is no tmux integration or requirement. tmux, Terminal.app, iTerm, SSH,
  and other terminals are merely places from which the same launcher can run.
- There is no message database, receipt journal, retry scheduler, history, or
  search. Telegram holds pending Bot API updates until the active poller receives
  them. The local SQLite ownership files are lock-only and contain no tables,
  rows, tokens, messages, offsets, sessions, or routes.

## Requirements

- Stock Codex with plugins, Unix-socket App Server, remote TUI, native queue
  admission, and host-supplied MCP thread metadata. The accepted development
  baseline is Codex `0.153.4`.
- Bun `1.3.11` and Python 3. Current runtime acceptance is on macOS. Linux and
  Windows have CI/source coverage only where stated; do not assume runtime
  acceptance there yet.
- An authenticated Codex installation, a Telegram bot token, and your numeric
  Telegram user ID.

The plugin does not provide model access or change the chosen model, reasoning
effort, sandbox, or approval policy.

## Tools

The plugin exposes five narrowly scoped MCP tools:

- `connect` binds the current host-owned Codex thread to the retained Telegram
  poll owner. The launcher calls it automatically at startup and after a safe
  root transition.
- `reply` sends text or files only through the signed `reply_handle` supplied
  with an admitted Telegram message.
- `react` adds a reaction only through a signed inbound target or signed
  outbound message handle.
- `edit_message` edits only a signed message previously sent by `reply`.
- `download_attachment` downloads only the attachment identified by the signed
  handle supplied with the current admitted message.

The model cannot provide raw chat, topic, message, user, or filesystem routes
to these tools. Access-policy changes are terminal-only commands, not MCP
tools.

## Quick setup

### 1. Create a bot

Open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow its
prompts. Put the resulting token in a private local file; do not paste it into
Codex, a shell argument, an issue, or this repository.

For example on macOS or Linux:

```sh
install -d -m 700 "$HOME/.config/codex-telegram"
umask 077
${EDITOR:-vi} "$HOME/.config/codex-telegram/bot-token"
```

### 2. Install the marketplace and plugin

```sh
codex plugin marketplace add tmrcodes/codex-telegram-plugin --ref main
codex plugin add telegram-channel@codex-telegram
codex plugin list --marketplace codex-telegram --json
```

These are stock Codex CLI commands, not Claude Code `/plugin` commands.

### 3. Create private launcher settings

Start Codex in a local terminal and ask:

> Configure Codex Telegram Channel using token file
> `/absolute/path/to/bot-token` and allow my numeric Telegram user ID
> `YOUR_USER_ID`.

The installed `telegram-channel-operations` skill runs the bundled setup script
without putting the token on the command line. You can also run it directly
from the installed plugin directory:

```sh
bun dist/scripts/telegram-setup.js \
  --codex-binary /absolute/path/to/stock/codex \
  --token-file /absolute/path/to/private/bot-token \
  --allow-from YOUR_NUMERIC_TELEGRAM_USER_ID \
  --codex-home /absolute/path/to/the/installed/codex/home
```

Setup creates owner-only token, policy, state, and launcher files and refuses to
overwrite an existing settings directory. Runtime entrypoints are pre-bundled
from the checked-in frozen dependency lock, so first launch performs no package
installation. By default, setup permits only that user's DMs; groups and
`allowAllGroups` remain off.

### Update an existing installation

Use the stock Codex binary with the same Codex home selected during setup.
After updating the marketplace and plugin, refresh the copied launcher:

```sh
CODEX_HOME=/absolute/path/to/original/codex/home /absolute/path/to/stock/codex plugin marketplace upgrade codex-telegram
CODEX_HOME=/absolute/path/to/original/codex/home /absolute/path/to/stock/codex plugin add telegram-channel@codex-telegram
bun /absolute/path/to/installed/plugin/dist/scripts/telegram-setup.js \
  --refresh-launcher \
  --directory /absolute/path/to/private/codex-telegram \
  --codex-home /absolute/path/to/original/codex/home
```

The refresh validates private settings and the installed plugin before writing.
It preserves the selected Codex home, token, access policy, and state. Source
the printed activation file in your next terminal session to use the updated
launcher. Follow a release's tested migration instructions before changing an
existing installation; a lower version number is not an automatic upgrade.

### 4. Launch from any terminal

Source the exact activation path printed by setup, then run Codex normally in
the workspace that Telegram should control:

```sh
source "$HOME/.codex/codex-telegram/activate.sh"
cd /path/to/your/workspace
codex
```

The activation defines an opt-in shell function; it does not replace the stock
Codex binary. Add the `source` line to your shell startup file if you want the
function in future terminals. Administrative commands such as `codex plugin`
continue to pass through to stock Codex.

### 5. Verify the real path

With that terminal session running, send a fresh DM to the bot. Confirm all of
the following before relying on it:

1. The inbound message appears in the visible Codex conversation.
2. The model processes it and its answer replies to the same Telegram message.
3. A newly sent photo is visible to the model.
4. `/new` changes the foreground Codex conversation without creating a second
   poller; a rejected busy change restores the previous conversation.
5. Health remains clean after the turn.

A connection receipt, typing indicator, unit test, or configuration readback is
not end-to-end acceptance.

## Groups and access control

Access changes are local-terminal actions. A Telegram message cannot grant a
user, group, file, or policy permission.

The terminal access command supports `status`, `allow`, `remove`, pairing-code
maintenance, explicit group rules, and policy settings. See the installed
`telegram-channel-operations` skill for examples.

`allowAllGroups` is off by default. When enabled, it still admits only a sender
already present in global `allowFrom`, and only when that sender genuinely
mentions the bot or replies to it. It does not add the bot to a group, bypass
Telegram privacy mode, admit channels/anonymous senders, or broaden the sender
allowlist. An explicit group rule takes precedence.

## Data and lifecycle boundaries

Telegram's Bot API exposes no message history or search to this plugin. Photos
attached to current admitted messages are downloaded eagerly into a private,
bounded inbox; other media carries bounded metadata and a signed attachment
handle. Telegram compresses photos, so send an image as a document when the
original file is required.

The in-memory provider offset advances only after stock Codex admission is
confirmed. On transient failure the same Telegram update is retried; uncertain
admission stops the poller rather than risking an invisible second submission.
Previously issued old-root handles remain usable after `/new` only until their
existing one-hour expiry; no root registry is retained. New ingress always
targets only the current root.

Ownership locks live in the real OS user's `~/.codex-telegram-channel/ownership`,
independently of `CODEX_HOME`, so separate Codex homes cannot claim the same
bot. These private directories use mode `0700` and lock files use `0600`.
Process exit releases the locks; the empty lock files remain for reuse. Do not
delete or replace them while any instance is running.

Runtime settings, downloaded files, health state, ownership locks, Codex homes,
and conversations are local data and must remain outside this checkout. See
[SECURITY.md](SECURITY.md) for the disclosure and trust-boundary policy.

## Development

```sh
python3 scripts/verify-public-source.py
python3 scripts/verify-public-source.test.py
(
  cd plugins/telegram-channel
  bun install --frozen-lockfile
  bun audit
  bun run build:runtime
  bun run verify:runtime
  bun run verify:runtime:test
  bun run typecheck
  CODEX_TELEGRAM_BUN_TEST_TIMEOUT_SECONDS=30 bun run test
)
```

CI rebuilds the committed runtime bundles in an empty directory and rejects any
path-set or byte drift, including stale extra artifacts.

The test wrapper enforces an external process-group deadline so a leaked Bun
handle cannot leave CI running forever. The source scanner is a narrow
guardrail, not proof that a publish set contains no private data; review the
complete tree before release.

## License

[MIT](LICENSE). Bundled dependency licenses are retained in
[THIRD_PARTY_NOTICES.md](plugins/telegram-channel/THIRD_PARTY_NOTICES.md).
