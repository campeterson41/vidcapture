const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {cleanTitle,buildInput,fileStem,FALLBACK}=require('../titles.cjs');
const {Recorder,isRecordingName}=require('../recorder.cjs');

test('titles are cleaned to plain short names or rejected',()=>{
  assert.equal(cleanTitle('"Checkout tax rounding per line."'),'Checkout tax rounding per line');
  assert.equal(cleanTitle('Title: kindly editor grid controls\nextra'),'Kindly editor grid controls');
  assert.equal(cleanTitle('WABO: member directory!'),'WABO member directory');
  assert.equal(cleanTitle('one two three four five six seven'),null);
  assert.equal(cleanTitle('The ultimate guide to forms'),null);
  assert.equal(cleanTitle('...'),null);
  assert.equal(cleanTitle(''),null);
  assert.equal(cleanTitle(FALLBACK),FALLBACK);
});
test('model input carries screen context and caps the transcript',()=>{
  const words=Array.from({length:900},(_,i)=>`w${i}`).join(' ');
  const input=buildInput({screen:'Kindly - Chromium',app:'chromium',durationSeconds:150,transcript:words});
  assert.match(input,/^On screen: Kindly - Chromium \(chromium\)/);
  assert.match(input,/Length: 3 minutes/);
  assert.ok(input.includes('w699')&&!input.includes('w700'));
  assert.match(buildInput({}),/What was said: nothing/);
});
test('file stems are safe and dated',()=>{
  const d=new Date(2026,10,7,9,5);
  assert.equal(fileStem('Fix a/b: c?',d),'Fix a b c 2026-11-07 09.05');
  assert.equal(fileStem('',d),`${FALLBACK} 2026-11-07 09.05`);
});
test('recording names accept titled files and skip partial saves',()=>{
  assert.ok(isRecordingName('Kindly editor grid 2026-11-07 09.05.mp4'));
  assert.ok(isRecordingName('Capture-2026-11-07_09-05-00.mkv'));
  for(const n of ['.hidden.mp4','x.saving.mp4','notes.txt',null])assert.ok(!isRecordingName(n));
});
test('renaming moves the file and every sidecar, and avoids collisions',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-rename-'));
  const data=path.join(root,'state'),out=path.join(root,'videos');
  await fs.mkdir(data);await fs.mkdir(out);
  const r=new Recorder({dataDir:data,outputDir:out});
  try{
    const a=path.join(out,'Capture-2026-11-07_09-05-00.mp4');
    await fs.writeFile(a,'video');
    await fs.writeFile(path.join(data,'Capture-2026-11-07_09-05-00.mp4.json'),'{"title":"Demo"}');
    await fs.writeFile(path.join(data,'Capture-2026-11-07_09-05-00.mp4.transcript.json'),'{}');
    await fs.writeFile(path.join(out,'Demo 2026-11-07 09.05.mp4'),'other');
    r.state.lastFile=await fs.realpath(a);
    const dest=await r.renameRecording(a,'Demo 2026-11-07 09.05');
    assert.equal(path.basename(dest),'Demo 2026-11-07 09.05 2.mp4');
    assert.equal(await fs.readFile(dest,'utf8'),'video');
    assert.deepEqual((await fs.readdir(data)).sort(),['Demo 2026-11-07 09.05 2.mp4.json','Demo 2026-11-07 09.05 2.mp4.transcript.json']);
    assert.equal(r.state.lastFile,dest);
    assert.equal(r.state.renamed.to,dest);
    await assert.rejects(r.renameRecording(path.join(root,'elsewhere.mp4'),'x'));
  }finally{await r.dispose();await fs.rm(root,{recursive:true,force:true});}
});
test('changing the save folder persists and is blocked while busy or fixed',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-location-'));
  const data=path.join(root,'state');await fs.mkdir(data);
  const r=new Recorder({dataDir:data,outputDir:path.join(root,'videos')});
  try{
    await assert.rejects(r.setOutputDir(path.join(root,'new')),/fixed/);
    r.fixedOutput=false;
    await assert.rejects(r.setOutputDir('relative/path'),/Choose a folder/);
    const next=path.join(root,'new','videos');
    await r.setOutputDir(next);
    assert.equal(r.outputDir,await fs.realpath(next));
    assert.equal(r.state.outputDir,r.outputDir);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data,'location.json'),'utf8')),{outputDir:r.outputDir});
    r.state.phase='recording';
    await assert.rejects(r.setOutputDir(root));
  }finally{r.state.phase='idle';await r.dispose();await fs.rm(root,{recursive:true,force:true});}
});
