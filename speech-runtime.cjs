'use strict';
// Where local speech recognition lives. In order: environment overrides,
// VidCapture's own runtime (scripts/setup-transcription.sh), then an existing
// Narration Studio installation. Transcripts and AI titles both use this.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');

function speechRuntime(env=process.env,home=os.homedir()){
  const own=path.join(home,'.local/share/vidcapture-transcribe');
  const studio=env.NARRATION_STUDIO_ROOT||path.join(home,'.local/share/narration-studio');
  const useOwn=fs.existsSync(path.join(own,'venv/bin/python'))||!fs.existsSync(path.join(studio,'tools/transcribe.py'));
  const base=useOwn
    ?{python:path.join(own,'venv/bin/python'),tool:path.join(__dirname,'capture_transcribe.py'),model:path.join(own,'models/parakeet-tdt-0.6b-v3')}
    :{python:path.join(studio,'transcript-venv/bin/python'),tool:path.join(studio,'tools/transcribe.py'),model:path.join(studio,'models/parakeet-tdt-0.6b-v3')};
  return {python:env.CAPTURE_TRANSCRIPT_PYTHON||base.python,tool:env.CAPTURE_TRANSCRIPT_TOOL||base.tool,model:env.CAPTURE_TRANSCRIPT_MODEL||base.model};
}

module.exports={speechRuntime};
