import {GIFEncoder,quantize,applyPalette} from './gifenc.js';
export async function makePreview(source,{signal}={}){
 const video=document.createElement('video'),local=source instanceof Blob,url=local?URL.createObjectURL(source):source;
 video.muted=true;video.playsInline=true;video.preload='auto';
 function wait(event,test,action){return new Promise((resolve,reject)=>{
  let timer;const clean=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',error);signal?.removeEventListener('abort',aborted);};
  const done=()=>{if(test()){clean();resolve();}},error=()=>{clean();reject(new Error('Could not read the video preview.'));},aborted=()=>{clean();reject(new DOMException('Canceled','AbortError'));};
  if(signal?.aborted)return aborted();video.addEventListener(event,done);video.addEventListener('error',error);signal?.addEventListener('abort',aborted,{once:true});timer=setTimeout(error,20000);action?.();done();
 });}
 try{
  await wait('loadeddata',()=>video.readyState>=2,()=>{video.src=url;});
  const canvas=document.createElement('canvas');canvas.width=640;canvas.height=400;const context=canvas.getContext('2d',{willReadFrequently:true}),encoder=GIFEncoder();let poster;
  const scale=Math.min(640/video.videoWidth,400/video.videoHeight),w=video.videoWidth*scale,h=video.videoHeight*scale;
  for(let i=0;i<18;i++){
   if(signal?.aborted)throw new DOMException('Canceled','AbortError');
   const time=Math.min(i/6,Math.max(0,video.duration-.05));
   if(Math.abs(video.currentTime-time)>.0001)await wait('seeked',()=>!video.seeking&&video.readyState>=2,()=>{video.currentTime=time;});
   context.fillStyle='#1a1917';context.fillRect(0,0,640,400);context.drawImage(video,(640-w)/2,(400-h)/2,w,h);
   context.fillStyle='rgba(55,91,67,.94)';context.beginPath();context.arc(320,200,46,0,2*Math.PI);context.fill();context.fillStyle='white';context.beginPath();context.moveTo(310,179);context.lineTo(310,221);context.lineTo(342,200);context.closePath();context.fill();
   if(i===0)poster=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.88));
   const pixels=context.getImageData(0,0,640,400).data,palette=quantize(pixels,160);encoder.writeFrame(applyPalette(pixels,palette),640,400,{palette,delay:170,repeat:0});
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  encoder.finish();const gif=new Blob([encoder.bytes()],{type:'image/gif'});
  if(!poster||gif.size>5*1024**2)throw new Error('The video preview could not be created.');
  return {gif,poster};
 }finally{video.removeAttribute('src');video.load();if(local)URL.revokeObjectURL(url);}
}
