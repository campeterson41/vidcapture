'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {CameraProfiles,validateProfile,publicProfile}=require('../camera-profiles.cjs');
const {cameraShader}=require('../camera.cjs');

const UNIT={guid:'23e49ed0-1178-4f31-ae52-d2fb8a8d3b48',size:8,setSelector:1,getSelector:2,status:'c003110000000000',ensure:[{byte:2,equals:1,send:'ff01000300000000'}]};

test('a profile needs a name and a USB match, and keeps only known fields',()=>{
  const p=validateProfile({name:' Cam ',match:'USB:1532:0E08',note:'Hi',extra:1});
  assert.deepEqual(p,{name:'Cam',match:'usb:1532:0e08',note:'Hi'});
  assert.throws(()=>validateProfile({match:'usb:1532:0e08'}),/name/);
  assert.throws(()=>validateProfile({name:'x',match:'card:Webcam'}),/match/);
  assert.throws(()=>validateProfile({name:'x',match:'usb:1532:0e08',gpuDecode:'nvidia'}),/intel/);
});

test('extension unit commands must be the declared size and rules must point inside it',()=>{
  assert.equal(validateProfile({name:'x',match:'usb:1532:0e08',extensionUnit:UNIT}).extensionUnit.ensure.length,1);
  assert.throws(()=>validateProfile({name:'x',match:'usb:1532:0e08',extensionUnit:{...UNIT,status:'c00311'}}),/8 bytes/);
  assert.throws(()=>validateProfile({name:'x',match:'usb:1532:0e08',extensionUnit:{...UNIT,ensure:[{byte:8,equals:1,send:'ff01000300000000'}]}}),/ensure\[0\]/);
  assert.throws(()=>validateProfile({name:'x',match:'usb:1532:0e08',extensionUnit:{...UNIT,guid:'nope'}}),/GUID/);
});

test('profiles match by vendor and product, and a user profile replaces a bundled one',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vc-profiles-'));
  const bundled=path.join(root,'bundled'),user=path.join(root,'user');
  await fs.mkdir(bundled);await fs.mkdir(user);
  await fs.writeFile(path.join(bundled,'a.json'),JSON.stringify({name:'Bundled',match:'usb:1532:0e08'}));
  await fs.writeFile(path.join(bundled,'b.json'),JSON.stringify({name:'Other',match:'usb:046d:085e'}));
  await fs.writeFile(path.join(bundled,'broken.json'),'{');
  await fs.writeFile(path.join(bundled,'skip.json.sample'),JSON.stringify({name:'Sample',match:'usb:0000:0000'}));
  await fs.writeFile(path.join(user,'mine.json'),JSON.stringify({name:'Mine',match:'usb:1532:0e08',note:'Tuned'}));
  const warnings=[];
  const profiles=new CameraProfiles([bundled,user,path.join(root,'missing')],{warn:m=>warnings.push(m)});
  await profiles.load();
  assert.equal(profiles.list.length,2);
  assert.equal(profiles.forKey('usb:1532:0e08:ABC123').name,'Mine');
  assert.equal(profiles.forKey('usb:046d:085e:-').name,'Other');
  assert.equal(profiles.forKey('usb:1532:0e080:-'),null);
  assert.equal(profiles.forKey('card:Integrated Webcam'),null);
  assert.equal(profiles.forKey(null),null);
  assert.match(warnings.join('\n'),/broken\.json/);
  await fs.rm(root,{recursive:true,force:true});
});

test('the interface sees the name, note and lens fit, never vendor commands',()=>{
  const p=validateProfile({name:'Cam',match:'usb:1532:0e08',extensionUnit:UNIT,lensCorrection:{radial:[1,0,0],offset:[0,0],fittedAt:{zoom_absolute:100,'bad key':1}}});
  assert.deepEqual(publicProfile(p),{name:'Cam',note:null,lensCorrection:true,fittedAt:{zoom_absolute:100}});
  assert.equal(publicProfile(null),null);
});

test('lens correction coefficients come from the profile; no profile means no correction',()=>{
  const shader=cameraShader({correction:{radial:[0.9,-0.02,1],offset:[0,-0.007]}});
  assert.match(shader,/float radial = 0\.9 \+ \(-0\.02\) \* r2 \+ \(1\.0\) \* r2 \* r2;/);
  assert.match(shader,/vec2\(0\.0, -0\.007\)/);
  assert.doesNotMatch(cameraShader({}),/radial/);
  assert.throws(()=>cameraShader({correction:{radial:[NaN,0,0],offset:[0,0]}}),/lens/);
});

test('the bundled example is a valid profile',async()=>{
  const text=await fs.readFile(path.join(__dirname,'..','camera-profiles','example.json.sample'),'utf8');
  assert.equal(validateProfile(JSON.parse(text)).lensCorrection.radial.length,3);
});
