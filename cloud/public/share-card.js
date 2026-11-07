'use strict';
window.videoCard=video=>{
 const match=typeof video?.url==='string'&&/^https?:\/\/[^/]+\/v\/([a-f0-9]{48})$/.exec(video.url);
 if(!match||new URL(video.url).origin!==location.origin||typeof video.title!=='string')throw new Error('No video card is ready.');
 const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const title=escape(video.title),url=escape(video.url),image=`${location.origin}/thumbnail/${match[1]}.gif`;
 return {text:video.url,html:`<div><a href="${url}" style="font-family:Arial,sans-serif;font-size:18px;font-weight:600;color:#253e2e;text-decoration:underline">${title}</a><br><br><a href="${url}"><img src="${image}" width="480" height="300" alt="Play ${title}" style="display:block;width:480px;max-width:100%;height:auto;border:0"></a><a href="${url}" style="font-family:Arial,sans-serif;font-size:13px;color:#73786e">${url}</a></div>`};
};
// Promise representations preserve the clipboard gesture while an older video creates its preview.
window.copyVideoCard=async resolveVideo=>{
 if(!navigator.clipboard?.write||!window.ClipboardItem)throw new Error('Rich copying is unavailable in this browser. Use Copy link instead.');
 const ready=Promise.resolve().then(resolveVideo).then(window.videoCard);
 await navigator.clipboard.write([new ClipboardItem({'text/html':ready.then(c=>new Blob([c.html],{type:'text/html'})),'text/plain':ready.then(c=>new Blob([c.text],{type:'text/plain'}))})]);
};
