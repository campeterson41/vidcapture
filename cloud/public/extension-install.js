'use strict';
// This page only copies visible setup text. It never installs or runs software.
for(const button of document.querySelectorAll('[data-extension-copy]')){
 button.addEventListener('click',async()=>{
  const text=document.getElementById(button.dataset.extensionCopy),status=document.getElementById('extension-copy-status');
  if(!text||!status)return;
  const label=button.textContent;button.disabled=true;status.textContent='';
  try{await navigator.clipboard.writeText(text.value);status.textContent='Installation prompt copied.';}
  catch{
   const details=text.closest('details');if(details)details.open=true;
   text.focus();text.select();status.textContent='Copy was unavailable. The prompt is selected below; press Ctrl+C to copy it.';
  }finally{button.disabled=false;button.textContent=label;}
 });
}
