'use strict';
// A bright outline around the chosen window, area or display while the record
// panel is open. The window is click-through; the main process positions it.
(() => {
  const frame = document.getElementById('frame');
  window.vidcapture.on('frame', (f) => {
    if (!f) { frame.hidden = true; return; }
    const first = frame.hidden;
    Object.assign(frame.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.width}px`, height: `${f.height}px` });
    frame.dataset.kind = f.kind;
    frame.hidden = false;
    if (first) { frame.classList.remove('frame-in'); void frame.offsetWidth; frame.classList.add('frame-in'); }
  });
})();
