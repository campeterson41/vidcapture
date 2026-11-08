const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {registerHooks}=require('node:module');
registerHooks({resolve(specifier,context,next){if(specifier==='./extension-download'&&context.parentURL?.endsWith('/cloud/src/pages.ts'))specifier='./extension-download.ts';return next(specifier,context);}});
const load=()=>import(pathToFileURL(path.resolve(__dirname,'../cloud/src/extension-download.ts')).href);
test('homepage release gate emits no future asset or pinned-doc links before publication',async()=>{
 const {extensionDownloadSection}=await load();const html=extensionDownloadSection();assert.ok(html.includes('being prepared'));assert.equal(html.includes('/releases/download/'),false);assert.equal(html.includes('/blob/v0.1.0-alpha.7/'),false);assert.equal(html.includes('data-extension-copy'),false);
});
test('enabled section has exact prerelease asset and accessible manual/terminal/agent routes',async()=>{
 const {extensionDownloadSection,extensionRelease}=await load(),html=extensionDownloadSection({...extensionRelease,available:true});
 assert.ok(html.includes('/releases/download/v0.1.0-alpha.7/vidcapture-extension-v0.3.0.zip'));assert.ok(html.includes('vidcapture-extension-v0.3.0.zip.sha256'));assert.equal(html.includes('/releases/latest'),false);assert.ok(html.includes('chrome://extensions'));assert.ok(html.includes('Load unpacked'));assert.ok(html.includes('Requires VidCapture desktop on Omarchy/Linux'));assert.ok(html.includes('textarea id="extension-agent-prompt" readonly'));assert.ok(html.includes('aria-live="polite"'));assert.ok(html.includes('Read or select the prompt'));assert.ok(html.includes('/extension-install.js'));
});
test('copyable agent prompt is self-contained, bounded and verifies an actual loaded connection',async()=>{
 const {extensionInstallPrompt}=await load(),text=extensionInstallPrompt();for(const needed of ['v0.1.0-alpha.7','extension/INSTALL.md','Omarchy/Linux','/usr/bin/node','~/.local/bin/capture','PACKAGE-CONTENTS.json','lasting folder','dagpaflngbhbgpeichcnhalplkdmkfie','--browser chromium','--browser chrome','--user-data-dir','required approvals','Connected to desktop app','Camera & background','Extension 0.3.0'])assert.ok(text.includes(needed),needed);
 assert.ok(text.includes('Preserve'));assert.ok(text.includes('without starting a recording or changing my settings'));assert.equal(/curl[^\n]*\|\s*(?:sh|bash)/.test(text),false);
});
test('existing homepage keeps supplied demo, signed-in/out behavior and desktop install section',async()=>{
 const {homePage}=await import(pathToFileURL(path.resolve(__dirname,'../cloud/src/pages.ts')).href);
 const fixture='<section id="demo">Existing supplied demo</section>';for(const signedIn of [false,true]){const html=homePage(signedIn,fixture);assert.ok(html.includes(fixture));assert.ok(html.includes('id="install"'));assert.ok(html.includes('id="chrome-extension"'));assert.ok(html.includes('id="faq"'));assert.ok(html.includes('./engine/build-camera.sh'));assert.equal(html.includes('/releases/download/'),false);}
 assert.ok(homePage(false).includes('/login#signup'));assert.ok(homePage(true).includes('/library'));
});
