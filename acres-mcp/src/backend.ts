import type {GatewayConfig} from './config.js';
import type {Account} from './auth.js';
import type {ToolName} from './contracts.js';

const messages:Record<string,string>={
  REQUEST_TIMEOUT:'The request exceeded its time limit. Try again.',
  REQUEST_CANCELLED:'The request was cancelled.',
  SOURCE_NOT_FOUND:'This source is unavailable for your account or its retention period has ended.',
  QUOTA_EXCEEDED:'The Arosa pilot request limit has been reached. Try again after the quota window resets.',
  SERVICE_BUSY:'Arosa is busy. Try again shortly.',
  INVALID_INPUT:'Use the documented NYC tool inputs.',
  BOROUGH_CONFLICT:'Clarify the NYC borough: the address and selected borough disagree.',
  PROVIDER_CREDITS_EXHAUSTED:'The research provider has no remaining credits.',
  PROVIDER_RATE_LIMITED:'The research provider is rate limited. Try again later.',
  PROVIDER_TIMEOUT:'The research provider timed out. Try again later.',
  PROVIDER_UNAVAILABLE:'The research provider is unavailable.',
  PROVIDER_RESPONSE_TOO_LARGE:'The research provider response exceeded the size limit.',
  PROJECT_NOT_FOUND:'This project is unavailable for your account. Use list_projects for available project IDs.',
  VERSION_CONFLICT:'The project changed since it was read. Read it again with get_project_state and reapply the assumptions.',
  PROJECT_READ_ONLY:'This account can read but not change this project.',
  NOT_IMPLEMENTED:'This operation is declared but not available yet on Arosa. Project state can be read with get_project_state.',
};
export class BackendError extends Error {
  constructor(public code:string,message=messages[code]||'Arosa could not complete this operation.'){super(message);}
}

// One lifetime starts at HTTP entry. Absolute checks cover expired admission and
// delayed timer delivery; the signal covers work already waiting on I/O.
export function requestBudget(deadline:number) {
  const controller=new AbortController();
  const expire=()=>controller.abort(new BackendError('REQUEST_TIMEOUT'));
  const remaining=deadline-Date.now();
  const timer=Number.isFinite(remaining)&&remaining>0?setTimeout(expire,remaining):null;
  if(!timer)expire();
  const check=()=>{
    if(!controller.signal.aborted&&Date.now()>=deadline)expire();
    controller.signal.throwIfAborted();
  };
  return {deadline,signal:controller.signal,check,
    cancel:()=>controller.abort(new BackendError('REQUEST_CANCELLED')),
    close:()=>{if(timer)clearTimeout(timer);},
    wait<T>(start:()=>Promise<T>):Promise<T> {
      check();
      return new Promise((resolve,reject)=>{
        const abort=()=>reject(controller.signal.reason);
        controller.signal.addEventListener('abort',abort,{once:true});
        Promise.resolve().then(()=>{check();return start();}).then(value=>{check();return value;}).then(resolve,reject)
          .finally(()=>controller.signal.removeEventListener('abort',abort));
      });
    },
  };
}
export type RequestBudget=ReturnType<typeof requestBudget>;

export function createBackend(config:GatewayConfig) {
  return async (tool:ToolName,args:unknown,account:Account,requestId:string,budget:RequestBudget,signal?:AbortSignal):Promise<unknown>=>{
    const cancellation=signal?AbortSignal.any([budget.signal,signal]):budget.signal;
    const check=()=>{cancellation.throwIfAborted();budget.check();};
    try {
      check();
      const response=await fetch(`${config.backendUrl}/mcp-api/tools/${tool}`,{
        method:'POST',redirect:'error',signal:cancellation,
        headers:{'content-type':'application/json',authorization:`Bearer ${config.serviceToken}`,'x-acres-account':account.accountId,'x-acres-workspace':account.workspaceId,'x-request-id':requestId,'x-acres-deadline':String(budget.deadline)},
        body:JSON.stringify({arguments:args}),
      });
      const reader=response.body?.getReader();if(!reader)throw new BackendError('BACKEND_UNAVAILABLE');
      const chunks:Uint8Array[]=[];let size=0;
      try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>512*1024)throw new BackendError('BACKEND_RESPONSE_TOO_LARGE');chunks.push(value);}}
      finally {await reader.cancel();}
      check();
      const payload:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!response.ok){
        const code=typeof payload==='object'&&payload!==null&&'error' in payload&&typeof payload.error==='object'&&payload.error!==null&&'code' in payload.error?String(payload.error.code):'';
        throw new BackendError(Object.hasOwn(messages,code)?code:'BACKEND_UNAVAILABLE');
      }
      return payload;
    } catch(error) {
      if(cancellation.aborted)throw cancellation.reason instanceof BackendError?cancellation.reason:new BackendError('REQUEST_CANCELLED');
      if(error instanceof BackendError)throw error;
      throw new BackendError('BACKEND_UNAVAILABLE');
    }
  };
}
