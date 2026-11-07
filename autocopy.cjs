'use strict';
// Copies a finished share's link to the clipboard once.
// - "copied" is reported only after the clipboard really holds the link.
// - The rich card (GIF preview for email) is used when it arrives quickly; otherwise
//   the plain link is written so a finished share never waits on the network.
// - If a newer share (or none) has replaced this one by the time the copy is ready,
//   nothing is written and nothing is marked, so newer clipboard contents are kept.
// Share state: copying (in flight), copied (written and confirmed), copyFailed (use Copy link).
const CARD_WAIT_MS=1500;

function createAutoCopy({getState,set,card,write,readText,cardWait=CARD_WAIT_MS}){
 let inFlight=null;
 const current=url=>getState().share?.url===url;
 const mark=(url,fields)=>{if(current(url))set({share:{...getState().share,...fields}});};
 async function copy(url){
  let rich=null;
  try{rich=await Promise.race([card(),new Promise(resolve=>setTimeout(resolve,cardWait,null))]);}catch{rich=null;}
  if(!current(url))return false;
  if(rich?.text===url)write(rich);else write({text:url});
  if(readText()!==url)throw new Error('The link could not be copied.');
  return true;
 }
 return function onState(state){
  const share=state.share,job=state.job;
  if(!share?.url||share.copied||share.copyFailed||share.copying||inFlight===share.url)return;
  if(job?.kind!=='publish'||job.running||job.error)return;
  const url=share.url;inFlight=url;
  set({share:{...share,copying:true}});
  return copy(url).then(
   written=>{if(written)mark(url,{copying:false,copied:true});},
   ()=>mark(url,{copying:false,copyFailed:true})
  ).finally(()=>{if(inFlight===url)inFlight=null;});
 };
}

module.exports={createAutoCopy,CARD_WAIT_MS};
