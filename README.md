# Reminder Hub

A personal reminder list that floats on top of every window, sorted into tabs by urgency, and kept the same on more than one PC.

- **Collapsed**, it's the blue bell floating at the edge of the screen. The red badge counts reminders that need attention (everything in **Urgent**, plus anything overdue). Blue rings pulse when a reminder falls due.
- **Expanded**, it's your list, in five tabs: **Urgent**, **Soon**, **Later**, **Someday** and **Done**.

## Using it

| To… | Do this |
| --- | --- |
| Open the list | Click the bell |
| Move the bell | Drag it anywhere on screen (it remembers where) |
| Move the open list | Drag it by its top bar; the bell moves with it to the nearest corner |
| Minimise back to the bell | Click **—** or press **Esc** |
| Add a reminder | Pick its urgency above the box (it starts on the tab you're in), type, press **Enter** (**Shift+Enter** for a new line). Tick **Due** to set a time: it chimes and the bell pulses when that time comes |
| Mark one done | Click the circle on its left. It moves to **Done**; click the circle again to bring it back |
| Move it to another tab | Point at it and click one of the coloured dots (red Urgent, amber Soon, blue Later, grey Someday) |
| Edit it | Point at it and click the pencil, or double-click its text. **Enter** saves, **Esc** cancels |
| Delete it | Point at it and click the bin. **Undo** appears for a few seconds |
| Put off an overdue one | **Snooze 1 hour**, **Tomorrow 9 am**, or **Clear due time** |
| Tidy the Done tab | **Clear all done** (with Undo) |
| Search every tab | Magnifying glass, or **Ctrl+F** |
| Switch tabs from the keyboard | **Ctrl+1** … **Ctrl+5** |
| Settings / Quit | Gear icon, or right-click the bell in the Windows system tray |

Within a tab, reminders with a due time come first (soonest or most overdue at the top), then the rest, newest first.

## Syncing between PCs

Your reminders are kept in a **private (secret) gist** on your own GitHub account, which both PCs read and write. Nothing goes anywhere else. Each PC also keeps its own full copy, so the app works offline and catches up when it's back online.

**Set up (once per PC):**

1. In Reminder Hub, click **Open GitHub's new-token page** (on the welcome screen, or **Settings → Sync between PCs**). Sign in to GitHub if asked.
2. Leave the **gist** box ticked (it's the only permission the token needs), choose an **Expiration** ("No expiration" means you never have to redo this), and click **Generate token**.
3. Copy the token, paste it into Reminder Hub and click **Connect**.
4. On your other PC, paste the same token (or make a second one the same way). It finds the same gist automatically, and the two lists merge.

Changes upload a second or so after you make them. Each PC checks for the other's changes every minute (every 15 seconds while the list is open), when the list is opened, and after waking from sleep. If the same reminder is changed on both PCs before they sync, the later change wins.

The token is stored encrypted with Windows' own per-user encryption, in `%APPDATA%\Reminder Hub\config.json`. To stop syncing on a PC, use **Turn off sync** in Settings. To revoke access completely, delete the token on GitHub (Settings → Developer settings → Personal access tokens).

**Settings → View the data on GitHub** opens the gist. Don't edit it by hand: if it stops being valid data, the app replaces it with the PC's own copy.

## Installing

1. Download `Reminder-Hub-Setup-x.y.z.exe` from the [Releases page](https://github.com/PatBad/REMINDER-HUB/releases/latest).
2. Run it. The installer isn't code-signed, so Windows may show "Windows protected your PC". Click **More info → Run anyway**.
3. Connect sync on the welcome screen, or skip it to use the app on that PC only.

It installs into your Windows user profile (no admin needed) and starts with Windows.

## Updates

Installed copies check this repository's GitHub Releases 30 seconds after starting and every 4 hours after that. A new version downloads in the background and installs the next time the list is minimised. **Settings → Restart now** installs it straight away.

> **The repository needs to be public** for automatic updates, because installed copies download releases without logging in to GitHub. Your reminders are never in the repository (they live in the secret gist), so making it public is safe. If it stays private, download new versions from the Releases page by hand.

### Releasing an update

1. Make and test your changes (`npm start`, `npm test`).
2. Bump the version. This commits and creates a tag such as `v1.0.1`:
   ```bash
   npm version patch
   ```
3. Push the commit and the tag:
   ```bash
   git push --follow-tags
   ```
4. GitHub Actions (`.github/workflows/release.yml`) runs the tests, builds the installer and publishes it as a release.

## Development

Requires Node.js 22 or newer.

```bash
npm install
```

```bash
npm start
```

| Command | What it does |
| --- | --- |
| `npm start` | Run the app from source |
| `npm test` | Run the storage and sync tests |
| `npm run dist` | Build the installer into `dist/` without publishing |
| `npm run icons` | Regenerate the icon files from `assets/logo.svg` |

### Running a test copy

`RH_DATA_DIR` gives a copy its own data folder, so it can run beside the installed app without touching your real reminders:

```powershell
$env:RH_DATA_DIR = "$PWD\.dev-data\a"; npm start
```

### Project layout

```
src/main/main.js       Window (expand/collapse, drag, always on top), tray, due alerts, IPC
src/main/store.js      Reminders on disk + validation + merge rules
src/main/sync.js       Sync through a private GitHub gist
src/main/updater.js    Auto-update from GitHub Releases
src/main/config.js     Per-PC settings (bell position, sync token, …)
src/preload.js         The safe bridge between the window and the main process
src/renderer/          The interface (HTML/CSS/JS, no framework)
test/                  node:test suites
```

## Troubleshooting

- **Data**: `%APPDATA%\Reminder Hub\reminders.json` (Settings → Open data folder). If that file is ever unreadable, it's copied aside as `reminders.json.corrupt-…` and, with sync on, the list comes back from the gist.
- **Logs**: `%APPDATA%\Reminder Hub\logs\reminder-hub.log`
- **"Sync problem"**: Settings shows the reason. If GitHub stopped accepting the token (expired or deleted), paste a new one there.
- **Bell disappeared off-screen** (e.g. after unplugging a monitor): right-click the tray icon → **Move icon back to the corner**.
