import {requestSignal,throwIfCancelled,combinedSignal} from './execution-context.mjs';
export class PublicToolError extends Error {
  constructor(code,message,status=503){super(message);this.code=code;this.status=status;}
}

// NYC Open Data serves anonymous callers from a shared, throttled pool; requests that carry the
// app token (ACRES_SOCRATA_APP_TOKEN, pulled with the gateway secrets) get their own allowance.
export function socrataHeaders(url,env=process.env) {
  const token=env.ACRES_SOCRATA_APP_TOKEN;
  if(!token)return {};
  let host='';
  try {host=new URL(String(url)).host;} catch {return {};}
  return host==='data.cityofnewyork.us'?{'X-App-Token':token}:{};
}

// Provider bodies and error details are never forwarded to public clients or logs.
export async function providerJson(url,options={},fetcher=fetch) {
  try {
    const response=await fetcher(url,{...options,headers:{...socrataHeaders(url),...(options.headers||{})},signal:combinedSignal(options.signal,requestSignal(15000)),redirect:'error'});
    if(!response.ok) {
      if(response.status===402)throw new PublicToolError('PROVIDER_CREDITS_EXHAUSTED','The research provider has no remaining credits.');
      if(response.status===429)throw new PublicToolError('PROVIDER_RATE_LIMITED','The research provider is rate limited.');
      throw new PublicToolError('PROVIDER_UNAVAILABLE','The research provider is unavailable.');
    }
    const reader=response.body?.getReader();if(!reader)throw new Error('Missing response body');
    const chunks=[];let size=0;
    try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw new PublicToolError('PROVIDER_RESPONSE_TOO_LARGE','The research provider response exceeded the size limit.');chunks.push(Buffer.from(value));}}
    finally {await reader.cancel();}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(data?.error||data?.result_type==='failed')throw new PublicToolError('PROVIDER_UNAVAILABLE','The research provider could not complete this request.');
    return data;
  } catch(error) {
    throwIfCancelled();
    if(error instanceof PublicToolError)throw error;
    if(error?.name==='TimeoutError'||error?.name==='AbortError')throw new PublicToolError('PROVIDER_TIMEOUT','The research provider timed out.');
    throw new PublicToolError('PROVIDER_UNAVAILABLE','The research provider returned an unusable response.');
  }
}
