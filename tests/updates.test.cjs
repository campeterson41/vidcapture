'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const run = require('node:util').promisify(require('node:child_process').execFile);
const {Updates,compare,selectRelease,download,REPO} = require('../updates.cjs');
const release = (tag='v0.1.0-alpha.8', extra={}) => ({tag_name:tag,prerelease:tag.includes('-'),draft:false,assets:[{name:`vidcapture-${tag}.tar.gz`,state:'uploaded',size:10,digest:'sha256:'+'a'.repeat(64),browser_download_url:`${REPO}/releases/download/${tag}/vidcapture-${tag}.tar.gz`}],...extra});
test('release order handles numeric prereleases, final releases, and never downgrades',()=>{
  assert.equal(compare('0.1.0-alpha.10','0.1.0-alpha.9'),1);
  assert.equal(compare('0.1.0','0.1.0-rc.9'),1);
  assert.equal(selectRelease([release('v0.1.0-alpha.7')],'0.1.0-alpha.8'),null);
  assert.equal(selectRelease([release('v0.2.0-alpha.1')],'0.1.0'),null);
  assert.equal(selectRelease([release('v0.1.0'),release('v0.1.0-alpha.9')],'0.1.0-alpha.8').version,'0.1.0');
  assert.equal(selectRelease([release(undefined,{draft:true})],'0.1.0-alpha.7'),null);
});
test('incomplete or foreign release assets fail closed',()=>{
  for (const edit of [{digest:null},{browser_download_url:'https://example.com/a'},{size:50000000},{state:'new'}]) {
    const r=release();Object.assign(r.assets[0],edit);
    assert.throws(()=>selectRelease([r],'0.1.0-alpha.7'),/not ready/);
  }
});
test('network errors and oversized responses are explicit',async()=>{
  await assert.rejects(download('https://api.github.com',2,async()=>new Response('abc')),/expected size/);
  await assert.rejects(download('https://api.github.com',200,async()=>new Response('',{status:429})),/rate limited/);
});
async function fixture(t,{badDigest=false,buildFails=false}={}) {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'vc-updates-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const root=path.join(home,'old');await fs.mkdir(path.join(root,'scripts'),{recursive:true});
  await fs.copyFile(path.join(__dirname,'../scripts/extract-update.py'),path.join(root,'scripts/extract-update.py'));
  const launcher=path.join(home,'.local/bin/capture');await fs.mkdir(path.dirname(launcher),{recursive:true});
  const before=`#!/usr/bin/env bash\n# Capture local recorder launcher\nexec /usr/bin/node ${root}/launch.cjs "$@"\n`;
  await fs.writeFile(launcher,before,{mode:0o755});
  const tree=path.join(home,'tree'),name='vidcapture-v0.1.0-alpha.8',next=path.join(tree,name);
  await fs.mkdir(path.join(next,'engine'),{recursive:true});
  await fs.writeFile(path.join(next,'package.json'),JSON.stringify({name:'vidcapture',version:'0.1.0-alpha.8'}));
  for(const file of ['build.sh','build-camera.sh','follow-region.patch'])await fs.writeFile(path.join(next,'engine',file),'fixture');
  await fs.writeFile(path.join(next,'launch.cjs'),'console.log("new app")');
  const archiveFile=path.join(home,'fixture.tar.gz');await run('tar',['czf',archiveFile,'-C',tree,name]);
  const archive=await fs.readFile(archiveFile),r=release();r.assets[0].size=archive.length;r.assets[0].digest='sha256:'+crypto.createHash('sha256').update(archive).digest('hex');
  if(badDigest)r.assets[0].digest='sha256:'+'0'.repeat(64);
  let calls=0,builds=0;
  const updater=new Updates({root,home,current:'0.1.0-alpha.7',fetcher:async url=>{calls++;return new Response(url.includes('api.github.com')?JSON.stringify([r]):archive);},runner:async(cmd,args,opts)=>{
    if(cmd==='python3')return run(cmd,args,opts);
    builds++;if(buildFails)throw new Error('compiler unavailable');
    const bin=path.join(opts.cwd,'.local/bin');await fs.mkdir(bin,{recursive:true});
    for(const name of ['gpu-screen-recorder-follow','capture-camera-stream'])await fs.writeFile(path.join(bin,name),'fixture',{mode:0o755});
  }});
  return {home,root,updater,launcher,before,calls:()=>calls,builds:()=>builds};
}
test('verified update extracts, builds, and atomically activates without altering source or data',async t=>{
  const f=await fixture(t);
  const settings=path.join(f.home,'.local/state/capture/settings.json');await fs.mkdir(path.dirname(settings),{recursive:true});await fs.writeFile(settings,'private settings');
  const ready=await f.updater.prepare();assert.equal(f.builds(),2);
  assert.equal(await fs.readFile(f.launcher,'utf8'),f.before);
  const next=await f.updater.activate();assert.equal(next,ready.next);
  assert.match(await fs.readFile(f.launcher,'utf8'),new RegExp('updates/v0.1.0-alpha.8-'));
  assert.equal(await fs.readFile(path.join(ready.stage,'previous-launcher'),'utf8'),f.before);
  assert.equal(await fs.readFile(settings,'utf8'),'private settings');
  assert.equal((await fs.stat(f.root)).isDirectory(),true);
  assert.match((await run(f.launcher,[])).stdout,/new app/);
});
test('checksum mismatch and build failure preserve the installed launcher',async t=>{
  for(const options of [{badDigest:true},{buildFails:true}]) {
    const f=await fixture(t,options);await assert.rejects(f.updater.prepare(),/checksum|compiler/);
    assert.equal(await fs.readFile(f.launcher,'utf8'),f.before);
    assert.deepEqual(await fs.readdir(f.updater.base),[]);
    if(options.badDigest)assert.equal(f.builds(),0);
  }
});
test('development checkout and changed launcher are preserved',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'AGENTS.md'),'private');
  await assert.rejects(f.updater.prepare(),/development checkout/);assert.equal(f.calls(),0);
  await fs.unlink(path.join(f.root,'AGENTS.md'));await f.updater.prepare();
  await fs.writeFile(f.launcher,f.before+'# changed\n');
  await assert.rejects(f.updater.activate(),/launcher changed/);
  assert.equal(await fs.readFile(f.launcher,'utf8'),f.before+'# changed\n');
});
test('automatic checks are cached but manual checks retry and install rereads live metadata',async t=>{
  const f=await fixture(t);await f.updater.check();assert.equal(f.calls(),1);
  await f.updater.check();assert.equal(f.calls(),1);
  await f.updater.check({force:true});assert.equal(f.calls(),2);
  await f.updater.prepare();assert.equal(f.calls(),4);
});
test('archive extraction refuses traversal, links, duplicate paths and devices',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'vc-archive-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  for(const kind of ['traversal','symlink','hardlink','duplicate','device']) {
    const archive=path.join(home,kind+'.tar.gz'),dest=path.join(home,kind);await fs.mkdir(dest);
    await run('python3',['-c',`import tarfile,sys,io
with tarfile.open(sys.argv[1], 'w:gz') as t:
 n=tarfile.TarInfo('root/../escape' if sys.argv[2]=='traversal' else 'root/file')
 if sys.argv[2]=='symlink': n.type=tarfile.SYMTYPE; n.linkname='/tmp/escape'
 if sys.argv[2]=='hardlink': n.type=tarfile.LNKTYPE; n.linkname='../../escape'
 if sys.argv[2]=='device': n.type=tarfile.CHRTYPE
 t.addfile(n)
 if sys.argv[2]=='duplicate': t.addfile(n)
`,archive,kind]);
    await assert.rejects(run('python3',[path.join(__dirname,'../scripts/extract-update.py'),archive,dest,'root']),/Unsafe/);
    assert.deepEqual(await fs.readdir(dest),[]);
  }
});

test('automatic checks preserve a prepared update while offline',async t=>{
 const f=await fixture(t);await f.updater.prepare();const calls=f.calls();
 f.updater.fetcher=async()=>{throw new Error('offline');};await f.updater.check({force:true});
 assert.equal(f.calls(),calls);assert.equal(f.updater.state.status,'ready');
});

test('launcher ownership works for source paths containing spaces and quotes',async t=>{
 const f=await fixture(t);const root=path.join(f.home,"app folder's copy");
 const marked=`#!/usr/bin/env bash\n# Capture local recorder launcher\n# Capture source: ${Buffer.from(root).toString('base64')}\nexec /usr/bin/node 'quoted path' "$@"\n`;
 await fs.writeFile(f.launcher,marked);const u=new Updates({root,home:f.home});
 assert.equal(await u.ownedLauncher(),marked);
});
