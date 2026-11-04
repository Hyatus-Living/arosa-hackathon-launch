import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';

test('private secret mappings are required and unmapped optional integrations stay disabled',t=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const python=join(root,'planning','.venv','bin','python');
  if(!existsSync(python))return t.skip('Planning Python environment is not installed');
  const dir=mkdtempSync(join(tmpdir(),'arosa-secrets-config-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=readFileSync(join(root,'infra','acres-pull-secrets'),'utf8').split("exec python3 - <<'PY'\n")[1].replace(/\nPY\s*$/,'');
  const keys=['RESEARCH_TOKEN','GOOGLE_MAPS_API_KEY','DEEPSEEK_API_KEY','MCP_SERVICE_TOKEN','CLOUDFLARE_API_TOKEN','COMPOSIO_API_KEY','COMPOSIO_USER_API_KEY','SERPER_API_KEY','MODEL_API_KEY','ACRES_SOCRATA_APP_TOKEN','PASCAL_MAP_API_KEY','GOOGLE_MAP_TILES_API_KEY','OPENROUTER_API_KEY','TYPESAFE_API_KEY'];
  const mapping=Object.fromEntries(keys.map((key,i)=>[key,`example-secret-${i}`]));
  const mapFile=join(dir,'mapping.json');
  writeFileSync(mapFile,JSON.stringify(mapping));
  const env={...process.env,PROJECT:'example-project',OUT:join(dir,'out'),CONFIG_JSON:join(dir,'config.json'),LEGACY_JSON:join(dir,'legacy.json'),APP_TEMPLATE:join(dir,'app.env'),ACRES_SECRET_MAP_JSON:mapFile,ACRES_KNOWLEDGE_TEMPLATE:join(dir,'knowledge.json')};
  const harness=`import base64, io, json, os, pwd, urllib.request
def fake_account(name): raise KeyError(name)
pwd.getpwnam = fake_account
def fake_request(request, **kwargs):
    if request.full_url.startswith('http://metadata.google.internal/'):
        return io.BytesIO(b'{"access_token":"fixture"}')
    names = json.load(open(os.environ['ACRES_SECRET_MAP_JSON'])).values()
    assert any('/secrets/' + name + '/' in request.full_url for name in names), request.full_url
    return io.BytesIO(json.dumps({'payload': {'data': base64.b64encode(b'fixture-value').decode()}}).encode())
urllib.request.urlopen = fake_request
`;
  execFileSync(python,['-c',harness+source],{env,stdio:'pipe',timeout:5000});
  const config=JSON.parse(readFileSync(join(dir,'out','secrets.json'),'utf8'));
  assert.equal(config.RESEARCH_TOKEN,'fixture-value');
  assert.equal(config.MODEL_API_KEY,'fixture-value');
  assert.equal(config.SENDGRID_API_KEY,'');
  const app=readFileSync(join(dir,'out','app.env'),'utf8');
  assert.match(app,/RESEARCH_TOKEN=fixture-value/);
  assert.doesNotMatch(app,/STRIPE_SECRET_KEY|STRIPE_SUBSCRIPTION_WEBHOOK_SECRET/);
  writeFileSync(mapFile,'{}');
  const noNetwork=`import urllib.request, time
def unexpected_network(*args, **kwargs): raise AssertionError('network access before configuration')
urllib.request.urlopen = unexpected_network
time.sleep = lambda _: None
`;
  const missing=spawnSync(python,['-c',noNetwork+source],{env,encoding:'utf8',timeout:5000});
  assert.notEqual(missing.status,0);
  assert.match(missing.stderr,/Missing required secret mappings/);
  assert.equal(readFileSync(join(dir,'out','app.env'),'utf8'),app,'missing configuration never overwrites existing runtime secrets');
});
