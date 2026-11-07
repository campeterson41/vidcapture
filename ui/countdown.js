'use strict';
// 3, 2, 1 before a take. The main process drives the numbers and closes
// this window before recording starts.
(() => {
  const vc = window.vidcapture;
  const count = document.getElementById('count');
  const n = Number(new URLSearchParams(location.search).get('n'));
  if (n > 0) count.textContent = String(n);
  const tick = () => { count.classList.remove('count-in'); void count.offsetWidth; count.classList.add('count-in'); };
  tick();
  vc.on('count', (v) => { count.textContent = String(v); tick(); });
  const cancel = () => vc.countdownCancel().catch(() => {});
  document.getElementById('cancel').addEventListener('click', cancel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
})();
