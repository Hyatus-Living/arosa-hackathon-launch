export function publicErrorMessage({status=0,message='',userFacing=false,code=null}={},subject='This request') {
 const raw=/^(?:Not found[.!]?|Internal Server Error[.!]?|Failed to fetch|Forbidden[.!]?|Unauthorized[.!]?|Conflict[.!]?|HTTP\s*\d+.*)$/i.test(String(message).trim());
 if((userFacing||code)&&message&&!raw)return message;
 status=status||(/^Not found/i.test(message)?404:/Internal Server Error/i.test(message)?500:0);
 if(status===403)return subject+' is not shared with this account. Ask its owner for access.';
 if(status===404)return subject+' is no longer available. Return to the previous page and open it again.';
 if(status===409)return subject+' changed while you were working. Reload the page and try again.';
 if(status>=500)return subject+' could not load. Try again in a moment.';
 if(!status)return 'Arosa could not connect. Check your connection and try again.';
 return subject+' could not finish. Check the details and try again.';
}
const DEFAULT_TIMEOUT_MS = 30000;
export async function chatRequest(path,options={}) {
 const {timeoutMs=DEFAULT_TIMEOUT_MS,...fetchOptions}=options;
 const signal=fetchOptions.signal || (timeoutMs>0 ? AbortSignal.timeout(timeoutMs) : undefined);
 let response;
 try {
  response=await fetch('/api'+path,{cache:'no-store',...fetchOptions,signal,headers:{'content-type':'application/json',...fetchOptions.headers}});
 } catch(error) {
  if(error?.name==='TimeoutError' || error?.name==='AbortError') throw new Error('The request timed out. Check your connection and try again.');
  throw new Error(publicErrorMessage({},'This request'));
 }
 if(response.status===204)return {};
 let result;
 try{result=await response.json();}
 catch{
  // Cloudflare answers an origin 502 or 504 with its own HTML page; keep the status so callers can
  // treat it as the transient outage it is rather than a lost sign-in.
  if(response.status>=500){const error=new Error('The research connection was interrupted. Reload to reconnect to your saved request.');error.status=response.status;throw error;}
  throw new Error('Your sign-in could not be verified. Reload Arosa and sign in again.');
 }
 result.requestId ||= result.traceId || response.headers.get('x-request-id');
 // A coded refusal, such as reaching the free research allowance, is a plain answer with nothing to trace.
 if(!response.ok){const error=new Error(publicErrorMessage({status:response.status,message:result.error,userFacing:result.userFacing||(response.status>=400&&response.status<500),code:result.code})+(result.requestId&&!result.code?` Reference: ${result.requestId}`:''));error.status=response.status;error.code=result.code;throw error;}
 return result;
}
export const postChat=(path,body)=>chatRequest(path,{method:'POST',body:JSON.stringify(body)});
export const patchChat=(path,body)=>chatRequest(path,{method:'PATCH',body:JSON.stringify(body)});
export const deleteChat=(path)=>chatRequest(path,{method:'DELETE'});
// An EventSource retries a dropped connection itself but gives up for good on an error response,
// which the proxy returns while the research service restarts during a deploy. Reopen from the
// last delivered event until the service is back; onDisconnect({final:true}) reports giving up.
export function streamRun(id,onEvent,onDisconnect,{retryMs=3000,retryForMs=120000}={}) {
 let cursor=0,closed=false,timer=null,failingSince=null;
 const handle={close(){closed=true;clearTimeout(timer);handle.source.close();}};
 const open=()=>{
  const source=handle.source=new EventSource(`/api/runs/${id}/events${cursor?`?after=${cursor}`:''}`);
  source.onopen=()=>{failingSince=null;};
  source.onmessage=e=>{failingSince=null;const event=JSON.parse(e.data);if(event.seq<=cursor)return;cursor=event.seq;onEvent(event);if(/^run\.(completed|failed|interrupted)$/.test(event.event))handle.close();};
  source.onerror=()=>{
   if(closed)return;
   const stopped=source.readyState===2; // EventSource.CLOSED
   failingSince??=Date.now();
   const final=stopped&&Date.now()-failingSince>=retryForMs;
   onDisconnect({final});
   if(final)handle.close();
   else if(stopped){clearTimeout(timer);timer=setTimeout(()=>{if(!closed)open();},retryMs);}
  };
 };
 open();return handle;
}
