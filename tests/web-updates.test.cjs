'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{registerHooks}=require('node:module');
registerHooks({resolve(s,c,next){if(s.startsWith('./')&&!path.extname(s)&&c.parentURL?.includes('/cloud/src/'))s+='.ts';return next(s,c);}});
const load=()=>import(pathToFileURL(path.resolve(__dirname,'../cloud/src/app-updates.ts')).href);
test('release notice links only to fixed updater URI and retains visible fallback',async()=>{
 const {updateBanner,appRelease}=await load(),html=updateBanner();assert.ok(html.includes('href="vidcapture://updates"'));assert.ok(html.includes('href="/update"'));assert.ok(html.includes('data-dismiss-update'));assert.ok(html.includes(`data-release="${appRelease.version}"`));assert.equal(html.includes('updated successfully'),false);
});
test('update page explains both prior updater and pre-updater migration paths',async()=>{
 const {updatePage,appRelease}=await load(),html=updatePage();for(const s of ['If your app has an Updates button','If your app has no Updates button','alpha.7 and earlier','separate folder','cannot see your installed version','cannot','git clone --depth 1 --branch '+appRelease.tag,'./engine/build-camera.sh','./install.sh','SHA256SUMS','data-copy-update'])assert.ok(html.includes(s),s);
 assert.equal(/curl[^\n]*\|\s*(?:sh|bash)/.test(html),false);assert.equal(html.includes('rm -rf'),false);
});
