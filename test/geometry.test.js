'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeDock, dockSnap, matchDockArea } = require('../src/main/geometry');

const area = { x: 0, y: 0, width: 1920, height: 1032 };
const SIZE = 76;

// ---------- Docking the bell to a screen edge ----------

test('a dock sits on the chosen edge, with the bell kept on the screen', () => {
  assert.deepEqual(makeDock('right', area, 300, SIZE), { side: 'right', edge: 1920, y: 300 });
  assert.deepEqual(makeDock('left', area, 300, SIZE), { side: 'left', edge: 0, y: 300 });
  assert.equal(makeDock('left', area, -50, SIZE).y, 0, 'not above the top');
  assert.equal(makeDock('left', area, 5000, SIZE).y, 1032 - SIZE, 'not below the bottom');
});

test('a dock on a second monitor uses that monitor’s edge', () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(makeDock('left', left, 100, SIZE), { side: 'left', edge: -1920, y: 100 });
  assert.deepEqual(makeDock('right', left, 100, SIZE), { side: 'right', edge: 0, y: 100 });
});

test('dropping the bell near an edge snaps it to that side', () => {
  assert.equal(dockSnap({ x: 12, y: 300 }, SIZE, area, 40), 'left');
  assert.equal(dockSnap({ x: 1920 - SIZE - 12, y: 300 }, SIZE, area, 40), 'right');
  assert.equal(dockSnap({ x: 900, y: 300 }, SIZE, area, 40), null, 'in the middle of the screen');
  assert.equal(dockSnap({ x: 41, y: 300 }, SIZE, area, 40), null, 'just too far');
});

test('dropping the bell past an edge snaps to that side', () => {
  assert.equal(dockSnap({ x: -60, y: 300 }, SIZE, area, 40), 'left');
  assert.equal(dockSnap({ x: 1900, y: 300 }, SIZE, area, 40), 'right');
});

test('on a screen too narrow for either side to be clearly nearer, the nearer one wins', () => {
  const narrow = { x: 0, y: 0, width: 100, height: 500 };
  assert.equal(dockSnap({ x: 20, y: 0 }, SIZE, narrow, 40), 'right');
  assert.equal(dockSnap({ x: 2, y: 0 }, SIZE, narrow, 40), 'left');
});

test('a saved dock is matched to the screen it was on', () => {
  const second = { x: 1920, y: 0, width: 1280, height: 1000 };
  const areas = [area, second];
  assert.equal(matchDockArea({ side: 'right', edge: 3200, y: 200 }, SIZE, areas), second);
  assert.equal(matchDockArea({ side: 'left', edge: 1920, y: 200 }, SIZE, areas), second, 'the seam belongs to the screen it’s docked on');
  assert.equal(matchDockArea({ side: 'right', edge: 1920, y: 200 }, SIZE, areas), area);
});

test('a saved dock that fits no screen is dropped', () => {
  assert.equal(matchDockArea({ side: 'right', edge: 5000, y: 200 }, SIZE, [area]), null, 'monitor unplugged');
  assert.equal(matchDockArea({ side: 'right', edge: 1920, y: 5000 }, SIZE, [area]), null, 'height off every screen');
  assert.equal(matchDockArea({ side: 'top', edge: 1920, y: 200 }, SIZE, [area]), null, 'unknown side');
  assert.equal(matchDockArea({ side: 'left', edge: 'x', y: 200 }, SIZE, [area]), null, 'garbage');
  assert.equal(matchDockArea(false, SIZE, [area]), null);
});

test('a dock whose screen’s edge moved a little (taskbar moved) still finds its screen', () => {
  const shifted = { x: 48, y: 0, width: 1872, height: 1032 };
  assert.equal(matchDockArea({ side: 'left', edge: 0, y: 200 }, SIZE, [shifted]), null, 'edge is outside the new area');
  assert.equal(matchDockArea({ side: 'right', edge: 1900, y: 200 }, SIZE, [shifted]), shifted, 'edge is inside the new area');
});
