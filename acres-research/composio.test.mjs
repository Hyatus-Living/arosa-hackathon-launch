import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionStore,composioHeaders,serviceUser} from './composio.mjs';

const secrets={COMPOSIO_API_KEY:'test-project-key-not-real-0000'};

test('sessions are created once per account plus one shared service session, then reused',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-composio-')),created=[];
  const request=async(_url,options)=>{const body=JSON.parse(options.body);created.push(body);assert.equal(options.headers['x-api-key'],secrets.COMPOSIO_API_KEY);assert.equal(options.headers['x-user-api-key'],undefined);return {session_id:'trs_'+body.user_id};};
  const store=new SessionStore(join(dir,'composio.sqlite'),secrets,request);
  try {
    const owner='a'.repeat(24),other='b'.repeat(24);
    assert.deepEqual(await store.forAccount(owner),{exa:'trs_'+serviceUser,public:'trs_'+owner});
    assert.deepEqual(await store.forAccount(owner),{exa:'trs_'+serviceUser,public:'trs_'+owner});
    assert.equal((await store.forAccount(other)).public,'trs_'+other);
    assert.equal(await store.forService(),'trs_'+serviceUser);
    assert.equal(created.length,3);
    const service=created.find(b=>b.user_id===serviceUser),account=created.find(b=>b.user_id===owner);
    assert.deepEqual(service.toolkits,{enable:['exa']});assert.deepEqual(service.tools.exa.enable,['EXA_SEARCH','EXA_GET_CONTENTS_ACTION','EXA_FIND_SIMILAR']);
    assert.deepEqual(account.tags,['readOnlyHint']);assert.equal(account.toolkits,undefined);
    for(const b of [service,account]){assert.equal(b.manage_connections.enable,false);assert.equal(b.workbench.enable,false);assert.equal(b.instant.return_instant_charge,true);}
    await assert.rejects(store.forAccount('not-an-account'),/verified account/);
    const reopened=new SessionStore(join(dir,'composio.sqlite'),secrets,async()=>{throw new Error('must not create');});
    assert.equal((await reopened.forAccount(owner)).public,'trs_'+owner);reopened.close();
  } finally {store.close();rmSync(dir,{recursive:true});}
});

test('a missing project key fails before any provider call',()=>{
  assert.throws(()=>composioHeaders({}),/COMPOSIO_API_KEY/);
});
