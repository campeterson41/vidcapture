'use strict';
const ORIGIN='https://vidcapture.stream',HOST='stream.vidcapture.launcher';
const status=document.getElementById('status'),record=document.getElementById('record');
// Recording happens in the VidCapture desktop app, which saves to this computer.
record.onclick=()=>{
 record.disabled=true;status.classList.remove('error');status.textContent='Opening VidCapture…';
 chrome.runtime.sendNativeMessage(HOST,{action:'record'},reply=>{
  record.disabled=false;
  if(chrome.runtime.lastError||!reply?.ok){status.classList.add('error');status.textContent=reply?.error||'VidCapture is not installed on this computer. Install the desktop app to record.';return;}
  window.close();
 });
};
document.getElementById('library').onclick=()=>{chrome.tabs.create({url:ORIGIN+'/library'});window.close();};
