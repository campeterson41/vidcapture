'use strict';
// Shared picker and controls geometry. Loaded by the main process (CommonJS)
// and by the picker page (as window.VidGeometry). All rectangles use Hyprland's
// logical layout coordinates, the same space slurp and the recorder use.
(function (root) {
  const OWN_CLASS = /^capture(?:-|$)/;
  const INTERNAL = /^eDP|^LVDS/;

  function logicalMonitor(m) {
    const scale = m.scale || 1;
    const rotated = m.transform % 2 === 1;
    const reserved = Array.isArray(m.reserved) ? m.reserved : [0, 0, 0, 0];
    return {
      id: m.name, x: m.x, y: m.y,
      width: Math.floor((rotated ? m.height : m.width) / scale),
      height: Math.floor((rotated ? m.width : m.height) / scale),
      scale, internal: INTERNAL.test(m.name),
      workspace: m.activeWorkspace ? m.activeWorkspace.id : null,
      special: m.specialWorkspace && m.specialWorkspace.id ? m.specialWorkspace.id : 0,
      // Hyprland lists reserved space as left, top, right, bottom.
      reserved: { left: reserved[0] || 0, top: reserved[1] || 0, right: reserved[2] || 0, bottom: reserved[3] || 0 },
      disabled: !!m.disabled,
    };
  }

  const contains = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
  const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  function monitorAt(monitors, x, y) {
    return monitors.find((m) => contains(m, x, y)) || null;
  }

  // Windows a person can actually see: the active (or open special) workspace on
  // each monitor, plus pinned windows. VidCapture's own windows never qualify.
  // The result is ordered topmost first so the first hit wins.
  function visibleWindows(clients, monitors) {
    const out = [];
    for (const c of clients) {
      if (!c.mapped || c.hidden || c.visible === false || OWN_CLASS.test(c.class || '')) continue;
      if (!c.size || c.size[0] < 32 || c.size[1] < 32) continue;
      const ws = c.workspace ? c.workspace.id : null;
      const shown = monitors.find((m) => !m.disabled && (ws === m.workspace || (m.special && ws === m.special)));
      if (!shown && !c.pinned) continue;
      const special = !!shown && shown.special === ws && ws !== shown.workspace;
      const layer = special ? 4 : c.pinned ? 3 : c.fullscreen ? 2 : c.floating ? 1 : 0;
      out.push({
        address: c.address, title: c.title || c.class || 'Window', app: c.class || '',
        x: c.at[0], y: c.at[1], width: c.size[0], height: c.size[1],
        layer, focus: Number.isFinite(c.focusHistoryID) ? c.focusHistoryID : 1e6,
      });
    }
    return out.sort((a, b) => b.layer - a.layer || a.focus - b.focus);
  }

  function windowAt(windows, x, y) {
    return windows.find((w) => contains(w, x, y)) || null;
  }

  // The smallest logical step whose physical size is a whole pixel, so a 1.5
  // scale display snaps to even logical values and avoids half-pixel crops.
  function scaleStep(scale) {
    for (let n = 1; n <= 8; n++) if (Math.abs(n * scale - Math.round(n * scale)) < 1e-6) return n;
    return 1;
  }

  // Turns two drag points into a recorder region inside one monitor.
  function dragRect(a, b, monitor, min = 32) {
    const step = scaleStep(monitor.scale || 1);
    const clampX = (v) => Math.min(monitor.width, Math.max(0, v - monitor.x));
    const clampY = (v) => Math.min(monitor.height, Math.max(0, v - monitor.y));
    let x0 = clampX(Math.min(a.x, b.x)), x1 = clampX(Math.max(a.x, b.x));
    let y0 = clampY(Math.min(a.y, b.y)), y1 = clampY(Math.max(a.y, b.y));
    x0 = Math.floor(x0 / step) * step; y0 = Math.floor(y0 / step) * step;
    x1 = Math.min(Math.floor(monitor.width / step) * step, Math.ceil(x1 / step) * step);
    y1 = Math.min(Math.floor(monitor.height / step) * step, Math.ceil(y1 / step) * step);
    const width = x1 - x0, height = y1 - y0;
    if (width < min || height < min) return null;
    return { x: monitor.x + x0, y: monitor.y + y0, width, height };
  }

  // Physical pixels the recorder saves for a logical rectangle. H.264 needs
  // even dimensions, so the recorder rounds odd sizes up to the next even pixel.
  function physicalSize(rect, scale) {
    const even = (v) => Math.ceil(Math.round(v * (scale || 1)) / 2) * 2;
    return { width: even(rect.width), height: even(rect.height) };
  }

  function regionId(rect) {
    return `region:${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
  }

  // Usable area of a monitor, excluding bars and other reserved edges.
  function usable(m, margin) {
    const r = m.reserved || { left: 0, top: 0, right: 0, bottom: 0 };
    return { x: m.x + r.left + margin, y: m.y + r.top + margin, width: m.width - r.left - r.right - margin * 2, height: m.height - r.top - r.bottom - margin * 2 };
  }

  const inside = (outer, r) => r.x >= outer.x && r.y >= outer.y && r.x + r.width <= outer.x + outer.width && r.y + r.height <= outer.y + outer.height;

  function targetMonitor(target, monitors) {
    if (target.kind === 'monitor') return monitors.find((m) => m.id === target.monitor) || null;
    return monitors.find((m) => target.x >= m.x && target.y >= m.y && target.x + target.width <= m.x + m.width + 1 && target.y + target.height <= m.y + m.height + 1) || null;
  }

  function otherMonitor(monitors, exclude) {
    const rest = monitors.filter((m) => !m.disabled && (!exclude || m.id !== exclude.id));
    return rest.find((m) => m.internal) || rest[0] || null;
  }

  function bottomCenter(m, size, margin) {
    const area = usable(m, margin);
    return { x: Math.round(area.x + (area.width - size.width) / 2), y: Math.round(area.y + area.height - size.height), width: size.width, height: size.height, monitor: m.id };
  }

  // Where the floating recording controls go so they stay out of the take.
  // Window and area: beside the crop on the same monitor when there is room,
  // else another monitor. Full display: another monitor, else a small dot in
  // the corner away from the camera bubble (it then appears in the recording).
  function pillPlacement({ target, monitors, pill, dot = { width: 28, height: 28 }, gap = 16, margin = 12, cameraCorner = 'bottom-right' }) {
    const home = targetMonitor(target, monitors);
    if (target.kind !== 'monitor' && home) {
      const area = usable(home, margin);
      const keepOut = { x: target.x - gap, y: target.y - gap, width: target.width + gap * 2, height: target.height + gap * 2 };
      const clampX = (x) => Math.min(area.x + area.width - pill.width, Math.max(area.x, x));
      const clampY = (y) => Math.min(area.y + area.height - pill.height, Math.max(area.y, y));
      const cx = Math.round(target.x + (target.width - pill.width) / 2);
      const cy = Math.round(target.y + (target.height - pill.height) / 2);
      const candidates = [
        { x: clampX(cx), y: target.y + target.height + gap },
        { x: clampX(cx), y: target.y - gap - pill.height },
        { x: target.x + target.width + gap, y: clampY(cy) },
        { x: target.x - gap - pill.width, y: clampY(cy) },
        { x: area.x + area.width - pill.width, y: area.y + area.height - pill.height },
        { x: area.x, y: area.y + area.height - pill.height },
        { x: area.x + area.width - pill.width, y: area.y },
        { x: area.x, y: area.y },
      ];
      for (const c of candidates) {
        const r = { x: Math.round(c.x), y: Math.round(c.y), width: pill.width, height: pill.height };
        if (inside(area, r) && !intersects(r, keepOut)) return { ...r, monitor: home.id, collapsed: false, recorded: false };
      }
    }
    const other = otherMonitor(monitors, home);
    if (other) return { ...bottomCenter(other, pill, margin), collapsed: false, recorded: false };
    const m = home || monitors[0];
    const area = usable(m, margin);
    const left = cameraCorner !== 'bottom-left';
    const x = left ? area.x : area.x + area.width - dot.width;
    return { x: Math.round(x), y: Math.round(area.y + area.height - dot.height), width: dot.width, height: dot.height, monitor: m.id, collapsed: true, recorded: true };
  }

  // Expanding the dot keeps it anchored to its corner and on screen.
  function expandFromDot(dotRect, pill, monitor, margin = 12) {
    const area = usable(monitor, margin);
    const anchoredRight = dotRect.x + dotRect.width / 2 > monitor.x + monitor.width / 2;
    const x = anchoredRight ? dotRect.x + dotRect.width - pill.width : dotRect.x;
    return {
      x: Math.round(Math.min(area.x + area.width - pill.width, Math.max(area.x, x))),
      y: Math.round(Math.min(area.y + area.height - pill.height, Math.max(area.y, dotRect.y + dotRect.height - pill.height))),
      width: pill.width, height: pill.height,
    };
  }

  // Top center of the built-in display, below its reserved bar.
  function barPlacement(monitor, size, margin = 12) {
    const r = monitor.reserved || { top: 0 };
    return { x: Math.round(monitor.x + (monitor.width - size.width) / 2), y: monitor.y + r.top + margin, width: size.width, height: size.height };
  }

  // Drop-down from the top bar, like the system menus. With an anchor (the bar
  // icon's x on that monitor) the panel's right edge sits just past the icon;
  // without one it hugs the monitor's top-right corner.
  function panelPlacement(monitor, size, anchorX = null, margin = 8) {
    const r = monitor.reserved || { top: 0, right: 0, bottom: 0 };
    const minX = monitor.x + margin, maxX = monitor.x + monitor.width - (r.right || 0) - margin - size.width;
    const want = anchorX == null ? maxX : Math.round(monitor.x + anchorX + 24 - size.width);
    const top = monitor.y + (r.top || 0) + 6;
    const maxHeight = monitor.height - (r.top || 0) - (r.bottom || 0) - 12;
    return { x: Math.max(minX, Math.min(maxX, want)), y: top, width: size.width, height: Math.min(size.height, maxHeight), monitor: monitor.id };
  }

  const api = { logicalMonitor, monitorAt, visibleWindows, windowAt, scaleStep, dragRect, physicalSize, regionId, pillPlacement, expandFromDot, barPlacement, panelPlacement, targetMonitor, intersects, contains };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VidGeometry = api;
})(typeof self !== 'undefined' ? self : this);
