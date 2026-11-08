// Private, local-only control channel. Browser pages cannot reach this Unix socket.
const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const CONFIGURABLE=new Set(['camera','microphone','systemAudio','cameraSize','cameraCorner','cameraCorrection','cameraLighting','cameraBackground','cameraBlur','cameraBackgroundImage','micNoise','micGate','micRumble','micBackup','fps','quality','resolution','countdown']);
const ARGS={configure:['settings'],select:['target'],preview:['enabled'],setCameraControl:['name','value'],setMicLevel:['percent'],removeBackground:['name','confirmed'],resetCameraControls:['confirmed'],restart:['confirmed'],discard:['confirmed']};
const SETTINGS_ACTIONS=new Set(['configure','refreshDevices','setCameraControl','resetCameraControls','setMicLevel','addBackground','removeBackground','chooseOutputDir','retryCleanup']);
const IDLE_ACTIONS=new Set([...SETTINGS_ACTIONS,'select','pick','preview','start']);
const LIVE=new Set(['recording','paused']);
const MUTATIONS=new Set(['configure','select','pick','preview','start','pause','resume','stop','open','library','refreshDevices','setCameraControl','resetCameraControls','setMicLevel','addBackground','removeBackground','chooseOutputDir','openFolder','retryCleanup','restart','discard']);
function publicState(recorder,pending=null){
 const s=recorder.snapshot();
 return {phase:s.phase,elapsed:s.elapsed||0,target:s.target,settings:s.settings,devices:s.devices,
  cameraPreview:!!s.cameraPreview,cameraRunning:!!recorder.camera,cameraPid:recorder.camera?.pid||null,
  outputFolder:path.basename(s.outputDir||recorder.outputDir||''),shortcuts:s.shortcuts||{},micCleanupError:s.micCleanupError||null,
  pending,error:s.error||null,processing:!!s.job?.running,
  saved:s.lastFile?{name:path.basename(s.lastFile)}:null,
  recent:(s.recent||[]).slice(0,3).map(r=>({name:r.title||r.name,created:r.created}))};
}
async function startExtensionBridge({recorder,actions,surfaces,show,socketPath=path.join(recorder.dataDir,'extension.sock')}){
 const directory=path.dirname(socketPath);await fs.mkdir(directory,{recursive:true,mode:0o700});
 // Refuse to replace a live server, including one belonging to another task.
 try{
  await new Promise((resolve,reject)=>{const c=net.createConnection(socketPath);c.setTimeout(500);c.once('connect',()=>{c.destroy();resolve();});c.once('error',reject);c.once('timeout',()=>{c.destroy();reject(Object.assign(new Error('Control socket is unresponsive.'),{code:'ETIMEDOUT'}));});});
  throw new Error('VidCapture browser controls are already running.');
 }catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
 await fs.rm(socketPath,{force:true});
 let pending=null,closed=false;const requests=new Map(),connections=new Set();
 const state=()=>({...publicState(recorder,pending||(surfaces.startPending?'start':null)),settingsLocked:!!(surfaces.startPending||surfaces.retaking||surfaces.busy?.()),...(surfaces.picker?{phase:'selecting'}:{})});
 async function execute(m){
  if(!m||typeof m!=='object'||typeof m.id!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(m.id))throw new Error('Invalid request.');
  if(Object.keys(m).some(k=>k!=='id'&&k!=='action'&&!(ARGS[m.action]||[]).includes(k)))throw new Error('Unexpected request field.');
  if(m.action==='status')return state();
  if(m.action==='studio'){const selection={camera:recorder.state.settings.camera,microphone:recorder.state.settings.microphone};const info=await actions.studioInfo();return {selection,camera:info.camera?{controls:info.camera.controls||[],saved:info.camera.saved||[],error:info.camera.error||null}:null,mic:info.mic?{percent:info.mic.percent,error:info.mic.error||null}:null,audio:info.audio,effects:info.effects,cleanup:info.cleanup};}
  if(m.action==='sources')return {windows:await recorder.listWindows()};
  if(!MUTATIONS.has(m.action))throw new Error('Unknown action.');
  const signature=JSON.stringify([m.action,m.settings,m.target,m.enabled,m.name,m.value,m.percent,m.confirmed]);
  if(requests.has(m.id)){
   const cached=requests.get(m.id);if(cached.signature!==signature)throw new Error('Request identifier was reused.');return cached.promise;
  }
  if(pending)throw new Error('Wait for the current action to finish.');
  if(surfaces.picker&&m.action!=='open')throw new Error('Finish choosing your recording area, or press Escape to cancel.');
  if(IDLE_ACTIONS.has(m.action)&&(surfaces.startPending||surfaces.retaking||surfaces.busy?.()))throw new Error('Wait for the desktop recording action to finish.');
  pending=m.action;
  if(SETTINGS_ACTIONS.has(m.action))surfaces.extensionMutation=true;
  const promise=(async()=>{
   switch(m.action){
    case 'configure': {
     recorder.idleOnly();
     if(!m.settings||typeof m.settings!=='object'||Array.isArray(m.settings)||Object.keys(m.settings).some(k=>!CONFIGURABLE.has(k)))throw new Error('Invalid settings.');
     if(m.settings.cameraBackgroundImage&&!((await recorder.cameraEffects.images()).includes(m.settings.cameraBackgroundImage)))throw new Error('Choose an existing background image.');
     await actions.saveSettings(m.settings);break;
    }
    case 'select': {
     if(typeof m.target!=='string'||m.target.length>120)throw new Error('Invalid source.');
     if(m.target!=='camera'&&!recorder.state.devices.monitors.some(d=>d.id===m.target)&&!/^window:0x[a-f0-9]+$/i.test(m.target))throw new Error('Choose a connected display or an open window.');
     const preview=!!recorder.camera;
     try{await recorder.chooseTarget(m.target);}
     finally{if(preview&&!recorder.camera&&recorder.state.settings.camera!=='none')await recorder.openCamera();}
     break;
    }
    case 'pick':recorder.idleOnly();await surfaces.openPicker('area',{intent:'select',origin:'extension'});break;
    case 'preview':
     recorder.idleOnly();if(typeof m.enabled!=='boolean')throw new Error('Invalid camera request.');
     if(m.enabled&&!recorder.camera)await recorder.openCamera();else if(!m.enabled&&recorder.camera)await recorder.closeCamera();break;
    case 'start':recorder.idleOnly();surfaces.closePanel?.();await actions.start();break;
    case 'pause':if(recorder.state.phase==='recording')await recorder.pause();else if(recorder.state.phase!=='paused')throw new Error('No recording is running.');break;
    case 'resume':if(recorder.state.phase==='paused')await recorder.pause();else if(recorder.state.phase!=='recording')throw new Error('No recording is paused.');break;
    case 'stop':if(LIVE.has(recorder.state.phase))await recorder.stop();else if(!['saved','stopping'].includes(recorder.state.phase))throw new Error('No recording is running.');break;
    case 'refreshDevices':recorder.idleOnly();await actions.refreshDevices();break;
    case 'setCameraControl':
     recorder.idleOnly();if(typeof m.name!=='string'||!/^[a-z0-9_]{1,80}$/.test(m.name)||!Number.isInteger(m.value))throw new Error('Invalid camera control.');
     await actions.setCameraControl(m.name,m.value);break;
    case 'resetCameraControls':recorder.idleOnly();if(m.confirmed!==true)throw new Error('Confirm resetting camera controls.');await actions.resetCameraControls();break;
    case 'setMicLevel':recorder.idleOnly();if(!Number.isInteger(m.percent)||m.percent<0||m.percent>150)throw new Error('Mic level must be between 0 and 150 percent.');await actions.setMicLevel(m.percent);break;
    case 'addBackground':recorder.idleOnly();await actions.addBackground();break;
    case 'removeBackground':
     recorder.idleOnly();if(m.confirmed!==true)throw new Error('Confirm removing the background image.');
     if(typeof m.name!=='string'||!(await recorder.cameraEffects.images()).includes(m.name))throw new Error('Choose an existing background image.');
     await actions.removeBackground(m.name);break;
    case 'chooseOutputDir':recorder.idleOnly();await actions.chooseOutputDir();break;
    case 'openFolder':await actions.openFolder();break;
    case 'retryCleanup':recorder.idleOnly();await actions.saveSettings({});break;
    case 'restart':case 'discard':
     if(!LIVE.has(recorder.state.phase))throw new Error('No recording is running.');
     if(m.confirmed!==true)throw new Error('Confirm discarding this take.');
     await actions[m.action]();break;
    case 'open':show();break;
    case 'library':await actions.openLibrary();break;
   }
   // A successful response describes the completed action, not a stale busy state.
   pending=null;if(SETTINGS_ACTIONS.has(m.action))surfaces.extensionMutation=false;
   return state();
  })().finally(()=>{pending=null;if(SETTINGS_ACTIONS.has(m.action))surfaces.extensionMutation=false;});
  requests.set(m.id,{signature,promise});
  // Keep a bounded replay cache. Never evict an in-flight command.
  if(requests.size>100)requests.delete(requests.keys().next().value);
  return promise;
 }
 const server=net.createServer(c=>{
  connections.add(c);c.once('close',()=>connections.delete(c));c.on('error',()=>{});c.setTimeout(180000,()=>c.destroy());
  let buffer='',handled=false;
  c.on('data',chunk=>{
   if(handled)return;buffer+=chunk.toString();
   if(Buffer.byteLength(buffer)>8192){handled=true;c.end(JSON.stringify({ok:false,error:'Message too large.'})+'\n');return;}
   const end=buffer.indexOf('\n');if(end<0)return;handled=true;
   Promise.resolve().then(()=>JSON.parse(buffer.slice(0,end))).then(execute).then(result=>c.end(JSON.stringify({ok:true,result})+'\n'),e=>c.end(JSON.stringify({ok:false,error:e.message})+'\n'));
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
 await fs.chmod(socketPath,0o600);
 return {execute,state,async close(){if(closed)return;closed=true;for(const c of connections)c.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(socketPath,{force:true});}};
}
module.exports={startExtensionBridge,publicState,CONFIGURABLE};
