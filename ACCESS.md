# Access and permissions

Who may talk to your bot is stored in one private file, `policy.json`, in the
profile directory (`~/.codex/codex-telegram` by default). The running session
re-reads it for every message, so a change takes effect immediately.

Access is changed only from your machine:

- in the Codex composer: `$telegram-channel:access <command>`
- in a terminal: `codex telegram <command>`

Nothing sent through Telegram can change it. `/start`, `/help` and `/status` in
the bot's chat only report, and a message that merely looks like an access
command is treated as ordinary text.

## Commands

| Command                                                          | Effect                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `status`                                                         | Show the policy, allowed users and pending pairing requests |
| `pair CODE`                                                      | Allow the sender who received this code                     |
| `deny CODE`                                                      | Discard a pending code                                      |
| `policy pairing` \| `allowlist` \| `disabled`                    | How direct messages from unknown people are handled         |
| `allow USER_ID`                                                  | Allow a user by numeric ID                                  |
| `remove USER_ID`                                                 | Remove a user from chat access, group rules and approvals   |
| `group add CHAT_ID --allow-from ID,ID [--require-mention false]` | Add a rule for one group                                    |
| `group set CHAT_ID --allow-from ID,ID [--require-mention false]` | Replace that rule                                           |
| `group rm CHAT_ID`                                               | Remove that rule                                            |
| `set FIELD VALUE`                                                | Change a setting listed below                               |
| `operator list` \| `add USER_ID` \| `remove USER_ID`             | Who may approve tool requests from Telegram                 |

IDs are numeric Telegram IDs; group IDs are negative. Pairing finds a user's ID
for you, and `/status` in the bot's chat shows it.

## Direct messages

| `policy`            | Unknown sender                                                        |
| ------------------- | --------------------------------------------------------------------- |
| `pairing` (default) | Receives a six-character code; their message is not forwarded         |
| `allowlist`         | Ignored silently                                                      |
| `disabled`          | Ignored silently, and allowed users cannot use direct messages either |

A code is valid for one hour and at most three requests wait at a time. A code
is bound to the account that asked for it, so it is useless to anyone else. Pair
by typing the code yourself; never let Codex choose one from the pending list.
Switch to `allowlist` once everyone you want has paired.

## Groups

Add the bot to a group as usual. A group message is addressed to the bot when it
replies to one of the bot's messages, starts with a command addressed to it
(`/ask@your_bot how is the build?`; any command name works), or contains an
`@your_bot` mention.

**Telegram's privacy mode decides what arrives at all.** It is on by default for
every bot, and with it on Telegram delivers only replies to the bot and commands
addressed to it: a plain `@mention` never reaches the bot. To use mentions, send
`/setprivacy` to [@BotFather](https://t.me/BotFather), choose _Disable_, then
remove the bot from the group and add it again; making the bot a group admin has
the same effect. The bot then receives every group message, and the rules below
still decide which ones are heard.

Two things decide whether an addressed message is heard:

**Any group (default on).** With `set allowAllGroups true`, a user who is already
allowed can reach the bot from any group it has joined by addressing it as
described above. Other members are ignored. Turn it off with
`set allowAllGroups false`.

**Explicit rules.** `group add -1001234567890 --allow-from 111,222` limits that
group to the listed senders and replaces the fallback for it. The message must
still be addressed to the bot unless you add `--require-mention false`, which is
useful only with privacy mode disabled. `--allow-from ""` is a valid rule that
admits nobody.

For groups with an explicit rule you can add your own triggers besides a
mention, as case-insensitive regular expressions:

```sh
codex telegram set mentionPatterns '["^hey bot\\b"]'
```

They never bypass the sender check, and like mentions they need privacy mode
disabled to arrive. Anonymous group admins and channel posts are never admitted.

## Settings

| Field                 | Values                                                                  | Default                     |
| --------------------- | ----------------------------------------------------------------------- | --------------------------- |
| `ackReaction`         | an emoji from Telegram's reaction list, or `""` for none                | `👀`                        |
| `typing`              | `true` \| `false` — show "typing…" when a message is accepted           | `true`                      |
| `replyToMode`         | `first` \| `all` \| `off` — which parts of an answer quote the question | `first`                     |
| `textChunkLimit`      | `1`–`4096` characters per message                                       | `4096`                      |
| `chunkMode`           | `newline` \| `length` — where long answers are split                    | `newline`                   |
| `deliveryMode`        | `queue` \| `steer` \| `auto`                                            | `queue`                     |
| `allowAllGroups`      | `true` \| `false`                                                       | `true`                      |
| `mentionPatterns`     | JSON array of up to 16 regular expressions                              | `[]`                        |
| `permissions.enabled` | `true` \| `false` — approval cards in Telegram                          | off until the first pairing |

`deliveryMode` matters only while Codex is busy; an idle conversation always
starts a new turn. `queue` adds the message to Codex's queue, `steer` injects it
into the running turn, and `auto` steers unless messages are already queued. If
the running turn cannot be steered, the message is queued instead. When Codex
does not confirm that it accepted a message, the plugin stops receiving rather
than risk delivering it twice; restart the session to continue.

## Replies without a confirmation each time

Codex asks before running a plugin's tool. To let the bot answer without a
prompt for every reply, add this to `~/.codex/config.toml` and restart the
session:

```toml
[plugins."telegram-channel@codex-telegram".mcp_servers.telegram.tools.reply]
approval_mode = "approve"
```

This covers text **and** files sent through `reply`, and nothing else. Do not set
`default_tools_approval_mode` for this server: that would also pre-approve
`download_attachment`.

## Approving tools from Telegram

When Codex needs an approval (a command, a file change, extra permissions or one
of this plugin's tools), the operator receives a card in their private chat with
**Allow once**, sometimes **Allow session**, and **Deny**. The prompt in the
terminal keeps working; whichever is answered first wins and the other is
retired. Cards expire after ten minutes, and at the end of the session, as
denied.

On a fresh profile the first private chat you pair becomes the only operator.
Later pairings can chat but cannot approve. To manage operators yourself:

```sh
codex telegram operator add 111
codex telegram set permissions.enabled true
codex telegram operator remove 111
```

An operator must be an allowed user with a private chat. Removing an operator
leaves their chat access in place; `remove USER_ID` takes away both. The relay
never approves anything by itself and does not change Codex's sandbox or
approval policy. Requests it does not recognize, such as forms asking for input,
stay in the terminal.

## Files

| File            | Content                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| `policy.json`   | Everything on this page                                                   |
| `bot-token`     | The bot token (`0600`)                                                    |
| `launcher.json` | Paths of this profile and of the stock Codex binary                       |
| `state/`        | Poller health, the session lock, and `inbox/` with downloaded attachments |

Downloads go to a per-session folder under `state/inbox/`. It is removed when
the session ends cleanly and idle, and kept otherwise so that a queued turn can
still read its files.

A profile belongs to one bot and one Codex home. For a second bot, use a second
Codex home (`CODEX_HOME=/path/to/other codex …`); its command is
`/path/to/other/bin/codex`, and your everyday `codex` is left as it is.
