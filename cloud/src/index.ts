import {hasUpdater,upgradeRequired,legacyDevices,confirmUpdater,uploadMutation} from './app-upgrade';
import {updateBanner,updatePage} from './app-updates';
import {player} from './player';
import {homePage,loginPage,accountPages} from './pages';
import {HttpError,json,random,digest,now,escapeHtml,cookieToken,sameOrigin,readJson,optional} from './util';
import {commentRoutes} from './comments';
import {weeklySummary} from './notify';
import {type Account,accountRoutes,sessionAccount,startSession,emailSigninAccount,usedBytes,quotaMessage} from './accounts';
// Pages with forms that send email or create accounts carry the Turnstile check.
const TURNSTILE_PAGES=new Set(['/login','/signup','/forgot','/connect-app']);
const CHUNK = 8 * 1024 * 1024;
const MAX_SIZE = 20 * 1024 ** 3;
const VIEW_WINDOW = 6 * 3600;
type Video = { id:string; share_id:string; title:string; object_key:string; upload_id:string|null; status:string; size:number; duration:number; width:number; height:number; created_at:number; published_at:number|null; views:number; device_hash:string; account_id:string|null; thumbnail_ready:number; poster_hd:number; visibility:'public'|'private'; comments_enabled:number; captions:number };
// Device tokens (desktop app) reach only that device's videos. Browser sessions reach the whole account.
type Auth = { account:Account; device:string|null };
function safeVisibility(value:unknown){if(value!=='public'&&value!=='private')throw new HttpError(400,'Visibility must be public or private.');return value;}
function safeTitle(value:unknown){if(typeof value!=='string'||!value.trim()||value.length>160)throw new HttpError(400,'Use a title between 1 and 160 characters.');return value.trim();}
async function owner(request:Request,env:Env):Promise<Auth>{
 const bearer=request.headers.get('authorization');
 if(bearer?.startsWith('Bearer ')){
  if(bearer.length>200)throw new HttpError(401,'Reconnect VidCapture to your account.');
  const hash=await digest(bearer.slice(7));
  const account=await env.DB.prepare('SELECT a.* FROM devices d JOIN accounts a ON a.id=d.account_id WHERE d.token_hash=? AND d.revoked=0 AND a.disabled=0').bind(hash).first<Account>();
  if(!account)throw new HttpError(401,'This computer is no longer connected to a VidCapture account. Click Share to connect it again.');
  return {account,device:hash};
 }
 if(cookieToken(request)){
  if(!['GET','HEAD'].includes(request.method))sameOrigin(request);
  const account=await sessionAccount(request,env);if(account)return {account,device:null};
 }
 throw new HttpError(401,'Your session has ended. Log in again.');
}
// Uploads from the website need a device row too; each account gets one that no token can use.
async function websiteDevice(env:Env,account:Account){
 const existing=await env.DB.prepare('SELECT token_hash FROM devices WHERE account_id=? AND website=1 AND revoked=0').bind(account.id).first<{token_hash:string}>();
 if(existing)return existing.token_hash;
 const hash=await digest(random());await env.DB.prepare("INSERT INTO devices(token_hash,name,created_at,revoked,account_id,website) VALUES(?,'Website',?,0,?,1)").bind(hash,now(),account.id).run();return hash;
}
// Videos of disabled or deleted accounts stop playing everywhere.
const LIVE="AND account_id NOT IN (SELECT id FROM accounts WHERE disabled=1)";
function publicVideo(v:Video,origin:string){return {id:v.id,title:v.title,status:v.status,visibility:v.visibility,size:v.size,duration:v.duration,width:v.width,height:v.height,createdAt:v.created_at,publishedAt:v.published_at,views:v.views,thumbnailReady:!!v.thumbnail_ready,posterHd:!!v.poster_hd,thumbnailUrl:v.thumbnail_ready?`${origin}/thumbnail/${v.share_id}.gif`:null,posterUrl:v.thumbnail_ready?`${origin}/thumbnail/${v.share_id}.jpg`:null,url:v.status==='ready'?`${origin}/v/${v.share_id}`:null,commentsEnabled:v.comments_enabled!==0,captions:!!v.captions};}
async function getVideo(env:Env,id:string,auth:Auth){const v=await (auth.device?env.DB.prepare('SELECT * FROM videos WHERE id=? AND device_hash=? AND account_id=?').bind(id,auth.device,auth.account.id):env.DB.prepare('SELECT * FROM videos WHERE id=? AND account_id=?').bind(id,auth.account.id)).first<Video>();if(!v)throw new HttpError(404,'Video not found.');return v;}
async function parts(env:Env,id:string){return (await env.DB.prepare('SELECT part_number AS partNumber,etag,size FROM parts WHERE video_id=? ORDER BY part_number').bind(id).all<{partNumber:number;etag:string;size:number}>()).results;}
function expectedPartSize(v:Video,n:number){if(!Number.isInteger(n)||n<1||n>Math.ceil(v.size/CHUNK))throw new HttpError(400,'Invalid upload part.');return Math.min(CHUNK,v.size-(n-1)*CHUNK);}
async function purge(env:Env,v:Video){
 // Revoke the link before touching storage so a failed deletion stays private.
 // A removed video leaves nothing to moderate, so its reports close with it.
 await env.DB.batch([env.DB.prepare("UPDATE videos SET status='deleted',thumbnail_ready=0 WHERE id=?").bind(v.id),env.DB.prepare('UPDATE reports SET resolved=1 WHERE video_id=?').bind(v.id)]);
 if(v.upload_id){try{await env.VIDEOS.resumeMultipartUpload(v.object_key,v.upload_id).abort();}catch{ /* Completed uploads cannot be aborted. */ }}
 await env.VIDEOS.delete([v.object_key,`${v.object_key}.preview.gif`,`${v.object_key}.preview.jpg`,`${v.object_key}.captions.vtt`]);await env.DB.batch([env.DB.prepare('DELETE FROM parts WHERE video_id=?').bind(v.id),env.DB.prepare('DELETE FROM comments WHERE video_id=?').bind(v.id)]);
}
async function admin(request:Request,env:Env,url:URL){
 const auth=await owner(request,env),path=url.pathname,method=request.method;
 if(path==='/api/admin/app-upgrade'&&method==='POST'){
  if(!auth.device)throw new HttpError(403,'Open the updated desktop app to confirm this upgrade.');
  if(!hasUpdater(request))return upgradeRequired();
  await confirmUpdater(env,auth.device,auth.account.id);return json({ok:true});
 }
 if(uploadMutation(path,method)){
  // Check every desktop request: a previous upgrade cannot authorize an old binary.
  if(auth.device){if(!hasUpdater(request))return upgradeRequired();}
  else if(await legacyDevices(env,auth.account.id))return upgradeRequired();
 }
 if(auth.device&&hasUpdater(request)&&(path==='/api/admin/uploads'||path==='/api/admin/browser-session')&&method==='POST')await confirmUpdater(env,auth.device,auth.account.id);
 if(path==='/api/admin/browser-session'&&method==='POST'){
  if(!auth.device)throw new HttpError(403,'Open the library from VidCapture to sign in.');
  const code=random();await env.DB.prepare('INSERT INTO login_codes VALUES(?,?,?)').bind(await digest(code),auth.device,now()+90).run();
  return json({url:`${env.SITE_ORIGIN}/connect#${code}`});
 }
 if(path==='/api/admin/logout'&&method==='POST'){
  const token=cookieToken(request);if(token)await env.DB.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(await digest(token)).run();
  return new Response(null,{status:204,headers:{'Set-Cookie':'__Host-vc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'}});
 }
 if(path==='/api/admin/videos'&&method==='GET'){
  const rows=await (auth.device?env.DB.prepare("SELECT * FROM videos WHERE device_hash=? AND account_id=? AND status!='deleted' ORDER BY created_at DESC LIMIT 500").bind(auth.device,auth.account.id):env.DB.prepare("SELECT * FROM videos WHERE account_id=? AND status!='deleted' ORDER BY created_at DESC LIMIT 500").bind(auth.account.id)).all<Video>();
  const counts=new Map((await env.DB.prepare("SELECT c.video_id AS id,COUNT(*) AS n FROM comments c JOIN videos v ON v.id=c.video_id WHERE v.account_id=? GROUP BY c.video_id").bind(auth.account.id).all<{id:string;n:number}>()).results.map(r=>[r.id,r.n]));
  return json({videos:rows.results.map(v=>({...publicVideo(v,env.SITE_ORIGIN),comments:counts.get(v.id)||0})),usedBytes:await usedBytes(env,auth.account.id),quotaBytes:auth.account.quota_bytes,verified:!!auth.account.verified_at});
 }
 if(path==='/api/admin/uploads'&&method==='POST'){
  const body=await readJson(request),id=body.id;
  if(typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id))throw new HttpError(400,'Invalid upload ID.');
  const title=safeTitle(body.title),visibility=body.visibility===undefined?'public':safeVisibility(body.visibility),size=Number(body.size),duration=Number(body.duration),width=Number(body.width),height=Number(body.height);
  if(!Number.isSafeInteger(size)||size<1||size>MAX_SIZE||!Number.isFinite(duration)||duration<=0||duration>12*3600||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>16384||height>16384)throw new HttpError(400,'Use an MP4 up to 20 GB and 12 hours.');
  let v=await env.DB.prepare('SELECT * FROM videos WHERE id=?').bind(id).first<Video>();
  if(v){if(v.account_id!==auth.account.id||(auth.device&&v.device_hash!==auth.device)||v.size!==size||v.duration!==duration)throw new HttpError(409,'Upload ID is already in use.');if(v.status==='deleted')throw new HttpError(410,'This upload was removed. Start a new upload.');if(v.title!==title){await env.DB.prepare('UPDATE videos SET title=? WHERE id=?').bind(title,id).run();v.title=title;}}
  else{
   if(!auth.account.verified_at)throw new HttpError(403,`Confirm your email address first. We sent a link to ${auth.account.email}.`);
   const used=await usedBytes(env,auth.account.id);if(used+size>auth.account.quota_bytes)throw new HttpError(413,quotaMessage(used,auth.account.quota_bytes,size));
   const device=auth.device||await websiteDevice(env,auth.account);
   const share=random().slice(0,48),key=`videos/${id}.mp4`;
   const upload=await env.VIDEOS.createMultipartUpload(key,{httpMetadata:{contentType:'video/mp4'}});
   // The quota is checked again inside the insert, so simultaneous uploads cannot overshoot it together.
   let inserted;
   try{inserted=await env.DB.prepare("INSERT INTO videos(id,share_id,title,object_key,upload_id,size,duration,width,height,created_at,device_hash,visibility,account_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(size),0) FROM videos WHERE account_id=? AND status IN ('ready','uploading'))+?<=(SELECT quota_bytes FROM accounts WHERE id=?)").bind(id,share,title,key,upload.uploadId,size,duration,width,height,now(),device,visibility,auth.account.id,auth.account.id,size,auth.account.id).run();}
   catch(error){await upload.abort();throw error;}
   if(!inserted.meta.changes){await upload.abort();const usedNow=await usedBytes(env,auth.account.id);throw new HttpError(413,quotaMessage(usedNow,auth.account.quota_bytes,size));}
   v=await getVideo(env,id,auth);
  }
  return json({...publicVideo(v,env.SITE_ORIGIN),chunkSize:CHUNK,parts:await parts(env,id)});
 }
 const match=path.match(/^\/api\/admin\/videos\/([a-f0-9-]{36})(?:\/(parts\/(\d+)|complete|thumbnail|poster|captions))?$/);
 if(!match)throw new HttpError(404,'Not found.');
 const v=await getVideo(env,match[1],auth);
 if(!match[2]){
  if(method==='GET')return json({...publicVideo(v,env.SITE_ORIGIN),chunkSize:CHUNK,parts:await parts(env,v.id)});
  if(method==='PATCH'){
   const body=await readJson(request);if(v.status==='deleted')throw new HttpError(404,'Video not found.');
   if(body.title===undefined&&body.visibility===undefined&&body.comments===undefined)throw new HttpError(400,'Nothing to change.');
   if(body.comments!==undefined&&typeof body.comments!=='boolean')throw new HttpError(400,'Comments must be on or off.');
   const title=body.title===undefined?v.title:safeTitle(body.title),visibility=body.visibility===undefined?v.visibility:safeVisibility(body.visibility),comments=body.comments===undefined?v.comments_enabled:body.comments?1:0;
   await env.DB.prepare('UPDATE videos SET title=?,visibility=?,comments_enabled=? WHERE id=?').bind(title,visibility,comments,v.id).run();
   return json({...publicVideo({...v,title,visibility,comments_enabled:comments},env.SITE_ORIGIN)});
  }
  if(method==='DELETE'){await purge(env,v);return json({ok:true});}
 }
 if(v.status==='deleted')throw new HttpError(404,'Video not found.');
 if(match[2]==='captions'){
  const key=`${v.object_key}.captions.vtt`;
  if(method==='DELETE'){await env.VIDEOS.delete(key);await env.DB.prepare('UPDATE videos SET captions=0 WHERE id=?').bind(v.id).run();return json({ok:true});}
  if(method!=='PUT')throw new HttpError(405,'Method not allowed.');
  if(!request.headers.get('content-type')?.startsWith('text/vtt'))throw new HttpError(415,'Send WebVTT captions.');
  const text=await request.text();if(text.length>1024*1024)throw new HttpError(413,'Captions are too large.');
  if(!/^\uFEFF?WEBVTT/.test(text))throw new HttpError(400,'Captions must be a WebVTT file.');
  await env.VIDEOS.put(key,text,{httpMetadata:{contentType:'text/vtt; charset=utf-8'}});
  await env.DB.prepare('UPDATE videos SET captions=1 WHERE id=?').bind(v.id).run();return json({ok:true,captions:true});
 }
 if(['thumbnail','poster'].includes(match[2])&&method==='PUT'){
  const gif=match[2]==='thumbnail',type=gif?'image/gif':'image/jpeg',limit=(gif?5:2)*1024**2;let hd=false;
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
     const h=data[at+3]*256+data[at+4],w=data[at+5]*256+data[at+6];
     dimensions=length>=8&&(h===400&&w===640||h===720&&w===1280);hd=h===720;break;
    }
    at+=length;
   }
   if(!dimensions)throw new HttpError(400,'Use a 1280 by 720 JPEG poster.');
  }
  const keys=[`${v.object_key}.preview.gif`,`${v.object_key}.preview.jpg`];
  if(!gif)await env.DB.prepare('UPDATE videos SET poster_hd=? WHERE id=?').bind(hd?1:0,v.id).run();
  await env.VIDEOS.put(keys[gif?0:1],data,{httpMetadata:{contentType:type}});
  const current=await getVideo(env,v.id,auth);
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
  const finished=await getVideo(env,v.id,auth);if(finished.status!=='ready'){await env.VIDEOS.delete(v.object_key);throw new HttpError(409,'The upload was removed while finishing.');}return json(publicVideo(finished,env.SITE_ORIGIN));
 }
 throw new HttpError(405,'Method not allowed.');
}
function playerFor(v:Video){let p=player(v.share_id,v.width,v.height).replace('preload="metadata"',`preload="metadata"${v.thumbnail_ready?` poster="/thumbnail/${v.share_id}.jpg"`:''}`);if(v.captions)p=p.replace('</video>',`<track kind="captions" srclang="en" label="English" src="/captions/${v.share_id}.vtt"></video>`);return p;}
// The homepage demo: the public, ready video named by DEMO_SHARE. Nothing is shown without one.
// The player sits in a template, so no video loads until a visitor presses play.
async function demoSection(env:Env){
 const share=optional(env).DEMO_SHARE;if(!share||!/^[a-f0-9]{48}$/.test(share))return '';
 const v=await env.DB.prepare(`SELECT * FROM videos WHERE share_id=? AND status='ready' AND visibility='public' AND thumbnail_ready=1 ${LIVE}`).bind(share).first<Video>();if(!v)return '';
 const t=Math.round(v.duration),length=`${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`,w=v.width>0?v.width:1280,h=v.height>0?v.height:720;
 const transcript=v.captions?`<details class="transcript" id="transcript" data-src="/captions/${v.share_id}.vtt"><summary>Transcript</summary><ol class="transcript-list" id="transcript-list"></ol></details>`:'';
 const inner=playerFor(v).replace('<script defer src="/player.js"></script>','')+transcript;
 return `<section class="demo" id="demo" aria-labelledby="demo-heading">
	<div class="section-head"><h2 id="demo-heading">Watch the demo</h2><p>${length}${v.captions?' with captions and a transcript':''}.</p></div>
	<div class="demo-frame" id="demo-frame"><button type="button" class="demo-start" id="demo-start" aria-label="Play the demo, ${length}"><img src="/thumbnail/${v.share_id}.jpg" width="${w}" height="${h}" alt="" decoding="async"></button><template id="demo-player">${inner}</template></div>
</section>`;
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
function shell(title:string,content:string,script='/site.js',opts:{nav?:Nav;signedIn?:boolean;description?:string;bodyClass?:string;updateRequired?:boolean;share?:Video;origin?:string;turnstile?:string}={}){
 const nav=opts.nav||'app';
 const account=opts.signedIn?'<a class="header-link" href="/account">Account</a><a class="header-cta" href="/library">My videos</a>':'<a class="header-link" href="/login">Log in</a><a class="header-cta" href="/login#signup">Sign up free</a>';
 const links=nav==='home'?'<nav class="site-nav" aria-label="Main"><a href="/#features">Features</a><a href="/#privacy">Privacy</a><a href="/#compare">Compare</a><a href="/#install">Install</a><a href="/#faq">Questions</a></nav>':'';
 const right=nav==='viewer'?(opts.signedIn?'<a class="header-cta" href="/library">My videos</a>':'<a class="header-link" href="/">What is VidCapture?</a>'):account;
 const share=opts.share;const length=share?`${Math.floor(share.duration/60)}:${String(Math.floor(share.duration%60)).padStart(2,'0')}`:'';
 // Link previews (LinkedIn, Slack, iMessage, X, Facebook, Discord) are built from these tags.
 const social=share?`<meta property="og:site_name" content="VidCapture"><meta property="og:type" content="video.other"><meta property="og:title" content="${escapeHtml(share.title)}"><meta property="og:description" content="${length} video. Watch on VidCapture."><meta name="description" content="${length} video. Watch on VidCapture."><meta name="twitter:title" content="${escapeHtml(share.title)}"><meta name="twitter:description" content="${length} video. Watch on VidCapture."><meta property="og:url" content="${escapeHtml(opts.origin||'')}/v/${share.share_id}">${share.thumbnail_ready?`<meta name="twitter:card" content="${share.visibility==='public'?'player':'summary_large_image'}"><meta property="og:image" content="${escapeHtml(opts.origin||'')}/thumbnail/${share.share_id}.jpg"><meta property="og:image:secure_url" content="${escapeHtml(opts.origin||'')}/thumbnail/${share.share_id}.jpg"><meta property="og:image:type" content="image/jpeg"><meta property="og:image:alt" content="Play ${escapeHtml(share.title)}"><meta property="og:image:width" content="${share.poster_hd?1280:640}"><meta property="og:image:height" content="${share.poster_hd?720:400}"><meta name="twitter:image" content="${escapeHtml(opts.origin||'')}/thumbnail/${share.share_id}.jpg">`:''}`:'';
 const embed=share&&share.visibility==='public'?(()=>{const o=escapeHtml(opts.origin||''),w=1280,h=Math.round(w*share.height/share.width/2)*2,page=`${o}/embed/${share.share_id}`,watch=`${o}/v/${share.share_id}`;
  // Slack, Discord, X and Facebook show an inline player from oEmbed and player tags.
  return `<link rel="alternate" type="application/json+oembed" href="${o}/oembed?url=${encodeURIComponent(watch)}&amp;format=json" title="${escapeHtml(share.title)}"><meta property="og:video" content="${page}"><meta property="og:video:url" content="${page}"><meta property="og:video:secure_url" content="${page}"><meta property="og:video:type" content="text/html"><meta property="og:video:width" content="${w}"><meta property="og:video:height" content="${h}"><meta name="twitter:player" content="${page}"><meta name="twitter:player:width" content="${w}"><meta name="twitter:player:height" content="${h}"><meta name="twitter:player:stream" content="${o}/media/${share.share_id}"><meta name="twitter:player:stream:content_type" content="video/mp4">`;})():'';
 const description=opts.description?`<meta name="description" content="${escapeHtml(opts.description)}">`:'';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${opts.nav==='home'?'index,follow':'noindex,nofollow'}"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#f6f5f1">${opts.turnstile?`<meta name="turnstile-sitekey" content="${escapeHtml(opts.turnstile)}">`:''}${description}${social}${embed}<title>${escapeHtml(title)} · VidCapture</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/style.css"><script defer src="/share-card.js"></script><script defer src="${script}"></script><script defer src="/app-updates.js"></script></head><body${opts.bodyClass?` class="${opts.bodyClass}"`:''}><a class="skip" href="#main">Skip to content</a><header class="site-header"><a class="brand" href="/" aria-label="VidCapture home"><svg class="brand-icon" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="18" fill="#375b43"/><path d="M25 18v28l23-14z" fill="#fff"/></svg>VidCapture</a>${links}<div class="header-right">${right}</div></header><div id="main">${opts.signedIn&&nav!=='viewer'&&opts.bodyClass!=='page-update'?updateBanner(!!opts.updateRequired):''}${content}</div><footer class="site-footer"><div class="footer-brand"><svg class="brand-icon" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="18" fill="#375b43"/><path d="M25 18v28l23-14z" fill="#fff"/></svg><span>VidCapture</span></div><nav aria-label="Footer"><a href="/#features">Features</a><a href="/#install">Install</a><a href="/update">Update app</a><a href="/#faq">Questions</a><a href="${opts.signedIn?'/library':'/login'}">${opts.signedIn?'My videos':'Log in'}</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a></nav><p>Record on your computer. Share one link.</p></footer><div id="toast" role="status" hidden></div></body></html>`;
}
const html=(body:string,status=200)=>new Response(body,{status,headers:{'Content-Type':'text/html;charset=UTF-8','Cache-Control':'no-store, no-transform'}});
const browserSession=sessionAccount;
async function route(request:Request,env:Env,ctx:ExecutionContext){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(path.startsWith('/api/admin/'))return admin(request,env,url);
 if(path==='/api/session'&&method==='POST'){
  sameOrigin(request);
  const body=await readJson(request);if(typeof body.code!=='string'||! /^[a-f0-9]{64}$/.test(body.code))throw new HttpError(401,'This sign-in link is invalid or expired.');
  const device=(await env.DB.prepare('DELETE FROM login_codes WHERE code_hash=? AND expires_at>? RETURNING device_hash').bind(await digest(body.code),now()).first<{device_hash:string}>())?.device_hash;
  let accountId=device?(await env.DB.prepare('SELECT a.id FROM devices d JOIN accounts a ON a.id=d.account_id WHERE d.token_hash=? AND d.revoked=0 AND a.disabled=0').bind(device).first<{id:string}>())?.id:undefined;
  // An emailed sign-in link also proves the address.
  if(!accountId){accountId=(await emailSigninAccount(env,body.code))?.id;if(accountId)await env.DB.prepare('UPDATE accounts SET verified_at=COALESCE(verified_at,?) WHERE id=?').bind(now(),accountId).run();}
  if(!accountId)throw new HttpError(401,'This sign-in link has expired or was already used. Request a new one.');
  return json({ok:true},200,{'Set-Cookie':await startSession(env,accountId)});
 }
 const commentResponse=await commentRoutes(request,env,url);if(commentResponse)return commentResponse;
 const accountResponse=await accountRoutes(request,env,url,{purge:v=>purge(env,v as Video)});if(accountResponse)return accountResponse;
 const thumb=path.match(/^\/thumbnail\/([a-f0-9]{48})\.(gif|jpg)$/);
 if(thumb){
  if(!['GET','HEAD'].includes(method))throw new HttpError(405,'Method not allowed.');
  const v=await env.DB.prepare(`SELECT * FROM videos WHERE share_id=? AND status='ready' AND thumbnail_ready=1 ${LIVE}`).bind(thumb[1]).first<Video>();
  if(!v||v.visibility==='private'&&(await browserSession(request,env))?.id!==v.account_id)throw new HttpError(404,'Preview unavailable.');
  const object=await env.VIDEOS.get(`${v.object_key}.preview.${thumb[2]}`);if(!object)throw new HttpError(404,'Preview unavailable.');
  return new Response(method==='HEAD'?null:object.body,{headers:{'Content-Type':thumb[2]==='gif'?'image/gif':'image/jpeg','Content-Length':String(object.size),'Cache-Control':v.visibility==='public'?'public, max-age=300':'private, no-store','ETag':object.httpEtag}});
 }
 const caption=path.match(/^\/captions\/([a-f0-9]{48})\.vtt$/);
 if(caption){
  if(!['GET','HEAD'].includes(method))throw new HttpError(405,'Method not allowed.');
  const v=await env.DB.prepare(`SELECT * FROM videos WHERE share_id=? AND status='ready' AND captions=1 ${LIVE}`).bind(caption[1]).first<Video>();
  if(!v||v.visibility==='private'&&(await browserSession(request,env))?.id!==v.account_id)throw new HttpError(404,'Captions unavailable.');
  const object=await env.VIDEOS.get(`${v.object_key}.captions.vtt`);if(!object)throw new HttpError(404,'Captions unavailable.');
  return new Response(method==='HEAD'?null:object.body,{headers:{'Content-Type':'text/vtt; charset=utf-8','Cache-Control':v.visibility==='public'?'public, max-age=60':'private, no-store'}});
 }
 const embedMatch=path.match(/^\/embed\/([a-f0-9]{48})$/);
 if(embedMatch&&['GET','HEAD'].includes(method)){
  const v=await env.DB.prepare(`SELECT * FROM videos WHERE share_id=? AND status='ready' AND visibility='public' ${LIVE}`).bind(embedMatch[1]).first<Video>();
  if(!v)throw new HttpError(404,'This video is unavailable.');
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${escapeHtml(v.title)} · VidCapture</title><link rel="stylesheet" href="/style.css"></head><body class="embed-body">${playerFor(v)}<a class="embed-brand" href="/v/${v.share_id}" target="_blank" rel="noopener">Watch on VidCapture</a><script defer src="/site.js"></script></body></html>`);
 }
 if(path==='/oembed'&&['GET','HEAD'].includes(method)){
  const target=url.searchParams.get('url')||'',share=target.match(/^https?:\/\/[^/]+\/(?:v|embed)\/([a-f0-9]{48})(?:[?#].*)?$/)?.[1];
  if(url.searchParams.get('format')&&url.searchParams.get('format')!=='json')throw new HttpError(501,'Only JSON is supported.');
  const v=share?await env.DB.prepare(`SELECT * FROM videos WHERE share_id=? AND status='ready' AND visibility='public' ${LIVE}`).bind(share).first<Video>():null;
  if(!v)throw new HttpError(404,'Video not found.');
  const maxWidth=Number(url.searchParams.get('maxwidth'))||1280,w=Math.min(1280,Math.max(200,maxWidth)),h=Math.round(w*v.height/v.width),src=`${env.SITE_ORIGIN}/embed/${v.share_id}`;
  return Response.json({version:'1.0',type:'video',provider_name:'VidCapture',provider_url:env.SITE_ORIGIN,title:v.title,duration:Math.round(v.duration),width:w,height:h,html:`<iframe src="${src}" width="${w}" height="${h}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen title="${escapeHtml(v.title)}"></iframe>`,...(v.thumbnail_ready?{thumbnail_url:`${env.SITE_ORIGIN}/thumbnail/${v.share_id}.jpg`,thumbnail_width:v.poster_hd?1280:640,thumbnail_height:v.poster_hd?720:400}:{})},{headers:{'Cache-Control':'public, max-age=300','Access-Control-Allow-Origin':'*'}});
 }
 const m=path.match(/^\/(v|media|api\/view)\/([a-f0-9]{48})$/);
 if(m){
  const v=await env.DB.prepare(`SELECT * FROM videos WHERE share_id=? AND status='ready' ${LIVE}`).bind(m[2]).first<Video>();
  // Private links answer exactly like removed ones unless their owner is signed in.
  const viewer=await browserSession(request,env),ownerView=!!v&&viewer?.id===v.account_id;
  if(!v||v.visibility==='private'&&!ownerView)throw new HttpError(404,'This video is unavailable. Its owner may have removed it or made it private.');
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
  if(m[1]==='v'){
   const date=new Date(v.created_at*1000).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}),length=`${Math.floor(v.duration/60)}:${String(Math.floor(v.duration%60)).padStart(2,'0')}`;
   const report=ownerView?'':`<form id="report-form" class="report-form" data-share="${v.share_id}" hidden><h2>Report this video</h2><label for="report-reason">Reason</label><select id="report-reason" required><option value="">Choose a reason</option><option>Illegal or harmful</option><option>Copyright</option><option>Harassment or private information</option><option>Spam</option><option>Something else</option></select><label for="report-details">Details (optional)</label><textarea id="report-details" maxlength="1000" rows="3"></textarea><div class="actions"><button class="button" type="submit">Send report</button><button class="quiet" type="button" id="report-cancel">Cancel</button></div><p id="report-status" role="status"></p></form>`;
   const comments=`<section class="comments" id="comments" data-share="${v.share_id}" data-duration="${v.duration}"${ownerView?' data-owner':''} aria-labelledby="comments-heading"><div class="comments-head"><h2 id="comments-heading">Comments <span id="comment-count" class="subtle"></span></h2>${ownerView?`<label class="switch"><input type="checkbox" id="comments-toggle"${v.comments_enabled?' checked':''}><span>Allow comments</span></label>`:''}</div>
<form id="comment-form" class="comment-form" novalidate${v.comments_enabled?'':' hidden'}><label for="comment-body" class="sr-only">Comment</label><textarea id="comment-body" rows="2" maxlength="1000" placeholder="Add a comment" required></textarea><div class="comment-row" id="comment-extra" hidden><label class="comment-at"><input type="checkbox" id="comment-at" checked><span>At <span id="comment-at-time">0:00</span></span></label><label for="comment-name" class="sr-only">Your name</label><input id="comment-name" maxlength="60" autocomplete="name" placeholder="Your name" required><button class="button" type="submit">Post</button></div><p class="login-status" id="comment-status" role="status" aria-live="polite"></p></form>
<p class="subtle" id="comments-off"${v.comments_enabled?' hidden':''}>Comments are off.</p><ol class="comment-list" id="comment-list"></ol></section>`;
   return html(shell(v.title,`<main class="watch"><div class="watch-heading"><div><h1>${escapeHtml(v.title)}</h1>${v.visibility==='private'?'<p class="subtle">Private. Only you can watch it while signed in.</p>':''}</div><div class="actions">${ownerView?`<button class="quiet" type="button" id="visibility-toggle" data-video="${v.id}" data-visibility="${v.visibility}">${v.visibility==='private'?'Make public':'Make private'}</button>`:''}<button class="button" id="copy-link"${v.visibility==='private'?' data-private':v.thumbnail_ready?' data-card':''}>Copy link</button></div></div>${playerFor(v)}<div class="player-meta"><span>${date} <span class="dot">·</span> ${ownerView?`${v.views} ${v.views===1?'play':'plays'}`:length}</span><span class="meta-actions">${ownerView?`<button type="button" class="text-button quiet-link" id="use-frame" data-video="${v.id}" data-share="${v.share_id}">Use this frame as preview</button>`:'<button type="button" class="text-button quiet-link" id="report-open">Report video</button>'}</span></div><div class="reactions" id="reactions" data-share="${v.share_id}" role="group" aria-label="Reactions"></div>${v.captions?`<details class="transcript" id="transcript" data-src="/captions/${v.share_id}.vtt"><summary>Transcript</summary><ol class="transcript-list" id="transcript-list"></ol></details><script defer src="/transcript.js"></script>`:''}${report}${comments}</main><script defer src="/comments.js"></script>`,'/site.js',{nav:'viewer',signedIn:!!viewer,share:v,origin:env.SITE_ORIGIN}));
  }
 }
 if(method!=='GET'&&method!=='HEAD')throw new HttpError(405,'Method not allowed.');
 if(path==='/health')return json({ok:true});
 if(path==='/'){const account=await browserSession(request,env),signedIn=!!account;return html(shell('Record, edit, and share from your top bar',homePage(signedIn,await demoSection(env)),'/site.js',{nav:'home',signedIn,updateRequired:!!account&&!!await legacyDevices(env,account.id),bodyClass:'page-home',description:'VidCapture is a free, open-source screen and camera recorder for Omarchy. Clean up your mic live, edit by deleting words from the transcript, and share one link.'}));}
 if(path==='/update'){const account=await browserSession(request,env),required=!!account&&!!await legacyDevices(env,account.id);return html(shell('Update VidCapture',updatePage(required,!!account),'/site.js',{signedIn:!!account,bodyClass:'page-update'}));}
 if(path==='/login'||path==='/signup'){if(await browserSession(request,env))return new Response(null,{status:302,headers:{Location:'/library','Cache-Control':'no-store'}});return html(shell('Log in or sign up',loginPage(),'/site.js',{nav:'viewer',bodyClass:'page-login',turnstile:env.TURNSTILE_SITEKEY}));}
 const page=accountPages[path as keyof typeof accountPages];
 if(page){
  const account=await browserSession(request,env);
  if(page.signedIn&&!account)return new Response(null,{status:302,headers:{Location:'/login','Cache-Control':'no-store'}});
  if(page.admin&&!account?.is_admin)throw new HttpError(404,'Page not found.');
  return html(shell(page.title,page.body,'/site.js',{nav:page.nav,signedIn:!!account,updateRequired:!!account&&page.nav!=='viewer'&&!!await legacyDevices(env,account.id),bodyClass:page.bodyClass,turnstile:TURNSTILE_PAGES.has(path)?env.TURNSTILE_SITEKEY:undefined}));
 }
 let libraryUpdateRequired=false;
 if(path==='/library'){const account=await browserSession(request,env);if(!account)return new Response(null,{status:302,headers:{Location:'/login','Cache-Control':'no-store'}});libraryUpdateRequired=!!await legacyDevices(env,account.id);}
 if(path==='/library'||path==='/connect'){
  const content=path==='/connect'?'<main class="welcome"><h1>Opening your library.</h1><p id="connect-status" role="status">Signing you in…</p></main>':'<main class="library"><div class="page-heading"><div><h1>My videos</h1></div><div class="actions"><label class="button" id="upload-label" hidden>Upload video <input id="upload" type="file" accept="video/mp4,.mp4" hidden></label></div></div><div id="verify-banner" class="notice" hidden><p>Confirm your email to start sharing. We sent a link to <strong id="verify-email"></strong>.</p><button class="quiet" id="verify-resend" type="button">Send it again</button></div><p id="storage-meter" class="subtle" hidden></p><div id="library-message" class="empty" role="status">Loading…</div><div id="library-tools" hidden><div class="library-filters"><input id="search" type="search" placeholder="Search your videos" aria-label="Search videos"><select id="visibility-filter" aria-label="Show"><option value="all">All videos</option><option value="public">Public</option><option value="private">Private</option></select></div><span id="video-count" class="subtle"></span></div><div id="upload-progress" hidden><span id="upload-status"></span><progress max="100" value="0"></progress><button id="cancel-upload" class="quiet">Cancel</button></div><div id="video-grid" class="video-grid"></div></main>';
  return html(shell(path==='/library'?'My videos':'Signing in',content,'/site.js',{signedIn:path==='/library',updateRequired:libraryUpdateRequired}));
 }
 if(['/style.css','/site.js','/app-updates.js','/extension-install.js','/player.js','/icon.svg','/share-card.js','/gifenc.js','/gifenc-LICENSE.md','/preview.js','/comments.js','/transcript.js'].includes(path))return env.ASSETS.fetch(request);
 if(/^\/shots\/[a-z-]+\.webp$/.test(path)){const r=await env.ASSETS.fetch(request);if(r.status!==200)throw new HttpError(404,'Page not found.');const out=new Response(r.body,r);out.headers.set('Cache-Control','public, max-age=86400');return out;}
 throw new HttpError(404,'Page not found.');
}
export default {
 async fetch(request,env,ctx){
  let response:Response;
  try{response=await route(request,env,ctx);}catch(error){const status=error instanceof HttpError?error.status:500;const message=error instanceof HttpError?error.message:'Something went wrong. Please try again.';if(status===500)console.error(JSON.stringify({event:'request-failed',path:new URL(request.url).pathname.split('/').slice(0,3).join('/'),error:error instanceof Error?error.message:'Unknown error'}));
   response=new URL(request.url).pathname.startsWith('/api/')?json({error:message},status):new Response(shell(status===404?'Not found':'Unable to open video',`<main class="welcome"><h1>${status===404?'Nothing to watch here.':'Something went wrong.'}</h1><p>${escapeHtml(message)}</p><a class="button" href="/">Go home</a></main>`,'/site.js',{nav:'viewer'}),{status,headers:{'Content-Type':'text/html;charset=UTF-8','Cache-Control':'no-store, no-transform'}});
  }
  const secured=new Response(request.method==='HEAD'?null:response.body,response);secured.headers.set('Strict-Transport-Security','max-age=31536000');secured.headers.set('X-Content-Type-Options','nosniff');secured.headers.set('Referrer-Policy','no-referrer');secured.headers.set('X-Robots-Tag',new URL(request.url).pathname==='/'&&response.status===200?'index, follow':'noindex, nofollow');secured.headers.set('Content-Security-Policy',`default-src 'self'; script-src 'self'${TURNSTILE_PAGES.has(new URL(request.url).pathname)?' https://challenges.cloudflare.com':''}; frame-src ${TURNSTILE_PAGES.has(new URL(request.url).pathname)?'https://challenges.cloudflare.com':"'none'"}; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${/^\/embed\//.test(new URL(request.url).pathname)?'*':"'none'"}; form-action 'self'`);secured.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');return secured;
 },
 async scheduled(event,env){
  if(event.cron==='0 13 * * 1'){await weeklySummary(env);return;}
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()),env.DB.prepare('DELETE FROM account_sessions WHERE expires_at<?').bind(now()),env.DB.prepare('DELETE FROM account_tokens WHERE expires_at<?').bind(now()),env.DB.prepare('DELETE FROM pairings WHERE expires_at<?').bind(now()-86400),env.DB.prepare('DELETE FROM rate_events WHERE at<?').bind(now()-2*86400),env.DB.prepare('DELETE FROM login_codes WHERE expires_at<?').bind(now()),env.DB.prepare('DELETE FROM view_marks WHERE expires_at<?').bind(now()),env.DB.prepare('DELETE FROM email_codes WHERE expires_at<?').bind(now())]);
  const stale=await env.DB.prepare("SELECT * FROM videos WHERE status='uploading' AND created_at<? LIMIT 50").bind(now()-7*86400).all<Video>();for(const v of stale.results){try{await purge(env,v);}catch(error){console.error(JSON.stringify({event:'stale-upload-cleanup-failed',id:v.id}));}}
 }
} satisfies ExportedHandler<Env>;
