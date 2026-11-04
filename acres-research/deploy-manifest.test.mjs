import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,copyFile} from 'node:fs/promises';
import {existsSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));

test('the research release stages the complete planner and binds it to its dependency environment',async t=>{
  const root=join(here,'..'),python=join(root,'planning','.venv','bin','python');
  if(!existsSync(python))return t.skip('Planning environment is not installed');
  const helper=await readFile(join(root,'infra','acres-stage-planning'),'utf8');
  assert.ok(helper.includes('sys.version_info >= (3,11)'), 'the installer supports the GCP host Python 3.11 runtime');
  for(const directory of ['', 'exporters']){
    for(const file of await readdir(join(root,'planning',directory))){
      if(file.endsWith('.py')&&!file.startsWith('test_')&&file!=='example.py')assert.ok(helper.includes(directory?`${directory}/${file}`:file),`${file} ships with the planner`);
    }
  }
  const installer=await readFile(join(root,'infra','acres-deploy-research'),'utf8'),apply=await readFile(join(root,'infra','acres-research-apply'),'utf8');
  assert.ok(installer.includes('bash "$ROOT/infra/acres-stage-planning" "$ROOT" "$REL" /opt/acres-planning-envs'));
  assert.ok(apply.includes('"$FILE" == opt/planning/*'));
  const temporary=mkdtempSync(join(tmpdir(),'arosa-planner-release-'));
  t.after(()=>rmSync(temporary,{recursive:true,force:true}));
  const requirements=await readFile(join(root,'planning','requirements.txt'));
  const hash=createHash('sha256').update(requirements).digest('hex'),environment=join(temporary,'envs',hash);
  mkdirSync(join(environment,'bin'),{recursive:true});
  // Reuse the project's installed dependencies; no network or host installation in this test.
  writeFileSync(join(environment,'bin','python'),`#!/bin/sh\nexec "${python}" "$@"\n`,{mode:0o755});
  writeFileSync(join(environment,'.ready'),'');
  const release=join(temporary,'release');
  execFileSync('bash',[join(root,'infra','acres-stage-planning'),root,release,join(temporary,'envs')],{stdio:'pipe'});
  const staged=join(release,'opt','planning');
  assert.equal(await readFile(join(staged,'requirements.txt'),'utf8'),requirements.toString());
  assert.ok((await readFile(join(staged,'.venv','bin','python'),'utf8')).includes(environment));
  const source=join(temporary,'source.ifc');
  execFileSync(python,[join(root,'worker','make_fixture_ifc.py'),source],{stdio:'pipe'});
  const result=JSON.parse(execFileSync(join(staged,'.venv','bin','python'),[join(staged,'run.py')],{
    input:JSON.stringify({operation:'import-ifc',inputPath:source,name:'Release smoke test'}),encoding:'utf8',stdio:['pipe','pipe','pipe'],
  }));
  assert.equal(result.report.importedWalls,4,'the staged runner executes the new operation');
});

test('the research installer ships every module the service imports',async()=>{
  const installer=await readFile(join(here,'..','infra','acres-deploy-research'),'utf8');
  const shipped=new Set([...installer.matchAll(/for FILE in ([^;]+); do/g)].flatMap(m=>m[1].split(/\s+/).filter(name=>name.endsWith('.mjs'))));
  for(const file of shipped)assert.ok(existsSync(join(here,file)),`${file} is present for installation`);
  const files=(await readdir(here)).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs'));
  const missing=new Set();
  for(const file of files){
    const text=await readFile(join(here,file),'utf8');
    for(const m of text.matchAll(/(?:from\s+|import\s+|import\()\s*['"]\.\/([a-z0-9-]+\.mjs)['"]/g)){
      if(!shipped.has(m[1]))missing.add(`${m[1]} (imported by ${file})`);
    }
  }
  assert.deepEqual([...missing].sort(),[],'modules imported by the research service but missing from infra/acres-deploy-research');
});

test('the secrets puller carries the Stripe subscription secrets as optional app env, never as boot requirements',async()=>{
  const pull=await readFile(join(here,'..','infra','acres-pull-secrets'),'utf8');
  assert.ok(pull.includes("'STRIPE_SECRET_KEY': 'acres-stripe-secret-key'"),'Secret Manager name for the Stripe secret key');
  assert.ok(pull.includes("'STRIPE_SUBSCRIPTION_WEBHOOK_SECRET': 'acres-stripe-subscription-webhook-secret'"),'Secret Manager name for the subscription webhook secret');
  const optionalBlock=pull.slice(pull.indexOf('OPTIONAL_KEYS'),pull.indexOf('RESEARCH_JSON_KEYS'));
  assert.ok(optionalBlock.includes('STRIPE_SECRET_KEY')&&optionalBlock.includes('STRIPE_SUBSCRIPTION_WEBHOOK_SECRET'),'both Stripe secrets are optional, so billing stays closed instead of blocking boot');
  assert.ok(pull.includes("emit('app.env', [k for k in APP_KEYS if k not in OPTIONAL_KEYS]"),'app.env is still emitted while the Stripe secrets are missing');
  const server=await readFile(join(here,'..','app-starter','server.js'),'utf8');
  for(const name of ['STRIPE_SECRET_KEY','STRIPE_LIVE','STRIPE_PRICE_PRO_MONTHLY','STRIPE_PRICE_PRO_YEARLY','STRIPE_SUBSCRIPTION_WEBHOOK_SECRET'])
    assert.ok(server.includes(name),`server.js reads ${name}`);
});

test('the research installer ships every JSON fact file a module reads',async()=>{
  const installer=await readFile(join(here,'..','infra','acres-deploy-research'),'utf8');
  const files=(await readdir(here)).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs'));
  const missing=new Set();
  for(const file of files){
    const text=await readFile(join(here,file),'utf8');
    for(const m of text.matchAll(/new URL\('\.\/([a-z0-9-]+\.json)'/g)){
      if(!installer.includes(`/opt/acres-research/${m[1]}`))missing.add(`${m[1]} (read by ${file})`);
    }
  }
  assert.deepEqual([...missing].sort(),[],'JSON files read by the research service but not installed by infra/acres-deploy-research');
});

test('the research installer ships every skill in the library',async()=>{
  const installer=await readFile(join(here,'..','infra','acres-deploy-research'),'utf8');
  const skillDirs=(await readdir(join(here,'skills'),{withFileTypes:true})).filter(d=>d.isDirectory()).map(d=>d.name).sort();
  const missing=skillDirs.filter(name=>!installer.includes(name));
  assert.deepEqual(missing,[],'skills present in acres-research/skills but missing from infra/acres-deploy-research');
});

// Shared browser modules ship as the one file app-starter/public holds. acres-research keeps a shim
// per module that re-exports it by relative path, and the installer mirrors app-starter/public
// under /opt so the same shim resolves on the host with nothing rewritten.
const shimTarget=text=>text.match(/^export \* from '\.\.\/app-starter\/public\/([a-z0-9-]+\.js)';\s*$/m)?.[1]??null;

test('a research module that shares a browser module\'s name is a shim onto it or a different module, never a copy',async()=>{
  const publicDir=join(here,'..','app-starter','public'),code=text=>text.split('\n').filter(line=>!/^\s*(\/\/|$)/.test(line)).join('\n');
  const twins=(await readdir(here)).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs')).filter(f=>existsSync(join(publicDir,f.replace(/\.mjs$/,'.js'))));
  assert.ok(twins.includes('plan-intake.mjs')&&twins.includes('listing-filter-schema.mjs'));
  for(const file of twins){
    const text=await readFile(join(here,file),'utf8'),browser=await readFile(join(publicDir,file.replace(/\.mjs$/,'.js')),'utf8');
    if(shimTarget(text)===file.replace(/\.mjs$/,'.js'))continue;
    assert.notEqual(code(text),code(browser),`${file} duplicates its browser module; make it a shim`);
  }
});

test('the installer ships the shims as modules and mirrors their browser targets, which resolve from the host layout',async t=>{
  const installer=await readFile(join(here,'..','infra','acres-deploy-research'),'utf8');
  const listed=new Set(installer.match(/for FILE in ([^;]+); do/)[1].split(/\s+/));
  const publicDir=join(here,'..','app-starter','public'),shims=[];
  for(const file of (await readdir(here)).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs'))){const target=shimTarget(await readFile(join(here,file),'utf8'));if(target)shims.push({file,target});}
  assert.ok(shims.length>=3);
  for(const {file}of shims)assert.ok(listed.has(file),`${file} is in the installer's module list`);
  assert.ok(installer.includes('/opt/app-starter/public'),'the installer mirrors app-starter/public under /opt');
  assert.equal(/sed /.test(installer),false,'no import rewriting at deploy time');
  // The installer follows each shim's target and its relative imports; the same closure must load from a mirror.
  const closure=new Set(),queue=shims.map(s=>s.target);
  while(queue.length){const name=queue.pop();if(closure.has(name))continue;closure.add(name);const text=await readFile(join(publicDir,name),'utf8');
    for(const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)){assert.match(m[1],/^\.\/[a-z0-9-]+\.js$/,`${name} imports only sibling browser modules (${m[1]})`);queue.push(m[1].slice(2));}}
  const root=mkdtempSync(join(tmpdir(),'acres-host-layout-'));t.after(()=>rmSync(root,{recursive:true}));
  mkdirSync(join(root,'acres-research'));mkdirSync(join(root,'app-starter','public'),{recursive:true});
  await copyFile(join(here,'..','app-starter','package.json'),join(root,'app-starter','package.json'));
  for(const name of closure)await copyFile(join(publicDir,name),join(root,'app-starter','public',name));
  for(const {file}of shims){await copyFile(join(here,file),join(root,'acres-research',file));const mod=await import(pathToFileURL(join(root,'acres-research',file)).href);assert.ok(Object.keys(mod).length>0,`${file} exports from the mirrored layout`);}
});
