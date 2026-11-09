'use strict';
const $=id=>document.getElementById(id);let toastTimer;
const appUpgradeRequired=()=>document.getElementById('app-update-notice')?.dataset.required==='true';
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{...(options.body&&typeof options.body==='string'?{'Content-Type':'application/json'}:{}),...options.headers}});const data=response.status===204?{}:await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'Request failed.'),{status:response.status});return data;}
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
async function copy(url,isPrivate=false){try{await navigator.clipboard.writeText(url);toast(isPrivate?'Private link copied. Only you can open it while signed in.':'Link copied. Paste it anywhere and it shows a preview card.');}catch{prompt('Copy this video link:',url);}}
const formatSize=n=>n>=1024**3?`${(n/1024**3).toFixed(1)} GB`:`${Math.max(0,Math.round(n/1024**2))} MB`;
const clock=n=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
const formatDate=n=>new Date(n*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
async function uploadPreview(source,id,posterOnly=false,signal){
 const {makePreview}=await import('/preview.js'),preview=await makePreview(source,{signal});
 if(!posterOnly)await api(`/api/admin/videos/${id}/thumbnail`,{method:'PUT',headers:{'Content-Type':'image/gif'},body:preview.gif,signal});
 await api(`/api/admin/videos/${id}/poster`,{method:'PUT',headers:{'Content-Type':'image/jpeg'},body:preview.poster,signal});
}
async function copyCard(button,video,prepare){
 const label=button.textContent;button.disabled=true;button.textContent=video.thumbnailReady?'Copying…':'Creating preview…';
 try{await window.copyVideoCard(async()=>{if(!video.thumbnailReady&&prepare){await prepare();video.thumbnailReady=true;}return video;});toast('Link copied. Email shows a playable preview; Slack and LinkedIn show a video card.');}
 catch(error){if(video.url)await copy(video.url);else toast(error.message);}finally{button.disabled=false;button.textContent=label;}
}
if($('copy-link'))$('copy-link').onclick=()=>$('copy-link').hasAttribute('data-card')?copyCard($('copy-link'),{title:document.querySelector('h1').textContent,url:location.href.split(/[?#]/)[0],thumbnailReady:true}):copy(location.href.split(/[?#]/)[0],$('copy-link').hasAttribute('data-private'));
if($('watch-video')){
 const video=$('watch-video');
 video.addEventListener('play',()=>{const key='view:'+video.dataset.share;try{if(sessionStorage.getItem(key))return;sessionStorage.setItem(key,'1');}catch{}fetch('/api/view/'+video.dataset.share,{method:'POST'}).catch(()=>{});},{once:true});
}
if(location.pathname==='/connect'){
 const code=location.hash.slice(1);history.replaceState(null,'','/connect');
 api('/api/session',{method:'POST',body:JSON.stringify({code})}).then(()=>location.replace('/library')).catch(error=>$('connect-status').textContent=error.message);
}
// Turnstile: loaded only on pages that carry a sitekey and a widget slot. Each slot names its action.
// Tokens are single-use, so every attempt resets its widget afterwards.
const human={ids:new Map(),ready:null};
function loadHuman(){
 if(human.ready)return human.ready;
 const key=document.querySelector('meta[name="turnstile-sitekey"]')?.content;
 if(!key||!document.querySelector('[data-turnstile]'))return human.ready=Promise.resolve();
 human.ready=new Promise((resolve,reject)=>{
  // The check runs out of sight. If it cannot finish on its own, the widget appears so the person can complete it.
  human.render=(slot,appearance)=>{const action=slot.dataset.turnstile,old=human.ids.get(action);if(old!==undefined)try{window.turnstile.remove(old);}catch{}
   if(appearance==='always')slot.classList.add('shown');
   human.ids.set(action,window.turnstile.render(slot,{sitekey:key,action,appearance,size:'flexible',
    'before-interactive-callback':()=>slot.classList.add('shown'),
    'error-callback':()=>{if(appearance!=='always')human.render(slot,'always');return true;},
    'unsupported-callback':()=>{slot.classList.add('shown');slot.textContent='This browser cannot run the security check. Try an up-to-date browser.';}}));};
  window.vcTurnstileReady=()=>{for(const slot of document.querySelectorAll('[data-turnstile]'))human.render(slot,'interaction-only');resolve();};
  const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=vcTurnstileReady';script.async=true;
  script.onerror=()=>{human.ready=null;reject(new Error('The security check could not load. Check your connection, then try again.'));};document.head.append(script);
 });
 return human.ready;
}
async function humanToken(action){
 await loadHuman();const id=human.ids.get(action),t=window.turnstile;if(id===undefined||!t)return undefined;
 const slot=document.querySelector(`[data-turnstile="${action}"]`);
 // A silent check usually finishes within a few seconds. A visible one waits for the person, so ask right away.
 for(let i=0;i<100;i++){const id=human.ids.get(action);if(t.isExpired(id))t.reset(id);const token=t.getResponse(id);if(token)return token;if(i>=6&&slot?.classList.contains('shown'))break;await new Promise(r=>setTimeout(r,150));}
 if(slot&&!slot.classList.contains('shown'))human.render(slot,'always');
 throw new Error('Complete the security check on this page, then try again.');
}
function resetHuman(action){const id=human.ids.get(action);if(id!==undefined)try{window.turnstile.reset(id);}catch{}}
if(document.querySelector('[data-turnstile]'))loadHuman().catch(()=>{});
function setStatus(node,text,error=false){node.textContent=text;node.classList.toggle('error',error);}
const validEmail=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
// Log in / Sign up tabs. onDone runs after a session starts.
function authTabs(onDone){
 const tabs={login:$('tab-login'),signup:$('tab-signup')},panels={login:$('panel-login'),signup:$('panel-signup')};
 const show=(name,focus)=>{for(const k in tabs){const on=k===name;tabs[k].setAttribute('aria-selected',on);tabs[k].tabIndex=on?0:-1;panels[k].hidden=!on;}if(focus)panels[name].querySelector('input').focus();};
 tabs.login.onclick=()=>show('login',true);tabs.signup.onclick=()=>show('signup',true);
 for(const t of Object.values(tabs))t.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){const next=t===tabs.login?'signup':'login';show(next);tabs[next].focus();}};
 show(location.hash==='#signup'||location.pathname==='/signup'?'signup':'login');
 const submit=(panel,path,emailId,passId,busy)=>panel.onsubmit=async e=>{
  e.preventDefault();const status=panel.querySelector('.login-status'),button=panel.querySelector('button[type=submit]');
  const email=$(emailId).value.trim(),password=$(passId).value;
  if(!validEmail(email)){setStatus(status,'Enter a valid email address.',true);$(emailId).focus();return;}
  if(path==='/api/signup'&&password.length<10){setStatus(status,'Use at least 10 characters for your password.',true);$(passId).focus();return;}
  if(!password){setStatus(status,'Enter your password.',true);$(passId).focus();return;}
  button.disabled=true;setStatus(status,busy);
  const signup=path==='/api/signup';
  try{const turnstile=signup?await humanToken('signup'):undefined;await api(path,{method:'POST',body:JSON.stringify({email,password,turnstile})});await onDone(signup);}
  catch(error){setStatus(status,error.message,true);button.disabled=false;}
  finally{if(signup)resetHuman('signup');}
 };
 submit(panels.login,'/api/login','login-email','login-password','Logging in…');
 submit(panels.signup,'/api/signup','signup-email','signup-password','Creating your account…');
 $('email-link').onclick=async()=>{
  const status=panels.login.querySelector('.login-status'),email=$('login-email').value.trim();
  if(!validEmail(email)){setStatus(status,'Enter your email above, then choose Email me a sign-in link.',true);$('login-email').focus();return;}
  $('email-link').disabled=true;setStatus(status,'Sending…');
  try{const turnstile=await humanToken('signin');await api('/api/signin',{method:'POST',body:JSON.stringify({email,turnstile})});setStatus(status,`If ${email} has an account, a sign-in link is on its way. It expires in 15 minutes.`);}
  catch(error){setStatus(status,error.message,true);}finally{$('email-link').disabled=false;resetHuman('signin');}
 };
}
if(location.pathname==='/login'||location.pathname==='/signup')authTabs(async()=>location.replace('/library'));
if($('connect-app')){
 const id=location.hash.slice(1),status=$('connect-status');let polling=null;
 const show=part=>{for(const k of ['connect-auth','connect-verify','connect-approve','connect-done'])$(k).hidden=k!==part;};
 const approve=async()=>{
  let me,pair;
  try{me=await api('/api/me');}catch(error){if(error.status!==401){setStatus(status,error.message,true);return;}show('connect-auth');return;}
  try{pair=await api('/api/pair/'+id);}catch(error){show(null);setStatus(status,error.message,true);return;}
  if(pair.approved){show('connect-done');return;}
  if(!me.verified){$('verify-to').textContent=me.email;show('connect-verify');try{localStorage.setItem('vc-pair',id);}catch{}clearTimeout(polling);polling=setTimeout(approve,4000);return;}
  try{localStorage.removeItem('vc-pair');}catch{}
  $('pair-name').textContent=pair.name;$('pair-account').textContent=me.email;if($('connect-approve').hidden){show('connect-approve');$('pair-code').focus();}
 };
 $('connect-resend').onclick=()=>resendVerify($('connect-resend'));
 $('connect-approve').onsubmit=async e=>{e.preventDefault();const code=$('pair-code').value.trim();
  if(code.replace(/[^a-z0-9]/gi,'').length!==8){setStatus(status,'Type the eight-character code from VidCapture.',true);$('pair-code').focus();return;}
  $('pair-approve').disabled=true;setStatus(status,'');
  try{await api(`/api/pair/${id}/approve`,{method:'POST',body:JSON.stringify({code})});show('connect-done');}
  catch(error){setStatus(status,error.message,true);$('pair-approve').disabled=false;}};
 if(!/^[a-f0-9]{32}$/.test(id))setStatus(status,'This link is incomplete. Click Share in VidCapture again.',true);
 else{authTabs(async created=>{if(created)toast('Account created. Check your email to confirm it.');await approve();});approve();}
}
if($('forgot-form')){
 const form=$('forgot-form'),status=form.querySelector('.login-status');
 form.onsubmit=async e=>{e.preventDefault();const email=$('forgot-email').value.trim();if(!validEmail(email)){setStatus(status,'Enter a valid email address.',true);return;}
  const b=form.querySelector('button');b.disabled=true;setStatus(status,'Sending…');
  try{const turnstile=await humanToken('forgot');await api('/api/password/forgot',{method:'POST',body:JSON.stringify({email,turnstile})});setStatus(status,`If ${email} has an account, a reset link is on its way. It expires in one hour.`);}catch(error){setStatus(status,error.message,true);}finally{b.disabled=false;resetHuman('forgot');}};
}
if($('reset-form')){
 const token=location.hash.slice(1);history.replaceState(null,'','/reset');const form=$('reset-form'),status=form.querySelector('.login-status');
 form.onsubmit=async e=>{e.preventDefault();const password=$('reset-password').value;if(password.length<10){setStatus(status,'Use at least 10 characters.',true);return;}
  const b=form.querySelector('button');b.disabled=true;setStatus(status,'Saving…');
  try{await api('/api/password/reset',{method:'POST',body:JSON.stringify({token,password})});setStatus(status,'Password saved. Log in with your new password.');setTimeout(()=>location.replace('/login'),1500);}catch(error){setStatus(status,error.message,true);b.disabled=false;}};
}
if(location.pathname==='/verify'){
 const token=location.hash.slice(1);history.replaceState(null,'','/verify');
 api('/api/verify',{method:'POST',body:JSON.stringify({token})}).then(r=>{$('verify-heading').textContent='Email confirmed.';$('verify-status').textContent=`${r.email} is ready to share videos.`;$('verify-continue').hidden=false;let pair=null;try{pair=localStorage.getItem('vc-pair');}catch{}if(pair&&/^[a-f0-9]{32}$/.test(pair)){$('verify-continue').textContent='Finish connecting VidCapture';$('verify-continue').href='/connect-app#'+pair;}}).catch(error=>{$('verify-heading').textContent='Link not valid';$('verify-status').textContent=error.message;$('verify-continue').textContent='Log in';$('verify-continue').href='/login';$('verify-continue').hidden=false;});
}
async function logout(){try{await api('/api/logout',{method:'POST'});location.replace('/');}catch(e){toast(e.message);}}
async function resendVerify(button){button.disabled=true;try{const r=await api('/api/verify/resend',{method:'POST'});toast(r.verified?'Your email is already confirmed.':'Sent. Check your inbox.');}catch(e){toast(e.message);}finally{button.disabled=false;}}
if($('account-email')){
 $('logout').onclick=logout;$('verify-resend').onclick=()=>resendVerify($('verify-resend'));
 const load=async()=>{
  let me;try{me=await api('/api/me');}catch(error){if(error.status===401)location.replace('/login');else toast(error.message);return;}
  $('account-email').textContent=me.email;
  const notify=$('notify-comments');notify.checked=me.notifyComments;notify.onchange=async()=>{notify.disabled=true;try{await api('/api/account/notifications',{method:'POST',body:JSON.stringify({comments:notify.checked})});setStatus($('notify-status'),notify.checked?'Comment emails are on.':'Comment emails are off.');}catch(error){notify.checked=!notify.checked;setStatus($('notify-status'),error.message,true);}finally{notify.disabled=false;}};$('account-verify').hidden=me.verified;$('admin-link').hidden=!me.isAdmin;
  $('account-storage').textContent=`${formatSize(me.usedBytes)} of ${formatSize(me.quotaBytes)} used`;$('account-storage-bar').value=Math.min(100,me.usedBytes/me.quotaBytes*100);
  $('current-password').closest('form').querySelector('[for=current-password]').hidden=$('current-password').hidden=!me.hasPassword;
  $('delete-password').hidden=document.querySelector('[for=delete-password]').hidden=!me.hasPassword;
  $('password-heading').textContent=me.hasPassword?'Password':'Set a password';$('password-form').querySelector('button[type=submit]').textContent=me.hasPassword?'Change password':'Set password';
  const list=$('account-devices');list.replaceChildren();
  if(!me.devices.length)list.append(el('li','No computers connected yet.','subtle'));
  for(const d of me.devices){const li=el('li'),name=el('span',d.name);if(!d.updaterReady)name.append(el('small','Needs one-time update','device-update-status'));li.append(name,el('span',`Connected ${formatDate(d.createdAt)}`,'subtle'));const b=el('button','Disconnect','quiet');b.type='button';
   b.onclick=async()=>{b.disabled=true;try{await api('/api/account/devices/'+d.id,{method:'DELETE'});toast(`${d.name} disconnected. Share from it again to reconnect.`);load();}catch(e){toast(e.message);b.disabled=false;}};li.append(b);list.append(li);}
 };
 load();
 $('password-form').onsubmit=async e=>{e.preventDefault();const form=e.target,status=form.querySelector('.login-status'),password=$('new-password').value;
  if(password.length<10){setStatus(status,'Use at least 10 characters.',true);return;}
  try{await api('/api/account/password',{method:'POST',body:JSON.stringify({current:$('current-password').value,password})});const first=$('current-password').hidden;form.reset();setStatus(status,first?'Password set.':'Password changed. Other browsers were signed out.');load();}catch(error){setStatus(status,error.message,true);}};
 $('delete-form').onsubmit=async e=>{e.preventDefault();const status=e.target.querySelector('.login-status');
  if(!confirm('Delete your account and every video you shared? This cannot be undone.'))return;
  try{await api('/api/account/delete',{method:'POST',body:JSON.stringify({password:$('delete-password').value})});location.replace('/');}catch(error){setStatus(status,error.message,true);}};
}
if($('admin-reports')){
 const act=async(path,button,done)=>{button.disabled=true;try{await api('/api/moderation/'+path,{method:'POST'});toast(done);load();}catch(e){toast(e.message);button.disabled=false;}};
 const btn=(label,onclick)=>{const b=el('button',label,'quiet');b.type='button';b.onclick=()=>onclick(b);return b;};
 const load=async()=>{
  let data;try{data=await api('/api/moderation');}catch(error){$('admin-reports').replaceChildren(el('p',error.status===404?'This page is for administrators.':error.message,'subtle'));return;}
  const reports=$('admin-reports');reports.replaceChildren();
  if(!data.reports.length)reports.append(el('p','No open reports.','subtle'));
  for(const r of data.reports){const card=el('div',undefined,'report-item');const link=el('a',r.title);link.href='/v/'+r.shareId;link.target='_blank';
   card.append(link,el('p',`${r.reason} · ${formatDate(r.createdAt)} · ${r.email||'unknown owner'}`,'subtle'));if(r.details)card.append(el('p',r.details));
   const row=el('div',undefined,'actions');
   if(r.status!=='deleted')row.append(btn('Remove video',b=>{if(confirm(`Remove "${r.title}" for everyone?`))act(`videos/${r.videoId}/remove`,b,'Video removed.');}));
   row.append(btn('Dismiss',b=>act(`reports/${r.id}/resolve`,b,'Report dismissed.')));card.append(row);reports.append(card);}
  const body=$('admin-accounts').tBodies[0];body.replaceChildren();
  for(const a of data.accounts){const tr=el('tr');const email=el('td',a.email);if(!a.verifiedAt)email.append(el('span',' (unconfirmed)','subtle'));if(a.disabled)email.append(el('span',' (disabled)','subtle'));
   const cell=el('td');if(!a.isAdmin)cell.append(a.disabled?btn('Enable',b=>act(`accounts/${a.id}/enable`,b,'Account enabled.')):btn('Disable',b=>{if(confirm(`Disable ${a.email}? Their videos stop playing.`))act(`accounts/${a.id}/disable`,b,'Account disabled.');}));
   tr.append(email,el('td',formatDate(a.createdAt)),el('td',String(a.videos)),el('td',formatSize(a.usedBytes)),cell);body.append(tr);}
 };
 load();
}
if($('report-open')){
 const form=$('report-form'),status=$('report-status');
 $('report-open').onclick=()=>{form.hidden=false;$('report-reason').focus();};$('report-cancel').onclick=()=>{form.hidden=true;$('report-open').focus();};
 form.onsubmit=async e=>{e.preventDefault();if(!$('report-reason').value){setStatus(status,'Choose a reason.',true);return;}
  const b=form.querySelector('button[type=submit]');b.disabled=true;
  try{await api('/api/report/'+form.dataset.share,{method:'POST',body:JSON.stringify({reason:$('report-reason').value,details:$('report-details').value})});form.replaceChildren(el('p','Thank you. We will review this video.'));}
  catch(error){setStatus(status,error.message,true);b.disabled=false;}};
}
let videos=[];
function closeAllMenus(){document.querySelectorAll('.card-more').forEach(m=>m.closeMenu?.());}
function drawLibrary(){
 const grid=$('video-grid');grid.replaceChildren();const query=$('search').value.toLowerCase(),shown=$('visibility-filter').value;const matches=videos.filter(v=>v.title.toLowerCase().includes(query)&&(shown==='all'||v.visibility===shown));$('video-count').textContent=`${videos.length} ${videos.length===1?'video':'videos'}`;
 for(const v of matches){
  const card=el('article',undefined,'video-card');
  if(v.status==='ready'){
   const link=el('a',undefined,'thumbnail');link.href=new URL(v.url).pathname;link.setAttribute('aria-label','Watch '+v.title);const preview=el(v.thumbnailReady?'img':'video');if(v.thumbnailReady){preview.src=new URL(v.posterUrl).pathname;preview.alt='';preview.loading='lazy';}else{preview.src=new URL(v.url).pathname.replace('/v/','/media/');preview.addEventListener('loadedmetadata',()=>{preview.currentTime=Math.min(.1,preview.duration/2);},{once:true});preview.preload='metadata';preview.muted=true;preview.playsInline=true;}link.append(preview,el('span',clock(v.duration),'duration'));if(v.visibility==='private')link.append(el('span','Private','badge'));card.append(link);
  }else card.append(el('div','Upload unfinished. Resume from the same file in VidCapture.','uploading-card'));
  const heading=el('h2');if(v.url){const a=el('a',v.title);a.href=new URL(v.url).pathname;heading.append(a);}else heading.textContent=v.title;
  const counts=[`${v.views} ${v.views===1?'play':'plays'}`,...(v.comments?[`${v.comments} ${v.comments===1?'comment':'comments'}`]:[])].join(', ');
  card.append(heading,el('div',`${formatDate(v.createdAt)} · ${counts}`,'card-meta'));
  const actions=el('div',undefined,'card-actions');
  if(v.url){
   // One Copy link: email editors paste the GIF card, Slack and LinkedIn paste the URL and unfurl it.
   const button=el('button','Copy link','primary');button.onclick=()=>v.visibility==='public'?copyCard(button,v,()=>uploadPreview(new URL(v.url).pathname.replace('/v/','/media/'),v.id)):copy(v.url,true);actions.append(button);
  }
  const more=el('div',undefined,'card-more'),moreButton=el('button','More','more-button'),menu=el('div',undefined,'card-menu');
  moreButton.setAttribute('aria-haspopup','true');moreButton.setAttribute('aria-expanded','false');menu.hidden=true;
  const remove=el('button','Remove','remove');remove.title='The link stops working. Your recording on your computer is kept.';
  const closeMenu=()=>{menu.hidden=true;moreButton.setAttribute('aria-expanded','false');delete remove.dataset.armed;remove.textContent='Remove';};more.closeMenu=closeMenu;
  moreButton.onclick=event=>{event.stopPropagation();const open=menu.hidden;closeAllMenus();menu.hidden=!open;moreButton.setAttribute('aria-expanded',String(open));if(open)menu.querySelector('button').focus();};
  menu.onkeydown=event=>{if(event.key==='Escape'){closeMenu();moreButton.focus();}};
  const makePrivate=v.visibility==='public',toggle=el('button',makePrivate?'Make private':'Make public');
  toggle.onclick=async()=>{closeMenu();try{const updated=await api('/api/admin/videos/'+v.id,{method:'PATCH',body:JSON.stringify({visibility:makePrivate?'private':'public'})});v.visibility=updated.visibility;drawLibrary();toast(makePrivate?'Video is private. Its link only works for you.':'Video is public. Anyone with the link can watch.');}catch(e){toast(e.message);}};
  const rename=el('button','Rename');rename.onclick=()=>{closeMenu();
   const input=el('input',undefined,'rename-input');input.value=v.title;input.maxLength=160;input.setAttribute('aria-label','Video title');heading.replaceChildren(input);input.focus();input.select();
   const error=el('p',undefined,'rename-error');error.setAttribute('role','alert');error.hidden=true;heading.after(error);
   let busy=false,failed=false,closed=false;
   const close=()=>{if(closed)return;closed=true;drawLibrary();};
   const finish=async save=>{if(busy||closed)return;const title=input.value.trim();if(!save||!title||title===v.title){close();return;}
    busy=true;input.disabled=true;error.hidden=true;
    try{const u=await api('/api/admin/videos/'+v.id,{method:'PATCH',body:JSON.stringify({title})});v.title=u.title;close();toast('Renamed.');}
    catch(e){failed=true;busy=false;input.disabled=false;input.setAttribute('aria-invalid','true');error.textContent=`${e.message} Press Enter to try again or Escape to cancel.`;error.hidden=false;input.focus();}};
   input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();finish(true);}else if(e.key==='Escape'){e.preventDefault();finish(false);}};input.onblur=()=>{if(!failed)finish(true);};};
  remove.onclick=async event=>{event.stopPropagation();if(!remove.dataset.armed){remove.dataset.armed='1';remove.textContent='Remove for everyone';return;}closeMenu();try{await api('/api/admin/videos/'+v.id,{method:'DELETE'});await loadLibrary();toast('Video removed. Its link no longer works.');}catch(e){toast(e.message);}};
  menu.append(toggle,rename,remove);more.append(moreButton,menu);actions.append(more);card.append(actions);grid.append(card);
 }
 document.onclick=event=>{if(!event.target.closest('.card-more'))closeAllMenus();};
 if(!matches.length&&videos.length)grid.append(el('p',query?'No videos match your search.':`No ${shown} videos yet.`,'subtle'));
}
let filling=false;
// Videos uploaded before previews existed have no image, so their cards look different
// and their links unfurl without a picture. Make the missing previews here, one at a time.
async function fillPreviews(){
 if(filling||appUpgradeRequired())return;filling=true;
 try{for(const v of videos.filter(v=>v.status==='ready'&&(!v.thumbnailReady||!v.posterHd)&&v.url)){try{await uploadPreview(new URL(v.url).pathname.replace('/v/','/media/'),v.id,v.thumbnailReady);const fresh=(await api('/api/admin/videos')).videos.find(x=>x.id===v.id);if(fresh)Object.assign(v,fresh);drawLibrary();}catch{}}}
 finally{filling=false;}
}
async function loadLibrary(){
 try{
  const data=await api('/api/admin/videos');videos=data.videos;
  if(data.quotaBytes){$('storage-meter').hidden=false;$('storage-meter').textContent=`${formatSize(data.usedBytes)} of ${formatSize(data.quotaBytes)} used`;}
  if(data.verified===false){$('verify-banner').hidden=false;api('/api/me').then(me=>$('verify-email').textContent=me.email).catch(()=>{});}$('upload-label').hidden=appUpgradeRequired();$('library-tools').hidden=!videos.length;
  $('library-message').hidden=!!videos.length;
  if(!videos.length){const get=el('a','Get the desktop app','button');get.href='/#install';const up=el('label','Upload an MP4','quiet');up.htmlFor='upload';up.tabIndex=0;up.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('upload').click();}};const row=el('div',undefined,'empty-actions');if(appUpgradeRequired()){get.href='/update';get.textContent='Update the desktop app';row.append(get);}else row.append(get,up);$('library-message').replaceChildren(el('h2','No videos yet'),el('p','Press Share in VidCapture and your video shows up here.'),row);}
  drawLibrary();fillPreviews();
 }catch(error){
  $('library-message').hidden=false;$('library-message').replaceChildren(el('h2',error.status===401?'Your library is private.':'Unable to load your library.'),el('p',error.status===401?'Log in to see your videos.':error.message));if(error.status===401){const link=el('a','Log in','button');link.href='/login';$('library-message').append(link);}
 }
}
if($('video-grid')){
 loadLibrary();$('search').oninput=drawLibrary;$('visibility-filter').onchange=drawLibrary;
$('verify-resend').onclick=()=>resendVerify($('verify-resend'));
 let uploadController=null;
 $('cancel-upload').onclick=()=>uploadController?.abort();
 $('upload').onchange=async()=>{
  if(appUpgradeRequired()){$('upload').value='';toast('Update the connected desktop app before uploading. Use Update app above.');return;}
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
    if(!upload.thumbnailReady){$('upload-status').textContent='Creating preview…';try{await uploadPreview(file,id,false,signal);}catch(error){if(signal.aborted)throw error;cardWarning=true;}}
    $('upload-status').textContent='Finishing upload…';await api(`/api/admin/videos/${id}/complete`,{method:'POST',signal});
   }
   if(upload.status==='ready'&&!upload.thumbnailReady){$('upload-status').textContent='Creating preview…';try{await uploadPreview(file,id,false,signal);}catch(error){if(signal.aborted)throw error;cardWarning=true;}}
   try{localStorage.removeItem(fingerprint);}catch{}toast(cardWarning?'Video ready. Its preview could not be created. You can still copy the link.':'Video ready. Copy its link to share it anywhere.');
  }catch(error){toast(signal.aborted?'Upload paused. Choose the same file to resume.':error.message);}
  finally{uploadController=null;$('upload-progress').hidden=true;$('upload').value='';$('upload-label').hidden=appUpgradeRequired();await loadLibrary();}
 };
}

// Owner on their own watch page: switch between public and private in place.
{const b=$('visibility-toggle');if(b)b.onclick=async()=>{const next=b.dataset.visibility==='private'?'public':'private';b.disabled=true;try{await api('/api/admin/videos/'+b.dataset.video,{method:'PATCH',body:JSON.stringify({visibility:next})});location.reload();}catch(error){b.disabled=false;toast(error.message);}};}
// Homepage demo: swap the preview for the player only when someone presses play.
if($('demo-start'))$('demo-start').onclick=async()=>{
 const frame=$('demo-frame');frame.replaceChildren($('demo-player').content.cloneNode(true));
 const load=src=>new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.body.append(s);});
 try{await Promise.all([load('/player.js'),$('transcript')?load('/transcript.js'):null]);}catch{toast('The demo could not load. Reload the page and try again.');return;}
 $('video-player')?.focus({preventScroll:true});$('watch-video')?.play().catch(()=>{});
};
