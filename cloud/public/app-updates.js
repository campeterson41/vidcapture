'use strict';
(()=>{
 const banner=document.getElementById('app-update-notice');
 if(banner){
  const key='vidcapture-update-dismissed';
  try{banner.hidden=localStorage.getItem(key)===banner.dataset.release;}catch{}
  banner.querySelector('[data-dismiss-update]').addEventListener('click',()=>{
   banner.hidden=true;try{localStorage.setItem(key,banner.dataset.release);}catch{}
  });
 }
 for(const link of document.querySelectorAll('[data-open-updater]'))link.addEventListener('click',()=>{
  const scope=link.closest('aside,section'),feedback=scope?.querySelector('[data-update-feedback]');
  if(feedback)feedback.hidden=false;
  // A browser does not report whether the app opened or updated. Leave help visible.
 });
 document.querySelector('[data-copy-update]')?.addEventListener('click',async()=>{
  const code=document.getElementById('update-commands'),status=document.getElementById('update-copy-status');
  try{await navigator.clipboard.writeText(code.textContent);status.textContent='Upgrade commands copied.';}
  catch{const range=document.createRange();range.selectNodeContents(code);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);status.textContent='Copy is unavailable. The commands are selected so you can copy them.';}
 });
})();
