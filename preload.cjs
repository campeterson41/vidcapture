const {contextBridge,ipcRenderer}=require('electron');
const api={};
for(const name of ['getState','listWindows','refreshDevices','saveSettings','chooseTarget','start','pause','stop','restart','discard','previewCamera','openFile','openFolder','chooseOutputDir','minimize','close','getMedia','getWaveform','saveEdits','exportEdit','enhanceAudio','enhanceAudioFast','enhanceAudioQuick','cancelJob','publishVideo','openLibrary','copyShareLink','copyShareCard','openShareLink','openBar','pickOnScreen','sources','chooseSource','watchLevel','getTranscript','makeTranscript','cancelTranscript','studioInfo','setCameraControl','resetCameraControls','setMicLevel','addBackground','removeBackground'])api[name]=(...args)=>ipcRenderer.invoke(`capture:${name}`,...args);
api.onState=callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('capture:state',listener);return()=>ipcRenderer.removeListener('capture:state',listener);};
// Recordings library
for(const name of ['syncShares','copyLink','openLink','listRecordings','recordingDetails','setCurrentVersion'])api[name]=(...args)=>ipcRenderer.invoke(`capture:${name}`,...args);
api.onLevel=callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('capture:level',listener);return()=>ipcRenderer.removeListener('capture:level',listener);};
contextBridge.exposeInMainWorld('capture',api);
