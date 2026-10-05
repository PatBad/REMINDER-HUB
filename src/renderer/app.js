'use strict';

/* global hub */

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  panel: $('panel'),
  bubble: $('bubble'),
  badge: $('badge'),
  openCount: $('open-count'),
  syncPill: $('sync-pill'),
  syncText: $('sync-text'),
  toggleSearch: $('toggle-search'),
  openSettings: $('open-settings'),
  collapse: $('collapse'),
  tabs: $('tabs'),
  welcome: $('screen-welcome'),
  welcomeSync: $('welcome-sync'),
  welcomeSkip: $('welcome-skip'),
  listScreen: $('screen-list'),
  searchRow: $('search-row'),
  search: $('search'),
  banner: $('update-banner'),
  bannerText: $('update-banner-text'),
  bannerBtn: $('update-banner-btn'),
  listHint: $('list-hint'),
  clearDone: $('clear-done'),
  list: $('list'),
  compose: $('compose'),
  levelPick: $('level-pick'),
  text: $('text'),
  add: $('add'),
  dueOn: $('due-on'),
  due: $('due'),
  composeError: $('compose-error'),
  settings: $('screen-settings'),
  closeSettings: $('close-settings'),
  settingsSync: $('settings-sync'),
  optSound: $('opt-sound'),
  optAutostart: $('opt-autostart'),
  version: $('version'),
  host: $('host'),
  updateText: $('update-text'),
  updateBtn: $('update-btn'),
  openData: $('open-data'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
};

const state = {
  levels: [],
  settings: {},
  expanded: false,
  screen: 'list', // 'welcome' | 'list' | 'settings'
  tab: 'urgent', // a level id, or 'done'
  searching: false,
  search: '',
  reminders: [],
  summary: { counts: {}, done: 0, attention: 0, unseenDue: false },
  sync: { state: 'off' },
  update: { state: 'dev' },
  composeLevel: 'soon',
  adding: false,
  editing: null, // id of the reminder being edited
};

// ---------- Helpers ----------

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Static, trusted SVG markup for small icons.
const ICONS = {
  tick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>',
  pencil:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M5 3 2 6M19 3l3 3"/></svg>',
};

function icon(name, cls) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name];
  const node = t.content.firstChild;
  if (cls) node.classList.add(cls);
  return node;
}

const levelOf = (id) => state.levels.find((l) => l.id === id) || { id, label: id, hint: '' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** Whole days from today to the day containing `ts` (0 = today, 1 = tomorrow, -1 = yesterday). */
function daysFromToday(ts) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const that = new Date(ts);
  that.setHours(0, 0, 0, 0);
  return Math.round((that - today) / 86400000);
}

/** "3:00 pm", "tomorrow 9:00 am", "Mon 28 Sep, 3:00 pm". */
function whenLabel(ts) {
  const days = daysFromToday(ts);
  const time = timeFmt.format(ts);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${shortDayFmt.format(ts)}, ${time}`;
}

/** "today", "yesterday", "Mon 28 Sep". */
function dayLabel(ts) {
  const days = daysFromToday(ts);
  if (days === 0) return 'today';
  if (days === -1) return 'yesterday';
  return shortDayFmt.format(ts);
}

function dueLabel(dueAt) {
  return dueAt <= Date.now() ? `Overdue · ${whenLabel(dueAt)}` : `Due ${whenLabel(dueAt)}`;
}

/** yyyy-mm-ddThh:mm in local time, as a datetime-local input wants it. */
function toLocalInput(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** An hour from now, on the quarter hour. */
const nextHour = () => Math.ceil((Date.now() + 3600e3) / 900e3) * 900e3;

function tomorrowAt(hour) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function growTextarea(t, max = 132) {
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight + 2, max)}px`;
}

let toastTimer;
/** Shows a short notice; `action` ({label, run}) adds a button such as Undo. */
function toast(message, action = null) {
  el.toastText.textContent = message;
  el.toastAction.hidden = !action;
  el.toast.classList.toggle('has-action', Boolean(action));
  if (action) {
    el.toastAction.textContent = action.label;
    el.toastAction.onclick = () => {
      el.toast.hidden = true;
      action.run();
    };
  }
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), action ? 6000 : 2600);
}

// Errors from the main process arrive as "Error invoking remote method 'x': Error: message".
const errorText = (err) => String((err && err.message) || err).replace(/^.*?Error: /, '');

// ---------- Sound ----------

let audio;
function chime() {
  if (!state.settings.sound) return;
  try {
    audio = audio || new AudioContext();
    const notes = [784, 988, 1175, 988, 1175];
    const start = audio.currentTime + 0.03;
    notes.forEach((freq, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const t = start + i * 0.16;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    });
  } catch {
    // no audio device; ignore
  }
}

// ---------- Expand / collapse ----------

async function setExpanded(expanded) {
  if (expanded === state.expanded) return;
  el.body.classList.add('is-switching');
  try {
    await hub.setExpanded(expanded);
  } finally {
    el.body.classList.remove('is-switching');
  }
}

function applyView({ expanded, origin }) {
  const opening = expanded && !state.expanded;
  state.expanded = expanded;
  el.body.classList.toggle('is-expanded', expanded);
  el.body.classList.toggle('is-collapsed', !expanded);
  el.body.classList.remove('is-switching');
  if (origin) el.panel.style.transformOrigin = origin;
  if (opening) {
    showScreen(state.settings.welcomed ? 'list' : 'welcome');
    refresh();
    hub.markSeen();
  }
}

/**
 * Lets `handle` move the whole window. A press that doesn't move counts as a
 * tap. Returns a function that says whether a drag is in progress.
 */
function makeDraggable(handle, { canStart = () => true, onTap = () => {} } = {}) {
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !canStart(e)) return;
    drag = {
      offsetX: e.screenX - window.screenX,
      offsetY: e.screenY - window.screenY,
      startX: e.screenX,
      startY: e.screenY,
      moved: false,
    };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // pointer already released
    }
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.screenX - drag.startX, e.screenY - drag.startY) > 4) {
      drag.moved = true;
      handle.classList.add('is-dragging');
    }
    if (drag.moved) hub.dragMove(e.screenX - drag.offsetX, e.screenY - drag.offsetY);
  });
  const end = (e) => {
    if (!drag) return;
    const { moved } = drag;
    drag = null;
    handle.classList.remove('is-dragging');
    if (moved) hub.dragEnd();
    else if (e.type === 'pointerup') onTap();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  return () => drag !== null;
}

// The bubble: drag to move it, tap to open.
const bubbleDragging = makeDraggable(el.bubble, { onTap: () => setExpanded(true) });
el.bubble.addEventListener('click', (e) => {
  if (e.detail === 0) setExpanded(true); // Enter/Space when it has keyboard focus
});

// Clicks pass through the empty space around the bubble to the apps below;
// catch them again while the mouse is over the bubble itself.
el.bubble.addEventListener('pointerenter', () => hub.setClickThrough(false));
el.bubble.addEventListener('pointerleave', () => {
  if (!bubbleDragging()) hub.setClickThrough(true);
});

// The open panel: drag it by its top bar (but not by the buttons there).
makeDraggable(document.querySelector('.topbar'), { canStart: (e) => !e.target.closest('button') });

el.collapse.addEventListener('click', () => setExpanded(false));

// ---------- Badge, header and tabs ----------

function renderBadge() {
  const { attention, unseenDue } = state.summary;
  el.badge.hidden = attention === 0;
  el.badge.textContent = attention > 99 ? '99+' : String(attention);
  el.bubble.classList.toggle('has-due', unseenDue);
  const label = attention ? `Reminder Hub – ${plural(attention, 'reminder')} need${attention === 1 ? 's' : ''} attention` : 'Reminder Hub';
  el.bubble.title = label;
  el.bubble.setAttribute('aria-label', `Open ${label}`);
}

function bump() {
  el.bubble.classList.remove('bump');
  void el.bubble.offsetWidth; // restart the animation
  el.bubble.classList.add('bump');
}

function renderHeader() {
  const open = Object.values(state.summary.counts).reduce((n, c) => n + c.open, 0);
  el.openCount.textContent = `${open} open`;
  const s = state.sync;
  const text = { off: 'Not syncing', idle: 'Syncing…', syncing: 'Syncing…', ok: 'Synced', offline: 'Offline', error: 'Sync problem' }[s.state];
  el.syncText.textContent = text;
  el.syncPill.className = `sync-pill is-${s.state === 'idle' ? 'syncing' : s.state}`;
  el.syncPill.title =
    s.state === 'ok' && s.lastSyncAt
      ? `Synced with GitHub${s.user ? ` as ${s.user}` : ''} at ${timeFmt.format(s.lastSyncAt)}`
      : s.state === 'off'
        ? 'Reminders are only on this PC. Set up syncing in Settings.'
        : s.error || text;
  const inApp = state.screen !== 'welcome';
  el.collapse.hidden = !inApp;
  el.openSettings.hidden = !inApp;
  el.toggleSearch.hidden = state.screen !== 'list';
  el.toggleSearch.setAttribute('aria-pressed', String(state.searching));
}

function renderTabs() {
  const { counts, done } = state.summary;
  const tabs = state.levels.map((l) => {
    const c = counts[l.id] || { open: 0, overdue: 0 };
    return h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: ['tab', `lv-${l.id}`],
        'data-tab': l.id,
        'aria-selected': String(!state.searching && state.tab === l.id),
        title: c.overdue ? `${l.hint} · ${c.open} open, ${c.overdue} overdue` : `${l.hint} · ${c.open} open`,
      },
      l.label,
      c.open ? h('span', { class: ['tab-count', c.overdue && 'is-overdue'] }, String(c.open)) : null,
    );
  });
  tabs.push(
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: ['tab', 'lv-done'],
        'data-tab': 'done',
        'aria-selected': String(!state.searching && state.tab === 'done'),
        title: `${done} done`,
      },
      icon('tick', 'tab-done-icon'),
      'Done',
    ),
  );
  el.tabs.replaceChildren(...tabs);
}

el.tabs.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-tab]');
  if (button) selectTab(button.dataset.tab);
});

function selectTab(tab) {
  if (state.searching) closeSearch();
  state.tab = tab;
  state.editing = null;
  try {
    localStorage.setItem('tab', tab);
  } catch {
    // storage unavailable; not important
  }
  if (tab !== 'done') setComposeLevel(tab);
  renderTabs();
  renderList({ toTop: true });
}

// ---------- Screens ----------

function showScreen(name) {
  state.screen = name;
  el.welcome.hidden = name !== 'welcome';
  el.listScreen.hidden = name !== 'list';
  el.settings.hidden = name !== 'settings';
  el.tabs.hidden = name !== 'list';
  if (name === 'settings') renderSettings();
  if (name === 'welcome') renderSyncSetup();
  if (name === 'list') {
    renderTabs();
    renderList();
    if (!state.editing) el.text.focus();
  }
  renderHeader();
}

// ---------- The list ----------

async function refresh() {
  state.reminders = await hub.list();
  if (state.screen === 'list') renderList();
}

const isOverdue = (r) => !r.doneAt && r.dueAt !== null && r.dueAt <= Date.now();

/** Dated reminders first (soonest or most overdue at the top), then the rest, newest first. */
function byUrgency(a, b) {
  if ((a.dueAt === null) !== (b.dueAt === null)) return a.dueAt === null ? 1 : -1;
  if (a.dueAt !== null && a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
  return b.createdAt - a.createdAt;
}

function visibleReminders() {
  if (state.searching && state.search) {
    const q = state.search.toLowerCase();
    const order = Object.fromEntries(state.levels.map((l, i) => [l.id, i]));
    return state.reminders
      .filter((r) => r.text.toLowerCase().includes(q))
      .sort((a, b) => Boolean(a.doneAt) - Boolean(b.doneAt) || order[a.level] - order[b.level] || byUrgency(a, b));
  }
  if (state.tab === 'done') return state.reminders.filter((r) => r.doneAt).sort((a, b) => b.doneAt - a.doneAt);
  return state.reminders.filter((r) => !r.doneAt && r.level === state.tab).sort(byUrgency);
}

function renderListHead(items) {
  el.clearDone.hidden = state.searching || state.tab !== 'done' || !items.length;
  if (state.searching) {
    el.listHint.textContent = state.search ? `${plural(items.length, 'match')} across all tabs` : 'Type to search every tab, including Done';
    return;
  }
  if (state.tab === 'done') {
    el.listHint.textContent = items.length ? `${items.length} done · newest first` : '';
    return;
  }
  const level = levelOf(state.tab);
  const c = state.summary.counts[state.tab] || { open: 0, overdue: 0 };
  el.listHint.textContent = `${level.hint}${c.open ? ` · ${c.open} open` : ''}${c.overdue ? `, ${c.overdue} overdue` : ''}`;
}

function renderList({ toTop = false } = {}) {
  const list = el.list;
  const top = list.scrollTop;
  const items = visibleReminders();
  renderListHead(items);
  // Don't throw away a half-finished edit when something else changes.
  const editing = state.editing && list.querySelector(`.rem[data-id="${CSS.escape(state.editing)}"]`);
  const nodes = items.map((r) => (editing && r.id === state.editing ? editing : reminderNode(r)));
  list.replaceChildren(...(nodes.length ? nodes : [emptyNode()]));
  list.scrollTop = toTop ? 0 : top;
}

function emptyNode() {
  if (state.searching) {
    return state.search
      ? h('div', { class: 'empty' }, h('strong', null, 'No matches'), `Nothing found for “${state.search}”.`)
      : h('div', { class: 'empty' }, h('strong', null, 'Search reminders'), 'Matches from every tab appear here.');
  }
  if (state.tab === 'done') {
    return h('div', { class: 'empty' }, h('strong', null, 'Nothing done yet'), 'Tick a reminder’s circle when it’s done and it moves here.');
  }
  const level = levelOf(state.tab);
  return h(
    'div',
    { class: 'empty' },
    h('strong', null, `Nothing ${level.label === 'Someday' ? 'for someday' : `marked ${level.label}`}`),
    'Add one below. You can move a reminder to another tab any time by pointing at it and clicking a coloured dot.',
  );
}

function reminderNode(r) {
  const done = Boolean(r.doneAt);
  const overdue = isOverdue(r);
  const soonDue = !done && !overdue && r.dueAt !== null && r.dueAt - Date.now() < 3600e3;
  const showLevel = state.searching || done;

  const meta = [];
  if (!done && r.dueAt !== null) meta.push(h('span', { class: 'rem-due', title: fullFmt.format(r.dueAt) }, dueLabel(r.dueAt)));
  if (showLevel) meta.push(h('span', { class: 'rem-level-tag' }, levelOf(r.level).label));
  meta.push(
    done
      ? h('span', { title: fullFmt.format(r.doneAt) }, `Done ${whenLabel(r.doneAt)}`)
      : h('span', { title: `Added ${fullFmt.format(r.createdAt)}` }, `Added ${dayLabel(r.createdAt)}`),
  );

  return h(
    'article',
    {
      class: ['rem', `lv-${r.level}`, overdue && 'is-overdue', soonDue && 'is-soon-due', done && 'is-done'],
      'data-id': r.id,
    },
    h(
      'div',
      { class: 'rem-row' },
      h(
        'button',
        {
          type: 'button',
          class: 'rem-check',
          title: done ? 'Mark as not done' : 'Mark as done',
          'aria-label': done ? 'Mark as not done' : 'Mark as done',
          onclick: () => setDone(r, !done),
        },
        icon('tick'),
      ),
      h(
        'div',
        { class: 'rem-body' },
        h('p', { class: 'rem-text', title: done ? null : 'Double-click to edit', ondblclick: () => !done && startEdit(r) }, r.text),
        h('div', { class: 'rem-meta' }, ...meta),
        overdue
          ? h(
              'div',
              { class: 'rem-snooze' },
              h('button', { type: 'button', class: 'chip', onclick: () => snooze(r, nextHour()) }, 'Snooze 1 hour'),
              h('button', { type: 'button', class: 'chip', onclick: () => snooze(r, tomorrowAt(9)) }, 'Tomorrow 9 am'),
              h('button', { type: 'button', class: 'chip is-quiet', onclick: () => snooze(r, null) }, 'Clear due time'),
            )
          : null,
      ),
    ),
    actionsNode(r, done),
  );
}

/** The floating bar shown while pointing at a reminder: move to another tab, edit, delete. */
function actionsNode(r, done) {
  const moves = done
    ? []
    : state.levels.map((l) =>
        h(
          'button',
          {
            type: 'button',
            class: ['act', 'act-move', `lv-${l.id}`],
            title: l.id === r.level ? `In ${l.label}` : `Move to ${l.label}`,
            'aria-label': l.id === r.level ? `In ${l.label}` : `Move to ${l.label}`,
            'aria-current': String(l.id === r.level),
            onclick: () => moveTo(r, l.id),
          },
          h('span'),
        ),
      );
  return h(
    'div',
    { class: 'rem-actions', role: 'toolbar', 'aria-label': 'Reminder actions' },
    ...moves,
    moves.length ? h('span', { class: 'act-sep' }) : null,
    done ? null : h('button', { type: 'button', class: 'act', title: 'Edit', 'aria-label': 'Edit', onclick: () => startEdit(r) }, icon('pencil')),
    h('button', { type: 'button', class: ['act', 'is-delete'], title: 'Delete', 'aria-label': 'Delete', onclick: () => remove(r) }, icon('trash')),
  );
}

// ---------- Changing reminders ----------

async function change(r, changes, message, undoChanges) {
  try {
    await hub.update(r.id, changes);
    // The list refreshes itself when the main process reports the change.
    if (message) {
      toast(message, undoChanges && { label: 'Undo', run: () => hub.update(r.id, undoChanges).catch(() => toast('Couldn’t undo that')) });
    }
  } catch {
    toast('Couldn’t update that reminder');
  }
}

function setDone(r, done) {
  change(r, { done }, done ? 'Marked as done' : `Back in ${levelOf(r.level).label}`, { done: !done });
}

function moveTo(r, level) {
  if (level === r.level) return;
  change(r, { level }, `Moved to ${levelOf(level).label}`, { level: r.level });
}

function snooze(r, dueAt) {
  change(r, { dueAt }, dueAt === null ? 'Due time cleared' : `Snoozed until ${whenLabel(dueAt)}`, { dueAt: r.dueAt });
}

async function remove(r) {
  try {
    const removed = await hub.remove([r.id]);
    toast('Reminder deleted', { label: 'Undo', run: () => hub.restore(removed).catch(() => toast('Couldn’t undo that')) });
  } catch {
    toast('Couldn’t delete that reminder');
  }
}

el.clearDone.addEventListener('click', async () => {
  try {
    const removed = await hub.clearDone();
    if (removed.length) {
      toast(`${plural(removed.length, 'reminder')} cleared`, {
        label: 'Undo',
        run: () => hub.restore(removed).catch(() => toast('Couldn’t undo that')),
      });
    }
  } catch {
    toast('Couldn’t clear the done list');
  }
});

// --- editing in place ---

function startEdit(r) {
  const article = el.list.querySelector(`.rem[data-id="${CSS.escape(r.id)}"]`);
  if (!article) return;
  if (state.editing && state.editing !== r.id) cancelEdit();
  state.editing = r.id;
  article.classList.add('is-editing');

  const text = h('textarea', { rows: '1', maxlength: '2000', 'aria-label': 'Reminder text' });
  text.value = r.text;
  const dueOn = h('input', { type: 'checkbox' });
  dueOn.checked = r.dueAt !== null;
  const due = h('input', { type: 'datetime-local', class: 'due-input', 'aria-label': 'Due date and time' });
  due.value = r.dueAt !== null ? toLocalInput(r.dueAt) : '';
  due.hidden = !dueOn.checked;
  dueOn.addEventListener('change', () => {
    due.hidden = !dueOn.checked;
    if (dueOn.checked && !due.value) due.value = toLocalInput(nextHour());
  });

  const save = async () => {
    const value = text.value.trim();
    if (!value) return text.focus();
    let dueAt = null;
    if (dueOn.checked) {
      dueAt = due.value ? new Date(due.value).getTime() : NaN;
      if (!Number.isFinite(dueAt)) return due.focus();
    }
    state.editing = null;
    try {
      await hub.update(r.id, { text: value, dueAt });
    } catch {
      toast('Couldn’t save that change');
    }
    renderList();
  };

  text.addEventListener('input', () => growTextarea(text, 160));
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  });

  const body = article.querySelector('.rem-body');
  body.replaceChildren(
    h(
      'div',
      { class: 'rem-edit' },
      text,
      h(
        'div',
        { class: 'rem-edit-row' },
        h('label', { class: 'due-toggle' }, dueOn, icon('clock'), 'Due'),
        due,
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'chip is-quiet', onclick: cancelEdit }, 'Cancel'),
        h('button', { type: 'button', class: 'chip is-primary', onclick: save }, 'Save'),
      ),
    ),
  );
  growTextarea(text, 160);
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}

function cancelEdit() {
  state.editing = null;
  renderList();
}

// ---------- Search ----------

function openSearch() {
  if (state.screen !== 'list') showScreen('list');
  state.searching = true;
  el.searchRow.hidden = false;
  el.search.focus();
  el.search.select();
  renderHeader();
  renderTabs();
  renderList({ toTop: true });
}

function closeSearch() {
  state.searching = false;
  state.search = '';
  el.search.value = '';
  el.searchRow.hidden = true;
  renderHeader();
  renderTabs();
  renderList({ toTop: true });
}

el.toggleSearch.addEventListener('click', () => (state.searching ? closeSearch() : openSearch()));

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = el.search.value.trim();
    renderList({ toTop: true });
  }, 120);
});

// ---------- Adding a reminder ----------

function renderLevelPick() {
  el.levelPick.replaceChildren(
    ...state.levels.map((l) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          class: ['level-opt', `lv-${l.id}`],
          'data-level': l.id,
          'aria-checked': String(state.composeLevel === l.id),
          title: l.hint,
        },
        l.label,
      ),
    ),
  );
}

function setComposeLevel(level) {
  state.composeLevel = level;
  for (const b of el.levelPick.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.level === level));
}

el.levelPick.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-level]');
  if (button) {
    setComposeLevel(button.dataset.level);
    el.text.focus();
  }
});

function updateAddState() {
  el.add.disabled = state.adding || !el.text.value.trim();
}

el.text.addEventListener('input', () => {
  growTextarea(el.text);
  updateAddState();
  el.composeError.hidden = true;
});
el.text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    el.compose.requestSubmit();
  }
});
el.dueOn.addEventListener('change', () => {
  el.due.hidden = !el.dueOn.checked;
  if (el.dueOn.checked) {
    if (!el.due.value) el.due.value = toLocalInput(nextHour());
    el.due.focus();
  }
});

el.compose.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = el.text.value.trim();
  if (!text || state.adding) return;
  let dueAt = null;
  if (el.dueOn.checked) {
    dueAt = el.due.value ? new Date(el.due.value).getTime() : NaN; // datetime-local values are local time
    if (!Number.isFinite(dueAt)) {
      el.composeError.textContent = 'Pick a due date and time, or untick Due.';
      el.composeError.hidden = false;
      return;
    }
  }
  state.adding = true;
  updateAddState();
  try {
    const level = state.composeLevel;
    await hub.add({ text, level, dueAt });
    el.text.value = '';
    el.dueOn.checked = false;
    el.due.hidden = true;
    el.due.value = '';
    growTextarea(el.text);
    // Let them know where it went if the current view won't show it.
    if (state.searching || state.tab !== level) toast(`Added to ${levelOf(level).label}`, { label: 'Show', run: () => selectTab(level) });
  } catch {
    el.composeError.textContent = 'Reminder not added. Please try again.';
    el.composeError.hidden = false;
  } finally {
    state.adding = false;
    updateAddState();
    el.text.focus();
  }
});

// Keep "due" labels and overdue highlighting current while the list is open.
setInterval(() => {
  if (state.expanded && state.screen === 'list') renderList();
}, 30000);

// ---------- Sync setup (welcome screen and settings) ----------

/**
 * Each place showing sync setup gets a status box, a token form and some
 * links. They're built once and then just updated, so a half-typed token
 * survives the frequent status changes.
 */
const syncViews = new Map();

function syncView(container) {
  if (syncViews.has(container)) return syncViews.get(container);
  const v = {};
  v.status = h('div', { class: 'sync-state' });
  v.steps = h(
    'ol',
    { class: 'sync-steps' },
    h(
      'li',
      null,
      h('button', { type: 'button', class: 'link-btn', onclick: () => hub.openLink('token') }, 'Open GitHub’s new-token page'),
      ' (sign in if asked).',
    ),
    h('li', null, 'Keep the ', h('strong', null, 'gist'), ' box ticked, pick an ', h('strong', null, 'Expiration'), ' (No expiration is simplest), then click ', h('strong', null, 'Generate token'), '.'),
    h('li', null, 'Copy the token and paste it below. On your other PC, paste the same token (or make another the same way).'),
  );
  v.input = h('input', {
    type: 'password',
    class: 'token-input',
    placeholder: 'ghp_… or github_pat_…',
    'aria-label': 'GitHub token',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  v.connect = h('button', { type: 'submit', class: 'btn' }, 'Connect');
  v.error = h('p', { class: 'sync-error', role: 'alert', hidden: true });
  v.form = h('form', { class: 'sync-form', autocomplete: 'off' }, v.steps, h('div', { class: 'token-row' }, v.input, v.connect), v.error);
  v.form.addEventListener('submit', (e) => {
    e.preventDefault();
    connectSync(v);
  });
  v.links = h(
    'div',
    { class: 'sync-links' },
    h('button', { type: 'button', class: 'link-btn', onclick: () => hub.syncNow() }, 'Sync now'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => hub.openLink('gist') }, 'View the data on GitHub'),
    h(
      'button',
      {
        type: 'button',
        class: ['link-btn', 'is-danger'],
        onclick: async () => {
          await hub.syncDisconnect();
          toast('Sync turned off on this PC');
        },
      },
      'Turn off sync',
    ),
  );
  container.replaceChildren(v.status, v.form, v.links);
  syncViews.set(container, v);
  return v;
}

async function connectSync(v) {
  const token = v.input.value.trim();
  if (!token) return v.input.focus();
  v.connect.disabled = true;
  v.connect.textContent = 'Connecting…';
  v.error.hidden = true;
  try {
    const result = await hub.syncConnect(token);
    if (!result.ok) {
      v.error.textContent = result.error;
      v.error.hidden = false;
      return;
    }
    v.input.value = '';
    state.settings.welcomed = true;
    toast(`Syncing with GitHub as ${state.sync.user || 'you'}`);
    if (state.screen === 'welcome') showScreen('list');
  } finally {
    v.connect.disabled = false;
    v.connect.textContent = 'Connect';
  }
}

function renderSyncSetup() {
  const containers = state.screen === 'welcome' ? [el.welcomeSync] : state.screen === 'settings' ? [el.settingsSync] : [];
  const s = state.sync;
  for (const container of containers) {
    const v = syncView(container);
    const on = s.state !== 'off';
    v.status.hidden = !on;
    v.links.hidden = !on;
    // The token form: to connect, or to replace a token GitHub stopped accepting.
    v.form.hidden = on && s.state !== 'error';
    v.steps.hidden = on;
    v.input.placeholder = on ? 'Paste a new token' : 'ghp_… or github_pat_…';
    if (!on) continue;
    const headline = {
      idle: 'Sync on',
      syncing: 'Syncing…',
      ok: `Synced${s.user ? ` as ${s.user}` : ''}`,
      offline: 'Offline',
      error: 'Sync problem',
    }[s.state];
    const detail =
      s.state === 'ok'
        ? `Last synced at ${timeFmt.format(s.lastSyncAt)}. Changes reach your other PC within a minute or so.`
        : s.state === 'syncing' || s.state === 'idle'
          ? 'Checking GitHub for changes from your other PC.'
          : s.error;
    v.status.className = `sync-state is-${s.state === 'idle' ? 'syncing' : s.state}`;
    v.status.replaceChildren(h('span', { class: 'sync-dot' }), h('span', null, h('strong', null, headline), h('small', null, detail)));
  }
}

el.welcomeSkip.addEventListener('click', async () => {
  state.settings = await hub.setSettings({ welcomed: true });
  showScreen('list');
});

// ---------- Settings ----------

function renderSettings() {
  el.optSound.checked = !!state.settings.sound;
  el.optAutostart.checked = !!state.settings.autoStart;
  renderSyncSetup();
  renderUpdate();
}

function renderUpdate() {
  const u = state.update;
  const text = {
    dev: 'Automatic updates are off in development mode.',
    idle: 'Updates are checked automatically.',
    checking: 'Checking for updates…',
    current: 'You have the latest version.',
    downloading: `Downloading version ${u.version}…`,
    ready: `Version ${u.version} is ready to install.`,
    error: 'Couldn’t check for updates.',
  }[u.state] || '';
  el.updateText.textContent = text;
  const button = { idle: 'Check now', current: 'Check again', error: 'Try again', ready: 'Restart now' }[u.state];
  el.updateBtn.hidden = !button;
  el.updateBtn.textContent = button || '';

  el.banner.hidden = u.state !== 'ready';
  el.bannerText.textContent = `Update ${u.version} is ready — it installs when you minimise.`;
}

el.updateBtn.addEventListener('click', () => hub.updateAction(state.update.state === 'ready' ? 'install' : 'check'));
el.bannerBtn.addEventListener('click', () => hub.updateAction('install'));
el.openData.addEventListener('click', () => hub.openDataFolder());
el.openSettings.addEventListener('click', () => (state.screen === 'settings' ? showScreen('list') : showScreen('settings')));
el.closeSettings.addEventListener('click', () => showScreen('list'));
el.optSound.addEventListener('change', async () => {
  state.settings = await hub.setSettings({ sound: el.optSound.checked });
  if (state.settings.sound) chime();
});
el.optAutostart.addEventListener('change', async () => {
  state.settings = await hub.setSettings({ autoStart: el.optAutostart.checked });
});

// ---------- Keyboard ----------

document.addEventListener('keydown', (e) => {
  if (!state.expanded) return;
  if (e.key === 'Escape') {
    if (state.editing) cancelEdit();
    else if (state.searching) closeSearch();
    else if (state.screen === 'settings') showScreen('list');
    else if (state.screen === 'list') setExpanded(false);
    e.preventDefault();
  } else if (e.key === 'f' && e.ctrlKey && state.screen !== 'welcome') {
    openSearch();
    e.preventDefault();
  } else if (e.ctrlKey && /^[1-5]$/.test(e.key) && state.screen === 'list') {
    // Ctrl+1 … Ctrl+5: the tabs, left to right.
    const tabs = [...state.levels.map((l) => l.id), 'done'];
    selectTab(tabs[Number(e.key) - 1]);
    e.preventDefault();
  }
});

// ---------- Live updates from the main process ----------

hub.onView(applyView);

// Something changed (here, on the other PC via sync, or a reminder fell due).
hub.onRemindersChanged(({ alert }) => {
  if (alert === 'due') {
    chime();
    if (!state.expanded) bump();
    else hub.markSeen();
  }
  refresh();
});

hub.onSummary((summary) => {
  state.summary = summary;
  renderBadge();
  renderHeader();
  if (state.screen === 'list') {
    renderTabs();
    renderListHead(visibleReminders());
  }
});

hub.onSync((status) => {
  state.sync = status;
  renderHeader();
  renderSyncSetup();
});

hub.onUpdate((update) => {
  state.update = update;
  renderUpdate();
});

hub.onOpen((screen) => {
  if (screen === 'settings' && state.settings.welcomed) showScreen('settings');
});

// ---------- Start ----------

async function init() {
  const s = await hub.getState();
  Object.assign(state, {
    levels: s.levels,
    settings: s.settings,
    summary: s.summary,
    sync: s.sync,
    update: s.update,
  });
  let tab = null;
  try {
    tab = localStorage.getItem('tab');
  } catch {
    // storage unavailable
  }
  state.tab = tab === 'done' || s.levels.some((l) => l.id === tab) ? tab : s.levels[0].id;
  state.composeLevel = state.tab !== 'done' ? state.tab : s.settings.lastLevel || 'soon';
  el.version.textContent = s.version;
  el.host.textContent = s.host;
  renderLevelPick();
  renderBadge();
  renderUpdate();
  state.reminders = await hub.list();
  showScreen(s.settings.welcomed ? 'list' : 'welcome');
  applyView({ expanded: s.expanded });
}

init();
