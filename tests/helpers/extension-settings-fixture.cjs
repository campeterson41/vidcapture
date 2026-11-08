// Real Recorder persistence, CameraSettings validation, effect-control socket,
// and extension bridge. Physical device/chooser operations are injected fixtures.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {Recorder}=require('../../recorder.cjs');
const {CameraSettings}=require('../../camera-settings.cjs');
const {CameraEffects}=require('../../camera-effects.cjs');
const {syncCleanup}=require('../../audio-chain.cjs');
const {startExtensionBridge}=require('../../extension-bridge.cjs');
async function createFixture(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vc-settings-'));
 const r=new Recorder({dataDir:path.join(dir,'state'),outputDir:path.join(dir,'videos')});
 const devices={cameras:[{id:'/dev/video99',name:'Test camera',profile:{name:'Test profile',lensCorrection:true,note:'Calibrated at default zoom.'}}],microphones:[{id:'test-mic',name:'Test microphone'}],monitors:[{id:'eDP-test',name:'Test screen',x:0,y:0,width:1280,height:720}]};
 r.refreshDevices=async()=>{r.state.devices=structuredClone(devices);return r.publish();};await r.init();r.fixedOutput=false;
 const controlValues={auto_exposure:3,brightness:128,white_balance_automatic:1,white_balance_temperature:4500,custom_led:2};
 const hardware=()=>`auto_exposure 0x009a0901 (menu) : min=1 max=3 default=3 value=${controlValues.auto_exposure}\n  1: Manual Mode\n  3: Aperture Priority Mode\nbrightness 0x00980900 (int) : min=0 max=255 step=1 default=128 value=${controlValues.brightness}\nwhite_balance_automatic 0x0098090c (bool) : default=1 value=${controlValues.white_balance_automatic}\nwhite_balance_temperature 0x0098091a (int) : min=2000 max=6500 step=100 default=4500 value=${controlValues.white_balance_temperature}${controlValues.white_balance_automatic?' flags=inactive':''}\ncustom_led 0x0098ffff (int) : min=0 max=4 step=1 default=2 value=${controlValues.custom_led}\n`;
 r.cameraSettings=new CameraSettings(path.join(dir,'camera'),{exec:async(_cmd,args)=>{
  if(args.includes('--info'))return {stdout:'Card type : Test camera\n'};
  if(args.includes('--list-ctrls-menus'))return {stdout:hardware()};
  const setting=args.at(-1).split('=');controlValues[setting[0]]=Number(setting[1]);return {stdout:''};
 }});
 const flags={effects:true,noise:true,cleanupError:null,previewError:null};let micPercent=85,cleanupCalls=0;
 r.audioChain={ensure:async()=>{cleanupCalls++;if(flags.cleanupError)throw new Error(flags.cleanupError);},available:async()=>({noise:flags.noise}),running:()=>!flags.cleanupError,level:async()=>({source:'private-source',percent:micPercent}),setLevel:async(_device,p)=>{micPercent=p;}};
 r.cameraEffects=new CameraEffects({backgrounds:path.join(dir,'backgrounds')});r.cameraEffects.available=async()=>flags.effects;
 const changes=[],fxSocket=path.join(dir,'fx.sock');
 const fx=net.createServer(c=>{let b='';c.on('data',x=>{b+=x;if(b.includes('\n')){changes.push(JSON.parse(b.split('\n')[0]));c.end('{"ok":true}\n');}});});await new Promise(resolve=>fx.listen(fxSocket,resolve));
 r.closeCamera=async()=>{r.camera=null;r.set({cameraPreview:false});};
 r.openCamera=async()=>{if(flags.previewError)throw new Error(flags.previewError);r.camera={pid:123,exitCode:null,...(r.state.settings.cameraBackground!=='off'?{effects:{controlSocket:fxSocket}}:{})};r.set({cameraPreview:true});};r.positionCamera=async()=>{};
 r.updateWindow=async()=>{};r.unmarkWindow=async()=>{};
 r.listWindows=async()=>[{id:'0x123',title:'Generated test window'}];
 const nativeChooserImage=path.join(dir,'Chosen background.png');await fs.writeFile(nativeChooserImage,'test-only-image');
 let shown=0;
 const actions={
  saveSettings:async s=>{const out=await r.saveSettings(s);await syncCleanup({chain:r.audioChain,recorder:r,isBusy:()=>['starting','recording','paused','stopping'].includes(r.state.phase)});return out;},
  refreshDevices:()=>r.refreshDevices(),
  studioInfo:async()=>({camera:r.state.settings.camera==='none'?null:await r.cameraSettings.list(r.state.settings.camera),mic:r.state.settings.microphone==='none'?null:await r.audioChain.level(),audio:await r.audioChain.available(),effects:{available:await r.cameraEffects.available(),backgrounds:await r.cameraEffects.images()},cleanup:{running:r.audioChain.running(),error:r.state.micCleanupError}}),
  setCameraControl:(name,value)=>r.cameraSettings.set(r.state.settings.camera,name,value),resetCameraControls:()=>r.cameraSettings.reset(r.state.settings.camera),
  setMicLevel:async value=>r.audioChain.setLevel(r.state.settings.microphone,value),
  addBackground:async()=>{const name=await r.cameraEffects.addImage(nativeChooserImage);await r.saveSettings({cameraBackground:'image',cameraBackgroundImage:name});},
  removeBackground:async name=>{if(r.state.settings.cameraBackgroundImage===name)await r.saveSettings({cameraBackground:'off',cameraBackgroundImage:''});await r.cameraEffects.removeImage(name);},
  chooseOutputDir:()=>r.setOutputDir(path.join(dir,'Chosen recordings')),openFolder:async()=>{},openLibrary:async()=>{},
  start:async()=>{r.state.phase='recording';},restart:async()=>{r.state.phase='recording';},discard:async()=>{r.state.phase='idle';}
 };
 const choose=r.chooseTarget.bind(r);r.chooseTarget=async id=>{if(id.startsWith('window:'))return r.set({phase:'idle',target:{kind:'window',address:id.slice(7),label:'Generated test window',available:true,width:900,height:600}});return choose(id);};
 r.pause=async()=>r.set({phase:r.state.phase==='paused'?'recording':'paused'});r.stop=async()=>{await r.closeCamera();return r.set({phase:'saved',lastFile:path.join(r.outputDir,'Test recording.mp4')});};
 await actions.saveSettings({camera:'/dev/video99',microphone:'test-mic'});
 const surfaces={startPending:false,openPicker:async()=>{},closePanel(){},busy(){return !!(this.startPending||this.extensionMutation);}};
 const bridge=await startExtensionBridge({recorder:r,actions,surfaces,show(){shown++;}});
 let next=0;return {r,dir,devices,flags,bridge,actions,surfaces,changes,controlValues,cleanupCalls:()=>cleanupCalls,shown:()=>shown,
  request:(action,args={})=>bridge.execute({id:'fixture-'+String(++next).padStart(6,'0'),action,...args}),
  async close(){await bridge.close();await r.dispose();await new Promise(resolve=>fx.close(resolve));await fs.rm(dir,{recursive:true,force:true});}};
}
module.exports={createFixture};
