'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

// The only bridge between the page and the rest of the app.
contextBridge.exposeInMainWorld('hub', {
  getState: () => ipcRenderer.invoke('get-state'),
  list: () => ipcRenderer.invoke('list'),
  add: (reminder) => ipcRenderer.invoke('add', reminder),
  update: (id, changes) => ipcRenderer.invoke('update', { id, changes }),
  remove: (ids) => ipcRenderer.invoke('remove', ids),
  restore: (records) => ipcRenderer.invoke('restore', records),
  clearDone: () => ipcRenderer.invoke('clear-done'),
  setSettings: (values) => ipcRenderer.invoke('set-settings', values),
  setExpanded: (expanded) => ipcRenderer.invoke('set-expanded', expanded),
  markSeen: () => ipcRenderer.invoke('mark-seen'),
  syncConnect: (token) => ipcRenderer.invoke('sync-connect', token),
  syncDisconnect: () => ipcRenderer.invoke('sync-disconnect'),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  openLink: (which) => ipcRenderer.invoke('open-link', which),
  dragMove: (x, y) => ipcRenderer.send('drag-move', { x, y }),
  dragEnd: () => ipcRenderer.send('drag-end'),
  setClickThrough: (on) => ipcRenderer.send('click-through', on),
  updateAction: (action) => ipcRenderer.invoke('update-action', action),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),

  onView: on('view'),
  onRemindersChanged: on('reminders-changed'),
  onSummary: on('summary'),
  onSync: on('sync-status'),
  onUpdate: on('update-status'),
  onOpen: on('open'),
});
