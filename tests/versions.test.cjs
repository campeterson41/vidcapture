const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Library,versionBase,groupVersions}=require('../library.cjs');
const {Recorder}=require('../recorder.cjs');

const item=(name,modified,extra={})=>({name,path:'/v/'+name,key:name,modified,bytes:1,title:'T',recordedAt:null,variant:/-edited-/.test(name)?'Edited':null,...extra});

test('version base strips every edit and audio suffix',()=>{
  assert.equal(versionBase('Demo 2026-11-07 09.05.mp4'),'Demo 2026-11-07 09.05');
  assert.equal(versionBase('Demo 2026-11-07 09.05-edited-1794050000000-enhanced-1794050100000.mp4'),'Demo 2026-11-07 09.05');
  assert.equal(versionBase('Capture-2026-11-06T16-24-03-758Z-folio-1793980717283.mp4'),'Capture-2026-11-06T16-24-03-758Z');
  assert.equal(versionBase('Notes-edited-12.mp4'),'Notes-edited-12');
});
test('copies fold into one recording, newest current, original labeled',()=>{
  const g=groupVersions([item('A.mp4','2026-11-07T08:00:00Z'),item('A-edited-1794050000000.mp4','2026-11-07T09:00:00Z'),item('B.mp4','2026-11-07T07:00:00Z')]);
  assert.equal(g.length,2);
  const a=g.find(x=>x.root==='A.mp4');
  assert.equal(a.name,'A-edited-1794050000000.mp4');
  assert.deepEqual(a.versions.map(v=>[v.label,v.current]),[['Edited',true],['Original',false]]);
});
test('a restored version stays current until a newer one is made',()=>{
  const list=[item('A.mp4','2026-11-07T08:00:00Z'),item('A-edited-1794050000000.mp4','2026-11-07T09:00:00Z')];
  const pick=at=>new Map([['A.mp4',{currentVersion:{suffix:'.mp4',at}}]]);
  assert.equal(groupVersions(list,pick(Date.parse('2026-11-07T10:00:00Z')))[0].name,'A.mp4');
  assert.equal(groupVersions(list,pick(Date.parse('2026-11-07T08:30:00Z')))[0].name,'A-edited-1794050000000.mp4');
});
test('restoring writes the pick and renaming moves every version together',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-versions-'));
  const data=path.join(root,'state'),out=path.join(root,'videos');await fs.mkdir(data);await fs.mkdir(out);
  const r=new Recorder({dataDir:data,outputDir:out});
  try{
    for(const n of ['Capture-x.mp4','Capture-x-edited-1794050000000.mp4','Capture-x-edited-1794050000000-enhanced-1794050100000.mp4','Other.mp4'])await fs.writeFile(path.join(out,n),n);
    await fs.writeFile(path.join(data,'Capture-x-edited-1794050000000.mp4.transcript.json'),'{}');
    const lib=new Library(r,{run:async()=>{throw new Error('no ffmpeg in tests');}});
    const items=await lib.setCurrentVersion('Capture-x.mp4','Capture-x-edited-1794050000000.mp4');
    assert.equal(items.find(i=>i.root==='Capture-x.mp4').name,'Capture-x-edited-1794050000000.mp4');
    await assert.rejects(lib.setCurrentVersion('Capture-x.mp4','Other.mp4'),/not a version/);
    await r.renameRecording(path.join(out,'Capture-x.mp4'),'Demo 2026-11-07 09.05');
    assert.deepEqual((await fs.readdir(out)).sort(),['Demo 2026-11-07 09.05-edited-1794050000000-enhanced-1794050100000.mp4','Demo 2026-11-07 09.05-edited-1794050000000.mp4','Demo 2026-11-07 09.05.mp4','Other.mp4']);
    const names=await fs.readdir(data);
    assert.ok(names.includes('Demo 2026-11-07 09.05-edited-1794050000000.mp4.transcript.json'));
    assert.ok(names.includes('Demo 2026-11-07 09.05.mp4.json'));
    const g=(await lib.list()).find(i=>i.root==='Demo 2026-11-07 09.05.mp4');
    assert.equal(g.versions.length,3);
    assert.equal(g.name,'Demo 2026-11-07 09.05-edited-1794050000000.mp4');
  }finally{await r.dispose();await fs.rm(root,{recursive:true,force:true});}
});
test('renaming sets the title on the whole recording and keeps files in place',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-rename-'));
  const data=path.join(root,'state'),out=path.join(root,'videos');await fs.mkdir(data);await fs.mkdir(out);
  const r=new Recorder({dataDir:data,outputDir:out});
  try{
    for(const n of ['Demo 2026-11-07 09.05.mp4','Demo 2026-11-07 09.05-edited-1794050000000.mp4'])await fs.writeFile(path.join(out,n),n);
    await fs.writeFile(path.join(data,'Demo 2026-11-07 09.05.mp4.json'),JSON.stringify({keep:[[0,1]],title:'Old'}));
    const lib=new Library(r,{run:async()=>{throw new Error('no ffmpeg in tests');}});
    const items=await lib.rename('Demo 2026-11-07 09.05.mp4','  Q4   plan\nreview ');
    assert.equal(items[0].title,'Q4 plan review');
    const meta=JSON.parse(await fs.readFile(path.join(data,'Demo 2026-11-07 09.05.mp4.json'),'utf8'));
    assert.deepEqual(meta,{keep:[[0,1]],title:'Q4 plan review'});
    assert.equal((await fs.readdir(out)).length,2);
    await assert.rejects(lib.rename('Demo 2026-11-07 09.05.mp4','   '),/Enter a name/);
    await assert.rejects(lib.rename('Demo 2026-11-07 09.05.mp4','x'.repeat(121)),/120/);
    await assert.rejects(lib.rename('../escape.mp4','A'),/Choose a file/);
    await assert.rejects(lib.rename('Missing.mp4','A'));
  }finally{await r.dispose();await fs.rm(root,{recursive:true,force:true});}
});
test('removing moves only that recording and its versions to the trash',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-remove-'));
  const data=path.join(root,'state'),out=path.join(root,'videos');await fs.mkdir(data);await fs.mkdir(out);
  const r=new Recorder({dataDir:data,outputDir:out});
  try{
    for(const n of ['A.mp4','A-edited-1794050000000.mp4','A-edited-1794050000000-enhanced-1794050100000.mp4','AB.mp4','B.mp4','notes.txt'])await fs.writeFile(path.join(out,n),n);
    const lib=new Library(r,{run:async()=>{throw new Error('no ffmpeg in tests');}});
    const trashed=[];const trash=async f=>{trashed.push(path.basename(f));await fs.rm(f);};
    const items=await lib.remove('A.mp4',trash);
    assert.deepEqual(trashed.sort(),['A-edited-1794050000000-enhanced-1794050100000.mp4','A-edited-1794050000000.mp4','A.mp4']);
    assert.deepEqual(items.map(i=>i.root).sort(),['AB.mp4','B.mp4']);
    assert.deepEqual((await fs.readdir(out)).sort(),['AB.mp4','B.mp4','notes.txt']);
    await assert.rejects(lib.remove('notes.txt',trash),/Choose a file/);
    r.state.phase='recording';
    await assert.rejects(lib.remove('B.mp4',trash),/Finish recording/);
    r.state.phase='idle';r.state.job={running:true};
    await assert.rejects(lib.remove('B.mp4',trash),/Wait for the current job/);
    assert.ok((await fs.readdir(out)).includes('B.mp4'));
  }finally{await r.dispose();await fs.rm(root,{recursive:true,force:true});}
});
