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

test('a transport-fed preview is ended at once without an IPC quit, before its transport stops',async()=>{
 const net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const r=new Recorder();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capture-close-order-'));
 const socketPath=path.join(dir,'control.sock');let ipcConnections=0;
 const server=net.createServer(c=>{ipcConnections++;c.destroy();});
 await new Promise(resolve=>server.listen(socketPath,resolve));
 const camera=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
 const transport=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await Promise.all([once(camera,'spawn'),once(transport,'spawn')]);
 const order=[];
 for(const [name,child] of [['camera',camera],['transport',transport]]){
  const kill=child.kill.bind(child);child.kill=signal=>{order.push(`${name}:${signal}`);return kill(signal);};
  child.once('exit',()=>order.push(`${name}:exit`));
 }
 camera.controlSocket=socketPath;camera.transport=transport;r.camera=camera;r.state.cameraPreview=true;
 try{
  const started=Date.now();
  await r.closeCamera();
  assert.equal(ipcConnections,0,'The transport path must not ask MPV to quit');
  assert.equal(camera.signalCode,'SIGKILL');
  assert.deepEqual(order.slice(0,3),['camera:SIGKILL','camera:exit','transport:SIGTERM']);
  assert.ok(transport.exitCode!==null||transport.signalCode);
  assert.ok(Date.now()-started<2000,'Closing must not wait for the IPC quit timeout');
  assert.equal(r.camera,null);assert.equal(r.state.cameraPreview,false);
 }finally{
  for(const child of [camera,transport])if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');
  server.close();fs.rmSync(dir,{recursive:true,force:true});await r.dispose();
 }
});

test('a preview that reads the camera itself still quits through MPV IPC',async()=>{
 const net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const r=new Recorder();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capture-close-direct-'));
 const socketPath=path.join(dir,'control.sock');
 const camera=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await once(camera,'spawn');
 const received=[];
 const server=net.createServer(c=>{c.setEncoding('utf8');c.on('data',d=>{received.push(d);camera.kill('SIGTERM');});});
 await new Promise(resolve=>server.listen(socketPath,resolve));
 const signals=[],kill=camera.kill.bind(camera);
 camera.kill=signal=>{signals.push(signal);return kill(signal);};
 camera.controlSocket=socketPath;r.camera=camera;
 try{
  await r.closeCamera();
  assert.match(received.join(''),/"command":\["quit"\]/);
  assert.ok(!signals.includes('SIGKILL'),'A responsive direct preview is not killed');
 }finally{
  if(camera.exitCode===null&&!camera.signalCode)kill('SIGKILL');
  server.close();fs.rmSync(dir,{recursive:true,force:true});await r.dispose();
 }
});

test('an effects-fed preview still quits through MPV IPC before its effects and transport stop',async()=>{
 const net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const r=new Recorder();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capture-close-effects-'));
 const socketPath=path.join(dir,'control.sock');
 const camera=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const effects=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const transport=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await Promise.all([once(camera,'spawn'),once(effects,'spawn'),once(transport,'spawn')]);
 const order=[],received=[];
 for(const [name,child] of [['camera',camera],['effects',effects],['transport',transport]]){
  const kill=child.kill.bind(child);child.kill=signal=>{order.push(`${name}:${signal}`);return kill(signal);};
  child.once('exit',()=>order.push(`${name}:exit`));
 }
 const server=net.createServer(c=>{c.setEncoding('utf8');c.on('data',d=>{received.push(d);process.kill(camera.pid,'SIGTERM');});});
 await new Promise(resolve=>server.listen(socketPath,resolve));
 camera.controlSocket=socketPath;camera.effects=effects;camera.transport=transport;r.camera=camera;
 try{
  await r.closeCamera();
  assert.match(received.join(''),/"command":\["quit"\]/);
  assert.ok(!order.includes('camera:SIGKILL'),'A responsive effects-fed preview is not killed');
  assert.ok(order.indexOf('camera:exit')<order.indexOf('effects:SIGTERM'));
  assert.ok(order.indexOf('effects:SIGTERM')<order.indexOf('transport:SIGTERM'));
 }finally{
  for(const child of [camera,effects,transport])if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');
  server.close();fs.rmSync(dir,{recursive:true,force:true});await r.dispose();
 }
});
