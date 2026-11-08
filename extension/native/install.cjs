#!/usr/bin/node
'use strict';
// Registration only: never edit launch flags, stop a browser, or run the app.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const ID='dagpaflngbhbgpeichcnhalplkdmkfie',HOST='stream.vidcapture.launcher';
function parse(args){
 const out={browser:'all',userDataDir:null};
 for(let i=0;i<args.length;i++){
  const arg=args[i];if(arg==='--help'||arg==='-h')return {help:true};
  if(arg==='--browser'){out.browser=args[++i];if(!['chromium','chrome','all'].includes(out.browser))throw Error('Use --browser chromium, chrome, or all.');}
  else if(arg==='--user-data-dir'){out.userDataDir=args[++i];if(!out.userDataDir||!path.isAbsolute(out.userDataDir))throw Error('--user-data-dir must be an absolute path.');}
  else throw Error('Unknown option: '+arg);
 }
 if(out.userDataDir&&out.browser==='all')throw Error('Choose one --browser when using --user-data-dir.');return out;
}
function main(args=process.argv.slice(2),context={}){
 const log=context.log||console.log;
 const options=parse(args);
 if(options.help){log('Usage: bash native/install.sh [--browser chromium|chrome|all] [--user-data-dir /absolute/browser/data]\nRegisters only this extension’s native host. Launch flags and browser sessions are left alone.');return;}
 if(process.platform!=='linux')throw Error('Recording controls currently require the VidCapture desktop app on Omarchy/Linux.');
 const root=fs.realpathSync(path.join(__dirname,'..')),host=path.join(root,'native/vidcapture-native-host');
 if(/[\x00-\x1f\x7f]/.test(root))throw Error('Choose a lasting extension folder without control characters in its name.');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 const id=crypto.createHash('sha256').update(Buffer.from(manifest.key||'','base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 if(id!==ID)throw Error('The extension key does not match the supported VidCapture extension.');
 const home=context.home||os.homedir(),config=context.configHome||process.env.XDG_CONFIG_HOME||path.join(home,'.config');
 if(!path.isAbsolute(config))throw Error('XDG_CONFIG_HOME must be an absolute path.');
 const launcher=path.join(home,'.local/bin/capture');
 try{if(!fs.statSync(launcher).isFile())throw Error();fs.accessSync(launcher,fs.constants.X_OK);}catch{throw Error('Install the VidCapture desktop app first. Its launcher must be executable at ~/.local/bin/capture.');}
 if(!fs.statSync(host).isFile())throw Error('The native host is missing. Extract the complete extension ZIP.');
 fs.chmodSync(host,0o755);
 const targets=options.userDataDir?[options.userDataDir]:options.browser==='all'?[path.join(config,'chromium'),path.join(config,'google-chrome')]:[path.join(config,options.browser==='chrome'?'google-chrome':'chromium')];
 const body=JSON.stringify({name:HOST,description:'Connects the VidCapture extension to the local desktop recorder',path:host,type:'stdio',allowed_origins:[`chrome-extension://${ID}/`]},null,2)+'\n';
 for(const target of targets){
  const folder=path.join(target,'NativeMessagingHosts'),file=path.join(folder,HOST+'.json');fs.mkdirSync(folder,{recursive:true,mode:0o700});
  let previous=null;
  try{const stat=fs.lstatSync(file);if(!stat.isFile())throw Error('Existing native-host registration is not a regular file: '+file);previous=fs.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(previous!==body){
   if(previous!==null){const backup=file+'.before-vidcapture-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');fs.writeFileSync(backup,previous,{mode:0o600,flag:'wx'});log('Preserved previous registration: '+backup);}
   const temp=file+'.'+process.pid+'.tmp';try{fs.writeFileSync(temp,body,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  log('Native host registered: '+file);
 }
 log('Load this folder with Chrome’s Load unpacked control: '+root+'\nThen pin VidCapture and open it. Verify “Connected to desktop app” in the popup.\nNo browser launch flags were changed. No browser or recorder was started or restarted.');
}
if(require.main===module){try{main();}catch(e){console.error('VidCapture setup: '+e.message);process.exitCode=1;}}
module.exports={main,parse};
