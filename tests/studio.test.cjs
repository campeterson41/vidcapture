const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {parseControls,validValue,CameraSettings}=require('../camera-settings.cjs');
const {chainConfig,wanted}=require('../audio-chain.cjs');
const {buildArgs,validateSettings,DEFAULTS}=require('../recorder.cjs');

const RAZER=`
User Controls

                     brightness 0x00980900 (int)    : min=0 max=255 step=1 default=128 value=185 flags=has-min-max
        white_balance_automatic 0x0098090c (bool)   : default=1 value=1
      white_balance_temperature 0x0098091a (int)    : min=2800 max=7500 step=10 default=5000 value=4070 flags=inactive, has-min-max
           power_line_frequency 0x00980918 (menu)   : min=0 max=2 default=2 value=2 (60 Hz)
				0: Disabled
				1: 50 Hz
				2: 60 Hz
   region_of_interest_rectangle 0x00981ae1 (rect)   : value=(0,0)/1x1 flags=has-payload, has-min-max

Camera Controls

                  auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=3 (Aperture Priority Mode)
				1: Manual Mode
				3: Aperture Priority Mode
                   pan_absolute 0x009a0908 (int)    : min=-36000 max=36000 step=3600 default=0 value=0 flags=has-min-max
                  zoom_absolute 0x009a090d (int)    : min=100 max=400 step=1 default=110 value=100 flags=has-min-max
`;

test('camera controls are parsed into friendly, grouped settings',()=>{
  const c=parseControls(RAZER);
  assert.deepEqual(c.map(x=>x.name),['auto_exposure','white_balance_automatic','white_balance_temperature','brightness','zoom_absolute','pan_absolute','power_line_frequency']);
  const exp=c.find(x=>x.name==='auto_exposure');
  assert.deepEqual(exp.options,[{value:1,label:'Manual'},{value:3,label:'Auto'}]);
  assert.equal(c.find(x=>x.name==='white_balance_temperature').inactive,true);
  assert.equal(c.find(x=>x.name==='power_line_frequency').label,'Anti-flicker');
  assert.ok(!c.some(x=>x.name==='region_of_interest_rectangle'),'rect controls are not offered');
});

test('camera values are checked against range, step and menu',()=>{
  const c=parseControls(RAZER),get=n=>c.find(x=>x.name===n);
  assert.equal(validValue(get('brightness'),300),null);
  assert.equal(validValue(get('brightness'),200),200);
  assert.equal(validValue(get('pan_absolute'),5000),3600,'snaps to the step');
  assert.equal(validValue(get('auto_exposure'),2),null,'only listed menu items');
  assert.equal(validValue(get('white_balance_automatic'),1),1);
  assert.equal(validValue(get('brightness'),'12; rm -rf /'),null);
});

test('saved camera values are applied with auto modes first and skipped while auto is on',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capture-cam-test-'));
  let text=RAZER;const calls=[];
  const exec=async(cmd,args)=>{
    if(args.includes('--list-ctrls-menus'))return {stdout:text};
    if(args.includes('--info'))return {stdout:'Card type        : Test Camera\n'};
    calls.push(args[args.length-1]);
    if(args[args.length-1]==='white_balance_automatic=0')text=text.replace('value=4070 flags=inactive,','value=4070 flags=');
    return {stdout:''};
  };
  const cs=new CameraSettings(dir,{exec});
  await fs.writeFile(cs.file,JSON.stringify({'card:Test Camera':{controls:{white_balance_temperature:5200,brightness:150,white_balance_automatic:0}}}));
  const r=await cs.apply('/dev/video99');
  assert.deepEqual(calls,['white_balance_automatic=0','white_balance_temperature=5200','brightness=150']);
  assert.equal(r.applied,3);
  calls.length=0;text=RAZER;
  await fs.writeFile(cs.file,JSON.stringify({'card:Test Camera':{controls:{white_balance_temperature:5200}}}));
  await cs.apply('/dev/video99');
  assert.deepEqual(calls,[],'a manual value waits while auto white balance is on');
  await assert.rejects(cs.set('/dev/video99;x','brightness',1),/Choose a camera/);
});

test('mic cleanup builds the right chain and recording tracks',()=>{
  assert.equal(wanted({...DEFAULTS}),false,'off by default');
  assert.equal(wanted({...DEFAULTS,micNoise:'on'}),true);
  assert.equal(wanted({...DEFAULTS,micNoise:'on',microphone:'none'}),false);
  const conf=chainConfig({mic:'alsa_input.test',noise:true,gate:'strong',rumble:true,plugin:'/usr/lib/ladspa/librnnoise_ladspa.so'});
  assert.match(conf,/bq_highpass/);assert.match(conf,/"VAD Threshold \(%\)" = 90\.0/);
  assert.match(conf,/inputs = \[ "rumble:In" \]/);assert.match(conf,/outputs = \[ "clean:Output" \]/);
  assert.match(conf,/target\.object = "alsa_input\.test"/);
  const injected=chainConfig({mic:'a" } evil = { "',noise:false,rumble:true});
  assert.ok(!injected.includes('a" }'),'names cannot break out of the config string');
  const target={kind:'monitor',monitor:'eDP-1'};
  const s={...DEFAULTS,microphone:'alsa_input.test',micNoise:'on'};
  assert.deepEqual(buildArgs(target,s,'/x.mkv','vidcapture_mic').filter((a,i,arr)=>arr[i-1]==='-a'),['device:vidcapture_mic','device:alsa_input.test']);
  assert.deepEqual(buildArgs(target,{...s,systemAudio:true},'/x.mkv','vidcapture_mic').filter((a,i,arr)=>arr[i-1]==='-a'),['default_output|device:vidcapture_mic','device:vidcapture_mic','default_output','device:alsa_input.test']);
  assert.deepEqual(buildArgs(target,{...s,micBackup:false},'/x.mkv','vidcapture_mic').filter((a,i,arr)=>arr[i-1]==='-a'),['device:vidcapture_mic']);
  assert.deepEqual(buildArgs(target,s,'/x.mkv',null).filter((a,i,arr)=>arr[i-1]==='-a'),['device:alsa_input.test'],'no chain, no backup track');
  assert.throws(()=>validateSettings({micGate:'loud'},DEFAULTS,{microphones:[],cameras:[]}),/Invalid setting/);
  assert.equal(validateSettings({micRumble:true},DEFAULTS,{microphones:[],cameras:[]}).micRumble,true);
});
