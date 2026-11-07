const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Library,isRecordingName,parseRecordingName,recordingTitle,cacheKey,thumbPath}=require('../library.cjs');
const {Recorder}=require('../recorder.cjs');

const now=()=>new Date('2026-11-07T12:00:00Z');

test('titles come from the recording time in local time, with copies labeled',()=>{
  const o={now:now(),timeZone:'America/Chicago'};
  assert.deepEqual(recordingTitle('Capture-2026-11-06T17-24-03-758Z.mkv',o),{title:'Nov 6, 11:24 AM',dated:true,variant:null,recordedAt:'2026-11-06T17:24:03.758Z'});
  assert.equal(recordingTitle('Capture-2026-11-06T17-24-03-758Z-edited-1793986116324.mp4',o).variant,'Edited');
  assert.equal(recordingTitle('Capture-2026-11-06T17-24-03-758Z-edited-1793986116324-enhanced-1793995502313.mp4',o).variant,'Edited, enhanced audio');
  assert.equal(recordingTitle('Capture-2026-11-06T17-24-03-758Z-edited-1-quick-studio-2.mp4',o).variant,'Edited, enhanced audio');
  assert.equal(recordingTitle('Capture-2026-11-06T15-56-52-759Z-folio-1793980717283.mp4',o).variant,'Enhanced audio');
  assert.equal(recordingTitle('Capture-2025-01-02T03-04-05-000Z.mp4',{now:now(),timeZone:'UTC'}).title,'Jan 2, 2025, 3:04 AM');
  assert.deepEqual(recordingTitle('Capture-demo.mp4',o),{title:'demo',dated:false,variant:null,recordedAt:null});
  assert.equal(parseRecordingName('Capture-2026-13-45T10-00-00-000Z.mp4').recordedAt,null);
});

test('recording names exclude partial saves, other folders, and other files',()=>{
  assert.ok(isRecordingName('Capture-2026-11-06T17-24-03-758Z.mkv'));
  assert.ok(isRecordingName('Kindly editor grid controls 2026-11-07 09.05.mp4'));
  for(const n of ['Capture-x.saving.mp4','../Capture-x.mp4','sub/Capture-x.mp4','Audio-comparison.wav','Capture-x.mov','.hidden.mp4',null,42])assert.ok(!isRecordingName(n));
});

test('titled recordings show their AI title, and edits keep it with a variant',()=>{
  const o={now:new Date(2026,10,7,12),timeZone:undefined};
  const t=recordingTitle('Kindly editor grid controls 2026-11-07 09.05.mp4',o);
  assert.equal(t.title,'Kindly editor grid controls');assert.equal(t.variant,null);
  assert.equal(new Date(t.recordedAt).getTime(),new Date(2026,10,7,9,5).getTime());
  const e=recordingTitle('Kindly editor grid controls 2026-11-07 09.05 2-edited-1793986116324.mp4',o);
  assert.equal(e.title,'Kindly editor grid controls');assert.equal(e.variant,'Edited');
  const meta={title:'Checkout tax rounding',recordedAt:'2026-11-07T15:05:09.000Z'};
  assert.deepEqual(recordingTitle('Capture-2026-11-07T15-05-09-000Z.mp4',o,meta),{title:'Checkout tax rounding',dated:false,variant:null,recordedAt:'2026-11-07T15:05:09.000Z'});
  assert.equal(recordingTitle('Screen recording 2026-11-07 09.05.mp4',o,meta).recordedAt,'2026-11-07T15:05:09.000Z');
  assert.equal(recordingTitle('notes.mp4',o).title,'notes');
});

test('cache keys change when a recording is replaced or modified',()=>{
  const a=cacheKey('Capture-a.mp4',100,1000);
  assert.match(a,/^[a-f0-9]{40}$/);
  assert.equal(a,cacheKey('Capture-a.mp4',100,1000));
  assert.notEqual(a,cacheKey('Capture-a.mp4',101,1000));
  assert.notEqual(a,cacheKey('Capture-a.mp4',100,2000));
  assert.notEqual(a,cacheKey('Capture-b.mp4',100,1000));
});

test('poster serving rejects traversal, other names, and links out of the cache',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-thumbs-'));
  const dir=path.join(root,'thumbs');await fs.mkdir(dir);
  const good='a'.repeat(40)+'.jpg';await fs.writeFile(path.join(dir,good),'jpg');
  await fs.writeFile(path.join(root,'secret.jpg'),'secret');
  const link='b'.repeat(40)+'.jpg';await fs.symlink(path.join(root,'secret.jpg'),path.join(dir,link));
  await fs.mkdir(path.join(dir,'c'.repeat(40)+'.jpg'));
  try{
    assert.equal(await thumbPath(dir,good),await fs.realpath(path.join(dir,good)));
    for(const bad of ['../secret.jpg','..%2Fsecret.jpg','/etc/passwd',`${'a'.repeat(40)}.json`,`x/${good}`,'A'.repeat(40)+'.jpg',link,'c'.repeat(40)+'.jpg','d'.repeat(40)+'.jpg','',undefined])
      await assert.rejects(thumbPath(dir,bad),String(bad));
    const lib=new Library({dataDir:root,outputDir:root});
    assert.equal((await lib.serve(new URL(`capture-media://thumb/${good}`))).status,200);
    for(const bad of ['..%2Fsecret.jpg','%2E%2E/secret.jpg',link])assert.equal((await lib.serve(new URL(`capture-media://thumb/${bad}`))).status,404);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('library lists every recording newest first and caches posters privately',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-library-'));
  const rec=new Recorder({dataDir:path.join(root,'state'),outputDir:path.join(root,'videos')});
  await fs.mkdir(rec.dataDir,{recursive:true});await fs.mkdir(rec.outputDir,{recursive:true});
  const names=[];
  for(let i=0;i<15;i++){
    const name=`Capture-2026-11-0${1+(i%9)}T1${i%10}-00-00-000Z${i===3?'-edited-5':''}.mp4`;
    if(names.includes(name))continue;names.push(name);
    const file=path.join(rec.outputDir,name);await fs.writeFile(file,'x'.repeat(10+i));
    const t=new Date(Date.UTC(2026,10,1,0,i));await fs.utimes(file,t,t);
  }
  await fs.writeFile(path.join(rec.outputDir,'Capture-z.saving.mp4'),'partial');
  await fs.writeFile(path.join(rec.outputDir,'Capture-empty.mp4'),'');
  await fs.writeFile(path.join(rec.outputDir,'notes.txt'),'x');
  await fs.writeFile(path.join(rec.outputDir,'Capture-live.mkv'),'growing');rec.rawFile=path.join(rec.outputDir,'Capture-live.mkv');
  const calls=[];let running=0,peak=0;
  const run=async(cmd,args)=>{
    calls.push(cmd);running++;peak=Math.max(peak,running);await new Promise(r=>setTimeout(r,10));running--;
    if(args.includes(path.join(rec.outputDir,names[0])))throw new Error('corrupt');
    if(cmd==='ffprobe')return {stdout:JSON.stringify({format:{duration:'12.5'}})};
    await fs.writeFile(args[args.length-1],'jpeg');return {stdout:''};
  };
  const lib=new Library(rec,{run,now});
  try{
    const items=await lib.list();
    assert.equal(items.length,names.length);
    assert.ok(items.every((it,i)=>!i||items[i-1].recordedAt>=it.recordedAt));
    assert.ok(!items.some(it=>/saving|empty|live/.test(it.name)));
    assert.equal(items.find(it=>it.name.includes('-edited-')).variant,'Edited');
    // An edited copy made later sorts by its recording time, just above its original.
    const copy=path.join(rec.outputDir,'Capture-2026-11-01T10-00-00-000Z-edited-9.mp4');await fs.writeFile(copy,'copy');
    const order=(await lib.list()).map(it=>it.name);
    assert.equal(order.indexOf('Capture-2026-11-01T10-00-00-000Z-edited-9.mp4')+1,order.indexOf('Capture-2026-11-01T10-00-00-000Z.mp4'));
    await fs.rm(copy);
    const results=await Promise.all(names.map(n=>lib.details(n)));
    assert.ok(peak<=2,'poster generation is limited to two at a time');
    assert.equal(results[0].unreadable,true);assert.equal(results[0].poster,null);
    assert.equal(results[1].duration,12.5);assert.match(results[1].poster,/^capture-media:\/\/thumb\/[a-f0-9]{40}\.jpg$/);
    const before=calls.length;await lib.details(names[1]);assert.equal(calls.length,before,'cached poster is reused');
    const stat=await fs.stat(lib.dir);assert.equal(stat.mode&0o777,0o700);
    const posterFile=path.join(lib.dir,results[1].key+'.jpg');assert.equal((await fs.stat(posterFile)).mode&0o777,0o600);
    const listed=(await lib.list()).find(it=>it.name===names[1]);assert.equal(listed.duration,12.5);assert.equal(listed.poster,results[1].poster);
    await assert.rejects(lib.details('../state/settings.json'));
    await assert.rejects(lib.details('Capture-missing.mp4'));
    // Replacing a recording drops its old poster from the cache.
    await fs.writeFile(path.join(rec.outputDir,names[1]),'changed contents');await lib.list();await new Promise(r=>setTimeout(r,50));
    await assert.rejects(fs.access(posterFile));
  }finally{await rec.dispose();await fs.rm(root,{recursive:true,force:true});}
});
