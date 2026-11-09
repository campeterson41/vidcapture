'use strict';
// Public release checks and staged source updates. Never modify the running source.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const run = require('node:util').promisify(execFile);
const REPO = 'https://github.com/campeterson41/vidcapture';
const FEED = 'https://api.github.com/repos/campeterson41/vidcapture/releases?per_page=100';
const INTERVAL = 6 * 60 * 60 * 1000;
function version(value) {
  const m = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(value);
  return m ? [+m[1], +m[2], +m[3], {alpha:0,beta:1,rc:2}[m[4]] ?? 3, +(m[5] || 0)] : null;
}
function compare(a, b) {
  const aa = version(a), bb = version(b);
  if (!aa || !bb) throw new Error('Unsupported release version.');
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
function selectRelease(releases, current) {
  if (!Array.isArray(releases) || !version(current)) throw new Error('Invalid update response.');
  const candidates = releases.filter(r => !r.draft && typeof r.tag_name === 'string' && r.tag_name.startsWith('v') && version(r.tag_name)
    && (current.includes('-') || (!r.prerelease && !r.tag_name.includes('-'))) && compare(r.tag_name, current) > 0);
  candidates.sort((a,b) => compare(b.tag_name, a.tag_name));
  if (!candidates.length) return null;
  const r = candidates[0], name = `vidcapture-${r.tag_name}.tar.gz`;
  const asset = r.assets?.find(a => a.name === name && a.state === 'uploaded');
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 25*1024*1024
    || asset.browser_download_url !== `${REPO}/releases/download/${r.tag_name}/${name}`) throw new Error('The new release is not ready for verified updates. Try again later.');
  return {version:r.tag_name.slice(1), tag:r.tag_name, url:asset.browser_download_url, digest:asset.digest.slice(7), size:asset.size};
}
async function download(url, limit, fetcher = fetch) {
  const response = await fetcher(url, {headers:{Accept:'application/vnd.github+json','User-Agent':'VidCapture-Updater'}, signal:AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'Update checks are temporarily rate limited. Try again later.' : `Update download failed (HTTP ${response.status}).`);
  if (response.url && !['https://api.github.com','https://github.com','https://release-assets.githubusercontent.com'].includes(new URL(response.url).origin)) throw new Error('Unexpected update download origin.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Update download exceeded its expected size.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
class Updates {
  constructor({root = __dirname, home = os.homedir(), current = require('./package.json').version, fetcher = fetch, runner = run, changed = () => {}} = {}) {
    Object.assign(this, {root, home, current, fetcher, runner, changed});
    this.state = {current, status:'idle', available:null};
    this.base = path.join(home,'.local/share/vidcapture/updates');
    this.cache = path.join(home,'.local/state/capture/update-check.json');
    this.launcher = path.join(home,'.local/bin/capture');
  }
  set(patch) { Object.assign(this.state,patch); this.changed({...this.state}); }
  async check({force = false} = {}) {
    if (this.checking || this.installing || this.ready) return this.state;
    this.checking = true;
    try {
      if (!force) {
        try {
          const cache = JSON.parse(await fs.readFile(this.cache,'utf8'));
          if (cache.current === this.current && Date.now() >= cache.at && Date.now() - cache.at < INTERVAL) {
            // Cached availability is display-only; installation always reads the live feed.
            if (cache.available && version(cache.available) && compare(cache.available,this.current)>0) this.set({status:'available',available:cache.available});
            return this.state;
          }
        } catch {}
      }
      this.set({status:'checking',error:null});
      const release = selectRelease(JSON.parse((await download(FEED, 4*1024*1024,this.fetcher)).toString()),this.current);
      this.set({status:release?'available':'current',available:release?.version || null});
      await fs.mkdir(path.dirname(this.cache),{recursive:true,mode:0o700});
      await fs.writeFile(this.cache,JSON.stringify({current:this.current,at:Date.now(),available:release?.version || null}),{mode:0o600});
    } catch (e) { this.set({status:'error',error:e.message}); }
    finally { this.checking = false; }
    return this.state;
  }
  async ownedLauncher() {
    const stat = await fs.lstat(this.launcher);
    const text = await fs.readFile(this.launcher,'utf8');
    if (!stat.isFile() || !text.startsWith('#!/usr/bin/env bash\n# Capture local recorder launcher\n') || !(text.split('\n').includes('# Capture source: '+Buffer.from(this.root).toString('base64')) || text.includes(path.join(this.root,'launch.cjs')))) throw new Error('This copy is not the installed VidCapture app. Install it with ./install.sh first.');
    return text;
  }
  async prepare() {
    if (this.installing || this.checking) throw new Error('An update check or installation is already running.');
    this.installing = true; let stage;
    try {
      const launcherBefore = await this.ownedLauncher();
      // Private development checkouts stay on their own source and release workflow.
      try {
        await fs.access(path.join(this.root,'AGENTS.md'));
        throw new Error('This is a development checkout. Update it through its source workflow. Public installations support in-app updates.');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      this.set({status:'downloading',error:null});
      const release = selectRelease(JSON.parse((await download(FEED,4*1024*1024,this.fetcher)).toString()),this.current);
      if (!release) throw new Error('No newer release is available.');
      await fs.mkdir(this.base,{recursive:true,mode:0o700});
      stage = await fs.mkdtemp(path.join(this.base,release.tag+'-'));
      const archive = await download(release.url,release.size,this.fetcher);
      if (archive.length !== release.size || crypto.createHash('sha256').update(archive).digest('hex') !== release.digest) throw new Error('The update checksum did not match. Your installed app was preserved.');
      const archivePath = path.join(stage,'release.tar.gz');
      await fs.writeFile(archivePath,archive,{mode:0o600});
      await this.runner('python3',[path.join(this.root,'scripts/extract-update.py'),archivePath,stage,`vidcapture-${release.tag}`],{timeout:30000,maxBuffer:1024*1024});
      const next = path.join(stage,`vidcapture-${release.tag}`);
      const pkg = JSON.parse(await fs.readFile(path.join(next,'package.json'),'utf8'));
      if (pkg.name !== 'vidcapture' || pkg.version !== release.version) throw new Error('The update version does not match its release.');
      this.set({status:'building',available:release.version});
      // Reuse the pinned engine cache only when its build inputs are byte-identical.
      // Changed engine inputs get a separate cache, preserving all other source builds.
      const engineHash = crypto.createHash('sha256');
      for (const file of ['engine/build.sh','engine/follow-region.patch']) engineHash.update(await fs.readFile(path.join(next,file)));
      const env = {...process.env,HOME:this.home,CAPTURE_ENGINE_BUILD_DIR:path.join(this.home,'.cache','vidcapture-engine-'+engineHash.digest('hex').slice(0,16))};
      for (const script of ['engine/build.sh','engine/build-camera.sh']) await this.runner('bash',[path.join(next,script)],{cwd:next,env,timeout:15*60*1000,maxBuffer:8*1024*1024});
      for (const name of ['gpu-screen-recorder-follow','capture-camera-stream']) await fs.access(path.join(next,'.local/bin',name),fs.constants.X_OK);
      await fs.writeFile(path.join(stage,'previous-launcher'),launcherBefore,{mode:0o700});
      this.ready = {next,stage,launcherBefore,release};
      this.set({status:'ready'});
      return this.ready;
    } catch (e) {
      if (stage) await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});
      this.set({status:'error',error:`Update could not be prepared: ${e.message}`}); throw new Error(this.state.error);
    } finally { this.installing = false; }
  }
  async activate() {
    if (!this.ready) throw new Error('No prepared update is available.');
    const {next,stage,launcherBefore,release} = this.ready;
    if (await this.ownedLauncher() !== launcherBefore) throw new Error('The installed launcher changed. It was preserved.');
    // The only activation mutation is an atomic launcher replacement. The old source,
    // desktop icon, extension registration, recordings, settings and models stay intact.
    const temp = this.launcher+'.update-'+crypto.randomBytes(8).toString('hex');
    try {
      await fs.writeFile(temp,`#!/usr/bin/env bash\n# Capture local recorder launcher\n# Capture source: ${Buffer.from(next).toString('base64')}\nexec /usr/bin/node ${quote(path.join(next,'launch.cjs'))} "$@"\n`,{mode:0o755,flag:'wx'});
      await fs.writeFile(path.join(stage,'receipt.json'),JSON.stringify({version:release.version,sha256:release.digest,previousRoot:this.root,installedAt:new Date().toISOString()}),{mode:0o600});
      await fs.rename(temp,this.launcher);
    } finally { await fs.rm(temp,{force:true}); }
    this.set({status:'installed'});
    return next;
  }
}
module.exports = {Updates, version, compare, selectRelease, download, REPO, INTERVAL};
