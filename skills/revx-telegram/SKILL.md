---
name: revx-telegram
description: >
  Revolut X Telegram notification connector. Use when the user asks to "set up Telegram alerts",
  "add Telegram bot", "manage Telegram connection", "test Telegram notification",
  or runs revx connector telegram commands.
---

# Telegram Connector (`revx connector telegram`)

> Configure Telegram bot integrations for alert notifications from monitors and the grid bot.

Ensure `revx` is installed, up to date (`npm update -g cli-k9x2a`), and configured — see `revx-auth` skill.

---

## Add a Connection

```bash
revx connector telegram add --token <bot-token> --chat-id <chat-id>
revx connector telegram add --token <token> --chat-id <id> --label prod --test
```

| Flag | Description |
|---|---|
| `--token <token>` | Telegram Bot API token (required) |
| `--chat-id <id>` | Telegram chat ID (required) |
| `--label <name>` | Connection label (default: "default") |
| `--test` | Send test message after adding |

### Behavioral Instructions for Claude

When the user wants to set up Telegram notifications, they need two things: a **bot token** and a **chat ID**. If either is missing, walk them through the setup below. Share the relevant steps as a message the user can follow — do not attempt to perform these steps via tools, as they require the user's Telegram app.

### Setup Guide: Getting a Bot Token and Chat ID

Share the following instructions with the user when they need help setting up Telegram:

**Step 1 — Create a Telegram Bot (to get the bot token):**

1. Open Telegram (mobile or desktop)
2. Search for **@BotFather** and start a chat
3. Send `/newbot`
4. BotFather will ask for a **display name** (e.g., "My RevX Alerts") — type any name
5. BotFather will ask for a **username** ending in `bot` (e.g., `my_revx_alerts_bot`) — must be unique
6. BotFather replies with your bot token — it looks like `123456789:ABCdefGHI-jklMNOpqrSTUvwxYZ`
7. Copy the token and share it back here

**Step 2 — Get your Chat ID:**

1. Open Telegram and find your new bot (search for the username you just created)
2. Send any message to the bot (e.g., "hello")
3. Open this URL in a browser — replace `<YOUR_TOKEN>` with the token from Step 1:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
4. In the JSON response, find `"chat":{"id": <number>}` — that number is your chat ID
5. It's usually a positive number for personal chats (e.g., `123456789`) or a negative number for group chats (e.g., `-1001234567890`)
6. Copy the chat ID and share it back here

**Step 3 — Add the connection (Claude runs this):**

Once the user provides both values, run:
```bash
revx connector telegram add --token <bot-token> --chat-id <chat-id> --test
```

The `--test` flag sends a test message to verify the connection works. If the test succeeds, the setup is complete.

**Troubleshooting:**
- "chat not found" or empty `getUpdates` response — the user must send a message to the bot first, then retry the URL
- "Unauthorized" — the token is incorrect, ask the user to copy it again from BotFather
- For **group chats**: the bot must be added to the group as a member, then someone must send a message in the group before `getUpdates` shows the group chat ID

---

## Manage Connections

```bash
revx connector telegram list                       # List all connections
revx connector telegram test <connection-id>       # Send test message
revx connector telegram test <id> --message "Custom test"
revx connector telegram enable <connection-id>     # Enable connection
revx connector telegram disable <connection-id>    # Disable connection
revx connector telegram delete <connection-id>     # Delete connection
```

---

## How Notifications Work

Once a Telegram connection is configured and enabled:
- **Monitor alerts** (see `revx-monitor` skill) are automatically sent as Telegram messages when triggered
- **Grid bot events** (see `revx-strategy` skill) send notifications on startup, shutdown, fills, and P&L changes

No additional configuration is needed — active monitors and the grid bot detect enabled Telegram connections automatically.

---

## Related Skills

| Skill | Purpose |
|---|---|
| `revx-monitor` | Set up price/indicator alerts that notify via Telegram |
| `revx-strategy` | Grid bot sends trade notifications via Telegram |
| `revx-auth` | API key setup and configuration |
