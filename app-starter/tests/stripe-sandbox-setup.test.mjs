import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runSandboxSetup,WEBHOOK_URL} from '../../scripts/stripe-sandbox-setup.mjs';

// Every key below is an obviously fake fixture string. Tests never call api.stripe.com:
// runSandboxSetup takes an injected fetcher (the subscriptions.mjs pattern), and the CLI
// subprocess tests only exercise refusal and --dry-run paths, which make no API calls.
const here=dirname(fileURLToPath(import.meta.url));
const repoRoot=join(here,'..','..');
const testKey='sk_test_fixture-not-a-real-key';
const noNetwork=async()=>{throw new Error('network is forbidden in this test');};

function outFile(t) {
  const dir=mkdtempSync(join(tmpdir(),'stripe-sandbox-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return join(dir,'arosa-stripe.env');
}

// A fake Stripe account. GETs serve the seeded store; POSTs append and echo form fields.
function fakeStripe({products=[],prices=[],portalConfigs=[],endpoints=[]}={}) {
  const calls=[];let seq=0;
  const fetcher=async(url,options={})=>{
    calls.push({url,method:options.method||'GET',options});
    const path=new URL(url).pathname.replace('/v1/','');
    const form=options.body?new URLSearchParams(options.body):null;
    let body;
    if(path==='products'&&!form)body={data:products};
    else if(path==='products')body={id:`prod_new_${++seq}`,livemode:false,name:form.get('name'),metadata:{purpose:form.get('metadata[purpose]')}};
    else if(path==='prices'&&!form)body={data:prices};
    else if(path==='prices')body={id:`price_new_${form.get('recurring[interval]')}`,livemode:false,currency:form.get('currency'),unit_amount:Number(form.get('unit_amount')),lookup_key:form.get('lookup_key'),recurring:{interval:form.get('recurring[interval]')}};
    else if(path==='billing_portal/configurations'&&!form)body={data:portalConfigs};
    else if(path==='billing_portal/configurations')body={id:'bpc_new',livemode:false};
    else if(path==='webhook_endpoints'&&!form)body={data:endpoints};
    else if(path==='webhook_endpoints')body={id:'we_new',livemode:false,url:form.get('url'),secret:'whsec_fixture-secret-from-create'};
    else throw new Error(`unexpected Stripe path ${path}`);
    return {ok:true,status:200,json:async()=>body};
  };
  const posts=path=>calls.filter(c=>c.method==='POST'&&new URL(c.url).pathname.endsWith(path));
  return {fetcher,calls,posts};
}

test('refuses missing, live, and non-test keys before any API call',async()=>{
  await assert.rejects(runSandboxSetup({argv:['--out','/tmp/x.env'],secretKey:'',fetcher:noNetwork,cwd:repoRoot}),/Set STRIPE_SECRET_KEY/);
  await assert.rejects(runSandboxSetup({argv:['--out','/tmp/x.env'],secretKey:'sk_live_fixture-not-a-real-key',fetcher:noNetwork,cwd:repoRoot}),/LIVE Stripe key/);
  await assert.rejects(runSandboxSetup({argv:['--out','/tmp/x.env'],secretKey:'rk_live_fixture-not-a-real-key',fetcher:noNetwork,cwd:repoRoot}),/LIVE Stripe key/);
  await assert.rejects(runSandboxSetup({argv:['--out','/tmp/x.env'],secretKey:'pk_test_fixture',fetcher:noNetwork,cwd:repoRoot}),/does not look like a Stripe test key/);
});

test('refuses a missing --out and any --out inside the repository',async()=>{
  await assert.rejects(runSandboxSetup({argv:[],secretKey:testKey,fetcher:noNetwork,cwd:repoRoot}),/Pass --out/);
  await assert.rejects(runSandboxSetup({argv:['--out',join(repoRoot,'stripe.env')],secretKey:testKey,fetcher:noNetwork,cwd:repoRoot}),/inside the repository/);
  await assert.rejects(runSandboxSetup({argv:['--out','docs/stripe.env'],secretKey:testKey,fetcher:noNetwork,cwd:repoRoot}),/inside the repository/);
});

test('--dry-run validates the key shape and makes no API calls or files',async t=>{
  const summary=await runSandboxSetup({argv:['--dry-run'],secretKey:testKey,fetcher:noNetwork,cwd:repoRoot});
  assert.equal(summary.keyMode,'test');
  assert.deepEqual(summary.prices.map(p=>p.amount),[10000,60000]);
  assert.equal(summary.webhookUrl,WEBHOOK_URL);
});

test('finds the existing product and prices and creates nothing twice',async t=>{
  const out=outFile(t);
  const fake=fakeStripe({
    products:[{id:'prod_existing',metadata:{purpose:'arosa-pro-v1'}}],
    prices:[
      {id:'price_existing_month',lookup_key:'arosa_pro_monthly',currency:'usd',unit_amount:10000,recurring:{interval:'month'}},
      {id:'price_existing_year',lookup_key:'arosa_pro_yearly',currency:'usd',unit_amount:60000,recurring:{interval:'year'}},
    ],
    portalConfigs:[{id:'bpc_existing'}],
    endpoints:[{id:'we_existing',url:WEBHOOK_URL}],
  });
  const summary=await runSandboxSetup({argv:['--out',out],secretKey:testKey,fetcher:fake.fetcher,cwd:repoRoot});
  assert.equal(fake.calls.filter(c=>c.method==='POST').length,0,'idempotent rerun posts nothing');
  assert.deepEqual(summary.prices,{month:'price_existing_month',year:'price_existing_year'});
  const env=readFileSync(out,'utf8');
  assert.match(env,/^STRIPE_PRICE_PRO_MONTHLY=price_existing_month$/m);
  assert.match(env,/^# STRIPE_SUBSCRIPTION_WEBHOOK_SECRET=/m,'existing webhook writes the commented line');
  assert.equal(/whsec_/.test(env),false,'never invents a signing secret for an existing endpoint');
  assert.match(summary.webhook,/already exists \(we_existing\)/);
});

test('creates the missing product, $100/mo and $600/yr prices, portal and webhook',async t=>{
  const out=outFile(t);
  const fake=fakeStripe();
  const summary=await runSandboxSetup({argv:['--out',out],secretKey:testKey,fetcher:fake.fetcher,cwd:repoRoot});
  assert.equal(fake.posts('products').length,1);
  const pricePosts=fake.posts('prices');
  assert.equal(pricePosts.length,2);
  const forms=pricePosts.map(c=>new URLSearchParams(c.options.body));
  assert.deepEqual(forms.map(f=>[f.get('unit_amount'),f.get('recurring[interval]'),f.get('lookup_key')]),
    [['10000','month','arosa_pro_monthly'],['60000','year','arosa_pro_yearly']]);
  assert.match(pricePosts[0].options.headers['Idempotency-Key'],/^arosa-sandbox:arosa-pro-v1:prices:arosa_pro_monthly$/);
  assert.equal(pricePosts[0].options.headers.authorization,`Bearer ${testKey}`);
  const webhookForm=new URLSearchParams(fake.posts('webhook_endpoints')[0].options.body);
  assert.equal(webhookForm.get('url'),WEBHOOK_URL);
  assert.equal(webhookForm.get('enabled_events[0]'),'checkout.session.completed');
  const env=readFileSync(out,'utf8');
  assert.match(env,/^STRIPE_SUBSCRIPTION_WEBHOOK_SECRET=whsec_fixture-secret-from-create$/m);
  assert.deepEqual(summary.prices,{month:'price_new_month',year:'price_new_year'});
});

test('reuses a price matched by amount and interval, creating only the missing one',async t=>{
  const out=outFile(t);
  const fake=fakeStripe({
    products:[{id:'prod_existing',metadata:{purpose:'arosa-pro-v1'}}],
    prices:[{id:'price_plain_month',lookup_key:null,currency:'usd',unit_amount:10000,recurring:{interval:'month'}}],
    portalConfigs:[{id:'bpc_existing'}],
    endpoints:[{id:'we_existing',url:WEBHOOK_URL}],
  });
  const summary=await runSandboxSetup({argv:['--out',out],secretKey:testKey,fetcher:fake.fetcher,cwd:repoRoot});
  assert.equal(fake.posts('prices').length,1);
  assert.deepEqual(summary.prices,{month:'price_plain_month',year:'price_new_year'});
});

test('the env file is mode 0600, names every app key, and leaves the free limit off',async t=>{
  const out=outFile(t);
  await runSandboxSetup({argv:['--out',out],secretKey:testKey,fetcher:fakeStripe().fetcher,cwd:repoRoot});
  assert.equal(statSync(out).mode&0o777,0o600);
  const env=readFileSync(out,'utf8');
  for(const name of ['STRIPE_SECRET_KEY','STRIPE_PRICE_PRO_MONTHLY','STRIPE_PRICE_PRO_YEARLY','STRIPE_SUBSCRIPTION_WEBHOOK_SECRET'])
    assert.match(env,new RegExp(`^${name}=.+`,'m'),name);
  assert.match(env,/^STRIPE_LIVE=false$/m);
  assert.equal(/^FREE_RUNS_PER_MONTH=/m.test(env),false,'the free-run limit stays off');
});

test('the env names match the server wiring and the durable secret route',()=>{
  const server=readFileSync(join(repoRoot,'app-starter','server.js'),'utf8');
  for(const name of ['STRIPE_SECRET_KEY','STRIPE_LIVE','STRIPE_PRICE_PRO_MONTHLY','STRIPE_PRICE_PRO_YEARLY','STRIPE_SUBSCRIPTION_WEBHOOK_SECRET'])
    assert.ok(server.includes(name),`server.js reads ${name}`);
  const pull=readFileSync(join(repoRoot,'infra','acres-pull-secrets'),'utf8');
  assert.ok(pull.includes("'STRIPE_SECRET_KEY': 'acres-stripe-secret-key'"),'GSM name for the Stripe secret key');
  assert.ok(pull.includes("'STRIPE_SUBSCRIPTION_WEBHOOK_SECRET': 'acres-stripe-subscription-webhook-secret'"),'GSM name for the webhook secret');
  const billing=readFileSync(join(repoRoot,'docs','BILLING.md'),'utf8');
  assert.ok(billing.includes('node scripts/stripe-sandbox-setup.mjs'),'the one owner command is documented');
});

test('the CLI refuses bad keys with exit 2 and accepts --dry-run, all without network',()=>{
  const script=join(repoRoot,'scripts','stripe-sandbox-setup.mjs');
  const run=(env,args)=>spawnSync(process.execPath,[script,...args],{cwd:repoRoot,env:{...process.env,...env},encoding:'utf8',timeout:20000});
  assert.equal(run({STRIPE_SECRET_KEY:''},['--dry-run']).status,2);
  const live=run({STRIPE_SECRET_KEY:'sk_live_fixture-not-a-real-key'},['--out','/tmp/x.env']);
  assert.equal(live.status,2);assert.match(live.stderr,/LIVE/);
  const inside=run({STRIPE_SECRET_KEY:testKey},['--out',join(repoRoot,'stripe.env')]);
  assert.equal(inside.status,2);assert.match(inside.stderr,/inside the repository/);
  const dry=run({STRIPE_SECRET_KEY:testKey},['--dry-run']);
  assert.equal(dry.status,0,dry.stderr);
  assert.equal(JSON.parse(dry.stdout).keyMode,'test');
});
