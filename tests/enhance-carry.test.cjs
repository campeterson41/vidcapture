'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {carryKeep}=require('../media.cjs');
const {Transcripts}=require('../transcript.cjs');

test('the cut plan carries to an enhanced copy, clamped to its own length',()=>{
  assert.deepEqual(carryKeep([[0,5],[8,20]],20),[[0,5],[8,20]]);
  // A copy a few milliseconds shorter keeps the last section, just shortened.
  assert.deepEqual(carryKeep([[0,5],[8,20]],19.96),[[0,5],[8,19.96]]);
  // A section that falls past the copy's end is dropped, not invented.
  assert.deepEqual(carryKeep([[0,5],[19.99,20]],19.95),[[0,5]]);
  // Anything unusable means the whole copy is kept.
  assert.deepEqual(carryKeep(null,12),[[0,12]]);
  assert.deepEqual(carryKeep([[5,1]],12),[[0,12]]);
});

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vc-carry-'));
  const out=path.join(root,'out'),data=path.join(root,'data');
  await fs.mkdir(out);await fs.mkdir(data);
  const meta={};
  const rec={dataDir:data,state:{},set(){},allowedFile:async f=>f};
  const media={metadata:async f=>meta[path.basename(f)]||{}};
  return {root,out,data,meta,t:new Transcripts(rec,media)};
}
const words=[{text:'Hello',start:0.5,end:0.9},{text:'there',start:1,end:1.4}];

test('an enhanced copy reuses its source transcript with its own file stamp',async()=>{
  const {root,out,meta,t}=await fixture();
  const source=path.join(out,'talk.mp4'),copy=path.join(out,'talk-quick-studio-1.mp4');
  await fs.writeFile(source,'source');await fs.writeFile(copy,'enhanced copy');
  const st=await fs.stat(source);
  await fs.writeFile(t.file(source),JSON.stringify({schema:'vidcapture-transcript/1',source:'talk.mp4',sourceSize:st.size,sourceMtime:st.mtimeMs,words}));
  meta['talk-quick-studio-1.mp4']={enhancedFrom:source};
  assert.equal(await t.carry(copy),true);
  const carried=JSON.parse(await fs.readFile(t.file(copy),'utf8'));
  const cs=await fs.stat(copy);
  assert.equal(carried.sourceSize,cs.size);assert.equal(carried.sourceMtime,cs.mtimeMs);
  assert.equal(carried.carriedFrom,'talk.mp4');assert.deepEqual(carried.words,words);
  // An existing transcript on the copy is never replaced.
  assert.equal(await t.carry(copy),false);
  await fs.rm(root,{recursive:true,force:true});
});

test('a stale or missing source transcript is not carried',async()=>{
  const {root,out,meta,t}=await fixture();
  const source=path.join(out,'talk.mp4'),copy=path.join(out,'talk-folio-1.mp4');
  await fs.writeFile(source,'source');await fs.writeFile(copy,'copy');
  meta['talk-folio-1.mp4']={enhancedFrom:source};
  assert.equal(await t.carry(copy),false);
  await fs.writeFile(t.file(source),JSON.stringify({schema:'vidcapture-transcript/1',sourceSize:1,sourceMtime:1,words}));
  assert.equal(await t.carry(copy),false);
  // A plain recording has no source to carry from.
  assert.equal(await t.carry(source),false);
  await fs.rm(root,{recursive:true,force:true});
});

test('a transcript finished after enhancement reaches the copies made meanwhile',async()=>{
  const {root,out,data,meta,t}=await fixture();
  const source=path.join(out,'talk.mp4'),copy=path.join(out,'talk-quick-studio-2.mp4');
  await fs.writeFile(source,'source');await fs.writeFile(copy,'copy');
  meta['talk-quick-studio-2.mp4']={enhancedFrom:source};
  await fs.writeFile(path.join(data,'talk-quick-studio-2.mp4.json'),JSON.stringify(meta['talk-quick-studio-2.mp4']));
  const st=await fs.stat(source);
  await fs.writeFile(t.file(source),JSON.stringify({schema:'vidcapture-transcript/1',sourceSize:st.size,sourceMtime:st.mtimeMs,words}));
  await t.carryToCopies(source);
  assert.equal(JSON.parse(await fs.readFile(t.file(copy),'utf8')).carriedFrom,'talk.mp4');
  await fs.rm(root,{recursive:true,force:true});
});
