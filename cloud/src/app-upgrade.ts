// A fixed compatibility contract, independent of the latest advertised release.
// Keep protocol 1 accepted by future releases. This is not a latest-version gate.
export const updaterHeader='X-VidCapture-Updater';
export const updaterProtocol='1';
export const updaterBaseline='0.1.0-alpha.11';
export const hasUpdater=(request:Request)=>request.headers.get(updaterHeader)===updaterProtocol;
export function upgradeRequired(){
 return Response.json({code:'APP_UPDATE_REQUIRED',error:'One-time VidCapture update required before sharing. Open Updates in the app, or visit https://vidcapture.stream/update for older copies. Restart the updated app, then try sharing again. Your recordings are preserved.',updateUrl:'https://vidcapture.stream/update',minimumVersion:updaterBaseline},{status:409,headers:{'Cache-Control':'no-store'}});
}
export async function legacyDevices(env:Env,accountId:string){
 const row=await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id=? AND revoked=0 AND website=0 AND updater_ready=0').bind(accountId).first<{n:number}>();
 return row?.n||0;
}
export async function confirmUpdater(env:Env,device:string,accountId:string){
 await env.DB.prepare('UPDATE devices SET updater_ready=1 WHERE token_hash=? AND account_id=? AND revoked=0 AND website=0 AND updater_ready=0').bind(device,accountId).run();
}
export function uploadMutation(path:string,method:string){
 return path==='/api/admin/uploads'&&method==='POST'
  ||/^\/api\/admin\/videos\/[a-f0-9-]{36}\/(parts\/\d+|thumbnail|poster|captions)$/.test(path)&&method==='PUT'
  ||/^\/api\/admin\/videos\/[a-f0-9-]{36}\/complete$/.test(path)&&method==='POST';
}
