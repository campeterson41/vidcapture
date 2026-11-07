const {test}=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {once}=require('node:events');
const {cameraCommand}=require('../camera.cjs');

async function serverFixture(t,respond) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capture-ipc-'));
 const socket=path.join(dir,'control.sock');
 const server=net.createServer(client=>client.once('data',data=>respond(client,JSON.parse(data))));
 server.listen(socket);await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
 return socket;
}
test('camera readiness handles events and split IPC responses',async t=>{
 const socket=await serverFixture(t,(client,request)=>{
  assert.deepEqual(request.command,['get_property','hwdec-current']);
  client.write('{"event":"video-reconfig"}\n{"request_id":1,"error":"success","da');
  setTimeout(()=>client.end('ta":"vaapi"}\n'),10);
 });
 assert.equal(await cameraCommand(socket,['get_property','hwdec-current']),'vaapi');
});
test('camera readiness fails when the player closes instead of hanging',async t=>{
 const socket=await serverFixture(t,client=>client.end());
 await assert.rejects(cameraCommand(socket,['get_property','hwdec-current']),/closed/);
});
test('camera readiness propagates player errors',async t=>{
 const socket=await serverFixture(t,client=>client.end('{"request_id":1,"error":"property unavailable"}\n'));
 await assert.rejects(cameraCommand(socket,['get_property','hwdec-current']),/property unavailable/);
});
