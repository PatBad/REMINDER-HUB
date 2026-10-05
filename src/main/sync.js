'use strict';

const { EventEmitter } = require('events');
const { SYNC } = require('./constants');
const { parse } = require('./store');

/**
 * Keeps the reminders in step between PCs through one private ("secret")
 * GitHub gist on the user's own account.
 *
 * Each sync downloads the gist, merges it into the local copy (the later
 * edit of each reminder wins), and uploads the result if the gist is missing
 * anything. Because every PC does the same, they settle on the same list even
 * if two upload at once; a change lost in a race is simply uploaded again by
 * the PC that still has it on its next sync.
 *
 * Emits 'status' (see this.status) and 'gist' ({ gistId, gistUrl, user }).
 */
class GistSync extends EventEmitter {
  constructor({ store, log, fetch = globalThis.fetch, api = SYNC.API }) {
    super();
    this.store = store;
    this.log = log;
    this.fetch = fetch;
    this.api = api;
    this.token = null;
    this.gistId = null;
    this.open = false;
    this.timer = null;
    this.pushTimer = null;
    this.running = null;
    this.again = false;
    this.authFailed = false;
    this.etag = null; // of the last downloaded gist, so unchanged polls are cheap
    this.remoteText = null; // what the gist held at that point
    this.status = { state: 'off', lastSyncAt: null, error: null, user: null, gistUrl: null };
  }

  /** Sets (or with no token, clears) the account to sync with. */
  configure({ token = null, gistId = null, user = null, gistUrl = null } = {}) {
    this.token = token;
    this.gistId = gistId;
    this.etag = null;
    this.remoteText = null;
    this.authFailed = false;
    clearTimeout(this.timer);
    clearTimeout(this.pushTimer);
    this._set({ state: token ? 'idle' : 'off', error: null, user, gistUrl, lastSyncAt: null });
  }

  /**
   * Checks a new token, finds this account's Reminder Hub gist (or creates
   * one), then syncs. Throws with a readable message if the token won't do.
   */
  async connect(token) {
    const previous = { token: this.token, gistId: this.gistId, user: this.status.user, gistUrl: this.status.gistUrl };
    this.configure({ token });
    this._set({ state: 'syncing' });
    try {
      const me = await this._request('GET', '/user');
      const scopes = me.headers.get('x-oauth-scopes');
      // Classic tokens list their scopes; fine-grained ones don't (a missing permission shows up below).
      if (scopes !== null && !scopes.split(',').map((s) => s.trim()).includes('gist')) {
        throw new Error('That token can’t use gists. Make a new one with the “gist” box ticked.');
      }
      this.status.user = me.data.login;
      await this._findOrCreateGist();
    } catch (err) {
      this.configure(previous);
      if (previous.token) this.sync();
      throw new Error(friendlyError(err, 'connect'));
    }
    await this.sync();
    return { user: this.status.user, gistId: this.gistId, gistUrl: this.status.gistUrl };
  }

  disconnect() {
    this.configure({});
  }

  /** Called when the panel opens or closes: poll more often while it's open. */
  setOpen(open) {
    this.open = open;
    if (!this.token) return;
    const age = Date.now() - (this.status.lastSyncAt || 0);
    if (open && age > 5000) this.sync();
    else this._schedule();
  }

  /** Called after a local edit: upload shortly (edits in quick succession go together). */
  schedulePush() {
    if (!this.token) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.sync(), SYNC.PUSH_DELAY_MS);
  }

  /** Syncs now. If a sync is already running, another follows it. */
  sync() {
    if (!this.token) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    clearTimeout(this.timer);
    clearTimeout(this.pushTimer);
    this.running = (async () => {
      do {
        this.again = false;
        await this._syncOnce();
      } while (this.again && this.token && !this.authFailed);
    })().finally(() => {
      this.running = null;
      this._schedule();
    });
    return this.running;
  }

  stop() {
    this.token = null;
    clearTimeout(this.timer);
    clearTimeout(this.pushTimer);
  }

  async _syncOnce() {
    if (this.authFailed) return;
    const token = this.token;
    this._set({ state: 'syncing' });
    try {
      if (!this.gistId) await this._findOrCreateGist();
      let remote;
      try {
        remote = await this._download();
      } catch (err) {
        if (err.status !== 404) throw err;
        // The gist was deleted on GitHub: start a new one from what's here.
        this.log.warn('sync gist not found; creating a new one');
        this.gistId = null;
        await this._findOrCreateGist();
        remote = await this._download();
      }
      if (remote) {
        try {
          if (this.store.merge(parse(remote))) this.log.info('sync: merged changes from the gist');
        } catch (err) {
          this.log.warn('sync: gist content unreadable, replacing it:', err.message);
        }
      }
      const local = this.store.serialize();
      if (local !== remote && token === this.token) {
        await this._request('PATCH', `/gists/${this.gistId}`, { body: { files: { [SYNC.FILE]: { content: local } } } });
        // The next download fetches the new version in full (and gets its tag).
        this.etag = null;
        this.remoteText = null;
        this.log.info('sync: uploaded changes');
      }
      if (token === this.token) this._set({ state: 'ok', error: null, lastSyncAt: Date.now() });
    } catch (err) {
      if (token !== this.token) return; // disconnected or reconnected meanwhile
      if (err.status === 401) this.authFailed = true;
      const state = err.offline ? 'offline' : 'error';
      if (!err.offline) this.log.warn('sync failed:', err.status || '', err.message);
      this._set({ state, error: friendlyError(err, 'sync') });
    }
  }

  /** The gist file's current text (null if the file is missing). */
  async _download() {
    const res = await this._request('GET', `/gists/${this.gistId}`, { etag: this.remoteText !== null ? this.etag : null });
    if (res.status === 304) return this.remoteText;
    const file = res.data.files && res.data.files[SYNC.FILE];
    let text = file ? file.content : null;
    if (file && file.truncated) text = (await this._request('GET', file.raw_url, { raw: true })).text;
    this.etag = res.headers.get('etag');
    this.remoteText = text;
    if (res.data.html_url && res.data.html_url !== this.status.gistUrl) this._set({ gistUrl: res.data.html_url });
    return text;
  }

  /** Finds the account's existing Reminder Hub gist, or makes a new secret one. */
  async _findOrCreateGist() {
    for (let page = 1; page <= 10; page++) {
      const { data } = await this._request('GET', `/gists?per_page=100&page=${page}`);
      const found = data.find((g) => g.files && g.files[SYNC.FILE]);
      if (found) {
        this._useGist(found, 'found');
        return;
      }
      if (data.length < 100) break;
    }
    const { data } = await this._request('POST', '/gists', {
      body: { description: SYNC.DESCRIPTION, public: false, files: { [SYNC.FILE]: { content: this.store.serialize() } } },
    });
    this._useGist(data, 'created');
  }

  _useGist(gist, how) {
    this.gistId = gist.id;
    this.etag = null;
    this.remoteText = null;
    this.log.info(`sync: ${how} gist ${gist.id}`);
    this._set({ gistUrl: gist.html_url });
    this.emit('gist', { gistId: gist.id, gistUrl: gist.html_url, user: this.status.user });
  }

  async _request(method, pathOrUrl, { body, etag, raw = false } = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Reminder-Hub',
    };
    if (etag) headers['If-None-Match'] = etag;
    if (body) headers['Content-Type'] = 'application/json';
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${this.api}${pathOrUrl}`;
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(SYNC.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw Object.assign(new Error(err.message || 'network error'), { offline: true });
    }
    if (res.status === 304) return { status: 304, headers: res.headers };
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let message = `GitHub returned ${res.status}`;
      try {
        message = JSON.parse(text).message || message;
      } catch {
        // not JSON
      }
      throw Object.assign(new Error(message), {
        status: res.status,
        rateLimited: res.headers.get('x-ratelimit-remaining') === '0',
      });
    }
    if (raw) return { status: res.status, headers: res.headers, text };
    return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
  }

  _schedule() {
    clearTimeout(this.timer);
    if (!this.token || this.authFailed) return;
    this.timer = setTimeout(() => this.sync(), this.open ? SYNC.POLL_OPEN_MS : SYNC.POLL_MS);
  }

  _set(values) {
    Object.assign(this.status, values);
    this.emit('status', { ...this.status });
  }
}

function friendlyError(err, during) {
  if (err.offline) return 'Can’t reach GitHub. Changes are saved on this PC and will sync when it’s back online.';
  if (err.status === 401) {
    return during === 'connect'
      ? 'GitHub didn’t accept that token. Check you copied all of it.'
      : 'GitHub didn’t accept the token. It may have expired: paste a new one below.';
  }
  if (err.rateLimited) return 'GitHub is limiting requests for a while. Syncing will carry on shortly.';
  if (err.status === 403 || err.status === 404) {
    return during === 'connect'
      ? 'That token doesn’t have permission to use gists. Make one with the “gist” box ticked.'
      : 'The token no longer has permission to use gists.';
  }
  return err.message || 'Something went wrong while syncing.';
}

module.exports = { GistSync };
