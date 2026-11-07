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
  vc.on('state', render);
  vc.on('expanded', (on) => { expanded = on; render(); });
  vc.controlsState().then(render).catch(() => render());
})();
