const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAutoCopy}=require('../autocopy.cjs');

const URL1='https://vidcapture.stream/v/'+'a'.repeat(48),URL2='https://vidcapture.stream/v/'+'b'.repeat(48);
const done=url=>({share:{id:'s',url},job:{kind:'publish',running:false}});
const later=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

// A small stand-in for the recorder state and the system clipboard.
function harness({card,cardWait=1000,failWrite=false}={}){
 let state={},clip='Before copy';const calls={card:0,write:[]};
 const set=patch=>{state={...state,...patch};onState(state);};
 const onState=createAutoCopy({getState:()=>state,set,cardWait,
  card:()=>{calls.card++;return card?card():Promise.reject(new Error('no card'));},
  write:data=>{calls.write.push(data);if(!failWrite)clip=data.text;},
  readText:()=>clip});
 const start=url=>{state={...state,...done(url)};return onState(state);};
 return {start,set,get state(){return state;},get clip(){return clip;},set clip(v){clip=v;},calls};
}

test('a slow card does not report "copied" before the clipboard holds the link',async()=>{
 const card=later(),h=harness({card:()=>card.promise});
 const run=h.start(URL1);
 assert.equal(h.state.share.copying,true);assert.notEqual(h.state.share.copied,true,'not copied while the card is loading');
 assert.equal(h.clip,'Before copy');
 card.resolve({text:URL1,html:'<a>card</a>'});await run;
 assert.equal(h.clip,URL1);assert.equal(h.state.share.copied,true);assert.equal(h.state.share.copying,false);
 assert.equal(h.calls.write[0].html,'<a>card</a>','rich card used when it arrives in time');
});

test('a card that never arrives falls back to the plain link after the wait',async()=>{
 const h=harness({card:()=>new Promise(()=>{}),cardWait:30});
 const started=Date.now();await h.start(URL1);
 assert.ok(Date.now()-started<1000);assert.equal(h.clip,URL1);assert.equal(h.state.share.copied,true);
 assert.equal(h.calls.write[0].html,undefined,'plain link written');
});

test('a card error writes the plain link at once',async()=>{
 const h=harness({card:()=>Promise.reject(new Error('no thumbnail'))});
 await h.start(URL1);assert.equal(h.clip,URL1);assert.equal(h.state.share.copied,true);
});

test('a clipboard write that does not stick is reported as failed, not copied',async()=>{
 const h=harness({failWrite:true});
 await h.start(URL1);
 assert.equal(h.state.share.copyFailed,true);assert.notEqual(h.state.share.copied,true);assert.equal(h.state.share.copying,false);
});

test('a late copy for an older share neither writes nor marks the newer share',async()=>{
 const card=later(),h=harness({card:()=>card.promise});
 const run=h.start(URL1);
 // A newer share replaces the first while its card is still loading, and the person copies something else.
 h.set({share:{id:'t',url:URL2},job:{kind:'publish',running:true}});h.clip='Newer clipboard text';
 card.resolve({text:URL1,html:'old'});await run;
 assert.equal(h.clip,'Newer clipboard text','newer clipboard contents kept');
 assert.equal(h.state.share.url,URL2);assert.equal(h.state.share.copied,undefined);assert.equal(h.state.share.copyFailed,undefined);
});

test('repeated state events start one copy only',async()=>{
 const card=later(),h=harness({card:()=>card.promise});
 const run=h.start(URL1);h.set({});h.set({});h.start(URL1);
 card.resolve(null);await run;
 assert.equal(h.calls.card,1);assert.equal(h.calls.write.length,1);
});

test('shares that are still running, failed, or already handled are left alone',async()=>{
 const h=harness();
 for(const state of [{share:{url:URL1},job:{kind:'publish',running:true}},{share:{url:URL1},job:{kind:'publish',running:false,error:'x'}},{share:{url:URL1,copied:true},job:{kind:'publish'}},{share:{url:URL1,copyFailed:true},job:{kind:'publish'}},{share:{url:URL1},job:{kind:'export'}}]){
  h.set(state);
 }
 await new Promise(r=>setTimeout(r,10));assert.equal(h.calls.write.length,0);
});
