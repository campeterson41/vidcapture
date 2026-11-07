'use strict';
// One overlay per display. Pointer positions are page pixels, which equal
// Hyprland logical pixels; adding the display origin gives layout coordinates.
(() => {
  const vc = window.vidcapture;
  const G = window.VidGeometry;
  const $ = (id) => document.getElementById(id);
  const cut = $('cut'), sizeTag = $('size-tag'), top = $('picker-top'), hint = $('hint');
  const confirm = $('confirm'), confirmTitle = $('confirm-title'), confirmSize = $('confirm-size');
  const go = $('go'), goLabel = $('go-label');
  const HINTS = { window: 'Click a window', area: 'Drag to select an area', display: 'Click a screen' };

  let data = null, mode = 'window', selection = null, drag = null, hover = null;

  const dims = (r) => { const p = G.physicalSize(r, data.monitor.scale); return `${p.width} × ${p.height}`; };
  const local = (r) => ({ x: r.x - data.monitor.x, y: r.y - data.monitor.y, width: r.width, height: r.height });
  const globalPoint = (e) => ({ x: e.clientX + data.monitor.x, y: e.clientY + data.monitor.y });

  function showCut(rect, kind) {
    if (!rect) {
      cut.className = 'cut';
      Object.assign(cut.style, { left: '0px', top: '0px', width: '0px', height: '0px' });
      sizeTag.hidden = true;
      return;
    }
    const r = local(rect);
    cut.className = `cut is-shown${kind === 'hover' ? ' is-hover' : ''}`;
    Object.assign(cut.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  function showSize(rect) {
    if (!rect) { sizeTag.hidden = true; return; }
    const r = local(rect);
    sizeTag.textContent = dims(rect);
    sizeTag.hidden = false;
    const w = sizeTag.offsetWidth, h = sizeTag.offsetHeight;
    const x = Math.min(innerWidth - w - 8, Math.max(8, r.x));
    let y = r.y - h - 8 >= 8 ? r.y - h - 8 : Math.min(innerHeight - h - 8, r.y + 8);
    // Keep the tag clear of the toolbar and hint at the top of the screen.
    const t = top.getBoundingClientRect();
    if (x < t.right && x + w > t.left && y < t.bottom && y + h > t.top) y = Math.min(innerHeight - h - 8, Math.max(t.bottom + 8, r.y + 8));
    Object.assign(sizeTag.style, { left: `${x}px`, top: `${y}px` });
  }

  function renderMode() {
    document.body.dataset.mode = mode;
    for (const b of document.querySelectorAll('.mode')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    hint.textContent = HINTS[mode];
  }

  function placeConfirm(rect) {
    const r = local(rect);
    confirm.hidden = false;
    const w = confirm.offsetWidth, h = confirm.offsetHeight, gap = 12;
    const topLimit = (data.monitor.reserved?.top || 0) + gap;
    let y;
    if (r.y + r.height + gap + h <= innerHeight - gap) y = r.y + r.height + gap;
    else if (r.y - gap - h >= topLimit) y = r.y - gap - h;
    else y = Math.max(topLimit, Math.min(innerHeight - h - gap, r.y + r.height - h - 24));
    const x = Math.min(innerWidth - w - gap, Math.max(gap, r.x + (r.width - w) / 2));
    Object.assign(confirm.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` });
  }

  function renderSelection() {
    document.body.classList.toggle('has-selection', !!selection);
    hint.hidden = !!selection;
    if (!selection) {
      confirm.hidden = true;
      showCut(hover, 'hover');
      if (mode === 'area' || !hover) sizeTag.hidden = true;
      return;
    }
    const mine = G.intersects(selection.rect, data.monitor);
    showCut(mine ? selection.rect : null, 'selected');
    sizeTag.hidden = true;
    const r = selection.rect;
    const home = G.monitorAt([data.monitor], r.x + r.width / 2, r.y + r.height / 2);
    if (!home) { confirm.hidden = true; return; }
    confirmTitle.textContent = selection.kind === 'window' ? selection.title : selection.kind === 'monitor' ? (data.monitor.label || data.monitor.id) : 'Area';
    confirmSize.textContent = dims(r);
    placeConfirm(r);
    go.focus({ preventScroll: true, focusVisible: false });
  }

  function hoverAt(e) {
    if (selection || drag || !data) return;
    const p = globalPoint(e);
    let next = null;
    if (mode === 'window') next = G.windowAt(data.windows, p.x, p.y);
    else if (mode === 'display') next = data.monitor;
    if (next === hover) return;
    hover = next;
    showCut(hover, 'hover');
    if (hover && mode === 'window') showSize(hover); else sizeTag.hidden = true;
  }

  let hintTimer = 0;
  const onChrome = (e) => e.target.closest('.confirm, .toolbar, .hint');

  document.addEventListener('mousemove', (e) => {
    if (drag) {
      const rect = G.dragRect(drag, globalPoint(e), data.monitor, 1);
      showCut(rect, 'selected');
      showSize(rect);
      return;
    }
    hoverAt(e);
  });

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !data || onChrome(e)) return;
    const p = globalPoint(e);
    if (mode === 'area') {
      selection = null; confirm.hidden = true; document.body.classList.remove('has-selection');
      drag = p;
      showCut(null);
      return;
    }
    hover = null;
    if (mode === 'window') {
      const w = G.windowAt(data.windows, p.x, p.y);
      vc.select(w ? { kind: 'window', address: w.address } : null);
    } else if (mode === 'display') {
      vc.select({ kind: 'monitor', monitor: data.monitor.id });
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const start = drag; drag = null;
    const rect = G.dragRect(start, globalPoint(e), data.monitor);
    if (!rect) {
      showCut(null); vc.select(null);
      // A real drag that came out too small gets a short explanation.
      const end = globalPoint(e);
      if (Math.abs(end.x - start.x) > 4 || Math.abs(end.y - start.y) > 4) {
        hint.textContent = 'Drag a larger area'; hint.hidden = false;
        clearTimeout(hintTimer); hintTimer = setTimeout(() => { if (mode === 'area') hint.textContent = HINTS[mode]; }, 1800);
      }
      return;
    }
    vc.select({ kind: 'region', rect });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); vc.cancel(); }
    else if (e.key === 'Enter' && selection && !e.target.closest('button')) { e.preventDefault(); vc.confirm(); }
  });

  for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => vc.setMode(b.dataset.mode));
  $('dismiss').addEventListener('click', () => vc.cancel());
  $('cancel').addEventListener('click', () => vc.cancel());
  go.addEventListener('click', () => vc.confirm());

  vc.on('mode', (m) => { mode = m; hover = null; drag = null; renderMode(); renderSelection(); });
  vc.on('selection', (s) => { selection = s; hover = null; renderSelection(); });

  vc.pickerData().then((d) => {
    if (!d) return;
    data = d;
    mode = d.mode;
    selection = d.selection;
    const record = d.intent === 'record';
    go.className = `btn ${record ? 'btn-record' : 'btn-solid'}`;
    go.querySelector('.rec-mark').hidden = !record;
    goLabel.textContent = record ? 'Start recording' : 'Select';
    if (d.toolbar) {
      top.hidden = false;
      top.style.top = `${(d.monitor.reserved?.top || 0) + 12}px`;
    }
    renderMode();
    renderSelection();
    document.body.dataset.ready = 'true';
  });
})();
