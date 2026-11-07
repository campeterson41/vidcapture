import {HttpError,json,random,digest,now,escapeHtml,cookieToken,sameOrigin,readJson,formatBytes} from './util';

export type Account = { id:string; email:string; password_hash:string|null; created_at:number; verified_at:number|null; quota_bytes:number; is_admin:number; disabled:number };
type VideoRow = { id:string; share_id:string; title:string; object_key:string; upload_id:string|null; status:string; size:number; account_id:string|null };
type Deps = { purge:(v:VideoRow)=>Promise<void> };

const SESSION_TTL = 30 * 86400;
const TOKEN_TTL = { verify: 7 * 86400, reset: 3600, signin: 15 * 60 } as const;
const PBKDF2_ITERATIONS = 100000; // Workers' WebCrypto maximum for PBKDF2.
// Self-hosted deployments set EMAIL_FROM to an address on their own Email Sending domain.
const sender = (env: Env) => ({ email: (env as { EMAIL_FROM?: string }).EMAIL_FROM || 'no-reply@vidcapture.stream', name: 'VidCapture' });

// ---------- Passwords ----------
const b64 = (bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
const unb64 = (text:string)=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
async function derive(password:string,salt:Uint8Array,iterations:number){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
 return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,256));
}
export async function hashPassword(password:string){const salt=crypto.getRandomValues(new Uint8Array(16));return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(await derive(password,salt,PBKDF2_ITERATIONS))}`;}
export async function checkPassword(password:string,stored:string|null){
 // Unknown accounts still pay the hashing cost so response time does not reveal them.
 const [scheme,iter,salt,hash]=(stored||`pbkdf2$${PBKDF2_ITERATIONS}$${b64(new Uint8Array(16))}$`).split('$');
 if(scheme!=='pbkdf2')return false;
 const actual=await derive(password,unb64(salt),Number(iter)),expected=hash?unb64(hash):new Uint8Array(32);
 let diff=actual.length^expected.length;for(let i=0;i<actual.length;i++)diff|=actual[i]^(expected[i]??0);
 return !!stored&&diff===0;
}
function validEmail(value:unknown){const email=typeof value==='string'?value.trim().toLowerCase():'';if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new HttpError(400,'Enter a valid email address.');return email;}
function validPassword(value:unknown){if(typeof value!=='string'||value.length<10)throw new HttpError(400,'Use a password with at least 10 characters.');if(value.length>200)throw new HttpError(400,'Use a password under 200 characters.');return value;}

// ---------- Rate limits ----------
export async function limit(env:Env,name:string,subject:string,max:number,windowSeconds:number,message='Too many attempts. Wait a few minutes and try again.'){
 const key=`${name}:${await digest(subject)}`;
 // Count and record in one statement, so a burst of parallel requests cannot all slip under the limit.
 const result=await env.DB.prepare('INSERT INTO rate_events(key,at) SELECT ?,? WHERE (SELECT COUNT(*) FROM rate_events WHERE key=? AND at>?)<?').bind(key,now(),key,now()-windowSeconds,max).run();
 if(!result.meta.changes)throw new HttpError(429,message);
}
async function attempts(env:Env,name:string,subject:string,windowSeconds:number){return (await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key=? AND at>?').bind(`${name}:${await digest(subject)}`,now()-windowSeconds).first<{n:number}>())?.n||0;}
export const ip=(request:Request)=>request.headers.get('cf-connecting-ip')||'unknown';

// ---------- Sessions ----------
export async function sessionAccount(request:Request,env:Env){
 const token=cookieToken(request);if(!token)return null;
 const account=await env.DB.prepare('SELECT a.* FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND a.disabled=0').bind(await digest(token),now()).first<Account>();
 return account||null;
}
export async function requireAccount(request:Request,env:Env){
 if(!['GET','HEAD'].includes(request.method))sameOrigin(request);
 const account=await sessionAccount(request,env);if(!account)throw new HttpError(401,'Your session has ended. Log in again.');return account;
}
export async function startSession(env:Env,accountId:string){
 const token=random();await env.DB.prepare('INSERT INTO account_sessions VALUES(?,?,?)').bind(await digest(token),accountId,now()+SESSION_TTL).run();
 return `__Host-vc=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`;
}
const endSession='__Host-vc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';

// ---------- Email ----------
function emailHtml(heading:string,body:string,button:string,link:string){
 const href=escapeHtml(link);
 return `<!doctype html><html><body style="margin:0;background:#f6f5f1;font-family:Inter,Segoe UI,Arial,sans-serif;color:#242823"><div style="max-width:480px;margin:0 auto;padding:40px 24px"><p style="font-size:18px;font-weight:600;margin:0 0 16px">${escapeHtml(heading)}</p><p style="font-size:15px;line-height:1.6;margin:0 0 24px">${escapeHtml(body)}</p><p style="margin:0 0 28px"><a href="${href}" style="display:inline-block;background:#375b43;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px">${escapeHtml(button)}</a></p><p style="font-size:13px;line-height:1.6;color:#73786e;margin:0">If you did not ask for this, you can ignore this email.</p></div></body></html>`;
}
async function emailToken(env:Env,account:Account,purpose:keyof typeof TOKEN_TTL){
 const token=random();
 await env.DB.prepare('INSERT INTO account_tokens VALUES(?,?,?,?,?)').bind(await digest(token),account.id,purpose,now(),now()+TOKEN_TTL[purpose]).run();
 const copy={
  verify:{path:'/verify',subject:'Confirm your VidCapture email',heading:'Confirm your email',body:'Confirm this address to start sharing videos from VidCapture. The link works for seven days.',button:'Confirm email'},
  reset:{path:'/reset',subject:'Reset your VidCapture password',heading:'Reset your password',body:'Use this link to choose a new password. It works once and expires in one hour.',button:'Choose a new password'},
  signin:{path:'/connect',subject:'Sign in to VidCapture',heading:'Sign in to VidCapture',body:'Use this link to open your video library. It works once and expires in 15 minutes.',button:'Open my library'},
 }[purpose];
 const link=`${env.SITE_ORIGIN}${copy.path}#${token}`;
 try{const sent=await env.EMAIL.send({from:sender(env),to:account.email,subject:copy.subject,text:`${copy.body}\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,html:emailHtml(copy.heading,copy.body,copy.button,link)});console.log(JSON.stringify({event:'email-sent',purpose,messageId:sent?.messageId??null}));}
 catch(error){console.error(JSON.stringify({event:'email-failed',purpose,error:error instanceof Error?error.message:'Unknown error'}));throw new HttpError(502,'The email could not be sent. Try again in a minute.');}
}
async function useToken(env:Env,token:unknown,purpose:string){
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
 const row=await env.DB.prepare('DELETE FROM account_tokens WHERE token_hash=? AND purpose=? AND expires_at>? RETURNING account_id').bind(await digest(token),purpose,now()).first<{account_id:string}>();
 return row?await env.DB.prepare('SELECT * FROM accounts WHERE id=? AND disabled=0').bind(row.account_id).first<Account>():null;
}
export const emailSigninAccount=(env:Env,token:unknown)=>useToken(env,token,'signin');

// ---------- Usage ----------
export async function usedBytes(env:Env,accountId:string){return (await env.DB.prepare("SELECT COALESCE(SUM(size),0) AS n FROM videos WHERE account_id=? AND status IN ('ready','uploading')").bind(accountId).first<{n:number}>())?.n||0;}
export function quotaMessage(used:number,quota:number,size:number){return `This video is ${formatBytes(size)}, and you have ${formatBytes(Math.max(0,quota-used))} of your ${formatBytes(quota)} free. Remove videos from your library to make room.`;}

// ---------- Routes ----------
export async function accountRoutes(request:Request,env:Env,url:URL,deps:Deps):Promise<Response|null>{
 const path=url.pathname,method=request.method;
 if(path==='/api/signup'&&method==='POST'){
  sameOrigin(request);const body=await readJson(request),email=validEmail(body.email),password=validPassword(body.password);
  await limit(env,'signup-ip',ip(request),5,3600,'Too many new accounts from this network. Try again later.');
  await limit(env,'signup-all','all',300,3600,'Sign-ups are paused for a moment. Try again shortly.');
  if(await env.DB.prepare('SELECT id FROM accounts WHERE email=?').bind(email).first())throw new HttpError(409,'An account with this email already exists. Log in instead.');
  const account:Account={id:crypto.randomUUID(),email,password_hash:await hashPassword(password),created_at:now(),verified_at:null,quota_bytes:5*1024**3,is_admin:0,disabled:0};
  await env.DB.prepare('INSERT INTO accounts(id,email,password_hash,created_at) VALUES(?,?,?,?)').bind(account.id,email,account.password_hash,account.created_at).run();
  await emailToken(env,account,'verify');
  return json({ok:true,email,verified:false},200,{'Set-Cookie':await startSession(env,account.id)});
 }
 if(path==='/api/login'&&method==='POST'){
  sameOrigin(request);const body=await readJson(request),email=validEmail(body.email),password=typeof body.password==='string'?body.password.slice(0,200):'';
  await limit(env,'login-ip',ip(request),30,900);
  // A locked address refuses even the right password, so guesses learn nothing.
  if(await attempts(env,'login-fail',email,900)>=10)throw new HttpError(429,'Too many incorrect attempts. Wait 15 minutes or reset your password.');
  const account=await env.DB.prepare('SELECT * FROM accounts WHERE email=?').bind(email).first<Account>();
  const ok=await checkPassword(password,account?.password_hash||null);
  if(!account||!ok){await limit(env,'login-fail',email,10,900,'Too many incorrect attempts. Wait 15 minutes or reset your password.');throw new HttpError(401,account&&!account.password_hash?'This account has no password yet. Use "Forgot password" to set one.':'That email and password do not match.');}
  if(account.disabled)throw new HttpError(403,'This account has been disabled.');
  return json({ok:true,verified:!!account.verified_at},200,{'Set-Cookie':await startSession(env,account.id)});
 }
 if(path==='/api/logout'&&method==='POST'){
  sameOrigin(request);const token=cookieToken(request);if(token)await env.DB.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(await digest(token)).run();
  return new Response(null,{status:204,headers:{'Set-Cookie':endSession}});
 }
 if(path==='/api/verify'&&method==='POST'){
  sameOrigin(request);const account=await useToken(env,(await readJson(request)).token,'verify');
  if(!account)throw new HttpError(400,'This confirmation link has expired or was already used. Log in to send a new one.');
  await env.DB.prepare('UPDATE accounts SET verified_at=COALESCE(verified_at,?) WHERE id=?').bind(now(),account.id).run();
  return json({ok:true,email:account.email});
 }
 if(path==='/api/verify/resend'&&method==='POST'){
  const account=await requireAccount(request,env);if(account.verified_at)return json({ok:true,verified:true});
  await limit(env,'verify-resend',account.id,3,3600,'We already sent a few emails. Check your inbox and spam folder, or try again in an hour.');
  await emailToken(env,account,'verify');return json({ok:true});
 }
 if((path==='/api/password/forgot'||path==='/api/signin')&&method==='POST'){
  sameOrigin(request);const email=validEmail((await readJson(request)).email);
  await limit(env,'mail-ip',ip(request),10,3600);
  const account=await env.DB.prepare('SELECT * FROM accounts WHERE email=? AND disabled=0').bind(email).first<Account>();
  // Same answer either way, so this cannot be used to find out who has an account.
  if(account){try{await limit(env,'mail-account',account.id,4,3600);await emailToken(env,account,path==='/api/signin'?'signin':'reset');}catch(error){if(!(error instanceof HttpError&&error.status===429))throw error;}}
  return json({ok:true});
 }
 if(path==='/api/password/reset'&&method==='POST'){
  sameOrigin(request);const body=await readJson(request),password=validPassword(body.password);
  const account=await useToken(env,body.token,'reset');if(!account)throw new HttpError(400,'This reset link has expired or was already used. Request a new one.');
  // A working reset link also proves the address.
  await env.DB.batch([env.DB.prepare('UPDATE accounts SET password_hash=?,verified_at=COALESCE(verified_at,?) WHERE id=?').bind(await hashPassword(password),now(),account.id),env.DB.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(account.id),
   // A reset disconnects every computer, so a device someone else attached cannot outlive it.
   env.DB.prepare('UPDATE devices SET revoked=1 WHERE account_id=? AND website=0').bind(account.id)]);
  return json({ok:true},200,{'Set-Cookie':await startSession(env,account.id)});
 }
 if(path==='/api/me'&&method==='GET'){
  const account=await requireAccount(request,env);
  const devices=(await env.DB.prepare("SELECT rowid AS id,name,created_at AS createdAt FROM devices WHERE account_id=? AND revoked=0 AND website=0 ORDER BY created_at").bind(account.id).all()).results;
  return json({email:account.email,verified:!!account.verified_at,usedBytes:await usedBytes(env,account.id),quotaBytes:account.quota_bytes,isAdmin:!!account.is_admin,hasPassword:!!account.password_hash,devices});
 }
 if(path==='/api/account/password'&&method==='POST'){
  const account=await requireAccount(request,env),body=await readJson(request),password=validPassword(body.password);
  if(account.password_hash&&!await checkPassword(typeof body.current==='string'?body.current:'',account.password_hash))throw new HttpError(400,'Your current password is not correct.');
  await env.DB.batch([env.DB.prepare('UPDATE accounts SET password_hash=? WHERE id=?').bind(await hashPassword(password),account.id),env.DB.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(account.id)]);
  return json({ok:true},200,{'Set-Cookie':await startSession(env,account.id)});
 }
 const deviceMatch=path.match(/^\/api\/account\/devices\/(\d+)$/);
 if(deviceMatch&&method==='DELETE'){
  const account=await requireAccount(request,env);
  const done=await env.DB.prepare('UPDATE devices SET revoked=1 WHERE rowid=? AND account_id=?').bind(Number(deviceMatch[1]),account.id).run();
  if(!done.meta.changes)throw new HttpError(404,'Computer not found.');return json({ok:true});
 }
 if(path==='/api/account/delete'&&method==='POST'){
  const account=await requireAccount(request,env),body=await readJson(request);
  if(account.password_hash&&!await checkPassword(typeof body.password==='string'?body.password:'',account.password_hash))throw new HttpError(400,'Your password is not correct.');
  if(account.is_admin)throw new HttpError(400,'The admin account cannot be deleted here.');
  const videos=(await env.DB.prepare("SELECT * FROM videos WHERE account_id=? AND status!='deleted'").bind(account.id).all<VideoRow>()).results;
  for(const v of videos)await deps.purge(v);
  // Keep the row for foreign keys, but drop the address and every way back in.
  await env.DB.batch([env.DB.prepare("UPDATE accounts SET email='deleted:'||id,password_hash=NULL,disabled=1 WHERE id=?").bind(account.id),env.DB.prepare('UPDATE devices SET revoked=1 WHERE account_id=?').bind(account.id),env.DB.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(account.id),env.DB.prepare('DELETE FROM account_tokens WHERE account_id=?').bind(account.id),env.DB.prepare('DELETE FROM comments WHERE parent_id IN (SELECT id FROM comments WHERE account_id=?)').bind(account.id),env.DB.prepare('DELETE FROM comments WHERE account_id=?').bind(account.id)]);
  return json({ok:true,removed:videos.length},200,{'Set-Cookie':endSession});
 }
 // Desktop app connection. The app sends only its token's hash, then polls with the token.
 if(path==='/api/pair/start'&&method==='POST'){
  const body=await readJson(request),hash=body.hash,name=typeof body.name==='string'?body.name.trim().slice(0,60):'';
  if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw new HttpError(400,'Invalid connection request.');
  await limit(env,'pair-ip',ip(request),20,3600);
  const id=random().slice(0,32),alphabet='ABCDEFGHJKMNPQRSTUVWXYZ23456789',bytes=crypto.getRandomValues(new Uint8Array(8)),code=Array.from(bytes,b=>alphabet[b%alphabet.length]).join('').replace(/^(.{4})/,'$1-');
  await env.DB.prepare('INSERT INTO pairings(id,device_hash,name,code,created_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(device_hash) DO UPDATE SET id=excluded.id,code=excluded.code,expires_at=excluded.expires_at,account_id=NULL').bind(id,hash,name||'VidCapture app',code,now(),now()+20*60).run();
  return json({url:`${env.SITE_ORIGIN}/connect-app#${id}`,code});
 }
 if(path==='/api/pair/status'&&method==='POST'){
  const bearer=request.headers.get('authorization');if(!bearer?.startsWith('Bearer ')||bearer.length>200)throw new HttpError(401,'Missing device token.');
  const hash=await digest(bearer.slice(7));
  const device=await env.DB.prepare('SELECT a.email FROM devices d JOIN accounts a ON a.id=d.account_id WHERE d.token_hash=? AND d.revoked=0 AND a.disabled=0').bind(hash).first<{email:string}>();
  if(device)return json({status:'approved',email:device.email});
  const pending=await env.DB.prepare('SELECT id FROM pairings WHERE device_hash=? AND expires_at>?').bind(hash,now()).first();
  return json({status:pending?'pending':'expired'});
 }
 const pairMatch=path.match(/^\/api\/pair\/([a-f0-9]{32})(\/approve)?$/);
 if(pairMatch){
  const account=await requireAccount(request,env);
  const pairing=await env.DB.prepare('SELECT * FROM pairings WHERE id=? AND expires_at>?').bind(pairMatch[1],now()).first<{id:string;device_hash:string;name:string;code:string;account_id:string|null}>();
  if(!pairing)throw new HttpError(404,'This connection request has expired. Click Share in VidCapture again.');
  if(!pairMatch[2]&&method==='GET')return json({name:pairing.name,approved:pairing.account_id===account.id});
  if(pairMatch[2]&&method==='POST'){
   if(!account.verified_at)throw new HttpError(403,'Confirm your email before connecting a computer. Check your inbox for our link.');
   // The person types the code their own app shows, so a link sent by someone else cannot attach a stranger's computer.
   const body=await readJson(request),typed=typeof body.code==='string'?body.code.toUpperCase().replace(/[^A-Z0-9]/g,''):'';
   await limit(env,'pair-code',pairing.id,5,1200,'Too many wrong codes. Click Share in VidCapture again for a new one.');
   if(!pairing.account_id&&typed!==pairing.code.replace('-',''))throw new HttpError(400,'That code does not match. Type the code VidCapture shows.');
   if(pairing.account_id&&pairing.account_id!==account.id)throw new HttpError(409,'This request was already approved by another account.');
   await env.DB.batch([env.DB.prepare('INSERT INTO devices(token_hash,name,created_at,revoked,account_id) VALUES(?,?,?,0,?) ON CONFLICT(token_hash) DO NOTHING').bind(pairing.device_hash,pairing.name,now(),account.id),env.DB.prepare('UPDATE pairings SET account_id=? WHERE id=?').bind(account.id,pairing.id)]);
   return json({ok:true});
  }
 }
 // Reports from viewers.
 const reportMatch=path.match(/^\/api\/report\/([a-f0-9]{48})$/);
 if(reportMatch&&method==='POST'){
  sameOrigin(request);const body=await readJson(request),reasons=['Illegal or harmful','Copyright','Harassment or private information','Spam','Something else'];
  if(typeof body.reason!=='string'||!reasons.includes(body.reason))throw new HttpError(400,'Choose a reason.');
  await limit(env,'report-ip',ip(request),10,3600);
  const v=await env.DB.prepare("SELECT id FROM videos WHERE share_id=? AND status='ready'").bind(reportMatch[1]).first<{id:string}>();if(!v)throw new HttpError(404,'Video not found.');
  await env.DB.prepare('INSERT INTO reports(id,video_id,reason,details,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),v.id,body.reason,typeof body.details==='string'?body.details.slice(0,1000):null,now()).run();
  return json({ok:true});
 }
 // Admin moderation.
 if(path.startsWith('/api/moderation')){
  const account=await requireAccount(request,env);if(!account.is_admin)throw new HttpError(404,'Not found.');
  if(path==='/api/moderation'&&method==='GET'){
   const reports=(await env.DB.prepare("SELECT r.id,r.reason,r.details,r.created_at AS createdAt,v.id AS videoId,v.title,v.share_id AS shareId,v.status,a.email FROM reports r JOIN videos v ON v.id=r.video_id LEFT JOIN accounts a ON a.id=v.account_id WHERE r.resolved=0 ORDER BY r.created_at DESC LIMIT 200").all()).results;
   const accounts=(await env.DB.prepare("SELECT a.id,a.email,a.created_at AS createdAt,a.verified_at AS verifiedAt,a.disabled,a.is_admin AS isAdmin,(SELECT COUNT(*) FROM videos v WHERE v.account_id=a.id AND v.status='ready') AS videos,(SELECT COALESCE(SUM(size),0) FROM videos v WHERE v.account_id=a.id AND v.status IN ('ready','uploading')) AS usedBytes FROM accounts a WHERE a.email NOT LIKE 'deleted:%' ORDER BY a.created_at DESC LIMIT 500").all()).results;
   return json({reports,accounts});
  }
  const m=path.match(/^\/api\/moderation\/(videos|reports|accounts)\/([a-f0-9-]{32,36})\/(remove|resolve|disable|enable)$/);
  if(m&&method==='POST'){
   if(m[1]==='videos'&&m[3]==='remove'){const v=await env.DB.prepare('SELECT * FROM videos WHERE id=?').bind(m[2]).first<VideoRow>();if(!v)throw new HttpError(404,'Video not found.');await deps.purge(v);await env.DB.prepare('UPDATE reports SET resolved=1 WHERE video_id=?').bind(v.id).run();return json({ok:true});}
   if(m[1]==='reports'&&m[3]==='resolve'){await env.DB.prepare('UPDATE reports SET resolved=1 WHERE id=?').bind(m[2]).run();return json({ok:true});}
   if(m[1]==='accounts'&&(m[3]==='disable'||m[3]==='enable')){
    if(m[2]===account.id)throw new HttpError(400,'You cannot disable your own account.');
    await env.DB.batch([env.DB.prepare('UPDATE accounts SET disabled=? WHERE id=?').bind(m[3]==='disable'?1:0,m[2]),...(m[3]==='disable'?[env.DB.prepare('DELETE FROM account_sessions WHERE account_id=?').bind(m[2])]:[])]);
    return json({ok:true});
   }
  }
  throw new HttpError(404,'Not found.');
 }
 return null;
}
