'use strict';
const $=id=>document.getElementById(id),livePhases=new Set(['starting','recording','paused','stopping']);
let state=null,mode='monitor',view='record',windows=[],busy=false,polling=false,connected=false,localError=null,studio=null,studioLoading=false,confirmation=null,studioKey=null,studioRequestedKey=null,studioEpoch=0,stateEpoch=0,returnFocus=null,confirmReturnFocus=null;
const clock=seconds=>{const n=Math.floor(Math.max(0,seconds));return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;};
const studioSignature=()=>JSON.stringify([state?.settings.camera,state?.settings.microphone,state?.settings.micNoise,state?.settings.micGate,state?.settings.micRumble,state?.micCleanupError||null,livePhases.has(state?.phase),state?.devices.cameras.map(d=>d.id),state?.devices.microphones.map(d=>d.id)]);
function invalidateStudio(){studioEpoch++;studio=null;studioKey=null;studioRequestedKey=null;studioLoading=false;}
const extensionVersion=chrome.runtime.getManifest?.()?.version||'';
const isLive=()=>!!state&&(livePhases.has(state.phase)||state.pending==='start');
const locked=()=>busy||!!state?.pending||isLive()||state?.phase==='selecting'||state?.processing||state?.settingsLocked||!connected;
function rpc(message){return new Promise((resolve,reject)=>{
 chrome.runtime.sendMessage(message,reply=>{
  const error=chrome.runtime.lastError;
  if(error||!reply?.ok)reject(new Error(reply?.error||error?.message||'VidCapture did not respond. Try connecting again.'));else resolve(reply.result);
 });
});}
function options(select,items,value){
 const signature=JSON.stringify(items);
 if(select.dataset.options!==signature){select.replaceChildren(...items.map(([id,label])=>new Option(label,id)));select.dataset.options=signature;}
 if(value!==undefined&&[...select.options].some(o=>o.value===String(value)))select.value=String(value);
}
function sources(){
 const target=state?.target;
 $('source-label').hidden=mode==='region'||mode==='camera';$('pick').hidden=mode!=='region';$('camera-note').hidden=mode!=='camera';
 $('source-label').querySelector('span').textContent=mode==='window'?'Window to record':'Screen to record';
 if(mode==='monitor')options($('source'),[['','Choose a screen'],...(state?.devices.monitors||[]).map(d=>[d.id,d.name])],target?.kind==='monitor'?target.monitor:'');
 if(mode==='window')options($('source'),[['','Choose a window'],...windows.map(w=>['window:'+w.id,w.title||w.label||w.class||'Window'])],target?.kind==='window'?'window:'+target.address:'');
 $('pick').textContent=target?.kind==='region'?`${target.width} × ${target.height} · Draw again`:'Draw an area ↗';
 for(const b of document.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===mode));
}
function renderHardware(disabled){
 const controls=studioKey===studioSignature()?studio?.camera?.controls||[]:[],root=$('camera-controls');
 const signature=JSON.stringify(controls.map(c=>[c.name,c.label,c.section,c.type,c.min,c.max,c.step,c.options]));
 if(root.dataset.signature!==signature){
  const nodes=[];let section=null;
  for(const c of controls){
   if(section!==c.section){section=c.section;const heading=document.createElement('h3');heading.textContent=({exposure:'Exposure',color:'Color',framing:'Framing',other:'Other'})[section]||'Other';nodes.push(heading);}
   const row=document.createElement('div');row.className='hardware-control';
   const label=document.createElement('label');label.htmlFor='hardware-'+c.name;label.textContent=c.label;
   const input=document.createElement(c.type==='menu'||c.type==='intmenu'?'select':'input');input.id='hardware-'+c.name;input.dataset.control=c.name;
   if(c.type==='menu'||c.type==='intmenu')input.replaceChildren(...(c.options||[]).map(o=>new Option(o.label,o.value)));
   else if(c.type==='bool')input.type='checkbox';
   else{input.type='range';input.min=c.min;input.max=c.max;input.step=c.step;}
   const output=document.createElement('output');output.htmlFor=input.id;output.id='value-'+c.name;
   input.oninput=()=>{output.textContent=input.type==='checkbox'?(input.checked?'On':'Off'):input.value+(c.unit?' '+c.unit:'');};
   input.onchange=()=>command('setCameraControl',{name:c.name,value:input.type==='checkbox'?(input.checked?1:0):Number(input.value)});
   if(c.type==='bool')label.append(input);else{label.append(output);row.append(label,input);}
   if(c.type==='bool')row.append(label);nodes.push(row);
  }
  root.replaceChildren(...nodes);root.dataset.signature=signature;
 }
 for(const c of controls){
  const input=$('hardware-'+c.name);if(!input)continue;
  input.disabled=!!disabled||!!c.inactive;
  if(input.type==='checkbox'){if(!busy)input.checked=!!c.value;}else if(!busy&&document.activeElement!==input)input.value=String(c.value);
  const output=$('value-'+c.name);if(output)output.textContent=c.type==='bool'?(c.value?'On':'Off'):String(c.value)+(c.unit?' '+c.unit:'');
 }
 $('controls-note').textContent=studioLoading?'Reading camera controls…':studio?.camera?.error?'Camera controls could not be read. '+studio.camera.error:controls.length?'Automatic modes may disable their manual controls.':'This camera does not report additional supported controls.';
 $('reset-camera').hidden=!controls.length;$('reset-camera').disabled=!!disabled;
}
function renderSettings(){
 const s=state?.settings||{},disabled=!!locked(),noCamera=!s.camera||s.camera==='none',noMic=!s.microphone||s.microphone==='none',cameraOnly=mode==='camera',effects=studio?.effects;
 for(const el of document.querySelectorAll('[data-setting]')){
  const value=s[el.dataset.setting];if(value!==undefined&&!busy){if(el.type==='checkbox')el.checked=value;else el.value=String(value);}
  el.disabled=disabled||(el.hasAttribute('data-camera')&&noCamera)||(el.hasAttribute('data-mic')&&noMic);
 }
 const lockMessage=['recording','paused','stopping'].includes(state?.phase)?'Stop and save your recording before changing settings.':state?.pending==='start'||state?.phase==='starting'?'Recording is starting. Wait for the countdown to finish.':state?.processing?'Wait for video processing to finish before changing settings.':state?.phase==='selecting'?'Finish choosing your recording area first.':busy||state?.pending?'Applying your changes…':'Wait for the desktop recording action to finish.';
 for(const el of document.querySelectorAll('.locked-note')){el.hidden=!disabled||!connected;el.textContent=lockMessage;}
 $('camera-off-note').hidden=!noCamera;
 $('blur-row').hidden=s.cameraBackground!=='blur';$('image-settings').hidden=s.cameraBackground!=='image';
 const unavailable=studio!==null&&!effects?.available;
 for(const option of $('background').options)option.disabled=option.value!=='off'&&(cameraOnly||unavailable||studioLoading||!studio);
 $('effects-note').hidden=!cameraOnly&&!unavailable;
 $('effects-note').textContent=cameraOnly?'Background effects, bubble lighting, and lens correction do not apply to camera-only recording. Choose Original background to record your camera.':unavailable?'Background effects are not installed in the desktop app. Open the desktop app for setup.':'';
 $('blur').disabled=disabled||noCamera||cameraOnly||!effects?.available;
 options($('background-image'),[['','Choose an image'],...(effects?.backgrounds||[]).map(name=>[name,name])],s.cameraBackgroundImage||'');
 $('background-image').disabled=disabled||noCamera||cameraOnly||!effects?.available;
 $('add-background').disabled=disabled||noCamera||cameraOnly||!effects?.available;
 $('remove-background').disabled=disabled||!s.cameraBackgroundImage||!(effects?.backgrounds||[]).includes(s.cameraBackgroundImage);
 for(const id of ['camera-size','camera-corner','camera-lighting'])$(id).disabled=disabled||noCamera||cameraOnly;
 const profile=state?.devices.cameras.find(c=>c.id===s.camera)?.profile;
 $('camera-correction').disabled=disabled||noCamera||cameraOnly||!profile?.lensCorrection;
 $('profile-note').textContent=cameraOnly?'Bubble size, position, and lighting do not affect camera-only recordings.':profile?.lensCorrection?(profile.note||'Lens correction is available for this camera.'):'Lens correction is not available for this camera.';
 const fitted=profile?.lensCorrection&&s.cameraCorrection==='computer'?Object.entries(profile.fittedAt||{}):[];const drift=fitted.filter(([name,value])=>studio?.camera?.controls.some(c=>c.name===name&&c.value!==value));if(!cameraOnly&&drift.length)$('profile-note').textContent+=' Lens correction was calibrated at '+drift.map(([name,value])=>(studio.camera.controls.find(c=>c.name===name)?.label||name.replace(/_/g,' '))+': '+value).join(', ')+'.';
 $('mic-level').disabled=disabled||noMic||!Number.isFinite(studio?.mic?.percent);
 if(!busy&&document.activeElement!==$('mic-level')&&Number.isFinite(studio?.mic?.percent))$('mic-level').value=studio.mic.percent;
 $('mic-level-value').textContent=Number.isFinite(studio?.mic?.percent)?studio.mic.percent+'%':'';
 $('mic-level-note').hidden=!noMic&&!studio?.mic?.error;$('mic-level-note').textContent=noMic?'Choose a microphone on the recording panel.':studio?.mic?.error||'';
 $('noise-note').hidden=studio===null||!!studio.audio?.noise&&s.micNoise==='on';$('noise-note').textContent=studio?.audio?.noise?'Turn on noise removal to use the voice gate.':'Noise removal requires the desktop audio cleanup plugin. Voice gate works with noise removal.';
 $('mic-noise').disabled=disabled||noMic||studioKey!==studioSignature();
 for(const option of $('mic-noise').options)option.disabled=option.value==='on'&&studio!==null&&!studio.audio?.noise;
 $('mic-gate').disabled=disabled||noMic||s.micNoise!=='on'||!studio?.audio?.noise;
 $('mic-backup').disabled=disabled||noMic||!(s.micNoise==='on'||s.micRumble);
 const cleanupError=state?.micCleanupError||null;
 $('cleanup-health').hidden=!cleanupError;$('cleanup-error').textContent=cleanupError||'';$('retry-cleanup').disabled=disabled||noMic;
 $('output-folder').textContent=state?.outputFolder||'Desktop app’s recording folder';$('change-folder').disabled=disabled;$('open-folder').disabled=!connected||busy;
 $('fps').disabled=disabled||cameraOnly;
 const keys=state?.shortcuts||{};$('shortcuts').textContent=Object.entries(keys).filter(([,v])=>typeof v==='string').map(([k,v])=>`${k}: ${v}`).join(' · ')||'Use the desktop app’s configured recording shortcuts.';
 renderHardware(disabled||noCamera);
}
function render(){
 const live=isLive(),disabled=!!locked(),pending=busy||!!state?.pending;
 document.body.dataset.settings=String(view!=='record');
 $('view-title').textContent=({record:live?'Recording':'New recording',camera:'Camera & background',audio:'Audio',recording:'Recording settings'})[view];
 $('extension-version').hidden=view==='record'||!extensionVersion;$('extension-version').textContent=extensionVersion?'Extension '+extensionVersion:'';
 $('back').hidden=view==='record';$('refresh-devices').hidden=view!=='record'||live;$('refresh-devices').disabled=disabled;
 for(const page of document.querySelectorAll('[data-page]'))page.hidden=page.dataset.page!==view;
 $('connection-text').textContent=connected?(state?.processing?'Desktop app is processing a video':'Connected to desktop app'):'Desktop app unavailable';$('retry').hidden=connected;
 $('setup').hidden=live;$('session').hidden=!live;$('record').hidden=live||view!=='record';
 $('elapsed').textContent=clock(state?.elapsed||0);$('session-label').textContent=state?.pending==='start'?'Starting…':({paused:'Paused',stopping:'Saving…',starting:'Starting…',recording:'Recording'})[state?.phase]||'Recording';
 $('target-name').textContent=state?.target?.label||'Your selected source';
 $('pause').textContent=state?.phase==='paused'?'Resume':'Pause';
 for(const id of ['pause','stop','restart-take','discard-take'])$(id).disabled=pending||!connected||!['recording','paused'].includes(state?.phase);
 for(const el of document.querySelectorAll('#setup select,#setup input,#setup button:not([data-view])'))el.disabled=disabled;
 $('record').disabled=disabled||!state?.target||state.target.available===false||state.target.kind!==mode||(mode==='camera'&&(state.settings.camera==='none'||state.settings.cameraBackground!=='off'));
 $('record-label').textContent=pending?'Working…':state?.phase==='selecting'?'Choose your recording area…':state?.target?.kind!==mode?'Choose a source to start':mode==='camera'&&state?.settings.cameraBackground!=='off'?'Set camera background to Original':'Start recording';
 $('preview').disabled=disabled||state?.settings.camera==='none';$('preview').textContent=state?.cameraPreview?'Hide':'Preview';$('preview').setAttribute('aria-pressed',String(!!state?.cameraPreview));
 $('error').hidden=!localError&&!state?.error;$('error').textContent=localError||state?.error||'';
 $('saved').hidden=!state?.saved||live;$('saved-name').textContent=state?.saved?.name||'';
 if(state){
  options($('camera'),[['none','Camera off'],...state.devices.cameras.map(d=>[d.id,d.name])],busy?undefined:state.settings.camera);
  options($('microphone'),[['none','Microphone off'],['default_input','System default'],...state.devices.microphones.map(d=>[d.id,d.name])],busy?undefined:state.settings.microphone);
  if(!busy)$('system-audio').checked=state.settings.systemAudio;
  $('camera-summary').textContent=({off:'Original background',blur:'Blur · '+state.settings.cameraBlur,image:'Image background'})[state.settings.cameraBackground]||'Size, lighting, blur, and image';
  $('audio-summary').textContent=state.settings.micNoise==='on'?'Noise removal on':state.settings.micRumble?'Rumble filter on':'Mic level and cleanup';
  $('recording-summary').textContent=`${state.settings.resolution==='0x0'?'Match source':'1080p'} · ${state.settings.fps||30} fps · ${state.settings.quality?.replace('_',' ')||'High'}`;
 }
 sources();if(view!=='record')renderSettings();
 $('confirm').hidden=!confirmation;$('confirm-text').textContent=confirmation?.text||'';$('confirm-yes').disabled=busy||!connected;
}
async function loadStudio(force=false){
 if(!connected)return;const key=studioSignature();if(!force&&studioLoading&&studioRequestedKey===key)return;
 const epoch=++studioEpoch;studioRequestedKey=key;studioLoading=true;render();
 try{
  const reply=await rpc({action:'studio'});
  if(epoch!==studioEpoch||studioSignature()!==key)return;
  if(reply.selection&&(reply.selection.camera!==state?.settings.camera||reply.selection.microphone!==state?.settings.microphone)){studio=null;studioKey=null;studioRequestedKey=null;return;}
  studio=reply;studioKey=key;
 }catch(e){if(epoch===studioEpoch)localError=e.message;}
 finally{if(epoch===studioEpoch){studioLoading=false;if(studioKey!==studioSignature()){studio=null;studioRequestedKey=null;}render();}}
}
async function command(action,extra={}){
 if(busy)return;stateEpoch++;busy=true;localError=null;$('save-status').textContent='';render();
 try{state=await rpc({action,...extra});connected=true;if(view!=='record')await loadStudio(true);if(['configure','setMicLevel','setCameraControl','resetCameraControls','removeBackground'].includes(action))$('save-status').textContent='Settings saved';}
 catch(e){localError=e.message;try{state=await rpc({action:'status'});if(view!=='record')await loadStudio(true);}catch{connected=false;}}
 finally{busy=false;render();if(localError){$('viewport').scrollTop=0;$('error').focus?.();}else if(action==='stop'){$('viewport').scrollTop=0;$('saved').focus?.();}}
}
async function refresh(){
 if(polling||busy||document.hidden)return;polling=true;const epoch=stateEpoch;
 try{const previous=state;const next=await rpc({action:'status'});if(epoch!==stateEpoch)return;state=next;if(studioKey&&studioKey!==studioSignature())invalidateStudio();if(!connected)localError=null;connected=true;if(state.target&&(!previous||previous.target?.kind!==state.target.kind))mode=state.target.kind;}
 catch(e){connected=false;localError=e.message;}
 finally{polling=false;render();if(view!=='record'&&studioKey!==studioSignature()&&studioRequestedKey!==studioSignature())loadStudio();}
}
async function loadWindows(){try{windows=(await rpc({action:'sources'})).windows||[];sources();}catch(e){localError=e.message;render();}}
function focusVisible(element){if(element?.isConnected&&element.getClientRects?.().length&&!element.disabled)element.focus();else $('view-title').focus?.();}
async function navigate(next,trigger=null){const previous=view;if(next!=='record'&&view==='record')returnFocus=trigger||document.activeElement;view=next;confirmation=null;render();$('viewport').scrollTop=0;if(view==='record')focusVisible(returnFocus);else $('back').focus?.();if(view!=='record')await loadStudio(true);}
function confirmAction(text,action,extra={}){confirmReturnFocus=document.activeElement;confirmation={text,action,extra};render();$('confirm').scrollIntoView?.({block:'nearest'});$('confirm-no').focus?.();}
function cancelConfirmation(){confirmation=null;render();focusVisible(confirmReturnFocus);}
for(const button of document.querySelectorAll('[data-mode]'))button.onclick=async()=>{mode=button.dataset.mode;render();if(mode==='window')await loadWindows();else if(mode==='camera')await command('select',{target:'camera'});};
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>navigate(button.dataset.view,button);
for(const input of document.querySelectorAll('[data-setting]'))input.onchange=()=>{const value=input.type==='checkbox'?input.checked:input.hasAttribute('data-number')?Number(input.value):input.value;command('configure',{settings:{[input.dataset.setting]:value}});};
$('back').onclick=()=>navigate('record');$('source').onchange=()=>{if($('source').value)command('select',{target:$('source').value});};$('pick').onclick=()=>command('pick');
$('camera').onchange=()=>{invalidateStudio();command('configure',{settings:{camera:$('camera').value}});};$('microphone').onchange=()=>{invalidateStudio();command('configure',{settings:{microphone:$('microphone').value}});};$('system-audio').onchange=()=>command('configure',{settings:{systemAudio:$('system-audio').checked}});
$('preview').onclick=()=>command('preview',{enabled:!state?.cameraPreview});$('record').onclick=()=>{if(!state?.target||state.target.kind!==mode||$('record').disabled)return;command('start');};$('pause').onclick=()=>command(state?.phase==='paused'?'resume':'pause');$('stop').onclick=()=>command('stop');
$('refresh-devices').onclick=async()=>{invalidateStudio();await command('refreshDevices');if(mode==='window')loadWindows();};
$('mic-level').oninput=()=>{$('mic-level-value').textContent=$('mic-level').value+'%';};$('mic-level').onchange=()=>command('setMicLevel',{percent:Number($('mic-level').value)});
$('add-background').onclick=()=>command('addBackground');$('remove-background').onclick=()=>confirmAction('Remove this background image from VidCapture?','removeBackground',{name:state?.settings.cameraBackgroundImage});$('reset-camera').onclick=()=>confirmAction('Reset this camera’s hardware controls to its defaults?','resetCameraControls');
$('restart-take').onclick=()=>confirmAction('Discard this take and start a new recording with the same choices?','restart');$('discard-take').onclick=()=>confirmAction('Discard this take? Its recording file will be deleted.','discard');
$('confirm-no').onclick=cancelConfirmation;$('confirm-yes').onclick=async()=>{const c=confirmation;if(!c)return;confirmation=null;await command(c.action,{...c.extra,confirmed:true});if(!localError)focusVisible(confirmReturnFocus);};
$('retry-cleanup').onclick=()=>command('retryCleanup');$('change-folder').onclick=()=>command('chooseOutputDir');$('open-folder').onclick=()=>command('openFolder');
$('app').onclick=e=>{e.preventDefault();command('open');};$('edit').onclick=()=>command('open');$('library').onclick=()=>command('library');$('retry').onclick=()=>{localError=null;refresh();};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&confirmation){e.preventDefault();cancelConfirmation();}else if(e.key==='Escape'&&view!=='record'){e.preventDefault();navigate('record');}});
refresh().then(()=>{if(mode==='window')loadWindows();});setInterval(refresh,1000);setInterval(()=>{if(view!=='record'&&!locked()&&!studioLoading)loadStudio(true);},5000);
