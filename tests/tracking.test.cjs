const {test}=require('node:test');
const assert=require('node:assert/strict');
const {selectedWindow,windowTarget,matchingWindow,containingMonitor,physicalRegion}=require('../tracking.cjs');
const {cameraGeometry}=require('../recorder.cjs');
const client={address:'0x123',pid:123,stableId:'abc',class:'editor',title:'My walkthrough',mapped:true,hidden:false,visible:true,at:[100,120],size:[800,480],focusHistoryID:0};
test('window picking records identity and ignores Capture and hidden windows',()=>{
 const area={x:100,y:120,width:800,height:480};
 assert.equal(selectedWindow([{...client,class:'capture'},{...client,hidden:true},client],area),client);
 const target=windowTarget(client);assert.equal(target.label,'My walkthrough');
 assert.equal(matchingWindow([{...client,pid:999}],target),undefined);
 assert.equal(matchingWindow([{...client,stableId:'replacement'}],target),undefined);
 assert.equal(matchingWindow([client],target),client);
});
test('tracked positions convert logical scaled desktop coordinates into physical crop coordinates',()=>{
 const monitor={id:'laptop',x:-1280,y:0,width:1280,height:720,scale:1.5};
 const target={x:-1180,y:120,width:800,height:480};
 assert.equal(containingMonitor([monitor],target),monitor);
 assert.deepEqual(physicalRegion(target,monitor),[150,180,1200,720]);
 assert.equal(containingMonitor([monitor],{...target,x:-200}),undefined);
});
test('camera sizes grow visibly and remain proportional to a larger selected window',()=>{
 const small={x:0,y:0,width:800,height:480},large={x:1280,y:0,width:1700,height:1390};
 const sizes=['small','medium','large'].map(size=>cameraGeometry(small,size,'bottom-left').size);
 assert.deepEqual(sizes,[106,163,230]);
 assert.ok(cameraGeometry(large,'large','bottom-right').size>600);
});

test('manual camera placement follows target movement and stays within bounds after resize',()=>{
 const target={x:100,y:50,width:1000,height:600},placement={x:.4,y:.2};
 const a=cameraGeometry(target,'large','bottom-left',placement);
 const b=cameraGeometry({...target,x:350,y:120},'large','bottom-left',placement);
 assert.equal(b.x-a.x,250);assert.equal(b.y-a.y,70);
 const small={x:-900,y:100,width:600,height:400};
 const c=cameraGeometry(small,'large','bottom-right',{x:5,y:-2});
 assert.ok(c.x+c.size<=small.x+small.width-16);assert.equal(c.y,small.y+16);
});
