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
let iconPos = null;
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
  const wa = screen.getDisplayMatching({ ...iconPos, width: ICON_SIZE, height: ICON_SIZE }).workArea;
  const width = Math.min(PANEL_WIDTH, wa.width - EDGE * 2);
  const height = Math.min(PANEL_HEIGHT, wa.height - EDGE * 2);
  const right = iconPos.x + ICON_SIZE / 2 > wa.x + wa.width / 2;
  const bottom = iconPos.y + ICON_SIZE / 2 > wa.y + wa.height / 2;
  const x = clamp(right ? iconPos.x + ICON_SIZE - width : iconPos.x, wa.x, wa.x + wa.width - width);
  const y = clamp(bottom ? iconPos.y + ICON_SIZE - height : iconPos.y, wa.y, wa.y + wa.height - height);
  return {
    rect: { x: Math.round(x), y: Math.round(y), width, height },
    origin: `${bottom ? 'bottom' : 'top'} ${right ? 'right' : 'left'}`,
  };
}

function collapsedBounds() {
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

function keepOnScreen() {
  iconPos = validIconPosition(iconPos) || defaultIconPosition();
  setExpanded(expanded);
}

function resetIconPosition() {
  iconPos = defaultIconPosition();
  config.set({ iconPosition: iconPos });
  setExpanded(false);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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
      { label: 'Move icon back to the corner', click: resetIconPosition },
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
  } else {
    iconPos = { x: x + PULSE_PAD, y: y + PULSE_PAD };
    win.setBounds(collapsedBounds());
  }
});

ipcMain.on('drag-end', () => {
  if (!win) return;
  if (expanded) {
    // The bubble follows the panel, so it collapses and reopens in the same place.
    iconPos = validIconPosition(iconForPanel(clampToWorkArea(win.getBounds()))) || defaultIconPosition();
    panelRect = panelBounds().rect;
    win.setBounds(panelRect);
  } else {
    iconPos = validIconPosition(iconPos) || defaultIconPosition();
    win.setBounds(collapsedBounds());
  }
  config.set({ iconPosition: iconPos });
});

ipcMain.on('click-through', (_e, on) => setClickThrough(!!on));

ipcMain.handle('update-action', (_e, action) => {
  if (!updater) return;
  if (action === 'install') updater.installNow();
  else updater.check();
});

ipcMain.handle('open-data-folder', () => shell.openPath(app.getPath('userData')));
