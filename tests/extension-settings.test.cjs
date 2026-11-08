const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {createFixture}=require('./helpers/extension-settings-fixture.cjs');
const {CONFIGURABLE}=require('../extension-bridge.cjs');const {DEFAULTS}=require('../recorder.cjs');
async function fixture(t){const f=await createFixture();t.after(()=>f.close());return f;}
test('extension configure covers every desktop recorder setting and persists validated values',async t=>{
 assert.deepEqual([...CONFIGURABLE].sort(),Object.keys(DEFAULTS).sort());const f=await fixture(t);
 const settings={camera:'/dev/video99',microphone:'test-mic',cameraSize:'large',cameraCorner:'bottom-left',cameraCorrection:'off',cameraLighting:'balanced',cameraBackground:'blur',cameraBlur:'strong',micNoise:'on',micGate:'strong',micRumble:true,micBackup:false,systemAudio:true,fps:60,quality:'ultra',resolution:'0x0',countdown:0};
 await f.request('configure',{settings});const disk=JSON.parse(await fs.readFile(path.join(f.r.dataDir,'settings.json')));
 for(const [k,v] of Object.entries(settings))assert.equal(disk[k],v,k);assert.ok(f.cleanupCalls()>1,'main-style save synchronizes microphone cleanup');
});
test('background modes, strength, image library membership and native chooser dispatch',async t=>{
 const f=await fixture(t);await f.request('preview',{enabled:true});await f.request('configure',{settings:{cameraBackground:'blur'}});
 await f.request('configure',{settings:{cameraBlur:'strong'}});assert.equal(f.changes.at(-1).blur,.9,'actual effect socket receives blur strength');
 await f.request('addBackground');const name=f.r.state.settings.cameraBackgroundImage;assert.ok(name.endsWith('.png'));assert.ok((await f.request('studio')).effects.backgrounds.includes(name));
 await f.request('configure',{settings:{cameraBackground:'off'}});await f.request('configure',{settings:{cameraBackground:'image',cameraBackgroundImage:name}});
 await assert.rejects(f.request('configure',{settings:{cameraBackgroundImage:'missing.png'}}),/existing/);
 await assert.rejects(f.request('configure',{settings:{cameraBackgroundImage:'../../private.png'}}),/existing/);
 await assert.rejects(f.request('removeBackground',{name}),/Confirm/);await f.request('removeBackground',{name,confirmed:true});assert.equal(f.r.state.settings.cameraBackground,'off');assert.deepEqual((await f.request('studio')).effects.backgrounds,[]);
});
test('hardware controls use actual device ranges, persist, refresh dependent fields and require reset confirmation',async t=>{
 const f=await fixture(t);await f.request('setCameraControl',{name:'brightness',value:200});assert.equal(f.controlValues.brightness,200);const saved=JSON.parse(await fs.readFile(f.r.cameraSettings.file));assert.equal(Object.values(saved)[0].controls.brightness,200);
 await assert.rejects(f.request('setCameraControl',{name:'brightness',value:999}),/out of range/);await assert.rejects(f.request('setCameraControl',{name:'no_such_control',value:1}),/does not have/);
 await f.request('setCameraControl',{name:'white_balance_automatic',value:0});assert.equal((await f.request('studio')).camera.controls.find(c=>c.name==='white_balance_temperature').inactive,false);
 await assert.rejects(f.request('resetCameraControls'),/Confirm/);await f.request('resetCameraControls',{confirmed:true});assert.equal(f.controlValues.brightness,128);
 const info=await f.request('studio');assert.equal(info.camera.key,undefined);assert.equal(info.mic.source,undefined);assert.ok(info.camera.controls.some(c=>c.name==='custom_led'));
});
test('trusted mutations reject all busy phases and processing, not just disabled popup controls',async t=>{
 const f=await fixture(t);for(const phase of ['selecting','starting','recording','paused','stopping']){f.r.state.phase=phase;for(const action of ['configure','setMicLevel','setCameraControl','addBackground','resetCameraControls','chooseOutputDir','refreshDevices','retryCleanup'])await assert.rejects(f.request(action,({configure:{settings:{fps:60}},setMicLevel:{percent:90},setCameraControl:{name:'brightness',value:100},resetCameraControls:{confirmed:true}})[action]||{}),/Stop and save/);}
 f.r.state.phase='idle';f.r.state.job={running:true};await assert.rejects(f.request('setMicLevel',{percent:90}),/processing/);
});
test('mic level validates bounds, cleanup error stays fresh, retry uses the existing synchronization',async t=>{
 const f=await fixture(t);await f.request('setMicLevel',{percent:120});assert.equal((await f.request('studio')).mic.percent,120);await assert.rejects(f.request('setMicLevel',{percent:151}),/between/);
 f.flags.cleanupError='Test microphone disconnected';await f.request('configure',{settings:{micNoise:'on'}});assert.equal((await f.request('status')).micCleanupError,'Test microphone disconnected');f.flags.cleanupError=null;await f.request('retryCleanup');assert.equal((await f.request('status')).micCleanupError,null);
});
test('new RPC arguments participate in replay signatures and unknown keys never reach services',async t=>{
 const f=await fixture(t),m={id:'replay-mic-001',action:'setMicLevel',percent:70};await f.bridge.execute(m);await assert.rejects(f.bridge.execute({...m,percent:90}),/reused/);
 await assert.rejects(f.request('configure',{settings:{outputDir:'/etc'}}),/Invalid/);await assert.rejects(f.request('configure',{settings:'camera'}),/Invalid/);await assert.rejects(f.request('setCameraControl',{name:'x;touch /tmp/test',value:1}),/Invalid/);
 await assert.rejects(f.request('chooseOutputDir',{path:'/etc'}),/Unexpected/);await assert.rejects(f.request('addBackground',{path:'/private'}),/Unexpected/);await f.request('chooseOutputDir');assert.equal((await f.request('status')).outputFolder,'Chosen recordings');assert.equal(JSON.parse(await fs.readFile(path.join(f.r.dataDir,'location.json'))).outputDir,f.r.outputDir);
});
test('a save that persists then fails preview is visible in refreshed state and disk',async t=>{
 const f=await fixture(t);await f.request('preview',{enabled:true});f.flags.previewError='Test effects could not start';await assert.rejects(f.request('configure',{settings:{cameraBackground:'blur'}}),/effects could not start/);
 assert.equal((await f.request('status')).settings.cameraBackground,'blur');assert.equal(JSON.parse(await fs.readFile(path.join(f.r.dataDir,'settings.json'))).cameraBackground,'blur');
});


test('external desktop countdown locks native mutations while status stays truthful and readable',async t=>{
 const f=await fixture(t);f.surfaces.startPending=true;assert.equal(f.r.state.phase,'idle');
 const status=await f.request('status');assert.equal(status.pending,'start');assert.equal(status.settingsLocked,true);
 await assert.rejects(f.request('setCameraControl',{name:'brightness',value:201}),/desktop recording action/);await assert.rejects(f.request('configure',{settings:{fps:60}}),/desktop recording action/);await assert.rejects(f.request('preview',{enabled:true}),/desktop recording action/);
 assert.equal(f.controlValues.brightness,128);assert.equal(f.r.state.settings.fps,30);assert.ok((await f.request('studio')).camera.controls.length);
 f.surfaces.startPending=false;await f.request('configure',{settings:{fps:60}});assert.equal(f.r.state.settings.fps,60);
});

test('an extension settings operation holds the desktop start guard through asynchronous work',async t=>{
 const f=await fixture(t);const original=f.actions.setCameraControl;let release;f.actions.setCameraControl=async(...args)=>{await new Promise(resolve=>{release=resolve;});return original(...args);};
 const pending=f.request('setCameraControl',{name:'brightness',value:190});assert.equal(f.surfaces.busy(),true);assert.equal((await f.request('status')).settingsLocked,true);release();await pending;assert.equal(f.surfaces.busy(),false);
});


test('successful settings replies report completion without waiting for the next status poll',async t=>{
 const f=await fixture(t);const result=await f.request('configure',{settings:{fps:60}});assert.equal(result.settings.fps,60);assert.equal(result.pending,null);assert.equal(result.settingsLocked,false);assert.equal(f.surfaces.extensionMutation,false);
});
