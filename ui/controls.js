'use strict';
(() => {
  const vc = window.vidcapture;
  const $ = (id) => document.getElementById(id);
  const pill = $('pill'), dot = $('dot'), elapsed = $('elapsed'), pause = $('pause');
  const main = $('pill-main'), confirmBox = $('pill-confirm'), confirmText = $('confirm-text'), confirmGo = $('confirm-go');
  let shortcuts = {}, confirming = null, confirmTimer = null;
  const withKey = (label, key) => (key ? `${label} (${key})` : label);
  const collapsible = new URLSearchParams(location.search).get('collapsed') === '1';
  let expanded = !collapsible, foldTimer = null, busy = false;

  function format(seconds) {
    const t = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function render(state) {
    if (state) {
      document.body.dataset.phase = state.phase;
      elapsed.textContent = format(state.elapsed);
      const paused = state.phase === 'paused';
      if (state.shortcuts) shortcuts = state.shortcuts;
      pause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
      pause.title = withKey(paused ? 'Resume' : 'Pause', shortcuts.pause);
      $('stop').title = withKey('Stop and save', shortcuts.record);
      pause.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
      dot.title = paused ? 'Paused' : 'Recording';
    }
    pill.hidden = !expanded;
    dot.hidden = expanded;
    if (!expanded && confirming) settle(false);
  }
  async function act(fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } catch { /* the main window reports recorder errors */ } finally { busy = false; }
  }
  // Restart and Delete take ask once more, in place, before throwing the take away.
  const CONFIRM = {
    restart: { text: 'Restart this take?', go: 'Restart', run: () => vc.restart() },
    discard: { text: 'Delete this take?', go: 'Delete', run: () => vc.discard() },
  };
  function ask(kind) {
    confirming = kind;
    confirmText.textContent = CONFIRM[kind].text;
    confirmGo.textContent = CONFIRM[kind].go;
    main.hidden = true; confirmBox.hidden = false;
    confirmGo.focus();
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => settle(false), 6000);
  }
  function settle(go) {
    const kind = confirming; if (!kind) return;
    confirming = null; clearTimeout(confirmTimer);
    confirmBox.hidden = true; main.hidden = false;
    if (go) act(() => CONFIRM[kind].run());
    else $(kind).focus();
  }
  $('restart').addEventListener('click', () => ask('restart'));
  $('discard').addEventListener('click', () => ask('discard'));
  confirmGo.addEventListener('click', () => settle(true));
  $('confirm-cancel').addEventListener('click', () => settle(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && confirming) { e.preventDefault(); settle(false); } });
  pause.addEventListener('click', () => act(() => vc.pause()));
  $('stop').addEventListener('click', () => act(() => vc.stop()));
  dot.addEventListener('click', () => act(() => vc.expand(true)));
  if (collapsible) {
    // The full-display dot folds back after the pointer leaves the controls.
    document.addEventListener('mouseleave', () => {
      clearTimeout(foldTimer);
      if (expanded) foldTimer = setTimeout(() => { if (!confirming) vc.expand(false); }, 2500);
    });
    document.addEventListener('mouseenter', () => clearTimeout(foldTimer));
  }
  // Microphone input indicator. The main process measures the source the recording's
  // own microphone stream reads (take-meter.cjs) and sends a state and level.
  const mic = $('mic'), micStatus = $('mic-status');
  const NOTE = ' Measured at the input this recording reads, not from the saved file.';
  const MIC = {
    checking: 'Microphone: checking the recording input',
    live: 'Microphone: sound is reaching the recording input',
    quiet: 'Microphone: connected, quiet right now',
    muted: 'Microphone is muted, so this recording gets silence from it',
    held: 'Microphone input is on hold in this recording, so it may get silence',
    unlinked: 'Microphone is not connected to this recording',
    cleanup: 'Microphone cleanup stopped, so the cleaned microphone track may be silent',
    unavailable: 'Microphone level unavailable, so it cannot be confirmed right now',
    paused: 'Paused. The microphone is not being recorded',
    none: 'No microphone in this recording',
  };
  // Spoken only when the meaning changes. Live and quiet count as one working state,
  // so pauses in speech are never announced.
  const group = (st) => (st === 'live' || st === 'quiet' ? 'ok' : st);
  let micShown = null;
  function renderMic(m) {
    const st = m && MIC[m.state] ? m.state : 'checking';
    const level = st === 'live' ? Math.max(0, Math.min(1, Number(m.level) || 0)) : 0;
    mic.dataset.state = st;
    // Scaled from 35 to 100 percent so even a soft voice shows clearly.
    mic.style.setProperty('--level', st === 'live' ? String(0.35 + 0.65 * level) : '0');
    mic.setAttribute('aria-label', MIC[st]);
    mic.title = MIC[st] + '.' + (st === 'none' ? '' : NOTE);
    if (group(st) !== micShown) {
      const first = micShown === null;
      micShown = group(st);
      if (!first && st !== 'checking') micStatus.textContent = MIC[st];
    }
  }
  vc.on('mic', renderMic);
  vc.on('state', render);
  vc.on('expanded', (on) => { expanded = on; render(); });
  vc.controlsState().then((s) => { render(s); renderMic(s && s.mic); }).catch(() => { render(); renderMic(null); });
})();
