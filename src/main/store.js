'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { LEVEL_IDS, LIMITS, SYNC } = require('./constants');

const FORMAT = { app: 'reminder-hub', version: 1 };

const isTs = (v) => Number.isFinite(v) && v >= LIMITS.MIN_TS && v <= LIMITS.MAX_TS;
const isTsOrNull = (v) => v === null || isTs(v);
const isId = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Checks a reminder (from disk, the page or the other PC) and returns a clean
 * copy with fields in a fixed order, or null if it's invalid.
 *
 * A deleted reminder is a "tombstone": just its id, deletedAt, updatedAt and
 * device, so the deletion reaches the other PC.
 */
function clean(r) {
  if (!r || typeof r !== 'object') return null;
  if (!isId(r.id, LIMITS.ID) || !isId(r.device, LIMITS.DEVICE) || !isTs(r.updatedAt)) return null;
  if (r.deletedAt != null) {
    if (!isTs(r.deletedAt)) return null;
    return { id: r.id, deletedAt: r.deletedAt, updatedAt: r.updatedAt, device: r.device };
  }
  const text = typeof r.text === 'string' ? r.text.trim().slice(0, LIMITS.TEXT) : '';
  const dueAt = r.dueAt ?? null;
  const doneAt = r.doneAt ?? null;
  if (!text || !LEVEL_IDS.includes(r.level) || !isTs(r.createdAt) || !isTsOrNull(dueAt) || !isTsOrNull(doneAt)) {
    return null;
  }
  return {
    id: r.id,
    text,
    level: r.level,
    dueAt,
    doneAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    device: r.device,
  };
}

/** Whether `a` should replace `b`: the later edit wins (ties broken by device so both PCs agree). */
function isNewer(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.device > b.device;
}

/** The text form saved to disk and to the gist. Same items always give the same text. */
function serialize(items) {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return `${JSON.stringify({ ...FORMAT, items: sorted }, null, 1)}\n`;
}

/** Reads the items out of a saved file or gist, skipping anything invalid. */
function parse(text) {
  const data = JSON.parse(text);
  if (!data || data.app !== FORMAT.app || !Array.isArray(data.items)) throw new Error('Not Reminder Hub data');
  return data.items;
}

/**
 * All reminders, kept in one JSON file. Every change stamps updatedAt and
 * this PC's device id, which is what lets two PCs merge their copies.
 * Emits 'changed' with { source: 'local' | 'sync' }.
 */
class ReminderStore extends EventEmitter {
  constructor(dir, { device, now = Date.now } = {}) {
    super();
    this.file = path.join(dir, 'reminders.json');
    this.device = device;
    this.now = now;
    this.items = new Map();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return this; // first run
    }
    try {
      this._mergeItems(parse(raw));
    } catch (err) {
      // Keep the unreadable file for recovery, then start fresh.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.file, backup);
      } catch {
        // nothing more we can do
      }
      this.loadError = `${err.message} (copied to ${path.basename(backup)})`;
    }
    return this;
  }

  /** Every item, including deletion markers that haven't expired. */
  snapshot() {
    const cutoff = this.now() - SYNC.TOMBSTONE_TTL_MS;
    return [...this.items.values()].filter((r) => !r.deletedAt || r.deletedAt > cutoff);
  }

  serialize() {
    return serialize(this.snapshot());
  }

  /** Reminders that haven't been deleted. */
  all() {
    return [...this.items.values()].filter((r) => !r.deletedAt);
  }

  get(id) {
    const r = this.items.get(id);
    return r && !r.deletedAt ? r : null;
  }

  create({ text, level, dueAt = null }) {
    const now = this.now();
    return this._put({ id: crypto.randomUUID(), text, level, dueAt, doneAt: null, createdAt: now }, null);
  }

  /** Changes text, level, dueAt or done (true/false). */
  update(id, changes = {}) {
    const current = this.get(id);
    if (!current) throw new Error('Reminder not found');
    const next = { ...current };
    if ('text' in changes) next.text = changes.text;
    if ('level' in changes) next.level = changes.level;
    if ('dueAt' in changes) next.dueAt = changes.dueAt;
    if ('done' in changes) next.doneAt = changes.done ? current.doneAt || this.now() : null;
    return this._put(next, current);
  }

  remove(ids) {
    const removed = [];
    for (const id of ids) {
      const current = this.get(id);
      if (!current) continue;
      removed.push(current);
      this._put({ id, deletedAt: this.now() }, current, { quiet: true });
    }
    if (removed.length) this._changed('local');
    return removed;
  }

  /** Puts back reminders returned by remove() (for Undo). */
  restore(records) {
    let n = 0;
    for (const r of records) {
      const current = this.items.get(r && r.id);
      if (!current || !current.deletedAt) continue;
      if (this._put({ ...r }, current, { quiet: true })) n++;
    }
    if (n) this._changed('local');
    return n;
  }

  /**
   * Takes in items from the other PC. Returns true if anything here changed.
   * Invalid and expired items are ignored.
   */
  merge(items) {
    const changed = this._mergeItems(items);
    if (changed) this._changed('sync');
    return changed;
  }

  _mergeItems(items) {
    const cutoff = this.now() - SYNC.TOMBSTONE_TTL_MS;
    let changed = false;
    for (const item of items) {
      const r = clean(item);
      if (!r || (r.deletedAt && r.deletedAt <= cutoff)) continue;
      const current = this.items.get(r.id);
      if (current && !isNewer(r, current)) continue;
      this.items.set(r.id, r);
      changed = true;
    }
    return changed;
  }

  /** Stamps and validates a local edit, saves, and returns the new record (null if invalid). */
  _put(fields, previous, { quiet = false } = {}) {
    // Always move forward, even if this PC's clock is behind the edit it's replacing.
    const updatedAt = Math.max(this.now(), previous ? previous.updatedAt + 1 : 0);
    const r = clean({ ...fields, updatedAt, device: this.device });
    if (!r) {
      if (quiet) return null;
      throw new Error('Reminder was empty or invalid');
    }
    this.items.set(r.id, r);
    if (!quiet) this._changed('local');
    return r;
  }

  _changed(source) {
    this.save();
    this.emit('changed', { source });
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.serialize());
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { ReminderStore, clean, isNewer, serialize, parse };
