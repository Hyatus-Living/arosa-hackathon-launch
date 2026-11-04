// Offline harness bridge for tests that already replace global fetch. Native requests
// retain the production DNS/pin path, then receive only the explicit fetch fixture.
import assert from 'node:assert/strict';
import https,* as httpsExports from 'node:https';
import dns,* as dnsExports from 'node:dns/promises';
import tls from 'node:tls';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';

export function installOfflinePublicWeb() {
  const original={fetch:globalThis.fetch,get:https.get,lookup:dns.lookup,connect:tls.connect};
  dns.lookup=async()=>[{address:'93.184.216.34',family:4}];
  tls.connect=()=>{throw new Error('Offline public web fixtures cannot open a TLS socket.');};
  https.get=(url,options,onResponse)=>{
    const request=new EventEmitter();
    const deliver=async()=>{
      assert.equal(typeof options.lookup,'function','offline source requests must retain the pinned lookup');
      await new Promise((resolve,reject)=>options.lookup(new URL(url).hostname,{all:true},(error,addresses)=>{if(error)return reject(error);assert.ok(addresses.length);resolve();}));
      const fixtureFetch=globalThis.fetch;
      assert.notEqual(fixtureFetch,original.fetch,'offline source requests require an explicit fetch fixture');
      const response=await fixtureFetch(url,options);
      const body=Readable.from(response.body??[]);
      body.statusCode=response.status;
      body.headers=Object.fromEntries(['content-type','content-encoding','location'].map(name=>[name,response.headers?.get(name)]).filter(([,value])=>value!=null));
      return body;
    };
    queueMicrotask(()=>{void deliver().then(onResponse,error=>request.emit('error',error));});
    return request;
  };
  syncBuiltinESMExports();
  assert.equal(httpsExports.get,https.get);assert.equal(dnsExports.lookup,dns.lookup);
  return ()=>{https.get=original.get;dns.lookup=original.lookup;tls.connect=original.connect;syncBuiltinESMExports();};
}
