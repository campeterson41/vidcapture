const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,dialog,shell,powerSaveBlocker,protocol,clipboard} = require('electron');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const {Readable}=require('node:stream');
const {createAutoCopy}=require('./autocopy.cjs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const {Recorder,ACTIVE}=require('./recorder.cjs');
const {MediaTools}=require('./media.cjs');
const {Transcripts}=require('./transcript.cjs');
const {Titles}=require('./titles.cjs');
const {Publisher,ORIGIN}=require('./publisher.cjs');
const {Surfaces}=require('./surfaces.cjs');
const {Library,versionBase}=require('./library.cjs');
const {AudioChain,ChainWatch,syncCleanup}=require('./audio-chain.cjs');
const {CameraSettings}=require('./camera-settings.cjs');
const {CameraEffects}=require('./camera-effects.cjs');
const {CameraProfiles}=require('./camera-profiles.cjs');
const {startExtensionBridge}=require('./extension-bridge.cjs');
const {shortcutsFrom}=require('./hotkeys.cjs');
const {Updates}=require('./updates.cjs');
protocol.registerSchemesAsPrivileged([{scheme:'capture-media',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
app.setName('Capture');
app.setPath('userData',path.join(app.getPath('appData'),'capture'));
const locked=app.requestSingleInstanceLock();
if(!locked){app.quit();}else{
  let win,tray,recorder,media,transcripts,publisher,surfaces,titles,editorFile=null,allowQuit=false,closing=false,inhibit=null,extensionBridge=null,micWatch=null,updates=null,updateDialog=false,restartUpdate=false;
  const show=()=>{if(win){win.show();if(win.isMinimized())win.restore();win.focus();}};
  // `capture --panel [--screen=NAME] [--x=N]` opens the record drop-down; the
  // top bar icon passes its screen and position. `--pick` is the older name.
  const panelArgs=argv=>{
    if(!argv.includes('--panel')&&!argv.includes('--pick'))return null;
    const screen=(argv.find(a=>a.startsWith('--screen='))||'').slice(9);
    const xs=argv.find(a=>a.startsWith('--x=')),x=xs?Number(xs.slice(4)):NaN;
    return {screen:/^[A-Za-z0-9_.-]{1,40}$/.test(screen)?screen:null,x:Number.isFinite(x)&&x>=0&&x<20000?x:null};
  };
  const openPanel=args=>surfaces.openPanel(args||{}).catch(e=>{console.error(e);show();});
  // `capture --toggle-recording` and `capture --toggle-pause` come from the
  // Hyprland shortcuts that install.sh adds (Electron's own global shortcuts
  // do not work under Wayland).
  const hotkey=argv=>argv.includes('--toggle-recording')?'record':argv.includes('--toggle-pause')?'pause':null;
  const runHotkey=kind=>(kind==='record'?surfaces.toggleRecording():surfaces.togglePause()).catch(e=>console.error('shortcut',e));
  app.on('second-instance',(_event,argv)=>{
    if(argv.includes('--extension-service'))return;
    const key=hotkey(argv);
    if(key){if(surfaces)runHotkey(key);return;}
    const args=panelArgs(argv);if(args&&surfaces)openPanel(args);else show();
  });
  async function requestClose(){
    if(closing)return;
    if(updates?.installing){await dialog.showMessageBox(win,{message:'VidCapture is preparing an update.',detail:'Wait for it to finish before quitting.'});return;}
    if(restartUpdate&&(surfaces.busy()||surfaces.picker||surfaces.counting||transcripts.job)){restartUpdate=false;throw new Error('Finish recording and processing before restarting.');}
    closing=true;
    if(restartUpdate)surfaces.updating=true;
    // No microphone recovery may start a chain once quitting begins, even if a step below
    // waits (the editor flush, a dialog). The watch restarts only if the close is abandoned.
    const watchDone=micWatch?.stop();
    try{
      if(win && !win.isDestroyed())await win.webContents.executeJavaScript('window.captureFlushEdits?.()');
      if(recorder.state.job?.running){
        const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['Keep processing','Cancel and quit'],defaultId:0,cancelId:0,message:'Your recording is still being processed.'});
        if(response!==1)return;publisher?.cancel();await media.cancelJob();if(media.task)await media.task;
      }
      if(ACTIVE.has(recorder.state.phase)){
        if(!['recording','paused'].includes(recorder.state.phase)){show();return;}
        const {response}=await dialog.showMessageBox(win,{type:'question',buttons:['Keep recording','Stop, save, and quit'],defaultId:0,cancelId:0,message:'A recording is in progress.'});
        if(response!==1)return;
        await recorder.stop();
      }
      const next=restartUpdate?await updates.activate():null;
      await extensionBridge?.close();
      // The microphone indicator's level readers are stopped and waited for (bounded). One
      // whose exit was not confirmed is reported, not assumed gone; quitting goes on.
      const meterEnd=await surfaces?.dispose();
      if(meterEnd?.unconfirmed?.length)console.error(`VidCapture: microphone level reader did not confirm its exit (pid ${meterEnd.unconfirmed.join(', ')}).`);
      // Stop the chain (which also cancels a recovery in progress) and wait for the watch to drain.
      await recorder.audioChain?.stop().catch(()=>{});await watchDone;
      await titles?.flush().catch(()=>{});media?.dispose();transcripts?.dispose();await recorder.dispose();
      if(next)app.relaunch({execPath:'/usr/bin/node',args:[path.join(next,'launch.cjs')]});
      allowQuit=true;app.quit();
    }catch(e){show();await dialog.showMessageBox(win,{type:'error',message:e.message});}finally{closing=false;if(!allowQuit){restartUpdate=false;if(surfaces)surfaces.updating=false;micWatch?.start();}}
  }
  app.on('before-quit',e=>{if(!allowQuit){e.preventDefault();requestClose();}});
  app.whenReady().then(async()=>{
    recorder=new Recorder({dataDir:process.env.CAPTURE_TEST_DATA_DIR,outputDir:process.env.CAPTURE_TEST_OUTPUT_DIR,beforePick:()=>win.hide(),afterPick:show});
    // Studio settings services: live microphone cleanup and saved camera controls.
    recorder.audioChain=new AudioChain(recorder.dataDir);recorder.cameraSettings=new CameraSettings(path.join(app.getPath('appData'),'vidcapture'));
    recorder.cameraEffects=new CameraEffects({backgrounds:path.join(app.getPath('appData'),'vidcapture','backgrounds')});
    // Optional tuning per camera model, from the app folder and the user's config folder.
    recorder.cameraProfiles=new CameraProfiles([path.join(__dirname,'camera-profiles'),path.join(app.getPath('appData'),'vidcapture','camera-profiles')]);
    await recorder.cameraProfiles.load();
    await recorder.init();
    syncCleanup({chain:recorder.audioChain,recorder,isBusy:()=>ACTIVE.has(recorder.state.phase)}).catch(()=>{});
    media=new MediaTools(recorder);transcripts=new Transcripts(recorder,media);media.onEnhanced=output=>transcripts.carry(output);publisher=new Publisher(recorder,media,{openExternal:url=>shell.openExternal(url),transcript:file=>transcripts.get(file)});await publisher.init();
    // New recordings are titled in the background and renamed once nothing has
    // them open. The editor's file counts as open until another file replaces it.
    // Any version of a recording open in the editor holds the whole set's rename.
    titles=new Titles(recorder,media,{isOpen:file=>!!editorFile&&path.dirname(path.resolve(editorFile))===path.dirname(path.resolve(file))&&versionBase(path.basename(editorFile))===versionBase(path.basename(file))});
    titles.reconcile().catch(()=>{});
    protocol.handle('capture-media',async request=>{
      try{
        const url=new URL(request.url);
        // Library posters come only from the thumbnail cache folder.
        if(url.hostname==='thumb')return library.serve(url);
        // Camera background images, only by name from VidCapture's backgrounds folder.
        if(url.hostname==='background'){
          const name=decodeURIComponent(url.pathname.slice(1));
          const file=recorder.cameraEffects.imagePath(name);
          const type={'.png':'image/png','.webp':'image/webp'}[path.extname(name).toLowerCase()]||'image/jpeg';
          return new Response(await fsp.readFile(file),{headers:{'content-type':type,'cache-control':'no-store'}});
        }
        if(url.hostname!=='recording')return new Response('',{status:404});
        const name=decodeURIComponent(url.pathname.slice(1));
        if(path.basename(name)!==name)return new Response('',{status:403});
        const file=await recorder.allowedFile(path.join(recorder.outputDir,name));const stat=await fsp.stat(file);
        let start=0,end=stat.size-1,status=200;
        const range=request.headers.get('range');
        if(range){const m=range.match(/^bytes=(\d+)-(\d*)$/);if(!m)return new Response('',{status:416});start=+m[1];if(m[2])end=Math.min(+m[2],end);status=206;}
        if(start>end||start>=stat.size)return new Response('',{status:416});
        const headers={'Content-Type':file.endsWith('.mp4')?'video/mp4':'video/x-matroska','Accept-Ranges':'bytes','Content-Length':String(end-start+1),'Cache-Control':'no-store'};
        if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
        return new Response(request.method==='HEAD'?null:Readable.toWeb(fs.createReadStream(file,{start,end})),{status,headers});
      }catch{return new Response('Recording unavailable',{status:404});}
    });
    const library=new Library(recorder,{origin:()=>publisher.origin});
    win=new BrowserWindow({width:820,height:650,minWidth:390,minHeight:560,title:'VidCapture',frame:false,backgroundColor:'#1a1917',show:false,icon:path.join(__dirname,'ui/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    surfaces=new Surfaces({recorder,onSettings:()=>syncMicChain(),showMain:show,hideMain:()=>{if(win&&!win.isDestroyed())win.hide();},mainVisible:()=>!!win&&!win.isDestroyed()&&win.isVisible(),sendMain:(channel,value)=>{if(win&&!win.isDestroyed())win.webContents.send(channel,value);}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(url!==win.webContents.getURL())event.preventDefault();});
    win.webContents.session.setPermissionRequestHandler((_wc,_p,callback)=>callback(false));
    win.on('focus',()=>{if(!ACTIVE.has(recorder.state.phase))recorder.refreshDevices().catch(e=>recorder.set({error:e.message}));});
    for(const name of ['hide','show','minimize','restore'])win.on(name,()=>surfaces.syncLevel());
    win.on('close',event=>{if(!allowQuit){event.preventDefault();requestClose();}});
    const actions={
      checkUpdates:()=>showUpdates(),
      getState:()=>recorder.snapshot(),listWindows:()=>recorder.listWindows(),refreshDevices:async()=>{await recorder.cameraProfiles.load();return recorder.refreshDevices();},saveSettings:async s=>{const out=await recorder.saveSettings(s);await syncMicChain();return out;},
      chooseTarget:id=>recorder.chooseTarget(id),
      // Studio settings: every camera control, the mic's own level, and live mic cleanup.
      studioInfo:()=>studioInfo(),
      setCameraControl:async(name,value)=>{const cam=recorder.state.settings.camera;if(cam==='none')throw new Error('Choose a camera first.');await recorder.cameraSettings.set(cam,String(name),value);return studioInfo();},
      resetCameraControls:async()=>{const cam=recorder.state.settings.camera;if(cam==='none')throw new Error('Choose a camera first.');await recorder.cameraSettings.reset(cam);return studioInfo();},
      // Background images for the camera bubble live in ~/.config/vidcapture/backgrounds.
      addBackground:async()=>{
        const {canceled,filePaths}=await dialog.showOpenDialog(win,{title:'Choose a background image',properties:['openFile'],filters:[{name:'Images',extensions:['jpg','jpeg','png','webp']}]});
        if(canceled||!filePaths?.[0])return studioInfo();
        const name=await recorder.cameraEffects.addImage(filePaths[0]);
        await recorder.saveSettings({cameraBackground:'image',cameraBackgroundImage:name});
        return studioInfo();
      },
      removeBackground:async name=>{
        if(recorder.state.settings.cameraBackgroundImage===name)await recorder.saveSettings({cameraBackgroundImage:'',...(recorder.state.settings.cameraBackground==='image'?{cameraBackground:'off'}:{})});
        await recorder.cameraEffects.removeImage(name);return studioInfo();
      },
      setMicLevel:async percent=>{const mic=recorder.state.settings.microphone;if(mic==='none')throw new Error('Choose a microphone first.');await recorder.audioChain.setLevel(mic,percent);return studioInfo();},start:async()=>{if(surfaces.busy())throw new Error('Wait for the current recording action to finish.');recorder.idleOnly();surfaces.startPending=true;win.hide();try{if(!(await surfaces.countdown())){show();return recorder.snapshot();}return await recorder.start();}catch(e){show();throw e;}finally{surfaces.startPending=false;}},pause:()=>recorder.pause(),stop:()=>recorder.stop(),restart:()=>surfaces.restartTake(),discard:()=>surfaces.discardTake(),previewCamera:()=>recorder.previewCamera(),
      getMedia:file=>{editorFile=file;titles.applyRenames().catch(()=>{});return media.getMedia(file);},getWaveform:file=>media.getWaveform(file),saveEdits:(file,keep)=>media.saveEdits(file,keep),exportEdit:(file,keep)=>media.exportEdit(file,keep),enhanceAudio:file=>media.enhanceAudio(file),enhanceAudioFast:file=>media.enhanceAudioFast(file),enhanceAudioQuick:(file,options)=>media.enhanceAudioQuick(file,options),cancelJob:()=>{publisher.cancel();return media.cancelJob();},
      publishVideo:(file,title,keep)=>publisher.publish(file,title,keep),
      getTranscript:file=>transcripts.get(file),makeTranscript:file=>transcripts.create(file),cancelTranscript:()=>transcripts.cancel(),
      openLibrary:async()=>shell.openExternal(await publisher.libraryURL()),
      copyShareCard:async()=>{const card=await publisher.card();clipboard.write(card);if(!clipboard.availableFormats().includes('text/html'))throw new Error('The video card could not be copied. Try again.');return true;},
      // One Copy link: rich editors (email) paste the GIF card, plain fields (Slack, LinkedIn) paste the URL.
      copyShareLink:()=>copyShareLink(),
      openShareLink:async()=>{const url=recorder.state.share?.url;if(!url?.startsWith(publisher.origin+'/v/'))throw new Error('No share link is ready.');await shell.openExternal(url);},
      openFile:async file=>{const p=await recorder.allowedFile(file);const error=await shell.openPath(p);if(error)throw new Error(error);},
      chooseOutputDir:async()=>{
        const {canceled,filePaths}=await dialog.showOpenDialog(win,{title:'Choose where recordings are saved',defaultPath:recorder.outputDir,properties:['openDirectory','createDirectory']});
        if(canceled||!filePaths?.[0])return recorder.snapshot();
        return recorder.setOutputDir(filePaths[0]);
      },
      openFolder:async()=>{const error=await shell.openPath(recorder.outputDir);if(error)throw new Error(error);},
      openBar:()=>surfaces.openBar({origin:'main'}),sources:()=>surfaces.mainSources(),chooseSource:sel=>surfaces.mainChoose(sel),watchLevel:on=>surfaces.watchMainLevel(on),pickOnScreen:mode=>surfaces.openPicker(mode,{intent:'select',origin:'main'}),
      minimize:()=>win.minimize(),close:()=>requestClose()
    };
    const autoCopy=createAutoCopy({getState:()=>recorder.state,set:patch=>recorder.set(patch),card:()=>publisher.card(),write:data=>clipboard.write(data),readText:()=>clipboard.readText()});
    async function copyShareLink(){const url=recorder.state.share?.url;if(!url?.startsWith(publisher.origin+'/v/'))throw new Error('No share link is ready.');let card=null;try{card=await publisher.card();}catch{}if(card?.text===url)clipboard.write(card);else clipboard.writeText(url);return true;}
    async function studioInfo(){
      const s=recorder.state.settings;
      const [camera,mic,audio,effectsReady,backgrounds]=await Promise.all([
        s.camera==='none'?null:recorder.cameraSettings.list(s.camera).catch(e=>({error:e.message})),
        s.microphone==='none'?null:recorder.audioChain.level(s.microphone).catch(e=>({error:e.message})),
        recorder.audioChain.available(),
        recorder.cameraEffects.available(),
        recorder.cameraEffects.images()
      ]);
      return {camera,mic,audio,effects:{available:effectsReady,backgrounds},cleanup:{running:recorder.audioChain.running(),error:recorder.state.micCleanupError||null}};
    }
    // Keeps live cleanup in step with the settings while idle, so the level meter
    // shows what will actually be recorded. A take checks again when it starts.
    // A cleanup failure lives in recorder state, so the panel and the main window both show it.
    async function syncMicChain(){
      // Nothing starts a chain while quitting (Try again or a settings save arriving late).
      if(closing||ACTIVE.has(recorder.state.phase))return;
      await syncCleanup({chain:recorder.audioChain,recorder,isBusy:()=>ACTIVE.has(recorder.state.phase)});
      surfaces?.syncLevel();
    }
    // Between takes, notice a chain whose graph has gone (for example when the microphone
    // fails) and recover once; a lasting failure stays visible with Try again.
    micWatch=new ChainWatch({chain:recorder.audioChain,isBusy:()=>ACTIVE.has(recorder.state.phase),recover:async()=>{surfaces?.syncLevel();await syncMicChain();}});
    micWatch.start();
    for(const [name,handler] of Object.entries(actions))ipcMain.handle(`capture:${name}`,async(event,...args)=>{
      if(event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame)throw new Error('Untrusted app frame.');
      if((surfaces.updating||closing)&&!['getState','minimize','close','checkUpdates','saveEdits'].includes(name))throw new Error('Wait for the app update to finish.');
      return handler(...args);
    });

    // Recordings library. Same main-window-only gate as the actions above.
    const shareURL=url=>{if(typeof url!=='string'||!new RegExp('^'+publisher.origin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/v/[a-f0-9]{48}$').test(url))throw new Error('That is not a VidCapture share link.');return url;};
    const libraryActions={syncShares:()=>publisher.syncShares().catch(()=>({synced:false,changed:0})),copyLink:async url=>{clipboard.writeText(shareURL(url));return true;},openLink:async url=>{await shell.openExternal(shareURL(url));},listRecordings:()=>library.list(),recordingDetails:name=>library.details(name),setCurrentVersion:(root,name)=>library.setCurrentVersion(root,name),
      // A new title shows at once; a recording still named Capture-<time> takes it as its file name when nothing has it open.
      renameRecording:async(root,title)=>{const items=await library.rename(root,title);if(/^Capture-/.test(String(root))){titles.pending.add(path.join(recorder.outputDir,root));titles.applyRenames().catch(()=>{});}return items;},
      removeRecording:async root=>{const items=await library.remove(root,file=>shell.trashItem(file));if(editorFile&&!(await fsp.access(editorFile).then(()=>true,()=>false)))editorFile=null;return items;},
      showRecording:async name=>{if(typeof name!=='string'||path.basename(name)!==name)throw new Error('Choose a file from your recordings folder.');shell.showItemInFolder(await recorder.allowedFile(path.join(recorder.outputDir,name)));}};
    for(const [name,handler] of Object.entries(libraryActions))ipcMain.handle(`capture:${name}`,async(event,...args)=>{
      if(event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame)throw new Error('Untrusted app frame.');
      if((surfaces.updating||closing)&&!['getState','minimize','close','checkUpdates','saveEdits'].includes(name))throw new Error('Wait for the app update to finish.');
      return handler(...args);
    });
    // Small state file for the top bar icon: phase changes only, plus the
    // elapsed time at that moment so the icon can count on its own.
    const liveFile=path.join(recorder.dataDir,'live.json');let livePhase=null,liveChain=Promise.resolve();
    const fsp=require('node:fs/promises'),fss=require('node:fs');
    const writeLive=state=>{
      const phase=['recording','paused','stopping','starting'].includes(state.phase)?state.phase:'idle';
      if(phase===livePhase)return;livePhase=phase;
      const body=JSON.stringify({phase,elapsed:state.elapsed||0,at:Date.now(),pid:process.pid});
      // One write at a time, so a quick pause and resume cannot interleave on the tmp file.
      liveChain=liveChain.then(async()=>{const tmp=`${liveFile}.${process.pid}.tmp`;await fsp.writeFile(tmp,body,{mode:0o600});await fsp.rename(tmp,liveFile);}).catch(()=>{});
    };
    // A quit or crash must not leave the bar counting a recording that ended.
    process.on('exit',()=>{try{fss.writeFileSync(liveFile,JSON.stringify({phase:'idle',elapsed:0,at:Date.now(),pid:process.pid}),{mode:0o600});}catch{}});
    function update(state){
      writeLive(state);
      if(!win.isDestroyed())win.webContents.send('capture:state',state);
      surfaces?.update(state);
      const active=['starting','recording','paused','stopping'].includes(state.phase);
      if(active&&inhibit===null)inhibit=powerSaveBlocker.start('prevent-display-sleep');
      if(!active&&inhibit!==null){powerSaveBlocker.stop(inhibit);inhibit=null;}
      if(tray){
        tray.setToolTip(active?`VidCapture: ${state.phase} (${Math.floor(state.elapsed/60)}:${String(Math.floor(state.elapsed%60)).padStart(2,'0')})`:'VidCapture');
        tray.setContextMenu(Menu.buildFromTemplate([
          {label:'Open VidCapture',click:show},
          {label:'New recording',enabled:!active&&!state.job?.running,click:()=>openPanel()},
          {label:state.phase==='paused'?'Resume recording':'Pause recording',enabled:['recording','paused'].includes(state.phase),click:()=>recorder.pause().catch(e=>recorder.set({error:e.message}))},
          {label:'Stop and save',enabled:['recording','paused'].includes(state.phase),click:()=>{recorder.stop().catch(e=>recorder.set({error:e.message})).finally(show);}},
          {type:'separator'},{label:updates?.state.available?'Update available':'Check for updates',click:()=>showUpdates()},
          {label:'Quit VidCapture',click:requestClose}
        ]));
      }
    }
    async function showUpdates(){
      if(updateDialog||closing)return;
      updateDialog=true;
      show();
      try{
        if(updates.installing){await dialog.showMessageBox(win,{message:'Preparing your update',detail:'VidCapture is downloading and building the new version. This can take several minutes.'});return;}
        if(!updates.ready)await updates.check({force:true});
        const u=updates.state;
        if(updates.checking||u.status==='checking'){await dialog.showMessageBox(win,{message:'Checking for updates',detail:'A check is still running. Open Updates again in a moment.'});return;}
        if(u.status==='error')throw new Error(u.error);
        if(!u.available){await dialog.showMessageBox(win,{message:'VidCapture is up to date',detail:`Installed version: ${u.current}`});return;}
        if(surfaces.busy()||surfaces.picker||surfaces.counting||transcripts.job){await dialog.showMessageBox(win,{message:`VidCapture ${u.available} is available`,detail:'Finish recording and processing, then open Updates to install it.'});return;}
        if(!updates.ready){
          const {response}=await dialog.showMessageBox(win,{type:'question',message:`Update to VidCapture ${u.available}?`,detail:'The update will download and build on this computer. Recording controls will be unavailable while it prepares. Your recordings and settings stay in place.',buttons:['Later','Install update'],defaultId:0,cancelId:0});
          if(response!==1)return;
          // A recording or extension command can begin while the dialog is open.
          if(surfaces.busy()||surfaces.picker||surfaces.counting||transcripts.job)throw new Error('Finish recording and processing before installing.');
          surfaces.updating=true;
          try{await updates.prepare();}finally{surfaces.updating=false;}
        }
        const {response}=await dialog.showMessageBox(win,{message:'Your update is ready',detail:'Restart VidCapture to use the new version. The previous app copy is kept for recovery.',buttons:['Later','Restart now'],defaultId:1,cancelId:0});
        if(response===1){restartUpdate=true;await requestClose();}
      }catch(e){await dialog.showMessageBox(win,{type:'error',message:'VidCapture update',detail:e.message});}
      finally{updateDialog=false;}
    }
    updates=new Updates({changed:state=>recorder.set({appUpdate:state})});
    recorder.set({appUpdate:{...updates.state}});
    if(!process.env.CAPTURE_TEST_DATA_DIR){
      const first=setTimeout(()=>updates.check(),15000);first.unref();
      const timer=setInterval(()=>updates.check(),6*60*60*1000);timer.unref();
    }
    const icon=nativeImage.createFromPath(path.join(__dirname,'ui/icon.png'));
    tray=new Tray(icon.resize({width:24,height:24}));tray.on('click',()=>openPanel());
    recorder.on('state',update);
    let lastTitled=null,wasBusy=false;
    recorder.on('state',state=>{
      if(state.renamed?.to===state.lastFile)lastTitled=state.lastFile;
      if(state.phase==='saved'&&state.lastFile&&state.lastFile!==lastTitled){lastTitled=state.lastFile;titles.add(state.lastFile);}
      if(state.renamed&&editorFile===state.renamed.from)editorFile=state.renamed.to;
      // A finished share puts its link on the clipboard, ready to paste.
      autoCopy(state);
      const busy=['starting','recording','paused','stopping'].includes(state.phase)||!!state.job?.running;
      if(wasBusy&&!busy)titles.applyRenames().catch(()=>{});
      wasBusy=busy;
    });
    await win.loadFile(path.join(__dirname,'ui/index.html'));
    update(recorder.snapshot());
    try{extensionBridge=await startExtensionBridge({recorder,actions,surfaces,show});}
    catch(e){console.error('Browser controls could not start:',e.message);}
    // Shortcut keys shown in tooltips: whatever Hyprland binds to the toggles.
    // CAPTURE_TEST_BINDS (a JSON list like `hyprctl binds -j`) stands in for the live binds in isolated checks.
    (process.env.CAPTURE_TEST_BINDS?Promise.resolve({stdout:process.env.CAPTURE_TEST_BINDS}):run('hyprctl',['binds','-j'],{timeout:3000})).then(({stdout})=>recorder.set({shortcuts:shortcutsFrom(JSON.parse(stdout))})).catch(()=>{});
    const startKey=hotkey(process.argv),startArgs=panelArgs(process.argv);
    if(startKey)runHotkey(startKey);else if(startArgs)openPanel(startArgs);else if(!process.argv.includes('--extension-service'))show();
  }).catch(e=>{console.error(e);dialog.showErrorBox('Capture could not open',e.message);allowQuit=true;app.quit();});
}
