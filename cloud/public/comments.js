'use strict';
// Comments on the watch page: post at the current moment, reply, remove your own,
// markers on the seek bar, and ?t=SECONDS links that open at a moment.
(()=>{
 const root=document.getElementById('comments');if(!root)return;
 const $=id=>document.getElementById(id),video=$('watch-video'),share=root.dataset.share,duration=Number(root.dataset.duration)||0,isOwner=root.hasAttribute('data-owner');
 const form=$('comment-form'),body=$('comment-body'),nameInput=$('comment-name'),atBox=$('comment-at'),status=$('comment-status'),list=$('comment-list');
 const store={get(k,f){try{return JSON.parse(localStorage.getItem(k))??f;}catch{return f;}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch{}}};
 let comments=[],canModerate=false,enabled=true,pinned=0;
 const clock=value=>{const t=Math.max(0,Math.floor(value||0)),h=Math.floor(t/3600),m=Math.floor(t%3600/60),s=String(t%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${s}`:`${m}:${s}`;};
 const rtf=new Intl.RelativeTimeFormat('en',{numeric:'auto'});
 function ago(seconds){const d=seconds-Date.now()/1000;for(const [unit,size] of [['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60]])if(Math.abs(d)>=size)return rtf.format(Math.round(d/size),unit);return 'just now';}
 function el(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
 async function call(path,options={}){
  const response=await fetch('/api/comments/'+share+path,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Something went wrong. Try again.');return data;
 }
 function seekTo(seconds){if(!video)return;video.currentTime=Math.min(seconds,duration||seconds);document.getElementById('video-player')?.scrollIntoView({block:'nearest',behavior:'smooth'});video.play().catch(()=>{});}

 // Seek bar markers, one per timestamped comment. Clicks go through to the seek bar.
 function drawMarkers(){
  const wrap=$('seek-wrap');if(!wrap||!duration)return;wrap.querySelectorAll('.comment-marker').forEach(m=>m.remove());
  for(const c of comments)if(c.at!==null&&!c.parentId){const m=el('span',undefined,'comment-marker');m.style.left=`${Math.min(100,c.at/duration*100)}%`;m.title=`${c.name} at ${clock(c.at)}`;m.setAttribute('aria-hidden','true');wrap.append(m);}
 }

 function removeButton(c){
  const keys=store.get('vidcapture-comment-keys',{});
  if(!(c.mine||keys[c.id]||canModerate))return null;
  const b=el('button','Delete','text-button comment-action');let armed=false,timer;
  b.onclick=async()=>{
   if(!armed){armed=true;b.textContent='Confirm delete';timer=setTimeout(()=>{armed=false;b.textContent='Delete';},4000);return;}
   clearTimeout(timer);b.disabled=true;
   try{await call('/'+c.id,{method:'DELETE',headers:keys[c.id]?{'X-Comment-Key':keys[c.id]}:{}});comments=comments.filter(x=>x.id!==c.id&&x.parentId!==c.id);delete keys[c.id];store.set('vidcapture-comment-keys',keys);draw();}
   catch(error){b.disabled=false;b.textContent='Delete';armed=false;setStatus(error.message,true);}
  };
  return b;
 }

 function item(c,replies){
  const li=el('li',undefined,'comment'+(c.parentId?' reply':''));li.id='comment-'+c.id;
  const head=el('div',undefined,'comment-head');head.append(el('strong',c.name));
  if(c.byOwner)head.append(el('span','Creator','comment-owner'));
  head.append(el('time',ago(c.createdAt),'subtle'));head.lastChild.dateTime=new Date(c.createdAt*1000).toISOString();head.lastChild.title=new Date(c.createdAt*1000).toLocaleString();
  const text=el('p',undefined,'comment-body');
  if(c.at!==null){const t=el('button',clock(c.at),'comment-time');t.type='button';t.setAttribute('aria-label','Play from '+clock(c.at));t.onclick=()=>seekTo(c.at);text.append(t,' ');}
  text.append(c.body);
  const actions=el('div',undefined,'comment-actions');
  if(!c.parentId&&enabled){const r=el('button','Reply','text-button comment-action');r.type='button';r.onclick=()=>openReply(li,c);actions.append(r);}
  const del=removeButton(c);if(del){del.type='button';actions.append(del);}
  li.append(head,text);if(actions.childElementCount)li.append(actions);
  if(replies?.length){const ol=el('ol',undefined,'comment-replies');for(const r of replies)ol.append(item(r));li.append(ol);}
  return li;
 }

 function openReply(li,parent){
  if(li.querySelector('.reply-form')){li.querySelector('.reply-form textarea').focus();return;}
  const f=el('form',undefined,'reply-form comment-form');f.noValidate=true;
  const ta=el('textarea');ta.rows=2;ta.maxLength=1000;ta.placeholder='Reply to '+parent.name;ta.setAttribute('aria-label','Reply to '+parent.name);
  const row=el('div',undefined,'comment-row'),name=el('input');name.maxLength=60;name.placeholder='Your name';name.setAttribute('aria-label','Your name');name.autocomplete='name';name.value=store.get('vidcapture-comment-name','');name.hidden=!!name.value;
  const cancel=el('button','Cancel','quiet');cancel.type='button';cancel.onclick=()=>f.remove();
  const post=el('button','Reply','button');post.type='submit';
  const msg=el('p',undefined,'login-status');msg.setAttribute('role','status');
  row.append(name,cancel,post);f.append(ta,row,msg);
  ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))f.requestSubmit();});
  f.onsubmit=async e=>{e.preventDefault();if(!ta.value.trim()){ta.focus();return;}if(!name.value.trim()){name.hidden=false;name.focus();msg.textContent='Add your name.';return;}
   post.disabled=true;try{const data=await call('',{method:'POST',body:JSON.stringify({body:ta.value,name:name.value,parentId:parent.id})});remember(data,name.value);comments.push(data.comment);draw();}
   catch(error){post.disabled=false;msg.textContent=error.message;msg.classList.add('error');}};
  const replies=li.querySelector('.comment-replies');li.insertBefore(f,replies||null);ta.focus();
 }

 function remember(data,name){const keys=store.get('vidcapture-comment-keys',{});keys[data.comment.id]=data.key;store.set('vidcapture-comment-keys',keys);store.set('vidcapture-comment-name',name.trim());}

 function draw(){
  const top=comments.filter(c=>!c.parentId).sort((a,b)=>(a.at??Infinity)-(b.at??Infinity)||a.createdAt-b.createdAt);
  list.replaceChildren(...top.map(c=>item(c,comments.filter(r=>r.parentId===c.id).sort((a,b)=>a.createdAt-b.createdAt))));
  $('comment-count').textContent=comments.length?String(comments.length):'';
  $('comments-off').hidden=enabled;form.hidden=!enabled;drawMarkers();
 }
 function setStatus(text,error=false){status.textContent=text;status.classList.toggle('error',error);}

 // The moment is taken when you start writing, and the video pauses so it stays put.
 function pin(){pinned=video?video.currentTime:0;$('comment-at-time').textContent=clock(pinned);atBox.checked=pinned>=0.5;}
 body.addEventListener('focus',()=>{if($('comment-extra').hidden){pin();$('comment-extra').hidden=false;}});
 body.addEventListener('input',()=>{if(video&&!video.paused)video.pause();},{once:false});
 body.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))form.requestSubmit();});
 nameInput.value=store.get('vidcapture-comment-name','');
 form.onsubmit=async e=>{
  e.preventDefault();setStatus('');
  if(!body.value.trim()){body.focus();setStatus('Write a comment first.',true);return;}
  if(!nameInput.value.trim()){nameInput.focus();setStatus('Add your name.',true);return;}
  const button=form.querySelector('button[type=submit]');button.disabled=true;
  try{
   const data=await call('',{method:'POST',body:JSON.stringify({body:body.value,name:nameInput.value,at:atBox.checked&&duration?pinned:null})});
   remember(data,nameInput.value);comments.push(data.comment);body.value='';$('comment-extra').hidden=true;draw();
   document.getElementById('comment-'+data.comment.id)?.scrollIntoView({block:'nearest'});
  }catch(error){setStatus(error.message,true);}finally{button.disabled=false;}
 };

 const toggle=$('comments-toggle');
 if(toggle)toggle.onchange=async()=>{toggle.disabled=true;try{enabled=(await call('',{method:'PATCH',body:JSON.stringify({enabled:toggle.checked})})).enabled;draw();}catch(error){toggle.checked=!toggle.checked;setStatus(error.message,true);}finally{toggle.disabled=false;}};

 async function load(){
  try{const data=await call('');comments=data.comments;canModerate=data.canModerate||isOwner;enabled=data.enabled;draw();}
  catch(error){list.replaceChildren(el('li',error.message,'subtle'));}
 }
 if(video)video.addEventListener('loadedmetadata',drawMarkers);
 // Open at a moment: /v/ID?t=83
 const t=Number(new URLSearchParams(location.search).get('t'));
 if(video&&t>0){const go=()=>{video.currentTime=Math.min(t,video.duration||t);};if(video.readyState>=1)go();else video.addEventListener('loadedmetadata',go,{once:true});}
 load();
})();

// Reactions: count per emoji, sent at the current moment. During playback, reactions
// rise briefly over the video at the moment they were left.
(()=>{
 const box=document.getElementById('reactions'),video=document.getElementById('watch-video');if(!box||!video)return;
 const share=box.dataset.share,stage=document.querySelector('.video-stage');let moments=[],last=0;
 const names={'👍':'Thumbs up','❤️':'Love','😂':'Funny','🎉':'Celebrate','👀':'Watching','🤔':'Thinking'};
 function float(emoji){if(!stage||matchMedia('(prefers-reduced-motion: reduce)').matches)return;const e=document.createElement('span');e.className='reaction-float';e.textContent=emoji;e.setAttribute('aria-hidden','true');e.style.left=`${8+Math.random()*10}%`;stage.append(e);setTimeout(()=>e.remove(),2200);}
 function draw(data){
  box.replaceChildren(...data.emoji.map(emoji=>{const b=document.createElement('button');b.type='button';b.className='reaction';b.dataset.emoji=emoji;const n=data.counts[emoji]||0;b.setAttribute('aria-label',`${names[emoji]||emoji}, ${n}`);b.title=`React with ${names[emoji]||emoji} at this moment`;
   const glyph=document.createElement('span');glyph.textContent=emoji;glyph.setAttribute('aria-hidden','true');const count=document.createElement('span');count.className='reaction-count';count.textContent=n?String(n):'';b.append(glyph,count);
   b.onclick=async()=>{b.disabled=true;try{const r=await fetch('/api/reactions/'+share,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({emoji,at:video.currentTime||0})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Could not send that reaction.');data.counts[emoji]=(data.counts[emoji]||0)+1;moments.push({emoji,at:video.currentTime});float(emoji);draw(data);}catch(error){const t=document.getElementById('toast');if(t){t.textContent=error.message;t.hidden=false;setTimeout(()=>t.hidden=true,3500);}b.disabled=false;}};
   return b;}));
 }
 video.addEventListener('timeupdate',()=>{const t=video.currentTime;if(!video.paused&&t>last&&t-last<1.5)for(const m of moments)if(m.at>last&&m.at<=t)float(m.emoji);last=t;});
 fetch('/api/reactions/'+share,{credentials:'same-origin'}).then(r=>r.ok?r.json():Promise.reject()).then(d=>{moments=d.moments;draw(d);}).catch(()=>{box.hidden=true;});
})();

// Owner: make the current frame the video's preview image and link card.
(()=>{
 const b=document.getElementById('use-frame'),video=document.getElementById('watch-video');if(!b||!video)return;
 b.onclick=async()=>{
  const label=b.textContent;b.disabled=true;b.textContent='Saving preview…';
  try{
   const {makePreview}=await import('/preview.js'),p=await makePreview('/media/'+b.dataset.share,{start:video.currentTime||0});
   for(const [kind,type,body] of [['thumbnail','image/gif',p.gif],['poster','image/jpeg',p.poster]]){const r=await fetch(`/api/admin/videos/${b.dataset.video}/${kind}`,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':type},body});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'The preview could not be saved.');}
   video.poster='/thumbnail/'+b.dataset.share+'.jpg?'+Date.now();b.textContent='Preview updated';setTimeout(()=>{b.textContent=label;b.disabled=false;},2500);
  }catch(error){b.textContent=label;b.disabled=false;const t=document.getElementById('toast');if(t){t.textContent=error.message;t.hidden=false;setTimeout(()=>t.hidden=true,3500);}}
 };
})();
