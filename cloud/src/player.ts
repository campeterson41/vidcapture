const icons:Record<string,string>={
 play:'<path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none"/>',
 pause:'<path d="M8 5v14M16 5v14" stroke-width="4"/>',
 back:'<path d="M4 9a8 8 0 1 1-1 7M4 4v5h5"/><text x="12" y="16" text-anchor="middle" stroke="none" fill="currentColor" font-size="9" font-family="sans-serif">10</text>',
 forward:'<path d="M20 9a8 8 0 1 0 1 7M20 4v5h-5"/><text x="12" y="16" text-anchor="middle" stroke="none" fill="currentColor" font-size="9" font-family="sans-serif">10</text>',
 volume:'<path d="M11 4 5 9H2v6h3l6 5zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
 muted:'<path d="M11 4 5 9H2v6h3l6 5zM16 9l6 6M22 9l-6 6"/>',
 fullscreen:'<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>',
 exit:'<path d="M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3"/>',
 replay:'<path d="M4 9a8 8 0 1 1-1 7M4 4v5h5"/>',
 cc:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 10.2a2.3 2.3 0 1 0 0 3.6M17 10.2a2.3 2.3 0 1 0 0 3.6"/>',
 pip:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M12 11h7v6h-7z" fill="currentColor" stroke="none"/>'
};
const icon=(name:string)=>`<svg class="player-icon icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const button=(id:string,label:string,content:string)=>`<button type="button" class="player-button" id="${id}" aria-label="${label}" title="${label}">${content}</button>`;
export function player(share:string){return `<section class="player" id="video-player" aria-label="Video player" tabindex="0">
 <div class="video-stage"><video id="watch-video" controls playsinline preload="metadata" src="/media/${share}" data-share="${share}"></video>
 <button type="button" class="center-play" id="center-play" aria-label="Play video" hidden>${icon('play')}${icon('replay')}</button>
 <div class="player-loading" id="player-loading" role="status" hidden><span class="player-spinner"></span><span class="sr-only">Loading video</span></div>
 <div class="player-error" id="player-error" role="alert" hidden><p>This video could not load.</p><button type="button" class="quiet" id="player-retry">Try again</button></div></div>
 <div class="player-controls" id="player-controls" hidden>
  <div class="seek-wrap" id="seek-wrap"><progress id="player-buffer" max="100" value="0" aria-hidden="true"></progress><progress id="player-progress" max="100" value="0" aria-hidden="true"></progress><input id="player-seek" type="range" min="0" max="100" step="0.01" value="0" aria-label="Seek video" aria-valuetext="0:00"><output id="seek-preview" hidden></output></div>
  <div class="player-toolbar"><div class="player-group">
   ${button('player-toggle','Play (Space)',icon('play')+icon('pause')+icon('replay'))}
   ${button('player-back','Back 10 seconds (J)',icon('back'))}${button('player-forward','Forward 10 seconds (L)',icon('forward'))}
   <span class="player-time"><span id="player-current">0:00</span><span class="time-divider"> / </span><span id="player-duration">0:00</span></span>
  </div><div class="player-group player-options">
   <div class="volume-control">${button('player-mute','Mute (M)',icon('volume')+icon('muted'))}<input id="player-volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume"></div>
   <select id="speed" aria-label="Playback speed" title="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option><option value="3">3×</option></select>
   ${button('player-cc','Captions (C)',icon('cc'))}${button('player-pip','Picture in picture',icon('pip'))}${button('player-fullscreen','Fullscreen (F)',icon('fullscreen')+icon('exit'))}
  </div></div>
 </div>
</section><script defer src="/player.js"></script>`;}
