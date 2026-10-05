'use strict';

const { app } = require('electron');
const { EventEmitter } = require('events');

const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Checks the GitHub repo's Releases for a newer version, downloads it in the
 * background and installs it. The app runs all day, so instead of waiting
 * for a quit we restart into the new version as soon as the reminder panel is
 * collapsed (never while someone might be typing).
 */
class Updater extends EventEmitter {
  constructor({ log, canInstallNow }) {
    super();
    this.log = log;
    this.canInstallNow = canInstallNow;
    this.status = { state: app.isPackaged ? 'idle' : 'dev', version: null, error: null };
    this.autoUpdater = null;
  }

  start() {
    if (!app.isPackaged) return;
    const { autoUpdater } = require('electron-updater');
    this.autoUpdater = autoUpdater;
    autoUpdater.logger = this.log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => this._set({ state: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this._set({ state: 'current' }));
    autoUpdater.on('update-available', (info) => this._set({ state: 'downloading', version: info.version }));
    autoUpdater.on('update-downloaded', (info) => {
      this._set({ state: 'ready', version: info.version });
      this.installIfIdle();
    });
    autoUpdater.on('error', (err) => {
      this.log.warn('update check failed:', err && err.message);
      this._set({ state: 'error', error: 'Could not reach the update server.' });
    });

    setTimeout(() => this.check(), FIRST_CHECK_MS);
    setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  check() {
    if (!this.autoUpdater || this.status.state === 'ready') return;
    this.autoUpdater.checkForUpdates().catch(() => {}); // reported via 'error'
  }

  installIfIdle() {
    if (this.status.state === 'ready' && this.canInstallNow()) this.installNow();
  }

  installNow() {
    if (this.status.state !== 'ready') return;
    this.log.info(`installing update ${this.status.version}`);
    setImmediate(() => this.autoUpdater.quitAndInstall(true, true));
  }

  _set(values) {
    Object.assign(this.status, values);
    this.emit('status', { ...this.status });
  }
}

module.exports = { Updater };
