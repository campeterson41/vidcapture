'use strict';

(() => {
  const bridge = window.capture;
  const ACTIVE = new Set(['selecting', 'starting', 'recording', 'paused', 'stopping']);
  const HOME_RE = /^\/home\/[^/]+(?=\/|$)/;

  const $ = (id) => document.getElementById(id);
  const el = {
    targets: $('targets'),
    regionNote: $('region-note'),
    sourceTools: $('source-tools'),
    pickOnScreen: $('pick-on-screen'),
    cameraOptions: $('camera-options'),
    cameraIcon: $('camera-icon'),
    micIcon: $('mic-icon'),
    micLevel: $('mic-level'),
    microphone: $('microphone'),
    systemAudio: $('system-audio'),
    camera: $('camera'),
    cameraCorrection: $('camera-correction'),
    cameraProfileNote: $('camera-profile-note'),
    preview: $('preview'),
    refresh: $('refresh'),
    moreBody: $('more-body'),
    fieldsets: Array.from(document.querySelectorAll('fieldset[data-setting]')),
    openFolder: $('open-folder'),
    location: $('location'),
    outputDir: $('output-dir'),
    changeFolder: $('change-folder'),
    time: $('time'),
    status: $('status'),
    openLast: $('open-last'),
    pause: $('pause'),
    restart: $('restart'),
    discard: $('discard'),
    pauseLabel: $('pause').querySelector('.label'),
    pauseUse: $('pause').querySelector('use'),
    primary: $('primary'),
    primaryLabel: $('primary-label'),
    alert: $('alert'),
    alertText: $('alert-text'),
    alertDismiss: $('alert-dismiss'),
    editLast: $('edit-last'),
    minimize: $('minimize'),
    close: $('close'),
  };

  let state = null;
  let pending = null;
  let armed = null, armTimer = null;
  let localError = null;
  let dismissedError = null;
  const signatures = {};

  /* Formatting */

  function formatElapsed(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function shortenPath(path) {
    return String(path || '').replace(HOME_RE, '~');
  }

  function baseName(path) {
    const parts = String(path || '').split('/');
    return parts[parts.length - 1] || String(path || '');
  }

  function dims(w, h) {
    const W = Number(w);
    const H = Number(h);
    return W > 0 && H > 0 ? `${W} × ${H}` : '';
  }

  function errorMessage(err) {
    if (err && typeof err.message === 'string' && err.message.trim()) {
      // Electron prefixes rejected IPC errors; keep only the readable part.
      return err.message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim();
    }
    return 'Something went wrong. Please try again.';
  }

  function icon(id, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', `#${id}`);
    svg.appendChild(use);
    return svg;
  }

  function span(cls, text) {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    if (text != null) s.textContent = text;
    return s;
  }

  function changed(key, value) {
    const sig = JSON.stringify(value);
    if (signatures[key] === sig) return false;
    signatures[key] = sig;
    return true;
  }

  /* Async actions */

  let settingsChain = Promise.resolve();

  function adopt(next) {
    if (next && typeof next === 'object' && typeof next.phase === 'string') state = next;
  }

  function fail(err) {
    localError = errorMessage(err);
    dismissedError = null;
  }

  async function run(action, fn) {
    if (pending || !bridge) return;
    const focused = document.activeElement;
    pending = action;
    localError = null;
    render();
    try {
      await settingsChain;
      adopt(await fn());
    } catch (err) {
      fail(err);
    } finally {
      pending = null;
      render();
      if (focused && focused !== document.body && focused.isConnected && !focused.disabled &&
          (document.activeElement === document.body || document.activeElement == null)) {
        focused.focus({ preventScroll: true });
      }
    }
  }

  // Settings saves are queued so quick successive changes are all applied in order.
  function saveSetting(partial) {
    if (!bridge) return;
    settingsChain = settingsChain.then(async () => {
      try {
        adopt(await bridge.saveSettings(partial));
      } catch (err) {
        fail(err);
        signatures.mics = signatures.cams = null;
      }
      render();
    });
  }

  /* Rendering */

  /* What to record: Full screen, Window or Area, with live thumbnails */

  const src = { order: new Map(), data: null, loading: false, again: false, tab: null, at: 0, targetKey: undefined };
  const SHOT_RATIO = 16 / 10;

  function targetTab(t) {
    if (!t) return 'screen';
    return t.kind === 'window' ? 'window' : t.kind === 'region' ? 'area' : t.kind === 'camera' ? 'camera' : 'screen';
  }
  function targetKey(t) {
    return t ? [t.kind, t.address || t.monitor || '', t.x, t.y, t.width, t.height].join(':') : '';
  }
  // com.mitchellh.ghostty -> Ghostty
  function appName(cls) {
    const last = String(cls || '').split('.').pop().replace(/[-_]+/g, ' ').trim();
    return last ? last.charAt(0).toUpperCase() + last.slice(1) : 'Window';
  }

  // Thumbnails are taken fresh when the page shows, so they match the screen.
  async function loadSources() {
    if (!bridge || typeof bridge.sources !== 'function') return;
    if (src.loading) { src.again = true; return; }
    if (state && ACTIVE.has(state.phase)) return;
    src.loading = true;
    try {
      const data = await bridge.sources();
      // Windows keep the order they first appeared in, so cards never jump
      // when focus changes between refreshes.
      if (data && Array.isArray(data.windows)) {
        for (const w of data.windows) if (!src.order.has(w.address)) src.order.set(w.address, src.order.size);
        data.windows.sort((a, b) => src.order.get(a.address) - src.order.get(b.address));
      }
      src.data = data; src.at = Date.now();
    }
    catch { /* The page still works without thumbnails. */ }
    finally {
      src.loading = false;
      render();
      if (src.again) { src.again = false; loadSources(); }
    }
  }
  let sourcesTimer = null;
  function refreshSources(delay = 0) {
    clearTimeout(sourcesTimer);
    sourcesTimer = setTimeout(() => { if (ed.view === 'record' && !document.hidden) loadSources(); }, delay);
  }

  // Where the camera bubble lands, using the recorder's own sizing.
  function bubbleStyle(width, height, settings) {
    const margin = 16, size = settings.cameraSize || 'small';
    const d = Math.max(32, Math.min(
      Math.max({ small: 72, medium: 112, large: 160 }[size] || 72, Math.min(720, Math.round(Math.min(width, height) * ({ small: 0.22, medium: 0.34, large: 0.48 }[size] || 0.22)))),
      width - margin * 2, height - margin * 2));
    const side = settings.cameraCorner === 'bottom-left' ? 'left' : 'right';
    return { width: `${(d / width) * 100}%`, [side]: `${(margin / width) * 100}%`, bottom: `${(margin / height) * 100}%` };
  }

  // A thumbnail card. The picture keeps the source's shape inside the frame,
  // so the camera bubble sits where it will be in the recording.
  function sourceCard({ name, meta, thumb, width, height, selected, fallback, label }, s) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'source-card';
    b.setAttribute('aria-pressed', String(!!selected));
    if (label) b.setAttribute('aria-label', label);
    const shot = span('shot');
    const box = span('shot-box');
    const ratio = width > 0 && height > 0 ? width / height : SHOT_RATIO;
    if (ratio >= SHOT_RATIO) { box.style.width = '100%'; box.style.height = `${(SHOT_RATIO / ratio) * 100}%`; }
    else { box.style.height = '100%'; box.style.width = `${(ratio / SHOT_RATIO) * 100}%`; }
    if (thumb) {
      const img = document.createElement('img');
      img.src = thumb; img.alt = ''; img.draggable = false;
      box.appendChild(img);
    } else {
      box.classList.add('is-empty');
      if (typeof fallback === 'string') box.appendChild(span('initial', fallback));
      else box.appendChild(fallback || icon('i-desktop'));
    }
    const camera = s.settings && s.settings.camera && s.settings.camera !== 'none';
    if (selected && camera && width > 90 && height > 90) {
      const bubble = span('cam-bubble');
      Object.assign(bubble.style, bubbleStyle(width, height, s.settings));
      bubble.appendChild(icon('i-camera'));
      box.appendChild(bubble);
    }
    shot.appendChild(box);
    if (selected) shot.appendChild(icon('i-check', 'badge'));
    b.appendChild(shot);
    const text = span('card-label');
    text.appendChild(span('card-name', name));
    if (meta) text.appendChild(span('card-meta', meta));
    b.appendChild(text);
    b.title = name;
    return b;
  }

  function renderTargets(s, locked) {
    const target = s.target;
    const key = targetKey(target);
    // A choice made anywhere (panel, picker, this page) brings its tab forward.
    if (key !== src.targetKey) {
      const first = src.targetKey === undefined;
      src.targetKey = key;
      if (target) src.tab = targetTab(target);
      if (!first && target && target.kind === 'region') refreshSources();
    }
    const tab = src.tab || targetTab(target);
    const waiting = s.phase === 'selecting' || pending === 'target-region';
    const devMonitors = (s.devices && Array.isArray(s.devices.monitors)) ? s.devices.monitors : [];
    const data = src.data || {};

    for (const b of document.querySelectorAll('.source-tabs [role="tab"]')) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = locked;
    }
    el.targets.setAttribute('aria-labelledby', `tab-${tab}`);
    el.sourceTools.hidden = tab !== 'window';
    el.pickOnScreen.disabled = locked;

    const model = {
      tab, key, at: src.at, loading: src.loading && !src.data, waiting,
      available: target ? target.available : null, label: target ? target.label : null,
      cam: [s.settings?.camera, s.settings?.cameraSize, s.settings?.cameraCorner],
      cameras: ((s.devices && s.devices.cameras) || []).map((c) => [c.id, c.name]),
      monitors: devMonitors.map((m) => [m.id, m.name, m.width, m.height, m.pixelWidth, m.pixelHeight]),
    };

    if (changed('targets', model)) {
      const cards = [];
      if (tab === 'screen') {
        const thumbs = new Map((data.monitors || []).map((m) => [m.id, m.thumb]));
        for (const m of devMonitors) {
          const selected = !!target && target.kind === 'monitor' && (target.monitor === m.id || (target.monitor == null && target.label === m.name));
          const size = dims(m.pixelWidth || m.width, m.pixelHeight || m.height);
          const card = sourceCard({ name: m.name || String(m.id), meta: size, thumb: thumbs.get(m.id), width: m.width, height: m.height, selected,
            label: `Full display ${m.name || m.id}${size ? `, ${size}` : ''}` }, s);
          card.dataset.monitorId = String(m.id);
          cards.push(card);
        }
        if (!cards.length) cards.push(span('empty', 'No displays found.'));
      } else if (tab === 'window') {
        const list = (data.windows || []).slice();
        if (target && target.kind === 'window' && !list.some((w) => w.address === target.address)) {
          list.unshift({ address: target.address, title: target.label, app: '', visible: true, width: target.width, height: target.height });
        }
        for (const w of list) {
          const selected = !!target && target.kind === 'window' && target.address === w.address;
          const title = String(w.title || '').replace(/^[^\p{L}\p{N}]+/u, '') || w.title || 'Window';
          const app = w.app ? appName(w.app) : '';
          const meta = selected && target.available === false ? 'No longer visible'
            : w.visible === false ? `${app || 'Window'}, workspace ${w.workspace}` : app;
          const card = sourceCard({ name: title, meta, thumb: w.thumb, width: w.width, height: w.height, selected,
            fallback: (app || title).replace(/^[^a-z0-9]+/i, '').charAt(0).toUpperCase() || '?',
            label: `${title}${meta ? `, ${meta}` : ''}` }, s);
          card.dataset.address = w.address;
          cards.push(card);
        }
        if (!cards.length) cards.push(span('empty', src.data ? 'No open windows. Open the app you want to record, then come back.' : 'Looking for windows'));
      } else if (tab === 'camera') {
        // Camera only: one card per camera, with no screen in the recording.
        for (const c of (s.devices && s.devices.cameras) || []) {
          const selected = !!target && target.kind === 'camera' && s.settings.camera === c.id;
          const card = sourceCard({ name: c.name || String(c.id), width: 16, height: 9, selected, fallback: icon('i-camera'), label: `Camera ${c.name || c.id}` }, { settings: { camera: 'none' } });
          card.dataset.camera = String(c.id);
          cards.push(card);
        }
        if (!cards.length) cards.push(span('empty', 'No cameras found.'));
      } else {
        const area = target && target.kind === 'region' ? target : null;
        const size = area && dims(area.pixelWidth || area.width, area.pixelHeight || area.height);
        const card = sourceCard(area
          ? { name: waiting ? 'Drawing an area' : 'Area', meta: size, thumb: data.area, width: area.width, height: area.height, selected: true, fallback: icon('i-marquee'), label: `Area ${size}. Draw a different area` }
          : { name: waiting ? 'Drawing an area' : 'Draw an area on screen', meta: 'Drag across the part of the screen to record', width: 16, height: 9, fallback: icon('i-marquee') }, s);
        card.dataset.draw = '1';
        card.classList.add('is-area');
        cards.push(card);
        if (area) {
          const again = document.createElement('button');
          again.type = 'button';
          again.className = 'btn btn-plain draw-again';
          again.dataset.draw = '1';
          again.appendChild(icon('i-marquee'));
          again.appendChild(span('', 'Draw a different area'));
          cards.push(again);
        }
      }
      el.targets.dataset.tab = tab;
      el.targets.classList.toggle('single', tab === 'screen' && devMonitors.length < 2);
      el.targets.replaceChildren(...cards);

      el.regionNote.hidden = !target || targetTab(target) !== tab || target.kind === 'monitor' || target.kind === 'camera';
      el.regionNote.textContent = target?.kind === 'window'
        ? (target.available === false ? 'This window is no longer visible. Choose it again before recording.' : 'The recording and camera follow this window as it moves. Keep it on this display.')
        : 'This area stays fixed when windows move.';
    }

    for (const b of el.targets.querySelectorAll('button')) b.disabled = locked;
  }

  // Switching tabs brings back that tab's last choice, as in the panel.
  function chooseTab(tab) {
    if (!state || pending) return;
    src.tab = tab;
    signatures.targets = null;
    const t = state.target;
    if (targetTab(t) !== tab) {
      const memo = (src.data && src.data.memo) || {};
      const m = memo[tab];
      if (tab === 'screen') {
        const ms = (state.devices && state.devices.monitors) || [];
        const pick = (m && ms.find((x) => x.id === m.monitor)) || ms.find((x) => /^eDP/.test(x.id)) || ms[0];
        if (pick) run('target', () => bridge.chooseTarget(pick.id));
      } else if (tab === 'window' && m && ((src.data && src.data.windows) || []).some((w) => w.address === m.address && w.visible)) {
        run('target', () => bridge.chooseSource({ kind: 'window', address: m.address }));
      } else if (tab === 'area' && m) {
        run('target', () => bridge.chooseSource({ kind: 'region', x: m.x, y: m.y, width: m.width, height: m.height }));
      } else if (tab === 'camera' && state.settings.camera !== 'none') {
        run('target', () => bridge.chooseTarget('camera'));
      }
    }
    render();
  }

  function fillSelect(select, key, options, value) {
    const list = options.slice();
    if (value != null && !list.some((o) => o.value === value)) {
      list.push({ value, label: `${value} (not found)` });
    }
    if (changed(key, { list, value })) {
      select.textContent = '';
      for (const o of list) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        select.appendChild(opt);
      }
    }
    if (select.value !== value && value != null) select.value = value;
  }

  function renderInputs(s, locked) {
    const settings = s.settings || {};
    const devices = s.devices || {};

    const mics = Array.isArray(devices.microphones) ? devices.microphones : [];
    // Same names and order as the record panel.
    const micOptions = [];
    if (!mics.some((d) => d.id === 'default_input')) micOptions.push({ value: 'default_input', label: 'Default microphone' });
    for (const d of mics) micOptions.push({ value: String(d.id), label: d.name || String(d.id) });
    micOptions.push({ value: 'none', label: 'No microphone' });
    fillSelect(el.microphone, 'mics', micOptions, settings.microphone ?? 'none');

    const cams = Array.isArray(devices.cameras) ? devices.cameras : [];
    const camOptions = [{ value: 'none', label: 'No camera' }];
    for (const d of cams) camOptions.push({ value: String(d.id), label: d.name || String(d.id) });
    fillSelect(el.camera, 'cams', camOptions, settings.camera ?? 'none');

    el.microphone.disabled = locked;
    el.camera.disabled = locked;

    el.systemAudio.setAttribute('aria-checked', String(!!settings.systemAudio));
    el.systemAudio.disabled = locked;

    const hasCamera = settings.camera && settings.camera !== 'none';
    // A camera profile (camera-profiles/) adds a note and, when it has one, lens correction.
    const profile = hasCamera ? (cams.find(c => c.id === settings.camera) || {}).profile || null : null;
    el.cameraCorrection.hidden = !(profile && profile.lensCorrection);
    el.cameraProfileNote.hidden = !(profile && profile.note);
    el.cameraProfileNote.textContent = profile && profile.note ? `${profile.name}: ${profile.note}` : '';
    el.cameraOptions.hidden = !hasCamera || (src.tab || targetTab(s.target)) === 'camera';
    // A camera-only take records the camera as it is: lighting and lens correction are bubble effects.
    const cameraOnly = (src.tab || targetTab(s.target)) === 'camera';
    if (cameraOnly) el.cameraCorrection.hidden = true;
    document.querySelector('fieldset[data-setting="cameraLighting"]').hidden = cameraOnly;
    el.cameraIcon.querySelector('use').setAttribute('href', hasCamera ? '#i-camera' : '#i-camera-off');
    el.camera.closest('.select-wrap').classList.toggle('off', !hasCamera);
    const hasMic = settings.microphone && settings.microphone !== 'none';
    el.micIcon.querySelector('use').setAttribute('href', hasMic ? '#i-mic' : '#i-mic-off');
    el.microphone.closest('.select-wrap').classList.toggle('off', !hasMic);
    el.preview.hidden = !hasCamera;
    el.preview.disabled = locked || !hasCamera;
    el.preview.setAttribute('aria-pressed', String(!!s.cameraPreview));
    el.preview.title = s.cameraPreview ? 'Hide camera' : 'Show camera';
    el.preview.setAttribute('aria-label', el.preview.title);
    el.preview.setAttribute('aria-busy', String(pending === 'preview'));

    el.refresh.disabled = locked;
    el.refresh.classList.toggle('is-busy', pending === 'refresh');
    el.refresh.setAttribute('aria-busy', String(pending === 'refresh'));
    el.refresh.title = pending === 'refresh' ? 'Refreshing devices' : 'Refresh microphones and cameras';

    for (const fs of el.fieldsets) {
      const key = fs.dataset.setting;
      const value = settings[key] == null ? '' : String(settings[key]);
      for (const input of fs.querySelectorAll('input')) input.checked = input.value === value;
      const noMic = !settings.microphone || settings.microphone === 'none';
      const cleanup = settings.micNoise === 'on' || settings.micRumble === true;
      fs.disabled = locked || (['cameraCorrection','cameraLighting'].includes(key) && !hasCamera)
        || (['micNoise','micGate','micRumble','micBackup'].includes(key) && noMic)
        || (key === 'micGate' && settings.micNoise !== 'on')
        || (key === 'micBackup' && !cleanup)
        || (['cameraBackground','cameraBlur'].includes(key) && !hasCamera);
    }
    renderStudio(locked);
  }

  function renderRecordings(s, locked) {
    const dir = s.outputDir || '';
    // Marks keep the path left to right while the container truncates from the start.
    el.outputDir.textContent = dir ? `\u200e${shortenPath(dir)}\u200e` : 'Recordings folder';
    el.location.hidden = ACTIVE.has(s.phase) || s.phase === 'saved';
    el.openFolder.title = dir ? `Open ${dir}` : 'Open folder';
    el.openFolder.setAttribute('aria-label', dir ? `Open recordings folder, ${dir}` : 'Open recordings folder');
    el.openFolder.disabled = !bridge;

    // Past recordings live in the Library tab; this only sets where new ones go.
    el.changeFolder.disabled = !bridge || typeof bridge.chooseOutputDir !== 'function' || locked || !!s.job?.running;
  }

  // The microphone meter runs only while this page is in view and idle.
  let levelOn = false;
  function syncLevel(s) {
    const mic = s && s.settings && s.settings.microphone;
    const want = !!bridge && typeof bridge.watchLevel === 'function' && ed.view === 'record' && !document.hidden &&
      !!s && !ACTIVE.has(s.phase) && !!mic && mic !== 'none';
    if (want === levelOn) return;
    levelOn = want;
    if (!want) el.micLevel.hidden = true;
    bridge.watchLevel(want).catch(() => {});
  }
  if (bridge && typeof bridge.onLevel === 'function') {
    bridge.onLevel((v) => {
      const show = levelOn && typeof v === 'number' && v >= 0;
      el.micLevel.hidden = !show;
      if (show) el.micLevel.firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, v))})`;
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (state) syncLevel(state);
    if (!document.hidden) refreshSources(150);
  });
  window.addEventListener('focus', () => { if (!src.data || Date.now() - src.at > 4000) refreshSources(250); });

  // A recording's AI title when it has one, else its file name.
  function titleOf(file) {
    if (!file) return '';
    const r = (state && Array.isArray(state.recent) ? state.recent : []).find((x) => x.path === file);
    return (r && r.title) || baseName(file).replace(/\.(mp4|mkv)$/i, '');
  }

  function renderTransport(s) {
    const phase = s.phase;
    const shownTab = src.tab || targetTab(s.target);
    const hasTarget = !!s.target && s.target.available !== false && targetTab(s.target) === shownTab &&
      !(shownTab === 'camera' && (!s.settings || s.settings.camera === 'none'));

    el.time.textContent = formatElapsed(s.elapsed);

    let status;
    switch (phase) {
      case 'selecting': status = 'Waiting for a selection'; break;
      case 'starting': status = 'Starting'; break;
      case 'recording': status = 'Recording'; break;
      case 'paused': status = 'Paused'; break;
      case 'stopping': status = 'Saving the file'; break;
      case 'saved': status = s.lastFile ? `Saved ${titleOf(s.lastFile)}` : 'Saved'; break;
      case 'error': status = 'Not recording'; break;
      default: status = hasTarget ? 'Ready' : shownTab === 'camera' ? 'Choose a camera to record' : shownTab === 'window' ? 'Choose a window to record' : shownTab === 'area' ? 'Draw an area to record' : 'Choose a display to record';
    }
    if (pending === 'start' && phase !== 'starting' && !ACTIVE.has(phase)) status = 'Starting';
    if (el.status.textContent !== status) el.status.textContent = status;
    // While idle, the footer shows where files go; a hint only when Start is blocked.
    el.status.parentElement.hidden = (phase === 'idle' || phase === 'error') && hasTarget && pending !== 'start';
    el.status.title = phase === 'saved' && s.lastFile ? s.lastFile : '';

    const live = phase === 'recording' || phase === 'paused';
    const busyPrimary = phase === 'starting' || phase === 'stopping' || pending === 'start' || pending === 'stop';

    let label;
    if (phase === 'starting' || (pending === 'start' && !live)) label = 'Starting';
    else if (phase === 'stopping' || pending === 'stop') label = 'Saving';
    else if (live) label = 'Stop and save';
    else label = 'Start recording';
    el.primaryLabel.textContent = label;
    el.primary.classList.toggle('is-busy', busyPrimary);
    el.primary.setAttribute('aria-busy', String(busyPrimary));
    const processing = !!(s.job && s.job.running);
    el.primary.disabled = !bridge || busyPrimary || phase === 'selecting' || (!!pending && pending !== 'pause') ||
      (!live && (!hasTarget || processing));
    el.primary.title = !live && processing ? 'Wait for processing to finish'
      : (!live && !hasTarget ? status : '');

    el.pause.hidden = !live;
    el.pause.disabled = !!pending;
    el.pause.classList.toggle('is-busy', pending === 'pause');
    const paused = phase === 'paused';
    el.pauseLabel.textContent = paused ? 'Resume' : 'Pause';
    el.pause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    el.pauseUse.setAttribute('href', paused ? '#i-play' : '#i-pause');
    const keys = s.shortcuts || {};
    el.pause.title = keys.pause ? `${paused ? 'Resume' : 'Pause'} (${keys.pause})` : '';
    if (live) el.primary.title = keys.record ? `Stop and save (${keys.record})` : '';
    else if (!el.primary.title && keys.record) el.primary.title = `Start recording (${keys.record})`;
    for (const b of [el.restart, el.discard]) { b.hidden = !live; b.disabled = !!pending; }
    if (!live && armed) disarm();

    el.openLast.hidden = !(phase === 'saved' && s.lastFile);
    el.editLast.hidden = el.openLast.hidden;
    el.editLast.disabled = !!pending;
    el.editLast.setAttribute('aria-label', s.lastFile ? `Edit ${baseName(s.lastFile)}` : 'Edit recording');
    el.openLast.disabled = !!pending;
    el.openLast.setAttribute('aria-label', s.lastFile ? `Open ${baseName(s.lastFile)}` : 'Open recording');

    document.title = live ? `${paused ? 'Paused' : 'Recording'} ${formatElapsed(s.elapsed)}` : 'VidCapture';
  }

  function renderAlert(s) {
    const message = localError || (s && s.error) || null;
    const show = !!message && message !== dismissedError;
    el.alert.hidden = !show;
    if (show && el.alertText.textContent !== message) el.alertText.textContent = message;
  }

  function render() {
    if (!state) {
      el.status.textContent = bridge ? 'Loading' : 'Unavailable';
      el.primary.disabled = true;
      renderAlert(null);
      return;
    }
    const phase = state.phase;
    document.body.dataset.phase = phase;
    const locked = !bridge || ACTIVE.has(phase) || !!pending;
    renderTargets(state, locked);
    renderInputs(state, locked);
    renderRecordings(state, locked);
    renderTransport(state);
    renderAlert(state);
    syncLevel(state);
    renderJob(state);
    renderView(state);
    renderLibrary(state);
    renderEditorControls();
  }

  /* Events */

  el.targets.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.draw) run('target-region', () => bridge.pickOnScreen('area'));
    else if (b.dataset.address) run('target', () => bridge.chooseSource({ kind: 'window', address: b.dataset.address }));
    else if (b.dataset.monitorId) run('target', () => bridge.chooseTarget(b.dataset.monitorId));
    else if (b.dataset.camera) run('target', () => bridge.chooseSource({ kind: 'camera', device: b.dataset.camera }));
  });
  for (const b of document.querySelectorAll('.source-tabs [role="tab"]')) b.addEventListener('click', () => chooseTab(b.dataset.tab));
  // Arrow keys move between tabs, as tab lists do.
  $('content').querySelector('.source-tabs').addEventListener('keydown', (e) => {
    const tabs = Array.from(document.querySelectorAll('.source-tabs [role="tab"]'));
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n == null) return;
    e.preventDefault();
    tabs[n].focus();
    chooseTab(tabs[n].dataset.tab);
  });
  el.pickOnScreen.addEventListener('click', () => run('target-region', () => bridge.pickOnScreen('window')));

  el.microphone.addEventListener('change', () => saveSetting({ microphone: el.microphone.value }));
  el.camera.addEventListener('change', () => saveSetting({ camera: el.camera.value }));
  el.systemAudio.addEventListener('click', () => {
    if (!state) return;
    saveSetting({ systemAudio: !(state.settings && state.settings.systemAudio) });
  });

  /* Studio settings: camera controls and mic level */

  const ST = {
    controls: document.getElementById('camera-controls'),
    controlsNote: document.getElementById('camera-controls-note'),
    resetRow: document.getElementById('camera-reset-row'),
    reset: document.getElementById('camera-reset'),
    gainRow: document.getElementById('mic-gain-row'),
    gain: document.getElementById('mic-gain'),
    gainValue: document.getElementById('mic-gain-value'),
    micError: document.getElementById('mic-cleanup-error'),
    blur: document.getElementById('camera-blur'),
    backgrounds: document.getElementById('backgrounds'),
    backgroundList: document.getElementById('background-list'),
    backgroundAdd: document.getElementById('background-add'),
    effectsNote: document.getElementById('effects-note'),
    info: null, sig: null, loading: false, timers: new Map(), editing: new Set(), locked: false,
  };
  const SECTION_NAMES = { exposure: 'Exposure', color: 'Color', framing: 'Focus and framing', other: 'Other' };

  async function loadStudio() {
    if (!bridge || typeof bridge.studioInfo !== 'function') return;
    ST.loading = true;
    try { ST.info = await bridge.studioInfo(); } catch (err) { ST.info = { camera: { error: err.message } }; }
    ST.loading = false;
    renderStudio(ST.locked, true);
  }

  // Sends one control change after the slider rests briefly, then shows the camera's answer.
  function sendControl(name, value) {
    clearTimeout(ST.timers.get(name));
    ST.editing.add(name);
    ST.timers.set(name, setTimeout(async () => {
      ST.timers.delete(name);
      try { ST.info = await bridge.setCameraControl(name, value); }
      catch (err) { fail(err); }
      ST.editing.delete(name);
      renderStudio(ST.locked, true);
    }, 140));
  }

  function controlRow(c) {
    const row = document.createElement('div');
    row.className = 'control-row';
    row.dataset.control = c.name;
    const id = `cam-${c.name}`;
    const label = document.createElement(c.type === 'menu' ? 'span' : 'label');
    label.textContent = c.label;
    if (c.type !== 'menu') label.htmlFor = id;
    else label.id = id + '-label';
    row.append(label);
    if (c.type === 'bool') {
      const sw = document.createElement('button');
      sw.type = 'button'; sw.className = 'switch'; sw.id = id; sw.setAttribute('role', 'switch');
      sw.innerHTML = '<span class="switch-thumb"></span>';
      sw.addEventListener('click', () => {
        const next = sw.getAttribute('aria-checked') === 'true' ? 0 : 1;
        sw.setAttribute('aria-checked', String(next === 1));
        sendControl(c.name, next);
      });
      const wrap = document.createElement('div'); wrap.className = 'switch-wrap'; wrap.append(sw);
      row.append(wrap);
    } else if (c.type === 'menu') {
      const seg = document.createElement('div');
      seg.className = 'seg'; seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-labelledby', id + '-label');
      for (const o of c.options) {
        const l = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = id; input.value = String(o.value);
        input.addEventListener('change', () => sendControl(c.name, o.value));
        const span = document.createElement('span'); span.textContent = o.label;
        l.append(input, span); seg.append(l);
      }
      row.append(seg);
    } else {
      const wrap = document.createElement('div'); wrap.className = 'range-wrap';
      const input = document.createElement('input');
      input.type = 'range'; input.id = id; input.min = c.min; input.max = c.max; input.step = c.step;
      const out = document.createElement('output'); out.htmlFor = id;
      input.addEventListener('input', () => { out.textContent = input.value + (c.unit ? ' ' + c.unit : ''); sendControl(c.name, Number(input.value)); });
      input.addEventListener('dblclick', () => { if (Number.isFinite(c.default)) { input.value = c.default; input.dispatchEvent(new Event('input')); } });
      input.title = Number.isFinite(c.default) ? `Double-click to reset to ${c.default}` : '';
      wrap.append(input, out); row.append(wrap);
    }
    return row;
  }

  function updateRow(row, c, locked) {
    const off = locked || c.inactive;
    row.classList.toggle('is-inactive', !!c.inactive);
    if (ST.editing.has(c.name)) return;
    if (c.type === 'bool') { const sw = row.querySelector('.switch'); sw.setAttribute('aria-checked', String(c.value === 1)); sw.disabled = off; }
    else if (c.type === 'menu') { for (const input of row.querySelectorAll('input')) { input.checked = Number(input.value) === c.value; input.disabled = off; } }
    else { const input = row.querySelector('input'); input.value = c.value; input.disabled = off; row.querySelector('output').textContent = c.value + (c.unit ? ' ' + c.unit : ''); }
  }

  function renderStudio(locked, fromLoad) {
    ST.locked = locked;
    if (!state || !state.settings) return;
    const s = state.settings;
    const sig = [s.camera, s.microphone, s.micNoise, s.micGate, s.micRumble, state.phase === 'idle' || state.phase === 'saved' || state.phase === 'error'].join('|');
    if (sig !== ST.sig && !fromLoad) { ST.sig = sig; loadStudio(); }
    const info = ST.info || {};

    // Mic level and cleanup status.
    const mic = info.mic && !info.mic.error ? info.mic : null;
    ST.gainRow.hidden = !mic || s.microphone === 'none';
    if (mic && !ST.editing.has('mic-gain')) { ST.gain.value = mic.percent; ST.gainValue.textContent = mic.percent + '%'; }
    ST.gain.disabled = locked;
    const cleanupError = info.cleanup && info.cleanup.error;
    ST.micError.hidden = !cleanupError;
    ST.micError.textContent = cleanupError || '';

    // Background blur and replacement.
    const fx = info.effects || { available: false, backgrounds: [] };
    const noCam = !s.camera || s.camera === 'none';
    ST.blur.hidden = s.cameraBackground !== 'blur';
    ST.backgrounds.hidden = s.cameraBackground !== 'image';
    ST.effectsNote.hidden = !(ST.info && !fx.available && !noCam);
    ST.backgroundAdd.disabled = locked;
    const names = fx.backgrounds || [];
    const bgKey = names.join('\n');
    if (ST.backgroundList.dataset.key !== bgKey) {
      ST.backgroundList.dataset.key = bgKey;
      ST.backgroundList.replaceChildren(...names.map((name) => {
        const item = document.createElement('div');
        item.className = 'background-item';
        const pick = document.createElement('button');
        pick.type = 'button'; pick.className = 'background-pick'; pick.dataset.name = name;
        pick.setAttribute('role', 'radio'); pick.title = name;
        const img = document.createElement('img');
        img.alt = name; img.loading = 'lazy'; img.src = 'capture-media://background/' + encodeURIComponent(name);
        pick.append(img);
        pick.addEventListener('click', () => saveSetting({ cameraBackground: 'image', cameraBackgroundImage: name }));
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'icon-btn background-remove';
        remove.setAttribute('aria-label', 'Remove ' + name); remove.title = 'Remove';
        remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-x"/></svg>';
        remove.addEventListener('click', async () => {
          try { ST.info = await bridge.removeBackground(name); } catch (err) { fail(err); }
          renderStudio(ST.locked, true);
        });
        item.append(pick, remove);
        return item;
      }));
    }
    for (const pick of ST.backgroundList.querySelectorAll('.background-pick')) {
      const on = pick.dataset.name === s.cameraBackgroundImage;
      pick.setAttribute('aria-checked', String(on));
      pick.disabled = locked;
    }
    for (const btn of ST.backgroundList.querySelectorAll('.background-remove')) btn.disabled = locked;

    // Camera controls, grouped by section.
    const cam = info.camera;
    const controls = cam && Array.isArray(cam.controls) ? cam.controls : [];
    ST.resetRow.hidden = !controls.length;
    ST.reset.disabled = locked;
    if (s.camera === 'none') { ST.controls.replaceChildren(); ST.controlsNote.hidden = true; ST.controls.dataset.key = ''; return; }
    if (cam && cam.error) { ST.controls.replaceChildren(); ST.controlsNote.hidden = false; ST.controlsNote.textContent = 'Camera settings could not be read. ' + cam.error; return; }
    const key = (cam && cam.key || '') + ':' + controls.map((c) => c.name).join(',');
    if (ST.controls.dataset.key !== key) {
      ST.controls.dataset.key = key;
      const parts = [];
      let section = null;
      for (const c of controls) {
        if (c.section !== section) {
          section = c.section;
          const h = document.createElement('h4'); h.className = 'control-section'; h.textContent = SECTION_NAMES[section] || 'Other';
          parts.push(h);
        }
        parts.push(controlRow(c));
      }
      ST.controls.replaceChildren(...parts);
    }
    for (const c of controls) { const row = ST.controls.querySelector(`[data-control="${c.name}"]`); if (row) updateRow(row, c, locked); }
    // Profile lens correction is measured at fixed values (for example zoom and focus).
    const profile = ((state && state.devices && state.devices.cameras) || []).find((c) => c.id === s.camera)?.profile;
    const fitted = profile && profile.lensCorrection && s.cameraCorrection === 'computer' ? Object.entries(profile.fittedAt || {}) : [];
    const drift = fitted.filter(([name, value]) => { const c = controls.find((x) => x.name === name); return c && c.value !== value; });
    ST.controlsNote.hidden = !drift.length;
    ST.controlsNote.textContent = drift.length
      ? `Lens correction is matched to ${fitted.map(([name, value]) => `${(controls.find((x) => x.name === name)?.label || name).toLowerCase()} ${value}`).join(' and ')}. Other values may bend straight lines slightly.`
      : '';
  }

  ST.gain.addEventListener('input', () => {
    ST.gainValue.textContent = ST.gain.value + '%';
    ST.editing.add('mic-gain');
    clearTimeout(ST.timers.get('mic-gain'));
    ST.timers.set('mic-gain', setTimeout(async () => {
      ST.timers.delete('mic-gain');
      try { ST.info = await bridge.setMicLevel(Number(ST.gain.value)); } catch (err) { fail(err); }
      ST.editing.delete('mic-gain');
      renderStudio(ST.locked, true);
    }, 140));
  });
  ST.backgroundAdd.addEventListener('click', async () => {
    ST.backgroundAdd.disabled = true;
    try { ST.info = await bridge.addBackground(); } catch (err) { fail(err); }
    renderStudio(ST.locked, true);
  });
  ST.reset.addEventListener('click', async () => {
    ST.reset.disabled = true;
    try { ST.info = await bridge.resetCameraControls(); } catch (err) { fail(err); }
    renderStudio(ST.locked, true);
  });

  for (const fs of el.fieldsets) {
    fs.addEventListener('change', (e) => {
      const input = e.target;
      if (!input || input.type !== 'radio') return;
      const key = fs.dataset.setting;
      const raw = input.value;
      const value = key === 'fps' ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
      saveSetting({ [key]: value });
    });
  }

  el.preview.addEventListener('click', () => run('preview', () => bridge.previewCamera()));
  el.refresh.addEventListener('click', () => run('refresh', () => bridge.refreshDevices()));

  el.primary.addEventListener('click', () => {
    if (!state) return;
    const live = state.phase === 'recording' || state.phase === 'paused';
    if (live) run('stop', () => bridge.stop());
    else run('start', () => bridge.start());
  });
  el.pause.addEventListener('click', () => run('pause', () => bridge.pause()));
  // Restart and Delete take: the first click arms the button, a second click within a few seconds acts.
  const ARM = { restart: ['Restart', 'Confirm restart'], discard: ['Delete take', 'Confirm delete'] };
  function disarm() {
    if (!armed) return;
    const b = el[armed]; b.classList.remove('is-armed'); b.querySelector('.label').textContent = ARM[armed][0];
    b.removeAttribute('aria-pressed'); armed = null; clearTimeout(armTimer);
  }
  for (const kind of ['restart', 'discard']) {
    el[kind].addEventListener('click', () => {
      if (armed === kind) { disarm(); run(kind, () => bridge[kind]()); return; }
      disarm(); armed = kind;
      const b = el[kind]; b.classList.add('is-armed'); b.querySelector('.label').textContent = ARM[kind][1];
      armTimer = setTimeout(disarm, 5000);
    });
    el[kind].addEventListener('blur', () => { if (armed === kind) setTimeout(() => { if (document.activeElement !== el[kind]) disarm(); }, 0); });
  }

  async function openPath(path) {
    if (!bridge || !path) return;
    try {
      await bridge.openFile(path);
    } catch (err) {
      localError = errorMessage(err);
      dismissedError = null;
      render();
    }
  }

  el.openLast.addEventListener('click', () => { if (state) openPath(state.lastFile); });
  el.editLast.addEventListener('click', () => { if (state && state.lastFile) openEditor(state.lastFile); });

  el.changeFolder.addEventListener('click', async () => {
    if (!bridge || typeof bridge.chooseOutputDir !== 'function') return;
    try { await bridge.chooseOutputDir(); } catch (err) { localError = errorMessage(err); dismissedError = null; render(); }
  });

  el.openFolder.addEventListener('click', async () => {
    if (!bridge) return;
    try { await bridge.openFolder(); } catch (err) { localError = errorMessage(err); dismissedError = null; render(); }
  });

  el.alertDismiss.addEventListener('click', () => {
    dismissedError = el.alertText.textContent;
    localError = null;
    render();
  });

  el.minimize.addEventListener('click', async () => {
    try { await bridge.minimize(); } catch (err) { localError = errorMessage(err); render(); }
  });
  el.close.addEventListener('click', async () => {
    try { await bridge.close(); } catch (err) { localError = errorMessage(err); render(); }
  });

  /* Editor
     The edit plan is a list of kept ranges in original source seconds. The source file is never
     modified; the plan is saved through the bridge and exported to a separate copy on request. */

  const MIN_RANGE = 0.1;
  const MIN_SELECTION = 0.05;
  const EPS = 0.001;

  const E = {
    viewRecord: $('view-record'),
    viewEdit: $('view-edit'),
    empty: $('editor-empty'),
    main: $('editor-main'),
    name: $('edit-name'),
    meta: $('edit-meta'),
    video: $('video'),
    stageMsg: $('stage-msg'),
    play: $('play'),
    playUse: $('play').querySelector('use'),
    clockNow: $('clock-now'),
    clockTotal: $('clock-total'),
    summary: $('edit-summary'),
    timeline: $('timeline'),
    track: $('track'),
    waveform: $('waveform'),
    waveformStatus: $('waveform-status'),
    removed: $('removed'),
    selection: $('selection'),
    playhead: $('playhead'),
    scale: $('scale'),
    selStart: $('sel-start'),
    selEnd: $('sel-end'),
    cut: $('cut'),
    trim: $('trim'),
    undo: $('undo'),
    reset: $('reset'),
    status: $('edit-status'),
    folioHelp: $('folio-help'),
    enhance: $('enhance'),
    enhanceMode: $('enhance-mode'),
    exportBtn: $('export'),
    jobbar: $('jobbar'),
    jobTitle: $('job-title'),
    jobDetail: $('job-detail'),
    jobCancel: $('job-cancel'),
    jobOpen: $('job-open'),
    jobEdit: $('job-edit'),
    jobDismiss: $('job-dismiss'),
  };

  const statusText = span('');
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'text-btn';
  retryBtn.textContent = 'Try again';
  retryBtn.hidden = true;
  E.status.append(statusText, retryBtn);

  const ed = {
    view: 'record',
    session: null,
    loadingPath: null,
    loadToken: 0,
    drag: null,
    raf: 0,
    jobDismissed: null,
    canceling: false,
    scaleFor: null,
  };

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  const r3 = (x) => Math.round(x * 1000) / 1000;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function normalizeKeep(ranges, duration) {
    const max = duration > 0 ? duration : Infinity;
    const list = (Array.isArray(ranges) ? ranges : [])
      .filter((r) => Array.isArray(r) && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])))
      .map((r) => [clamp(Number(r[0]), 0, max), clamp(Number(r[1]), 0, max)])
      .filter((r) => r[1] > r[0])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of list) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + EPS) last[1] = Math.max(last[1], r[1]);
      else merged.push(r.slice());
    }
    return merged.filter((r) => r[1] - r[0] >= MIN_RANGE - EPS).map((r) => [r3(r[0]), r3(r[1])]);
  }

  const sameKeep = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const keptDuration = (keep) => keep.reduce((sum, r) => sum + (r[1] - r[0]), 0);

  function isFull(keep, duration) {
    return keep.length === 1 && keep[0][0] <= 0.01 && keep[0][1] >= duration - 0.01;
  }

  function removedRanges(keep, duration) {
    const out = [];
    let cursor = 0;
    for (const [a, b] of keep) {
      if (a - cursor > 0.01) out.push([cursor, a]);
      cursor = b;
    }
    if (duration - cursor > 0.01) out.push([cursor, duration]);
    return out;
  }

  function subtractRange(keep, a, b) {
    const out = [];
    for (const [s, e] of keep) {
      if (e <= a || s >= b) { out.push([s, e]); continue; }
      if (a > s) out.push([s, a]);
      if (e > b) out.push([b, e]);
    }
    return out;
  }

  function intersectRange(keep, a, b) {
    return keep.map(([s, e]) => [Math.max(s, a), Math.min(e, b)]).filter((r) => r[1] > r[0]);
  }

  function formatClock(seconds) {
    const t = Math.max(0, Math.round((Number(seconds) || 0) * 100) / 100);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function formatShort(seconds) {
    const t = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // Accepts seconds ("83.5") or timecode ("1:23.5", "0:01:23.5"). Returns null for empty, NaN for invalid.
  function parseClock(text) {
    const str = String(text || '').trim();
    if (!str) return null;
    const parts = str.split(':');
    if (parts.length > 3) return NaN;
    let total = 0;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      if (!(last ? /^\d+(\.\d*)?$|^\.\d+$/ : /^\d+$/).test(parts[i])) return NaN;
      const n = Number(parts[i]);
      if (!last && i > 0 && n >= 60) return NaN;
      total = total * 60 + n;
    }
    if (parts.length > 1 && Number(parts[parts.length - 1]) >= 60) return NaN;
    return total;
  }

  /* Opening media */

  async function openEditor(path) {
    if (!bridge || !path) return;
    if (typeof bridge.getMedia !== 'function') {
      fail(new Error('Editing is not available in this version of VidCapture.'));
      render();
      return;
    }
    setView('edit');
    if (ed.session && ed.session.path === path) return;
    ed.notice = null;

    const token = ++ed.loadToken;
    if (ed.session) flushSave(ed.session);
    ed.session = null;
    ed.loadingPath = path;
    stopTicker();
    E.video.pause();
    E.video.removeAttribute('src');
    E.video.load();
    drawTimeline();
    renderEditorControls();

    try {
      const media = await bridge.getMedia(path);
      if (token !== ed.loadToken) return;
      if (media && media.editedFrom && media.editedFrom !== path) {
        // A saved version is a finished render; keep editing its project instead.
        ed.loadingPath = null;
        return openEditor(media.editedFrom);
      }
      if (!media || typeof media.url !== 'string') throw new Error('This recording could not be opened.');
      const duration = Number(media.duration) > 0 ? Number(media.duration) : 0;
      let keep = normalizeKeep(media.keep, duration);
      if (!keep.length && duration) keep = [[0, r3(duration)]];
      ed.session = {
        path: media.path || path,
        media,
        duration,
        keep,
        undo: [],
        sel: null,
        version: 0,
        savedVersion: 0,
        saving: false,
        saveTimer: 0,
        saveError: null,
        videoError: false,
        ready: false,
        waveform: null, waveformError: null, cutIndex: null,
      };
      ed.loadingPath = null;
      E.video.src = media.url;
      const session=ed.session;
      if (bridge.getTranscript) loadTranscript(session);
      bridge.getWaveform(session.path).then(wave=>{if(ed.session===session){session.waveform=wave;drawWaveform();}}).catch(error=>{if(ed.session===session){session.waveformError=errorMessage(error);drawWaveform();}});
    } catch (err) {
      if (token !== ed.loadToken) return;
      ed.loadingPath = null;
      fail(err);
    }
    drawTimeline();
    render();
  }

  function setView(view) {
    if (view === ed.view) return;
    ed.view = view;
    if (view === 'record') {
      refreshSources();
      E.video.pause();
      if (ed.session) flushSave(ed.session);
    }
    render();
  }

  /* Saving the edit plan: debounced, one request in flight, latest plan always wins. */

  function scheduleSave(s) {
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(() => { s.saveTimer = 0; pumpSave(s); }, 350);
  }

  function flushSave(s) {
    if (s.saveTimer) { clearTimeout(s.saveTimer); s.saveTimer = 0; }
    pumpSave(s);
  }

  async function pumpSave(s) {
    if (s.saving || s.savedVersion >= s.version || !bridge) return;
    s.saving = true;
    const version = s.version;
    const keep = s.keep.map((r) => r.slice());
    if (s === ed.session) renderEditorControls();
    try {
      const res = await bridge.saveEdits(s.path, keep);
      s.saveError = null;
      s.savedVersion = Math.max(s.savedVersion, version);
      if (res && Array.isArray(res.keep) && s.version === version) {
        const norm = normalizeKeep(res.keep, s.duration);
        if (norm.length && !sameKeep(norm, s.keep)) {
          s.keep = norm;
          if (s === ed.session) drawTimeline();
        }
      }
    } catch (err) {
      s.saveError = errorMessage(err);
    } finally {
      s.saving = false;
      if (!s.saveError && s.version > s.savedVersion && !s.saveTimer) pumpSave(s);
      if (s === ed.session) renderEditorControls();
    }
  }

  retryBtn.addEventListener('click', () => {
    const s = ed.session;
    if (!s) return;
    s.saveError = null;
    flushSave(s);
  });

  window.captureFlushEdits = async () => {
    const s = ed.session;
    if (!s) return;
    flushSave(s);
    while (s.saving || s.saveTimer) await new Promise(resolve => setTimeout(resolve, 20));
    if (s.savedVersion < s.version) throw new Error(s.saveError || 'Your edits could not be saved. Try again before closing.');
  };

  window.addEventListener('pagehide', () => { if (ed.session) flushSave(ed.session); });

  /* Edit operations */

  function applyKeep(next, undoable = true) {
    const s = ed.session;
    if (!s || !s.duration) return false;
    const norm = normalizeKeep(next, s.duration);
    if (!norm.length || keptDuration(norm) < MIN_RANGE) {
      fail(new Error('That would remove the whole recording. Keep at least part of it.'));
      render();
      return false;
    }
    if (sameKeep(norm, s.keep)) return false;
    ed.notice = null;
    if (undoable) {
      s.undo.push(s.keep);
      if (s.undo.length > 200) s.undo.shift();
    }
    s.keep = norm;
    s.version += 1;
    scheduleSave(s);
    drawTimeline();
    snapIntoKeep(E.video.currentTime, 1);
    renderEditorControls();
    return true;
  }

  function validSelection(s) {
    return !!(s && s.sel && s.sel[1] - s.sel[0] >= MIN_SELECTION);
  }

  function cutSelection() {
    const s = ed.session;
    if (!validSelection(s)) return;
    const next=s.cutIndex!==null?adjustedCut(s.keep,s.cutIndex,s.sel,s.duration)?.keep:subtractRange(s.keep,s.sel[0],s.sel[1]);
    if (next&&applyKeep(next)) {
      setSelection(null);
      keepFocusOnTimeline();
    }
  }

  // Cut and Trim disable themselves once the selection clears; keep keyboard users on the timeline.
  function keepFocusOnTimeline() {
    const a = document.activeElement;
    if (!a || a === document.body || a === E.cut || a === E.trim) E.timeline.focus({ preventScroll: true });
  }

  function trimToSelection() {
    const s = ed.session;
    if (!validSelection(s)) return;
    if (applyKeep(intersectRange(s.keep, s.sel[0], s.sel[1]))) {
      setSelection(null);
      seek(s.keep[0][0]);
      keepFocusOnTimeline();
    }
  }

  function undo() {
    const s = ed.session;
    if (!s || !s.undo.length) return;
    setSelection(null);applyKeep(s.undo.pop(), false);
  }

  function resetEdits() {
    const s = ed.session;
    if (!s || !s.duration || isFull(s.keep, s.duration)) return;
    setSelection(null);applyKeep([[0, s.duration]]);
  }

  function setSelection(sel) {
    const s = ed.session;
    if (!s) return;
    if(!sel)s.cutIndex=null;
    s.sel = sel ? [r3(clamp(sel[0], 0, s.duration)), r3(clamp(sel[1], 0, s.duration))] : null;
    drawSelection();
    syncInputs();
    renderEditorControls();
  }

  /* Playback that skips removed ranges */

  // Returns the nearest kept time; dir > 0 moves forward out of a removed range, dir < 0 backward.
  function snapTime(t, dir) {
    const s = ed.session;
    if (!s || !s.keep.length) return t;
    for (let i = 0; i < s.keep.length; i++) {
      const [a, b] = s.keep[i];
      if (t >= a && t < b) return t;
      if (t < a) {
        if (dir < 0 && i > 0) return Math.max(s.keep[i - 1][0], s.keep[i - 1][1] - 0.05);
        return a;
      }
    }
    return s.keep[s.keep.length - 1][1];
  }

  function snapIntoKeep(t, dir) {
    const s = ed.session;
    if (!s || !s.keep.length || !s.ready) return;
    const target = snapTime(t, dir);
    if (Math.abs(target - t) > 0.01) E.video.currentTime = target;
  }

  function enforceKeep() {
    const s = ed.session;
    if (!s || !s.keep.length || !s.ready) return;
    const t = E.video.currentTime;
    for (const [a, b] of s.keep) {
      if (t >= a - 0.02 && t < b - 0.03) return;
      if (t < a) { E.video.currentTime = a; return; }
    }
    const end = s.keep[s.keep.length - 1][1];
    if (!E.video.paused) E.video.pause();
    if (Math.abs(t - end) > 0.05) E.video.currentTime = end;
  }

  function seek(t, dir = 1) {
    const s = ed.session;
    if (!s || !s.ready) return;
    E.video.currentTime = snapTime(clamp(t, 0, s.duration), dir);
    updatePlayhead();
  }

  function togglePlay() {
    const s = ed.session;
    if (!s || !s.ready) return;
    if (E.video.paused) {
      const end = s.keep[s.keep.length - 1][1];
      if (E.video.currentTime >= end - 0.05) E.video.currentTime = s.keep[0][0];
      const p = E.video.play();
      if (p && p.catch) p.catch((err) => { if (err && err.name !== 'AbortError') { fail(err); render(); } });
    } else {
      E.video.pause();
    }
  }

  function tick() {
    enforceKeep();
    updatePlayhead();
    ed.raf = E.video.paused ? 0 : requestAnimationFrame(tick);
  }

  function stopTicker() {
    if (ed.raf) cancelAnimationFrame(ed.raf);
    ed.raf = 0;
  }

  const speedControl = $('playback-speed');
  try {
    const saved = localStorage.getItem('capture-playback-speed');
    if ([...speedControl.options].some(option => option.value === saved)) speedControl.value = saved;
  } catch {}
  function applyPlaybackSpeed() {
    E.video.defaultPlaybackRate = Number(speedControl.value);
    E.video.playbackRate = Number(speedControl.value);
    E.video.preservesPitch = true;
  }
  speedControl.addEventListener('change', () => {
    applyPlaybackSpeed();
    try { localStorage.setItem('capture-playback-speed', speedControl.value); } catch {}
  });
  E.video.addEventListener('loadedmetadata', () => {
    applyPlaybackSpeed();
    const s = ed.session;
    if (!s) return;
    if (!s.duration && Number.isFinite(E.video.duration)) {
      s.duration = E.video.duration;
      if (!s.keep.length) s.keep = [[0, r3(s.duration)]];
    }
    s.ready = true;
    s.videoError = false;
    if (s.keep.length) E.video.currentTime = s.keep[0][0];
    drawTimeline();
    renderEditorControls();
  });
  E.video.addEventListener('error', () => {
    const s = ed.session;
    if (!s || !E.video.getAttribute('src')) return;
    s.videoError = true;
    renderEditorControls();
  });
  E.video.addEventListener('play', () => {
    E.playUse.setAttribute('href', '#i-pause');
    E.play.setAttribute('aria-label', 'Pause');
    E.play.title = 'Pause (Space)';
    stopTicker();
    ed.raf = requestAnimationFrame(tick);
  });
  const onStopped = () => {
    E.playUse.setAttribute('href', '#i-play');
    E.play.setAttribute('aria-label', 'Play');
    E.play.title = 'Play (Space)';
    stopTicker();
    updatePlayhead();
  };
  E.video.addEventListener('pause', onStopped);
  E.video.addEventListener('ended', onStopped);
  E.video.addEventListener('timeupdate', () => { enforceKeep(); updatePlayhead(); });
  E.video.addEventListener('seeking', () => { enforceKeep(); updatePlayhead(); });

  /* Timeline drawing */

  function pct(t, duration) {
    return `${(clamp(t / duration, 0, 1) * 100).toFixed(4)}%`;
  }

  function sourceToEdited(time,keep) {
    let total=0;for(const [a,b] of keep){if(time<a)return total;if(time<=b)return total+time-a;total+=b-a;}return total;
  }
  function editedToSource(time,keep) {
    let total=0;for(const [a,b] of keep){if(time<total+b-a-EPS)return a+Math.max(0,time-total);total+=b-a;}return keep.at(-1)?.[1]||0;
  }
  function updatePlayhead() {
    const s = ed.session;
    const duration = s ? keptDuration(s.keep) : 0;
    const t = s && s.ready ? sourceToEdited(E.video.currentTime,s.keep) : 0;
    E.playhead.style.left = duration ? pct(t, duration) : '0%';
    E.playhead.hidden = !duration;
    setText(E.clockNow, formatClock(t));
    E.timeline.setAttribute('aria-valuenow', String(Math.round(t * 10) / 10));
    E.timeline.setAttribute('aria-valuetext', `${formatClock(t)} of ${formatClock(duration)}`);
  }

  function drawSelection() {
    const s = ed.session;
    if (!s || !s.sel || !s.duration || s.cutIndex !== null) { E.selection.hidden = true; return; }
    E.selection.hidden = false;
    const a=sourceToEdited(s.sel[0],s.keep),b=sourceToEdited(s.sel[1],s.keep),duration=keptDuration(s.keep);
    E.selection.style.left=pct(a,duration);E.selection.style.width=pct(b-a,duration);
  }

  let timelineZoom=1;
  function drawWaveform() {
    const s=ed.session,canvas=E.waveform,rect=E.track.getBoundingClientRect();
    const width=Math.max(1,Math.min(12000,Math.round(rect.width*(window.devicePixelRatio||1))));
    canvas.width=width;canvas.height=160;
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,width,160);
    const peaks=s?.waveform?.peaks;
    E.waveformStatus.textContent=s?.waveformError?'Waveform unavailable. Reopen the recording to retry.':!s?'Audio waveform':!s.waveform?'Loading audio waveform…':!s.waveform.hasAudio?'No audio in this recording':'Audio waveform';
    if(!peaks?.length)return;
    const max=Math.max(.02,...peaks);ctx.fillStyle='#a4c3b2';
    const duration=keptDuration(s.keep);let offset=0;
    for(const [start,end] of s.keep) {
      const left=offset/duration*width,right=(offset+end-start)/duration*width;
      for(let x=Math.floor(left);x<right;x+=2) {
        const a=Math.floor((start+Math.max(0,x-left)/width*duration)/s.duration*peaks.length);
        const b=Math.max(a+1,Math.ceil(Math.min(end,start+(x+2-left)/width*duration)/s.duration*peaks.length));let peak=0;
        for(let i=a;i<b&&i<peaks.length;i++)peak=Math.max(peak,peaks[i]);
        const height=Math.max(1,Math.sqrt(peak/max)*134);ctx.fillRect(x,(160-height)/2,1.5,height);
      }
      offset+=end-start;
    }
  }
  new ResizeObserver(drawWaveform).observe(E.track);
  function zoomTimeline(factor,clientX=null) {
    const viewport=$('timeline-viewport'),rect=viewport.getBoundingClientRect();
    const anchor=clientX===null?rect.width/2:clamp(clientX-rect.left,0,rect.width);
    const fraction=(viewport.scrollLeft+anchor)/Math.max(1,E.timeline.scrollWidth);
    timelineZoom=clamp(timelineZoom*factor,1,16);E.timeline.style.width=`${timelineZoom*100}%`;
    $('zoom-level').textContent=`${timelineZoom}×`;$('zoom-out').disabled=timelineZoom===1;$('zoom-in').disabled=timelineZoom===16;
    viewport.scrollLeft=fraction*E.timeline.scrollWidth-anchor;drawWaveform();
  }
  $('zoom-in').addEventListener('click',()=>zoomTimeline(2));
  $('zoom-out').addEventListener('click',()=>zoomTimeline(.5));
  $('timeline-viewport').addEventListener('wheel',e=>{if(e.metaKey||e.ctrlKey){e.preventDefault();zoomTimeline(e.deltaY<0?2:.5,e.clientX);}},{passive:false});

  function adjustedCut(keep,index,range,duration) {
    const cuts=removedRanges(keep,duration),old=cuts[index];if(!old)return null;
    const min=index?cuts[index-1][1]+MIN_RANGE:0;
    const max=index+1<cuts.length?cuts[index+1][0]-MIN_RANGE:duration;
    const a=clamp(range[0],min,max-MIN_SELECTION),b=clamp(range[1],a+MIN_SELECTION,max);
    cuts[index]=[r3(a),r3(b)];let next=[[0,duration]];
    for(const [start,end] of cuts)next=subtractRange(next,start,end);
    return {keep:normalizeKeep(next,duration),range:cuts[index]};
  }

  function drawTimeline() {
    const s = ed.session;
    const duration = s ? keptDuration(s.keep) : 0;
    E.removed.textContent = '';
    if (s && duration) {
      for (const [index, [a, b]] of removedRanges(s.keep, s.duration).entries()) {
        const d = document.createElement('div');
        d.className = 'removed';
        d.style.left = pct(sourceToEdited(a,s.keep), duration);
        d.style.width = '0px';
        d.title = `Removed ${formatClock(a)} to ${formatClock(b)}`;
        for(const edge of ['start','end']) {
          const handle=document.createElement('button');handle.type='button';handle.className='cut-handle';handle.dataset.cutIndex=index;handle.dataset.cutEdge=edge;
          handle.setAttribute('aria-label',`Cut ${index+1} ${edge}`);handle.setAttribute('role','slider');handle.setAttribute('aria-valuemin','0');handle.setAttribute('aria-valuemax',s.duration);handle.setAttribute('aria-valuenow',edge==='start'?a:b);
          handle.title=`Drag to adjust cut ${edge}. Arrow keys: 0.01 seconds; Shift: 0.1 seconds.`;
          d.appendChild(handle);
        }
        E.removed.appendChild(d);
      }
    }
    if (ed.scaleFor !== duration) {
      ed.scaleFor = duration;
      E.scale.textContent = '';
      if (duration) {
        for (let i = 0; i <= 4; i++) {
          const tick = span(i % 2 ? 'minor' : '', formatShort((duration * i) / 4));
          tick.style.left = `${i * 25}%`;
          E.scale.appendChild(tick);
        }
      }
    }
    E.timeline.setAttribute('aria-valuemax', String(Math.round(duration * 10) / 10));
    setText(E.clockTotal, formatClock(duration));
    drawSelection();
    drawWaveform();
    syncInputs();
    updatePlayhead();
  }

  /* Pointer selection on the timeline */

  function timeAt(clientX) {
    const s = ed.session;
    const rect = E.track.getBoundingClientRect();
    if (!s || !rect.width) return 0;
    return editedToSource(clamp((clientX - rect.left) / rect.width, 0, 1) * keptDuration(s.keep),s.keep);
  }

  E.track.addEventListener('pointerdown', (e) => {
    const s = ed.session;
    if (e.button !== 0 || !s || !s.duration) return;
    e.preventDefault();
    E.timeline.focus({ preventScroll: true });
    const cutHandle=e.target.closest('.cut-handle');
    if(cutHandle) {
      E.video.pause();const index=Number(cutHandle.dataset.cutIndex),range=removedRanges(s.keep,s.duration)[index];
      s.cutIndex=index;setSelection(range);
      ed.drag={mode:'cut',index,edge:cutHandle.dataset.cutEdge,base:s.keep.map(r=>r.slice()),range:range.slice(),id:e.pointerId,x0:e.clientX,secondsPerPixel:keptDuration(s.keep)/E.track.getBoundingClientRect().width};
      E.track.setPointerCapture(e.pointerId);return;
    }
    s.cutIndex=null;
    const handle = e.target.closest('.handle');
    const t = timeAt(e.clientX);
    if (handle && s.sel) ed.drag = { mode: handle.dataset.edge, x0: e.clientX, moved: true };
    else ed.drag = { mode: 'new', anchor: t, x0: e.clientX, moved: false };
    ed.drag.id = e.pointerId;
    E.track.setPointerCapture(e.pointerId);
  });

  E.track.addEventListener('pointermove', (e) => {
    const s = ed.session;
    const d = ed.drag;
    if (!d || !s || e.pointerId !== d.id) return;
    const t = timeAt(e.clientX);
    if(d.mode==='cut') {
      const range=d.range.slice(),delta=(e.clientX-d.x0)*d.secondsPerPixel;range[d.edge==='start'?0:1]=d.edge==='start'?Math.min(range[0]+delta,range[1]-MIN_SELECTION):Math.max(range[1]+delta,range[0]+MIN_SELECTION);
      const next=adjustedCut(d.base,d.index,range,s.duration);
      if(next?.keep.length){s.keep=next.keep;s.sel=next.range;s.cutIndex=d.index;drawTimeline();}return;
    }
    if (d.mode === 'new') {
      if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
      d.moved = true;
      setSelection([Math.min(d.anchor, t), Math.max(d.anchor, t)]);
      return;
    }
    const other = d.mode === 'start' ? s.sel[1] : s.sel[0];
    d.mode = t < other ? 'start' : 'end';
    setSelection([Math.min(t, other), Math.max(t, other)]);
  });

  function endDrag(e) {
    const d = ed.drag;
    if (!d || e.pointerId !== d.id) return;
    ed.drag = null;
    if(d.mode==='cut') {
      const s=ed.session,next=s.keep;s.keep=d.base;
      if(e.type==='pointerup')applyKeep(next);else {s.sel=d.range;drawTimeline();}
      E.track.querySelector(`[data-cut-index="${d.index}"][data-cut-edge="${d.edge}"]`)?.focus({preventScroll:true});
      s.cutIndex=d.index;renderEditorControls();
    }
    if (E.track.hasPointerCapture(e.pointerId)) E.track.releasePointerCapture(e.pointerId);
    if (d.mode === 'new' && !d.moved && e.type === 'pointerup') {
      setSelection(null);
      seek(timeAt(e.clientX));
    }
  }
  E.track.addEventListener('pointerup', endDrag);
  E.track.addEventListener('pointercancel', endDrag);
  E.track.addEventListener('lostpointercapture', (e) => { if (ed.drag && ed.drag.id === e.pointerId) ed.drag = null; });

  E.track.addEventListener('keydown',e=>{
    const handle=e.target.closest('.cut-handle'),s=ed.session;
    if(!handle||!s||!['ArrowLeft','ArrowRight'].includes(e.key))return;
    e.preventDefault();e.stopPropagation();const index=Number(handle.dataset.cutIndex),edge=handle.dataset.cutEdge;
    const range=removedRanges(s.keep,s.duration)[index].slice();range[edge==='start'?0:1]+=(e.key==='ArrowRight'?1:-1)*(e.shiftKey?.1:.01);
    const next=adjustedCut(s.keep,index,range,s.duration);
    if(next?.keep.length){applyKeep(next.keep);s.cutIndex=index;setSelection(next.range);E.track.querySelector(`[data-cut-index="${index}"][data-cut-edge="${edge}"]`)?.focus({preventScroll:true});}
  });

  E.timeline.addEventListener('keydown', (e) => {
    const s = ed.session;
    if (!s || !s.ready) return;
    const step = e.shiftKey ? 10 : 1;
    const t = E.video.currentTime;
    if (e.key === 'ArrowRight') seek(t + step, 1);
    else if (e.key === 'ArrowLeft') seek(t - step, -1);
    else if (e.key === 'Home') seek(s.keep[0][0]);
    else if (e.key === 'End') seek(s.keep[s.keep.length - 1][1], -1);
    else return;
    e.preventDefault();
  });

  /* Numeric selection inputs */

  function syncInputs() {
    const s = ed.session;
    for (const [input, i] of [[E.selStart, 0], [E.selEnd, 1]]) {
      if (document.activeElement === input) continue;
      input.value = s && s.sel ? formatClock(s.sel[i]) : '';
      input.removeAttribute('aria-invalid');
    }
  }

  function commitInput(input) {
    const s = ed.session;
    if (!s || !s.duration) return;
    const isStart = input === E.selStart;
    const value = parseClock(input.value);
    const otherInput = isStart ? E.selEnd : E.selStart;
    let other = s.sel ? s.sel[isStart ? 1 : 0] : parseClock(otherInput.value);
    if (value === null && (other === null || Number.isNaN(other))) {
      input.removeAttribute('aria-invalid');
      setSelection(null);
      return;
    }
    if (value === null) { input.removeAttribute('aria-invalid'); return; }
    const bad = Number.isNaN(value) || value < 0 || value > s.duration + 0.05;
    if (bad) {
      input.setAttribute('aria-invalid', 'true');
      input.title = `Enter a time from 0 to ${formatClock(s.duration)}, like 83.5 or 1:23.5`;
      return;
    }
    input.removeAttribute('aria-invalid');
    input.title = '';
    if (other === null || Number.isNaN(other)) other = isStart ? s.duration : 0;
    const start = isStart ? value : other;
    const end = isStart ? other : value;
    if (end - start < MIN_SELECTION) {
      input.setAttribute('aria-invalid', 'true');
      input.title = 'Start must be before end';
      return;
    }
    setSelection([start, end]);
    input.value = formatClock(isStart ? s.sel[0] : s.sel[1]);
  }

  for (const input of [E.selStart, E.selEnd]) {
    input.addEventListener('change', () => commitInput(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitInput(input); }
      else if (e.key === 'Escape') { input.blur(); syncInputs(); }
    });
    input.addEventListener('blur', () => { if (!input.getAttribute('aria-invalid')) syncInputs(); });
  }

  /* Buttons and shortcuts */

  E.viewRecord.addEventListener('click', () => setView('record'));
  E.viewEdit.addEventListener('click', () => setView('edit'));
  E.play.addEventListener('click', togglePlay);
  E.cut.addEventListener('click', cutSelection);
  E.trim.addEventListener('click', trimToSelection);
  E.undo.addEventListener('click', undo);
  E.reset.addEventListener('click', resetEdits);

  E.exportBtn.addEventListener('click', () => {
    const s = ed.session;
    if (!s || typeof bridge.exportEdit !== 'function') return;
    flushSave(s);
    const keep = s.keep.map((r) => r.slice());
    run('export', () => bridge.exportEdit(s.path, keep));
  });
  E.enhanceMode.addEventListener('change', renderEditorControls);
  E.enhance.addEventListener('click', () => {
    const s = ed.session;
    const method = E.enhanceMode.value === 'folio' ? 'enhanceAudio' : 'enhanceAudioQuick';
    if (!s || typeof bridge[method] !== 'function') return;
    const source = (s.media && s.media.enhanceSource) || s.path;
    // Cuts do not need saving first: enhancement keeps the timeline, the cut
    // plan travels to the enhanced copy, and the editor moves there when done.
    flushSave(s);
    const keep = s.keep.map((r) => r.slice());
    ed.enhanceFrom = s.path;
    run('enhance', async () => {
      if (typeof bridge.saveEdits === 'function') await bridge.saveEdits(source, keep);
      return bridge[method](source, {noiseReduction:E.enhanceMode.value==='quick-quiet'?'stronger':'standard'});
    });
  });
  E.jobCancel.addEventListener('click', () => {
    ed.canceling = true;
    run('cancel', () => bridge.cancelJob()).then(() => { if (!(state && state.job && state.job.running)) ed.canceling = false; render(); });
  });
  E.jobOpen.addEventListener('click', () => { if(state?.job?.kind==='publish'){run('watch',()=>bridge.openShareLink());return;}if (state && state.job) openPath(state.job.output); });
  E.jobEdit.addEventListener('click', () => { if (state && state.job && state.job.output) openEditor(state.job.output); });
  E.jobDismiss.addEventListener('click', () => {
    if (state && state.job) ed.jobDismissed = jobKey(state.job);
    render();
  });

  /* Transcript: local Parakeet words, optional light punctuation pass. Deleting
     words removes their time from the keep plan, so Undo, playback and Save
     edited copy all work the same as timeline cuts. */

  // var, so renders that run before this block is reached see undefined, not an error.
  var T = {
    box: $('transcript'),
    status: $('transcript-status'),
    text: $('transcript-text'),
    del: $('transcript-delete'),
    ums: $('transcript-ums'),
    make: $('transcript-make'),
    cancel: $('transcript-cancel'),
  };
  var FILLERS = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mhm']);
  const wordKey = (w) => String(w).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const isFillerWord = (w) => FILLERS.has(wordKey(w));
  const PAD = 0.2;
  var builtFor = null, nowIndex = -1, transcriptError = null;

  async function loadTranscript(session) {
    session.transcript = null; session.transcriptAvailable = null;
    try {
      const res = await bridge.getTranscript(session.path);
      if (ed.session !== session) return;
      session.transcript = res && res.transcript && Array.isArray(res.transcript.words) ? res.transcript : null;
      session.transcriptAvailable = !!(res && res.available);
      // Transcripts start on their own; the button remains for a retry.
      const job = state && state.transcriptJob;
      if (!session.transcript && session.transcriptAvailable && !(job && job.stage !== 'failed')) makeTranscript();
    } catch (err) {
      if (ed.session !== session) return;
      session.transcriptAvailable = false; transcriptError = errorMessage(err);
    }
    renderTranscript();
  }

  function makeTranscript() {
    const s = ed.session;
    if (!s || !bridge.makeTranscript) return;
    transcriptError = null;
    const session = s;
    bridge.makeTranscript(s.path).then((t) => {
      if (ed.session === session) { session.transcript = t; builtFor = null; renderTranscript(); }
    }).catch((err) => {
      const msg = errorMessage(err);
      if (!/canceled/i.test(msg) && ed.session === session) transcriptError = msg;
      renderTranscript();
    });
    renderTranscript();
  }

  // Time span for words i..j, reaching halfway into the pauses around them so
  // no clipped syllable is left behind, but never more than PAD seconds.
  function wordSpan(words, i, j, duration) {
    // Transcripts made with measured cut points use them directly.
    if (words[i].cut && words[j].cut) return [Math.max(0, words[i].cut[0]), Math.min(duration, words[j].cut[1])];
    const a = i > 0 ? Math.max((words[i - 1].end + words[i].start) / 2, words[i].start - PAD) : Math.max(0, words[i].start - PAD);
    const b = j < words.length - 1 ? Math.min((words[j].end + words[j + 1].start) / 2, words[j].end + PAD) : Math.min(duration, words[j].end + PAD);
    return [Math.max(0, Math.min(a, words[i].start)), Math.max(b, words[j].end)];
  }

  function isKept(keep, t) {
    for (const [a, b] of keep) { if (t < a) return false; if (t < b) return true; }
    return false;
  }

  function wordCut(s, w) { const c = w.cut || [w.start, w.end]; return !isKept(s.keep, (c[0] + c[1]) / 2); }

  function cutWords(ranges) {
    const s = ed.session;
    if (!s || !ranges.length) return false;
    let next = s.keep;
    for (const [a, b] of ranges) next = subtractRange(next, a, b);
    return applyKeep(next);
  }

  function selectedWordRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!T.text.contains(range.commonAncestorContainer)) return null;
    let lo = Infinity, hi = -1;
    for (const span of T.text.querySelectorAll('.w')) {
      if (range.intersectsNode(span.firstChild || span)) {
        // A selection that only touches the edge of a word does not take it.
        const i = Number(span.dataset.i);
        if (span === range.startContainer.parentElement && range.startOffset >= span.textContent.length) continue;
        if (span === range.endContainer.parentElement && range.endOffset === 0) continue;
        lo = Math.min(lo, i); hi = Math.max(hi, i);
      }
    }
    return hi >= 0 ? [lo, hi] : null;
  }

  function deleteSelectedWords() {
    const s = ed.session, t = s && s.transcript;
    const r = selectedWordRange();
    if (!t || !r) return false;
    cutWords([wordSpan(t.words, r[0], r[1], s.duration)]);
    window.getSelection().removeAllRanges();
    renderTranscript();
    return true;
  }

  // Filler sounds, plus the false start they interrupt: in "that, uh, that"
  // the first "that" goes with the "uh", so the sentence reads cleanly.
  function fillerRanges(s) {
    const words = s.transcript.words, out = [];
    const live = (k) => !wordCut(s, words[k]);
    for (let i = 0; i < words.length; i++) {
      if (!isFillerWord(words[i].text) || !live(i)) continue;
      let j = i;
      while (j + 1 < words.length && isFillerWord(words[j + 1].text)) j++;
      let a = i;
      for (const n of [2, 1]) {
        if (a - n < 0 || j + n >= words.length) continue;
        let same = true;
        for (let k = 0; k < n && same; k++) {
          const before = wordKey(words[a - n + k].text), after = wordKey(words[j + 1 + k].text);
          same = !!before && before === after && live(a - n + k);
        }
        if (same) { a -= n; break; }
      }
      out.push(wordSpan(words, a, j, s.duration));
      i = j;
    }
    return out;
  }

  function removeFillers() {
    const s = ed.session;
    if (!s || !s.transcript) return;
    if (cutWords(fillerRanges(s))) renderTranscript();
  }

  function buildTranscript(s) {
    const words = s.transcript.words;
    const frag = document.createDocumentFragment();
    let p = document.createElement('p');
    words.forEach((w, i) => {
      const gap = i > 0 ? w.start - words[i - 1].end : 0;
      // A long pause, or a shorter one after a sentence, starts a new paragraph.
      if (i > 0 && (gap >= 1.6 || (gap >= 0.9 && /[.?!]$/.test(words[i - 1].text)))) { frag.append(p); p = document.createElement('p'); }
      if (p.childNodes.length) p.append(' ');
      const span = document.createElement('span');
      span.className = isFillerWord(w.text) ? 'w filler' : 'w';
      span.dataset.i = String(i);
      span.textContent = w.text;
      p.append(span);
    });
    frag.append(p);
    T.text.replaceChildren(frag);
    builtFor = s.transcript; nowIndex = -1;
  }

  function markTranscript() {
    const s = ed.session;
    if (!s || !s.transcript || builtFor !== s.transcript) return;
    const words = s.transcript.words;
    for (const span of T.text.querySelectorAll('.w')) span.classList.toggle('cut', wordCut(s, words[Number(span.dataset.i)]));
  }

  function wordAt(words, t) {
    let lo = 0, hi = words.length - 1, found = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].start <= t) { found = m; lo = m + 1; } else hi = m - 1; }
    return found >= 0 && t <= words[found].end + 0.25 ? found : -1;
  }

  function followPlayback() {
    const s = ed.session;
    if (!s || !s.transcript || builtFor !== s.transcript) return;
    const i = wordAt(s.transcript.words, E.video.currentTime);
    if (i === nowIndex) return;
    T.text.querySelector('.w.now')?.classList.remove('now');
    nowIndex = i;
    if (i < 0) return;
    const span = T.text.querySelector(`.w[data-i="${i}"]`);
    if (!span) return;
    span.classList.add('now');
    if (!E.video.paused) {
      const box = T.text.getBoundingClientRect(), r = span.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) span.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function renderTranscript() {
    // A transcript that finishes for another version (for example the source of
    // an enhanced copy) may now be available for the open one.
    const tjob = state && state.transcriptJob;
    if (ed.prevTranscriptJob && !tjob && ed.session && !ed.session.transcript && bridge.getTranscript) { ed.prevTranscriptJob = null; loadTranscript(ed.session); return; }
    ed.prevTranscriptJob = tjob || null;
    if (!T) return;
    const s = ed.session;
    const job = state && state.transcriptJob;
    const mine = !!(s && job && job.file === s.path && job.stage !== 'failed');
    const t = s && s.transcript;
    let status = '';
    if (!s) status = '';
    else if (mine) status = job.stage === 'audio' ? 'Preparing audio' : job.stage === 'words' ? `Finding words ${job.percent || 0}%` : `Adding punctuation ${job.percent || 0}%`;
    else if (transcriptError) status = transcriptError;
    else if (job && job.stage === 'failed' && job.file === s.path && !t) status = job.error || 'The transcript could not be made.';
    else if (t && t.polish && t.polish !== 'complete' && t.polish !== 'off') status = 'Some sections kept the original punctuation.';
    else if (!t && s.transcriptAvailable === false) status = 'Transcription is not installed. Run scripts/setup-transcription.sh.';
    setText(T.status, status);

    T.make.hidden = !s || !!t || mine || s.transcriptAvailable === false;
    T.make.disabled = !!(job && job.stage !== 'failed' && !mine);
    T.make.title = T.make.disabled ? 'Another transcript is being made' : 'Find every word locally, then add punctuation';
    T.cancel.hidden = !mine;
    T.del.hidden = !t;
    T.ums.hidden = !t;
    if (t) {
      if (builtFor !== t) buildTranscript(s);
      markTranscript();
      const left = fillerRanges(s).length;
      T.ums.disabled = !left;
      setText(T.ums, left ? `Remove filler words (${left})` : 'Remove filler words');
      T.del.disabled = !selectedWordRange();
    } else if (builtFor || !T.text.firstChild || T.text.dataset.mode !== (mine ? 'busy' : 'empty')) {
      builtFor = null;
      const empty = document.createElement('p');
      empty.className = 'transcript-empty';
      empty.textContent = mine ? 'Your words will appear here.' : (s && s.transcriptAvailable !== false ? 'Make a transcript to edit by text. Speech recognition runs on this computer.' : '');
      T.text.replaceChildren(empty);
      T.text.dataset.mode = mine ? 'busy' : 'empty';
    }
  }

  T.make.addEventListener('click', makeTranscript);
  T.cancel.addEventListener('click', () => { bridge.cancelTranscript().catch(() => {}); });
  T.ums.addEventListener('click', removeFillers);
  T.del.addEventListener('mousedown', (e) => e.preventDefault()); // keep the word selection
  T.del.addEventListener('click', deleteSelectedWords);
  document.addEventListener('selectionchange', () => {
    const s = ed.session;
    if (s && s.transcript && !T.del.hidden) T.del.disabled = !selectedWordRange();
  });
  // A plain click on a word plays from there; dragging selects words to delete.
  T.text.addEventListener('click', (e) => {
    const span = e.target instanceof Element ? e.target.closest('.w') : null;
    const s = ed.session;
    if (!span || !s || !s.transcript) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    seek(s.transcript.words[Number(span.dataset.i)].start, 1);
    followPlayback();
  });
  E.video.addEventListener('timeupdate', followPlayback);
  E.video.addEventListener('seeked', followPlayback);

  document.addEventListener('keydown', (e) => {
    if (ed.view !== 'edit' || !ed.session || e.defaultPrevented || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === ' ' && !mod) {
      // A keyboard-focused button keeps its normal Space activation.
      if (target && target.closest('button, summary') && target.matches(':focus-visible')) return;
      e.preventDefault();
      togglePlay();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
      e.preventDefault();
      if (!deleteSelectedWords()) cutSelection();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();cutSelection();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape' && ed.session.sel) {
      setSelection(null);
    }
  });

  let sharePath=null;
  $('video-library').addEventListener('click',()=>run('library',()=>bridge.openLibrary()));
  $('share-video').addEventListener('click',()=>{
    sharePath=ed.view==='edit'?ed.session?.path:state?.lastFile;
    if(!sharePath)return;
    $('share-name').value=titleOf(sharePath);
    $('share-dialog').showModal();$('share-name').select();
  });
  $('share-cancel').addEventListener('click',()=>$('share-dialog').close());
  $('share-form').addEventListener('submit',async event=>{
    event.preventDefault();const file=sharePath,title=$('share-name').value.trim();if(!file||!title)return;
    $('share-dialog').close();
    try{await window.captureFlushEdits?.();const keep=ed.session?.path===file?ed.session.keep.map(r=>r.slice()):undefined;await run('publish',()=>bridge.publishVideo(file,title,keep));}catch(error){fail(error);render();}
  });
  $('copy-share').addEventListener('click',async()=>{try{await bridge.copyShareLink();$('copy-share').textContent='Copied';setTimeout(()=>$('copy-share').textContent='Copy link',2000);}catch(error){fail(error);render();}});

  /* Rendering for editor, view switch, and job */

  function jobKey(job) {
    return JSON.stringify([job.kind, job.output, job.error]);
  }

  function renderView(s) {
    document.body.dataset.view = ed.view;
    document.body.classList.toggle("has-session", !!ed.session);
    E.viewRecord.setAttribute('aria-pressed', String(ed.view === 'record'));
    E.viewEdit.setAttribute('aria-pressed', String(ed.view === 'edit'));
    E.viewEdit.disabled = ed.view === 'record' && ACTIVE.has(s.phase);
    E.viewEdit.title = E.viewEdit.disabled ? 'Available after recording' : '';
  }

  // When audio enhancement of the open recording finishes, keep editing the
  // enhanced copy: same cuts (including any made while it ran), same spot.
  function adoptEnhanced(job) {
    const from = ed.enhanceFrom;
    if (!from || !job || job.running) return;
    const audio = job.kind === 'folio' || job.kind === 'fast-audio' || job.kind === 'quick-audio';
    if (!audio || job.error || !job.output) { if (!job.running) ed.enhanceFrom = null; return; }
    ed.enhanceFrom = null;
    const s = ed.session;
    if (!s || s.path !== from) return;
    const keep = s.keep.map((r) => r.slice()), at = E.video.currentTime || 0;
    ed.jobDismissed = jobKey(job);
    flushSave(s);
    (async () => {
      try { if (typeof bridge.saveEdits === 'function') await bridge.saveEdits(job.output, keep); } catch {}
      await openEditor(job.output);
      if (ed.session && ed.session.path === job.output) {
        const seekTo = () => { try { E.video.currentTime = Math.min(at, E.video.duration || at); } catch {} };
        if (E.video.readyState >= 1) seekTo(); else E.video.addEventListener('loadedmetadata', seekTo, { once: true });
        ed.notice = 'Audio enhanced. Your cuts carried over.';
        render();
      }
    })();
  }

  function renderJob(s) {
    const job = s.job;
    const busy=ACTIVE.has(s.phase)||!!job?.running||!!pending;
    $('video-library').hidden=!s.publishingReady;$('video-library').disabled=!!pending;
    $('share-video').disabled=busy||!(ed.view==='edit'?ed.session?.path:s.lastFile);
    $('share-video').title=s.publishingReady?'Upload to vidcapture.stream':'Log in or sign up at vidcapture.stream to share';
    $('copy-share').hidden=!s.share?.url;
    if (!job || job.running) ed.jobDismissed = null;
    adoptEnhanced(job);
    if (!job || !job.running) ed.canceling = false;
    const status = !job ? null : job.running ? 'running' : job.error ? 'failed' : job.output ? 'done' : null;
    const show = !!status && !(status !== 'running' && ed.jobDismissed === jobKey(job));
    E.jobbar.hidden = !show;
    if (!show) return;
    E.jobbar.dataset.status = status;
    const folio = job.kind === 'folio';
    const audio = folio || job.kind === 'fast-audio' || job.kind === 'quick-audio';
    let title;
    let detail;
    if (status === 'running') {
      const connecting = job.kind==='publish' && /^(Opening|Log in or sign up)/.test(job.stage||'');
      title = connecting?'Connect your VidCapture account':job.kind==='publish'?'Sharing on VidCapture':audio ? (folio ? 'Enhancing audio with Folio' : job.kind==='quick-audio' ? 'Enhancing audio with Quick studio' : 'Enhancing audio with fast cleanup') : 'Saving version';
      detail = ed.canceling ? 'Canceling' : (job.stage || 'Working');
    } else if (status === 'done') {
      title = job.kind==='publish'?'Your share link is ready':audio ? 'Enhanced copy saved' : 'Version saved to Recordings';
      detail = job.kind==='publish'?(s.share?.cardWarning||s.share?.url||'Ready to share'):baseName(job.output);
    } else {
      title = job.kind==='publish'?'Video was not shared':audio ? 'Audio was not enhanced' : 'Version was not saved';
      detail = job.error;
    }
    setText(E.jobTitle, title);
    setText(E.jobDetail, detail);
    E.jobDetail.title = status === 'done' ? job.output : '';
    E.jobCancel.hidden = status !== 'running';
    E.jobCancel.disabled = ed.canceling || pending === 'cancel';
    setText(E.jobCancel, ed.canceling ? 'Canceling' : 'Cancel');
    E.jobOpen.hidden = status !== 'done';
    setText(E.jobOpen,job.kind==='publish'?'Watch video':'Open result');
    // A saved version reopens as this same project, so there is nothing new to edit.
    E.jobEdit.hidden = status !== 'done' || job.kind === 'edit' || job.kind === 'publish';
    E.jobOpen.disabled = E.jobEdit.disabled = !!pending;
    E.jobDismiss.hidden = status === 'running';
  }

  function renderEditorControls() {
    const s = ed.session;
    renderTranscript();
    const loading = !!ed.loadingPath;
    E.empty.hidden = !!(s || loading);
    E.main.hidden = !(s || loading);

    setText(E.name, s ? titleOf((s.media && s.media.enhanceSource) || s.path) : titleOf(ed.loadingPath || ''));
    E.name.title = s ? s.path : (ed.loadingPath || '');
    const metaParts = [];
    if (s && dims(s.media.width, s.media.height)) metaParts.push(dims(s.media.width, s.media.height));
    if (s && s.duration) metaParts.push(formatShort(s.duration));
    setText(E.meta, metaParts.join(', '));

    let msg = '';
    if (loading) msg = 'Loading recording';
    else if (s && s.videoError) msg = 'This recording could not be played here. You can still open it in your video player.';
    E.stageMsg.hidden = !msg;
    setText(E.stageMsg, msg);

    const ready = !!(s && s.ready);
    const phase = state ? state.phase : 'idle';
    const recordingBusy = ACTIVE.has(phase);
    const jobRunning = !!(state && state.job && state.job.running);
    const hasCuts = !!(s && s.duration && !isFull(s.keep, s.duration));
    const canSelect = validSelection(s);

    E.play.disabled = !ready;
    E.timeline.setAttribute('aria-disabled', String(!ready));
    E.selStart.disabled = E.selEnd.disabled = !s || !s.duration;
    E.cut.disabled = !canSelect;E.cut.querySelector('span').textContent=s?.cutIndex!==null&&s?.cutIndex!==undefined?'Update cut':'Cut';
    E.trim.disabled = !canSelect;
    E.undo.disabled = !s || !s.undo.length;
    E.reset.disabled = !s || !hasCuts;

    if (hasCuts) {
      const n = removedRanges(s.keep, s.duration).length;
      setText(E.summary, `${n} ${n === 1 ? 'cut' : 'cuts'}, ${formatShort(keptDuration(s.keep))} kept`);
    } else {
      setText(E.summary, '');
    }

    const unsaved = !!(s && s.version > s.savedVersion);
    let status = '';
    if (s && s.saveError && unsaved) status = `Edits not saved. ${s.saveError}`;
    else if (unsaved) status = 'Saving edits';
    else if (hasCuts) status = 'Edits saved. The original file is unchanged.';
    else if (s) status = 'Drag on the timeline to select a range.';
    setText(statusText, status);
    E.status.classList.toggle('is-error', !!(s && s.saveError && unsaved));
    retryBtn.hidden = !(s && s.saveError && unsaved);

    const blockedBy = recordingBusy ? 'Finish recording first' : jobRunning ? 'Wait for the current job to finish' : '';
    E.exportBtn.disabled = !s || !hasCuts || !!blockedBy || !!pending;
    E.exportBtn.title = !hasCuts ? 'Cut or trim first' : blockedBy;
    E.exportBtn.classList.toggle('is-busy', pending === 'export');

    const media = s ? s.media : null;
    const audioReady = media && (E.enhanceMode.value === 'folio' ? media.folioReady : media.quickAudioReady);
    let help = '';
    if (media && !audioReady) help = 'Audio enhancement needs a separately configured local audio runtime. Recording and editing work without it.';
    else if (media && !media.hasAudio) help = 'This recording has no microphone audio to enhance.';
    else if (media && !media.enhanceSource) help = 'This copy has no isolated microphone track to enhance.';
    else if (media && media.enhanced) help = `Audio enhanced with ${media.enhanced === 'folio' ? 'Folio studio' : 'Quick studio'}. Enhance again to try another method.`;
    else if (media) help = E.enhanceMode.value === 'folio' ? 'Folio uses neural restoration and full mastering. Long recordings can take much longer.' : E.enhanceMode.value==='quick-quiet' ? 'Quick studio with stronger noise cleanup and softer pauses.' : 'Fuller voice tone and fast local cleanup. A separate enhanced copy keeps your original safe.';
    setText(E.folioHelp, help);
    if (ed.notice && s) help = ed.notice;
    E.enhance.disabled = !media || !audioReady || !media.enhanceSource || !!blockedBy || !!pending;
    setText(E.enhance, media && media.enhanced ? 'Enhance again' : 'Enhance audio');
    E.enhance.title = blockedBy;
    E.enhanceMode.disabled = !!blockedBy || !!pending;
  }

  /* Library
     Every recording in the output folder as a grid of poster cards, with edited
     and enhanced copies folded into one card as versions. Posters and durations
     load lazily from the main process. Opening a card shows it in the VidCapture
     player with its version history. */

  const L = {
    view: $('view-library'),
    root: $('library'),
    head: document.querySelector('.library-head'),
    grid: $('library-grid'),
    count: $('library-count'),
    empty: $('library-empty'),
    loading: $('library-loading'),
    preview: $('library-preview'),
    video: $('library-video'),
    title: $('library-title'),
    meta: $('library-meta'),
    edit: $('library-edit'),
    share: $('library-share'),
    shareNote: $('library-share-note'),
    copyLink: $('library-copy-link'),
    openLink: $('library-open-link'),
    linkNote: $('library-link-note'),
    close: $('library-close'),
    folder: $('library-folder'),
    versions: $('library-versions'),
    versionList: $('version-list'),
    versionsToggle: $('versions-toggle'),
    versionsCount: $('versions-count'),
  };
  const player = window.VCPlayer ? window.VCPlayer.attach($('library-player')) : null;
  // items: one entry per recording. versions: every file by name, with its recording.
  const lib = { items: [], byRoot: new Map(), versions: new Map(), selected: null, viewing: null, loaded: false, loading: null, again: false, requested: new Set(), recentSig: null, restoring: false, versionsOpen: false };

  function libraryDuration(item) {
    return Number(item.duration) > 0 ? formatShort(item.duration) : '';
  }

  function versionWhen(v) {
    const d = new Date(v.modified);
    if (Number.isNaN(d.getTime())) return '';
    const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleString('en-US', opts).replace(' at ', ', ');
  }

  function cardSub(item) {
    if (item.unreadable) return 'Could not be read';
    const n = item.versions ? item.versions.length : 1;
    return [n > 1 ? `${n} versions` : '', formatBytes(item.bytes)].filter(Boolean).join(', ');
  }

  function libraryPoster(card, item) {
    const box = card.querySelector('.lib-poster');
    const dur = box.querySelector('.lib-duration');
    dur.textContent = libraryDuration(item);
    dur.hidden = !dur.textContent;
    let img = box.querySelector('img');
    if (item.poster) {
      if (!img) {
        img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.addEventListener('load', () => { box.dataset.state = 'ready'; });
        img.addEventListener('error', () => { box.dataset.state = 'missing'; });
        box.prepend(img);
      }
      if (img.getAttribute('src') !== item.poster) img.src = item.poster;
    } else {
      box.dataset.state = item.unreadable ? 'missing' : 'loading';
    }
    card.querySelector('.lib-sub').textContent = cardSub(item);
  }

  const libraryObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      libraryObserver.unobserve(entry.target);
      const item = lib.byRoot.get(entry.target.dataset.root);
      if (item) requestDetails(item.name);
    }
  }, { root: L.root, rootMargin: '300px 0px' }) : null;

  async function requestDetails(name) {
    const entry = lib.versions.get(name);
    if (!entry || entry.version.poster || entry.version.unreadable || lib.requested.has(name)) return;
    lib.requested.add(name);
    let d = null;
    try { d = await bridge.recordingDetails(name); } catch { /* The file vanished or changed; the next refresh will reconcile. */ }
    lib.requested.delete(name);
    const fresh = lib.versions.get(name);
    if (!fresh) return;
    const patch = d ? { duration: d.duration, poster: d.poster, unreadable: !!d.unreadable } : { unreadable: true };
    Object.assign(fresh.version, patch);
    if (fresh.item.name === name) {
      Object.assign(fresh.item, patch);
      const card = L.grid.querySelector(`button[data-root="${CSS.escape(fresh.item.root)}"]`);
      if (card) libraryPoster(card, fresh.item);
    }
    if (lib.selected === fresh.item.root) render();
  }

  function buildLibraryGrid() {
    if (libraryObserver) libraryObserver.disconnect();
    L.grid.textContent = '';
    for (const item of lib.items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lib-card';
      b.dataset.root = item.root;
      b.title = item.title;
      const box = span('lib-poster');
      box.appendChild(icon('i-video', 'lib-placeholder'));
      box.appendChild(span('lib-duration mono'));
      b.appendChild(box);
      b.appendChild(span('lib-title', item.title));
      b.appendChild(span('lib-sub'));
      libraryPoster(b, item);
      li.appendChild(b);
      L.grid.appendChild(li);
      if (!item.poster && !item.unreadable) {
        if (libraryObserver) libraryObserver.observe(b);
        else requestDetails(item.name);
      }
    }
  }

  function setLibraryItems(items) {
    // Keep details that arrived after the listing was read.
    const old = lib.versions;
    for (const item of items) {
      for (const v of item.versions || []) {
        const prev = old.get(v.name);
        if (prev && prev.version.key === v.key && !v.poster) Object.assign(v, { duration: prev.version.duration ?? v.duration, poster: prev.version.poster, unreadable: prev.version.unreadable || v.unreadable });
      }
      const cur = (item.versions || []).find((v) => v.name === item.name);
      if (cur) Object.assign(item, { duration: cur.duration, poster: cur.poster, unreadable: cur.unreadable });
    }
    lib.items = items;
    lib.byRoot = new Map(items.map((i) => [i.root, i]));
    lib.versions = new Map();
    for (const item of items) for (const v of item.versions || [{ ...item, label: 'Original', current: true, original: true }]) lib.versions.set(v.name, { version: v, item });
    if (lib.selected && !lib.byRoot.has(lib.selected)) {
      // A rename moves the whole set; follow it when the file being watched moved.
      const moved = lib.viewing && state && state.renamed && baseName(state.renamed.from) === lib.viewing ? lib.versions.get(baseName(state.renamed.to)) : null;
      if (moved) { lib.selected = moved.item.root; lib.viewing = moved.version.name; } else closeLibraryPreview();
    }
    if (lib.selected && lib.viewing && !lib.versions.has(lib.viewing)) lib.viewing = lib.byRoot.get(lib.selected).name;
    if (lib.selected) showVersion(lib.viewing);
  }

  async function loadLibrary() {
    if (!bridge || typeof bridge.listRecordings !== 'function') return;
    if (lib.loading) { lib.again = true; return lib.loading; }
    lib.recentSig = JSON.stringify(state && state.recent);
    lib.loading = (async () => {
      await null;
      try {
        setLibraryItems(await bridge.listRecordings());
        lib.loaded = true;
        buildLibraryGrid();
      } catch (err) {
        fail(err);
      }
    })();
    render();
    try { await lib.loading; } finally {
      lib.loading = null;
      render();
      if (lib.again) { lib.again = false; loadLibrary(); }
    }
  }

  // Plays one version of the open recording.
  function showVersion(name) {
    const entry = lib.versions.get(name);
    if (!entry || !player) return;
    const src = `capture-media://recording/${encodeURIComponent(name)}`;
    const same = L.video.getAttribute('src') === src;
    lib.viewing = name;
    if (!same) player.load(src, { poster: entry.version.poster || undefined });
    requestDetails(name);
    render();
  }

  function selectLibraryItem(root) {
    const item = lib.byRoot.get(root);
    if (!item) return;
    if (lib.selected !== root) lib.versionsOpen = false;
    lib.selected = root;
    showVersion(item.name);
    L.root.scrollTo({ top: 0 });
    render();
    if (player) player.focus();
  }

  function closeLibraryPreview() {
    const root = lib.selected;
    lib.selected = null;
    lib.viewing = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (player) player.clear();
    render();
    const card = root && L.grid.querySelector(`button[data-root="${CSS.escape(root)}"]`);
    if (card) card.focus({ preventScroll: false });
  }

  function renderVersions(item) {
    const versions = item.versions || [];
    // Versions stay folded away; the player is the page.
    L.versionsToggle.hidden = versions.length < 2;
    setText(L.versionsCount, `${versions.length} versions`);
    L.versionsToggle.setAttribute('aria-expanded', String(lib.versionsOpen));
    L.versions.hidden = versions.length < 2 || !lib.versionsOpen;
    if (L.versions.hidden) { L.versionList.textContent = ''; delete L.versionList.dataset.sig; return; }
    const sig = JSON.stringify([lib.viewing, versions.map((v) => [v.name, v.current, v.poster, v.duration, v.unreadable])]);
    if (L.versionList.dataset.sig === sig) return;
    L.versionList.dataset.sig = sig;
    L.versionList.textContent = '';
    for (const v of versions) {
      const li = document.createElement('li');
      li.className = 'version';
      if (v.name === lib.viewing) li.classList.add('is-viewing');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'version-play';
      b.dataset.version = v.name;
      b.setAttribute('aria-current', String(v.name === lib.viewing));
      const thumb = span('version-thumb');
      if (v.poster) { const img = document.createElement('img'); img.alt = ''; img.src = v.poster; thumb.appendChild(img); }
      else if (!v.unreadable) requestDetails(v.name);
      b.appendChild(thumb);
      const text = span('version-text');
      text.appendChild(span('version-label', v.label));
      text.appendChild(span('version-sub', [versionWhen(v), v.duration > 0 ? formatShort(v.duration) : '', formatBytes(v.bytes)].filter(Boolean).join(', ')));
      b.appendChild(text);
      b.setAttribute('aria-label', `Play ${v.label}, ${versionWhen(v)}`);
      li.appendChild(b);
      if (v.current) {
        const mark = icon('i-check', 'version-current');
        mark.setAttribute('role', 'img');
        mark.setAttribute('aria-label', 'Current version');
        mark.removeAttribute('aria-hidden');
        li.appendChild(mark);
      } else {
        const r = document.createElement('button');
        r.type = 'button';
        r.className = 'icon-btn version-restore';
        r.dataset.restore = v.name;
        r.title = 'Make this the current version';
        r.setAttribute('aria-label', `Make ${v.label} from ${versionWhen(v)} the current version`);
        r.appendChild(icon('i-undo'));
        li.appendChild(r);
      }
      L.versionList.appendChild(li);
    }
  }

  function renderLibraryPreview() {
    const item = lib.selected && lib.byRoot.get(lib.selected);
    L.preview.hidden = !item;
    L.root.classList.toggle('is-watching', !!item);
    if (!item) return;
    const v = (lib.versions.get(lib.viewing) || {}).version || item;
    setText(L.title, item.title);
    L.title.title = v.name;
    const parts = [v.current === false ? v.label : '', versionWhen(v), libraryDuration(v)];
    setText(L.meta, v.unreadable ? 'This recording could not be read.' : parts.filter(Boolean).join(', '));
    renderVersions(item);
  }

  function renderLibrary(s) {
    const on = ed.view === 'library';
    L.view.setAttribute('aria-pressed', String(on));
    if (!on) { if (player) player.pause(); return; }
    const recentSig = JSON.stringify(s && s.recent);
    if (lib.loaded && !lib.loading && recentSig !== lib.recentSig) { lib.recentSig = recentSig; loadLibrary(); }
    // A finished share saves its link on the recording; show it.
    const shared = s && s.job && s.job.kind === 'publish' && !s.job.running && !s.job.error ? s.share && s.share.url : null;
    if (shared && shared !== lib.sharedSig) { lib.sharedSig = shared; if (lib.loaded) loadLibrary(); }
    lib.recentSig = recentSig;
    const n = lib.items.length;
    const total = lib.items.reduce((sum, i) => sum + (i.versions || [i]).reduce((t, v) => t + (Number(v.bytes) || 0), 0), 0);
    setText(L.count, n ? `${n} ${n === 1 ? 'recording' : 'recordings'}, ${formatBytes(total)}` : '');
    const watching = !!lib.selected;
    L.head.hidden = watching;
    L.loading.hidden = watching || lib.loaded || !lib.loading;
    L.empty.hidden = watching || !lib.loaded || n > 0;
    L.grid.hidden = watching || n === 0;
    L.folder.disabled = !bridge;
    const recordingBusy = !!s && ACTIVE.has(s.phase);
    const jobRunning = !!(s && s.job && s.job.running);
    const ready = !!(s && s.publishingReady);
    const entry = lib.viewing && lib.versions.get(lib.viewing);
    const unreadable = !!(entry && entry.version.unreadable);
    L.edit.disabled = !entry || unreadable || recordingBusy;
    L.edit.title = recordingBusy ? 'Finish recording first' : '';
    L.share.disabled = !entry || unreadable || recordingBusy || jobRunning || !!pending;
    L.share.title = recordingBusy ? 'Finish recording first' : jobRunning ? 'Wait for the current job to finish' : ready ? 'Upload to vidcapture.stream' : 'Log in or sign up at vidcapture.stream to share';
    L.shareNote.hidden = ready;
    // A recording already online keeps its link instead of uploading again.
    const link = entry && entry.version.share;
    L.copyLink.hidden = !link;
    L.openLink.hidden = !link;
    L.share.hidden = !!(link && link.current);
    L.linkNote.hidden = !(link && !link.current);
    setText(L.share.querySelector('span'), link && !link.current ? 'Share edited version' : 'Create shareable link');
    L.copyLink.classList.toggle('btn-solid', !!(link && link.current));
    L.copyLink.classList.toggle('btn-quiet', !!(link && !link.current));
    if (link) L.copyLink.title = link.url;
    renderLibraryPreview();
  }

  function showLibrary() {
    if (ed.view === 'library') return;
    if (ed.view === 'edit') {
      E.video.pause();
      if (ed.session) flushSave(ed.session);
    }
    setView('library');
    loadLibrary();
    syncShares();
  }

  async function restoreVersion(name) {
    const item = lib.selected && lib.byRoot.get(lib.selected);
    if (!item || !name || lib.restoring) return;
    lib.restoring = true;
    render();
    try {
      setLibraryItems(await bridge.setCurrentVersion(item.root, name));
      buildLibraryGrid();
      showVersion(name);
    } catch (err) {
      fail(err);
    } finally {
      lib.restoring = false;
      render();
    }
  }

  L.view.addEventListener('click', showLibrary);
  $('library-record').addEventListener('click', () => setView('record'));
  L.grid.addEventListener('click', (e) => {
    const b = e.target.closest('button.lib-card');
    if (b) selectLibraryItem(b.dataset.root);
  });
  L.close.addEventListener('click', closeLibraryPreview);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || ed.view !== 'library' || !lib.selected || e.defaultPrevented || document.fullscreenElement) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    closeLibraryPreview();
  });
  L.versionsToggle.addEventListener('click', () => { lib.versionsOpen = !lib.versionsOpen; render(); });
  L.versionList.addEventListener('click', (e) => {
    const r = e.target.closest('button[data-restore]');
    if (r) { restoreVersion(r.dataset.restore); return; }
    const b = e.target.closest('button[data-version]');
    if (b) { showVersion(b.dataset.version); if (player) player.focus(); }
  });
  L.edit.addEventListener('click', () => {
    const entry = lib.viewing && lib.versions.get(lib.viewing);
    if (!entry) return;
    if (player) player.pause();
    openEditor(entry.version.path);
  });
  L.share.addEventListener('click', () => {
    const entry = lib.viewing && lib.versions.get(lib.viewing);
    if (!entry || L.share.disabled) return;
    if (player) player.pause();
    // The share form includes saved edits for this file, or the open editor's plan.
    sharePath = entry.version.path;
    $('share-name').value = entry.item.title;
    $('share-dialog').showModal();
    $('share-name').select();
  });
  const viewedLink = () => { const entry = lib.viewing && lib.versions.get(lib.viewing); return entry && entry.version.share; };
  L.copyLink.addEventListener('click', async () => {
    const link = viewedLink();
    if (!link) return;
    try {
      await bridge.copyLink(link.url);
      setText(L.copyLink.querySelector('span'), 'Copied');
      setTimeout(() => setText(L.copyLink.querySelector('span'), 'Copy link'), 1800);
    } catch (err) { fail(err); render(); }
  });
  L.openLink.addEventListener('click', async () => {
    const link = viewedLink();
    if (link) try { await bridge.openLink(link.url); } catch (err) { fail(err); render(); }
  });
  // Checks vidcapture.stream for links removed or renamed online, at most once a minute.
  let syncedAt = 0;
  async function syncShares() {
    if (!bridge || typeof bridge.syncShares !== 'function' || !state || !state.publishingReady || Date.now() - syncedAt < 60000) return;
    syncedAt = Date.now();
    try { const r = await bridge.syncShares(); if (r && r.changed) loadLibrary(); } catch { syncedAt = 0; }
  }
  L.folder.addEventListener('click', async () => {
    try { await bridge.openFolder(); } catch (err) { fail(err); render(); }
  });
  window.addEventListener('focus', () => { if (ed.view === 'library' && lib.loaded) loadLibrary(); });

  /* Startup */

  async function init() {
    if (!bridge) {
      localError = 'VidCapture could not connect to the recorder. Restart the app.';
      for (const b of document.querySelectorAll('button:not(#alert-dismiss), select, fieldset')) b.disabled = true;
      el.minimize.disabled = true;
      el.close.disabled = true;
      el.status.textContent = 'Unavailable';
      renderAlert(null);
      return;
    }
    try {
      bridge.onState((next) => {
        if (next && typeof next === 'object' && typeof next.phase === 'string') {
          state = next;
          render();
        }
      });
    } catch (err) {
      localError = errorMessage(err);
    }
    try {
      const initial = await bridge.getState();
      if (!state) adopt(initial);
    } catch (err) {
      localError = errorMessage(err);
    }
    render();
    refreshSources();
  }

  window.addEventListener('unhandledrejection', (e) => {
    localError = errorMessage(e.reason);
    dismissedError = null;
    render();
  });

  init();
})();
