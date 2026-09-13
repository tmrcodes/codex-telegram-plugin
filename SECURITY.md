# Security policy

## Supported version

Security fixes are made on the latest release and the default branch. This
project has not declared long-term support branches.

## Reporting a vulnerability

Do not open a public issue for a suspected credential leak, access-control
bypass, forged route handle, poll-owner conflict, or arbitrary file access.
Use GitHub's private vulnerability reporting for this repository. Include the
affected release or revision, a minimal reproduction, and the impact. Remove
real Telegram tokens, user data, message contents, local paths, and Codex
credentials from the report.

If private vulnerability reporting is unavailable, contact the repository
owner privately before sharing technical details.

## Credential handling

The plugin reads a Telegram bot token from a private local file. It must never
be committed, pasted into a prompt, supplied as a shell argument, or attached
to an issue. Rotate the token with BotFather if it may have been exposed.

Runtime settings, downloaded attachments, health files, process locks, Codex
homes, and conversation data are not source artifacts. Keep them outside the
checkout and out of backups intended for publication.

## Trust boundary

The local operator configures permitted Telegram users, chats, and group
triggers. Telegram messages cannot broaden that policy. Replies and attachment
downloads require short-lived signed handles created for an admitted origin;
the tools do not accept arbitrary Telegram chat, topic, message, or file IDs.

The launcher uses the installed stock Codex binary and its App Server. The
plugin does not provide model credentials and does not select the model,
sandbox, or approval policy.
