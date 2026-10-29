'use strict';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * The bell can be docked to the left or right edge of a screen, half of it
 * poking out. A dock is { side: 'left' | 'right', edge, y }: `edge` is the
 * screen x that side sits on and `y` is the top of the bell's box (`size` tall).
 */
const DOCK_SIDES = ['left', 'right'];

const dockEdgeX = (side, area) => (side === 'left' ? area.x : area.x + area.width);

/** A dock on `side` of `area`, with the bell's box as near `y` as the screen allows. */
function makeDock(side, area, y, size) {
  const top = clamp(Math.round(y), area.y, Math.max(area.y, area.y + area.height - size));
  return { side, edge: dockEdgeX(side, area), y: top };
}

/**
 * Which side of `area` the bell's box at `box` (x, y) should snap to when dropped,
 * or null if it is more than `threshold` from both. Dropping it past the edge counts.
 */
function dockSnap(box, size, area, threshold) {
  const fromLeft = box.x - area.x;
  const fromRight = area.x + area.width - (box.x + size);
  if (fromLeft <= threshold && fromLeft <= fromRight) return 'left';
  if (fromRight <= threshold) return 'right';
  return null;
}

/**
 * The screen area a saved dock belongs on, or null if it fits none (the monitor
 * was unplugged, say). Prefers the area whose edge is exactly where the dock was,
 * then any area spanning it, so a moved taskbar doesn't lose the dock.
 */
function matchDockArea(dock, size, areas) {
  if (!dock || !DOCK_SIDES.includes(dock.side) || !Number.isFinite(dock.edge) || !Number.isFinite(dock.y)) return null;
  const mid = dock.y + size / 2;
  const level = areas.filter((a) => mid >= a.y && mid < a.y + a.height);
  return (
    level.find((a) => dockEdgeX(dock.side, a) === dock.edge) ||
    level.find((a) => dock.edge >= a.x && dock.edge <= a.x + a.width) ||
    null
  );
}

module.exports = { clamp, DOCK_SIDES, makeDock, dockSnap, matchDockArea };
