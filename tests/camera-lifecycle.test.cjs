const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {Recorder}=require('../recorder.cjs');

test('unresponsive camera preview is terminated without sending SIGTERM',async()=>{
 const r=new Recorder();
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await once(child,'spawn');
 child.controlSocket=`/tmp/capture-missing-${process.pid}.sock`;
 r.camera=child;r.state.cameraPreview=true;
 const signals=[],kill=child.kill.bind(child);
 child.kill=signal=>{signals.push(signal);return kill(signal);};
 try{
  await r.closeCamera();
  assert.deepEqual(signals,['SIGKILL']);assert.equal(child.signalCode,'SIGKILL');
  assert.equal(r.camera,null);assert.equal(r.state.cameraPreview,false);
 }finally{
  if(child.exitCode===null&&!child.signalCode)kill('SIGKILL');
  await r.dispose();
 }
});

test('closing the preview also releases its camera transport',async()=>{
 const r=new Recorder();
 const camera=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const transport=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await Promise.all([once(camera,'spawn'),once(transport,'spawn')]);
 camera.controlSocket=`/tmp/capture-missing-transport-${process.pid}.sock`;
 camera.transport=transport;r.camera=camera;
 try {
  await r.closeCamera();
  assert.ok(camera.exitCode!==null||camera.signalCode);
  assert.ok(transport.exitCode!==null||transport.signalCode);
 }finally{
  for(const child of [camera,transport])if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');
  await r.dispose();
 }
});
