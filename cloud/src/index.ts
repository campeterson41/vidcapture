import {player} from './player';
import {homePage,loginPage} from './pages';
const CHUNK = 8 * 1024 * 1024;
const MAX_SIZE = 20 * 1024 ** 3;
const VIEW_WINDOW = 6 * 3600;
type Video = { id:string; share_id:string; title:string; object_key:string; upload_id:string|null; status:string; size:number; duration:number; width:number; height:number; created_at:number; published_at:number|null; views:number; device_hash:string; thumbnail_ready:number };
class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');}
const now=()=>Math.floor(Date.now()/1000);
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function safeTitle(value:unknown){if(typeof value!=='string'||!value.trim()||value.length>160)throw new HttpError(400,'Use a title between 1 and 160 characters.');return value.trim();}
async function readJson(request:Request):Promise<Record<string,unknown>>{
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new HttpError(415,'Send JSON.');
 const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'Missing request body.');
 const chunks:Uint8Array[]=[];let length=0;
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8192){await reader.cancel();throw new HttpError(413,'Request too large.');}chunks.push(value);}
 const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
 try{const parsed=JSON.parse(new TextDecoder().decode(data));if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw 0;return parsed;}catch{throw new HttpError(400,'Invalid JSON.');}
}
async function owner(request:Request,env:Env){
 const bearer=request.headers.get('authorization');let hash:string|undefined;
 if(bearer?.startsWith('Bearer ')){
  if(bearer.length>200)throw new HttpError(401,'Open your library from Capture to sign in.');
  hash=await digest(bearer.slice(7));
 }else{
  const token=request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-vc=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(token){
   if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==new URL(request.url).origin)throw new HttpError(403,'Invalid request origin.');
   const session=await env.DB.prepare('SELECT device_hash FROM sessions WHERE token_hash=? AND expires_at>?').bind(await digest(token),now()).first<{device_hash:string}>();hash=session?.device_hash;
  }
 }
 if(!hash||!await env.DB.prepare('SELECT token_hash FROM devices WHERE token_hash=? AND revoked=0').bind(hash).first())throw new HttpError(401,'Open your library from Capture to sign in.');
 return hash;
}
function publicVideo(v:Video,origin:string){return {id:v.id,title:v.title,status:v.status,size:v.size,duration:v.duration,width:v.width,height:v.height,createdAt:v.created_at,publishedAt:v.published_at,views:v.views,thumbnailReady:!!v.thumbnail_ready,thumbnailUrl:v.thumbnail_ready?`${origin}/thumbnail/${v.share_id}.gif`:null,posterUrl:v.thumbnail_ready?`${origin}/thumbnail/${v.share_id}.jpg`:null,url:v.status==='ready'?`${origin}/v/${v.share_id}`:null};}
async function getVideo(env:Env,id:string,device:string){const v=await env.DB.prepare('SELECT * FROM videos WHERE id=? AND device_hash=?').bind(id,device).first<Video>();if(!v)throw new HttpError(404,'Video not found.');return v;}
async function parts(env:Env,id:string){return (await env.DB.prepare('SELECT part_number AS partNumber,etag,size FROM parts WHERE video_id=? ORDER BY part_number').bind(id).all<{partNumber:number;etag:string;size:number}>()).results;}
function expectedPartSize(v:Video,n:number){if(!Number.isInteger(n)||n<1||n>Math.ceil(v.size/CHUNK))throw new HttpError(400,'Invalid upload part.');return Math.min(CHUNK,v.size-(n-1)*CHUNK);}
async function purge(env:Env,v:Video){
 // Revoke the link before touching storage so a failed deletion stays private.
 await env.DB.prepare("UPDATE videos SET status='deleted',thumbnail_ready=0 WHERE id=?").bind(v.id).run();
 if(v.upload_id){try{await env.VIDEOS.resumeMultipartUpload(v.object_key,v.upload_id).abort();}catch{ /* Completed uploads cannot be aborted. */ }}
 await env.VIDEOS.delete([v.object_key,`${v.object_key}.preview.gif`,`${v.object_key}.preview.jpg`]);await env.DB.prepare('DELETE FROM parts WHERE video_id=?').bind(v.id).run();
}
async function admin(request:Request,env:Env,url:URL){
 const device=await owner(request,env),path=url.pathname,method=request.method;
 if(path==='/api/admin/browser-session'&&method==='POST'){
  if(!request.headers.get('authorization')?.startsWith('Bearer '))throw new HttpError(403,'Open the library from Capture to sign in.');
  const code=random();await env.DB.prepare('INSERT INTO login_codes VALUES(?,?,?)').bind(await digest(code),device,now()+90).run();
  return json({url:`${env.SITE_ORIGIN}/connect#${code}`});
 }
 if(path==='/api/admin/logout'&&method==='POST'){
  const token=request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-vc=([a-f0-9]{64})(?:;|$)/)?.[1];if(token)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
  return new Response(null,{status:204,headers:{'Set-Cookie':'__Host-vc=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'}});
 }
 if(path==='/api/admin/videos'&&method==='GET'){
  const rows=await env.DB.prepare("SELECT * FROM videos WHERE device_hash=? AND status!='deleted' ORDER BY created_at DESC LIMIT 500").bind(device).all<Video>();
  return json({videos:rows.results.map(v=>publicVideo(v,env.SITE_ORIGIN))});
 }
 if(path==='/api/admin/uploads'&&method==='POST'){
  const body=await readJson(request),id=body.id;
  if(typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id))throw new HttpError(400,'Invalid upload ID.');
  const title=safeTitle(body.title),size=Number(body.size),duration=Number(body.duration),width=Number(body.width),height=Number(body.height);
  if(!Number.isSafeInteger(size)||size<1||size>MAX_SIZE||!Number.isFinite(duration)||duration<=0||duration>12*3600||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>16384||height>16384)throw new HttpError(400,'Use an MP4 up to 20 GB and 12 hours.');
  let v=await env.DB.prepare('SELECT * FROM videos WHERE id=?').bind(id).first<Video>();
  if(v){if(v.device_hash!==device||v.size!==size||v.duration!==duration)throw new HttpError(409,'Upload ID is already in use.');if(v.status==='deleted')throw new HttpError(410,'This upload was removed. Start a new upload.');if(v.title!==title){await env.DB.prepare('UPDATE videos SET title=? WHERE id=?').bind(title,id).run();v.title=title;}}
  else{
   const share=random().slice(0,48),key=`videos/${id}.mp4`;
   const upload=await env.VIDEOS.createMultipartUpload(key,{httpMetadata:{contentType:'video/mp4'}});
   try{await env.DB.prepare('INSERT INTO videos(id,share_id,title,object_key,upload_id,size,duration,width,height,created_at,device_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,share,title,key,upload.uploadId,size,duration,width,height,now(),device).run();}
   catch(error){await upload.abort();throw error;}
   v=await getVideo(env,id,device);
  }
  return json({...publicVideo(v,env.SITE_ORIGIN),chunkSize:CHUNK,parts:await parts(env,id)});
 }
 const match=path.match(/^\/api\/admin\/videos\/([a-f0-9-]{36})(?:\/(parts\/(\d+)|complete|thumbnail|poster))?$/);
 if(!match)throw new HttpError(404,'Not found.');
 const v=await getVideo(env,match[1],device);
 if(!match[2]){
  if(method==='GET')return json({...publicVideo(v,env.SITE_ORIGIN),chunkSize:CHUNK,parts:await parts(env,v.id)});
  if(method==='PATCH'){const body=await readJson(request);if(v.status==='deleted')throw new HttpError(404,'Video not found.');await env.DB.prepare('UPDATE videos SET title=? WHERE id=?').bind(safeTitle(body.title),v.id).run();return json({ok:true});}
  if(method==='DELETE'){await purge(env,v);return json({ok:true});}
 }
 if(v.status==='deleted')throw new HttpError(404,'Video not found.');
 if(['thumbnail','poster'].includes(match[2])&&method==='PUT'){
  const gif=match[2]==='thumbnail',type=gif?'image/gif':'image/jpeg',limit=(gif?5:2)*1024**2;
  if(request.headers.get('content-type')!==type||!request.body)throw new HttpError(415,'Send a GIF preview or JPEG poster.');
  if(Number(request.headers.get('content-length'))>limit)throw new HttpError(413,'Preview is too large.');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new HttpError(413,'Preview is too large.');}chunks.push(value);}
  const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  if(gif){
   const signature=new TextDecoder().decode(data.slice(0,6)),width=data[6]+data[7]*256,height=data[8]+data[9]*256;
   if(size<14||!['GIF87a','GIF89a'].includes(signature)||data[size-1]!==59||width!==640||height!==400)throw new HttpError(400,'Use a 640 by 400 GIF preview.');
  }else{
   if(size<4||data[0]!==255||data[1]!==216||data[size-2]!==255||data[size-1]!==217)throw new HttpError(400,'Invalid JPEG poster.');
   let dimensions=false;
   for(let at=2;at<size-4;){
    if(data[at++]!==255)break;while(data[at]===255)at++;const marker=data[at++];
    if(marker===218||marker===217)break;if(marker===216||marker>=208&&marker<=215)continue;
    const length=data[at]*256+data[at+1];if(length<2||at+length>size)break;
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
     dimensions=length>=8&&data[at+3]*256+data[at+4]===400&&data[at+5]*256+data[at+6]===640;break;
    }
    at+=length;
   }
   if(!dimensions)throw new HttpError(400,'Use a 640 by 400 JPEG poster.');
  }
  const keys=[`${v.object_key}.preview.gif`,`${v.object_key}.preview.jpg`];
  await env.VIDEOS.put(keys[gif?0:1],data,{httpMetadata:{contentType:type}});
  const current=await getVideo(env,v.id,device);
  if(current.status==='deleted'){await env.VIDEOS.delete(keys);throw new HttpError(404,'Video was removed.');}
  const exists=await Promise.all(keys.map(key=>env.VIDEOS.head(key)));
  if(exists.every(Boolean))await env.DB.prepare("UPDATE videos SET thumbnail_ready=1 WHERE id=? AND status!='deleted'").bind(v.id).run();
  return json({ok:true,thumbnailReady:exists.every(Boolean)});
 }
 if(match[3]&&method==='PUT'){
  if(v.status!=='uploading'||!v.upload_id)throw new HttpError(409,'Upload is already complete.');
  const n=Number(match[3]),expected=expectedPartSize(v,n);
  if(Number(request.headers.get('content-length'))!==expected||!request.body)throw new HttpError(400,'Upload part has the wrong size.');
  const part=await env.VIDEOS.resumeMultipartUpload(v.object_key,v.upload_id).uploadPart(n,request.body);
  await env.DB.prepare('INSERT INTO parts(video_id,part_number,etag,size) VALUES(?,?,?,?) ON CONFLICT(video_id,part_number) DO UPDATE SET etag=excluded.etag,size=excluded.size').bind(v.id,n,part.etag,expected).run();
  return json({partNumber:n,etag:part.etag});
 }
 if(match[2]==='complete'&&method==='POST'){
  if(v.status==='ready')return json(publicVideo(v,env.SITE_ORIGIN));
  const uploaded=await parts(env,v.id);
  if(uploaded.length!==Math.ceil(v.size/CHUNK)||uploaded.some((p,i)=>p.partNumber!==i+1||p.size!==expectedPartSize(v,i+1)))throw new HttpError(409,'Upload is incomplete. Resume uploading first.');
  let object=await env.VIDEOS.head(v.object_key);
  if(!object){if(!v.upload_id)throw new HttpError(409,'Upload expired.');object=await env.VIDEOS.resumeMultipartUpload(v.object_key,v.upload_id).complete(uploaded);}
  if(object.size!==v.size)throw new HttpError(409,'Uploaded file size does not match.');
  await env.DB.prepare("UPDATE videos SET status='ready',published_at=?,upload_id=NULL WHERE id=? AND status='uploading'").bind(now(),v.id).run();
  const finished=await getVideo(env,v.id,device);if(finished.status!=='ready'){await env.VIDEOS.delete(v.object_key);throw new HttpError(409,'The upload was removed while finishing.');}return json(publicVideo(finished,env.SITE_ORIGIN));
 }
 throw new HttpError(405,'Method not allowed.');
}
async function mediaResponse(request:Request,env:Env,v:Video){
 const head=await env.VIDEOS.head(v.object_key);if(!head)throw new HttpError(404,'Video unavailable.');
 const headers=new Headers({'Content-Type':'video/mp4','Content-Length':String(head.size),'Accept-Ranges':'bytes','ETag':head.httpEtag,'Cache-Control':'private, no-store','Content-Disposition':'inline'});
 let range:{offset:number;length:number}|undefined;
 const raw=request.headers.get('range');
 if(raw){const m=/^bytes=(\d*)-(\d*)$/.exec(raw);let start=0,end=head.size-1;
  if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${head.size}`}});
  if(!m[1])start=Math.max(0,head.size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=head.size||end<start)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${head.size}`}});
  range={offset:start,length:end-start+1};headers.set('Content-Length',String(range.length));headers.set('Content-Range',`bytes ${start}-${end}/${head.size}`);
 }
 const status=range?206:200;
 if(request.method==='HEAD')return new Response(null,{status,headers});
 const object=await env.VIDEOS.get(v.object_key,range?{range}:undefined);if(!object)throw new HttpError(404,'Video unavailable.');
 return new Response(object.body,{status,headers});
}
type Nav='home'|'app'|'viewer';
function shell(title:string,content:string,script='/site.js',opts:{nav?:Nav;signedIn?:boolean;description?:string;bodyClass?:string;share?:Video;origin?:string}={}){
 const nav=opts.nav||'app';
 const account=opts.signedIn?'<a class="header-cta" href="/library">My library</a>':'<a class="header-cta" href="/login">Sign in</a>';
 const links=nav==='home'?'<nav class="site-nav" aria-label="Main"><a href="/#features">Features</a><a href="/#how">How it works</a><a href="/#compare">Compare</a><a href="/#faq">Questions</a></nav>':'';
 const right=nav==='viewer'?'<a class="header-link" href="/">What is VidCapture?</a>':account;
 const share=opts.share;const social=share?`<meta property="og:type" content="video.other"><meta property="og:title" content="${escapeHtml(share.title)}"><meta property="og:url" content="${escapeHtml(opts.origin||'')}/v/${share.share_id}">${share.thumbnail_ready?`<meta name="twitter:card" content="summary_large_image"><meta property="og:image" content="${escapeHtml(opts.origin||'')}/thumbnail/${share.share_id}.jpg"><meta property="og:image:width" content="640"><meta property="og:image:height" content="400"><meta name="twitter:image" content="${escapeHtml(opts.origin||'')}/thumbnail/${share.share_id}.jpg">`:''}`:'';
 const description=opts.description?`<meta name="description" content="${escapeHtml(opts.description)}">`:'';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${opts.nav==='home'?'index,follow':'noindex,nofollow'}"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#f6f5f1">${description}${social}<title>${escapeHtml(title)} · VidCapture</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/style.css"><script defer src="/share-card.js"></script><script defer src="${script}"></script></head><body${opts.bodyClass?` class="${opts.bodyClass}"`:''}><a class="skip" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="/" aria-label="VidCapture home"><svg class="brand-icon" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="18" fill="#375b43"/><path d="M25 18v28l23-14z" fill="#fff"/></svg>VidCapture</a>${links}<div class="header-right">${right}</div></header><div id="main">${content}</div><footer class="site-footer"><div class="footer-brand"><svg class="brand-icon" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="18" fill="#375b43"/><path d="M25 18v28l23-14z" fill="#fff"/></svg><span>VidCapture</span></div><nav aria-label="Footer"><a href="/#features">Features</a><a href="/#how">How it works</a><a href="/#faq">Questions</a><a href="${opts.signedIn?'/library':'/login'}">${opts.signedIn?'My library':'Sign in'}</a></nav><p>Record on your computer. Share one link.</p></footer><div id="toast" role="status" hidden></div></body></html>`;
}
const html=(body:string,status=200)=>new Response(body,{status,headers:{'Content-Type':'text/html;charset=UTF-8','Cache-Control':'no-store, no-transform'}});
async function browserSession(request:Request,env:Env){
 const token=request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-vc=([a-f0-9]{64})(?:;|$)/)?.[1];if(!token)return false;
 return !!await env.DB.prepare('SELECT s.device_hash FROM sessions s JOIN devices d ON d.token_hash=s.device_hash WHERE s.token_hash=? AND s.expires_at>? AND d.revoked=0').bind(await digest(token),now()).first();
}
async function route(request:Request,env:Env,ctx:ExecutionContext){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(path.startsWith('/api/admin/'))return admin(request,env,url);
 if(path==='/api/session'&&method==='POST'){
  if(request.headers.get('origin')!==url.origin)throw new HttpError(403,'Invalid request origin.');
  const body=await readJson(request);if(typeof body.code!=='string'||! /^[a-f0-9]{64}$/.test(body.code))throw new HttpError(401,'This sign-in link is invalid or expired. Open the library from Capture again.');
  const code=await env.DB.prepare('DELETE FROM login_codes WHERE code_hash=? AND expires_at>? RETURNING device_hash').bind(await digest(body.code),now()).first<{device_hash:string}>();
  if(!code||!await env.DB.prepare('SELECT token_hash FROM devices WHERE token_hash=? AND revoked=0').bind(code.device_hash).first())throw new HttpError(401,'This sign-in link has expired. Open the library from Capture again.');
  const token=random();await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await digest(token),code.device_hash,now()+7*86400).run();
  return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':`__Host-vc=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800`}});
 }
 const thumb=path.match(/^\/thumbnail\/([a-f0-9]{48})\.(gif|jpg)$/);
 if(thumb){
  if(!['GET','HEAD'].includes(method))throw new HttpError(405,'Method not allowed.');
  const v=await env.DB.prepare("SELECT * FROM videos WHERE share_id=? AND status='ready' AND thumbnail_ready=1").bind(thumb[1]).first<Video>();
  if(!v)throw new HttpError(404,'Preview unavailable.');
  const object=await env.VIDEOS.get(`${v.object_key}.preview.${thumb[2]}`);if(!object)throw new HttpError(404,'Preview unavailable.');
  return new Response(method==='HEAD'?null:object.body,{headers:{'Content-Type':thumb[2]==='gif'?'image/gif':'image/jpeg','Content-Length':String(object.size),'Cache-Control':'private, no-store','ETag':object.httpEtag}});
 }
 const m=path.match(/^\/(v|media|api\/view)\/([a-f0-9]{48})$/);
 if(m){
  const v=await env.DB.prepare("SELECT * FROM videos WHERE share_id=? AND status='ready'").bind(m[2]).first<Video>();if(!v)throw new HttpError(404,'This video is unavailable. Its owner may have removed it.');
  if(m[1]==='api/view'&&method==='POST'){
   if(request.headers.get('origin')!==url.origin)throw new HttpError(403,'Invalid request origin.');
   // Count one play per visitor per video every 6 hours. The video id is not public,
   // so the mark cannot be precomputed from a share link.
   const visitor=request.headers.get('cf-connecting-ip')||'unknown',mark=await digest(`view:${v.id}:${visitor}`);
   const fresh=await env.DB.prepare('INSERT INTO view_marks(mark_hash,expires_at) VALUES(?,?) ON CONFLICT(mark_hash) DO UPDATE SET expires_at=excluded.expires_at WHERE view_marks.expires_at<?').bind(mark,now()+VIEW_WINDOW,now()).run();
   if(fresh.meta.changes)await env.DB.prepare('UPDATE videos SET views=views+1 WHERE id=?').bind(v.id).run();
   return json({ok:true});
  }
  if(!['GET','HEAD'].includes(method))throw new HttpError(405,'Method not allowed.');
  if(m[1]==='media')return mediaResponse(request,env,v);
  if(m[1]==='v')return html(shell(v.title,`<main class="watch"><div class="watch-heading"><div><p class="subtle">Shared recording</p><h1>${escapeHtml(v.title)}</h1></div><div class="actions">${v.thumbnail_ready?'<button class="button" id="copy-card">Copy video card</button>':''}<button class="quiet" id="copy-link">Copy link ↗</button></div></div>${player(v.share_id)}<div class="player-meta"><span>${new Date(v.created_at*1000).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})} <span class="dot">·</span> ${Math.floor(v.duration/60)}:${String(Math.floor(v.duration%60)).padStart(2,'0')}</span><span class="watch-hint">Made to be watched at your pace.</span></div></main>`,'/site.js',{nav:'viewer',share:v,origin:env.SITE_ORIGIN}));
 }
 if(method!=='GET'&&method!=='HEAD')throw new HttpError(405,'Method not allowed.');
 if(path==='/health')return json({ok:true});
 if(path==='/'){const signedIn=await browserSession(request,env);return html(shell('Record. Edit. Share.',homePage(signedIn),'/site.js',{nav:'home',signedIn,bodyClass:'page-home',description:'VidCapture is a screen recorder for Linux that keeps recordings on your computer, lets you cut them down, and shares the version you choose with one link.'}));}
 if(path==='/login'){if(await browserSession(request,env))return new Response(null,{status:302,headers:{Location:'/library','Cache-Control':'no-store'}});return html(shell('Sign in',loginPage(),'/site.js',{nav:'viewer',bodyClass:'page-login'}));}
 if(path==='/library'){if(!await browserSession(request,env))return new Response(null,{status:302,headers:{Location:'/login','Cache-Control':'no-store'}});}
 if(path==='/library'||path==='/connect'){
  const content=path==='/connect'?'<main class="welcome"><h1>Opening your library.</h1><p id="connect-status" role="status">Signing you in from VidCapture…</p></main>':'<main class="library"><div class="page-heading"><div><p class="subtle">Your workspace</p><h1>My videos</h1></div><div class="actions"><button id="logout" class="quiet" hidden>Sign out</button><label class="button" id="upload-label" hidden>Upload video <input id="upload" type="file" accept="video/mp4,.mp4" hidden></label></div></div><div id="library-message" class="empty" role="status">Loading your library…</div><div id="library-tools" hidden><input id="search" type="search" placeholder="Search your videos" aria-label="Search videos"><span id="video-count" class="subtle"></span></div><div id="upload-progress" hidden><span id="upload-status"></span><progress max="100" value="0"></progress><button id="cancel-upload" class="quiet">Cancel</button></div><div id="video-grid" class="video-grid"></div></main>';
  return html(shell(path==='/library'?'My videos':'Signing in',content,'/site.js',{signedIn:path==='/library'}));
 }
 if(['/style.css','/site.js','/player.js','/icon.svg','/share-card.js','/gifenc.js','/gifenc-LICENSE.md','/preview.js'].includes(path))return env.ASSETS.fetch(request);
 throw new HttpError(404,'Page not found.');
}
export default {
 async fetch(request,env,ctx){
  let response:Response;
  try{response=await route(request,env,ctx);}catch(error){const status=error instanceof HttpError?error.status:500;const message=error instanceof HttpError?error.message:'Something went wrong. Please try again.';if(status===500)console.error(JSON.stringify({event:'request-failed',path:new URL(request.url).pathname.split('/').slice(0,3).join('/'),error:error instanceof Error?error.message:'Unknown error'}));
   response=new URL(request.url).pathname.startsWith('/api/')?json({error:message},status):new Response(shell(status===404?'Not found':'Unable to open video',`<main class="welcome"><h1>${status===404?'Nothing to watch here.':'Something went wrong.'}</h1><p>${escapeHtml(message)}</p><a class="button" href="/">Go home</a></main>`,'/site.js',{nav:'viewer'}),{status,headers:{'Content-Type':'text/html;charset=UTF-8','Cache-Control':'no-store, no-transform'}});
  }
  const secured=new Response(request.method==='HEAD'?null:response.body,response);secured.headers.set('Strict-Transport-Security','max-age=31536000');secured.headers.set('X-Content-Type-Options','nosniff');secured.headers.set('Referrer-Policy','no-referrer');secured.headers.set('X-Robots-Tag',new URL(request.url).pathname==='/'&&response.status===200?'index, follow':'noindex, nofollow');secured.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");secured.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');return secured;
 },
 async scheduled(_event,env){
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()),env.DB.prepare('DELETE FROM login_codes WHERE expires_at<?').bind(now()),env.DB.prepare('DELETE FROM view_marks WHERE expires_at<?').bind(now())]);
  const stale=await env.DB.prepare("SELECT * FROM videos WHERE status='uploading' AND created_at<? LIMIT 50").bind(now()-7*86400).all<Video>();for(const v of stale.results){try{await purge(env,v);}catch(error){console.error(JSON.stringify({event:'stale-upload-cleanup-failed',id:v.id}));}}
 }
} satisfies ExportedHandler<Env>;
