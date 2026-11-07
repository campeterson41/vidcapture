'use strict';
(() => {
  const vc = window.vidcapture;
  for (const b of document.querySelectorAll('.mode')) {
    b.addEventListener('click', () => vc.openPicker(b.dataset.mode).catch(() => {}));
  }
  document.getElementById('dismiss').addEventListener('click', () => vc.closeBar());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') vc.closeBar(); });
})();
