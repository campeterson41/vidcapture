'use strict';
// Background blur and replacement for the camera bubble. The work happens in
// camera_effects.py (a separate process on the NVIDIA GPU); this module finds the
// installed runtime, keeps the user's background images, and talks to a running
// effect over its control socket so strength and image change without a restart.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');

const BLUR={light:0.35,medium:0.6,strong:0.9};
const IMAGE=/^[\w][\w .,()'-]{0,120}\.(jpe?g|png|webp)$/i;
const MAX_IMAGE=40*1024*1024;

function validImageName(name){return typeof name==='string'&&IMAGE.test(name)&&!name.includes('..');}

class CameraEffects{
  constructor(options={}){
    this.root=options.root||process.env.VIDCAPTURE_EFFECTS_DIR||path.join(os.homedir(),'.local/share/vidcapture-effects');
    this.python=path.join(this.root,'venv/bin/python');
    this.model=path.join(this.root,'models/camera-effects.onnx');
    this.script=options.script||path.join(__dirname,'camera_effects.py');
    this.backgrounds=options.backgrounds||path.join(os.homedir(),'.config/vidcapture/backgrounds');
  }
  async available(){try{await fs.access(this.python);await fs.access(this.model);await fs.access(this.script);return true;}catch{return false;}}
  strength(setting){return BLUR[setting]??BLUR.medium;}
  imagePath(name){if(!validImageName(name))throw new Error('Choose a background image first.');return path.join(this.backgrounds,name);}
  async images(){
    const names=await fs.readdir(this.backgrounds).catch(()=>[]);
    return names.filter(validImageName).sort((a,b)=>a.localeCompare(b));
  }
  // Copies a chosen picture into VidCapture's backgrounds folder and returns its name.
  async addImage(file){
    const st=await fs.stat(file);
    if(!st.isFile())throw new Error('Choose an image file.');
    if(st.size>MAX_IMAGE)throw new Error('Choose an image smaller than 40 MB.');
    let base=path.basename(file).replace(/[^\w .,()'-]/g,'-').replace(/^[^\w]+/,'');
    if(!validImageName(base))throw new Error('Choose a JPEG, PNG or WebP image.');
    await fs.mkdir(this.backgrounds,{recursive:true,mode:0o700});
    const ext=path.extname(base),stem=base.slice(0,-ext.length);
    for(let i=1;;i++){
      const name=i===1?base:`${stem} ${i}${ext}`;
      try{await fs.copyFile(file,path.join(this.backgrounds,name),fs.constants.COPYFILE_EXCL);return name;}
      catch(e){if(e.code!=='EEXIST')throw e;if(i>200)throw new Error('Too many images with that name.');}
    }
  }
  async removeImage(name){await fs.rm(this.imagePath(name),{force:true});}
  // Arguments for camera_effects.py; input is the bounded transport or a V4L2 device.
  args({size,input,render,device,mode,settings,socket}){
    const effect=settings.cameraBackground;
    const out=[this.script,'--model',this.model,'--size',String(size),'--socket',socket,
      '--mode',effect==='image'?'image':'blur','--blur',String(this.strength(settings.cameraBlur)),
      '--width',String(mode.width),'--height',String(mode.height),'--fps',String(mode.fps||30)];
    if(effect==='image')out.push('--background',this.imagePath(settings.cameraBackgroundImage));
    if(input==='transport')out.push('--input','transport','--render',render);
    else out.push('--input','v4l2','--device',device,...(mode.input?['--format',mode.input]:[]));
    return out;
  }
  // Sends one change to a running effect and waits for its answer.
  send(socket,message){
    return new Promise((resolve,reject)=>{
      const c=net.createConnection(socket);let buf='';let done=false;
      const finish=(e,v)=>{if(done)return;done=true;c.destroy();e?reject(e):resolve(v);};
      c.setTimeout(3000,()=>finish(new Error('The camera effect did not respond.')));
      c.once('error',finish);
      c.once('connect',()=>c.write(JSON.stringify(message)+'\n'));
      c.on('data',b=>{buf+=b;const i=buf.indexOf('\n');if(i>=0){try{const r=JSON.parse(buf.slice(0,i));r.ok?finish(null,r):finish(new Error(r.error||'The camera effect could not change.'));}catch(e){finish(e);}}});
      c.once('close',()=>finish(new Error('The camera effect closed.')));
    });
  }
}

module.exports={CameraEffects,validImageName,BLUR};
