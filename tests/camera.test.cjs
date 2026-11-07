const {test}=require('node:test');
const assert=require('node:assert/strict');
const {cameraMode}=require('../camera.cjs');
test('camera chooses native 4K MJPEG at 30 fps and rejects slow modes',()=>{
 const listing="[0]: 'YUYV'\nSize: Discrete 1920x1080\nInterval: Discrete 0.033s (30.000 fps)\n[1]: 'MJPG'\nSize: Discrete 1280x720\nInterval: Discrete 0.033s (30.000 fps)\nSize: Discrete 1920x1080\nInterval: Discrete 0.033s (30.000 fps)\nSize: Discrete 3840x2160\nInterval: Discrete 0.033s (30.000 fps)";
 assert.deepEqual(cameraMode(listing),{width:3840,height:2160,format:'MJPG',fps:30,input:'mjpeg',circle:2160});
 assert.equal(cameraMode(listing.replace('Size: Discrete 3840x2160\nInterval: Discrete 0.033s (30.000 fps)','Size: Discrete 3840x2160\nInterval: Discrete 0.067s (15.000 fps)')).height,1080);
});
test('raw-only and unknown cameras retain bounded compatible modes',()=>{
 assert.equal(cameraMode("[0]: 'YUYV'\nSize: Discrete 640x480\nInterval: Discrete 0.033s (30.000 fps)\nSize: Discrete 1920x1080\nInterval: Discrete 0.033s (30.000 fps)").input,'yuyv422');
 assert.equal(cameraMode('').height,480);
});
