const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {Recorder}=require('../recorder.cjs');
const {MediaTools,validKeep,hash,exportArgs,hardwareDecodable,intelRenderNode}=require('../media.cjs');
const run=promisify(execFile);
test('cut plan rejects reversed, overlapping, empty and out-of-range sections',()=>{
  for(const k of [[],[[1,0]],[[0,3],[2,5]],[[0,11]],[[NaN,3]],[[0,0.05]]])assert.throws(()=>validKeep(k,10));
  assert.deepEqual(validKeep([[1,3],[5,8]],10),[[1,3],[5,8]]);
});
test('real cut export preserves original, keeps all audio tracks, and matches selected duration',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-edit-test-'));
  const rec=new Recorder({dataDir:path.join(root,'state'),outputDir:path.join(root,'videos')});
  await fs.mkdir(rec.dataDir);await fs.mkdir(rec.outputDir);
  const file=path.join(rec.outputDir,'Capture-fixture.mp4');
  await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=6','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=6','-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-c:a','aac',file]);
  const original=await hash(file);const media=new MediaTools(rec);
  await fs.writeFile(media.metadataPath(file),JSON.stringify({micTrack:0,systemTrack:1}));
  await media.saveEdits(file,[[1,2],[4,5.5]]);
  assert.deepEqual((await media.getMedia(file)).keep,[[1,2],[4,5.5]]);
  media.exportEdit(file,[[1,2],[4,5.5]]);await media.task;
  assert.equal(rec.state.job.error,null);
  const info=await media.getMedia(rec.state.job.output);assert.ok(Math.abs(info.duration-2.5)<0.1);assert.equal(info.canEnhance,true);
  const probe=await media.probe(rec.state.job.output);assert.equal(probe.streams.filter(s=>s.codec_type==='audio').length,2);
  assert.equal(await hash(file),original);
  const exported=JSON.parse(await fs.readFile(media.metadataPath(rec.state.job.output),'utf8')).export;
  assert.equal(exported.encoder,await intelRenderNode()?'h264_vaapi':'libx264');
  // Canceling must leave the original and already completed export untouched.
  const output=rec.state.job.output;const outputHash=await hash(output);
  media.exportEdit(file,[[0,6]]);await media.cancelJob();await media.task;
  assert.equal(rec.state.job.stage,'Canceled');assert.equal(await hash(file),original);assert.equal(await hash(output),outputHash);
  await rec.dispose();await fs.rm(root,{recursive:true,force:true});
});

test('waveform distinguishes silence and audio, caches bounded peaks, and handles silent video',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-wave-test-'));
  const rec=new Recorder({dataDir:path.join(root,'state'),outputDir:path.join(root,'videos')});
  const media=new MediaTools(rec);
  try {
    await fs.mkdir(rec.dataDir);await fs.mkdir(rec.outputDir);
    const file=path.join(rec.outputDir,'Capture-wave.mp4'),silent=path.join(rec.outputDir,'Capture-silent.mp4');
    await run('ffmpeg',['-v','error','-f','lavfi','-i','color=size=160x90:rate=10:duration=2','-f','lavfi','-i','aevalsrc=if(lt(t\\,1)\\,0\\,0.3*sin(2*PI*440*t)):s=8000:d=2','-c:v','libx264','-preset','ultrafast','-c:a','aac',file]);
    const original=await hash(file),wave=await media.getWaveform(file);
    assert.equal(wave.hasAudio,true);assert.ok(wave.peaks.length<=24000);
    assert.ok(wave.peaks.slice(0,400).every(x=>x<.01));assert.ok(wave.peaks.slice(650).some(x=>x>.2));
    assert.equal(await media.getWaveform(file),wave);assert.equal(await hash(file),original);
    await run('ffmpeg',['-v','error','-i',file,'-an','-c:v','copy',silent]);
    assert.deepEqual((await media.getWaveform(silent)).peaks,[]);
    assert.equal((await media.getWaveform(silent)).hasAudio,false);
    assert.equal(media.waveformProcesses.size,0);
  } finally {media.dispose();await rec.dispose();await fs.rm(root,{recursive:true,force:true});}
});

test('fast cleanup preserves video packets, timing, original and system audio; cancellation removes partial output',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-audio-test-'));
  const rec=new Recorder({dataDir:path.join(root,'state'),outputDir:path.join(root,'videos')});
  const media=new MediaTools(rec);
  try{
    await fs.mkdir(rec.dataDir);await fs.mkdir(rec.outputDir);
    const file=path.join(rec.outputDir,'Capture-audio.mp4');
    await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=30:duration=6','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=6','-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-c:a','aac',file]);
    await fs.writeFile(media.metadataPath(file),JSON.stringify({micTrack:0,systemTrack:1}));
    const before=await hash(file);
    const videoHash=async p=>(await run('ffmpeg',['-v','error','-i',p,'-map','0:v:0','-c','copy','-f','hash','-'])).stdout;
    media.enhanceAudioFast(file);await media.task;
    assert.equal(rec.state.job.error,null);
    const output=rec.state.job.output,p=await media.probe(output);
    assert.equal(await hash(file),before);assert.equal(await videoHash(file),await videoHash(output));
    assert.equal(p.streams.filter(s=>s.codec_type==='audio').length,1);
    assert.ok(Math.abs(Number(p.format.duration)-6)<0.1);
    assert.equal((await media.getMedia(output)).canEnhance,false);
    // Both distinct tones must survive in the delivered mixed track.
    const pcm=await run('ffmpeg',['-v','error','-i',output,'-ss','2','-t','1','-map','0:a:0','-ac','1','-ar','8000','-f','f32le','-'],{encoding:'buffer'});
    const samples=Array.from({length:pcm.stdout.length/4},(_,i)=>pcm.stdout.readFloatLE(i*4));
    for(const hz of [440,880]){
      let re=0,im=0;for(let i=0;i<samples.length;i++){re+=samples[i]*Math.cos(2*Math.PI*hz*i/8000);im+=samples[i]*Math.sin(2*Math.PI*hz*i/8000);}
      assert.ok(2*Math.hypot(re,im)/samples.length>.025,`missing ${hz} Hz track`);
    }
    assert.ok(samples.every(x=>Number.isFinite(x)&&Math.abs(x)<1));
    media.enhanceAudioFast(file);await media.cancelJob();await media.task;
    assert.equal(rec.state.job.stage,'Canceled');assert.equal(await hash(file),before);
    assert.equal((await fs.readdir(rec.outputDir)).filter(n=>n.includes('.saving.')).length,0);
    assert.ok((await fs.readdir(rec.dataDir)).some(n=>n.startsWith('audio-job-')));
    await media.saveEdits(file,[[1,5]]);media.enhanceAudioFast(file);await media.task;
    assert.match(rec.state.job.error,/Save an edited copy/);
    await fs.writeFile(media.metadataPath(file),JSON.stringify({micTrack:0,systemTrack:99}));
    media.enhanceAudioFast(file);await media.task;assert.match(rec.state.job.error,/system audio track/);
    await fs.writeFile(media.metadataPath(file),JSON.stringify({micTrack:-1}));
    media.enhanceAudioFast(file);await media.task;assert.match(rec.state.job.error,/no isolated microphone/);
  }finally{media.dispose();await rec.dispose();await fs.rm(root,{recursive:true,force:true});}
});

test('hardware export falls back to software when the graphics device cannot encode, and handles non GPU decodable sources',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-export-fallback-'));
  const rec=new Recorder({dataDir:path.join(root,'state'),outputDir:path.join(root,'videos')});
  await fs.mkdir(rec.dataDir);await fs.mkdir(rec.outputDir);
  // 4:4:4 lossless H.264 is not decodable by the Intel decoder, so the hardware path must upload software frames.
  const file=path.join(rec.outputDir,'Capture-fallback.mp4');
  await run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-map','0:v','-map','1:a','-c:v','libx264','-preset','ultrafast','-qp','0','-pix_fmt','yuv444p','-c:a','aac',file]);
  const media=new MediaTools(rec);const source=(await media.probe(file)).streams.find(s=>s.codec_type==='video');
  assert.equal(hardwareDecodable(source),false);
  const args=exportArgs(file,{filter:'[0:v]null[video]',outputs:['[video]']},'/tmp/out.mp4','h264_vaapi',{device:'/dev/dri/renderD128',video:source});
  assert.ok(args.includes('-filter_hw_device')&&!args.includes('-hwaccel'));assert.match(args[args.indexOf('-filter_complex')+1],/hwupload\[hwvideo\]$/);
  if(await intelRenderNode()){
    media.exportEdit(file,[[0.5,3]]);await media.task;assert.equal(rec.state.job.error,null);
    assert.equal(JSON.parse(await fs.readFile(media.metadataPath(rec.state.job.output),'utf8')).export.encoder,'h264_vaapi');
  }
  // A device that cannot initialize falls back to libx264 and still produces a checked copy.
  media.renderNode=Promise.resolve(path.join(root,'missing-render-node'));
  media.exportEdit(file,[[0.5,3]]);await media.task;assert.equal(rec.state.job.error,null);
  const meta=JSON.parse(await fs.readFile(media.metadataPath(rec.state.job.output),'utf8'));
  assert.equal(meta.export.encoder,'libx264');assert.ok(meta.export.hardwareFallback);
  const info=await media.getMedia(rec.state.job.output);assert.ok(Math.abs(info.duration-2.5)<0.1);
  await rec.dispose();await fs.rm(root,{recursive:true,force:true});
});
