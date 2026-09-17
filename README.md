# Telegram for Codex

Talk to your Codex terminal session through your own Telegram bot. Messages and
files you send to the bot arrive in the conversation you have open; Codex
answers in the same chat and can send files, react and edit its replies.

The plugin is a small MCP server plus a launcher around the **stock** Codex
binary. It does not patch Codex, runs no background daemon and has no
dependencies besides [Bun](https://bun.sh).

This is an independent project, not an official OpenAI plugin.

## Requirements

- Codex CLI with plugin support, signed in. Tested with `0.154.0` on macOS.
- [Bun](https://bun.sh) `1.3` or newer on your `PATH`.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).

## Quick start

**1. Create a bot.** Send `/newbot` to [@BotFather](https://t.me/BotFather) and
keep the complete token it gives you (`123456789:AAH…`).

**2. Install the plugin.**

```sh
codex plugin marketplace add tmrcodes/codex-telegram-plugin
codex plugin add telegram-channel@codex-telegram
```

**3. Configure.** Start `codex` and enter this in its composer:

```text
$telegram-channel:configure 123456789:AAH…
```

The token is checked with Telegram and saved to a private file. A token typed
into the composer may stay in the session transcript and is sent to the model
backend; if you would rather avoid that, save it to a `0600` file and ask Codex
to configure the channel from that file.

**4. Relaunch.** Quit that session and run `codex` again. Configure installs a
`codex` command in your Codex home (`~/.codex/bin`, added to `PATH` in your
shell rc file), so open a new terminal if the old one still starts Codex
without Telegram. With a custom `CODEX_HOME` the command is `$CODEX_HOME/bin/codex`
and your `PATH` is left alone. Telegram works for as long as this session is open.

**5. Pair your own chat first.** Message your bot. It answers with a
six-character code; enter it in the Codex composer:

```text
$telegram-channel:access pair ABC234
```

Your access settings live outside the workspace, so Codex asks once whether the
access helper may write them; allow it and the pairing completes.

The first pairing also makes that account the only one allowed to approve tool
requests from Telegram. Send a new message to start chatting; the one that
produced the code was not forwarded.

**6. Lock it down.** When everyone you want is paired:

```text
$telegram-channel:access policy allowlist
```

Strangers are then ignored instead of receiving pairing codes. Groups, several
users, delivery settings and approvals are covered in [ACCESS.md](ACCESS.md).

## Using it

- **Text, photos and files.** Photos, voice, audio, video and image documents up
  to 5 MiB are downloaded before the message reaches Codex, and images are shown
  to the model directly. Any other document (text, PDF, archive) is fetched only
  when Codex asks for it, which needs your approval, up to the Bot API limit of
  20 MiB. Send an image as a file to avoid Telegram's compression.
- **Groups.** A paired user can talk to the bot in any group it has joined by
  replying to one of its messages or starting a message with a command
  addressed to it, such as `/ask@your_bot how is the build?`. Plain `@mentions`
  work once the bot's privacy mode is disabled in BotFather; see
  [ACCESS.md](ACCESS.md#groups). Everyone else is ignored.
- **`/new` and `/resume` in Codex** move the bot to the conversation you switch
  to, once the current turn has finished.
- **`/status` and `/help` in the bot's chat** answer without involving the model.
- **A second `codex`** for the same bot takes the channel over from the first
  one when that one is idle; otherwise it says so and leaves the first one alone.
  There is never more than one poller per bot.

Tools available to Codex:

| Tool                  | Purpose                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `reply`               | Answer a received message with text and up to eight files. Long text is split. |
| `react`               | Add an emoji reaction.                                                         |
| `edit_message`        | Edit a message the bot sent earlier.                                           |
| `download_attachment` | Fetch a document that was not downloaded automatically.                        |

The tools take short-lived signed handles that come with each admitted message,
never raw chat, message or file IDs, so Codex can only answer where it was
spoken to. A handle stops working as soon as its sender loses access.

The Bot API has no message history and no search: Codex sees only what arrives
while the session is running.

## Terminal commands

The installed `codex` command also manages access without opening a session:

```sh
codex telegram status
codex telegram pair ABC234
codex telegram policy allowlist
```

Every other `codex` subcommand (`codex exec`, `codex login`, `codex plugin …`)
is passed to the stock binary unchanged.

## Troubleshooting

- **The bot does not answer at all.** The session must be started with the
  `codex` command from step 4 and still be open. `$telegram-channel:configure`
  without arguments shows the last polling state.
- **No pairing code.** The policy is already `allowlist` or `disabled`; see
  `codex telegram status`.
- **Paired, but no answer.** Send a new message, then look at the Codex session:
  it may be waiting for an approval or showing a model error.
- **Every reply asks for approval.** Allow the `reply` tool once in your Codex
  config; see [ACCESS.md](ACCESS.md#replies-without-a-confirmation-each-time).
- **No answer in a group.** Only paired users are heard. With Telegram's privacy
  mode on (the default) the bot receives just replies to its own messages and
  commands addressed to it (`/ask@your_bot …`); a plain `@mention` never arrives.
  Disable privacy mode in BotFather and re-add the bot, or make it a group admin,
  to use mentions.
- **"Bot already in use".** Another computer or another profile is polling this
  bot. One bot can serve one session at a time.

## Updating and removing

```sh
codex plugin marketplace upgrade codex-telegram
codex plugin add telegram-channel@codex-telegram
```

Relaunch `codex` afterwards. Your token and access settings live outside the
plugin, in `~/.codex/codex-telegram`, and are kept.

To remove everything: `codex plugin remove telegram-channel@codex-telegram`,
then delete `~/.codex/bin/codex`, the `telegram-channel@codex-telegram` block in
your shell rc file, and `~/.codex/codex-telegram`.

## Security

Access is decided on your machine, from your terminal only; nothing sent through
Telegram can change it. See [SECURITY.md](SECURITY.md) for the trust model and
for reporting a vulnerability.

[MIT](LICENSE)
