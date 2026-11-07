const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseRegion,buildArgs,cameraGeometry,validateSettings,DEFAULTS,Recorder}=require('../recorder.cjs');
test('region coordinates preserve negative monitor positions and reject garbage',()=>{
  assert.deepEqual(parseRegion('-1280,30 800x600'),{kind:'region',x:-1280,y:30,width:800,height:600,label:'Selected area (800 × 600)'});
  for(const input of ['','foo','0,0 2x2','0,0 100x100;touch /tmp/oops'])assert.throws(()=>parseRegion(input));
});
test('recorder uses selected physical mic and merges desktop audio into one track',()=>{
  const a=buildArgs(parseRegion('0,0 800x600'),{...DEFAULTS,microphone:'alsa_input.test',systemAudio:true},'/tmp/sample.mkv');
  assert.equal(a[a.indexOf('-a')+1],'default_output|device:alsa_input.test');
  assert.equal(a[a.indexOf('-k')+1],'h264');assert.equal(a[a.indexOf('-w')+1],'800x600+0+0');
  assert.ok(!buildArgs(parseRegion('0,0 800x600'),{...DEFAULTS,microphone:'none'},'/tmp/sample.mkv').includes('-a'));
});
test('camera stays within selected region on offset monitors',()=>{
  const target=parseRegion('-1280,30 400x300');
  for(const corner of ['bottom-left','bottom-right'])for(const size of ['small','medium','large']){
    const g=cameraGeometry(target,size,corner);assert.ok(g.x>=target.x&&g.y>=target.y);assert.ok(g.x+g.size<=target.x+target.width&&g.y+g.size<=target.y+target.height);
  }
});
test('settings reject unknown devices, extra keys, wrong types, and invalid values',()=>{
  const devices={microphones:[],cameras:[]};
  for(const s of [{camera:'/etc/passwd'},{fps:'60'},{systemAudio:'true'},{outputDir:'/tmp'},{microphone:'other'}])assert.throws(()=>validateSettings(s,DEFAULTS,devices));
  assert.equal(validateSettings({fps:60},DEFAULTS,devices).fps,60);
});
test('paused timer excludes pauses and supports multi-hour recordings',async()=>{
  const r=new Recorder();r.started=Date.now()-7200000;r.pauseTotal=600000;r.pausedAt=Date.now()-300000;r.state.phase='paused';
  assert.ok(Math.abs(r.snapshot().elapsed-6300)<1);await r.dispose();
});
test('camera device changes refresh the list once and stop refreshing after disposal',async()=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-hotplug-'));
  const r=new Recorder({dataDir:path.join(root,'state'),outputDir:path.join(root,'videos')});
  let scans=0;
  r.enumerateDevices=async()=>{scans++;r.state.devices.cameras=scans>1?[{id:'/dev/video2',name:'Razer Kiyo Pro Ultra'}]:[];return r.publish();};
  try{
    await r.init();assert.equal(scans,1);
    r.deviceWatcher.emit('change','rename','video2');
    r.deviceWatcher.emit('change','rename','video3');
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.equal(scans,2);assert.equal(r.state.devices.cameras[0].name,'Razer Kiyo Pro Ultra');
    r.deviceWatcher.emit('change','rename','video2');
    await r.dispose();await new Promise(resolve=>setTimeout(resolve,450));
    assert.equal(scans,2);
  }finally{await r.dispose();await fs.rm(root,{recursive:true,force:true});}
});
test('on-screen area selections become region targets only inside one display',async()=>{
  const r=new Recorder();
  r.enumerateDevices=async()=>{r.state.devices.monitors=[{id:'eDP-1',x:0,y:0,width:1280,height:720,scale:1.5},{id:'DP-7',x:1280,y:0,width:3440,height:1440,scale:1}];return r.publish();};
  try{
    await r.chooseTarget('region:100,54 202x102');
    assert.deepEqual({...r.state.target,label:undefined},{kind:'region',x:100,y:54,width:202,height:102,label:undefined});
    await assert.rejects(r.chooseTarget('region:1200,10 200x200'),/within one display/);
    await assert.rejects(r.chooseTarget('region:0,0 10x10'));
    await assert.rejects(r.chooseTarget('region:0,0 100x100;rm -rf /'));
  }finally{await r.dispose();}
});
