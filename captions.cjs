'use strict';
// WebVTT captions for a shared video. Transcript words are timed against the
// original recording; the shared file keeps only the edit plan's sections,
// played back to back. Each word is moved onto that shorter timeline, words
// inside removed sections are dropped, and the rest are grouped into short cues.
const LINE=42,MAX_CUE=6,GAP=1.2,MIN_CUE=0.8,MAX_BYTES=1024*1024;

// Kept sections with their start on the shared timeline.
function timeline(keep){
  const out=[];let at=0;
  for(const [a,b] of keep){if(!(b>a))continue;out.push({a,b,at});at+=b-a;}
  return out;
}

// Words on the shared timeline. A word belongs to the section holding its
// midpoint; a word whose midpoint was cut is dropped even if it overlaps a
// kept section a little.
function remapWords(words,keep){
  const sections=timeline(keep),out=[];let i=0;
  for(const w of Array.isArray(words)?words:[]){
    if(!w||typeof w.text!=='string'||!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.end<w.start)continue;
    const text=w.text.trim();if(!text)continue;
    const mid=(w.start+w.end)/2;
    while(i<sections.length&&sections[i].b<=mid)i++;
    // Words are in time order; search from the start again only if one is not.
    let s=i<sections.length&&sections[i].a<=mid?sections[i]:sections.find(x=>x.a<=mid&&mid<x.b);
    if(!s)continue;
    const start=s.at+Math.max(0,w.start-s.a),end=s.at+Math.min(s.b,w.end)-s.a;
    out.push({text,start,end:Math.max(start,end),section:s});
  }
  return out;
}

// Splits a cue's text over at most two lines of LINE characters, as evenly as
// the words allow. Returns null when it does not fit.
function wrap(words){
  const text=words.join(' ');
  if(text.length<=LINE)return [text];
  let best=null;
  for(let k=1;k<words.length;k++){
    const a=words.slice(0,k).join(' '),b=words.slice(k).join(' ');
    if(a.length>LINE||b.length>LINE)continue;
    const score=Math.abs(a.length-b.length);
    if(!best||score<best.score)best={score,lines:[a,b]};
  }
  return best?best.lines:null;
}

const sentenceEnd=t=>/[.?!…]["')\]]*$/.test(t);
const clauseEnd=t=>/[,;:]["')\]]*$/.test(t);

function buildCues(words){
  const cues=[];let cur=[];
  const flush=()=>{if(cur.length)cues.push(cur);cur=[];};
  for(let i=0;i<words.length;i++){
    const w=words[i];
    if(cur.length){
      const first=cur[0],last=cur[cur.length-1];
      const tooLong=w.end-first.start>MAX_CUE;
      const pause=w.start-last.end>GAP;
      const fits=!!wrap([...cur,w].map(x=>x.text));
      if(tooLong||pause||!fits)flush();
    }
    cur.push(w);
    // A sentence end closes the cue. A clause end closes it when the cue is
    // already most of a line, so cues do not stop after a word or two.
    const len=cur.map(x=>x.text).join(' ').length;
    if(sentenceEnd(w.text)||(clauseEnd(w.text)&&len>=LINE*0.8))flush();
  }
  flush();
  return cues.map(ws=>({start:ws[0].start,end:ws[ws.length-1].end,lines:wrap(ws.map(x=>x.text))||[ws.map(x=>x.text).join(' ')]}));
}

// Short cues stay up long enough to read, without running into the next one.
function settle(cues){
  for(let i=0;i<cues.length;i++){
    const c=cues[i],next=cues[i+1];
    const limit=next?next.start:Infinity;
    if(c.end-c.start<MIN_CUE)c.end=Math.min(c.start+MIN_CUE,limit);
    if(c.end>limit)c.end=limit;
    if(c.end<=c.start)c.end=c.start+0.001;
  }
  return cues;
}

function stamp(seconds){
  const ms=Math.max(0,Math.round(seconds*1000));
  const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60,r=ms%1000;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(r).padStart(3,'0')}`;
}

const escape=t=>t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// words: transcript words on the original recording. keep: the edit plan's
// kept sections ([[start,end],...]); null or empty means the whole recording.
// Returns the WebVTT text, or null when there is nothing to caption.
function buildVTT(words,keep,duration=Infinity){
  const plan=Array.isArray(keep)&&keep.length?keep:[[0,Number.isFinite(duration)?duration:Infinity]];
  const cues=settle(buildCues(remapWords(words,plan)));
  if(!cues.length)return null;
  const body=cues.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.lines.map(escape).join('\n')}`).join('\n\n');
  const vtt=`WEBVTT\n\n${body}\n`;
  if(Buffer.byteLength(vtt)>MAX_BYTES)throw new Error('Captions are larger than 1 MiB.');
  return vtt;
}

module.exports={buildVTT,remapWords,buildCues,wrap,stamp,MAX_BYTES};
