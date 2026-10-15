import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'telegram-mcp-starter-source-release-v1';
export const SOURCE_REPOSITORY = 'alexfisenkov/telegram-mcp-starter';
const EXACT = new Set(['package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md','runtime/manifest.json','runtime/LICENSE','tools/apply-patches.mjs','tools/pack-release.mjs']);
export const RUNTIME_SOURCE_PATHS = Object.freeze([
  'telegram-client.js','telegram-helpers.js','telegram-client.d.ts','master.js','client.js',
  'tools/messages.js','tools/index.js','ipc-protocol.js','tools/media.js','tools/stickers.js',
  'tools/extras.js','tools/chats.js','tools/account.js','miniapp-shim.js','miniapp-browser.js',
  'tools/miniapps.js','tools/miniapp-ui.js',
].map(path => 'runtime/files/dist/' + path));
const RUNTIME_PATHS = new Set(RUNTIME_SOURCE_PATHS);
const REQUIRED = ['package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md','runtime/manifest.json','runtime/LICENSE','tools/apply-patches.mjs', ...RUNTIME_SOURCE_PATHS];
const SHA = /^[a-f0-9]{40}$/;
const H256 = /^[a-f0-9]{64}$/;
const MAX_BYTES = 32 * 1024 * 1024;
export const digest = b => createHash('sha256').update(b).digest('hex');
export function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\\x00-\x1f\x7f]/.test(path) && !isAbsolute(path) && !path.split('/').some(p => !p || p === '.' || p === '..');
}
export function isReleaseSourcePath(path) {
  if (!safeRelative(path)) return false;
  if (EXACT.has(path)) return true;
  return RUNTIME_PATHS.has(path);
}
function git(root, args) { return execFileSync('git',['-C',root,...args],{maxBuffer:MAX_BYTES}); }
function below(root,path) { const r=relative(root,path);return r===''||(!r.startsWith(`..${sep}`)&&r!=='..'&&!isAbsolute(r)); }
function tar(args) { return execFileSync('tar',args,{maxBuffer:MAX_BYTES,timeout:60000,env:{...process.env,COPYFILE_DISABLE:'1'}}); }
export function tarListingLines(bytes) { return bytes.toString().split(/\r?\n/).filter(Boolean); }
export function packRelease(repoPath, outputPath) {
  const root=realpathSync(repoPath), output=resolve(outputPath);
  if (existsSync(output)) throw new Error('Refusing to overwrite an existing release');
  mkdirSync(dirname(output),{recursive:true});
  const parent=realpathSync(dirname(output));
  if (below(root,parent)) throw new Error('Release output must be outside the repository');
  const finalPath=join(parent,output.split(sep).at(-1));
  if (existsSync(finalPath)) throw new Error('Release output already exists');
  const sourceCommit=git(root,['rev-parse','HEAD']).toString().trim();
  if (!SHA.test(sourceCommit)) throw new Error('Invalid Git source SHA');
  const entries=git(root,['ls-tree','-r','-z','HEAD']).toString().split('\0').filter(Boolean).map(row=>{
    const tab=row.indexOf('\t');if(tab<0)throw new Error('Invalid Git tree');
    const [mode,type,oid]=row.slice(0,tab).split(' ');return {path:row.slice(tab+1),mode,type,oid};
  }).filter(e=>isReleaseSourcePath(e.path)).sort((a,b)=>a.path.localeCompare(b.path,'en'));
  for(const name of REQUIRED)if(!entries.some(e=>e.path===name))throw new Error(`Missing release input: ${name}`);
  if(!entries.some(e=>e.path.startsWith('runtime/files/')))throw new Error('Runtime files are absent');
  const stage=mkdtempSync(join(tmpdir(),'telegram-public-source-'));const partial=join(parent,`.telegram-source-${sourceCommit}-${Date.now()}.partial`);
  try {
    const files=[];
    for(const e of entries){
      if(e.type!=='blob'||!['100644','100755'].includes(e.mode))throw new Error(`Non-regular source: ${e.path}`);
      const body=git(root,['cat-file','blob',e.oid]);if(body.length>MAX_BYTES)throw new Error('Source file is too large');
      const target=join(stage,e.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,body,{flag:'wx',mode:e.mode==='100755'?0o755:0o644});
      files.push({path:e.path,sha256:digest(body),bytes:body.length,mode:e.mode});
    }
    const version=Buffer.from(sourceCommit+'\n');writeFileSync(join(stage,'.VERSION'),version,{flag:'wx',mode:0o644});
    files.push({path:'.VERSION',sha256:digest(version),bytes:version.length,mode:'100644'});
    const manifest={schema:SCHEMA,sourceRepository:SOURCE_REPOSITORY,sourceCommit,files};
    writeFileSync(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});
    tar(['-czf',partial,'-C',stage,'.']);verifyRelease(partial,{expectedCommit:sourceCommit});
    if(existsSync(finalPath))throw new Error('Release destination appeared concurrently');
    renameSync(partial,finalPath);return manifest;
  } finally {rmSync(stage,{recursive:true,force:true});rmSync(partial,{force:true});}
}
export function verifyRelease(archivePath,{expectedCommit}={}) {
  const archive=resolve(archivePath),stat=lstatSync(archive);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw new Error('Invalid release archive');
  const names=tarListingLines(tar(['-tzf',archive]));
  const listing=tarListingLines(tar(['-tvzf',archive]));
  if(names.length!==listing.length)throw new Error('Ambiguous archive listing');
  if(listing.some(line=>!['-','d'].includes(line[0])))throw new Error('Symlink/special archive member');
  const members=[], modes=new Map();
  for(let i=0;i<names.length;i++){const name=names[i];const n=name.startsWith('./')?name.slice(2):name;if(n==='')continue;const check=n.endsWith('/')?n.slice(0,-1):n;if(!safeRelative(check))throw new Error('Unsafe archive member');if(n.endsWith('/'))continue;members.push(n);modes.set(n,listing[i].slice(0,10));}
  if(new Set(members).size!==members.length)throw new Error('Duplicate archive member');
  const bytes=tar(['-xOzf',archive,'./manifest.json']);if(bytes.length>2*1024*1024)throw new Error('Oversized manifest');
  const m=JSON.parse(bytes);
  if(m.schema!==SCHEMA||m.sourceRepository!==SOURCE_REPOSITORY||!SHA.test(m.sourceCommit)||expectedCommit&&m.sourceCommit!==expectedCommit)throw new Error('Release identity mismatch');
  if(!Array.isArray(m.files)||!m.files.length||m.files.length>500)throw new Error('Invalid file inventory');
  const expected=new Set(['manifest.json']);let total=0;
  for(const row of m.files){
    if(!row||!safeRelative(row.path)||expected.has(row.path)||row.path!=='.VERSION'&&!isReleaseSourcePath(row.path)||!H256.test(row.sha256)||!Number.isSafeInteger(row.bytes)||row.bytes<0||!['100644','100755'].includes(row.mode))throw new Error('Invalid manifest row');
    total+=row.bytes;if(total>MAX_BYTES)throw new Error('Oversized release');expected.add(row.path);
    if(modes.get(row.path)!==(row.mode==='100755'?'-rwxr-xr-x':'-rw-r--r--'))throw new Error(`Release mode mismatch: ${row.path}`);
    const body=tar(['-xOzf',archive,'./'+row.path]);if(body.length!==row.bytes||digest(body)!==row.sha256)throw new Error(`Release checksum mismatch: ${row.path}`);
  }
  if([...expected].sort().join('\n')!==members.slice().sort().join('\n'))throw new Error('Unexpected or missing archive files');
  for(const name of [...REQUIRED,'.VERSION'])if(!expected.has(name))throw new Error(`Missing release input: ${name}`);
  if(tar(['-xOzf',archive,'./.VERSION']).toString()!==m.sourceCommit+'\n')throw new Error('Immutable version mismatch');
  return {...m,archiveSha256:digest(readFileSync(archive)),manifestSha256:digest(bytes)};
}
if(process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url))){
  try{const a=process.argv.slice(2);if(a.length===2&&a[0]==='--output'){const m=packRelease(resolve(dirname(fileURLToPath(import.meta.url)),'..'),a[1]);console.log(JSON.stringify({sourceRepository:m.sourceRepository,sourceCommit:m.sourceCommit,files:m.files.length}));}else if(a[0]==='--verify'&&(a.length===2||a.length===4&&a[2]==='--expected-commit')){const m=verifyRelease(a[1],{expectedCommit:a[3]});console.log(JSON.stringify({sourceRepository:m.sourceRepository,sourceCommit:m.sourceCommit,files:m.files.length,archiveSha256:m.archiveSha256,manifestSha256:m.manifestSha256}));}else throw new Error('Usage: node tools/pack-release.mjs --output FILE | --verify FILE [--expected-commit SHA]');}catch(e){console.error(e.message);process.exitCode=1;}
}
