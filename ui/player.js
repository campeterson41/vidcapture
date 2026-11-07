'use strict';
// The VidCapture player, shared in look and behavior with the player on
// vidcapture.stream (cloud/public/player.js). Works on a .vp root in the page;
// classes instead of ids so it never collides with the editor's playbar.
(() => {
  function attach(root, { onError } = {}) {
    const q = (cls) => root.querySelector('.' + cls);
    const video = q('vp-video'), seek = q('vp-seek'), volume = q('vp-volume'), toggle = q('vp-toggle');
    const center = q('vp-center'), speed = q('vp-speed'), fullscreen = q('vp-fullscreen'), pip = q('vp-pip');
    const progress = q('vp-progress'), buffer = q('vp-buffer'), preview = q('vp-seek-preview');
    const current = q('vp-current'), total = q('vp-duration'), loader = q('vp-loading'), error = q('vp-error');
    let scrubbing = false, wasPlaying = false, previousVolume = 1, loadingTimer;

    const duration = () => (Number.isFinite(video.duration) ? video.duration : 0);
    const clock = (value) => {
      const seconds = Math.max(0, Math.floor(value || 0)), h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = String(seconds % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
    };
    const label = (element, text) => { element.setAttribute('aria-label', text); element.title = text; };

    function updateTime() {
      const t = duration(), time = scrubbing ? Number(seek.value) : video.currentTime;
      seek.max = String(t || 100); seek.disabled = !t;
      if (!scrubbing) seek.value = String(video.currentTime);
      seek.setAttribute('aria-valuetext', `${clock(time)} of ${clock(t)}`);
      current.textContent = clock(time); total.textContent = clock(t);
      progress.style.width = t ? `${(time / t) * 100}%` : '0%';
    }
    function updateBuffer() {
      let end = 0;
      for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) >= video.currentTime) end = video.buffered.end(i);
      buffer.style.width = duration() ? `${(end / duration()) * 100}%` : '0%';
    }
    function updatePlayback() {
      root.classList.toggle('is-playing', !video.paused && !video.ended);
      root.classList.toggle('is-ended', video.ended);
      center.hidden = !(video.paused || video.ended) || !!video.error || !video.getAttribute('src');
      label(toggle, video.ended ? 'Replay (Space)' : video.paused ? 'Play (Space)' : 'Pause (Space)');
      label(center, video.ended ? 'Replay video' : 'Play video');
      if (video.paused || video.ended) loading(false);
    }
    function loading(show) {
      clearTimeout(loadingTimer);
      if (!show) { loader.hidden = true; return; }
      loadingTimer = setTimeout(() => { if (!video.paused && !video.error) loader.hidden = false; }, 250);
    }
    async function play() {
      if (video.error || !video.getAttribute('src')) return;
      if (video.ended) video.currentTime = 0;
      try { await video.play(); } catch (err) { if (err.name !== 'AbortError') showError('Playback could not start. Try again.'); }
    }
    function togglePlay() { if (video.paused || video.ended) void play(); else video.pause(); }
    function jump(seconds) { if (duration()) video.currentTime = Math.max(0, Math.min(duration(), video.currentTime + seconds)); updateTime(); }
    function updateVolume() {
      const muted = video.muted || video.volume === 0;
      root.classList.toggle('is-muted', muted);
      volume.value = String(muted ? 0 : video.volume);
      label(q('vp-mute'), muted ? 'Unmute (M)' : 'Mute (M)');
    }
    function toggleMute() {
      if (video.muted || video.volume === 0) { video.muted = false; video.volume = previousVolume || 1; } else { previousVolume = video.volume; video.muted = true; }
      updateVolume();
    }
    async function toggleFullscreen() {
      try { if (document.fullscreenElement === root) await document.exitFullscreen(); else await root.requestFullscreen(); } catch {}
    }
    function showError(text) {
      loading(false);
      error.querySelector('p').textContent = text;
      error.hidden = false;
      center.hidden = true;
      if (onError) onError(text);
    }

    toggle.addEventListener('click', togglePlay);
    center.addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);
    video.addEventListener('dblclick', () => void toggleFullscreen());
    q('vp-back').addEventListener('click', () => jump(-10));
    q('vp-forward').addEventListener('click', () => jump(10));
    q('vp-mute').addEventListener('click', toggleMute);
    volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = video.volume === 0; if (video.volume) previousVolume = video.volume; });
    speed.addEventListener('change', () => {
      video.playbackRate = Number(speed.value); video.preservesPitch = true;
      try { localStorage.setItem('vidcapture-speed', speed.value); } catch {}
    });
    try { const saved = localStorage.getItem('vidcapture-speed'); if ([...speed.options].some((o) => o.value === saved)) speed.value = saved; } catch {}
    fullscreen.addEventListener('click', () => void toggleFullscreen());
    fullscreen.hidden = !document.fullscreenEnabled;
    document.addEventListener('fullscreenchange', () => {
      const full = document.fullscreenElement === root;
      root.classList.toggle('is-fullscreen', full);
      label(fullscreen, full ? 'Exit fullscreen (F)' : 'Fullscreen (F)');
    });
    pip.hidden = !document.pictureInPictureEnabled || !video.requestPictureInPicture;
    pip.addEventListener('click', async () => {
      try { if (document.pictureInPictureElement === video) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch {}
    });
    video.addEventListener('enterpictureinpicture', () => label(pip, 'Exit picture in picture'));
    video.addEventListener('leavepictureinpicture', () => label(pip, 'Picture in picture'));

    function beginScrub() { if (scrubbing) return; scrubbing = true; wasPlaying = !video.paused; video.pause(); root.classList.add('is-scrubbing'); }
    function finishScrub() {
      if (!scrubbing) return;
      video.currentTime = Math.min(duration(), Number(seek.value));
      scrubbing = false; root.classList.remove('is-scrubbing'); preview.hidden = true; updateTime();
      if (wasPlaying) void play();
    }
    seek.addEventListener('pointerdown', (e) => { beginScrub(); seek.setPointerCapture(e.pointerId); });
    seek.addEventListener('input', () => { video.currentTime = Number(seek.value); updateTime(); });
    for (const name of ['change', 'pointerup', 'pointercancel', 'lostpointercapture']) seek.addEventListener(name, finishScrub);
    seek.addEventListener('pointermove', (e) => {
      const rect = seek.getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      preview.textContent = clock(fraction * duration());
      preview.style.left = `${Math.max(24, Math.min(rect.width - 24, fraction * rect.width))}px`;
      preview.hidden = !duration();
    });
    seek.addEventListener('pointerleave', () => { preview.hidden = true; });

    root.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest('input,select,textarea')) return;
      if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button')) return;
      const key = e.key.toLowerCase();
      if (key === ' ' || key === 'k') togglePlay();
      else if (key === 'arrowleft') jump(-5);
      else if (key === 'arrowright') jump(5);
      else if (key === 'j') jump(-10);
      else if (key === 'l') jump(10);
      else if (key === 'm') toggleMute();
      else if (key === 'f') void toggleFullscreen();
      else if (key === 'home') video.currentTime = 0;
      else if (key === 'end' && duration()) video.currentTime = duration();
      else return;
      e.preventDefault();
    });

    for (const name of ['play', 'pause', 'ended']) video.addEventListener(name, updatePlayback);
    for (const name of ['timeupdate', 'seeking', 'seeked', 'durationchange']) video.addEventListener(name, updateTime);
    for (const name of ['progress', 'timeupdate', 'loadedmetadata']) video.addEventListener(name, updateBuffer);
    video.addEventListener('volumechange', updateVolume);
    video.addEventListener('ratechange', () => { speed.value = String(video.playbackRate); });
    for (const name of ['waiting', 'stalled']) video.addEventListener(name, () => loading(true));
    for (const name of ['playing', 'canplay', 'seeked']) video.addEventListener(name, () => loading(false));
    // The player takes the video's own shape, so there are no black bars.
    video.addEventListener('loadedmetadata', () => {
      video.playbackRate = Number(speed.value); video.preservesPitch = true;
      if (video.videoWidth && video.videoHeight) root.style.setProperty('--vp-ratio', String(video.videoWidth / video.videoHeight));
      updateTime();
    });
    video.addEventListener('error', () => { if (video.getAttribute('src')) showError('This recording could not be played here.'); });
    q('vp-retry').addEventListener('click', () => { error.hidden = true; video.load(); void play(); });

    video.controls = false;
    updatePlayback(); updateTime(); updateVolume();

    return {
      video,
      load(src, { poster, ratio } = {}) {
        error.hidden = true;
        if (ratio) root.style.setProperty('--vp-ratio', String(ratio));
        if (poster) video.poster = poster; else video.removeAttribute('poster');
        if (video.getAttribute('src') !== src) { video.src = src; video.playbackRate = Number(speed.value); }
        updatePlayback(); updateTime();
      },
      clear() {
        video.pause(); video.removeAttribute('src'); video.removeAttribute('poster'); video.load();
        error.hidden = true; updatePlayback(); updateTime();
      },
      pause() { video.pause(); },
      focus() { root.focus({ preventScroll: true }); },
    };
  }
  window.VCPlayer = { attach };
})();
