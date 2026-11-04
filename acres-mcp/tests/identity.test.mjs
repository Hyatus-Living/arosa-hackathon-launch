import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet} from 'jose';
import {readMemberships} from '../dist/config.js';
import {createAuthenticator} from '../dist/auth.js';

test('Verified historical Google account links preserve their stored namespace',async()=>{
  const {existingGoogleAccountId}=await import('../dist/identity.js');
  const keys=await generateKeyPair('RS256',{extractable:true}),jwk=await exportJWK(keys.publicKey);jwk.kid='identity-fixture';
  const dir=mkdtempSync(join(tmpdir(),'acres-link-')),path=join(dir,'memberships.json');
  try {
    const now=Math.floor(Date.now()/1000),accounts=[];
    const profiles=['123456789012345678901','223456789012345678901'];
    writeFileSync(path,JSON.stringify(profiles.map(id=>({subject:'google-oauth2|'+id,googleIapSubject:'accounts.google.com:'+id,workspaceId:'pilot',enabled:true}))));
    const config={issuer:'https://tenant.example/',resourceUrl:'https://mcp.acres.example/mcp',jwksUrl:'https://tenant.example/jwks',memberships:()=>readMemberships(path)};
    const verify=createAuthenticator(config,createLocalJWKSet({keys:[jwk]}));
    writeFileSync(path,'[]');
    assert.deepEqual(readMemberships(path),[]);
    const unlinked=await new SignJWT({sub:'google-oauth2|'+profiles[0],iss:config.issuer,aud:config.resourceUrl,scope:'acres:read',iat:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(keys.privateKey);
    await assert.rejects(verify('Bearer '+unlinked),error=>error.status===403&&error.code==='access_denied');
    writeFileSync(path,JSON.stringify(profiles.map(id=>({subject:'google-oauth2|'+id,googleIapSubject:'accounts.google.com:'+id,workspaceId:'pilot',enabled:true}))));
    for(const id of profiles) {
      const googleSub='accounts.google.com:'+id;
      const expectedAccount=existingGoogleAccountId(googleSub);
      const access=await new SignJWT({sub:'google-oauth2|'+id,iss:config.issuer,aud:config.resourceUrl,scope:'acres:read',iat:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(keys.privateKey);
      const linked=await verify('Bearer '+access);assert.equal(linked.accountId,expectedAccount);assert.equal(linked.workspaceId,'pilot');accounts.push(linked.accountId);
    }
    assert.notEqual(accounts[0],accounts[1]);
    writeFileSync(path,JSON.stringify([{subject:'google-oauth2|'+profiles[0],googleIapSubject:'accounts.google.com:'+profiles[0],accountId:'b'.repeat(24),workspaceId:'pilot',enabled:true}]));
    assert.throws(()=>readMemberships(path),/invalid/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
