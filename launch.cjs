// Starts VidCapture. The main window floats, centered on the screen in use
// (Hyprland's focused monitor), never forced onto a particular display.
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
(async()=>{
 await run('hyprctl',['eval','hl.window_rule({name="capture-app",match={class="^(vid)?capture$",title="^VidCapture$"},float=true,size={820,650},center=true,opacity="1.0 override 1.0 override",border_size=0,rounding=12})']).catch(()=>{});
 const child=spawn('/usr/bin/electron43',['--ozone-platform=wayland',__dirname,...process.argv.slice(2)],{stdio:'inherit'});
 child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code||0;});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
