'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReminderStore } = require('../src/main/store');
const { GistSync } = require('../src/main/sync');
const { SYNC } = require('../src/main/constants');

const log = { info() {}, warn() {}, error() {} };
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sync-'));

/**
 * A pretend GitHub gist API: one account, its gists, ETags and a token check.
 * `calls` records each request as "METHOD /path".
 */
function fakeGitHub({ token = 'ghp_goodtoken12345678901234', scopes = 'gist, repo' } = {}) {
  const gh = { gists: new Map(), calls: [], nextId: 1, offline: false };
  const reply = (status, body, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
  const view = (g) => ({
    id: g.id,
    html_url: `https://gist.github.com/${g.id}`,
    files: Object.fromEntries(Object.entries(g.files).map(([name, content]) => [name, { content, truncated: false }])),
  });
  gh.fetch = async (url, init = {}) => {
    if (gh.offline) throw new TypeError('fetch failed');
    const { pathname } = new URL(url);
    const method = init.method || 'GET';
    gh.calls.push(`${method} ${pathname}`);
    if (init.headers.Authorization !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });
    if (method === 'GET' && pathname === '/user') return reply(200, { login: 'patbad' }, scopes === null ? {} : { 'x-oauth-scopes': scopes });
    if (method === 'GET' && pathname === '/gists') return reply(200, [...gh.gists.values()].map(view));
    if (method === 'POST' && pathname === '/gists') {
      const body = JSON.parse(init.body);
      const g = { id: `g${gh.nextId++}`, version: 1, files: Object.fromEntries(Object.entries(body.files).map(([n, f]) => [n, f.content])) };
      gh.gists.set(g.id, g);
      return reply(201, view(g));
    }
    const m = pathname.match(/^\/gists\/(\w+)$/);
    const g = m && gh.gists.get(m[1]);
    if (!g) return reply(404, { message: 'Not Found' });
    if (method === 'GET') {
      const etag = `"v${g.version}"`;
      if (init.headers['If-None-Match'] === etag) return reply(304, undefined, { etag });
      return reply(200, view(g), { etag });
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      for (const [n, f] of Object.entries(body.files)) g.files[n] = f.content;
      g.version++;
      return reply(200, view(g), { etag: `"v${g.version}"` });
    }
    return reply(405, { message: 'nope' });
  };
  return gh;
}

function makePC(gh, device) {
  const clock = { t: Date.UTC(2026, 9, 5, 9, 0, 0) };
  const store = new ReminderStore(tempDir(), { device, now: () => clock.t }).load();
  const sync = new GistSync({ store, log, fetch: gh.fetch });
  return { store, sync, clock };
}

const TOKEN = 'ghp_goodtoken12345678901234';

test('connecting creates a secret gist, and a second PC finds the same one', async () => {
  const gh = fakeGitHub();
  const a = makePC(gh, 'A:1');
  a.store.create({ text: 'Buy milk', level: 'soon' });
  const result = await a.sync.connect(TOKEN);
  assert.equal(result.user, 'patbad');
  assert.equal(gh.gists.size, 1);
  assert.equal(a.sync.status.state, 'ok');

  const b = makePC(gh, 'B:2');
  const second = await b.sync.connect(TOKEN);
  assert.equal(second.gistId, result.gistId);
  assert.equal(gh.gists.size, 1);
  assert.deepEqual(b.store.all().map((r) => r.text), ['Buy milk']);
  a.sync.stop();
  b.sync.stop();
});

test('changes on each PC end up on both', async () => {
  const gh = fakeGitHub();
  const a = makePC(gh, 'A:1');
  const b = makePC(gh, 'B:2');
  await a.sync.connect(TOKEN);
  await b.sync.connect(TOKEN);

  const r1 = a.store.create({ text: 'From work', level: 'urgent' });
  const r2 = b.store.create({ text: 'From home', level: 'later' });
  await a.sync.sync();
  await b.sync.sync();
  await a.sync.sync();
  assert.equal(a.store.serialize(), b.store.serialize());
  assert.ok(a.store.get(r2.id) && b.store.get(r1.id));

  // A deletion travels too.
  b.clock.t += 1000;
  b.store.remove([r1.id]);
  await b.sync.sync();
  await a.sync.sync();
  assert.equal(a.store.get(r1.id), null);
  a.sync.stop();
  b.sync.stop();
});

test('a change lost in an upload race is uploaded again', async () => {
  const gh = fakeGitHub();
  const a = makePC(gh, 'A:1');
  const b = makePC(gh, 'B:2');
  await a.sync.connect(TOKEN);
  await b.sync.connect(TOKEN);
  const r = a.store.create({ text: 'Race', level: 'soon' });
  await a.sync.sync();
  // B overwrites the gist with a version that doesn't have A's reminder
  // (as if it had downloaded just before A uploaded).
  const [g] = gh.gists.values();
  g.files[SYNC.FILE] = b.store.serialize();
  g.version++;
  await a.sync.sync(); // A notices the gist lacks its reminder and uploads again
  await b.sync.sync();
  assert.equal(b.store.get(r.id).text, 'Race');
  a.sync.stop();
  b.sync.stop();
});

test('nothing is uploaded when nothing changed, and unchanged polls use the ETag', async () => {
  const gh = fakeGitHub();
  const a = makePC(gh, 'A:1');
  a.store.create({ text: 'x', level: 'soon' });
  await a.sync.connect(TOKEN);
  await a.sync.sync(); // fetches the new version in full after the first upload (if any)
  gh.calls.length = 0;
  await a.sync.sync();
  await a.sync.sync();
  assert.deepEqual(gh.calls, [`GET /gists/g1`, `GET /gists/g1`]);
  assert.ok(!gh.calls.some((c) => c.startsWith('PATCH')));
  a.sync.stop();
});

test('a bad token is refused with a clear message and leaves sync off', async () => {
  const gh = fakeGitHub();
  const a = makePC(gh, 'A:1');
  await assert.rejects(a.sync.connect('ghp_wrongtoken000000000000'), /didn’t accept that token/);
  assert.equal(a.sync.status.state, 'off');
});

test('a classic token without the gist scope is refused', async () => {
  const gh = fakeGitHub({ scopes: 'repo' });
  const a = makePC(gh, 'A:1');
  await assert.rejects(a.sync.connect(TOKEN), /gist/);
  assert.equal(gh.gists.size, 0);
});

test('going offline keeps local changes and reports it; they upload when back', async () => {
  const gh = fakeGitHub();
  const a = makePC(gh, 'A:1');
  await a.sync.connect(TOKEN);
  gh.offline = true;
  const r = a.store.create({ text: 'Offline edit', level: 'soon' });
  await a.sync.sync();
  assert.equal(a.sync.status.state, 'offline');
  gh.offline = false;
  await a.sync.sync();
  assert.equal(a.sync.status.state, 'ok');
  const [g] = gh.gists.values();
  assert.ok(g.files[SYNC.FILE].includes(r.id));
  a.sync.stop();
});

test('if the gist is deleted on GitHub, a new one is made', async () => {
  const gh = fakeGitHub();
  const a = makePC(gh, 'A:1');
  a.store.create({ text: 'Keep me', level: 'soon' });
  await a.sync.connect(TOKEN);
  gh.gists.clear();
  await a.sync.sync();
  assert.equal(a.sync.status.state, 'ok');
  assert.equal(gh.gists.size, 1);
  assert.ok([...gh.gists.values()][0].files[SYNC.FILE].includes('Keep me'));
  a.sync.stop();
});
