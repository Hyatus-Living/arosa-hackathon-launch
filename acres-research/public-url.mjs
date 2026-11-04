import dns from 'node:dns/promises';
import {get} from 'node:https';
import {isIP} from 'node:net';
import {pipeline} from 'node:stream';
import {createGunzip,createInflate,createBrotliDecompress} from 'node:zlib';
import ipaddr from 'ipaddr.js';

// URLs are citation identifiers, not a permission to fetch arbitrary content.
// The pilot also excludes nonstandard ports and local/reserved address ranges.
export class PublicDestinationError extends Error {
  constructor(message) { super(message); this.code='PUBLIC_DESTINATION_DENIED'; this.status=400; this.retryable=false; }
}
const cleanAddress=value=>String(value??'').trim().toLowerCase().replace(/^\[|\]$/g,'');
export function isPrivateAddress(ip) {
  const address=cleanAddress(ip);
  return !isIP(address)||ipaddr.process(address).range()!=='unicast';
}

export async function assertPublicDns(hostname,lookupFn=dns.lookup) {
  if(typeof lookupFn!=='function')throw new PublicDestinationError('A public DNS resolver is required.');
  const records=await lookupFn(hostname,{all:true});
  if(!Array.isArray(records)||!records.length)throw new PublicDestinationError('Destination has no public DNS addresses.');
  return records.map(record=>{
    const address=cleanAddress(typeof record==='string'?record:record?.address);
    if(isPrivateAddress(address))throw new PublicDestinationError('Destination resolves to a private or reserved IP address.');
    return {address,family:isIP(address)};
  });
}

export function publicUrl(value) {
  try {
    const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,'');
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!host.includes('.'))return false;
    if(isIP(host))return !isPrivateAddress(host);
    if(host.startsWith('[')||host.startsWith('metadata.'))return false;
    return !['.internal','.local','.localhost','.home.arpa'].some(suffix=>host.endsWith(suffix));
  } catch {return false;}
}

// Preserve the original HTTPS/TLS host while the socket uses only vetted DNS answers.
export async function pinnedRequest(url,{headers,signal,lookup=dns.lookup,connect=get}={}) {
  const target=String(url);
  if(!publicUrl(target))throw new PublicDestinationError('Request accepts public HTTPS URLs only.');
  const records=await assertPublicDns(new URL(target).hostname,lookup);
  const pinnedLookup=(_host,options,done)=>options.all?done(null,records):done(null,records[0].address,records[0].family);
  return new Promise((resolve,reject)=>{
    connect(target,{headers,signal,agent:false,rejectUnauthorized:true,lookup:pinnedLookup},res=>resolve({status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,body:res,
      headers:{get:name=>[res.headers[name.toLowerCase()]].flat().filter(value=>value!=null).join(', ')||null}})).on('error',reject);
  });
}

// Decode HTTP content codings as a stream so each caller's decoded-byte cap
// still bounds compressed responses. Pipeline teardown also closes the wire stream.
const decoders={gzip:createGunzip,deflate:createInflate,br:createBrotliDecompress};
export function responseBody(response) {
  const encodings=(response.headers.get('content-encoding')||'').split(',').map(value=>value.trim().toLowerCase()).filter(value=>value&&value!=='identity');
  if(!encodings.length)return response.body;
  if(encodings.some(value=>!Object.hasOwn(decoders,value))){response.body?.destroy?.();throw new Error('Unsupported HTTP content encoding.');}
  const streams=encodings.reverse().map(value=>decoders[value]());
  pipeline(response.body,...streams,()=>{});
  return streams.at(-1);
}
