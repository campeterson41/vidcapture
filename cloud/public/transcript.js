'use strict';
// Transcript under the player, read from the captions file. Click a line to play from there.
(()=>{
 const box=document.getElementById('transcript'),list=document.getElementById('transcript-list'),video=document.getElementById('watch-video');if(!box||!list||!video)return;
 const seconds=t=>{const p=t.trim().split(':').map(Number);return p.length===3?p[0]*3600+p[1]*60+p[2]:p[0]*60+p[1];};
 const clock=v=>{const t=Math.floor(v),h=Math.floor(t/3600),m=Math.floor(t%3600/60),s=String(t%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${s}`:`${m}:${s}`;};
 let cues=[],active=-1,loaded=false;
 async function load(){
  if(loaded)return;loaded=true;
  try{
   const text=await (await fetch(box.dataset.src,{credentials:'same-origin'})).text();
   for(const block of text.replace(/\r/g,'').split(/\n\n+/)){const lines=block.split('\n'),i=lines.findIndex(l=>l.includes('-->'));if(i<0)continue;const [a,b]=lines[i].split('-->');const words=lines.slice(i+1).join(' ').replace(/<[^>]*>/g,'').trim();if(words)cues.push({start:seconds(a),end:seconds(b.trim().split(/\s/)[0]),text:words});}
   list.replaceChildren(...cues.map(c=>{const li=document.createElement('li'),b=document.createElement('button');b.type='button';const t=document.createElement('span');t.className='transcript-time';t.textContent=clock(c.start);b.append(t,document.createTextNode(c.text));b.onclick=()=>{video.currentTime=c.start;video.play().catch(()=>{});};li.append(b);return li;}));
   if(!cues.length)list.replaceChildren(Object.assign(document.createElement('li'),{textContent:'No transcript for this video.',className:'subtle'}));
   update();
  }catch{list.replaceChildren(Object.assign(document.createElement('li'),{textContent:'The transcript could not load.',className:'subtle'}));loaded=false;}
 }
 function update(){
  const t=video.currentTime,i=cues.findIndex(c=>t>=c.start&&t<c.end);if(i===active)return;
  list.children[active]?.classList.remove('current');active=i;const row=list.children[i];if(!row)return;row.classList.add('current');
  if(box.open&&!list.matches(':hover')){const top=row.offsetTop-list.offsetTop;if(top<list.scrollTop||top>list.scrollTop+list.clientHeight-40)list.scrollTo({top:top-list.clientHeight/3,behavior:'smooth'});}
 }
 box.addEventListener('toggle',()=>{if(box.open)load();});
 video.addEventListener('timeupdate',update);
})();
