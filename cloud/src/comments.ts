// Viewer comments on shared videos. Anyone who can watch a video can read and add
// comments while its owner keeps them on. Comments are plain text, optionally tied to a
// moment in the video, with one level of replies.
import {HttpError,json,random,digest,now,sameOrigin,readJson} from './util';
import {sessionAccount,limit,ip,emailHtml,sender} from './accounts';
import {sendMail} from './mail';

type CommentVideo = { id:string; account_id:string|null; visibility:string; duration:number; comments_enabled:number; title:string; share_id:string };
type Row = { id:string; parent_id:string|null; account_id:string|null; author_name:string; body:string; at_seconds:number|null; created_at:number };
const MAX_BODY = 1000, MAX_NAME = 60, MAX_PER_VIDEO = 2000;
const LIVE = "AND account_id NOT IN (SELECT id FROM accounts WHERE disabled=1)";

function text(value:unknown,max:number,label:string){
 // Collapse runs of blank lines and strip control characters other than newlines.
 const clean=typeof value==='string'?value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g,'').replace(/\n{3,}/g,'\n\n').trim():'';
 if(!clean)throw new HttpError(400,`Add ${label}.`);
 if(clean.length>max)throw new HttpError(400,`Keep ${label} under ${max} characters.`);
 return clean;
}

export async function commentRoutes(request:Request,env:Env,url:URL):Promise<Response|undefined>{
 const r=url.pathname.match(/^\/api\/reactions\/([a-f0-9]{48})$/);if(r)return reactions(request,env,r[1]);
 const m=url.pathname.match(/^\/api\/comments\/([a-f0-9]{48})(?:\/([a-f0-9-]{36}))?$/);
 if(!m)return;
 const method=request.method;
 const v=await env.DB.prepare(`SELECT id,account_id,visibility,duration,comments_enabled,title,share_id FROM videos WHERE share_id=? AND status='ready' ${LIVE}`).bind(m[1]).first<CommentVideo>();
 const viewer=await sessionAccount(request,env),isOwner=!!v&&!!viewer&&viewer.id===v.account_id;
 if(!v||v.visibility==='private'&&!isOwner)throw new HttpError(404,'This video is unavailable.');

 if(!m[2]&&method==='GET'){
  const rows=v.comments_enabled||isOwner?(await env.DB.prepare('SELECT id,parent_id,account_id,author_name,body,at_seconds,created_at FROM comments WHERE video_id=? ORDER BY created_at LIMIT ?').bind(v.id,MAX_PER_VIDEO).all<Row>()).results:[];
  return json({enabled:!!v.comments_enabled,canModerate:isOwner,comments:rows.map(r=>({id:r.id,parentId:r.parent_id,name:r.author_name,body:r.body,at:r.at_seconds,createdAt:r.created_at,byOwner:!!r.account_id&&r.account_id===v.account_id,mine:!!viewer&&r.account_id===viewer.id}))});
 }

 if(!m[2]&&method==='PATCH'){
  sameOrigin(request);
  if(!isOwner)throw new HttpError(403,'Only the video owner can change this.');
  const body=await readJson(request);if(typeof body.enabled!=='boolean')throw new HttpError(400,'Comments must be on or off.');
  await env.DB.prepare('UPDATE videos SET comments_enabled=? WHERE id=?').bind(body.enabled?1:0,v.id).run();
  return json({enabled:body.enabled});
 }

 if(!m[2]&&method==='POST'){
  sameOrigin(request);
  if(!v.comments_enabled)throw new HttpError(403,'Comments are off for this video.');
  const body=await readJson(request);
  const name=text(body.name,MAX_NAME,'your name'),message=text(body.body,MAX_BODY,'a comment');
  let at:number|null=null;
  if(body.at!==undefined&&body.at!==null){const n=Number(body.at);if(!Number.isFinite(n)||n<0||n>v.duration+1)throw new HttpError(400,'That moment is outside the video.');at=Math.round(Math.min(n,v.duration)*10)/10;}
  let parent:string|null=null;
  if(body.parentId!==undefined&&body.parentId!==null){
   if(typeof body.parentId!=='string')throw new HttpError(400,'Invalid reply.');
   const p=await env.DB.prepare('SELECT id,parent_id FROM comments WHERE id=? AND video_id=?').bind(body.parentId,v.id).first<{id:string;parent_id:string|null}>();
   if(!p)throw new HttpError(404,'That comment was removed.');
   parent=p.parent_id||p.id;at=null;
  }
  // The video's owner is never limited on their own video.
  if(!isOwner){await limit(env,'comment-ip',ip(request),8,600,'You are commenting quickly. Wait a few minutes and try again.');await limit(env,'comment-ip-day',ip(request),60,86400,'Comment limit reached for today.');}
  const count=(await env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE video_id=?').bind(v.id).first<{n:number}>())?.n||0;
  if(count>=MAX_PER_VIDEO)throw new HttpError(409,'This video has reached its comment limit.');
  const id=crypto.randomUUID(),key=random(),created=now();
  await env.DB.prepare('INSERT INTO comments(id,video_id,parent_id,account_id,author_name,body,at_seconds,key_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,v.id,parent,viewer?.id||null,name,message,at,await digest(key),created).run();
  if(!isOwner)await notifyOwner(env,v,{id,name,body:message,at});
  return json({comment:{id,parentId:parent,name,body:message,at,createdAt:created,byOwner:isOwner,mine:true},key});
 }

 if(m[2]&&method==='DELETE'){
  sameOrigin(request);
  const row=await env.DB.prepare('SELECT id,account_id,key_hash FROM comments WHERE id=? AND video_id=?').bind(m[2],v.id).first<{id:string;account_id:string|null;key_hash:string|null}>();
  if(!row)return json({ok:true});
  const key=request.headers.get('x-comment-key')||'';
  const allowed=isOwner||!!viewer&&row.account_id===viewer.id||/^[a-f0-9]{64}$/.test(key)&&row.key_hash===await digest(key);
  if(!allowed)throw new HttpError(403,'Only the video owner or the person who wrote this comment can remove it.');
  await env.DB.batch([env.DB.prepare('DELETE FROM comments WHERE parent_id=?').bind(row.id),env.DB.prepare('DELETE FROM comments WHERE id=?').bind(row.id)]);
  return json({ok:true});
 }
 throw new HttpError(405,'Method not allowed.');
}

const clock=(t:number)=>{const s=Math.floor(t),h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=String(s%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${r}`:`${m}:${r}`;};
// One email per video every 15 minutes at most, so a busy thread does not flood the owner.
async function notifyOwner(env:Env,v:CommentVideo,c:{id:string;name:string;body:string;at:number|null}){
 try{
  if(!v.account_id)return;
  const owner=await env.DB.prepare('SELECT email,notify_comments,verified_at,disabled FROM accounts WHERE id=?').bind(v.account_id).first<{email:string;notify_comments:number;verified_at:number|null;disabled:number}>();
  if(!owner||!owner.notify_comments||!owner.verified_at||owner.disabled||owner.email.startsWith('deleted:'))return;
  const key=`comment-mail:${v.id}`;
  const recent=await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key=? AND at>?').bind(key,now()-900).first<{n:number}>();
  if(recent?.n)return;
  await env.DB.prepare('INSERT INTO rate_events VALUES(?,?)').bind(key,now()).run();
  const excerpt=c.body.length>280?c.body.slice(0,277)+'...':c.body,where=c.at===null?'':` at ${clock(c.at)}`;
  const link=`${env.SITE_ORIGIN}/v/${v.share_id}${c.at===null?'':`?t=${Math.floor(c.at)}`}#comment-${c.id}`,settings=`${env.SITE_ORIGIN}/account`;
  const subject=`${c.name} commented on ${v.title}`.slice(0,150),heading=`${c.name} commented${where}`;
  const footer='You get these emails for comments on your videos. Turn them off on your Account page.';
  const sent=await sendMail(env,{from:sender(env),to:owner.email,subject,text:`${heading}:\n\n${excerpt}\n\n${link}\n\n${footer} ${settings}`,html:emailHtml(heading,excerpt,'View comment',link,footer)});
  console.log(JSON.stringify({event:'email-sent',purpose:'comment',messageId:sent.messageId}));
 }catch(error){console.error(JSON.stringify({event:'email-failed',purpose:'comment',error:error instanceof Error?error.message:'Unknown error'}));}
}

const EMOJI=['👍','❤️','😂','🎉','👀','🤔'];
async function reactions(request:Request,env:Env,share:string){
 const v=await env.DB.prepare(`SELECT id,account_id,visibility,duration FROM videos WHERE share_id=? AND status='ready' ${LIVE}`).bind(share).first<{id:string;account_id:string|null;visibility:string;duration:number}>();
 const viewer=await sessionAccount(request,env),isOwner=!!v&&!!viewer&&viewer.id===v.account_id;
 if(!v||v.visibility==='private'&&!isOwner)throw new HttpError(404,'This video is unavailable.');
 if(request.method==='GET'){
  const rows=(await env.DB.prepare('SELECT emoji,at_seconds AS at FROM reactions WHERE video_id=? ORDER BY at_seconds LIMIT 2000').bind(v.id).all<{emoji:string;at:number}>()).results;
  const counts:Record<string,number>={};for(const e of EMOJI)counts[e]=0;for(const r of rows)counts[r.emoji]=(counts[r.emoji]||0)+1;
  return json({emoji:EMOJI,counts,moments:rows});
 }
 if(request.method==='POST'){
  sameOrigin(request);const body=await readJson(request);
  if(typeof body.emoji!=='string'||!EMOJI.includes(body.emoji))throw new HttpError(400,'Choose a reaction.');
  const at=Number(body.at);if(!Number.isFinite(at)||at<0||at>v.duration+1)throw new HttpError(400,'That moment is outside the video.');
  await limit(env,'reaction-ip',ip(request),30,600,'Slow down a little and try again.');
  await env.DB.prepare('INSERT INTO reactions VALUES(?,?,?,?)').bind(v.id,body.emoji,Math.round(Math.min(at,v.duration)*10)/10,now()).run();
  return json({ok:true});
 }
 throw new HttpError(405,'Method not allowed.');
}
