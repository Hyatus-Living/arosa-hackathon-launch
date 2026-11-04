import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet} from 'jose';
import {createAuthenticator,arosaAccount,isAdminEmail} from '../auth.js';

test('Arosa JWTs keep users separate and admit any Arosa account and reject wrong issuers and audiences',async()=>{
  const keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey);jwk.kid='fixture';
  const issuer='https://access.example',audience='acres-app';
  const auth=createAuthenticator({issuer,audience,accountLinks:{'michael@witharosa.ai':'existing-history'}},createLocalJWKSet({keys:[jwk]}));
  async function run(email,iss=issuer,aud=audience){
    const token=await new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setSubject('fixture:'+email).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const req={get:name=>name==='cf-access-jwt-assertion'?token:null};let accepted=false,status;
    await auth(req,{status:s=>({json:()=>{status=s;}})},()=>{accepted=true;});return {accepted,status,account:req.account,isAdmin:req.isAdmin};
  }
  assert.equal((await run('michael@witharosa.ai')).account,'existing-history');
  assert.equal((await run('michael@witharosa.ai')).isAdmin,false);
  assert.equal((await run('alex@witharosa.ai')).isAdmin,false);
  assert.equal((await run('chaim@witharosa.ai')).isAdmin,false);
  assert.equal((await run('other@witharosa.ai')).isAdmin,false);
  assert.equal((await run('ops@hyatus.com')).isAdmin,false);
  assert.equal((await run('alex@witharosa.ai')).account,arosaAccount('alex@witharosa.ai'));
  assert.notEqual((await run('alex@witharosa.ai')).account,(await run('chaim@witharosa.ai')).account);
  const newcomer=await run('newcomer@gmail.com');
  assert.equal(newcomer.account,arosaAccount('newcomer@gmail.com'));
  assert.equal(newcomer.isAdmin,false);
  assert.equal(isAdminEmail('michael@witharosa.ai',''),false);
  assert.equal(isAdminEmail('alex@witharosa.ai',''),false);
  assert.equal(isAdminEmail('chaim@witharosa.ai',''),false);
  assert.equal(isAdminEmail('other@witharosa.ai'),false);
  assert.equal(isAdminEmail('newcomer@gmail.com'),false);
  for(const args of [[''],['alex@witharosa.ai','https://evil.example'],['alex@witharosa.ai',issuer,'other-app']])assert.equal((await run(...args)).status,401);
});

test('the session reports the architecture feature only when it is switched on and the email is allowed',async()=>{
  const {isArchitectureEnabled}=await import('../auth.js');
  assert.equal(isArchitectureEnabled('michael@witharosa.ai','true',''),true,'enabled with no allowlist admits everyone');
  assert.equal(isArchitectureEnabled('michael@witharosa.ai','true','Michael@witharosa.ai, other@x.test'),true,'allowlist is case-insensitive');
  assert.equal(isArchitectureEnabled('someone@x.test','true','michael@witharosa.ai'),false,'an email off the allowlist is refused');
  assert.equal(isArchitectureEnabled('michael@witharosa.ai','false',''),false,'off is off');
  assert.equal(isArchitectureEnabled('',  'true',''),false,'no email is refused');
});

test('the architecture allowlist admits whole domains and the judging-window wildcard',async()=>{
  const {isArchitectureEnabled,architectureAllowlistAdmits}=await import('../auth.js');
  assert.equal(isArchitectureEnabled('judge@meta.com','true','michael@witharosa.ai,@Meta.com'),true,'a domain entry admits its accounts, case-insensitively');
  assert.equal(isArchitectureEnabled('judge@sub.meta.com','true','@meta.com'),false,'a domain entry does not admit subdomains');
  assert.equal(isArchitectureEnabled('anyone@x.test','true','*'),true,'the wildcard admits every verified account');
  assert.equal(isArchitectureEnabled('anyone@x.test','false','*'),false,'the wildcard does not switch the feature on');
  assert.equal(architectureAllowlistAdmits('','*'),false,'no email is refused even under the wildcard');
  assert.equal(architectureAllowlistAdmits('a@b.test','a@b.test.evil'),false,'exact entries stay exact');
});

test('administrators must be configured by the deployment owner',()=>{
  assert.equal(isAdminEmail('admin@example.com','admin@example.com'),true);
  assert.equal(isAdminEmail('other@example.com','admin@example.com'),false);
});
