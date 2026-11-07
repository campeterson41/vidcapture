// Outgoing email. Cloudflare Email Sending is the default. A deployment that sets
// SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY sends through Amazon SES instead
// (region SES_REGION, default us-east-1), which needs the sender's domain verified there.

import {optional} from './util';

export type Mail = { from:{email:string;name:string}; to:string; subject:string; text:string; html:string };

const enc = new TextEncoder();
const hex = (buf:ArrayBuffer)=>Array.from(new Uint8Array(buf),b=>b.toString(16).padStart(2,'0')).join('');
const sha256 = async (text:string)=>hex(await crypto.subtle.digest('SHA-256',enc.encode(text)));
async function hmac(key:ArrayBuffer|Uint8Array,text:string){
 const k=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return crypto.subtle.sign('HMAC',k,enc.encode(text));
}

// AWS Signature Version 4 for a JSON POST with no query string.
export async function signAws(opts:{accessKey:string;secretKey:string;region:string;service:string;host:string;path:string;body:string;date?:Date}){
 const stamp=(opts.date??new Date()).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
 const day=stamp.slice(0,8),scope=`${day}/${opts.region}/${opts.service}/aws4_request`;
 const payloadHash=await sha256(opts.body);
 const headers:Record<string,string>={'content-type':'application/json','host':opts.host,'x-amz-content-sha256':payloadHash,'x-amz-date':stamp};
 const names=Object.keys(headers).sort(),signed=names.join(';');
 const canonical=['POST',opts.path,'',names.map(n=>`${n}:${headers[n]}\n`).join(''),signed,payloadHash].join('\n');
 const toSign=['AWS4-HMAC-SHA256',stamp,scope,await sha256(canonical)].join('\n');
 let key:ArrayBuffer=await hmac(enc.encode('AWS4'+opts.secretKey),day);
 for(const part of [opts.region,opts.service,'aws4_request'])key=await hmac(key,part);
 const signature=hex(await hmac(key,toSign));
 return {...headers,authorization:`AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`};
}

const quoteName = (name:string)=>`"${name.replace(/["\\\r\n]/g,'')}"`;

export async function sendMail(env:Env,mail:Mail):Promise<{messageId:string|null}>{
 const ses=optional(env);
 if(!ses.SES_ACCESS_KEY_ID||!ses.SES_SECRET_ACCESS_KEY){
  const sent=await env.EMAIL.send(mail);
  return {messageId:sent?.messageId??null};
 }
 const region=ses.SES_REGION||'us-east-1',host=`email.${region}.amazonaws.com`,path='/v2/email/outbound-emails';
 const body=JSON.stringify({
  FromEmailAddress:`${quoteName(mail.from.name)} <${mail.from.email}>`,
  Destination:{ToAddresses:[mail.to]},
  Content:{Simple:{Subject:{Data:mail.subject,Charset:'UTF-8'},Body:{Text:{Data:mail.text,Charset:'UTF-8'},Html:{Data:mail.html,Charset:'UTF-8'}}}},
 });
 const headers=await signAws({accessKey:ses.SES_ACCESS_KEY_ID,secretKey:ses.SES_SECRET_ACCESS_KEY,region,service:'ses',host,path,body});
 const response=await fetch(`https://${host}${path}`,{method:'POST',headers,body});
 const result=await response.json().catch(()=>({})) as {MessageId?:string;message?:string};
 if(!response.ok)throw new Error(`SES ${response.status}: ${result.message??'request failed'}`);
 return {messageId:result.MessageId??null};
}
