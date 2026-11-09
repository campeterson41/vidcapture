'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {pathToFileURL,fileURLToPath}=require('node:url'),{registerHooks,stripTypeScriptTypes}=require('node:module'),{DatabaseSync}=require('node:sqlite');
registerHooks({resolve(s,c,next){if(s.startsWith('./')&&!path.extname(s)&&c.parentURL?.includes('/cloud/src/'))s+='.ts';return next(s,c);},load(url,context,next){if(url.includes('/cloud/src/')&&url.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url),'utf8'),{mode:'strip'}),shortCircuit:true};return next(url,context);}});
const ORIGIN='https://vidcapture.test',TOKEN='a'.repeat(64),SESSION='b'.repeat(64),ID='12345678-1234-1234-1234-123456789012',hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t,{legacy=true}={}){
 const db=new DatabaseSync(':memory:');for(const file of fs.readdirSync(path.resolve(__dirname,'../cloud/migrations')).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(path.resolve(__dirname,'../cloud/migrations',file),'utf8'));t.after(()=>db.close());
 db.prepare('INSERT INTO accounts(id,email,created_at,verified_at) VALUES(?,?,1,1)').run('owner','fixture@example.test');
 db.prepare('INSERT INTO account_sessions VALUES(?,?,?)').run(hash(SESSION),'owner',2147483647);
 if(legacy)db.prepare('INSERT INTO devices(token_hash,name,created_at,revoked,account_id,website) VALUES(?,?,1,0,?,0)').run(hash(TOKEN),'Fixture desktop','owner');
 const DB={prepare(sql){const stmt=db.prepare(sql);let args=[];return {bind(...values){args=values;return this},async first(){return stmt.get(...args)||null},async all(){return {results:stmt.all(...args)}},async run(){const result=stmt.run(...args);return {meta:{changes:Number(result.changes)}}}}},async batch(statements){db.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const objects=new Map(),uploads=new Map();let writes=0;
 const VIDEOS={async createMultipartUpload(key){writes++;uploads.set(key,new Map());return {uploadId:'upload'}},resumeMultipartUpload(key){return {async uploadPart(n,body){writes++;uploads.get(key).set(n,new Uint8Array(await new Response(body).arrayBuffer()));return {etag:'part-'+n}},async complete(parts){writes++;const data=Buffer.concat(parts.map(p=>Buffer.from(uploads.get(key).get(p.partNumber))));objects.set(key,data);return {size:data.length}},async abort(){uploads.delete(key)}}},async head(key){return objects.has(key)?{size:objects.get(key).length,httpEtag:'etag'}:null},async get(key){const data=objects.get(key);return data?{size:data.length,httpEtag:'etag',body:data}:null},async put(key,data){writes++;objects.set(key,data)},async delete(keys){writes++;for(const key of [].concat(keys))objects.delete(key)}};
 const env={DB,VIDEOS,SITE_ORIGIN:ORIGIN,ASSETS:{fetch:async()=>new Response('fixture')},EMAIL:{send:()=>assert.fail('Email is forbidden')},NOTIFY:{send:()=>assert.fail('Email is forbidden')}};
 const worker=(await import(pathToFileURL(path.resolve(__dirname,'../cloud/src/index.ts')).href)).default;
 const request=(route,{method='GET',browser=false,protocol,body,token=TOKEN,headers={}}={})=>worker.fetch(new Request(ORIGIN+route,{method,headers:{...(browser?{Cookie:'__Host-vc='+SESSION,Origin:ORIGIN}:{Authorization:'Bearer '+token}),...(protocol===undefined?{}:{'X-VidCapture-Updater':protocol}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)})}),env,{});
 const payload={id:ID,title:'Fixture',size:4,duration:1,width:16,height:16};return {db,request,payload,objects,writes:()=>writes};
}
test('legacy create, resume, complete and preview writes fail before touching upload storage',async t=>{
 const f=await fixture(t);for(const [route,method] of [['/api/admin/uploads','POST'],[`/api/admin/videos/${ID}/parts/1`,'PUT'],[`/api/admin/videos/${ID}/complete`,'POST'],[`/api/admin/videos/${ID}/thumbnail`,'PUT'],[`/api/admin/videos/${ID}/poster`,'PUT'],[`/api/admin/videos/${ID}/captions`,'PUT']]){const r=await f.request(route,{method,body:f.payload});assert.equal(r.status,409);const data=await r.json();assert.equal(data.code,'APP_UPDATE_REQUIRED');assert.match(data.error,/https:\/\/vidcapture.stream\/update/);}
 assert.equal(f.writes(),0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM videos').get().n,0);
 for(const protocol of ['', '0','2','1, 0'])assert.equal((await f.request('/api/admin/uploads',{method:'POST',protocol,body:f.payload})).status,409);
 assert.equal((await f.request('/api/admin/uploads',{method:'POST',token:'c'.repeat(64),body:f.payload})).status,401);
});
test('updated desktop confirms once and uploads exact bytes; old binary remains blocked afterward',async t=>{
 const f=await fixture(t);let status=await (await f.request('/api/app-upgrade',{browser:true})).json();assert.equal(status.required,true);
 assert.equal((await f.request('/api/admin/app-upgrade',{method:'POST',browser:true,protocol:'1'})).status,403);
 assert.equal((await f.request('/api/admin/app-upgrade',{method:'POST'})).status,409);
 assert.equal((await f.request('/api/admin/app-upgrade',{method:'POST',protocol:'1'})).status,200);
 status=await (await f.request('/api/app-upgrade',{browser:true})).json();assert.equal(status.required,false);
 assert.equal((await f.request('/api/admin/uploads',{method:'POST',body:f.payload})).status,409);
 const created=await f.request('/api/admin/uploads',{method:'POST',protocol:'1',body:f.payload,headers:{'X-VidCapture-App-Version':'999.0.0'}});assert.equal(created.status,200);assert.equal((await created.json()).status,'uploading');
 const data=new Uint8Array([1,2,3,4]);assert.equal((await f.request(`/api/admin/videos/${ID}/parts/1`,{method:'PUT',protocol:'1',body:data,headers:{'Content-Type':'application/octet-stream','Content-Length':'4'}})).status,200);
 const result=await f.request(`/api/admin/videos/${ID}/complete`,{method:'POST',protocol:'1'});assert.equal(result.status,200);const video=await result.json();assert.equal(video.status,'ready');assert.deepEqual([...f.objects.values()][0],Buffer.from(data));
 assert.equal((await f.request(new URL(video.url).pathname)).status,200,'existing shared page stays available');
 assert.equal((await f.request('/api/admin/videos')).status,200,'legacy clients can still read their library');
});
test('browser uploads cannot skip the migration; browser-only accounts stay independent',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/admin/uploads',{method:'POST',browser:true,protocol:'1',body:f.payload})).status,409);
 await f.request('/api/admin/app-upgrade',{method:'POST',protocol:'1'});
 assert.equal((await f.request('/api/admin/uploads',{method:'POST',browser:true,body:f.payload})).status,200);
 const noDesktop=await fixture(t,{legacy:false});assert.equal((await noDesktop.request('/api/admin/uploads',{method:'POST',browser:true,body:noDesktop.payload})).status,200);
});
test('each active desktop must confirm; another account and revoked or website devices are excluded',async t=>{
 const f=await fixture(t);f.db.prepare('INSERT INTO devices(token_hash,name,created_at,revoked,account_id,website) VALUES(?,?,1,0,?,0)').run(hash('c'.repeat(64)),'Second desktop','owner');
 await f.request('/api/admin/app-upgrade',{method:'POST',protocol:'1'});
 let status=await (await f.request('/api/app-upgrade',{browser:true})).json();assert.equal(status.remaining,1);
 assert.equal((await f.request('/api/admin/uploads',{method:'POST',browser:true,body:f.payload})).status,409);
 const second=f.db.prepare('SELECT rowid AS id FROM devices WHERE token_hash=?').get(hash('c'.repeat(64))).id;
 assert.equal((await f.request('/api/account/devices/'+second,{method:'DELETE',browser:true})).status,200);
 f.db.exec("INSERT INTO accounts(id,email,created_at) VALUES('other','other@example.test',1)");f.db.prepare('INSERT INTO devices(token_hash,name,created_at,account_id,website) VALUES(?,?,1,?,?)').run(hash('d'.repeat(64)),'Other','other',0);f.db.prepare('INSERT INTO devices(token_hash,name,created_at,account_id,website) VALUES(?,?,1,?,?)').run(hash('e'.repeat(64)),'Website','owner',1);
 status=await (await f.request('/api/app-upgrade',{browser:true})).json();assert.equal(status.required,false);assert.equal(status.remaining,0);
});
test('required notice follows server state and cannot be dismissed through browser state',async t=>{
 const f=await fixture(t);for(const route of ['/','/library','/account']){const r=await f.request(route,{browser:true});assert.equal(r.status,200);const html=await r.text();assert.match(html,/data-required="true"/);assert.doesNotMatch(html,/data-dismiss-update/);}
 const guide=await f.request('/update',{browser:true});assert.match(await guide.text(),/Future releases remain optional/);
 await f.request('/api/admin/app-upgrade',{method:'POST',protocol:'1'});const html=await (await f.request('/library',{browser:true})).text();assert.doesNotMatch(html,/data-required="true"/);assert.match(html,/data-dismiss-update/);
});

test('opening Online library acknowledges an updated app after missed startup confirmation',async t=>{
 const f=await fixture(t);const before=await (await f.request('/api/me',{browser:true})).json();assert.equal(before.devices[0].updaterReady,0);
 const link=await f.request('/api/admin/browser-session',{method:'POST',protocol:'1'});assert.equal(link.status,200);assert.match((await link.json()).url,/\/connect#/);
 const status=await (await f.request('/api/app-upgrade',{browser:true})).json();assert.equal(status.required,false);const after=await (await f.request('/api/me',{browser:true})).json();assert.equal(after.devices[0].updaterReady,1);
});
