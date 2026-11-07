const ORIGIN='https://vidcapture.stream';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function shareCard(video,origin=ORIGIN){
 const match=typeof video?.url==='string'&&/^https?:\/\/[^/]+\/v\/([a-f0-9]{48})$/.exec(video.url);
 if(!match||video.url!==origin+'/v/'+match[1]||typeof video.title!=='string'||!video.title.trim())throw new Error('No video card is ready.');
 const title=escape(video.title),url=escape(video.url),image=`${origin}/thumbnail/${match[1]}.gif`;
 return {text:video.url,html:`<div><a href="${url}" style="font-family:Arial,sans-serif;font-size:18px;font-weight:600;color:#253e2e;text-decoration:underline">${title}</a><br><br><a href="${url}"><img src="${image}" width="480" height="300" alt="Play ${title}" style="display:block;width:480px;max-width:100%;height:auto;border:0"></a><a href="${url}" style="font-family:Arial,sans-serif;font-size:13px;color:#73786e">${url}</a></div>`};
}
module.exports={shareCard};
