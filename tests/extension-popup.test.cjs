const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const elements=new Map();
function el(id){if(!elements.has(id))elements.set(id,{id,dataset:{},options:[],value:'',disabled:false,hidden:false,firstChild:{textContent:''},setAttribute(k,v){this[k]=v},querySelector(){return el(id+'-span')},replaceChildren(...options){this.options=options;this.value=options[0]?.value||''}});return elements.get(id)}
const modes=['monitor','window','region','camera'].map(mode=>{const e=el('mode-'+mode);e.dataset.mode=mode;return e});
let selected={phase:'idle',target:{kind:'monitor',monitor:'display',label:'Entire display'},settings:{camera:'none',microphone:'none',systemAudio:false,countdown:0},devices:{cameras:[],microphones:[],monitors:[{id:'display',name:'Entire display'}]}};
const calls=[];
const sandbox={console,Option:function(label,value){this.label=label;this.value=value},setInterval(){},document:{hidden:false,body:{dataset:{}},getElementById:el,querySelectorAll:sel=>sel==='[data-mode]'?modes:[],addEventListener(){}},chrome:{runtime:{sendMessage(message,reply){calls.push(message);reply({ok:true,result:message.action==='sources'?{windows:[{id:'0x123',title:'Chosen window'}]}:structuredClone(selected)})}}}};
vm.createContext(sandbox);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../extension/popup.js'),'utf8'),sandbox);
(async()=>{
 await new Promise(setImmediate);
 assert.equal(el('record').disabled,false,'initial monitor source is ready');
 await el('mode-window').onclick();
 const before={selectedMode:vm.runInContext('mode',sandbox),desktopTarget:vm.runInContext('state.target.kind',sandbox),sourceValue:el('source').value,recordDisabled:el('record').disabled};
 await el('record').onclick();
 console.log(JSON.stringify({beforeClick:before,commands:calls.map(c=>c.action),startSent:calls.some(c=>c.action==='start')},null,2));
 assert.equal(before.selectedMode,'window');assert.equal(before.sourceValue,'');assert.equal(before.recordDisabled,true);assert.equal(calls.some(c=>c.action==='start'),false,'mode switch must not start the previous screen source');
 for(const name of ['region','monitor','window']){await el('mode-'+name).onclick();const starts=calls.filter(c=>c.action==='start').length;await el('record').onclick();if(name!=='monitor')assert.equal(calls.filter(c=>c.action==='start').length,starts,'mismatched source must not start');}
 console.log('Mode changes immediately disable Start for unmatched sources.');
})().catch(e=>{console.error(e);process.exitCode=1});
