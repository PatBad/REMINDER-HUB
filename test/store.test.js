'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReminderStore, serialize, parse } = require('../src/main/store');
const { SYNC } = require('../src/main/constants');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rh-test-'));

/** A store with its own controllable clock. */
function makeStore(device = 'PC-A:1', dir = tempDir()) {
  const clock = { t: Date.UTC(2026, 9, 5, 9, 0, 0) };
  const store = new ReminderStore(dir, { device, now: () => clock.t }).load();
  return { store, clock, dir };
}

test('creates, edits and saves reminders to disk', () => {
  const { store, clock, dir } = makeStore();
  const r = store.create({ text: '  Ring the vet  ', level: 'urgent' });
  assert.equal(r.text, 'Ring the vet');
  assert.equal(r.level, 'urgent');
  assert.equal(r.dueAt, null);
  clock.t += 1000;
  const due = clock.t + 3600e3;
  store.update(r.id, { level: 'soon', dueAt: due });
  store.update(r.id, { done: true });

  const reloaded = new ReminderStore(dir, { device: 'PC-A:1' }).load();
  const back = reloaded.get(r.id);
  assert.equal(back.level, 'soon');
  assert.equal(back.dueAt, due);
  assert.ok(back.doneAt);
});

test('rejects empty text and unknown levels', () => {
  const { store } = makeStore();
  assert.throws(() => store.create({ text: '   ', level: 'urgent' }));
  assert.throws(() => store.create({ text: 'x', level: 'whenever' }));
  assert.equal(store.all().length, 0);
});

test('delete leaves a marker without the text, and undo brings it back', () => {
  const { store, clock } = makeStore();
  const r = store.create({ text: 'Secret', level: 'later' });
  clock.t += 1000;
  const removed = store.remove([r.id]);
  assert.equal(store.get(r.id), null);
  assert.equal(store.all().length, 0);
  assert.ok(!store.serialize().includes('Secret'));
  clock.t += 1000;
  assert.equal(store.restore(removed), 1);
  assert.equal(store.get(r.id).text, 'Secret');
});

test('merging takes the later edit of each reminder', () => {
  const a = makeStore('PC-A:1');
  const b = makeStore('PC-B:2');
  const r = a.store.create({ text: 'Original', level: 'soon' });
  b.store.merge(parse(a.store.serialize()));
  assert.equal(b.store.get(r.id).text, 'Original');

  // B edits later than A.
  a.clock.t += 1000;
  a.store.update(r.id, { text: 'Edited on A' });
  b.clock.t += 5000;
  b.store.update(r.id, { text: 'Edited on B' });

  a.store.merge(parse(b.store.serialize()));
  b.store.merge(parse(a.store.serialize()));
  assert.equal(a.store.get(r.id).text, 'Edited on B');
  assert.equal(a.store.serialize(), b.store.serialize());
});

test('a deletion on one PC reaches the other', () => {
  const a = makeStore('PC-A:1');
  const b = makeStore('PC-B:2');
  const r = a.store.create({ text: 'Delete me', level: 'urgent' });
  b.store.merge(parse(a.store.serialize()));
  b.clock.t += 1000;
  b.store.remove([r.id]);
  a.store.merge(parse(b.store.serialize()));
  assert.equal(a.store.get(r.id), null);
  assert.equal(a.store.serialize(), b.store.serialize());
});

test('an edit always replaces the version it was made from, even with a slow clock', () => {
  const a = makeStore('PC-A:1');
  const b = makeStore('PC-B:2');
  const r = a.store.create({ text: 'v1', level: 'soon' });
  b.store.merge(parse(a.store.serialize()));
  b.clock.t -= 60000; // B's clock is a minute behind
  b.store.update(r.id, { text: 'v2' });
  a.store.merge(parse(b.store.serialize()));
  assert.equal(a.store.get(r.id).text, 'v2');
});

test('merge ignores invalid items and expired deletion markers', () => {
  const { store, clock } = makeStore();
  const changed = store.merge([
    { id: 'x', text: '', level: 'soon', createdAt: clock.t, updatedAt: clock.t, device: 'B' },
    { id: 'y', text: 'ok', level: 'nope', createdAt: clock.t, updatedAt: clock.t, device: 'B' },
    { id: 'z', deletedAt: clock.t - SYNC.TOMBSTONE_TTL_MS - 1, updatedAt: clock.t - SYNC.TOMBSTONE_TTL_MS - 1, device: 'B' },
    null,
    'junk',
  ]);
  assert.equal(changed, false);
  assert.equal(store.snapshot().length, 0);
});

test('serialize is the same regardless of order', () => {
  const t = Date.UTC(2026, 0, 1);
  const one = { id: 'a', text: 'A', level: 'soon', dueAt: null, doneAt: null, createdAt: t, updatedAt: t, device: 'X' };
  const two = { ...one, id: 'b', text: 'B' };
  assert.equal(serialize([one, two]), serialize([two, one]));
});

test('an unreadable file is kept aside and the app starts empty', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'reminders.json'), '{not json');
  const store = new ReminderStore(dir, { device: 'PC-A:1' }).load();
  assert.ok(store.loadError);
  assert.equal(store.all().length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('reminders.json.corrupt-')));
});
