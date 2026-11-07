const test=require('node:test');const assert=require('node:assert/strict');
const {acceptPolish,chunkRanges,isFiller,normWord,validTranscript}=require('../transcript.cjs');
const {editGraph,selectGraph,validKeep,MAX_SECTIONS}=require('../media.cjs');

test('polish may only change punctuation and capitalization',()=>{
  const orig=['so','um','whenever','you','uh','whenever'];
  assert.deepEqual(acceptPolish(orig,'So um, whenever you, uh, whenever.'),['So','um,','whenever','you,','uh,','whenever.']);
  assert.equal(acceptPolish(orig,'So whenever you, uh, whenever.'),null,'dropping um is rejected');
  assert.equal(acceptPolish(orig,'So um, whenever you, uh, wherever.'),null,'changing a word is rejected');
  assert.equal(acceptPolish(orig,'So um, whenever you, uh, whenever. Thanks'),null,'adding a word is rejected');
  assert.equal(acceptPolish(orig,''),null);
});

test('fillers are recognized regardless of punctuation and case',()=>{
  for(const w of ['um','Um,','uh.','UHH','hmm?'])assert.ok(isFiller(w),w);
  for(const w of ['umbrella','huh','I','summer'])assert.ok(!isFiller(w),w);
  assert.equal(normWord("It's,"),"it's");
});

test('chunks end at a sentence when one is near',()=>{
  const words=Array.from({length:1000},(_,i)=>({text:i===400?'end.':'w'}));
  const r=chunkRanges(words,450);
  assert.deepEqual(r[0],[0,401]);
  assert.equal(r.at(-1)[1],1000);
  for(let i=1;i<r.length;i++)assert.equal(r[i][0],r[i-1][1]);
});

test('stored transcripts are validated',()=>{
  const ok={schema:'vidcapture-transcript/1',words:[{text:'a',start:0,end:0.2},{text:'b',start:0.3,end:0.5}]};
  assert.ok(validTranscript(ok,1));
  assert.ok(!validTranscript({...ok,words:[{text:'a',start:0.5,end:0.2}]}));
  assert.ok(!validTranscript({...ok,words:[{text:'a',start:2,end:3}]},1));
  assert.ok(!validTranscript({...ok,schema:'other'}));
});

test('many sections use grouped select filters on the original timeline',()=>{
  const keep=Array.from({length:120},(_,i)=>[1+i*0.5,1.3+i*0.5]);
  assert.ok(validKeep(keep,100));
  const g=editGraph(keep,2);
  assert.deepEqual(g.outputs,['[video]','[audio0]','[audio1]']);
  assert.ok(!g.filter.includes('trim='),'no per-section trim branches');
  assert.ok(!g.filter.includes('STARTPTS'),'times stay on the source timeline');
  // 120 cuts plus the tail, in groups of 40.
  assert.equal((g.filter.split(';')[0].match(/select=/g)||[]).length,4);
  assert.ok(g.filter.includes('not(gte(t\\,0)*lt(t\\,1))'),'leading cut');
  assert.ok(g.filter.includes('not(gte(t\\,1.3)*lt(t\\,1.5))'),'gap between sections');
  assert.match(g.filter,/asetnsamples=n=240:p=0/);
  assert.equal(editGraph(keep.slice(0,5),1).filter.includes('trim='),true,'few sections keep the trim path');
  assert.throws(()=>validKeep(Array.from({length:MAX_SECTIONS+1},(_,i)=>[i,i+0.5]),MAX_SECTIONS+2));
});

test('a leading cut shifts later frames by its length',()=>{
  const g=selectGraph(Array.from({length:30},(_,i)=>[5+i,5.5+i]),0);
  assert.match(g.filter,/gte\(T\\,5\)\*5[^.\d]/);
});
