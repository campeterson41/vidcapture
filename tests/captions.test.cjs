const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildVTT,remapWords,wrap,stamp}=require('../captions.cjs');

const words=(list)=>list.map(([text,start,end])=>({text,start,end}));
const cues=vtt=>vtt.trim().split('\n\n').slice(1).map(block=>{const [n,time,...lines]=block.split('\n');const [a,b]=time.split(' --> ');return {n:Number(n),a,b,lines};});

test('stamps are WebVTT hours, minutes, seconds and milliseconds',()=>{
  assert.equal(stamp(0),'00:00:00.000');
  assert.equal(stamp(61.2345),'00:01:01.235');
  assert.equal(stamp(3725.5),'01:02:05.500');
});

test('the whole recording keeps original word times',()=>{
  const vtt=buildVTT(words([['Hello',0.5,0.9],['there.',1.0,1.4]]),null,10);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  const c=cues(vtt);assert.equal(c.length,1);
  assert.equal(c[0].a,'00:00:00.500');assert.equal(c[0].b,'00:00:01.400');
  assert.deepEqual(c[0].lines,['Hello there.']);
});

test('words move onto the shared timeline and words in removed ranges are dropped',()=>{
  // Kept 0-2 and 5-8: the 3 seconds from 2 to 5 are gone in the shared file.
  const w=words([['one',0.2,0.5],['cut',2.5,2.9],['also',4.0,4.4],['two',5.5,5.9],['three',7.0,7.4]]);
  const out=remapWords(w,[[0,2],[5,8]]);
  assert.deepEqual(out.map(x=>x.text),['one','two','three']);
  assert.ok(Math.abs(out[1].start-2.5)<1e-9&&Math.abs(out[1].end-2.9)<1e-9);
  assert.ok(Math.abs(out[2].start-4.0)<1e-9);
});

test('a word straddling a cut follows its midpoint and is clamped into its section',()=>{
  const out=remapWords(words([['edge',1.8,2.1],['late',1.95,2.6]]),[[0,2],[3,5]]);
  assert.deepEqual(out.map(x=>x.text),['edge']);
  assert.ok(out[0].end<=2+1e-9);
});

test('a leading trim shifts everything back',()=>{
  const c=cues(buildVTT(words([['Skipped',0.1,0.5],['Kept.',10.2,10.6]]),[[10,20]],20));
  assert.equal(c.length,1);assert.deepEqual(c[0].lines,['Kept.']);assert.equal(c[0].a,'00:00:00.200');
});

test('cues break at sentence ends, stay within two lines of 42 characters and 6 seconds',()=>{
  const text='This is a fairly long sentence that keeps going on and on without stopping for a very long while indeed and then some more words follow. Short one. Another sentence here.';
  const list=text.split(' ').map((t,i)=>[t,i*0.4,i*0.4+0.3]);
  const c=cues(buildVTT(words(list),null,100));
  for(const cue of c){
    assert.ok(cue.lines.length<=2);
    for(const line of cue.lines)assert.ok(line.length<=42,line);
  }
  const toSec=s=>{const [h,m,r]=s.split(':');return h*3600+m*60+Number(r);};
  for(const cue of c)assert.ok(toSec(cue.b)-toSec(cue.a)<=6.0001);
  // Sentence ends close a cue.
  const ends=c.map(cue=>cue.lines.join(' '));
  assert.ok(ends.some(t=>t.endsWith('follow.')));
  assert.ok(ends.includes('Short one.'));
  assert.ok(ends.at(-1).endsWith('Another sentence here.'));
  // Numbered in order, with no overlaps.
  c.forEach((cue,i)=>{assert.equal(cue.n,i+1);if(i)assert.ok(toSec(cue.a)>=toSec(c[i-1].b));});
});

test('a long pause starts a new cue',()=>{
  const c=cues(buildVTT(words([['before',0,0.4],['after',5,5.4]]),null,10));
  assert.equal(c.length,2);
});

test('short cues are lengthened to be readable without overlapping the next',()=>{
  const c=cues(buildVTT(words([['Hi.',0,0.1],['Yes.',0.5,0.6]]),null,10));
  assert.equal(c[0].b,'00:00:00.500');assert.equal(c[1].b,'00:00:01.300');
});

test('markup characters are escaped and empty input gives no captions',()=>{
  assert.match(buildVTT(words([['<b>&',0,1]]),null,5),/&lt;b&gt;&amp;/);
  assert.equal(buildVTT([],null,5),null);
  assert.equal(buildVTT(words([['gone',3,4]]),[[0,2]],5),null);
});

test('wrap balances two lines and refuses text that cannot fit',()=>{
  assert.deepEqual(wrap(['short']),['short']);
  const two=wrap('one two three four five six seven eight nine ten eleven'.split(' '));
  assert.equal(two.length,2);assert.ok(two.every(l=>l.length<=42));
  assert.equal(wrap(Array(40).fill('word')),null);
});
