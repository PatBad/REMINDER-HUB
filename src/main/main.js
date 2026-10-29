'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, shell, net, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { LEVELS, LEVEL_IDS, LIMITS } = require('./constants');
const { Config } = require('./config');
const { ReminderStore } = require('./store');
const { GistSync } = require('./sync');
const { Updater } = require('./updater');
const { createLogger } = require('./logger');
const { clamp, makeDock, dockSnap, matchDockArea } = require('./geometry');

// Developer override so a test copy can run beside the installed one.
// See README "Running a test copy".
if (process.env.RH_DATA_DIR) app.setPath('userData', path.resolve(process.env.RH_DATA_DIR));

// The logo's box: a 60px bubble plus room for its shadow. iconPos is this box's top-left.
const ICON_SIZE = 76;
// While collapsed the window is this much bigger on every side, so the due
// pulse has room to spread. The extra area lets clicks through to the apps below.
const PULSE_PAD = 22;
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 640;
const EDGE = 12;
// Docked, the bell's centre sits on the screen edge, so half of it shows. The window
// is just that half plus room for the pulse; the rest of the bell would be off-screen.
const DOCK_WIDTH = ICON_SIZE / 2 + PULSE_PAD;
// Dropping the bell this close to a left or right edge docks it.
const DOCK_SNAP = 30;
// Pulling a docked bell this far away from its edge undocks it. (More than the bell's half-width
// plus DOCK_SNAP, so letting go straight after it comes free leaves it free rather than docking it again.)
const DOCK_DETACH = 80;
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const HOST = os.hostname().slice(0, 40);
const TOKEN_PAGE = 'https://github.com/settings/tokens/new?scopes=gist&description=Reminder%20Hub';

let win = null;
let tray = null;
let config;
let store;
let sync;
let updater = null;
let log;
let expanded = false;
let iconPos = null; // the free-floating bell's box; kept while docked, for when it is pulled out
let dock = null; // { side, edge, y } while the bell is docked to a screen edge, else null
let dragStart = null; // the bell as it was when the current drag of it began
let dockHint = false; // the bell being dragged is close enough to an edge to dock
let panelRect = null;
let quitting = false;
let dueCheckedUntil = Date.now(); // reminders due before this have already chimed

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => setExpanded(true));
  app.whenReady().then(start).catch((err) => {
    console.error(err);
    app.quit();
  });
}

async function start() {
  const dataDir = app.getPath('userData');
  log = createLogger(path.join(dataDir, 'logs'));
  log.info(`Reminder Hub ${app.getVersion()} starting on ${HOST}`);

  config = new Config(dataDir);
  // A copied profile keeps the old id; give each PC its own.
  if (!config.get('deviceId') || config.get('deviceHost') !== HOST) {
    config.set({ deviceId: `${HOST}:${crypto.randomUUID().slice(0, 8)}`, deviceHost: HOST });
  }

  store = new ReminderStore(dataDir, { device: config.get('deviceId') }).load();
  if (store.loadError) log.error('reminders file unreadable:', store.loadError);
  log.info(`loaded ${store.all().length} reminders`);
  store.on('changed', ({ source }) => {
    send('reminders-changed', { alert: null });
    sendSummary();
    if (source === 'local') sync.schedulePush();
  });

  sync = new GistSync({ store, log, fetch: (url, init) => net.fetch(url, init) });
  sync.on('status', (status) => {
    send('sync-status', status);
    refreshTray();
  });
  sync.on('gist', ({ gistId, gistUrl, user }) => config.set({ gistId, gistUrl, githubUser: user }));
  const token = readToken();
  if (token) {
    sync.configure({ token, gistId: config.get('gistId'), user: config.get('githubUser'), gistUrl: config.get('gistUrl') });
  }

  applyAutoStart();
  createWindow();

  updater = new Updater({ log, canInstallNow: () => !expanded });
  updater.on('status', (status) => {
    send('update-status', status);
    refreshTray();
  });
  createTray();
  updater.start();
  sync.sync();

  // Chime when a reminder falls due.
  setInterval(checkDue, 15000);
  // After sleep the other PC may have changed things.
  powerMonitor.on('resume', () => sync.sync());
  powerMonitor.on('unlock-screen', () => sync.sync());

  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);
  // Some full-screen apps knock topmost windows down; put ourselves back.
  setInterval(() => {
    if (win && !win.isDestroyed() && !win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
  }, 30000);
}

app.on('before-quit', () => {
  quitting = true;
  if (sync) sync.stop();
});

// ---------- Window ----------

function createWindow() {
  iconPos = validIconPosition(config.get('iconPosition')) || defaultIconPosition();
  dock = initialDock();
  win = new BrowserWindow({
    ...collapsedBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Reminder Hub',
    icon: path.join(ASSETS, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  setClickThrough(true);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    // First run: open straight onto the welcome / sync setup.
    if (!config.get('welcomed')) setExpanded(true);
    else win.showInactive();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Alt+F4 collapses rather than quits; quitting is in the tray menu.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    setExpanded(false);
  });
}

function setExpanded(value) {
  if (!win || win.isDestroyed()) return;
  expanded = !!value;
  let origin = 'bottom right';
  if (expanded) {
    const bounds = panelBounds();
    origin = bounds.origin;
    panelRect = bounds.rect;
    setClickThrough(false);
    win.setBounds(panelRect);
    win.show();
    win.focus();
  } else {
    sendDock();
    win.setBounds(collapsedBounds());
    setClickThrough(true);
    if (!win.isVisible()) win.showInactive();
    if (updater) updater.installIfIdle();
  }
  if (sync) sync.setOpen(expanded);
  send('view', { expanded, origin });
}

/** Opens the panel out of the bubble, towards the middle of the screen. */
function panelBounds() {
  const icon = logoBox();
  const wa = screen.getDisplayMatching({ ...icon, width: ICON_SIZE, height: ICON_SIZE }).workArea;
  const width = Math.min(PANEL_WIDTH, wa.width - EDGE * 2);
  const height = Math.min(PANEL_HEIGHT, wa.height - EDGE * 2);
  const right = icon.x + ICON_SIZE / 2 > wa.x + wa.width / 2;
  const bottom = icon.y + ICON_SIZE / 2 > wa.y + wa.height / 2;
  const x = clamp(right ? icon.x + ICON_SIZE - width : icon.x, wa.x, wa.x + wa.width - width);
  const y = clamp(bottom ? icon.y + ICON_SIZE - height : icon.y, wa.y, wa.y + wa.height - height);
  return {
    rect: { x: Math.round(x), y: Math.round(y), width, height },
    origin: `${bottom ? 'bottom' : 'top'} ${right ? 'right' : 'left'}`,
  };
}

/** The bell's box as if it were all showing: where it floats, or centred on the edge it is docked to. */
function logoBox() {
  return dock ? { x: dock.edge - ICON_SIZE / 2, y: dock.y } : iconPos;
}

function collapsedBounds() {
  if (dock) {
    return {
      x: dock.side === 'left' ? dock.edge : dock.edge - DOCK_WIDTH,
      y: dock.y - PULSE_PAD,
      width: DOCK_WIDTH,
      height: ICON_SIZE + PULSE_PAD * 2,
    };
  }
  return {
    x: iconPos.x - PULSE_PAD,
    y: iconPos.y - PULSE_PAD,
    width: ICON_SIZE + PULSE_PAD * 2,
    height: ICON_SIZE + PULSE_PAD * 2,
  };
}

/**
 * While collapsed, clicks pass through the window except over the bubble
 * itself (the page switches this off while the mouse is over the bubble).
 * `forward` still delivers mouse movement so the page can tell.
 */
function setClickThrough(on) {
  if (!win || win.isDestroyed()) return;
  if (on && !expanded) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
}

/** Where the bubble goes for a panel at `rect`: its corner nearest the screen edges. */
function iconForPanel(rect) {
  const wa = screen.getDisplayMatching(rect).workArea;
  const right = rect.x + rect.width / 2 > wa.x + wa.width / 2;
  const bottom = rect.y + rect.height / 2 > wa.y + wa.height / 2;
  return {
    x: right ? rect.x + rect.width - ICON_SIZE : rect.x,
    y: bottom ? rect.y + rect.height - ICON_SIZE : rect.y,
  };
}

function clampToWorkArea(rect) {
  const wa = screen.getDisplayMatching(rect).workArea;
  return {
    ...rect,
    x: Math.round(clamp(rect.x, wa.x, wa.x + wa.width - rect.width)),
    y: Math.round(clamp(rect.y, wa.y, wa.y + wa.height - rect.height)),
  };
}

function defaultIconPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - ICON_SIZE - EDGE, y: wa.y + Math.round(wa.height * 0.5) };
}

/** Returns the position clamped onto whichever screen it's on, or null if it's on none. */
function validIconPosition(pos) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
  const cx = pos.x + ICON_SIZE / 2;
  const cy = pos.y + ICON_SIZE / 2;
  const display = screen
    .getAllDisplays()
    .find(({ workArea: w }) => cx >= w.x && cx < w.x + w.width && cy >= w.y && cy < w.y + w.height);
  if (!display) return null;
  const w = display.workArea;
  return {
    x: Math.round(clamp(pos.x, w.x, w.x + w.width - ICON_SIZE)),
    y: Math.round(clamp(pos.y, w.y, w.y + w.height - ICON_SIZE)),
  };
}

/** A dock on the right of the main screen, at mid-height: where a new install starts. */
function defaultDock() {
  const wa = screen.getPrimaryDisplay().workArea;
  return makeDock('right', wa, wa.y + Math.round(wa.height * 0.5), ICON_SIZE);
}

/** The dock on whichever side of its screen the box at `pos` is nearer, at the same height. */
function dockFromBox(pos) {
  const wa = screen.getDisplayMatching({ ...pos, width: ICON_SIZE, height: ICON_SIZE }).workArea;
  const left = pos.x + ICON_SIZE / 2 < wa.x + wa.width / 2;
  return makeDock(left ? 'left' : 'right', wa, pos.y, ICON_SIZE);
}

/** The saved dock re-fitted to the screens as they are now, or null if it fits none. */
function validDock(saved) {
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const area = matchDockArea(saved, ICON_SIZE, areas);
  return area ? makeDock(saved.side, area, saved.y, ICON_SIZE) : null;
}

/**
 * How the bell starts. Docked unless it was pulled out of its dock on this PC.
 * A PC from before docking existed docks on the side its bell was nearest.
 */
function initialDock() {
  const saved = config.get('dock');
  if (saved === false) return null;
  let found = validDock(saved);
  if (!found) found = validIconPosition(config.get('iconPosition')) ? dockFromBox(iconPos) : defaultDock();
  config.set({ dock: found });
  return found;
}

/** Tells the page which edge it is docked to (null if free) so it can draw the half-hidden bell. */
function sendDock() {
  send('dock', dock ? dock.side : null);
}

function keepOnScreen() {
  iconPos = validIconPosition(iconPos) || defaultIconPosition();
  if (dock) {
    dock = validDock(dock) || defaultDock();
    config.set({ dock });
  }
  setExpanded(expanded);
}

function resetIconPosition() {
  dock = defaultDock();
  iconPos = defaultIconPosition();
  config.set({ dock, iconPosition: iconPos });
  setExpanded(false);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- Tray ----------

function createTray() {
  tray = new Tray(path.join(ASSETS, 'icon.ico'));
  tray.on('click', () => setExpanded(!expanded));
  refreshTray();
}

function syncLabel(status) {
  return {
    off: 'Sync is off (this PC only)',
    idle: 'Sync on',
    syncing: 'Syncing…',
    ok: `Synced with GitHub${status.user ? ` (${status.user})` : ''}`,
    offline: 'Offline: will sync when back online',
    error: 'Sync problem: see Settings',
  }[status.state];
}

function refreshTray() {
  if (!tray) return;
  const update = updater ? updater.status : { state: 'dev' };
  const { attention } = summary();
  tray.setToolTip(attention ? `Reminder Hub – ${attention} need attention` : 'Reminder Hub');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Reminder Hub ${app.getVersion()}`, enabled: false },
      { label: syncLabel(sync.status), enabled: false },
      { type: 'separator' },
      { label: 'Open reminders', click: () => setExpanded(true) },
      {
        label: 'Settings…',
        click: () => {
          setExpanded(true);
          send('open', 'settings');
        },
      },
      { label: 'Sync now', enabled: sync.status.state !== 'off', click: () => sync.sync() },
      { label: 'Put the bell back on the side of the screen', click: resetIconPosition },
      { type: 'separator' },
      update.state === 'ready'
        ? { label: `Restart to update to ${update.version}`, click: () => updater.installNow() }
        : { label: 'Check for updates', enabled: app.isPackaged, click: () => updater.check() },
      { type: 'separator' },
      {
        label: 'Quit Reminder Hub',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ---------- Reminders ----------

/**
 * Counts for the tabs and the bubble. "Attention" (the bubble's badge) is
 * every open Urgent reminder plus any other that's overdue. unseenDue makes
 * the bubble pulse: something fell due since the panel was last opened.
 */
function summary() {
  const counts = Object.fromEntries(LEVEL_IDS.map((id) => [id, { open: 0, overdue: 0 }]));
  const empty = { counts, done: 0, attention: 0, unseenDue: false };
  if (!store) return empty;
  const now = Date.now();
  const seenAt = config.get('seenAt') || 0;
  for (const r of store.all()) {
    if (r.doneAt) {
      empty.done++;
      continue;
    }
    const overdue = r.dueAt !== null && r.dueAt <= now;
    counts[r.level].open++;
    if (overdue) counts[r.level].overdue++;
    if (r.level === 'urgent' || overdue) empty.attention++;
    if (overdue && r.dueAt > seenAt) empty.unseenDue = true;
  }
  return empty;
}

function sendSummary() {
  send('summary', summary());
  refreshTray();
}

function checkDue() {
  const now = Date.now();
  const nowDue = store.all().filter((r) => !r.doneAt && r.dueAt !== null && r.dueAt > dueCheckedUntil && r.dueAt <= now);
  dueCheckedUntil = now;
  if (!nowDue.length) return;
  log.info(`${nowDue.length} reminder(s) now due`);
  send('reminders-changed', { alert: 'due' });
  sendSummary();
}

/** Cleans up fields sent by the page. */
function reminderInput(input = {}) {
  const out = {};
  if (typeof input.text === 'string') out.text = input.text.slice(0, LIMITS.TEXT);
  if (LEVEL_IDS.includes(input.level)) out.level = input.level;
  if (input.dueAt === null || Number.isFinite(input.dueAt)) out.dueAt = input.dueAt;
  if (typeof input.done === 'boolean') out.done = input.done;
  return out;
}

const idList = (ids) => (Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);

// ---------- Settings & sync token ----------

function publicSettings() {
  return {
    sound: config.get('sound'),
    autoStart: config.get('autoStart'),
    lastLevel: config.get('lastLevel'),
    welcomed: config.get('welcomed'),
  };
}

function applyAutoStart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!config.get('autoStart') });
}

/** The GitHub token, kept encrypted with Windows' own per-user encryption. */
function readToken() {
  const saved = config.get('syncToken');
  if (typeof saved !== 'string') return null;
  try {
    if (saved.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(saved.slice(4), 'base64'));
    if (saved.startsWith('plain:')) return saved.slice(6);
  } catch (err) {
    log.warn('could not read the saved sync token:', err.message);
  }
  return null;
}

function saveToken(token) {
  if (!token) {
    config.set({ syncToken: null });
    return;
  }
  const saved = safeStorage.isEncryptionAvailable()
    ? `enc:${safeStorage.encryptString(token).toString('base64')}`
    : `plain:${token}`;
  config.set({ syncToken: saved });
}

// ---------- IPC ----------

ipcMain.handle('get-state', () => ({
  version: app.getVersion(),
  host: HOST,
  levels: LEVELS,
  settings: publicSettings(),
  expanded,
  dock: dock ? dock.side : null,
  summary: summary(),
  sync: sync.status,
  update: updater ? updater.status : { state: 'dev' },
}));

ipcMain.handle('list', () => store.all());

ipcMain.handle('add', (_e, input) => {
  const fields = reminderInput(input);
  const record = store.create({ text: fields.text, level: fields.level, dueAt: fields.dueAt ?? null });
  config.set({ lastLevel: record.level });
  return record;
});

ipcMain.handle('update', (_e, { id, changes } = {}) => store.update(id, reminderInput(changes)));

// Returns the removed reminders, which the page hands back to 'restore' for Undo.
ipcMain.handle('remove', (_e, ids) => store.remove(idList(ids)));

ipcMain.handle('restore', (_e, records) => store.restore(Array.isArray(records) ? records : []));

ipcMain.handle('clear-done', () => store.remove(store.all().filter((r) => r.doneAt).map((r) => r.id)));

ipcMain.handle('set-settings', (_e, values = {}) => {
  const next = {};
  if (typeof values.sound === 'boolean') next.sound = values.sound;
  if (typeof values.autoStart === 'boolean') next.autoStart = values.autoStart;
  if (values.welcomed === true) next.welcomed = true;
  config.set(next);
  if ('autoStart' in next) applyAutoStart();
  return publicSettings();
});

ipcMain.handle('set-expanded', (_e, value) => setExpanded(!!value));

ipcMain.handle('mark-seen', () => {
  config.set({ seenAt: Date.now() });
  sendSummary();
});

ipcMain.handle('sync-connect', async (_e, token) => {
  token = typeof token === 'string' ? token.trim() : '';
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) return { ok: false, error: 'That doesn’t look like a GitHub token. Copy the whole thing (it starts ghp_ or github_pat_).' };
  try {
    const result = await sync.connect(token);
    saveToken(token);
    config.set({ gistId: result.gistId, gistUrl: result.gistUrl, githubUser: result.user, welcomed: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sync-disconnect', () => {
  sync.disconnect();
  saveToken(null);
  config.set({ gistId: null, gistUrl: null, githubUser: null });
});

ipcMain.handle('sync-now', () => sync.sync());

ipcMain.handle('open-link', (_e, which) => {
  const url = which === 'token' ? TOKEN_PAGE : which === 'gist' ? sync.status.gistUrl : null;
  if (typeof url === 'string' && /^https:\/\/(gist\.)?github\.com\//.test(url)) shell.openExternal(url);
});

// `pos` is where the page wants the window's top-left corner.
ipcMain.on('drag-move', (_e, pos) => {
  if (!win || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
  const x = Math.round(pos.x);
  const y = Math.round(pos.y);
  // setBounds (not setPosition) so the size can't drift across mixed-DPI screens.
  if (expanded) {
    win.setBounds({ x, y, width: panelRect.width, height: panelRect.height });
    return;
  }
  // `pos` is where the window began plus how far the pointer has moved, whatever shape
  // the window has now, so work from the movement. (The window changes shape when the bell is pulled out.)
  const { x: x0, y: y0 } = win.getBounds();
  if (!dragStart) dragStart = { box: { ...logoBox() }, from: { x: x0, y: y0 } };
  const dx = x - dragStart.from.x;
  const dy = y - dragStart.from.y;
  if (dock) {
    // Docked: up and down moves it along the edge; pulling it away from the edge frees it.
    const pulled = dock.side === 'left' ? dx : -dx;
    if (pulled <= DOCK_DETACH) {
      const wa = screen.getDisplayMatching(win.getBounds()).workArea;
      dock = makeDock(dock.side, wa, dragStart.box.y + dy, ICON_SIZE);
      win.setBounds(collapsedBounds());
      return;
    }
    dock = null;
    sendDock();
  }
  iconPos = { x: dragStart.box.x + dx, y: dragStart.box.y + dy };
  win.setBounds(collapsedBounds());
  setDockHint(Boolean(snapSideFor(iconPos)));
});

/** Which side the free bell at `box` would dock to if dropped now, or null. */
function snapSideFor(box) {
  const wa = screen.getDisplayMatching({ ...box, width: ICON_SIZE, height: ICON_SIZE }).workArea;
  return dockSnap(box, ICON_SIZE, wa, DOCK_SNAP);
}

/** Lets the page glow the bell while it is close enough to an edge to dock. */
function setDockHint(on) {
  if (on === dockHint) return;
  dockHint = on;
  send('dock-hint', on);
}

ipcMain.on('drag-end', () => {
  if (!win) return;
  if (expanded && dock) {
    // The list can go anywhere; closing it sends the bell back to its dock.
    panelRect = clampToWorkArea(win.getBounds());
    win.setBounds(panelRect);
  } else if (expanded) {
    // The bubble follows the panel, so it collapses and reopens in the same place.
    iconPos = validIconPosition(iconForPanel(clampToWorkArea(win.getBounds()))) || defaultIconPosition();
    panelRect = panelBounds().rect;
    win.setBounds(panelRect);
    config.set({ iconPosition: iconPos });
  } else {
    dragStart = null;
    setDockHint(false);
    const side = dock ? null : snapSideFor(iconPos);
    if (side) {
      // Dropped by an edge: it docks there, level with where it was dropped.
      const wa = screen.getDisplayMatching({ ...iconPos, width: ICON_SIZE, height: ICON_SIZE }).workArea;
      dock = makeDock(side, wa, iconPos.y, ICON_SIZE);
    }
    iconPos = validIconPosition(iconPos) || defaultIconPosition();
    sendDock();
    win.setBounds(collapsedBounds());
    config.set({ dock: dock || false, iconPosition: iconPos });
  }
});

ipcMain.on('click-through', (_e, on) => setClickThrough(!!on));

ipcMain.handle('update-action', (_e, action) => {
  if (!updater) return;
  if (action === 'install') updater.installNow();
  else updater.check();
});

ipcMain.handle('open-data-folder', () => shell.openPath(app.getPath('userData')));
