#!/usr/bin/env node
// Isolated no-auth protocol and single-owner concurrency regression.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cli=join(root,'node_modules/@overpod/mcp-telegram/dist/cli.js');
const sandbox=mkdtempSync(join(tmpdir(),'telegram-mcp-concurrency-'));
const session=join(sandbox,'session-does-not-exist');
const env={};
for(const key of ['PATH','SystemRoot','SYSTEMROOT','ComSpec','COMSPEC','PATHEXT','WINDIR'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{TELEGRAM_API_ID:'1',TELEGRAM_API_HASH:'invalid-fixture',TELEGRAM_SESSION_PATH:session,TELEGRAM_PROXY_IP:'127.0.0.1',TELEGRAM_PROXY_PORT:'9',TELEGRAM_PROXY_SOCKS_TYPE:'5',TMPDIR:sandbox,TEMP:sandbox,TMP:sandbox});
const expected=JSON.parse(readFileSync(join(root,'tests/fixtures/runtime-tools-standard.json'),'utf8')).tools.map(t=>t.name).sort();
const custom=['telegram-pin-topic','telegram-reorder-pinned-topics','telegram-list-mini-apps','telegram-get-mini-app-info','telegram-open-mini-app','telegram-prolong-mini-app','telegram-miniapp-read','telegram-miniapp-click','telegram-miniapp-fill','telegram-miniapp-screenshot','telegram-miniapp-close'];
const clients=[];let stderr='';
const watchdog=setTimeout(()=>{console.error('Concurrency check exceeded 60 seconds');process.exitCode=1;for(const c of clients)c.client.close().catch(()=>{});},60000);
async function connect(label){
  const transport=new StdioClientTransport({command:process.execPath,args:[cli],cwd:sandbox,env,stderr:'pipe'});
  const client=new Client({name:'public-ci-'+label,version:'2.0.0'});clients.push({client,transport});
  await client.connect(transport);
  if(transport.stderr)transport.stderr.on('data',b=>{stderr+=b.toString();});
  const result=await client.listTools();const names=result.tools.map(t=>t.name).sort();
  assert.deepEqual(names,expected,label+' full default tool inventory');
  for(const name of custom)assert(names.includes(name),label+' contains '+name);
  console.log(`${label}: ${names.length} tools; full patched inventory matches`);
  return {client,transport};
}
try{
  const a=await connect('first-owner');
  const owner=Number(readFileSync(join(sandbox,'daemon.lock'),'utf8').trim());
  assert.equal(owner,a.transport.pid,'first client is the sole temporary owner');
  const b=await connect('second-client');
  assert.equal(Number(readFileSync(join(sandbox,'daemon.lock'),'utf8').trim()),owner,'parallel client keeps the same owner');
  assert.notEqual(b.transport.pid,owner,'parallel process is a thin client');
  await b.client.close();
  const c=await connect('after-client-closed');
  assert.equal(Number(readFileSync(join(sandbox,'daemon.lock'),'utf8').trim()),owner,'owner survives client disconnect');
  await c.client.close();await a.client.close();
  assert.equal(existsSync(session),false,'no Telegram session was created');
  assert.equal(/(?:Connecting to|Connected to|DC \d|149\.154\.)/i.test(stderr),false,'no Telegram endpoint used');
  console.log('SMOKE OK: full inventory, isolated synthetic credentials, single owner and concurrent clients; no Telegram tool invoked');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{
  clearTimeout(watchdog);await Promise.allSettled(clients.map(c=>c.client.close()));rmSync(sandbox,{recursive:true,force:true});
}
