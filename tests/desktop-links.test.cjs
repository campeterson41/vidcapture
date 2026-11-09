'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {updateLinkRequest,registerUpdateLink,removeUpdateLink,execPath}=require('../desktop-links.cjs');
test('website update links accept only the fixed action with exactly one URL',()=>{
 for(const url of ['vidcapture://updates','vidcapture://updates/'])assert.equal(updateLinkRequest(['app','--open-update-link',url]).valid,true);
 for(const url of ['vidcapture://updates?url=https://example.com','vidcapture://updates#x','vidcapture://updates/else','vidcapture://user@updates','vidcapture://updates:9','vidcapture://record','file:///tmp/app','--toggle-recording','vidcapture://updates --toggle-recording'])assert.equal(updateLinkRequest(['app','--open-update-link',url]).valid,false,url);
 assert.equal(updateLinkRequest(['app','--open-update-link','vidcapture://updates','--toggle-recording']).valid,false);
 assert.equal(updateLinkRequest(['app','--toggle-recording']).present,false);
 const reordered=['electron','--ozone-platform=wayland','--open-update-link','--allow-file-access-from-files','/app','vidcapture://updates'];
 assert.equal(updateLinkRequest(reordered).valid,true);
 for(const extra of ['--toggle-recording','--panel','vidcapture://updates','--open-update-link'])assert.equal(updateLinkRequest([...reordered,extra]).valid,false,extra);
});
async function fixture(t){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),"vc-links-' "));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const root=path.join(home,'app'),launcher=path.join(home,'.local/bin/capture'),apps=path.join(home,'.local/share/applications');await fs.mkdir(root);await fs.mkdir(path.dirname(launcher),{recursive:true});
 await fs.writeFile(launcher,`#!/usr/bin/env bash\n# Capture local recorder launcher\n# Capture source: ${Buffer.from(root).toString('base64')}\nexec /usr/bin/node x\n`);
 const calls=[];let registered=false,other='';
 const env={HOME:home,XDG_DATA_HOME:path.join(home,'.local/share'),XDG_CONFIG_HOME:path.join(home,'.config')};
 const runner=async(cmd,args)=>{calls.push([cmd,...args]);if(cmd==='update-desktop-database')registered=true;return {stdout:cmd==='xdg-mime'?(other||(registered?'vidcapture-url.desktop':'')):''};};
 return {home,root,env,runner,calls,apps,file:path.join(apps,'vidcapture-url.desktop'),other:value=>other=value};
}
test('registration points to the installed launcher and does not set MIME defaults',async t=>{
 const f=await fixture(t);await registerUpdateLink(f);const text=await fs.readFile(f.file,'utf8');assert.match(text,/NoDisplay=true/);assert.ok(text.includes(execPath(path.join(f.home,'.local/bin/capture'))+' --open-update-link %u'));assert.match(text,/MimeType=x-scheme-handler\/vidcapture;/);
 assert.ok(f.calls.every(c=>c[0]!=='xdg-mime'||c[1]==='query'));
 await registerUpdateLink(f);assert.equal(await fs.readFile(f.file,'utf8'),text);
 await removeUpdateLink(f);await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
});
test('registration preserves unrelated entries and existing protocol choices',async t=>{
 const f=await fixture(t);await fs.mkdir(f.apps,{recursive:true});await fs.writeFile(f.file,'unrelated');await assert.rejects(registerUpdateLink(f),/unrelated/);await removeUpdateLink(f);assert.equal(await fs.readFile(f.file,'utf8'),'unrelated');await fs.unlink(f.file);
 f.other('another-app.desktop');await assert.rejects(registerUpdateLink(f),/association was preserved/);await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
});
test('uninstalled checkouts and symlink entries cannot overwrite the installed handler',async t=>{
 const f=await fixture(t);await assert.rejects(registerUpdateLink({...f,root:__dirname}),/Only the installed/);
 await fs.mkdir(f.apps,{recursive:true});await fs.writeFile(path.join(f.home,'target'),'preserve');await fs.symlink(path.join(f.home,'target'),f.file);await assert.rejects(registerUpdateLink(f),/unrelated/);assert.equal(await fs.readFile(path.join(f.home,'target'),'utf8'),'preserve');
});
test('desktop command quoting rejects control characters and escapes reserved codes',()=>{
 assert.equal(execPath('/some home/app'), '"/some home/app"');assert.ok(execPath('/home/percent%u/app').includes('%%u'));assert.throws(()=>execPath('/home/a\nb/app'));assert.throws(()=>execPath('/home/a=b/app'));
});
