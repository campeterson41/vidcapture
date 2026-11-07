'use strict';

(() => {
  const bridge = window.capture;
  const ACTIVE = new Set(['selecting', 'starting', 'recording', 'paused', 'stopping']);
  const HOME_RE = /^\/home\/[^/]+(?=\/|$)/;

  const $ = (id) => document.getElementById(id);
  const el = {
    targets: $('targets'),
    regionNote: $('region-note'),
    microphone: $('microphone'),
    systemAudio: $('system-audio'),
    camera: $('camera'),
    cameraCorrection: $('camera-correction'),
    cameraProfileNote: $('camera-profile-note'),
    preview: $('preview'),
    previewLabel: $('preview').querySelector('span'),
    refresh: $('refresh'),
    moreBody: $('more-body'),
    fieldsets: Array.from(document.querySelectorAll('fieldset[data-setting]')),
    openFolder: $('open-folder'),
    outputDir: $('output-dir'),
    recent: $('recent'),
    recentEmpty: $('recent-empty'),
    time: $('time'),
    status: $('status'),
    openLast: $('open-last'),
    pause: $('pause'),
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

  function toDate(value) {
    if (value == null || value === '') return null;
    let d;
    if (typeof value === 'number') d = new Date(value < 1e12 ? value * 1000 : value);
    else d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatCreated(value) {
    const d = toDate(value);
    if (!d) return '';
    const now = new Date();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return `${d.toLocaleDateString('en-US', opts)}, ${time}`;
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

  function renderTargets(s, locked) {
    const target = s.target;
    const monitors = (s.devices && Array.isArray(s.devices.monitors)) ? s.devices.monitors : [];
        const waiting = s.phase === 'selecting' || pending === 'target-region';

    const model = {
      monitors: monitors.map((m) => [m.id, m.name, m.width, m.height]),
      target: target ? [target.kind, target.label, target.x, target.y, target.width, target.height, target.monitor, target.available] : null,
      waiting,
    };

    if (changed('targets', model)) {
      el.targets.textContent = '';

      for (const kind of ['window', 'region']) {
        const selected = !!target && target.kind === kind;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'target';
        button.dataset.target = kind;
        button.setAttribute('aria-pressed', String(selected));
        button.appendChild(icon(kind === 'window' ? 'i-desktop' : 'i-marquee'));
        const text = span('target-text');
        text.appendChild(span('target-name', kind === 'window' ? 'Window' : 'Area'));
        const hint = selected ? target.label : kind === 'window' ? 'Choose a window to follow' : 'Drag a fixed recording area';
        text.appendChild(span('target-sub', hint));
        button.title = selected ? target.label : hint;
        button.appendChild(text);
        button.appendChild(span('target-end', selected ? 'Change' : ''));
        button.setAttribute('aria-label', selected ? `${kind === 'window' ? 'Window' : 'Area'}, selected: ${target.label}. Choose again` : hint);
        el.targets.appendChild(button);
      }

      for (const m of monitors) {
        const selected = !!target && target.kind === 'monitor' &&
          (target.monitor === m.id || (target.monitor == null && target.label === m.name));
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'target';
        b.dataset.target = 'monitor';
        b.dataset.monitorId = String(m.id);
        b.setAttribute('aria-pressed', String(selected));
        b.appendChild(icon('i-desktop'));
        const t = span('target-text');
        t.appendChild(span('target-name', m.name || String(m.id)));
        t.appendChild(span('target-sub mono', dims(m.width, m.height)));
        b.appendChild(t);
        const end = span('target-end');
        if (selected) end.appendChild(icon('i-check'));
        b.appendChild(end);
        b.setAttribute('aria-label', `Full display ${m.name || m.id}${dims(m.width, m.height) ? `, ${dims(m.width, m.height)}` : ''}`);
        el.targets.appendChild(b);
      }

      el.regionNote.hidden = !target || target.kind === 'monitor';
      el.regionNote.textContent = target?.kind === 'window'
        ? (target.available === false ? 'This window is no longer visible. Choose it again before recording.' : 'The highlighted window and camera follow moves and resizes. Keep it visible on this display; moving to another display ends the take.')
        : 'This area stays fixed when windows move.';
    }

    for (const b of el.targets.querySelectorAll('button')) b.disabled = locked;
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
    const micOptions = [{ value: 'none', label: 'None' }];
    if (!mics.some((d) => d.id === 'default_input')) micOptions.push({ value: 'default_input', label: 'Default input' });
    for (const d of mics) micOptions.push({ value: String(d.id), label: d.name || String(d.id) });
    fillSelect(el.microphone, 'mics', micOptions, settings.microphone ?? 'none');

    const cams = Array.isArray(devices.cameras) ? devices.cameras : [];
    const camOptions = [{ value: 'none', label: 'None' }];
    for (const d of cams) camOptions.push({ value: String(d.id), label: d.name || String(d.id) });
    fillSelect(el.camera, 'cams', camOptions, settings.camera ?? 'none');

    el.microphone.disabled = locked;
    el.camera.disabled = locked;

    el.systemAudio.setAttribute('aria-checked', String(!!settings.systemAudio));
    el.systemAudio.disabled = locked;

    const hasCamera = settings.camera && settings.camera !== 'none';
    const razer = /Razer Kiyo Pro Ultra/i.test(cams.find(c => c.id === settings.camera)?.name || '');
    el.cameraCorrection.hidden = !razer;
    el.cameraProfileNote.hidden = !razer;
    el.cameraProfileNote.textContent = settings.cameraCorrection === 'computer'
      ? 'Razer 4K at 30 fps. Lens correction runs on your computer; camera HDR stays off.'
      : 'Razer 4K at 30 fps. Lens correction and camera HDR stay off.';
    el.preview.disabled = locked || !hasCamera;
    el.preview.setAttribute('aria-pressed', String(!!s.cameraPreview));
    el.previewLabel.textContent = s.cameraPreview ? 'Hide preview' : 'Preview';
    el.preview.setAttribute('aria-busy', String(pending === 'preview'));

    el.refresh.disabled = locked;
    el.refresh.classList.toggle('is-busy', pending === 'refresh');
    el.refresh.setAttribute('aria-busy', String(pending === 'refresh'));
    el.refresh.querySelector('span').textContent = pending === 'refresh' ? 'Refreshing' : 'Refresh devices';

    for (const fs of el.fieldsets) {
      const key = fs.dataset.setting;
      const value = settings[key] == null ? '' : String(settings[key]);
      for (const input of fs.querySelectorAll('input')) input.checked = input.value === value;
      fs.disabled = locked || (['cameraCorrection','cameraLighting'].includes(key) && !hasCamera);
    }
  }

  function renderRecordings(s, locked) {
    const dir = s.outputDir || '';
    // Marks keep the path left to right while the container truncates from the start.
    el.outputDir.textContent = dir ? `\u200e${shortenPath(dir)}\u200e` : 'Recordings folder';
    el.openFolder.title = dir ? `Open ${dir}` : 'Open folder';
    el.openFolder.setAttribute('aria-label', dir ? `Open recordings folder, ${dir}` : 'Open recordings folder');
    el.openFolder.disabled = !bridge;

    const recent = Array.isArray(s.recent) ? s.recent : [];
    const fresh = s.phase === 'saved' ? s.lastFile : null;
    if (changed('recent', { recent, fresh, day: new Date().toDateString() })) {
      el.recent.textContent = '';
      for (const r of recent) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'recent-item';
        b.dataset.path = r.path;
        if (fresh && r.path === fresh) b.classList.add('is-new');
        const name = r.name || baseName(r.path);
        b.appendChild(span('recent-name', name));
        b.appendChild(span('recent-size', formatBytes(r.bytes)));
        b.appendChild(span('recent-date', formatCreated(r.created)));
        b.title = r.path;
        b.setAttribute('aria-label', `Open ${name}`);
        li.appendChild(b);
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn row-edit';
        editBtn.dataset.edit = r.path;
        editBtn.textContent = 'Edit';
        editBtn.setAttribute('aria-label', `Edit ${name}`);
        li.appendChild(editBtn);
        el.recent.appendChild(li);
      }
      el.recent.hidden = recent.length === 0;
      el.recentEmpty.hidden = recent.length !== 0;
    }
    for (const b of el.recent.querySelectorAll('button.recent-item')) b.disabled = !bridge;
    for (const b of el.recent.querySelectorAll('button.row-edit')) b.disabled = !bridge || ACTIVE.has(s.phase);
  }

  function renderTransport(s) {
    const phase = s.phase;
    const hasTarget = !!s.target && s.target.available !== false;

    el.time.textContent = formatElapsed(s.elapsed);

    let status;
    switch (phase) {
      case 'selecting': status = 'Waiting for a selection'; break;
      case 'starting': status = 'Starting'; break;
      case 'recording': status = 'Recording'; break;
      case 'paused': status = 'Paused'; break;
      case 'stopping': status = 'Saving the file'; break;
      case 'saved': status = s.lastFile ? `Saved ${baseName(s.lastFile)}` : 'Saved'; break;
      case 'error': status = 'Not recording'; break;
      default: status = hasTarget ? (s.target.kind === 'window' ? `Ready: ${s.target.label}` : 'Ready') : 'Choose a source to start';
    }
    if (pending === 'start' && phase !== 'starting' && !ACTIVE.has(phase)) status = 'Starting';
    if (el.status.textContent !== status) el.status.textContent = status;
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
      : (!live && !hasTarget ? 'Choose a source first' : '');

    el.pause.hidden = !live;
    el.pause.disabled = !!pending;
    el.pause.classList.toggle('is-busy', pending === 'pause');
    const paused = phase === 'paused';
    el.pauseLabel.textContent = paused ? 'Resume' : 'Pause';
    el.pause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    el.pauseUse.setAttribute('href', paused ? '#i-play' : '#i-pause');

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
    $('open-bar').disabled = locked || !!(state.job && state.job.running);
    renderInputs(state, locked);
    renderRecordings(state, locked);
    renderTransport(state);
    renderAlert(state);
    renderJob(state);
    renderView(state);
    renderEditorControls();
  }

  /* Events */

  el.targets.addEventListener('click', (e) => {
    const b = e.target.closest('button.target');
    if (!b || b.disabled) return;
    if (b.dataset.target === 'window') showWindowPicker();
    else if (b.dataset.target === 'region') run('target-region', () => bridge.pickOnScreen('area'));
    else run('target', () => bridge.chooseTarget(b.dataset.monitorId));
  });

  const picker = $('window-picker');
  const windowList = $('window-list');
  $('window-picker-close').addEventListener('click', () => picker.close());
  $('window-picker-screen').addEventListener('click', () => { picker.close(); run('target-region', () => bridge.pickOnScreen('window')); });
  $('open-bar').addEventListener('click', () => run('open-bar', () => bridge.openBar()));
  async function showWindowPicker() {
    try {
      const windows = await bridge.listWindows();
      windowList.replaceChildren();
      if (!windows.length) windowList.appendChild(span('note', 'No visible windows. Open the app you want to record, then try again.'));
      for (const item of windows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.windowId = item.id;
        button.title = item.title;
        button.appendChild(span('window-title', item.title));
        button.appendChild(span('window-app', item.app));
        button.addEventListener('click', () => {
          picker.close();
          run('target-region', () => bridge.chooseTarget(`window:${item.id}`));
        });
        windowList.appendChild(button);
      }
      picker.showModal();
    } catch (err) { fail(err); render(); }
  }

  el.microphone.addEventListener('change', () => saveSetting({ microphone: el.microphone.value }));
  el.camera.addEventListener('change', () => saveSetting({ camera: el.camera.value }));
  el.systemAudio.addEventListener('click', () => {
    if (!state) return;
    saveSetting({ systemAudio: !(state.settings && state.settings.systemAudio) });
  });

  for (const fs of el.fieldsets) {
    fs.addEventListener('change', (e) => {
      const input = e.target;
      if (!input || input.type !== 'radio') return;
      const key = fs.dataset.setting;
      const value = key === 'fps' ? Number(input.value) : input.value;
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
  el.recent.addEventListener('click', (e) => {
    const edit = e.target.closest('button.row-edit');
    if (edit) { if (!edit.disabled) openEditor(edit.dataset.edit); return; }
    const b = e.target.closest('button.recent-item');
    if (b && !b.disabled) openPath(b.dataset.path);
  });
  el.editLast.addEventListener('click', () => { if (state && state.lastFile) openEditor(state.lastFile); });

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
    run('enhance', () => bridge[method](s.path, {noiseReduction:E.enhanceMode.value==='quick-quiet'?'stronger':'standard'}));
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
      cutSelection();
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
    $('share-name').value=baseName(sharePath).replace(/\.mp4$/i,'');
    $('share-dialog').showModal();$('share-name').select();
  });
  $('share-cancel').addEventListener('click',()=>$('share-dialog').close());
  $('share-form').addEventListener('submit',async event=>{
    event.preventDefault();const file=sharePath,title=$('share-name').value.trim();if(!file||!title)return;
    $('share-dialog').close();
    try{await window.captureFlushEdits?.();const keep=ed.session?.path===file?ed.session.keep.map(r=>r.slice()):undefined;await run('publish',()=>bridge.publishVideo(file,title,keep));}catch(error){fail(error);render();}
  });
  $('copy-card').addEventListener('click',async()=>{const b=$('copy-card');b.disabled=true;try{await bridge.copyShareCard();b.textContent='Card copied';setTimeout(()=>b.textContent='Copy video card',2000);}catch(error){fail(error);render();}finally{b.disabled=false;}});
  $('copy-share').addEventListener('click',async()=>{try{await bridge.copyShareLink();$('copy-share').textContent='Copied';setTimeout(()=>$('copy-share').textContent='Copy link',2000);}catch(error){fail(error);render();}});

  /* Rendering for editor, view switch, and job */

  function jobKey(job) {
    return JSON.stringify([job.kind, job.output, job.error]);
  }

  function renderView(s) {
    document.body.dataset.view = ed.view;
    E.viewRecord.setAttribute('aria-pressed', String(ed.view === 'record'));
    E.viewEdit.setAttribute('aria-pressed', String(ed.view === 'edit'));
    E.viewEdit.disabled = ed.view === 'record' && ACTIVE.has(s.phase);
    E.viewEdit.title = E.viewEdit.disabled ? 'Available after recording' : '';
  }

  function renderJob(s) {
    const job = s.job;
    const busy=ACTIVE.has(s.phase)||!!job?.running||!!pending;
    $('video-library').disabled=!s.publishingReady||!!pending;
    $('share-video').disabled=!s.publishingReady||busy||!(ed.view==='edit'?ed.session?.path:s.lastFile);
    $('share-video').title=s.publishingReady?'Upload to vidcapture.stream':'Publishing is not connected on this computer';
    $('copy-share').hidden=!s.share?.url;
    $('copy-card').hidden=!s.share?.url;
    if (!job || job.running) ed.jobDismissed = null;
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
      title = job.kind==='publish'?'Sharing on VidCapture':audio ? (folio ? 'Enhancing audio with Folio' : job.kind==='quick-audio' ? 'Enhancing audio with Quick studio' : 'Enhancing audio with fast cleanup') : 'Saving edited copy';
      detail = ed.canceling ? 'Canceling' : (job.stage || 'Working');
    } else if (status === 'done') {
      title = job.kind==='publish'?'Your share link is ready':audio ? 'Enhanced copy saved' : 'Edited copy saved';
      detail = job.kind==='publish'?(s.share?.cardWarning||s.share?.url||'Ready to share'):baseName(job.output);
    } else {
      title = job.kind==='publish'?'Video was not shared':audio ? 'Audio was not enhanced' : 'Edited copy was not saved';
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
    E.jobEdit.hidden = status !== 'done';
    E.jobOpen.disabled = E.jobEdit.disabled = !!pending;
    E.jobDismiss.hidden = status === 'running';
  }

  function renderEditorControls() {
    const s = ed.session;
    const loading = !!ed.loadingPath;
    E.empty.hidden = !!(s || loading);
    E.main.hidden = !(s || loading);

    setText(E.name, s ? (s.media.name || baseName(s.path)) : baseName(ed.loadingPath || ''));
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
    else if (media && !media.canEnhance) help = 'This copy has no isolated microphone track to enhance.';
    else if (hasCuts) help = 'To enhance, save an edited copy first, then enhance that copy.';
    else if (media) help = E.enhanceMode.value === 'folio' ? 'Folio uses neural restoration and full mastering. Long recordings can take much longer.' : E.enhanceMode.value==='quick-quiet' ? 'Quick studio with stronger noise cleanup and softer pauses.' : 'Fuller voice tone and fast local cleanup. A separate enhanced copy keeps your original safe.';
    setText(E.folioHelp, help);
    E.enhance.disabled = !media || !audioReady || !media.canEnhance || hasCuts || !!blockedBy || !!pending;
    E.enhance.title = blockedBy;
    E.enhanceMode.disabled = !!blockedBy || !!pending;
  }

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
  }

  window.addEventListener('unhandledrejection', (e) => {
    localError = errorMessage(e.reason);
    dismissedError = null;
    render();
  });

  init();
})();
