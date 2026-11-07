// Private, local-only control channel. Browser pages cannot reach this Unix socket.
const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const LIVE=new Set(['recording','paused']);
const MUTATIONS=new Set(['configure','select','pick','preview','start','pause','resume','stop','open','library']);
function publicState(recorder,pending=null){
 const s=recorder.snapshot();
 return {phase:s.phase,elapsed:s.elapsed||0,target:s.target,settings:s.settings,devices:s.devices,
  cameraPreview:!!s.cameraPreview,cameraRunning:!!recorder.camera,cameraPid:recorder.camera?.pid||null,
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
 const state=()=>({...publicState(recorder,pending),...(surfaces.picker?{phase:'selecting'}:{})});
 async function execute(m){
  if(!m||typeof m!=='object'||typeof m.id!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(m.id))throw new Error('Invalid request.');
  if(m.action==='status')return state();
  if(m.action==='sources')return {windows:await recorder.listWindows()};
  if(!MUTATIONS.has(m.action))throw new Error('Unknown action.');
  const signature=JSON.stringify([m.action,m.settings,m.target,m.enabled]);
  if(requests.has(m.id)){
   const cached=requests.get(m.id);if(cached.signature!==signature)throw new Error('Request identifier was reused.');return cached.promise;
  }
  if(pending)throw new Error('Wait for the current action to finish.');
  if(surfaces.picker&&m.action!=='open')throw new Error('Finish choosing your recording area, or press Escape to cancel.');
  pending=m.action;
  const promise=(async()=>{
   switch(m.action){
    case 'configure': {
     const allowed=new Set(['camera','microphone','systemAudio','cameraSize','countdown']);
     if(!m.settings||Array.isArray(m.settings)||Object.keys(m.settings).some(k=>!allowed.has(k)))throw new Error('Invalid settings.');
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
    case 'open':show();break;
    case 'library':await actions.openLibrary();break;
   }
   return state();
  })().finally(()=>{pending=null;});
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
module.exports={startExtensionBridge,publicState};
