import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,FirestoreWalletRepository,createUsageMeter,decimalMicros} from './wallet.mjs';
import {createUrlFetcher} from './fetch-url.mjs';

const owner='a'.repeat(24),other='b'.repeat(24);
export class MemoryWalletRepository {
  wallets=new Map();operations=new Map();entries=new Map();chain=Promise.resolve();
  async transact(owner,key,mutate) {
    const task=this.chain.then(()=>{
      const id=owner+':'+key,old=this.operations.get(id)||null;
      const change=mutate(structuredClone(this.wallets.get(owner)||{balanceMicros:0,heldMicros:0,currency:'USD'}),structuredClone(old));
      if(!change)return old;
      this.wallets.set(owner,change.wallet);this.operations.set(id,change.operation);
      if(change.entry)this.entries.set(id+':'+change.entry.kind,change.entry);
      return change.operation;
    });this.chain=task.catch(()=>{});return task;
  }
  async snapshot(owner) {const wallet=this.wallets.get(owner)||{balanceMicros:0,heldMicros:0,currency:'USD'};return {...wallet,availableMicros:wallet.balanceMicros-wallet.heldMicros,entries:[...this.entries].filter(([key])=>key.startsWith(owner+':')).map(([,entry])=>entry)};}
}
const fixture=()=>new Wallet(new MemoryWalletRepository());

test('completed render errors settle their fixed-call charges before direct fallback or retry', async () => {
  for (const [statuses, directStatus] of [[[500], 200], [[429, 429], 503], [['network'], 200]]) {
    const wallet = fixture(); await wallet.credit(owner, 'fixture', 1_000_000);
    const meter = createUsageMeter({wallet, owner, runId: 'render', rates: {cloudflare: {mode: 'estimated_call', reserveMicros: 50_000, amountMicros: 2_000, version: 'test', basis: 'fixed-call estimate', currency: 'USD'}}});
    let calls = 0;
    const request = async () => {
      const status = statuses[calls++];
      if (status === 'network') throw new Error('Connection lost before a response');
      return Response.json({success: false, errors: [{message: status === 429 ? 'Browser is too busy, please retry later' : 'Render failed'}]}, {status});
    };
    const fetchUrl = createUrlFetcher({CLOUDFLARE_ACCOUNT_ID: 'fixture-account', CLOUDFLARE_API_TOKEN: 'fixture-token'}, {
      request, lookup: async () => [{address: '93.184.216.34', family: 4}],
      directRequest: async () => new Response('<main>' + 'Public source text. '.repeat(30) + '</main>', {status: directStatus, headers: {'content-type': 'text/html'}}),
      meterRender: async call => {
        const auth = await meter.authorize('cloudflare', 'cloudflare_markdown');
        try { const result = await auth.invoke(call); await auth.settle(result); return result; }
        catch (error) { await auth.pending(); throw error; }
      },
    });
    const result = await fetchUrl({url: 'https://www.example.gov/page'}).catch(error => error);
    const balance = await wallet.snapshot(owner), network = statuses[0] === 'network';
    assert.equal(calls, statuses.length);
    assert.equal(balance.heldMicros, network ? 50_000 : 0);
    assert.equal(balance.balanceMicros, 1_000_000 - (network ? 0 : statuses.length * 2_000));
    if (directStatus === 200) assert.equal(result.method, 'direct');
    else assert.equal(result.retryable, true);
  }
});

test('duplicate payment deliveries credit once and accounts stay isolated',async()=>{
  const wallet=fixture();await Promise.all(Array.from({length:20},()=>wallet.credit(owner,'payment',10_000_000)));
  assert.equal((await wallet.snapshot(owner)).balanceMicros,10_000_000);
  assert.equal((await wallet.snapshot(owner)).entries.length,1);
  assert.equal((await wallet.snapshot(other)).balanceMicros,0);
  await assert.rejects(wallet.credit(owner,'payment',20_000_000),/conflict/);
});
test('simultaneous research reservations cannot overspend a wallet',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',1_000_000);
  const results=await Promise.allSettled(Array.from({length:10},(_,i)=>wallet.reserve(owner,'run-'+i,250_000,{provider:'exa'})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,4);
  assert.equal((await wallet.snapshot(owner)).availableMicros,0);
  assert.equal((await wallet.snapshot(owner)).balanceMicros,1_000_000);
});
test('settlement releases unused reservation once and refuses duplicate dispatch',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',1_000_000);
  await wallet.reserve(owner,'call',500_000,{provider:'exa'});await wallet.dispatch(owner,'call');
  await assert.rejects(wallet.dispatch(owner,'call'),/again/);
  await wallet.settle(owner,'call',1234);await wallet.settle(owner,'call',1234);
  const result=await wallet.snapshot(owner);assert.equal(result.heldMicros,0);assert.equal(result.balanceMicros,998766);
  assert.equal(result.entries.filter(e=>e.kind==='usage').length,1);
  await assert.rejects(wallet.settle(owner,'call',1235),/conflict/);
});
test('zero settlement releases the whole reservation without charging the balance',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',1_000_000);
  await wallet.reserve(owner,'call',500_000,{provider:'gemini_deep_research'});await wallet.dispatch(owner,'call');
  await wallet.settle(owner,'call',0,{outcome:'provider_failed'});
  const result=await wallet.snapshot(owner);assert.equal(result.heldMicros,0);assert.equal(result.balanceMicros,1_000_000);
});
test('timeouts preserve reservations across recovery and block repeat operations',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',1_000_000);
  await wallet.reserve(owner,'call',500_000,{provider:'composio'});await wallet.dispatch(owner,'call');await wallet.pending(owner,'call','timeout');
  assert.equal((await wallet.snapshot(owner)).heldMicros,500_000);
  await assert.rejects(wallet.reserve(owner,'call',500_000,{}),/already/);
  await wallet.settle(owner,'call',200_000);
  assert.equal((await wallet.snapshot(owner)).availableMicros,800_000);
});
test('partial refunds are cumulative, idempotent and do not erase reservations',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',1_000_000);await wallet.reserve(owner,'call',200_000,{});
  await wallet.refund(owner,'refund',300_000);await wallet.refund(owner,'refund',100_000);await wallet.refund(owner,'refund',300_000);await wallet.refund(owner,'refund',1_000_000);
  assert.equal((await wallet.snapshot(owner)).balanceMicros,0);assert.equal((await wallet.snapshot(owner)).heldMicros,200_000);
  await assert.rejects(wallet.reserve(owner,'new',1,{}),/Not enough/);
});
test('overages are visible debt and disputes stop new paid work',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',100);await wallet.reserve(owner,'call',50,{});await wallet.dispatch(owner,'call');
  const result=await wallet.settle(owner,'call',101);assert.equal(result.overage,true);assert.equal((await wallet.snapshot(owner)).balanceMicros,-1);
  await wallet.credit(owner,'newpayment',1000);await wallet.block(owner,'dispute');await assert.rejects(wallet.reserve(owner,'new',1,{}),/review/);
});
test('provider-reported USD charges and token estimates are separately labeled',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',1_000_000);
  const events=[],meter=createUsageMeter({wallet,owner,runId:'test',emit:(name,value)=>events.push([name,value]),rates:{exa:{mode:'reported_usd',reserveMicros:100000,version:'v1',basis:'Verified total USD charge',chargeField:'instant_charge.total_usd',currency:'USD'},codex:{mode:'estimated_tokens',reserveMicros:100000,version:'v2',basis:'Subscription allocation estimate',inputMicrosPerMillion:1_000_000,cachedInputMicrosPerMillion:500_000,outputMicrosPerMillion:2_000_000}}});
  const exa=await meter.authorize('exa','EXA_SEARCH');await exa.invoke(async()=>{});await exa.settle({instant_charge:{total_usd:'0.001234'}});
  const codex=await meter.authorize('codex','codex');await codex.invoke(async()=>{});await codex.settle({usage:{inputTokens:1000,cachedInputTokens:200,outputTokens:100}});
  const charges=(await wallet.snapshot(owner)).entries.filter(e=>e.kind==='usage');
  assert.deepEqual(charges.map(e=>[e.amountMicros,e.estimated]),[[1234,false],[1100,true]]);
  assert.deepEqual(events.map(([name])=>name),['billing.invoked','billing.settled','billing.invoked','billing.settled']);
});
test('a run resumed after a restart authorizes under new keys and leaves the first attempt held',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',1_000_000);
  const rates={exa:{mode:'estimated_call',reserveMicros:100000,amountMicros:1000,version:'v1',basis:'Per call',currency:'USD'}};
  const first=await createUsageMeter({wallet,owner,runId:'run',rates}).authorize('exa','EXA_SEARCH');await first.invoke(async()=>{});
  const resumed=await createUsageMeter({wallet,owner,runId:'run',rates,attempt:2}).authorize('exa','EXA_SEARCH');await resumed.invoke(async()=>{});await resumed.settle({});
  const result=await wallet.snapshot(owner);assert.equal(result.heldMicros,100000);assert.equal(result.balanceMicros,999000);
});
test('missing or malformed costs stay unknown, not free; unconfigured providers fail before dispatch',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',1_000_000);
  const meter=createUsageMeter({wallet,owner,runId:'test',rates:{exa:{mode:'reported_usd',reserveMicros:100000,version:'v1',basis:'Verified USD field',chargeField:'charge',currency:'USD'}}});
  await assert.rejects(meter.authorize('codex','codex'),/not configured/);
  const auth=await meter.authorize('exa','EXA_SEARCH');await auth.invoke(async()=>{});await auth.settle({charge:{credits:1}});
  const result=await wallet.snapshot(owner);assert.equal(result.balanceMicros,1_000_000);assert.equal(result.heldMicros,100000);assert.equal(result.entries.at(-1).kind,'pending');
  assert.equal(decimalMicros('0.000001'),1);assert.throws(()=>decimalMicros('0.0000001'));assert.throws(()=>decimalMicros('-1'));
});
test('Firestore compare-and-swap retries conflicts and commits ledger atomically',async()=>{
  const docs=new Map();let version=0,conflicts=0;
  const root='https://firestore.googleapis.com/v1/',prefix='projects/hyatus-openclaw/databases/(default)/documents';
  const fetcher=async(url,options)=>{
    assert.equal(options.headers.authorization,'Bearer test-identity');
    if(options.method==='POST') {
      const {writes}=JSON.parse(options.body);
      for(const write of writes) {
        const previous=docs.get(write.update.name);
        if(write.currentDocument.exists===false?Boolean(previous):previous?.updateTime!==write.currentDocument.updateTime) {conflicts++;return {ok:false,status:409,json:async()=>({error:{status:'FAILED_PRECONDITION'}})};}
      }
      for(const write of writes)docs.set(write.update.name,{...write.update,updateTime:String(++version)});
      return {ok:true,status:200,json:async()=>({})};
    }
    const document=docs.get(String(url).slice(root.length));
    return document?{ok:true,status:200,json:async()=>structuredClone(document)}:{ok:false,status:404};
  };
  const wallet=new Wallet(new FirestoreWalletRepository({token:async()=>'test-identity',fetcher}));
  await Promise.all(Array.from({length:6},(_,i)=>wallet.credit(owner,'payment-'+i,100)));
  const stored=JSON.parse(docs.get(prefix+'/acres_wallets/'+owner).fields.payload.stringValue);
  assert.equal(stored.balanceMicros,600);assert.equal(docs.size,13);assert.ok(conflicts>0);
});

test('only undispatched holds can be released and small top-ups can repay negative balances',async()=>{
  const wallet=fixture();await wallet.credit(owner,'payment',1000);
  await wallet.reserve(owner,'undispatched',300,{});await wallet.releaseUndispatched(owner,'undispatched');await wallet.releaseUndispatched(owner,'undispatched');
  assert.equal((await wallet.snapshot(owner)).heldMicros,0);
  await wallet.reserve(owner,'sent',500,{});await wallet.dispatch(owner,'sent');
  await assert.rejects(wallet.releaseUndispatched(owner,'sent'),/undispatched/);
  await wallet.settle(owner,'sent',2000);await wallet.credit(owner,'repayment',100);
  assert.equal((await wallet.snapshot(owner)).balanceMicros,-900);
});
