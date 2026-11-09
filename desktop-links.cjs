'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const run=require('node:util').promisify(require('node:child_process').execFile);
const installEnv=(home,env)=>env.CAPTURE_INSTALL_HOME?{...env,HOME:home,XDG_DATA_HOME:path.join(home,'.local/share'),XDG_CONFIG_HOME:path.join(home,'.config')}:env;
const NAME='vidcapture-url.desktop',MIME='x-scheme-handler/vidcapture',MARKER='X-VidCapture-URL-Owned=true';
function updateLinkRequest(argv){
 const present=argv.includes('--open-update-link');
 const links=argv.filter(arg=>/^vidcapture:/i.test(arg));
 const actions=new Set(['--toggle-recording','--toggle-pause','--panel','--pick','--extension-service']);
 // Electron can reorder arguments and add switches for a second instance.
 const valid=present&&argv.filter(arg=>arg==='--open-update-link').length===1&&links.length===1
  &&/^vidcapture:\/\/updates\/?$/.test(links[0])&&!argv.some(arg=>actions.has(arg)||/^--(screen|x)=/.test(arg));
 return {present,valid};
}
function execPath(value){
 if(/[\r\n\0=]/.test(value))throw new Error('The app launcher path is not supported by desktop links.');
 return '"'+value.replace(/\\/g,'\\\\\\\\').replace(/["`$]/g,'\\\\$&').replace(/%/g,'%%')+'"';
}
async function registerUpdateLink({home=os.homedir(),root=__dirname,runner=run,env=process.env}={}){
 env=installEnv(home,env);
 const launcher=path.join(home,'.local/bin/capture');
 const stat=await fs.lstat(launcher),text=await fs.readFile(launcher,'utf8');
 const marker='# Capture source: '+Buffer.from(await fs.realpath(root)).toString('base64');
 if(!stat.isFile()||!text.startsWith('#!/usr/bin/env bash\n# Capture local recorder launcher\n')||!(text.split('\n').includes(marker)||text.includes(path.join(root,'launch.cjs'))))throw new Error('Only the installed app can register its update link.');
 const apps=path.join(env.XDG_DATA_HOME||path.join(home,'.local/share'),'applications'),file=path.join(apps,NAME);
 let previous=null;
 try{const s=await fs.lstat(file);if(!s.isFile())throw new Error('An unrelated desktop link was preserved.');previous=await fs.readFile(file,'utf8');if(!previous.split('\n').includes(MARKER))throw new Error('An unrelated desktop link was preserved.');}catch(e){if(e.code!=='ENOENT')throw e;}
 const options={timeout:5000,env:{...env,HOME:home},maxBuffer:1024*1024};
 const current=(await runner('xdg-mime',['query','default',MIME],options)).stdout.trim();
 if(current&&current!==NAME)throw new Error('Another application handles VidCapture links. Its association was preserved.');
 const entry=`[Desktop Entry]\nType=Application\nName=VidCapture updates\nNoDisplay=true\nExec=${execPath(launcher)} --open-update-link %u\nTerminal=false\nMimeType=${MIME};\n${MARKER}\n`;
 await fs.mkdir(apps,{recursive:true});
 if(previous!==entry){const temp=file+'.'+process.pid+'.tmp';try{await fs.writeFile(temp,entry,{mode:0o644,flag:'wx'});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}
 // Publishing our owned MIME entry is enough; do not change mimeapps.list or other defaults.
 await runner('update-desktop-database',[apps],options);
 const selected=(await runner('xdg-mime',['query','default',MIME],options)).stdout.trim();
 if(selected!==NAME)throw new Error('The desktop could not resolve the VidCapture update link. Open Updates in the app instead.');
 return {registered:true,file};
}
async function removeUpdateLink({home=os.homedir(),env=process.env,runner=run}={}){
 env=installEnv(home,env);
 const apps=path.join(env.XDG_DATA_HOME||path.join(home,'.local/share'),'applications'),file=path.join(apps,NAME);
 try{const stat=await fs.lstat(file);if(!stat.isFile())return;const text=await fs.readFile(file,'utf8');if(!text.split('\n').includes(MARKER))return;await fs.unlink(file);await runner('update-desktop-database',[apps],{timeout:5000,env:{...env,HOME:home}});}catch(e){if(e.code!=='ENOENT')throw e;}
}
module.exports={updateLinkRequest,registerUpdateLink,removeUpdateLink,execPath};
if(require.main===module){const home=process.argv[3]||os.homedir();const action=process.argv[2]==='remove'?removeUpdateLink:registerUpdateLink;action({home}).then(()=>console.log('VidCapture update link configured.')).catch(e=>{console.error(e.message);process.exitCode=1;});}
