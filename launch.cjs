// Place only the Electron process started by this launcher on the laptop display.
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile),wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const monitors=JSON.parse((await run('hyprctl',['monitors','-j'])).stdout);
 const laptop=monitors.find(m=>/^eDP|^LVDS/.test(m.name))||monitors.find(m=>m.focused)||monitors[0];
 if(!laptop)throw new Error('VidCapture needs an active Hyprland display.');
 await run('hyprctl',['eval',`hl.window_rule({name="capture-app",match={class="^capture$",title="^VidCapture$"},float=true,monitor=${JSON.stringify(laptop.name)},size={820,650},center=true,opacity="1.0 override 1.0 override",border_size=0,rounding=12})`]);
 const child=spawn('/usr/bin/electron43',['--ozone-platform=wayland',__dirname,...process.argv.slice(2)],{stdio:'inherit'});
 child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code||0;});
 for(let i=0;i<50;i++){
  if(child.exitCode!==null||child.signalCode)return;
  const clients=JSON.parse((await run('hyprctl',['clients','-j'])).stdout);
  const c=clients.find(c=>c.pid===child.pid&&c.class==='capture'&&c.title==='VidCapture'&&c.mapped);
  if(c){
   const target=`address:${c.address}`;
   const x=Math.floor(laptop.x+(laptop.width/laptop.scale-820)/2),y=Math.floor(laptop.y+(laptop.height/laptop.scale-650)/2);
   for(const command of [
    `hl.dsp.window.move({window="${target}",monitor=${JSON.stringify(laptop.name)},follow=false})`,
    `hl.dsp.window.float({window="${target}",action="set"})`,
    `hl.dsp.window.resize({window="${target}",x=820,y=650})`,
    `hl.dsp.window.move({window="${target}",x=${x},y=${y}})`
   ])await run('hyprctl',['dispatch',command]);
   await wait(300);
   const current=JSON.parse((await run('hyprctl',['clients','-j'])).stdout).find(w=>w.pid===child.pid&&w.title==='VidCapture');
   if(current?.floating && current.monitor===laptop.id && current.size[0]===820)return;
  }
  await wait(100);
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
