const net=require('node:net');
// Prefer compressed HD input without requesting modes the camera cannot supply.
function cameraMode(formats) {
  const modes=[];
  let format=null,size=null;
  for(const line of formats.split('\n')) {
    const f=line.match(/\[\d+\]: '([^']+)'/);
    if(f){format=f[1];size=null;continue;}
    const s=line.match(/Size: Discrete (\d+)x(\d+)/);
    if(s){size={width:+s[1],height:+s[2]};continue;}
    const fps=line.match(/\(([\d.]+) fps\)/);
    if(fps&&size&&+fps[1]===30&&['MJPG','YUYV','NV12'].includes(format)&&size.width<=3840&&size.height<=2160) {
      modes.push({...size,format,fps:30});
    }
  }
  // Raw HD consumes substantially more USB bandwidth; prefer MJPEG when present.
  const compressed=modes.filter(m=>m.format==='MJPG');
  const candidates=compressed.length?compressed:modes.filter(m=>m.width<=1280&&m.height<=720);
  candidates.sort((a,b)=>b.height-a.height||b.width-a.width);
  const mode=candidates[0]||{width:640,height:480,fps:30,format:null};
  return {...mode,input:({MJPG:'mjpeg',YUYV:'yuyv422',NV12:'nv12'})[mode.format]||null,circle:mode.height};
}
// Shader-safe number literal.
const glsl=v=>{const n=Number(v);if(!Number.isFinite(n))throw new Error('Invalid lens correction value.');const t=String(n);return /[.e]/.test(t)?t:t+'.0';};
// The mode for a camera-only take: the full frame at 30 fps, compressed when the
// camera offers it. 1080p caps the mode at 1920x1080; Match source takes the
// largest the camera supplies, up to 4K. pixfmt is GPU Screen Recorder's name.
function cameraRecordMode(formats,resolution='1920x1080'){
  const modes=[];let format=null,size=null;
  for(const line of String(formats).split('\n')){
    const f=line.match(/\[\d+\]: '([^']+)'/);
    if(f){format=f[1];size=null;continue;}
    const s=line.match(/Size: Discrete (\d+)x(\d+)/);
    if(s){size={width:+s[1],height:+s[2]};continue;}
    const fps=line.match(/\(([\d.]+) fps\)/);
    if(fps&&size&&+fps[1]===30&&['MJPG','YUYV'].includes(format))modes.push({...size,format});
  }
  const cap=resolution==='0x0'?{width:3840,height:2160}:{width:1920,height:1080};
  const fit=modes.filter(m=>m.width<=cap.width&&m.height<=cap.height);
  const compressed=fit.filter(m=>m.format==='MJPG');
  // Raw frames above 720p rarely reach 30 fps over USB.
  const candidates=compressed.length?compressed:fit.filter(m=>m.height<=720);
  candidates.sort((a,b)=>b.height*b.width-a.height*a.width);
  const mode=candidates[0];
  if(!mode)return {width:0,height:0,fps:0,pixfmt:'auto'};
  return {width:mode.width,height:mode.height,fps:30,pixfmt:mode.format==='MJPG'?'mjpeg':'yuyv'};
}
function cameraShader({correction=null,lighting='original'}={}) {
  // correction comes from a camera profile: radial and offset coefficients in
  // half-image-height units. The input is the center square.
  const correct=!!correction;
  const [k0,k1,k2]=correct?correction.radial.map(glsl):[];
  const [ox,oy]=correct?correction.offset.map(glsl):[];
  return `//!HOOK MAIN
//!BIND HOOKED
//!DESC Capture camera processing
//!COMPONENTS 4
vec4 hook() {
    vec2 p = (HOOKED_pos - vec2(0.5)) * 2.0;
    float r2 = dot(p, p);
    vec2 source = HOOKED_pos;
    ${correct?`float radial = ${k0} + (${k1}) * r2 + (${k2}) * r2 * r2;\n    source = (p * radial + vec2(${ox}, ${oy})) * 0.5 + vec2(0.5);`:''}
    vec4 color = HOOKED_tex(source);
    ${lighting==='balanced'?`float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    float adjusted = luma + 0.8 * luma * (1.0 - luma) * (0.5 - luma);
    color.rgb = clamp(color.rgb * (adjusted / max(luma, 0.00001)), 0.0, 1.0);`:''}
    float edge = 4.0 / min(HOOKED_size.x, HOOKED_size.y);
    color.a *= 1.0 - smoothstep(1.0 - edge, 1.0, length(p));
    return color;
}
`;
}
function cameraCommand(socket,command) {
  return new Promise((resolve,reject)=>{
    const client=net.createConnection(socket);let buffer='';let settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;client.destroy();error?reject(error):resolve(value);};
    client.setTimeout(2000,()=>finish(new Error('Camera preview did not respond.')));
    client.once('error',error=>finish(error));
    client.once('close',()=>finish(new Error('Camera preview closed.')));
    client.once('connect',()=>client.write(JSON.stringify({command,request_id:1})+'\n'));
    client.on('data',chunk=>{
      buffer+=chunk;
      let end;
      while((end=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try {const reply=JSON.parse(line);if(reply.request_id===1)finish(reply.error==='success'?null:new Error(reply.error),reply.data);}catch{}
      }
    });
  });
}
module.exports={cameraMode,cameraRecordMode,cameraShader,cameraCommand};
