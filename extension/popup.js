'use strict';
const $=id=>document.getElementById(id),livePhases=new Set(['starting','recording','paused','stopping']);
let state=null,mode='monitor',windows=[],busy=false,polling=false,connected=false,localError=null;
const clock=seconds=>{const n=Math.floor(Math.max(0,seconds));return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;};
function rpc(message){return new Promise((resolve,reject)=>{
 chrome.runtime.sendMessage(message,reply=>{
  const error=chrome.runtime.lastError;
  if(error||!reply?.ok)reject(new Error(reply?.error||error?.message||'VidCapture did not respond. Try connecting again.'));else resolve(reply.result);
 });
});}
function options(select,items,value){
 const signature=JSON.stringify(items);
 if(select.dataset.options!==signature){select.replaceChildren(...items.map(([id,label])=>new Option(label,id)));select.dataset.options=signature;}
 if(value!==undefined&&[...select.options].some(o=>o.value===value))select.value=value;
}
function sources(){
 const target=state?.target;
 $('source-label').hidden=mode==='region'||mode==='camera';$('pick').hidden=mode!=='region';$('camera-note').hidden=mode!=='camera';
 $('source-label').querySelector('span').textContent=mode==='window'?'Window to record':'Screen to record';
 if(mode==='monitor')options($('source'),[['','Choose a screen'],...(state?.devices.monitors||[]).map(d=>[d.id,d.name])],target?.kind==='monitor'?target.monitor:'');
 if(mode==='window')options($('source'),[['','Choose a window'],...windows.map(w=>['window:'+w.id,w.title||w.label||w.class||'Window'])],target?.kind==='window'?'window:'+target.address:'');
 $('pick').firstChild.textContent=target?.kind==='region'?`${target.width} × ${target.height} · Draw again `:'Draw an area ';
 for(const b of document.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===mode));
}
function render(){
 const live=!!state&&(livePhases.has(state.phase)||state.pending==='start');
 const pending=busy||!!state?.pending;
 const locked=pending||live||state?.phase==='selecting'||state?.processing||!connected;
 document.body.dataset.live=String(live);document.body.dataset.saved=String(!!state?.saved&&!live);
 $('connection').dataset.connected=String(connected);
 $('connection-text').textContent=connected?(live?'Desktop recorder is running':state?.processing?'Desktop app is processing a video':'Connected to the desktop app'):'Desktop recorder is unavailable';
 $('retry').hidden=connected;
 $('setup').hidden=live;$('session').hidden=!live;$('record').hidden=live;
 $('heading').textContent=live?(state.phase==='paused'?'Take your time.':state.phase==='stopping'?'Finishing your recording.':'You’re rolling.'):'A little more personal.';
 $('subheading').textContent=live?'Keep browsing. Your camera stays with you.':'Your screen, your voice, your camera.';
 $('scene-time').textContent=live?clock(state.elapsed):'Ready when you are';
 $('elapsed').textContent=clock(state?.elapsed||0);
 $('session-label').textContent=state?.pending==='start'?'Starting…':({paused:'Paused',stopping:'Saving…',starting:'Starting…',recording:'Recording'})[state?.phase]||'Recording';
 $('target-name').textContent=state?.target?.label||'Your selected source';
 $('pause').textContent=state?.phase==='paused'?'Resume':'Pause';
 $('pause').disabled=pending||!connected||!['recording','paused'].includes(state?.phase);
 $('stop').disabled=pending||!connected||!['recording','paused'].includes(state?.phase);
 for(const el of document.querySelectorAll('#setup button,#setup select,#setup input'))el.disabled=!!locked;
 $('record').disabled=!!locked||!state?.target||state.target.available===false||state.target.kind!==mode||(mode==='camera'&&state.settings.camera==='none');
 $('record-label').textContent=pending?'Working…':state?.phase==='selecting'?'Choose your recording area…':!state?.target?'Choose a source to start':'Start recording';
 $('preview').disabled=!!locked||state?.settings.camera==='none';
 $('preview').textContent=state?.cameraPreview?'Hide':'Preview';$('preview').setAttribute('aria-pressed',String(!!state?.cameraPreview));
 $('error').hidden=!localError&&!state?.error;$('error').textContent=localError||state?.error||'';
 $('saved').hidden=!state?.saved||live;$('saved-name').textContent=state?.saved?.name||'';
 $('footnote').textContent=live?'Closing this panel won’t stop your recording.':'Recorded by the desktop app. Share when you’re ready.';
 if(state){
  options($('camera'),[['none','Camera off'],...state.devices.cameras.map(d=>[d.id,d.name])],state.settings.camera);
  options($('microphone'),[['none','Microphone off'],['default_input','System default'],...state.devices.microphones.map(d=>[d.id,d.name])],state.settings.microphone);
  $('system-audio').checked=state.settings.systemAudio;$('countdown').checked=state.settings.countdown===3;
 }
 sources();
}
async function command(action,extra={}){
 if(busy)return;busy=true;localError=null;render();
 try{state=await rpc({action,...extra});connected=true;}
 catch(e){localError=e.message;}
 finally{busy=false;render();}
}
async function refresh(){
 if(polling||busy||document.hidden)return;polling=true;
 try{const previous=state;state=await rpc({action:'status'});if(!connected)localError=null;connected=true;if(state.target&&(!previous||previous.target?.kind!==state.target.kind)){mode=state.target.kind;sources();}}
 catch(e){connected=false;localError=e.message;}
 finally{polling=false;render();}
}
async function loadWindows(){try{windows=(await rpc({action:'sources'})).windows||[];sources();}catch(e){localError=e.message;render();}}
for(const button of document.querySelectorAll('[data-mode]'))button.onclick=async()=>{mode=button.dataset.mode;render();if(mode==='window')await loadWindows();else if(mode==='camera')await command('select',{target:'camera'});};
$('source').onchange=()=>{if($('source').value)command('select',{target:$('source').value});};
$('pick').onclick=()=>{command('pick');};
$('camera').onchange=()=>command('configure',{settings:{camera:$('camera').value}});
$('microphone').onchange=()=>command('configure',{settings:{microphone:$('microphone').value}});
$('system-audio').onchange=()=>command('configure',{settings:{systemAudio:$('system-audio').checked}});
$('countdown').onchange=()=>command('configure',{settings:{countdown:$('countdown').checked?3:0}});
$('preview').onclick=()=>command('preview',{enabled:!state?.cameraPreview});
$('record').onclick=()=>{if(!state?.target||state.target.kind!==mode||$('record').disabled)return;command('start');};$('pause').onclick=()=>command(state?.phase==='paused'?'resume':'pause');$('stop').onclick=()=>command('stop');
$('app').onclick=e=>{e.preventDefault();command('open');};$('edit').onclick=()=>command('open');$('library').onclick=()=>command('library');
$('retry').onclick=()=>{localError=null;refresh();};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
refresh().then(()=>{if(mode==='window')loadWindows();});
setInterval(refresh,1000);
