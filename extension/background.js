'use strict';
// Commands finish here even when Chrome closes the toolbar popup.
const HOST='stream.vidcapture.launcher';
let port=null,idleTimer=null;
const waiting=new Map();
function disconnect(){if(port){const p=port;port=null;p.disconnect();}}
function connect(){
 if(port)return port;
 port=chrome.runtime.connectNative(HOST);
 const current=port;
 port.onMessage.addListener(message=>{
  const request=waiting.get(message.id);if(!request)return;
  clearTimeout(request.timer);waiting.delete(message.id);request.resolve(message);
  if(!waiting.size){clearTimeout(idleTimer);idleTimer=setTimeout(disconnect,15000);}
 });
 port.onDisconnect.addListener(()=>{
  if(port!==current)return;
  const error=chrome.runtime.lastError?.message||'The desktop connection closed. Reopen VidCapture to check its status.';port=null;
  for(const request of waiting.values()){clearTimeout(request.timer);request.resolve({ok:false,error});}waiting.clear();
 });
 return port;
}
function call(message){return new Promise(resolve=>{
 clearTimeout(idleTimer);
 const id=crypto.randomUUID();
 const timer=setTimeout(()=>{waiting.delete(id);resolve({ok:false,error:'VidCapture is still responding. Reopen the panel to check its status.'});if(!waiting.size)disconnect();},175000);
 waiting.set(id,{resolve,timer});
 try{connect().postMessage({...message,id});}catch(e){clearTimeout(timer);waiting.delete(id);resolve({ok:false,error:e.message});}
});}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return;
 call(message).then(reply);return true;
});
