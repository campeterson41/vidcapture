'use strict';
// The drop-down record panel. Everything here goes through the narrow
// vidcapture bridge; the main process validates every choice.
(() => {
  const vc = window.vidcapture;
  const $ = (id) => document.getElementById(id);
  const sheet = $('sheet');
  let state = null, tab = null, busy = false, openMenu = null, confirming = null;
  const shortcuts = () => (state && state.shortcuts) || {};

  const LIVE = new Set(['starting', 'recording', 'paused', 'stopping']);
  const READY = new Set(['idle', 'saved', 'error']);

  function format(seconds) {
    const t = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const icon = (name, cls = 'icon') => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`);
    svg.append(use); return svg;
  };

  // com.mitchellh.ghostty -> Ghostty, chromium -> Chromium
  const appName = (cls) => {
    const last = String(cls || '').split('.').pop().replace(/[-_]+/g, ' ').trim();
    return last ? last.charAt(0).toUpperCase() + last.slice(1) : 'Window';
  };
  // Integrated_Webcam_HD: Integrate -> Integrated Webcam HD
  // LG ULTRAWIDE -> LG Ultrawide; keeps LG, HP, U2723QE
  const tidyName = (v) => String(v || '').replace(/\b([A-Z])([A-Z]{3,})\b/g, (_, a, b) => a + b.toLowerCase());
  const deviceLabel = (name) => String(name || '').split(':')[0].replace(/_+/g, ' ').trim() || String(name || '');

  function targetTab(t) {
    if (!t) return 'screen';
    return t.kind === 'window' ? 'window' : t.kind === 'region' ? 'area' : t.kind === 'camera' ? 'camera' : 'screen';
  }

  async function act(fn) {
    if (busy) return;
    busy = true; document.body.classList.add('busy');
    try { const next = await fn(); if (next && next.phase) render(next); }
    catch (e) { showError(String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { busy = false; document.body.classList.remove('busy'); if (state) updateStart(); }
  }

  function showError(text) {
    $('error').hidden = !text;
    $('error-text').textContent = text || '';
    fit();
  }

  /* Source */

  function renderDisplays() {
    const box = $('displays'); box.replaceChildren();
    const t = state.target;
    const ms = state.monitors || [];
    box.classList.toggle('single', ms.length < 2);
    for (const m of ms) {
      const on = t && t.kind === 'monitor' && (t.monitor === m.id);
      const b = el('button', 'display-card'); b.type = 'button'; b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const shot = el('span', 'shot');
      if (m.thumb) { const img = el('img'); img.src = m.thumb; img.alt = ''; shot.append(img); } else shot.append(icon('desktop'));
      if (on) shot.append(icon('check', 'icon badge'));
      const label = el('span', 'card-label');
      label.append(el('span', 'card-name', tidyName(m.name)), el('span', 'card-meta', `${m.width} × ${m.height}`));
      b.append(shot, label);
      b.dataset.focus = `display:${m.id}`;
      b.addEventListener('click', () => act(() => vc.panelChoose({ kind: 'monitor', id: m.id })));
      box.append(b);
    }
  }

  function renderWindows() {
    const list = $('windows'); list.replaceChildren();
    const t = state.target;
    const ws = state.windows || [];
    if (!ws.length) { list.append(el('li', 'empty', 'No open windows')); return; }
    for (const w of ws) {
      const on = t && t.kind === 'window' && t.address === w.address && t.available !== false;
      const li = el('li');
      const b = el('button', 'window-row'); b.type = 'button'; b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const shot = el('span', 'mini');
      if (w.thumb) { const img = el('img'); img.src = w.thumb; img.alt = ''; shot.append(img); }
      else shot.append(el('span', 'initial', (w.app || w.title || '?').replace(/^[^a-z0-9]+/i, '').charAt(0).toUpperCase() || '?'));
      const text = el('span', 'window-text');
      // Terminals put spinners and status marks in front of their titles.
      text.append(el('span', 'window-title', String(w.title).replace(/^[^\p{L}\p{N}]+/u, '') || w.title));
      text.append(el('span', 'window-meta', w.visible ? appName(w.app) : `${appName(w.app)}, workspace ${w.workspace}`));
      b.append(shot, text);
      if (on) b.append(icon('check', 'icon tick'));
      b.dataset.focus = `window:${w.address}`;
      b.addEventListener('click', () => act(() => vc.panelChoose({ kind: 'window', address: w.address })));
      li.append(b); list.append(li);
    }
  }

  function renderArea() {
    const t = state.target;
    const has = t && t.kind === 'region';
    const size = state.targetSize || t || {};
    $('area-state').hidden = !has;
    $('area-size').textContent = has ? `${size.width} × ${size.height}` : '';
    $('draw-label').textContent = has ? 'Draw a different area' : 'Draw an area on screen';
  }

  // Camera only: each camera is a row; choosing one records just that camera.
  function renderCameras() {
    const list = $('cameras'); list.replaceChildren();
    const cams = state.devices.cameras || [];
    const t = state.target, current = state.settings.camera;
    if (!cams.length) { list.append(el('li', 'empty', 'No cameras found')); return; }
    for (const c of cams) {
      const on = !!t && t.kind === 'camera' && current === c.id;
      const li = el('li');
      const b = el('button', 'window-row'); b.type = 'button'; b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const shot = el('span', 'mini'); shot.append(icon('camera'));
      const text = el('span', 'window-text');
      text.append(el('span', 'window-title', deviceLabel(c.name)));
      b.append(shot, text);
      if (on) b.append(icon('check', 'icon tick'));
      b.dataset.focus = `camera:${c.id}`;
      b.addEventListener('click', () => act(() => vc.panelChoose({ kind: 'camera', device: c.id })));
      li.append(b); list.append(li);
    }
  }

  function setTab(next, user) {
    // A tab switch restores that tab's choice; while another action runs it
    // would be dropped, leaving the tab and the target out of step.
    if (user && busy) return;
    tab = next;
    for (const b of document.querySelectorAll('[data-tab]')) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    for (const id of ['screen', 'window', 'area', 'camera']) $(`source-${id}`).hidden = id !== tab;
    // Switching tabs brings back that tab's last choice. Full screen falls back
    // to the display the panel opened on. Window and Area wait for the user.
    if (user && targetTab(state.target) !== tab) {
      const m = (state.memo || {})[tab];
      if (tab === 'screen') {
        const ms = state.monitors || [];
        const pick = (m && ms.find((x) => x.id === m.monitor)) || ms.find((x) => x.id === state.here) || ms[0];
        if (pick) act(() => vc.panelChoose({ kind: 'monitor', id: pick.id }));
      } else if (tab === 'window' && m && (state.windows || []).some((w) => w.address === m.address && w.visible)) {
        // Only a window already on screen; restoring one on another workspace
        // would switch workspaces just for clicking a tab.
        act(() => vc.panelChoose({ kind: 'window', address: m.address }));
      } else if (tab === 'area' && m) {
        act(() => vc.panelChoose({ kind: 'region', x: m.x, y: m.y, width: m.width, height: m.height }));
      } else if (tab === 'camera' && state.settings.camera !== 'none') {
        act(() => vc.panelChoose({ kind: 'camera' }));
      }
    }
    renderDevices(); updateStart(); fit();
  }

  function updateStart() {
    const t = state && state.target;
    const gone = !!t && t.kind === 'window' && t.available === false;
    const noCamera = tab === 'camera' && state.settings.camera === 'none';
    const ok = !!t && targetTab(t) === tab && !gone && !noCamera;
    const start = $('start');
    // Not tied to busy: act() already ignores clicks while a save runs, and a
    // gray flash on every settings change looked like an error.
    start.disabled = !ok || !!state.job?.running || !READY.has(state.phase);
    start.title = shortcuts().record ? `Start recording (${shortcuts().record})` : '';
    const hint = $('hint');
    hint.textContent = state.job?.running ? 'Processing a recording. Start is available when it finishes.'
      : ok || tab === 'area' ? '' : tab === 'camera' ? 'Choose a camera to record' : tab === 'window' ? (gone ? 'That window was closed. Choose another.' : 'Choose a window to record') : 'Choose a display to record';
    hint.hidden = !hint.textContent;
  }

  /* Devices */

  function deviceName(list, id, none) {
    if (id === 'none') return none;
    if (id === 'default_input') return 'Default microphone';
    return deviceLabel((list.find((d) => d.id === id) || {}).name) || none;
  }

  function buildMenu(menu, options, current, key) {
    menu.replaceChildren();
    for (const o of options) {
      const b = el('button', 'menu-item'); b.type = 'button';
      b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', o.id === current ? 'true' : 'false');
      b.tabIndex = -1;
      b.append(el('span', 'menu-text', deviceLabel(o.name)));
      if (o.id === current) b.append(icon('check', 'icon tick'));
      b.addEventListener('click', () => { closeMenus(true); if (o.id !== current) act(() => vc.panelSave({ [key]: o.id })); });
      menu.append(b);
    }
  }

  const MENUS = { 'camera-menu': 'camera-select', 'mic-menu': 'mic-select' };

  function closeMenus(refocus) {
    const was = openMenu;
    for (const [menu, btn] of Object.entries(MENUS)) { $(btn).setAttribute('aria-expanded', 'false'); $(menu).hidden = true; }
    openMenu = null;
    if (refocus && was) $(MENUS[was]).focus();
  }

  // Menus float over the panel, below the button or above it when the panel
  // has no room underneath.
  function placeMenu(menu, btn) {
    const r = btn.getBoundingClientRect(), gap = 4, edge = 6;
    menu.style.left = `${r.left}px`; menu.style.width = `${r.width}px`;
    menu.style.maxHeight = ''; menu.style.top = '0px';
    const h = menu.offsetHeight;
    const below = innerHeight - r.bottom - gap - edge, above = r.top - gap - edge;
    if (h <= below || below >= above) { menu.style.top = `${r.bottom + gap}px`; menu.style.maxHeight = `${Math.max(80, below)}px`; }
    else { const mh = Math.min(h, above); menu.style.top = `${r.top - gap - mh}px`; menu.style.maxHeight = `${mh}px`; }
  }

  function toggleMenu(btnId, menuId, focusLast) {
    const open = $(menuId).hidden;
    closeMenus(false);
    if (!open) return;
    const menu = $(menuId), btn = $(btnId);
    menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); openMenu = menuId;
    placeMenu(menu, btn);
    const items = [...menu.querySelectorAll('.menu-item')];
    const start = focusLast ? items[items.length - 1] : (items.find((b) => b.getAttribute('aria-checked') === 'true') || items[0]);
    start?.focus();
  }

  function menuKeys(e) {
    const items = [...e.currentTarget.querySelectorAll('.menu-item')];
    const i = items.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Tab') closeMenus(false);
  }

  function renderDevices() {
    const s = state.settings, d = state.devices;
    $('camera-value').textContent = deviceName(d.cameras, s.camera, 'No camera');
    $('mic-value').textContent = deviceName(d.microphones, s.microphone, 'No microphone');
    $('camera-select').setAttribute('aria-label', `Camera: ${$('camera-value').textContent}`);
    $('mic-select').setAttribute('aria-label', `Microphone: ${$('mic-value').textContent}`);
    // Rebuilding an open menu would drop keyboard focus out of it.
    if (openMenu !== 'camera-menu') buildMenu($('camera-menu'), [{ id: 'none', name: 'No camera' }, ...d.cameras], s.camera, 'camera');
    if (openMenu !== 'mic-menu') buildMenu($('mic-menu'), [{ id: 'default_input', name: 'Default microphone' }, ...d.microphones, { id: 'none', name: 'No microphone' }], s.microphone, 'microphone');
    $('camera-select').classList.toggle('off', s.camera === 'none');
    $('mic-select').classList.toggle('off', s.microphone === 'none');
    $('camera-select').querySelector('use').setAttribute('href', s.camera === 'none' ? '#i-camera-off' : '#i-camera');
    $('mic-select').querySelector('use').setAttribute('href', s.microphone === 'none' ? '#i-mic-off' : '#i-mic');
    const preview = $('preview');
    preview.hidden = s.camera === 'none';
    preview.setAttribute('aria-pressed', state.cameraPreview ? 'true' : 'false');
    preview.title = state.cameraPreview ? 'Hide camera' : 'Show camera';
    preview.setAttribute('aria-label', preview.title);
    $('system-audio').checked = !!s.systemAudio;
    for (const seg of document.querySelectorAll('.seg')) {
      const v = String(s[seg.dataset.key]);
      for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false');
    }
    const camRows = ['cameraSize', 'cameraCorner', 'cameraLighting', 'cameraCorrection'];
    for (const k of camRows) document.querySelector(`.seg[data-key="${k}"]`).closest('.setting').hidden = s.camera === 'none';
    // The bubble's size and corner mean nothing when only the camera is recorded.
    for (const k of ['cameraSize', 'cameraCorner', 'cameraLighting', 'cameraCorrection']) if (tab === 'camera') document.querySelector(`.seg[data-key="${k}"]`).closest('.setting').hidden = true;
    // Lens correction exists only for cameras whose profile measured it.
    const profile = (d.cameras.find((c) => c.id === s.camera) || {}).profile;
    if (!(profile && profile.lensCorrection)) document.querySelector('.seg[data-key="cameraCorrection"]').closest('.setting').hidden = true;
  }

  /* Live */

  function renderLive() {
    const paused = state.phase === 'paused';
    $('live').classList.toggle('paused', paused);
    $('live-elapsed').textContent = format(state.elapsed);
    $('live-dot').classList.toggle('paused', paused);
    const t = state.target;
    if (state.phase === 'starting') { $('live-what').textContent = 'Starting'; for (const id of ['live-pause', 'live-stop', 'live-restart', 'live-discard']) $(id).disabled = true; return; }
    const size = state.targetSize || t || {};
    const what = !t ? 'the screen' : t.kind === 'camera' ? 'the camera' : t.kind === 'window' ? (t.label || t.title || 'a window')
      : t.kind === 'region' ? `an area, ${size.width} × ${size.height}`
      : /^eDP/.test(t.monitor || '') ? 'the laptop display'
      : tidyName(((state.monitors || []).find((m) => m.id === t.monitor) || {}).name || t.label || 'the screen');
    $('live-what').textContent = state.phase === 'stopping' ? 'Saving' : paused ? 'Paused' : `Recording ${what}`;
    const p = $('live-pause');
    p.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
    p.querySelector('span').textContent = paused ? 'Resume' : 'Pause';
    p.disabled = state.phase === 'stopping';
    p.title = shortcuts().pause ? `${paused ? 'Resume' : 'Pause'} (${shortcuts().pause})` : '';
    $('live-stop').disabled = state.phase === 'stopping';
    $('live-stop').title = shortcuts().record ? `Stop and save (${shortcuts().record})` : '';
    $('live-restart').disabled = $('live-discard').disabled = state.phase === 'stopping';
    if (state.phase === 'stopping' && confirming) settle(false);
  }

  let lastKey = '';
  function render(next) {
    const first = !state;
    // Updates without thumbnails keep the ones from the first state.
    if (!next.monitors && state) { next.monitors = state.monitors; next.windows = state.windows; }
    const key = JSON.stringify({ ...next, elapsed: 0, monitors: null, windows: null, thumbs: !!next.monitors });
    const same = !first && key === lastKey;
    lastKey = key;
    state = next;
    if (same && !LIVE.has(state.phase)) return;
    const live = LIVE.has(state.phase);
    $('setup').hidden = live; $('live').hidden = !live;
    // Opening the main window mid-take would put it in the recording.
    $('recordings').hidden = live;
    if (live) { closeMenus(false); renderLive(); fit(); return; }
    if (first || !tab) tab = state.tab || targetTab(state.target);
    // Rebuilt rows would otherwise drop keyboard focus to the page.
    const had = document.activeElement?.dataset?.focus;
    renderDisplays(); renderWindows(); renderArea(); renderCameras(); renderDevices();
    if (had) document.querySelector(`[data-focus="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
    setTab(tab, false);
    showError(state.error || '');
    // Back from the picker, focus returns to the button that opened it, with
    // no ring unless the keyboard is used next.
    if (first && state.tab) {
      const into = state.tab === 'window' ? $('click-window') : $('draw-area');
      into?.focus({ preventScroll: true, focusVisible: false });
    }
  }

  /* Size the window to the sheet */

  let fitFrame = 0, lastHeight = 0;
  function fit() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      // The size the sheet wants, even while its middle is scrolling.
      const scroll = $('scroll'), setup = !$('setup').hidden;
      const natural = setup ? sheet.offsetHeight - scroll.clientHeight + scroll.scrollHeight : sheet.scrollHeight;
      const h = Math.ceil(natural) + 14 + 2;
      if (Math.abs(h - lastHeight) > 1) { lastHeight = h; vc.panelResize(h).catch(() => {}); }
    });
  }
  new ResizeObserver(fit).observe(sheet);
  new ResizeObserver(fit).observe($('scroll'));

  // Fade the scrolling middle only on the edges with more to see.
  const scroller = $('scroll');
  function edges() {
    sheet.classList.toggle('can-scroll-up', scroller.scrollTop > 0);
    sheet.classList.toggle('can-scroll-down', scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1);
  }
  scroller.addEventListener('scroll', edges, { passive: true });
  new ResizeObserver(edges).observe(scroller);
  new MutationObserver(edges).observe(scroller, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(fit).observe(sheet, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });

  /* Events */

  const tabs = [...document.querySelectorAll('[data-tab]')];
  for (const b of tabs) {
    b.addEventListener('click', () => setTab(b.dataset.tab, true));
    b.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(b);
      const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
      if (n == null) return;
      e.preventDefault();
      const next = tabs[(n + tabs.length) % tabs.length]; next.focus(); setTab(next.dataset.tab, true);
    });
  }
  $('click-window').addEventListener('click', () => act(() => vc.panelPick('window')));
  $('draw-area').addEventListener('click', () => act(() => vc.panelPick('area')));
  for (const [menu, btn] of Object.entries(MENUS)) {
    $(btn).addEventListener('click', () => toggleMenu(btn, menu));
    $(btn).addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if ($(menu).hidden) toggleMenu(btn, menu, e.key === 'ArrowUp'); }
    });
    $(menu).addEventListener('keydown', menuKeys);
  }
  // A click anywhere else, or scrolling, closes an open menu.
  document.addEventListener('pointerdown', (e) => {
    if (openMenu && !e.target.closest('.menu') && !e.target.closest('[aria-haspopup]')) closeMenus(false);
  }, true);
  $('scroll').addEventListener('scroll', () => { if (openMenu) closeMenus(false); });
  $('preview').addEventListener('click', () => act(() => vc.panelPreview()));
  $('system-audio').addEventListener('change', (e) => {
    const box = e.target, want = box.checked;
    // Show the saved value again if the save is refused or never runs.
    if (busy) { box.checked = !!state.settings.systemAudio; return; }
    act(async () => { try { return await vc.panelSave({ systemAudio: want }); } catch (err) { box.checked = !!state.settings.systemAudio; throw err; } });
  });
  $('more').addEventListener('click', () => {
    const open = $('settings').hidden;
    $('settings').hidden = !open; $('more').setAttribute('aria-expanded', open ? 'true' : 'false'); fit();
    // Once the window has grown (or hit the screen edge), bring the options into view.
    if (open) setTimeout(() => $('settings').scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 260);
  });
  for (const seg of document.querySelectorAll('.seg')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const key = seg.dataset.key; const v = key === 'fps' || key === 'countdown' ? Number(b.dataset.v) : b.dataset.v;
      act(() => vc.panelSave({ [key]: v }));
    });
  }
  $('start').addEventListener('click', () => act(() => vc.panelStart()));
  $('recordings').addEventListener('click', () => vc.panelMain());
  $('close').addEventListener('click', () => vc.panelClose());
  $('live-pause').addEventListener('click', () => act(() => vc.panelPause()));
  // Restart and Delete take ask once more before throwing the take away.
  const CONFIRM = {
    restart: { text: 'Restart this take?', go: 'Restart', run: () => vc.panelRestart(), from: 'live-restart' },
    discard: { text: 'Delete this take?', go: 'Delete', run: () => vc.panelDiscard(), from: 'live-discard' },
  };
  function ask(kind) {
    confirming = kind;
    $('live-confirm-text').textContent = CONFIRM[kind].text;
    $('live-confirm-go').textContent = CONFIRM[kind].go;
    $('live-actions').hidden = true; $('live-confirm').hidden = false;
    $('live-confirm-go').focus(); fit();
  }
  function settle(go) {
    const kind = confirming; if (!kind) return;
    confirming = null;
    $('live-confirm').hidden = true; $('live-actions').hidden = false; fit();
    if (go) act(() => CONFIRM[kind].run());
    else $(CONFIRM[kind].from).focus();
  }
  $('live-restart').addEventListener('click', () => ask('restart'));
  $('live-discard').addEventListener('click', () => ask('discard'));
  $('live-confirm-go').addEventListener('click', () => settle(true));
  $('live-confirm-cancel').addEventListener('click', () => settle(false));
  $('live-stop').addEventListener('click', () => act(() => vc.panelStop()));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (openMenu) { closeMenus(true); return; }
    if (confirming) { settle(false); return; }
    vc.panelClose();
  });

  // Live microphone level, -1 when nothing is being read.
  const meter = $('mic-level'), meterFill = meter.firstElementChild;
  let shown = 0;
  vc.on('level', (v) => {
    if (v < 0) { meter.hidden = true; return; }
    meter.hidden = false;
    // Rise at once, fall gently, like a hardware meter.
    shown = v > shown ? v : shown * 0.7 + v * 0.3;
    meterFill.style.transform = `scaleX(${shown.toFixed(3)})`;
  });

  vc.on('panel', (s) => { if (!busy || LIVE.has(s.phase)) render(s); });
  vc.panelState().then(render).catch((e) => showError(String(e.message || e)));
})();
