import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { packRelease,verifyRelease,isReleaseSourcePath,safeRelative,RUNTIME_SOURCE_PATHS,tarListingLines } from '../tools/pack-release.mjs';
const base=mkdtempSync(join(tmpdir(),'telegram source release-')),repo=join(base,'repo'),out=join(base,'out');
mkdirSync(repo);mkdirSync(out);mkdirSync(join(base,'no-hooks'));
function git(...args){return execFileSync('git',['-c','commit.gpgsign=false','-c','core.hooksPath='+join(base,'no-hooks'),'-C',repo,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}
function put(path,text){mkdirSync(dirname(join(repo,path)),{recursive:true});writeFileSync(join(repo,path),text);}
try{
 assert.deepEqual(tarListingLines(Buffer.from('./\r\n./package.json\r\n')), ['./','./package.json']);
 git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 for(const name of ['package.json','package-lock.json','LICENSE','THIRD_PARTY_NOTICES.md','runtime/manifest.json','runtime/LICENSE','tools/apply-patches.mjs',...RUNTIME_SOURCE_PATHS])put(name,'synthetic public source\n');
 put('.env','SYNTHETIC_PRIVATE_STATE_MUST_NOT_SHIP\n');put('session.fixture','SYNTHETIC_STATE\n');put('gateway/owner.config','not public release input\n');
 git('add','.');git('commit','-m','Synthetic release fixture');
 const archive=join(out,'source.tar.gz');const m=packRelease(repo,archive);const v=verifyRelease(archive,{expectedCommit:m.sourceCommit});
 assert.equal(v.sourceRepository,'alexfisenkov/telegram-mcp-starter');assert.equal(v.sourceCommit,git('rev-parse','HEAD'));
 const repeated=join(out,'same-source.tar.gz');packRelease(repo,repeated);assert.deepEqual(readFileSync(repeated),readFileSync(archive),'same source yields the same canonical archive on every host');
 assert(!m.files.some(f=>['.env','session.fixture','gateway/owner.config'].includes(f.path)),'private/operational source excluded');
 assert.throws(()=>packRelease(repo,archive),/overwrite|already exists/);assert.throws(()=>packRelease(repo,join(repo,'bad.tar.gz')),/outside/);
 assert.throws(()=>verifyRelease(archive,{expectedCommit:'0'.repeat(40)}),/identity mismatch/);
 const stage=join(base,'tamper');mkdirSync(stage);execFileSync('tar',['-xzf',archive,'-C',stage]);writeFileSync(join(stage,'package.json'),'altered\n');
 const damaged=join(out,'damaged.tar.gz');execFileSync('tar',['-czf',damaged,'-C',stage,'.']);assert.throws(()=>verifyRelease(damaged),/checksum mismatch|mode mismatch/);
 for(const path of ['../file','runtime/../outside','/etc/passwd','runtime\\file','runtime/files/dist/../../x','runtime/files/dist/x\n.js'])assert.equal(safeRelative(path),false);
 for(const path of ['.env','node_modules/pkg/code.js','gateway/private.js','patches/owner.copy','runtime/files/dist/../../x.js','runtime/files/dist/unknown.js'])assert.equal(isReleaseSourcePath(path),false);
 const oid=execFileSync('git',['-C',repo,'hash-object','-w','--stdin'],{input:'../../outside',encoding:'utf8'}).trim();
 git('update-index','--add','--cacheinfo','120000',oid,'runtime/files/dist/master.js');git('commit','-m','Synthetic symlink fixture');
 assert.throws(()=>packRelease(repo,join(out,'symlink.tar.gz')),/Non-regular source/);
 console.log('OK: exact committed source, immutable SHA, private-file exclusion, symlink/path/overwrite/checksum and wrong-commit guards');
}finally{rmSync(base,{recursive:true,force:true});}
