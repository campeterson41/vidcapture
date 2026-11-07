'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {speechRuntime}=require('../speech-runtime.cjs');

function home(){return fs.mkdtempSync(path.join(os.tmpdir(),'speech-'));}
function touch(file){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');}

test('uses VidCapture transcription when nothing else is installed',()=>{
  const h=home(),r=speechRuntime({},h);
  assert.equal(r.python,path.join(h,'.local/share/vidcapture-transcribe/venv/bin/python'));
  assert.equal(r.tool,path.join(__dirname,'..','capture_transcribe.py'));
  assert.equal(r.model,path.join(h,'.local/share/vidcapture-transcribe/models/parakeet-tdt-0.6b-v3'));
});

test('falls back to an existing Narration Studio install',()=>{
  const h=home();touch(path.join(h,'.local/share/narration-studio/tools/transcribe.py'));
  const r=speechRuntime({},h);
  assert.equal(r.tool,path.join(h,'.local/share/narration-studio/tools/transcribe.py'));
  assert.equal(r.python,path.join(h,'.local/share/narration-studio/transcript-venv/bin/python'));
});

test('prefers its own runtime once installed, and environment overrides win',()=>{
  const h=home();touch(path.join(h,'.local/share/narration-studio/tools/transcribe.py'));touch(path.join(h,'.local/share/vidcapture-transcribe/venv/bin/python'));
  assert.equal(speechRuntime({},h).tool,path.join(__dirname,'..','capture_transcribe.py'));
  const r=speechRuntime({CAPTURE_TRANSCRIPT_PYTHON:'/x/python',CAPTURE_TRANSCRIPT_MODEL:'/x/model'},h);
  assert.equal(r.python,'/x/python');assert.equal(r.model,'/x/model');
});
