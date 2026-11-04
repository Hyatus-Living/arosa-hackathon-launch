import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';

// A real gateway with a local test identity issuer. No production identity or payment provider.
test('free gateway closes both checkout routes even with legacy billing credentials configured',{timeout:15000},async t=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='daily-access-test';jwk.alg='RS256';
  const backend=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/cdn-cgi/access/certs')return res.end(JSON.stringify({keys:[jwk]}));
    if(req.url==='/plan')return res.end(JSON.stringify({plan:'community',beta:false,used:2,limit:50,remaining:48,resetsAt:Date.now()+3600000,period:'day',timeZone:'America/New_York',limits:{research:{used:2,limit:50,remaining:48,label:'Research requests'}},customer:null,subscription:null}));
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const issuer=`http://127.0.0.1:${backend.address().port}`;
  const child=spawn(process.execPath,['server.js'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,HOST:'127.0.0.1',PORT:'0',AROSA_ACCESS_ISSUER:issuer,AROSA_ACCESS_AUD:'daily-access',ACRES_RESEARCH_ORIGIN:issuer,RESEARCH_TOKEN:'test',BILLING_ENABLED:'true',STRIPE_SECRET_KEY:'sk_test_disabled',STRIPE_WEBHOOK_SECRET:'whsec_disabled',STRIPE_SUBSCRIPTION_WEBHOOK_SECRET:'whsec_disabled',STRIPE_PRICE_PRO_MONTHLY:'price_month',STRIPE_PRICE_PRO_YEARLY:'price_year',STRIPE_LIVE:'false'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));});
  const base=await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('Gateway did not start')),10000);
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Gateway exited ${code}`));});
  });
  const jwt=await new SignJWT({email:'visitor@example.test'}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setAudience('daily-access').setSubject('ordinary-visitor').setExpirationTime('5m').sign(privateKey);
  const headers={'cf-access-jwt-assertion':jwt,'content-type':'application/json'};
  assert.equal((await fetch(base+'/api/plan')).status,401);
  const response=await fetch(base+'/api/plan',{headers});assert.equal(response.status,200);
  const plan=await response.json();assert.equal(plan.plan,'community');assert.equal(plan.remaining,48);assert.equal(plan.checkoutAvailable,false);assert.equal(plan.manageable,false);assert.equal(plan.prices,undefined);
  for(const path of ['/api/plan/checkout','/api/wallet/checkout']) {
    const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify({interval:'year',amountCents:5000,id:crypto.randomUUID()})});
    assert.equal(response.status,410);assert.match((await response.json()).error,/free to use/i);
  }
  const wallet=await (await fetch(base+'/api/wallet',{headers})).json();assert.equal(wallet.enabled,false);assert.equal(wallet.checkoutAvailable,false);
});
