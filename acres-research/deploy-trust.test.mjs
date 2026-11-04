import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const installerPath=join(root,'infra/acres-deploy-research');
const installer=readFileSync(installerPath,'utf8');
const staging=installer.match(/^stage_source\(\) \{\n[\s\S]*?^\}/m)?.[0];
const permissions=installer.match(/^check_state_permissions\(\) \{\n[\s\S]*?^\}/m)?.[0];
const temp=t=>{const dir=mkdtempSync(join(tmpdir(),'acres-deploy-trust-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:dir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();

function fixture(t){
  const dir=temp(t),source=join(dir,'origin');mkdirSync(source);
  git(source,'init','-q');git(source,'config','user.email','fixture@example.invalid');git(source,'config','user.name','Deployment fixture');
  mkdirSync(join(source,'infra'));
  writeFileSync(join(source,'infra/acres-stage-planning'),'approved source\n');
  git(source,'add','.');git(source,'commit','-qm','Approved fixture');
  const commit=git(source,'rev-parse','HEAD');
  git(source,'update-ref','refs/remotes/origin/main',commit);
  const bundle=join(dir,'release.bundle');git(source,'bundle','create','-q',bundle,'refs/remotes/origin/main');
  writeFileSync(join(source,'infra/acres-stage-planning'),'unapproved working-tree content\n');
  const stage=join(dir,'stage');mkdirSync(stage);
  return {dir,source,commit,bundle,stage};
}
function stage(f,commit=f.commit,extraEnv={}){
  assert.ok(staging,'the exact production staging function is tested');
  return spawnSync('bash',['-c',`set -euo pipefail\nSTAGE=$1\nROOT=$STAGE/source\nCOMMIT=$2\n${staging}\nstage_source`, 'stage-source',f.stage,commit],{input:readFileSync(f.bundle),encoding:'utf8',env:{...process.env,...extraEnv}});
}

test('unprivileged invocation fails before reading or executing release input',t=>{
  if(process.getuid?.()===0)return t.skip('This check requires an unprivileged test process');
  const result=spawnSync('bash',[installerPath,'a'.repeat(40),'normal'],{input:'not a bundle',encoding:'utf8'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/operator sudo session/);
});

test('only explicit operator sudo deployment remains; old trigger and self-update are absent',()=>{
  assert.doesNotMatch(installer,/\/srv\/arosa|SELF_UPDATED|SELF_SRC|REQUESTED|setfacl|runuser -u openclaw -- cat/);
  assert.ok(installer.indexOf('[[ "$EUID" == 0 ]]')<installer.indexOf('install -d'));
  assert.ok(installer.indexOf('[[ "$#" == 2')<installer.indexOf('install -d'));
  assert.ok(installer.indexOf('flock -n 9')<installer.indexOf('stage_source\n'));
  assert.ok(installer.indexOf('stage_source\n')<installer.indexOf('bash "$ROOT/infra/acres-stage-planning"'));
  assert.ok(installer.includes('install -d -o root -g root -m 700 "$RELEASES"'));
  assert.ok(installer.includes('ROOT=$STAGE/source'));
  for(const name of ['path','service'])assert.equal(existsSync(join(root,`infra/acres-deploy-research.${name}`)),false);
  const client=readFileSync(join(root,'scripts/deploy-research.sh'),'utf8');
  assert.match(client,/sudo -n \/usr\/local\/sbin\/acres-deploy-research \$TARGET \$MODE/);
  assert.doesNotMatch(client,/sudo -u openclaw|\.deploy-research|npm ci/);
});

test('staging imports the exact approved commit and ignores mutable workspace and ambient Git config',t=>{
  const f=fixture(t),marker=join(f.dir,'archive-command-ran');
  const config=join(f.dir,'hostile-config');
  writeFileSync(config,`[tar "tar"]\n\tcommand = touch ${marker}\n`);
  const result=stage(f,f.commit,{GIT_CONFIG_GLOBAL:config,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'tar.tar.command',GIT_CONFIG_VALUE_0:`touch ${marker}`});
  assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(join(f.stage,'source/infra/acres-stage-planning'),'utf8'),'approved source\n');
  assert.equal(existsSync(marker),false,'the caller cannot supply Git archive commands');
  assert.equal(existsSync(join(f.stage,'source/.git')),false);
});

test('a bundle for another commit is rejected before any source is exported',t=>{
  const f=fixture(t),result=stage(f,'0'.repeat(40));
  assert.notEqual(result.status,0);
  assert.equal(existsSync(join(f.stage,'source')),false);
});

test('malformed release input is rejected before any source is exported',t=>{
  const f=fixture(t);writeFileSync(f.bundle,'unapproved request\n');
  const result=stage(f);
  assert.notEqual(result.status,0);
  assert.equal(existsSync(join(f.stage,'source')),false);
});

test('permission preflight fails closed on unsafe ownership or any research access to OpenClaw',t=>{
  const dir=temp(t),state=join(dir,'state');mkdirSync(state);mkdirSync(join(state,'openclaw'));
  // Use disposable paths and mocked system metadata; no host state or identities are changed.
  let check=permissions.replaceAll('/var/lib/arosa',state);
  assert.ok(check.includes('|| return 1'),'each failed check exits even when the function is used in a conditional');
  execFileSync('chmod',['1700',state]);
  const run=env=>spawnSync('bash',['-c',`set -euo pipefail\nstat() { case "$3" in ${state}) echo "\${PARENT_UID:-0}";; *) if [[ "$2" == %U ]]; then echo openclaw; else echo "\${PRIVATE_MODE:-700}"; fi;; esac; }\nsystemctl() { echo acres-runtime; }\nid() { if [[ "$2" == openclaw ]]; then echo 1000; else echo "\${RUNTIME_UID:-1001}"; fi; }\nrunuser() { [[ "\${RUNUSER_FAILURE:-no}" == no && "\${RESEARCH_ACCESS:-none}" != "$6" ]]; }\n${check}\nif check_state_permissions; then exit 0; else exit 1; fi`],{encoding:'utf8',env:{...process.env,...env}});
  assert.equal(run({}).status,0);
  for(const env of [{PARENT_UID:'1001'},{PRIVATE_MODE:'770'},{RUNTIME_UID:'0'},{RUNTIME_UID:'1000'},{RUNUSER_FAILURE:'yes'},...['-r','-w','-x'].map(RESEARCH_ACCESS=>({RESEARCH_ACCESS}))])assert.equal(run(env).status,1,JSON.stringify(env));
  execFileSync('chmod',['0700',state]);assert.equal(run({}).status,1,'non-sticky shared parent fails');
  execFileSync('chmod',['1700',state]);rmSync(join(state,'openclaw'),{recursive:true});symlinkSync(dir,join(state,'openclaw'));assert.equal(run({}).status,1,'symlinked private directory fails');
});

test('Buzz mount is read-only and ledger executes the staged immutable release',()=>{
  const buzz=readFileSync(join(root,'infra/arosa-buzz/arosa-buzz.service'),'utf8');
  assert.match(buzz,/src=\/srv\/arosa,dst=\/workspace\/acres,readonly(?: |$)/);
  const ledger=readFileSync(join(root,'infra/acres-ledger.service'),'utf8');
  assert.doesNotMatch(ledger,/\/srv\/arosa/);
  assert.match(ledger,/ExecStart=\/usr\/local\/bin\/node \/opt\/scripts\/ledger-sync.mjs/);
  assert.ok(installer.includes('"$REL/opt/scripts/ledger-sync.mjs"'));
  assert.ok(readFileSync(join(root,'infra/acres-research-apply'),'utf8').includes('"$FILE" == opt/scripts/ledger-sync.mjs'));
});
