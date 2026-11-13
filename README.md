# zcode-discord-bot

Drive [ZCode](https://zcode.ai) from your phone through Discord — the same way the
built-in Telegram/Feishu/Weixin bots work. ZCode ships the Discord tile as
"Coming soon", but the entire provider plumbing already exists inside the app:
`discord` is a first-class value in the bot schema, and the shared message
pipeline (binding, slash commands, permission prompts, sessions) is
provider-agnostic. Only the adapter + gateway runtime were missing — this repo
supplies them and flips the UI flag.

> Tested against the ZCode desktop build of Nov 2026, Windows. The patcher
> verifies every anchor before writing and restores cleanly (`--restore`).

## How it works

| File | Role |
|---|---|
| `patch-zcode-asar.mjs` | Edits 3 files inside ZCode's `app.asar`: injects a one-line bootstrap into the host's bot service (dynamic `import` of `adapter.mjs` **inside the host process**), adds `discord` to the binding-capable provider list, enables the Discord tile, updates two "not available yet" texts. Backs up the original, syntax-checks patched bundles, and round-trip-verifies the repacked archive. Anchors are hash-agnostic string matches; `--check` reports status, `--restore` undoes everything. |
| `adapter.mjs` | Runs inside the ZCode host process. Maintains the Discord Gateway WebSocket (identify/heartbeat/resume, single-writer lock across windows), translates DMs / slash commands / buttons / select menus into ZCode's standard provider-callback format, and delivers replies, typing indicators and selection components over the Discord REST API. No public URL or open port needed. |
| `register.mjs` | Validates your bot token against Discord, appends the bot to `~/.zcode/v2/bot-config.v3.json` (schema-exact), stores the token in `tokens.json` next to the module. `--set-token` / `--unregister` included. |
| `apply-discord-patch.bat` | Windows helper: refuses to run while ZCode is open, then applies the patch. |

Discord-specific behavior the adapter compensates for (all discovered by
reverse-engineering the host bundle, documented in code comments):

- Reply recipients come as `chatId ?? providerUserId` — a Telegram assumption.
  For Discord DMs `chatId` is the *channel* id, so it maps back to the recipient
  user id via the DM cache before sending.
- Selection callbacks reuse the host's Telegram `zc:*` custom-id scheme, so
  buttons and dropdowns decode into the exact slash commands the host parser
  accepts.
- Discord requires an interaction ACK within 3 seconds while the host pipeline
  may take longer, so interactions are deferred immediately on arrival and the
  "is thinking" state is cleared when the answer is ready.

## Requirements

- ZCode desktop app (has been launched at least once), currently closed when patching
- Node.js **22+** on `PATH` (uses global `WebSocket`, stable in Node 22)
- Windows (`apply-discord-patch.bat`; on other OS run `node patch-zcode-asar.mjs`
  with `ZCODE_RESOURCES` pointing at ZCode's `resources` folder)

## Setup

1. **Create a Discord bot** at <https://discord.com/developers/applications>:
   New Application → *Bot* tab → Reset Token (copy it). No privileged intents
   are needed for DMs.
2. **Invite it to a server you own** — required, since Discord only allows DMs
   between a bot and users who share a server:
   `https://discord.com/oauth2/authorize?client_id=<BOT_USER_ID>&scope=bot&permissions=117760`
   (`<BOT_USER_ID>` = the bot's User ID on the Bot tab; permissions = view
   channels, send/embed/attach/read-history).
3. **Apply the patch with ZCode fully closed** (system tray too):
   double-click `apply-discord-patch.bat`.
4. **Register the bot**:
   ```bat
   node register.mjs --token "YOUR_BOT_TOKEN" --name "My ZCode" --workspace "C:\path\to\project"
   ```
   Repeat `--workspace` to allow more, or manage them later in ZCode → Bots.
5. **Start ZCode.** The bot connects within seconds and sends you a welcome DM
   (once — it finds you via the application owner). Then copy the bind command
   from **ZCode → Bots → the bot card** and paste it in the DM:
   ```
   /bind XXXXXXXX
   ```

## Using it

Slash commands are registered with Discord automatically (`/bind <code>`,
`/help`, `/status`, `/new`, `/project`, `/model`, `/mode`, `/think`, `/reply`,
`/stop`, `/cancel`) — type `/` and the picker autocompletes them. Plain text is
sent straight to your bound ZCode session. Prompts adapt to the payload:
approve/deny style renders as **buttons**, any list (models, workspaces, …) as a
native **dropdown** with descriptions. `/bind` rebinds the chat to whatever
workspace is currently selected in the ZCode window; `/help` lists everything.

## Notes & limits

- **DMs only** (ZCode group topics are built around Feishu/Lark topics).
- Attachments from Discord are not forwarded yet; text, commands and components work.
- **ZCode updates overwrite `app.asar`** → re-run `apply-discord-patch.bat`
  afterwards. Bot registration and tokens are untouched. If an anchor ever
  breaks after an update, `node patch-zcode-asar.mjs --check` tells you which.
- The module loads from **the folder you run the patch from** — moving or
  re-cloning this folder is fine: just re-run the patch and it relocates.
  Override the module path with `ZCODE_DISCORD_MODULE=file:///...` if desired.
- Multiple ZCode windows: one gateway wins (`gateway.lock`), others show
  "held by another ZCode process".
- **Security:** the bot token lives in `tokens.json` next to this repo (plain
  JSON — unlike ZCode's OS-encrypted vault), so `tokens.json`,
  `dm-channels.json` and `commands.json` are gitignored. Anyone with the token
  controls the bot; anyone who can DM the bot and knows a bind code can bind a
  chat. Keep the folder local and rotate the token if it leaks.
- Troubleshooting: the bot card shows runtime status + delivery errors; host log
  lines are tagged `[zcode-discord]` in `%USERPROFILE%\.zcode\v2\logs\<date>.log`.
  "No Discord token" → run `register.mjs`; bot never messages you → it must
  share a server with you (step 2).
- Undo: `node patch-zcode-asar.mjs --restore` (ZCode closed) and
  `node register.mjs --unregister <bot-id>`.

## License

MIT
