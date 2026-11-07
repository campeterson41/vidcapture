// Provision one desktop against a separately deployed, owner-controlled Worker.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomBytes,createHash}=require('node:crypto');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
async function main(){
 const [originArg,configArg,mode]=process.argv.slice(2);
 if(!originArg||!configArg||!['--remote','--local'].includes(mode))throw new Error('Usage: node scripts/pair-sharing.cjs https://YOUR-HOST /absolute/path/to/wrangler.jsonc --remote|--local');
 const origin=new URL(originArg);
 if(origin.protocol!=='https:'||origin.origin!==originArg||origin.username||origin.password||origin.hostname==='vidcapture.stream')throw new Error('Use the HTTPS origin of your own deployment, without a trailing slash. This tool cannot pair with vidcapture.stream.');
 const config=path.resolve(configArg);await fs.access(config);
 const state=process.env.CAPTURE_PAIR_STATE_DIR||path.join(os.homedir(),'.local/state/capture');
 await fs.mkdir(state,{recursive:true,mode:0o700});
 const destination=path.join(state,'publishing.json');
 const token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
 // Exclusive creation preserves an existing connection and its videos.
 await fs.writeFile(destination,JSON.stringify({origin:origin.origin,token}),{mode:0o600,flag:'wx'});
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'vidcapture-pair-'));
 try{
  const sql=path.join(temp,'device.sql');
  await fs.writeFile(sql,`INSERT INTO devices(token_hash,name,created_at,revoked) VALUES('${hash}','Desktop',${Math.floor(Date.now()/1000)},0);`,{mode:0o600});
  const cli=path.join(__dirname,'../cloud/node_modules/wrangler/bin/wrangler.js');
  await run(process.execPath,[cli,'d1','execute','DB','--config',config,mode,'--file',sql,'--yes'],{maxBuffer:1024*1024});
  console.log('Sharing connected. Restart VidCapture, then choose Video library. No key was printed.');
 }catch(error){
  await fs.unlink(destination);
  throw new Error('Pairing did not complete. The new local connection was removed. Inspect your own Worker configuration and D1 availability before retrying.');
 }finally{await fs.rm(temp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.code==='EEXIST'?'A sharing connection already exists. It was preserved.':error.message);process.exitCode=1;});
