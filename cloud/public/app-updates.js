'use strict';
(()=>{
 const banner=document.getElementById('app-update-notice');
 if(banner&&banner.dataset.required!=='true'){
  const key='vidcapture-update-dismissed';
  try{banner.hidden=localStorage.getItem(key)===banner.dataset.release;}catch{}
  banner.querySelector('[data-dismiss-update]').addEventListener('click',()=>{
   banner.hidden=true;try{localStorage.setItem(key,banner.dataset.release);}catch{}
  });
 }
 for(const button of document.querySelectorAll('[data-check-upgrade]'))button.addEventListener('click',async()=>{
  const status=button.closest('aside,section').querySelector('[data-upgrade-status]');button.disabled=true;status.textContent='Checking the connected app…';
  try{const response=await fetch('/api/app-upgrade',{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not check the app. Try again.');
   if(data.required)status.textContent='A connected computer still needs the one-time update. Open Online library from the updated app on that computer, then check again.';
   else if(button.hasAttribute('data-stay-on-page')){status.textContent='This account is ready to upload. ';const link=document.createElement('a');link.href='/library';link.textContent='Open My videos';status.append(link);}
   else location.reload();
  }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
 });
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
