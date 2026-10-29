'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  sound: true,
  autoStart: true,
  iconPosition: null, // where the bell floats when it isn't docked
  dock: null, // { side, edge, y } while the bell is docked to a screen edge; false once pulled out; null means not chosen yet
  // Set once the welcome / sync setup screen has been dealt with.
  welcomed: false,
  // The urgency last used for a new reminder.
  lastLevel: 'soon',
  // Reminders that fell due before this have been seen (the panel was open).
  seenAt: 0,
  deviceId: null,
  deviceHost: null,
  // GitHub sync: the token (encrypted) and the gist it found or created.
  syncToken: null,
  gistId: null,
  gistUrl: null,
  githubUser: null,
};

/** Small JSON settings file for this PC. */
class Config {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.data = { ...DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // first run, or unreadable file: start from defaults
    }
  }

  get(key) {
    return this.data[key];
  }

  set(values) {
    Object.assign(this.data, values);
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Config };
