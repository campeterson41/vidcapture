// Camera-only takes and discarding a take.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {buildArgs,takeFile,DEFAULTS,Recorder}=require('../recorder.cjs');
const {cameraRecordMode}=require('../camera.cjs');

const FORMATS=`ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[0]: 'MJPG' (Motion-JPEG, compressed)
		Size: Discrete 3840x2160
			Interval: Discrete 0.033s (30.000 fps)
		Size: Discrete 1920x1080
			Interval: Discrete 0.033s (30.000 fps)
		Size: Discrete 1280x720
			Interval: Discrete 0.017s (60.000 fps)
			Interval: Discrete 0.033s (30.000 fps)
	[1]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 1920x1080
			Interval: Discrete 0.200s (5.000 fps)
		Size: Discrete 640x480
			Interval: Discrete 0.033s (30.000 fps)
`;

test('camera-only mode takes the full frame, capped by the resolution setting',()=>{
  assert.deepEqual(cameraRecordMode(FORMATS,'1920x1080'),{width:1920,height:1080,fps:30,pixfmt:'mjpeg'});
  assert.deepEqual(cameraRecordMode(FORMATS,'0x0'),{width:3840,height:2160,fps:30,pixfmt:'mjpeg'});
  const raw=FORMATS.split('[1]')[0].replace(/MJPG/,'NONE')+'[1]'+FORMATS.split('[1]')[1];
  assert.deepEqual(cameraRecordMode(raw,'1920x1080'),{width:640,height:480,fps:30,pixfmt:'yuyv'});
  assert.equal(cameraRecordMode('','1920x1080').width,0);
});

test('camera-only arguments record the camera device with its mode and the usual audio',()=>{
  const target={kind:'camera',device:'/dev/video0',mode:{width:1920,height:1080,fps:30,pixfmt:'mjpeg'}};
  const a=buildArgs(target,{...DEFAULTS,microphone:'alsa_input.test',systemAudio:true,fps:60},'/tmp/take.mkv');
  assert.equal(a[a.indexOf('-w')+1],'/dev/video0;camera_width=1920;camera_height=1080;camera_fps=30;pixfmt=mjpeg');
  assert.equal(a[a.indexOf('-s')+1],'1920x1080');assert.equal(a[a.indexOf('-f')+1],'30');
  assert.equal(a[a.indexOf('-a')+1],'default_output|device:alsa_input.test');
  assert.equal(a[a.indexOf('-o')+1],'/tmp/take.mkv');
  assert.throws(()=>buildArgs({kind:'camera',device:'/etc/passwd;x'},DEFAULTS,'/tmp/x.mkv'));
});

test('only a take file in the recordings folder counts as a take',()=>{
  assert.ok(takeFile('/v/Capture-2026-11-07T10-00-00-000Z.mkv','/v'));
  for(const f of ['/v/Meeting notes.mp4','/v/Capture-2026-11-07T10-00-00-000Z.mp4','/other/Capture-2026-11-07T10-00-00-000Z.mkv','/v/../x/Capture-1.mkv',null])assert.ok(!takeFile(f,'/v'),String(f));
});

async function liveRecorder(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-discard-'));
  const videos=path.join(root,'videos');
  const r=new Recorder({dataDir:path.join(root,'state'),outputDir:videos});
  await fs.mkdir(r.dataDir,{recursive:true});await fs.mkdir(videos,{recursive:true});
  // Other recordings, including a finished one and its sidecar.
  await fs.writeFile(path.join(videos,'Earlier take.mp4'),'keep');
  await fs.writeFile(path.join(videos,'Capture-2026-11-01T09-00-00-000Z.mkv'),'keep');
  await fs.writeFile(path.join(r.dataDir,'Earlier take.mp4.json'),'{}');
  r.rawFile=path.join(videos,'Capture-2026-11-07T10-00-00-000Z.mkv');
  await fs.writeFile(r.rawFile,'partial take');
  await fs.writeFile(path.join(r.dataDir,'active.json'),'{}');
  const child=new EventEmitter();child.signals=[];
  child.kill=sig=>{child.signals.push(sig);setTimeout(()=>child.emit('exit',0,null),5);return true;};
  r.child=child;r.exitPromise=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  let finished=0;r.finish=async()=>{finished++;};
  r.exitPromise.then(()=>{if(['recording','paused'].includes(r.state.phase))r.finish();});
  r.started=Date.now()-5000;r.state.phase='recording';
  return {root,videos,r,child,finished:()=>finished};
}

test('discard deletes only the take being recorded and returns to idle',async()=>{
  const t=await liveRecorder();
  try{
    const raw=t.r.rawFile;
    const state=await t.r.discard();
    assert.equal(state.phase,'idle');assert.equal(state.lastFile,null);assert.equal(t.finished(),0,'the take is not saved');
    assert.deepEqual(t.child.signals,['SIGINT']);
    await assert.rejects(fs.access(raw));
    assert.deepEqual((await fs.readdir(t.videos)).sort(),['Capture-2026-11-01T09-00-00-000Z.mkv','Earlier take.mp4']);
    assert.deepEqual((await fs.readdir(t.r.dataDir)).filter(n=>n!=='recorder.log').sort(),['Earlier take.mp4.json']);
    assert.equal(t.r.child,null);assert.equal(t.r.rawFile,null);
  }finally{await t.r.dispose();await fs.rm(t.root,{recursive:true,force:true});}
});

test('discard refuses when nothing is recording and never touches a file outside the folder',async()=>{
  const t=await liveRecorder();
  try{
    const outside=path.join(t.root,'Capture-2026-11-07T10-00-00-000Z.mkv');await fs.writeFile(outside,'not ours');
    t.r.rawFile=outside;
    await t.r.discard();
    assert.equal(await fs.readFile(outside,'utf8'),'not ours');
    await assert.rejects(t.r.discard(),/no recording to discard/);
  }finally{await t.r.dispose();await fs.rm(t.root,{recursive:true,force:true});}
});

test('choosing the camera target needs no display',async()=>{
  const r=new Recorder({dataDir:path.join(os.tmpdir(),'capture-camera-target-'+process.pid),outputDir:os.tmpdir()});
  r.unmarkWindow=async()=>{};
  try{
    const s=await r.chooseTarget('camera');
    assert.deepEqual(s.target,{kind:'camera',label:'Camera'});
    r.state.devices.monitors=[{id:'eDP-1',x:0,y:0,width:1280,height:800}];
    assert.equal(r.bubbleTarget().id,'eDP-1','the preview bubble uses the laptop display');
  }finally{await r.dispose();}
});
