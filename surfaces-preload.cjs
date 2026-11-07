const {contextBridge,ipcRenderer}=require('electron');
const api={};
for(const name of ['pickerData','setMode','select','confirm','cancel','openPicker','closeBar','controlsState','pause','stop','expand'])api[name]=(...args)=>ipcRenderer.invoke(`vc:${name}`,...args);
api.on=(channel,callback)=>{
  if(!['mode','selection','state','expanded'].includes(channel))throw new Error('Unknown channel.');
  const listener=(_event,data)=>callback(data);ipcRenderer.on(`vc:${channel}`,listener);return()=>ipcRenderer.removeListener(`vc:${channel}`,listener);
};
contextBridge.exposeInMainWorld('vidcapture',api);
