const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {shareCard}=require('../share-card.cjs'),{createThumbnail}=require('../thumbnail.cjs'),run=promisify(execFile);
test('share card contains just a safely linked title and animated image, with a plain text fallback',()=>{
 const url='https://vidcapture.stream/v/'+'a'.repeat(48),title='Demo <script> & "quoted"';const c=shareCard({url,title});
 assert.equal(c.text,title+'\n'+url);assert.ok(c.html.includes('Demo &lt;script&gt; &amp; &quot;quoted&quot;'));assert.equal((c.html.match(/<a /g)||[]).length,2);assert.ok(c.html.includes('/thumbnail/'+'a'.repeat(48)+'.gif'));assert.ok(!c.html.includes('<script>'));assert.ok(!c.html.includes('<p>'));
 for(const bad of ['javascript:alert(1)','https://evil.example/v/'+'a'.repeat(48),url+'?x=1'])assert.throws(()=>shareCard({url:bad,title}));
});
test('thumbnail generation creates a real looping animation and matching 640x400 poster without changing the video',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-thumbnail-'));
 try{
  const source=path.join(root,'fixture.mp4');await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x200:rate=12:duration=2','-c:v','libx264','-preset','ultrafast',source]);const before=await fs.readFile(source);
  const preview=await createThumbnail({process:(cmd,args)=>run(cmd,args)},source,root);
  const probe=JSON.parse((await run('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',preview.gif])).stdout).streams[0];assert.equal(probe.width,640);assert.equal(probe.height,400);assert.ok(Number(probe.nb_read_frames)>1);
  const gif=await fs.readFile(preview.gif);assert.ok(gif.includes(Buffer.from('NETSCAPE2.0')));assert.ok(gif.length<5*1024**2);
  const poster=JSON.parse((await run('ffprobe',['-v','error','-show_streams','-of','json',preview.poster])).stdout).streams[0];assert.equal(poster.width,640);assert.equal(poster.height,400);
  assert.deepEqual(await fs.readFile(source),before);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
