'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{registerHooks}=require('node:module');
registerHooks({resolve(s,c,next){if(s.startsWith('./')&&!path.extname(s)&&c.parentURL?.includes('/cloud/src/'))s+='.ts';return next(s,c);}});
const load=()=>import(pathToFileURL(path.resolve(__dirname,'../cloud/src/app-updates.ts')).href);
test('release notice links only to fixed updater URI and retains visible fallback',async()=>{
 const {updateBanner,appRelease}=await load(),html=updateBanner();assert.ok(html.includes('href="vidcapture://updates"'));assert.ok(html.includes('href="/update"'));assert.ok(html.includes('data-dismiss-update'));assert.ok(html.includes(`data-release="${appRelease.version}"`));assert.equal(html.includes('updated successfully'),false);
});
test('update page explains both prior updater and pre-updater migration paths',async()=>{
 const {updatePage,appRelease}=await load(),html=updatePage();for(const s of ['If your app has an Updates button','If your app has no Updates button','alpha.7 and earlier','separate folder','cannot inspect an offline app','Future releases remain optional','git clone --depth 1 --branch '+appRelease.tag,'./engine/build-camera.sh','./install.sh','SHA256SUMS','data-copy-update'])assert.ok(html.includes(s),s);
 assert.equal(/curl[^\n]*\|\s*(?:sh|bash)/.test(html),false);assert.equal(html.includes('rm -rf'),false);
});

test('required migration notice cannot be dismissed and links to the older-app guide',async()=>{
 const {updateBanner,updatePage}=await load(),html=updateBanner(true);assert.match(html,/data-required="true"/);assert.match(html,/One-time update required/);assert.match(html,/href="\/update"/);assert.doesNotMatch(html,/data-dismiss-update/);assert.match(updatePage(true,true),/data-check-upgrade/);
});

test('required baseline stays fixed when a newer optional release is advertised',async()=>{
 const {updatePage,appRelease}=await load(),previous=appRelease.version;try{appRelease.version='999.0.0';const html=updatePage();assert.match(html,/It applies to desktop releases before 0.1.0-alpha.11/);assert.doesNotMatch(html,/releases before 999/);}finally{appRelease.version=previous;}
});
