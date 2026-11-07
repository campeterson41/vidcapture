const fs=require('node:fs/promises'),path=require('node:path');
async function createThumbnail(media,file,folder){
 const gif=path.join(folder,'preview.gif'),poster=path.join(folder,'poster.jpg'),badge=path.join(__dirname,'ui/share-play.svg');
 const base='[0:v]fps=6,scale=640:400:force_original_aspect_ratio=decrease,pad=640:400:(ow-iw)/2:(oh-ih)/2:color=0x1a1917,setsar=1[base];[base][1:v]overlay=(W-w)/2:(H-h)/2:format=auto';
 await media.process('ffmpeg',['-nostdin','-v','error','-threads','2','-ss','0','-t','3','-i',file,'-i',badge,'-filter_complex_threads','2','-filter_complex',base+',split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3','-an','-loop','0','-n',gif]);
 await media.process('ffmpeg',['-nostdin','-v','error','-threads','2','-i',file,'-i',badge,'-filter_complex_threads','2','-filter_complex',base,'-frames:v','1','-an','-q:v','3','-n',poster]);
 if((await fs.stat(gif)).size>5*1024**2||(await fs.stat(poster)).size>2*1024**2)throw new Error('The video preview is too large.');
 return {gif,poster};
}
module.exports={createThumbnail};
