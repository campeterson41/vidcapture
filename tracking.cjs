const ownClass=c=>/^capture(?:-|$)/.test(c.class||'');
function selectedWindow(clients,region){
  return clients.filter(c=>c.mapped&&!c.hidden&&!ownClass(c)&&c.size?.[0]>=32&&c.size?.[1]>=32)
    .filter(c=>Math.abs(c.at[0]-region.x)<=3&&Math.abs(c.at[1]-region.y)<=3&&Math.abs(c.size[0]-region.width)<=3&&Math.abs(c.size[1]-region.height)<=3)
    .sort((a,b)=>a.focusHistoryID-b.focusHistoryID)[0];
}
function windowTarget(client){
  return {kind:'window',address:client.address,pid:client.pid,stableId:client.stableId,class:client.class,label:client.title||client.class||'Selected window',x:client.at[0],y:client.at[1],width:client.size[0],height:client.size[1],available:client.mapped&&!client.hidden&&client.visible!==false};
}
function matchingWindow(clients,target){
  return clients.find(c=>c.address===target.address&&c.pid===target.pid&&(!target.stableId||target.stableId===c.stableId));
}
function containingMonitor(monitors,target){return monitors.find(m=>target.x>=m.x&&target.y>=m.y&&target.x+target.width<=m.x+m.width+1&&target.y+target.height<=m.y+m.height+1);}
function physicalRegion(target,monitor){
  const scale=monitor.scale||1;
  return [target.x-monitor.x,target.y-monitor.y,target.width,target.height].map(n=>Math.round(n*scale));
}
module.exports={selectedWindow,windowTarget,matchingWindow,containingMonitor,physicalRegion};
