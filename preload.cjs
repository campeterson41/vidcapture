const {contextBridge,ipcRenderer}=require('electron');
const api={};
for(const name of ['getState','listWindows','refreshDevices','saveSettings','chooseTarget','start','pause','stop','previewCamera','openFile','openFolder','minimize','close','getMedia','getWaveform','saveEdits','exportEdit','enhanceAudio','enhanceAudioFast','enhanceAudioQuick','cancelJob','publishVideo','openLibrary','copyShareLink','copyShareCard','openShareLink','openBar','pickOnScreen'])api[name]=(...args)=>ipcRenderer.invoke(`capture:${name}`,...args);
api.onState=callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('capture:state',listener);return()=>ipcRenderer.removeListener('capture:state',listener);};
contextBridge.exposeInMainWorld('capture',api);
