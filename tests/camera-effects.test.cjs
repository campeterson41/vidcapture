const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {CameraEffects,validImageName}=require('../camera-effects.cjs');
const {validateSettings,DEFAULTS}=require('../recorder.cjs');

test('background image names stay inside the backgrounds folder',()=>{
  for(const ok of ['beach.jpg','Office 2.png','studio (warm).webp'])assert.ok(validImageName(ok),ok);
  for(const bad of ['../x.jpg','a/b.png','.hidden.png','x.gif','',null,'x.jpg/..','..jpg'])assert.ok(!validImageName(bad),String(bad));
});

test('background settings are validated',()=>{
  const d={microphones:[],cameras:[]};
  assert.equal(validateSettings({cameraBackground:'blur',cameraBlur:'strong'},DEFAULTS,d).cameraBlur,'strong');
  assert.equal(validateSettings({cameraBackgroundImage:'beach.jpg'},DEFAULTS,d).cameraBackgroundImage,'beach.jpg');
  assert.throws(()=>validateSettings({cameraBackgroundImage:'../../etc/passwd'},DEFAULTS,d),/Invalid setting/);
  assert.throws(()=>validateSettings({cameraBackground:'green'},DEFAULTS,d),/Invalid setting/);
  assert.equal(DEFAULTS.cameraBackground,'off','off unless chosen');
});

test('effect arguments follow the camera input and the chosen look',()=>{
  const fx=new CameraEffects({root:'/fx',script:'/app/camera_effects.py',backgrounds:'/bg'});
  const mode={width:3840,height:2160,fps:30,input:'mjpeg'};
  const blur=fx.args({size:720,input:'transport',render:'/dev/dri/renderD129',mode,settings:{...DEFAULTS,cameraBackground:'blur',cameraBlur:'strong'},socket:'/s'});
  assert.deepEqual(blur.slice(0,3),['/app/camera_effects.py','--model','/fx/models/camera-effects.onnx']);
  assert.equal(blur[blur.indexOf('--blur')+1],'0.9');
  assert.equal(blur[blur.indexOf('--input')+1],'transport');
  assert.equal(blur[blur.indexOf('--render')+1],'/dev/dri/renderD129');
  assert.ok(!blur.includes('--background'));
  const image=fx.args({size:480,input:'v4l2',device:'/dev/video2',mode:{...mode,width:1280,height:720},settings:{...DEFAULTS,cameraBackground:'image',cameraBackgroundImage:'beach.jpg'},socket:'/s'});
  assert.equal(image[image.indexOf('--background')+1],'/bg/beach.jpg');
  assert.equal(image[image.indexOf('--device')+1],'/dev/video2');
  assert.equal(image[image.indexOf('--format')+1],'mjpeg');
  assert.throws(()=>fx.args({size:480,input:'v4l2',device:'/dev/video2',mode,settings:{...DEFAULTS,cameraBackground:'image',cameraBackgroundImage:''},socket:'/s'}),/Choose a background image/);
});

test('added images are copied in with safe, unique names',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capture-bg-test-'));
  const fx=new CameraEffects({backgrounds:path.join(dir,'backgrounds')});
  const src=path.join(dir,'My Office!.JPG');await fs.writeFile(src,'x');
  assert.equal(await fx.addImage(src),'My Office-.JPG');
  assert.equal(await fx.addImage(src),'My Office- 2.JPG');
  assert.deepEqual(await fx.images(),['My Office- 2.JPG','My Office-.JPG']);
  await fx.removeImage('My Office-.JPG');
  assert.deepEqual(await fx.images(),['My Office- 2.JPG']);
  const gif=path.join(dir,'a.gif');await fs.writeFile(gif,'x');
  await assert.rejects(fx.addImage(gif),/JPEG, PNG or WebP/);
});
