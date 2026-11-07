export class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
export const json=(data:unknown,status=200,headers:Record<string,string>={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
export const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');}
export const now=()=>Math.floor(Date.now()/1000);
export const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const cookieToken=(request:Request)=>request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-vc=([a-f0-9]{64})(?:;|$)/)?.[1];
export function sameOrigin(request:Request){if(request.headers.get('origin')!==new URL(request.url).origin)throw new HttpError(403,'Invalid request origin.');}
export async function readJson(request:Request):Promise<Record<string,unknown>>{
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new HttpError(415,'Send JSON.');
 const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'Missing request body.');
 const chunks:Uint8Array[]=[];let length=0;
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8192){await reader.cancel();throw new HttpError(413,'Request too large.');}chunks.push(value);}
 const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
 try{const parsed=JSON.parse(new TextDecoder().decode(data));if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw 0;return parsed;}catch{throw new HttpError(400,'Invalid JSON.');}
}
export const formatBytes=(n:number)=>n>=1024**3?`${(n/1024**3).toFixed(n>=10*1024**3?0:1)} GB`:`${Math.max(0,Math.round(n/1024**2))} MB`;
