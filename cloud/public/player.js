'use strict';
(()=>{
 const root=document.getElementById('video-player');if(!root)return;
 const get=id=>root.querySelector('#'+id),video=get('watch-video'),seek=get('player-seek'),volume=get('player-volume'),toggle=get('player-toggle'),center=get('center-play'),speed=get('speed'),fullscreen=get('player-fullscreen'),pip=get('player-pip');
 let scrubbing=false,wasPlaying=false,previousVolume=1,loadingTimer;
 const duration=()=>Number.isFinite(video.duration)?video.duration:0;
 const clock=value=>{const seconds=Math.max(0,Math.floor(value||0)),h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=String(seconds%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${s}`:`${m}:${s}`;};
 const label=(element,text)=>{element.setAttribute('aria-label',text);element.title=text;};
 function updateTime(){const total=duration(),time=scrubbing?Number(seek.value):video.currentTime;seek.max=String(total||100);seek.disabled=!total;if(!scrubbing)seek.value=String(video.currentTime);seek.setAttribute('aria-valuetext',`${clock(time)} of ${clock(total)}`);get('player-current').textContent=clock(time);get('player-duration').textContent=clock(total);get('player-progress').value=total?time/total*100:0;}
 function updateBuffer(){let end=0;for(let i=0;i<video.buffered.length;i++){if(video.buffered.start(i)<=video.currentTime+.1&&video.buffered.end(i)>=video.currentTime)end=video.buffered.end(i);}get('player-buffer').value=duration()?end/duration()*100:0;}
 function updatePlayback(){root.classList.toggle('is-playing',!video.paused&&!video.ended);root.classList.toggle('is-ended',video.ended);center.hidden=!(video.paused||video.ended)||!!video.error;label(toggle,video.ended?'Replay (Space)':video.paused?'Play (Space)':'Pause (Space)');label(center,video.ended?'Replay video':'Play video');if(video.paused||video.ended)loading(false);}
 function loading(show){clearTimeout(loadingTimer);if(!show){get('player-loading').hidden=true;return;}loadingTimer=setTimeout(()=>{if(!video.paused&&!video.error)get('player-loading').hidden=false;},250);}
 async function play(){if(video.error)return;if(video.ended)video.currentTime=0;try{await video.play();}catch(error){if(error.name!=='AbortError'){get('player-error').hidden=false;get('player-error').querySelector('p').textContent='Playback could not start. Try again.';center.hidden=true;}}}
 function togglePlay(){if(video.paused||video.ended)void play();else video.pause();}
 function jump(seconds){if(duration())video.currentTime=Math.max(0,Math.min(duration(),video.currentTime+seconds));updateTime();}
 function updateVolume(){const muted=video.muted||video.volume===0;root.classList.toggle('is-muted',muted);volume.value=String(muted?0:video.volume);label(get('player-mute'),muted?'Unmute (M)':'Mute (M)');}
 function toggleMute(){if(video.muted||video.volume===0){video.muted=false;video.volume=previousVolume||1;}else{previousVolume=video.volume;video.muted=true;}updateVolume();}
 async function toggleFullscreen(){try{if(document.fullscreenElement===root)await document.exitFullscreen();else if(root.requestFullscreen)await root.requestFullscreen();else if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();}catch{announce('Fullscreen is not available in this browser.');}}
 function announce(text){const toast=document.getElementById('toast');toast.textContent=text;toast.hidden=false;setTimeout(()=>toast.hidden=true,3500);}
 toggle.onclick=togglePlay;center.onclick=togglePlay;video.onclick=togglePlay;video.ondblclick=()=>void toggleFullscreen();
 get('player-back').onclick=()=>jump(-10);get('player-forward').onclick=()=>jump(10);get('player-mute').onclick=toggleMute;
 volume.oninput=()=>{video.volume=Number(volume.value);video.muted=video.volume===0;if(video.volume)previousVolume=video.volume;};
 speed.onchange=()=>{video.playbackRate=Number(speed.value);video.preservesPitch=true;try{localStorage.setItem('vidcapture-speed',speed.value);}catch{}};
 try{const saved=localStorage.getItem('vidcapture-speed');if([...speed.options].some(o=>o.value===saved))speed.value=saved;}catch{}
 fullscreen.onclick=()=>void toggleFullscreen();fullscreen.hidden=!document.fullscreenEnabled&&!video.webkitEnterFullscreen;
 document.addEventListener('fullscreenchange',()=>{const full=document.fullscreenElement===root;root.classList.toggle('is-fullscreen',full);label(fullscreen,full?'Exit fullscreen (F)':'Fullscreen (F)');});
 pip.hidden=!document.pictureInPictureEnabled||!video.requestPictureInPicture;
 pip.onclick=async()=>{try{if(document.pictureInPictureElement===video)await document.exitPictureInPicture();else await video.requestPictureInPicture();}catch{announce('Picture in picture is not available right now.');}};
 video.addEventListener('enterpictureinpicture',()=>label(pip,'Exit picture in picture'));video.addEventListener('leavepictureinpicture',()=>label(pip,'Picture in picture'));
 function beginScrub(){if(scrubbing)return;scrubbing=true;wasPlaying=!video.paused;video.pause();root.classList.add('is-scrubbing');}
 function finishScrub(){if(!scrubbing)return;video.currentTime=Math.min(duration(),Number(seek.value));scrubbing=false;root.classList.remove('is-scrubbing');get('seek-preview').hidden=true;updateTime();if(wasPlaying)void play();}
 seek.addEventListener('pointerdown',event=>{beginScrub();seek.setPointerCapture(event.pointerId);});
 seek.addEventListener('input',()=>{video.currentTime=Number(seek.value);updateTime();});
 seek.addEventListener('change',finishScrub);seek.addEventListener('pointerup',finishScrub);seek.addEventListener('pointercancel',finishScrub);seek.addEventListener('lostpointercapture',finishScrub);
 seek.addEventListener('pointermove',event=>{const rect=seek.getBoundingClientRect(),fraction=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));const preview=get('seek-preview');preview.textContent=clock(fraction*duration());preview.style.left=`${Math.max(30,Math.min(rect.width-30,fraction*rect.width))}px`;preview.hidden=!duration();});
 seek.addEventListener('pointerleave',()=>{get('seek-preview').hidden=true;});
 root.addEventListener('keydown',event=>{
  if(event.altKey||event.ctrlKey||event.metaKey||event.target.closest('input,select,textarea'))return;
  if((event.key===' '||event.key==='Enter')&&event.target.closest('button'))return;
  const key=event.key.toLowerCase();
  if(key===' '||key==='k')togglePlay();else if(key==='arrowleft')jump(-5);else if(key==='arrowright')jump(5);else if(key==='j')jump(-10);else if(key==='l')jump(10);else if(key==='m')toggleMute();else if(key==='f')void toggleFullscreen();else if(key==='home'){video.currentTime=0;}else if(key==='end'&&duration()){video.currentTime=duration();}else return;
  event.preventDefault();
 });
 for(const name of ['play','pause','ended'])video.addEventListener(name,updatePlayback);
 for(const name of ['timeupdate','seeking','seeked','durationchange'])video.addEventListener(name,updateTime);
 for(const name of ['progress','timeupdate','loadedmetadata'])video.addEventListener(name,updateBuffer);
 video.addEventListener('volumechange',updateVolume);
 video.addEventListener('ratechange',()=>{speed.value=String(video.playbackRate);});
 for(const name of ['waiting','stalled'])video.addEventListener(name,()=>loading(true));
 for(const name of ['playing','canplay','seeked'])video.addEventListener(name,()=>loading(false));
 video.addEventListener('loadedmetadata',()=>{video.playbackRate=Number(speed.value);video.preservesPitch=true;updateTime();});
 function showError(){loading(false);get('player-error').hidden=false;get('player-error').querySelector('p').textContent='This video could not load. Check your connection and try again.';center.hidden=true;}
 video.addEventListener('error',showError);
 get('player-retry').onclick=()=>{get('player-error').hidden=true;video.load();void play();};
 // Keep native controls as a fallback until the custom controls are wired.
 video.playbackRate=Number(speed.value);video.preservesPitch=true;video.controls=false;get('player-controls').hidden=false;root.classList.add('custom-player');updatePlayback();updateTime();updateVolume();if(video.error)showError();
})();
