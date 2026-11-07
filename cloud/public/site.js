'use strict';
const $=id=>document.getElementById(id);let toastTimer;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{...(options.body&&typeof options.body==='string'?{'Content-Type':'application/json'}:{}),...options.headers}});const data=response.status===204?{}:await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'Request failed.'),{status:response.status});return data;}
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
async function copy(url){try{await navigator.clipboard.writeText(url);toast('Link copied. Anyone with the link can watch.');}catch{prompt('Copy this video link:',url);}}
const clock=n=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
const formatDate=n=>new Date(n*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
async function uploadPreview(source,id,signal){
 const {makePreview}=await import('/preview.js'),preview=await makePreview(source,{signal});
 await api(`/api/admin/videos/${id}/thumbnail`,{method:'PUT',headers:{'Content-Type':'image/gif'},body:preview.gif,signal});
 await api(`/api/admin/videos/${id}/poster`,{method:'PUT',headers:{'Content-Type':'image/jpeg'},body:preview.poster,signal});
}
async function copyCard(button,video,prepare){
 const label=button.textContent;button.disabled=true;button.textContent=video.thumbnailReady?'Copying…':'Creating preview…';
 try{await window.copyVideoCard(async()=>{if(!video.thumbnailReady&&prepare){await prepare();video.thumbnailReady=true;}return video;});toast('Video card copied. Paste it into your email.');}
 catch(error){toast(error.message.includes('Rich copying is unavailable')?error.message:video.thumbnailReady?'Card ready. Your browser could not copy it. Try again or use Copy link.':error.message);}finally{button.disabled=false;button.textContent=label;}
}
if($('copy-card'))$('copy-card').onclick=()=>copyCard($('copy-card'),{title:document.querySelector('h1').textContent,url:location.href.split(/[?#]/)[0],thumbnailReady:true});
if($('copy-link'))$('copy-link').onclick=()=>copy(location.href.split('#')[0]);
if($('watch-video')){
 const video=$('watch-video');
 video.addEventListener('play',()=>{const key='view:'+video.dataset.share;try{if(sessionStorage.getItem(key))return;sessionStorage.setItem(key,'1');}catch{}fetch('/api/view/'+video.dataset.share,{method:'POST'}).catch(()=>{});},{once:true});
}
if(location.pathname==='/connect'){
 const code=location.hash.slice(1);history.replaceState(null,'','/connect');
 api('/api/session',{method:'POST',body:JSON.stringify({code})}).then(()=>location.replace('/library')).catch(error=>$('connect-status').textContent=error.message);
}
if($('login-form')){
 const form=$('login-form'),input=$('login-link'),status=$('login-status'),submit=$('login-submit');
 form.onsubmit=async event=>{
  event.preventDefault();
  const code=(input.value.match(/(?:#|^\s*)([a-f0-9]{64})\s*$/i)||[])[1];
  status.classList.remove('error');
  if(!code){status.textContent='Paste the full link that VidCapture opened. It ends with a long code after the # sign.';status.classList.add('error');input.focus();return;}
  submit.disabled=true;status.textContent='Signing you in…';
  try{await api('/api/session',{method:'POST',body:JSON.stringify({code:code.toLowerCase()})});status.textContent='Signed in. Opening your library…';location.replace('/library');}
  catch(error){status.textContent=error.status===401?'That link has expired or was already used. Click Video library in VidCapture to get a new one.':error.message;status.classList.add('error');submit.disabled=false;}
 };
}
let videos=[];
function drawLibrary(){
 const grid=$('video-grid');grid.replaceChildren();const query=$('search').value.toLowerCase();const matches=videos.filter(v=>v.title.toLowerCase().includes(query));$('video-count').textContent=`${videos.length} ${videos.length===1?'video':'videos'}`;
 for(const v of matches){
  const card=el('article',undefined,'video-card');
  if(v.status==='ready'){
   const link=el('a',undefined,'thumbnail');link.href=new URL(v.url).pathname;link.setAttribute('aria-label','Watch '+v.title);const preview=el(v.thumbnailReady?'img':'video');if(v.thumbnailReady){preview.src=new URL(v.posterUrl).pathname;preview.alt='';preview.loading='lazy';}else{preview.src=new URL(v.url).pathname.replace('/v/','/media/');preview.addEventListener('loadedmetadata',()=>{preview.currentTime=Math.min(.1,preview.duration/2);},{once:true});preview.preload='metadata';preview.muted=true;preview.playsInline=true;}link.append(preview,el('span',clock(v.duration),'duration'));card.append(link);
  }else card.append(el('div','Upload unfinished. Resume from the same file in VidCapture.','uploading-card'));
  card.append(el('h2',v.title),el('div',`${formatDate(v.createdAt)} · ${v.views} ${v.views===1?'play':'plays'}`,'card-meta'));
  const actions=el('div',undefined,'card-actions');
  if(v.url){const cardButton=el('button','Copy video card');cardButton.onclick=()=>copyCard(cardButton,v,()=>uploadPreview(new URL(v.url).pathname.replace('/v/','/media/'),v.id));actions.append(cardButton);const button=el('button','Copy link');button.onclick=()=>copy(v.url);actions.append(button);}
  const rename=el('button','Rename');rename.onclick=async()=>{const title=prompt('Video title',v.title);if(!title?.trim()||title===v.title)return;try{await api('/api/admin/videos/'+v.id,{method:'PATCH',body:JSON.stringify({title:title.trim()})});await loadLibrary();}catch(e){toast(e.message);}};
  const remove=el('button','Remove','remove');remove.onclick=async()=>{if(!confirm(`Remove “${v.title}” from VidCapture? Its share link will stop working. Your local recording stays on your computer.`))return;remove.disabled=true;try{await api('/api/admin/videos/'+v.id,{method:'DELETE'});await loadLibrary();toast('Video removed. Its link no longer works.');}catch(e){remove.disabled=false;toast(e.message);}};
  actions.append(rename,remove);card.append(actions);grid.append(card);
 }
 if(!matches.length&&videos.length)grid.append(el('p','No videos match your search.','subtle'));
}
async function loadLibrary(){
 try{
  videos=(await api('/api/admin/videos')).videos;$('logout').hidden=false;$('upload-label').hidden=false;$('library-tools').hidden=!videos.length;
  $('library-message').hidden=!!videos.length;
  if(!videos.length){$('library-message').replaceChildren(el('h2','Your next video starts here.'),el('p','Share a recording from VidCapture, or upload an MP4 here. Only videos you choose to publish appear in this library.'));}
  drawLibrary();
 }catch(error){
  $('library-message').hidden=false;$('library-message').replaceChildren(el('h2',error.status===401?'Your library is private.':'Unable to load your library.'),el('p',error.status===401?'Your session has ended. Sign in again to see your videos.':error.message));if(error.status===401){const link=el('a','Sign in','button');link.href='/login';$('library-message').append(link);}
 }
}
if($('video-grid')){
 loadLibrary();$('search').oninput=drawLibrary;
 $('logout').onclick=async()=>{try{await api('/api/admin/logout',{method:'POST'});location.reload();}catch(e){toast(e.message);}};
 let uploadController=null;
 $('cancel-upload').onclick=()=>uploadController?.abort();
 $('upload').onchange=async()=>{
  const file=$('upload').files[0];if(!file)return;
  if(!/\.mp4$/i.test(file.name)||file.size>20*1024**3){toast('Choose an MP4 up to 20 GB.');return;}
  uploadController=new AbortController();const signal=uploadController.signal;let uploadId=null,cardWarning=false;
  $('upload-label').hidden=true;$('upload-progress').hidden=false;$('upload-status').textContent='Checking video…';
  try{
   const metadata=await new Promise((resolve,reject)=>{const video=document.createElement('video'),url=URL.createObjectURL(file);const done=()=>{clearTimeout(timer);URL.revokeObjectURL(url);video.removeAttribute('src');video.load();};const timer=setTimeout(()=>{done();reject(new Error('Could not read this video.'));},15000);video.onloadedmetadata=()=>{const data={duration:video.duration,width:video.videoWidth,height:video.videoHeight};done();resolve(data);};video.onerror=()=>{done();reject(new Error('This video format is not supported. Export an MP4 from VidCapture.'));};video.src=url;});
   const fingerprint=`vc-upload:${file.name}:${file.size}:${file.lastModified}`;let id;try{id=localStorage.getItem(fingerprint);}catch{}id||=crypto.randomUUID();
   const title=file.name.replace(/\.mp4$/i,'').slice(0,160);
   const initiate=()=>api('/api/admin/uploads',{method:'POST',body:JSON.stringify({id,title,size:file.size,...metadata}),signal});let upload;try{upload=await initiate();}catch(error){if(error.status!==410)throw error;id=crypto.randomUUID();upload=await initiate();}uploadId=id;try{localStorage.setItem(fingerprint,id);}catch{}
   if(upload.status!=='ready'){
    const done=new Set(upload.parts.map(p=>p.partNumber));
    for(let offset=0,n=1;offset<file.size;offset+=upload.chunkSize,n++){
     if(!done.has(n)){
      let last;for(let attempt=0;attempt<3;attempt++){try{await api(`/api/admin/videos/${id}/parts/${n}`,{method:'PUT',body:file.slice(offset,offset+upload.chunkSize),signal});last=null;break;}catch(error){last=error;if(signal.aborted||error.status&&error.status<500)throw error;await new Promise(r=>setTimeout(r,500*2**attempt));}}
      if(last)throw last;
     }
     const percent=Math.round(Math.min(file.size,offset+upload.chunkSize)/file.size*100);$('upload-status').textContent=`Uploading ${percent}%`;$('upload-progress').querySelector('progress').value=percent;
    }
    if(!upload.thumbnailReady){$('upload-status').textContent='Creating animated video card…';try{await uploadPreview(file,id,signal);}catch(error){if(signal.aborted)throw error;cardWarning=true;}}
    $('upload-status').textContent='Finishing upload…';await api(`/api/admin/videos/${id}/complete`,{method:'POST',signal});
   }
   if(upload.status==='ready'&&!upload.thumbnailReady){$('upload-status').textContent='Creating animated video card…';try{await uploadPreview(file,id,signal);}catch(error){if(signal.aborted)throw error;cardWarning=true;}}
   try{localStorage.removeItem(fingerprint);}catch{}toast(cardWarning?'Video ready. Its preview could not be created. You can still copy the link.':'Video ready. Copy its video card to share.');
  }catch(error){toast(signal.aborted?'Upload paused. Choose the same file to resume.':error.message);}
  finally{uploadController=null;$('upload-progress').hidden=true;$('upload').value='';$('upload-label').hidden=false;await loadLibrary();}
 };
}
