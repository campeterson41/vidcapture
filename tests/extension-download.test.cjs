const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),tool=path.join(root,'scripts/package-extension.py');
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vc-download-')),source=path.join(dir,'fresh source');
 const spec=JSON.parse(await fs.readFile(path.join(root,'extension/runtime-files.json')));
 for(const name of ['extension/runtime-files.json',...spec.files.map(f=>f.source)]){await fs.mkdir(path.dirname(path.join(source,name)),{recursive:true});await fs.copyFile(path.join(root,name),path.join(source,name));}
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,source,spec};
}
function build(source,out){return JSON.parse(execFileSync('python3',[tool,'--source',source,'--output-dir',out],{encoding:'utf8'}));}
function unzip(file,out){execFileSync('python3',['-c','import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',file,out]);}
test('runtime ZIP is byte deterministic, complete and private-file free',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.source,'extension/publishing.json'),'private-test-sentinel');await fs.writeFile(path.join(f.source,'extension/private-key.pem'),'private-test-key');
 const a=build(f.source,path.join(f.dir,'one'));
 for(const item of f.spec.files)await fs.utimes(path.join(f.source,item.source),1234567,1234567);
 const b=build(f.source,path.join(f.dir,'two'));assert.equal(a.sha256,b.sha256);assert.deepEqual(await fs.readFile(a.archive),await fs.readFile(b.archive));assert.equal(a.extensionId,'dagpaflngbhbgpeichcnhalplkdmkfie');assert.equal(a.version,'0.3.0');
 const extracted=path.join(f.dir,'unpacked');unzip(a.archive,extracted);const contents=JSON.parse(await fs.readFile(path.join(extracted,'PACKAGE-CONTENTS.json')));
 assert.equal(contents.files.length,f.spec.files.length);
 for(const file of contents.files){const bytes=await fs.readFile(path.join(extracted,file.path));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),file.sha256);assert.deepEqual(bytes,await fs.readFile(path.join(f.source,file.source)));assert.equal(/publishing|\.pem|node_modules|tests\//.test(file.path),false);}
 const zipInfo=JSON.parse(execFileSync('python3',['-c','import zipfile,json,sys; print(json.dumps({i.filename: ((i.external_attr>>16)&511) for i in zipfile.ZipFile(sys.argv[1]).infolist()}))',a.archive],{encoding:'utf8'}));assert.equal(zipInfo['native/vidcapture-native-host'],0o755);assert.equal(zipInfo['native/install.sh'],0o755);
 assert.equal(await fs.readFile(a.archive+'.sha256','utf8'),a.sha256+'  vidcapture-extension-v0.3.0.zip\n');
});
test('packaging rejects missing runtime references, private additions and changed extension identity',async t=>{
 const f=await fixture(t),file=path.join(f.source,'extension/runtime-files.json');
 let spec=structuredClone(f.spec);spec.files=spec.files.filter(x=>x.archive!=='popup.js');await fs.writeFile(file,JSON.stringify(spec));assert.match(spawnSync('python3',[tool,'--source',f.source,'--output-dir',path.join(f.dir,'bad')],{encoding:'utf8'}).stderr,/missing.*popup.js/);
 spec=structuredClone(f.spec);spec.files.push({source:'extension/publishing.json',archive:'publishing.json'});await fs.writeFile(path.join(f.source,'extension/publishing.json'),'private');await fs.writeFile(file,JSON.stringify(spec));assert.match(spawnSync('python3',[tool,'--source',f.source,'--output-dir',path.join(f.dir,'bad')],{encoding:'utf8'}).stderr,/Private or non-runtime/);
 await fs.writeFile(file,JSON.stringify(f.spec));const manifest=JSON.parse(await fs.readFile(path.join(f.source,'extension/manifest.json')));manifest.key=Buffer.from('not-the-supported-key').toString('base64');await fs.writeFile(path.join(f.source,'extension/manifest.json'),JSON.stringify(manifest));assert.match(spawnSync('python3',[tool,'--source',f.source,'--output-dir',path.join(f.dir,'bad')],{encoding:'utf8'}).stderr,/extension ID/);
});
test('fresh extracted installer handles spaces/quotes, preserves flags and registrations, and is idempotent',async t=>{
 const f=await fixture(t),built=build(f.source,path.join(f.dir,'build')),unpacked=path.join(f.dir,'lasting extension "quotes" $money & spaces');unzip(built.archive,unpacked);
 const home=path.join(f.dir,'fixture-user'),config=path.join(f.dir,'config with spaces'),logs=[];
 await fs.mkdir(path.join(home,'.local/bin'),{recursive:true});await fs.writeFile(path.join(home,'.local/bin/capture'),'#!/bin/sh\nexit 0\n',{mode:0o755});await fs.mkdir(config,{recursive:true});
 const flags=path.join(config,'chromium-flags.conf'),flagsBody='# personal flags\n--load-extension=/existing/one,/another path/two\n--enable-features=KeepThis\n';await fs.writeFile(flags,flagsBody);
 const hosts=path.join(config,'chromium/NativeMessagingHosts');await fs.mkdir(hosts,{recursive:true});const other=path.join(hosts,'another.application.json');await fs.writeFile(other,'other-registration');
 const name=path.join(hosts,'stream.vidcapture.launcher.json'),previous='{"name":"stream.vidcapture.launcher","path":"/old app/host"}\n';await fs.writeFile(name,previous);
 const {main}=require(path.join(unpacked,'native/install.cjs'));const context={home,configHome:config,log:s=>logs.push(s)};
 main(['--browser','chromium'],context);const after=await fs.readFile(name,'utf8'),registration=JSON.parse(after);assert.equal(registration.path,path.join(unpacked,'native/vidcapture-native-host'));assert.deepEqual(registration.allowed_origins,['chrome-extension://dagpaflngbhbgpeichcnhalplkdmkfie/']);assert.equal((await fs.stat(registration.path)).mode&0o111,0o111);
 const backups=(await fs.readdir(hosts)).filter(n=>n.includes('.before-vidcapture-'));assert.equal(backups.length,1);assert.equal(await fs.readFile(path.join(hosts,backups[0]),'utf8'),previous);
 main(['--browser','chromium'],context);assert.equal(await fs.readFile(name,'utf8'),after);assert.equal((await fs.readdir(hosts)).filter(n=>n.includes('.before-vidcapture-')).length,1);assert.equal(await fs.readFile(flags,'utf8'),flagsBody);assert.equal(await fs.readFile(other,'utf8'),'other-registration');
 main(['--browser','chrome'],context);assert.equal(JSON.parse(await fs.readFile(path.join(config,'google-chrome/NativeMessagingHosts/stream.vidcapture.launcher.json'))).path,registration.path);
 const custom=path.join(f.dir,'custom browser "data"');main(['--browser','chromium','--user-data-dir',custom],context);assert.ok(await fs.stat(path.join(custom,'NativeMessagingHosts/stream.vidcapture.launcher.json')));
 assert.ok(logs.some(x=>x.includes('No browser launch flags were changed')));
});
test('installer rejects unmet desktop prerequisites and unsupported arguments without browser-config writes',async t=>{
 const f=await fixture(t),built=build(f.source,path.join(f.dir,'build')),unpacked=path.join(f.dir,'unpacked');unzip(built.archive,unpacked);const {main}=require(path.join(unpacked,'native/install.cjs'));
 const home=path.join(f.dir,'no-app'),config=path.join(f.dir,'never-written');const context={home,configHome:config,log(){}};
 assert.throws(()=>main(['--browser','chromium'],context),/desktop app first/);assert.throws(()=>main(['--browser','safari'],context),/Use --browser/);assert.throws(()=>main(['--browser','chromium','--user-data-dir','relative'],context),/absolute/);assert.throws(()=>main(['--unexpected'],context),/Unknown option/);await assert.rejects(fs.stat(config),{code:'ENOENT'});
 const help=execFileSync('bash',[path.join(unpacked,'native/install.sh'),'--help'],{encoding:'utf8'});assert.match(help,/Launch flags and browser sessions are left alone/);
});
