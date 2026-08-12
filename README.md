# Palworld Discord Admin Bot — Operations Guide

## At a glance

| What | Value |
|---|---|
| VM | `<vm-ip>`, SSH user `$USER` |
| Bot code + config | `/home/$USER/palworld-bot/` |
| Bot secrets | `/home/$USER/palworld-bot/.env` |
| Bot config (3 files) | `/home/$USER/palworld-bot/config/guilds.json`, `roles.json`, `servers.json` |
| Palworld server install | `/home/$USER/palworld/` |
| Palworld server settings | `/home/$USER/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini` |
| Process manager | PM2, running as user `$USER` (no systemd, no sudo for daily use) |
| PM2 app names | `palworld` (game server), `palworld-bot` (this bot) |
| Currently-active guild | `<guild-id>` ("your-guild-name") — the only guild with a real server wired up |
| Game port | `8211` (UDP) |
| REST API port | `8212` (localhost only — never expose to the internet) |

Everything below assumes you're SSH'd in as `$USER@<vm-ip>`.

---

## First-time setup: turning on a new guild

The bot auto-joins every guild it's invited to and creates empty entries for it, but a brand new guild can't do anything until you fill those in. Concretely:

1. **Find the guild ID.** In Discord, enable Developer Mode (User Settings → Advanced), then right-click the server icon → Copy Server ID.

2. **Confirm the bot already registered it:**
   ```bash
   cat /home/$USER/palworld-bot/config/guilds.json
   ```
   If your guild ID isn't listed, the bot hasn't seen it yet — invite it first (invite link uses client ID `<bot-client-id>`), it registers itself within seconds of joining.

3. **Grant yourself admin access.** Edit `/home/$USER/palworld-bot/config/roles.json`, find the object with your `guildId`, and add your Discord user ID (right-click your name → Copy User ID) or a role ID to `admin.userIds` / `admin.roleIds`:
   ```bash
   nano /home/$USER/palworld-bot/config/roles.json
   ```
   Example for guild `<guild-id>`:
   ```json
   {
     "guildId": "<guild-id>",
     "admin": { "roleIds": ["<admin-role-id>"], "userIds": [] },
     "operator": { "roleIds": ["<operator-role-id>"], "userIds": ["<operator-user-id>"] },
     "common": { "roleIds": ["<common-role-id>"], "userIds": [] }
   }
   ```
   Saves apply automatically within ~1 second — no restart needed.

4. **Point it at a Palworld server.** Edit `/home/$USER/palworld-bot/config/servers.json` for the same `guildId` and add one entry to that guild's `servers` array, giving it a short `label`. Use `settingsFilePath` (not `restApiUrl`/`restApiPassword` directly) so the REST password is always read live from the ini instead of a copy that can go stale:
   ```json
   {
     "guildId": "<guild-id>",
     "servers": [
       { "label": "main", "settingsFilePath": "/home/$USER/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini", "pm2ProcessName": "palworld" }
     ]
   }
   ```
   A guild can list more than one server here (see "Adding a second Palworld server" below) — when there's only one, commands don't need to say which one; with more than one, every command's `server` option (autocompleted with the labels you set) picks which server it acts on.

5. **(Optional) Set up a log channel.** Edit that same guild's entry in `/home/$USER/palworld-bot/config/servers.json` and set `logChannelId` to a real Discord channel ID (right-click a channel → Copy Channel ID) — one shared channel gets everything: bot errors/permission denials and the live feed of admin actions. Leave it `null` to skip it.

6. **Verify:**
   ```bash
   cd /home/$USER/palworld-bot
   node --env-file=.env scripts/check-rest-api.js <guildId>
   ```
   Should print the server's name/version. Then try `/status` in Discord as the user/role you just granted admin.

---

## Adding a second Palworld server

Works the same whether the second server belongs to the *same* guild (e.g. a "main" and a "pvp" server for one community) or a *different* guild — either way, `config/servers.json` supports it, but the server itself has to actually exist first:

1. Install a second Palworld dedicated server via SteamCMD in its own directory (e.g. `/home/$USER/palworld2/`) — same process as the first install, app ID `2394010`.
2. In its `PalWorldSettings.ini`, set `RESTAPIEnabled=True` and give it **different** ports than the first instance — e.g. `PublicPort=8221`, `RESTAPIPort=8222` (the first instance already uses `8211`/`8212`; reusing them will conflict).
3. Add a new app entry to `/home/$USER/palworld-bot/deploy/ecosystem.config.js` with a unique `name` (e.g. `palworld2`) pointing at that install's `PalServer.sh`, then `pm2 start deploy/ecosystem.config.js --only palworld2` (first-time bootstrap of that one app only) and `pm2 save`.
4. In `config/servers.json`, add a new object to that guild's `servers` array with a distinct `label` (e.g. `"pvp"`), `restApiUrl` = `http://localhost:8222`, `pm2ProcessName` = `palworld2`, `restApiPassword` = whatever you set in step 2.
5. Once a guild has more than one server, every command's `server` option is required in practice — Discord will autocomplete the labels you've set, but if a command is run with no `server` and it's ambiguous, the bot replies listing the available labels instead of guessing.

---

## Daily operations (PM2)

```bash
pm2 list                       # status of all processes
pm2 logs palworld               # tail the game server's stdout/stderr
pm2 logs palworld-bot           # tail the bot's stdout/stderr
pm2 restart palworld            # restart the game server
pm2 restart palworld-bot        # restart the bot (needed after editing .env or code — NOT after editing config/*.json, those hot-reload)
pm2 stop palworld|palworld-bot
pm2 start palworld|palworld-bot
pm2 monit                       # live CPU/mem dashboard
pm2 save                        # persist current process list so a reboot restores it — run after any start/stop/restart
```

Boot persistence is already installed (`systemctl status pm2-$USER` — a systemd unit that runs `pm2 resurrect` on boot). You shouldn't need to touch it again.

**Restarting a single already-running app: use `pm2 restart <name>` by name.** Do **not** re-run `pm2 start deploy/ecosystem.config.js` (even with `--only`) against an app that's already running — this caused the *other* app in that same file to receive SIGINT and stop, even though it wasn't targeted. Only use `pm2 start deploy/ecosystem.config.js` to bootstrap an app for the very first time.

---

## Multi-tenancy: one bot, many guilds, separate servers

This bot can be invited to any Discord guild — including ones you don't control (people find/reuse the OAuth invite link; this has already happened twice). **Every guild is its own tenant.** A guild only gets a working Palworld connection if `/home/$USER/palworld-bot/config/servers.json` lists at least one complete server for that exact `guildId` (`label`, `restApiUrl`, `restApiPassword`, and `pm2ProcessName` all filled in). A guild with no servers listed, or only incomplete ones, gets a hard "no server configured" error on every command — **it cannot control any server**, no matter what roles it grants itself via `/operator`. That's the actual security boundary, not an allowlist bolted on afterward: capability is tied directly to configuration. A guild *can* be given several servers (see "Adding a second Palworld server"); it just can never reach one that isn't listed for it.

---

## Config file reference

All three files live in `/home/$USER/palworld-bot/config/`, are gitignored (VM-only, never in git), auto-create an empty entry for any guild the moment it joins, and **hot-reload within ~1 second of saving** — no bot restart needed after editing any of them.

- **`guilds.json`** — registry of known guilds: `[{ "guildId": "..." }]`. Informational, not something you edit.
- **`roles.json`** — who has access, per guild: `{ "guildId": "...", "admin": { "roleIds": [...], "userIds": [...] }, "operator": { "roleIds": [...], "userIds": [...] }, "common": { "roleIds": [...], "userIds": [...] } }`. Empty arrays = nobody has that tier. A role ID and a user ID work independently. `common` → `/status`, `/players`; `operator` → moderation (`/kick`/`/ban`/`/unban`/`/announce`/`/save`) plus `/start`/`/stop`/`/restart`; `admin` → `/worldsettings` and `/operator` (role management) only.
- **`servers.json`** — everything else, per guild: `{ "guildId": "...", "statusChannelId": "...", "logChannelId": "...", "servers": [{ "label": "...", "restApiUrl": "...", "restApiPassword": "...", "pm2ProcessName": "...", "saveFilePath": "...", "settingsFilePath": "..." }] }`.
  - `logChannelId` — one shared channel (bot errors/permission-denials plus a live feed of every successful admin action, player join/leave, world-save, and external `pm2` action alerts). `null` = that stream is off.
  - `statusChannelId` — a live-updating dashboard channel holding a status+players message pair per server the guild owns, with a running online-count in the channel name. Left `null`, the bot creates one itself and writes the resulting ID back here — you only ever need to *edit* this to point at a different existing channel.
  - `servers` — empty array = guild is inert (see Multi-tenancy above). One entry = commands don't need to specify it; more than one = commands need the `server` option to say which. `saveFilePath` is optional — absolute path to that server's `Level.sav` (see "World save detection" below). **`settingsFilePath`** is the recommended way to set up `restApiUrl`/`restApiPassword`: point it at that server's `PalWorldSettings.ini` and the bot reads `AdminPassword`/`RESTAPIPort` fresh from the ini on every single request instead of trusting a copy pasted into `servers.json` — the password can never drift out of sync again, because there's no longer a second copy to go stale. With `settingsFilePath` set, `restApiUrl`/`restApiPassword` are ignored entirely (leave them blank). Without it, the server falls back to whatever's stored directly in `restApiUrl`/`restApiPassword` — which you're then responsible for updating by hand if `AdminPassword` ever changes in-game.

**`/home/$USER/palworld-bot/.env`** is separate from all of that — just `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Not hot-reloaded; run `pm2 restart palworld-bot` after editing it.

---

## Commands the bot exposes

| Tier | Commands |
|---|---|
| operator | `/status` `/players` `/announce` `/kick` `/ban` `/unban` `/save` |
| admin | everything operator has, plus `/restart` `/start` `/stop` `/operator` |

`/operator add-role`, `add-user`, `remove-role`, `remove-user`, `list` let an admin grant/revoke **operator** access from Discord directly (edits `roles.json` for you). Promoting someone to *admin* is not exposed as a command on purpose — that still requires editing `config/roles.json` directly on the VM, a deliberate manual step.

`/ban`, `/restart`, `/stop` require a Confirm/Cancel button press before doing anything.

Every command except `/operator` takes an optional `server` option (autocompleted with that guild's configured labels) — only needed when a guild has more than one server; with exactly one, it's picked automatically.

`/kick` and `/ban`'s `userid` field autocompletes against that server's currently-connected players (type a name, pick from the list) instead of requiring you to paste a raw player ID. `/unban` stays free-text — Palworld's REST API has no endpoint to list banned players, only connected ones, so there's nothing to autocomplete against there.

---

## Palworld REST API

- Enabled per-server in that install's `PalWorldSettings.ini`: `RESTAPIEnabled=True`, `RESTAPIPort=<port>`
- Auth: HTTP Basic, username `admin`, password = `AdminPassword` in that server's `PalWorldSettings.ini` — read live via `settingsFilePath` (recommended, see Config file reference above) rather than a copy stored in `servers.json`
- Bound to localhost only — never open the REST port to the internet (check the Azure NSG has no inbound rule for it)
- Manual smoke test: `cd /home/$USER/palworld-bot && node --env-file=.env scripts/check-rest-api.js <guildId>`
- **`401 Unauthorized ... AdminPassword is empty`**: this is Palworld's own server refusing *all* REST auth because `AdminPassword=""` in the live ini — not a mismatched password, an *unset* one. No client-side fix is possible; `AdminPassword` must be set to a real value in `PalWorldSettings.ini` and **`palworld` restarted** (the ini only loads at startup) before REST calls will work again. Gameplay itself is unaffected in the meantime — only bot commands are down.
- **Gotcha (already handled in `/stop`'s code — documented so it isn't reintroduced):** the REST API's `shutdown`/`stop` endpoints make the PalServer *process itself* exit. Since the game server's PM2 entry has `autorestart: true`, PM2 can't tell that apart from a crash and brings it right back up within seconds. `/stop` waits out the shutdown, then explicitly runs `pm2 stop <name>` so PM2 knows it was intentional. If you ever call the REST shutdown endpoint directly (bypassing the bot), follow it with a manual `pm2 stop <name>`.

---

## Catching manual `pm2` commands

The bot also watches PM2's own event bus (not just its own actions) — if someone runs `pm2 stop palworld`, `pm2 restart palworld-bot`, etc. directly over SSH instead of through a Discord command, that gets posted to the relevant guild's `logChannelId` (or every registered guild's `logChannelId`, for the bot's own process, since that one isn't guild-specific) as an external-action warning. Actions the bot itself triggers are recognized and not double-reported.

PM2 doesn't distinguish "first start" from "restart" at the event level — even a plain `pm2 start` on a stopped process internally fires the same event a restart does — so the warning says "started or restarted" rather than guessing which one it actually was.

---

## Player join/leave tracking

Palworld's REST API has no push events for players connecting/disconnecting — only `GET /v1/api/players`, a snapshot. The bot polls that every 20 seconds per configured server and diffs it against the last snapshot, posting 🟢 joined / 🔴 left to that guild's `logChannelId`. A "left" could be a normal disconnect, a kick, or a ban — the players list can't tell those apart, so it's reported as a plain "left," not guessed at. The very first poll after startup just records who's already online without announcing anything (so a restart doesn't look like a mass server-join). A server that's briefly unreachable is skipped for that cycle rather than reported as everyone leaving.

---

## World save detection

Same problem as player tracking: the REST API has no "just saved" signal, and `/save` only *triggers* a save, it doesn't confirm one happened. Since the bot runs on the same machine as the server, it instead watches that server's `Level.sav` file's last-modified time every 15 seconds (needs `saveFilePath` set in `config/servers.json` — see above; skipped entirely for a server if it's not set). A save triggered through the bot (`/save`, or the automatic save `/restart` does before restarting) is recognized and not reported again through this path — only saves that happen some other way (Palworld's own `AutoSaveSpan` autosave, or an in-game/console save) post "💾 World saved on **{label}** (autosave or in-game, not `/save`)" to `logChannelId`. Purely read-only (`fs.stat`) — never touches the save file itself.

One caveat: if the *bot's own* process is killed externally, there's only a brief best-effort window to report that before it actually dies — it's not guaranteed for that one case.

---

## Deploying code changes

No CI/CD — updates are manual. **Only overwrite tracked source files, never `rm -rf`/replace the whole `/home/$USER/palworld-bot/` directory** — `config/*.json` and `data/audit-log.json` are gitignored and live only on the VM; wiping the directory destroys them.

```bash
# from your machine: copy changed files to the VM (pscp/scp), e.g.:
#   pscp path/to/file $USER@<vm-ip>:/home/$USER/palworld-bot/path/to/file
# then on the VM:
cd /home/$USER/palworld-bot
npm install              # only if package.json changed
npm test                 # sanity check — should be 0 failures before restarting
pm2 restart palworld-bot
pm2 save
```

If slash commands themselves changed (new command, renamed/added option, etc.), also run:

```bash
cd /home/$USER/palworld-bot && npm run deploy-commands
```
