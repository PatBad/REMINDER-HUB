'use strict';

// The urgency tabs, most urgent first.
const LEVELS = [
  { id: 'urgent', label: 'Urgent', hint: 'Needs doing now' },
  { id: 'soon', label: 'Soon', hint: 'Today or tomorrow' },
  { id: 'later', label: 'Later', hint: 'In the next week or so' },
  { id: 'someday', label: 'Someday', hint: 'No rush' },
];

const LEVEL_IDS = LEVELS.map((l) => l.id);

const LIMITS = {
  TEXT: 2000,
  ID: 64,
  DEVICE: 64,
  // Timestamps outside this window are treated as corrupt.
  MIN_TS: Date.UTC(2020, 0, 1),
  MAX_TS: Date.UTC(2100, 0, 1),
};

const SYNC = {
  API: 'https://api.github.com',
  // The single file kept in the private gist.
  FILE: 'reminder-hub.json',
  DESCRIPTION: 'Reminder Hub sync data (managed by the app)',
  POLL_MS: 60 * 1000,
  // Checked more often while the panel is open.
  POLL_OPEN_MS: 15 * 1000,
  // Changes are pushed this long after the last edit, so a burst of edits is one upload.
  PUSH_DELAY_MS: 1200,
  REQUEST_TIMEOUT_MS: 20 * 1000,
  // Deleted reminders leave a small marker so the other PC deletes them too.
  // Markers older than this are dropped.
  TOMBSTONE_TTL_MS: 180 * 24 * 60 * 60 * 1000,
};

module.exports = { LEVELS, LEVEL_IDS, LIMITS, SYNC };
