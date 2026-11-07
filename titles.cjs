'use strict';
// Plain, short titles for recordings, written by a small model from what was
// said and what was on screen. The title also becomes the file name.

const TITLE_PROMPT = `You name screen recordings in a person's private video library. You get what was on screen and a rough automatic transcript of what was said. Write the title they would have typed themselves, so they can find the video again at a glance.

Rules:
- 2 to 6 words. Never more than 6.
- Name the actual subject: the product, page, feature, client, document, bug or task. Specific beats general.
- Plain and calm, like a file name. Sentence case: capitalize only the first word and proper nouns.
- No hype, drama, emotion or marketing language. Never use words like ultimate, amazing, epic, powerful, game changer, deep dive, unlocking, journey, masterclass, secrets, mastering, revolutionize, insane, crazy.
- No questions, exclamation marks, emoji, quotation marks, colons, dashes, hashtags or ending punctuation.
- Do not mention that it is a video, recording, walkthrough, Loom or screen capture, and do not include dates.
- Use a verb only when the video is clearly about doing something (for example "Fix checkout tax rounding").
- The transcript may contain recognition mistakes; do not repeat obvious errors. Ignore filler words and small talk.
- If nobody speaks, or the speech says nothing about the subject, use the screen context. For a terminal or code editor, name the project or folder it shows (for example "Kindly repo in the terminal"), not the shell, user or computer name.
- If there is nothing useful at all, answer exactly: Screen recording

Good titles:
Homepage hero spacing fixes
WABO member directory search
Invoice export bug in Harvest
Onboarding checklist for new clients
Kindly editor grid controls
Quarterly budget review notes

Bad titles, and why:
The Ultimate Guide to Our New Homepage (hype, too long)
Let's Fix This Annoying Bug! (drama, vague, punctuation)
Quick Loom walkthrough of the dashboard (mentions the tool and format)
Recording November 7 (no subject)

Answer with the title only, on one line.`;

const HYPE = /\b(ultimate|amazing|epic|powerful|game[ -]?changer|deep dive|unlock(?:ing)?|journey|masterclass|secrets?|mastering|revolutioni[sz]e|insane|crazy|incredible|awesome)\b/i;
const FALLBACK = 'Screen recording';

// Normalizes model output to the rules above, or returns null when it cannot.
function cleanTitle(raw) {
  let t = String(raw || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  t = t.replace(/^title\s*[:\-]\s*/i, '')
    .replace(/[‘’]/g, "'")
    .replace(/["“”`*#_]/g, '')
    .replace(/[:;!?|\\/<>–—]+/g, ' ')
    .replace(/\s+-\s+/g, ' ')
    .replace(/[.,\s]+$/g, '')
    .replace(/^['\s]+|['\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || !/\p{L}/u.test(t)) return null;
  const words = t.split(' ');
  if (words.length > 6) return null;
  if (HYPE.test(t)) return null;
  if (t.length > 60) return null;
  // Sentence case without lowercasing names and acronyms the model kept.
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// What the model sees. Screen context first, then up to ~700 words of speech.
function buildInput({ screen, app, durationSeconds, transcript }) {
  const lines = [];
  if (screen) lines.push(`On screen: ${String(screen).slice(0, 200)}${app ? ` (${app})` : ''}`);
  else if (app) lines.push(`On screen: ${app}`);
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    const m = Math.round(durationSeconds / 60);
    lines.push(`Length: ${m < 1 ? 'under a minute' : `${m} minute${m === 1 ? '' : 's'}`}`);
  }
  const words = String(transcript || '').split(/\s+/).filter(Boolean);
  lines.push(words.length ? `What was said:\n${words.slice(0, 700).join(' ')}` : 'What was said: nothing');
  return lines.join('\n');
}

// Title plus local date and time, safe on any file system. Collisions get " 2", " 3".
function fileStem(title, date = new Date()) {
  const safe = String(title || FALLBACK).replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || FALLBACK;
  const p = (n) => String(n).padStart(2, '0');
  return `${safe} ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}`;
}

const fs = require('node:fs/promises');
const path = require('node:path');
const { speechRuntime } = require('./speech-runtime.cjs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const SPEECH_SECONDS = 150;

// Names each new recording in the background: a short local transcript of the
// opening minutes, then one small model call. The title goes into the
// recording's sidecar, and the file and its sidecars are renamed to match once
// nothing has the file open.
class Titles {
  constructor(recorder, media, options = {}) {
    this.rec = recorder; this.media = media;
    const speech = speechRuntime();
    this.python = options.python || speech.python; this.tool = options.tool || speech.tool; this.model = options.model || speech.model;
    this.claude = options.claude || process.env.CAPTURE_POLISH_CLAUDE || 'claude';
    this.titleModel = options.titleModel || process.env.CAPTURE_TITLE_MODEL || process.env.CAPTURE_POLISH_MODEL || 'claude-haiku-5-5';
    this.enabled = options.enabled ?? process.env.CAPTURE_TITLES !== 'off';
    this.isOpen = options.isOpen || (() => false);
    this.queue = Promise.resolve(); this.pending = new Set(); this.children = new Set(); this.disposed = false;
  }

  // Called after every save. Runs one recording at a time.
  add(file) {
    if (!this.enabled || !file) return this.queue;
    this.queue = this.queue.then(() => this.name(file)).catch((e) => console.error('title', e.message));
    return this.queue;
  }

  run(cmd, args, { input, cwd, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new Error('stopped'));
      const child = spawn(cmd, args, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: '1' } });
      this.children.add(child);
      let out = '', err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
      child.once('error', (e) => { clearTimeout(timer); this.children.delete(child); reject(e); });
      child.once('close', (code) => { clearTimeout(timer); this.children.delete(child); code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${path.basename(cmd)} exited with ${code}`)); });
      if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    });
  }

  // Words from the opening minutes of the microphone (or the only) track.
  async speech(file, meta, work) {
    try { await fs.access(this.python); await fs.access(this.tool); await fs.access(this.model); } catch { return ''; }
    let tracks = 0;
    try { tracks = (await this.media.probe(file)).streams.filter((s) => s.codec_type === 'audio').length; } catch { return ''; }
    if (!tracks) return '';
    const track = Number.isInteger(meta.micTrack) && meta.micTrack >= 0 && meta.micTrack < tracks ? meta.micTrack : 0;
    const wav = path.join(work, 'speech.wav'), out = path.join(work, 'words.json');
    await this.run('ffmpeg', ['-nostdin', '-v', 'error', '-t', String(SPEECH_SECONDS), '-i', file, '-map', `0:a:${track}`, '-vn', '-ac', '1', '-ar', '16000', '-y', wav], { timeout: 60000 });
    await this.run(this.python, [this.tool, '--input', wav, '--output', out, '--model', this.model, '--engine', 'parakeet', '--device', 'cpu'], { cwd: work, timeout: 240000 });
    const parsed = JSON.parse(await fs.readFile(out, 'utf8'));
    return (parsed.words || []).map((w) => String(w.word || '').trim()).filter(Boolean).join(' ');
  }

  async ask(input, cwd) {
    const raw = await this.run(this.claude, ['-p', '--model', this.titleModel, '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '', '--system-prompt', TITLE_PROMPT, '--output-format', 'json'], { input, cwd, timeout: 90000 });
    const result = JSON.parse(raw);
    if (result.is_error) throw new Error('The title model returned an error.');
    return String(result.result || '');
  }

  // Title for a recording: one retry when the first answer breaks the rules.
  async titleFor(file, meta, work) {
    let words = '';
    try { words = await this.speech(file, meta, work); } catch (e) { console.error('title speech', e.message); }
    let duration = null; try { duration = (await this.media.getMedia(file)).duration; } catch {}
    const input = buildInput({ screen: meta.screen, app: meta.app, durationSeconds: duration, transcript: words });
    try {
      const first = await this.ask(input, work);
      const ok = cleanTitle(first);
      if (ok) return ok;
      const second = await this.ask(`${input}\n\nYour earlier answer "${first.trim().slice(0, 120)}" broke the rules. Answer again with 6 words or fewer, plain and calm.`, work);
      return cleanTitle(second) || cleanTitle(second.split(/\s+/).slice(0, 6).join(' ')) || FALLBACK;
    } catch (e) {
      console.error('title model', e.message);
      return null;
    }
  }

  async name(file) {
    let real; try { real = await this.rec.allowedFile(file); } catch { return; }
    const metaPath = this.media.metadataPath(real);
    let meta = {}; try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch {}
    if (!meta.title) {
      const work = await fs.mkdtemp(path.join(os.tmpdir(), 'vidcapture-title-'));
      try {
        const title = await this.titleFor(real, meta, work);
        if (!title) return;
        meta = { ...meta, title };
        await fs.writeFile(metaPath + '.tmp', JSON.stringify(meta), { mode: 0o600 }); await fs.rename(metaPath + '.tmp', metaPath);
      } finally { await fs.rm(work, { recursive: true, force: true }).catch(() => {}); }
    }
    this.pending.add(real);
    await this.applyRenames();
  }

  // Renames titled recordings that nothing has open. Called again whenever the
  // app goes idle, so a recording open in the editor is renamed later.
  async applyRenames() {
    for (const file of [...this.pending]) {
      if (this.isOpen(file) || this.rec.state.job?.running || ['starting', 'recording', 'paused', 'stopping'].includes(this.rec.state.phase)) continue;
      this.pending.delete(file);
      let meta = {}; try { meta = JSON.parse(await fs.readFile(this.media.metadataPath(file), 'utf8')); } catch { continue; }
      if (!meta.title || !/^Capture-/.test(path.basename(file))) continue;
      const created = meta.recordedAt && !Number.isNaN(Date.parse(meta.recordedAt)) ? new Date(meta.recordedAt) : await fs.stat(file).then((s) => s.mtime, () => null);
      if (!created) continue;
      try { await this.rec.renameRecording(file, fileStem(meta.title, created)); } catch (e) { console.error('title rename', e.message); }
    }
  }

  // Recordings titled earlier but never renamed (for example open at quit).
  async reconcile() {
    await this.rec.refreshRecent();
    for (const r of this.rec.state.recent || []) if (r.title && /^Capture-/.test(r.name)) this.pending.add(r.path);
    return this.applyRenames();
  }

  // At quit nothing is open any more; finish pending renames.
  async flush() { this.isOpen = () => false; return this.applyRenames(); }

  dispose() { this.disposed = true; for (const c of this.children) c.kill('SIGTERM'); }
}

module.exports = { TITLE_PROMPT, FALLBACK, cleanTitle, buildInput, fileStem, Titles };
