import {createHash,randomUUID} from 'node:crypto';
import {executionSignal} from './execution-context.mjs';

export const MICROS_PER_USD = 1_000_000;
const ownerPattern = /^[a-f0-9]{24}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
export function money(value, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error('Amounts must be integer USD microcredits.');
  return value;
}
export function decimalMicros(value) {
  const text = String(value);
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error('Provider charge must be a nonnegative USD amount with at most six decimals.');
  const [whole, fraction = ''] = text.split('.');
  return money(Number(whole) * MICROS_PER_USD + Number(fraction.padEnd(6, '0')), true);
}
export class BillingError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

// All changes to a balance, its operation and the append-only ledger commit together.
// Uses the attached Google identity; there are no service-account key files.
export class FirestoreWalletRepository {
  constructor({token, fetcher = fetch} = {}) {
    this.fetcher = fetcher; this.token = token || (() => this.metadataToken());
    this.root = 'https://firestore.googleapis.com/v1/projects/hyatus-openclaw/databases/(default)/documents';
    this.prefix = 'projects/hyatus-openclaw/databases/(default)/documents';
  }
  async metadataToken() {
    if (this.cachedToken && Date.now() < this.tokenExpiry) return this.cachedToken;
    const response = await this.fetcher('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {headers:{'Metadata-Flavor':'Google'}, signal:AbortSignal.timeout(5000)});
    if (!response.ok) throw new BillingError('Wallet identity is unavailable.');
    const data = await response.json();
    if (!data.access_token) throw new BillingError('Wallet identity is unavailable.');
    this.cachedToken = data.access_token; this.tokenExpiry = Date.now() + Math.max(0, Number(data.expires_in) - 60) * 1000;
    return this.cachedToken;
  }
  async request(path, options = {}) {
    const response = await this.fetcher(this.root + path, {...options, headers:{'content-type':'application/json', authorization:`Bearer ${await this.token()}`}, signal:AbortSignal.timeout(15000)});
    if (response.status === 404 && options.method !== 'POST') return null;
    const data = await response.json();
    if (!response.ok) {
      const error = new BillingError('Wallet storage is unavailable.');
      error.retry = ['ABORTED','FAILED_PRECONDITION','ALREADY_EXISTS'].includes(data.error?.status); throw error;
    }
    return data;
  }
  path(owner) {
    if (!ownerPattern.test(owner)) throw new BillingError('Invalid wallet identity.', 401);
    return `/acres_wallets/${owner}`;
  }
  decode(doc) { return doc ? JSON.parse(doc.fields.payload.stringValue) : null; }
  write(path, value, previous) {
    return {update:{name:this.prefix + path, fields:{payload:{stringValue:JSON.stringify(value)},at:{integerValue:String(value.at || Date.now())}}},currentDocument:previous ? {updateTime:previous.updateTime} : {exists:false}};
  }
  async transact(owner, key, mutate) {
    const path = this.path(owner), operationPath = `${path}/operations/${hash(key)}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const [walletDoc, operationDoc] = await Promise.all([this.request(path), this.request(operationPath)]);
      const wallet = this.decode(walletDoc) || {balanceMicros:0, heldMicros:0, currency:'USD'};
      const operation = this.decode(operationDoc);
      const change = mutate(structuredClone(wallet), structuredClone(operation));
      if (!change) return operation;
      const writes = [this.write(path, change.wallet, walletDoc), this.write(operationPath, change.operation, operationDoc)];
      if (change.entry) writes.push(this.write(`${path}/ledger/${hash(key + ':' + change.entry.kind)}`, change.entry, null));
      try { await this.request(':commit', {method:'POST', body:JSON.stringify({writes})}); return change.operation; }
      catch (error) { if (!error.retry || attempt === 7) throw error; }
    }
  }
  async snapshot(owner) {
    const path = this.path(owner);
    const [doc, rows] = await Promise.all([
      this.request(path),
      this.request(`${path}:runQuery`, {method:'POST', body:JSON.stringify({structuredQuery:{from:[{collectionId:'ledger'}],orderBy:[{field:{fieldPath:'at'},direction:'DESCENDING'}],limit:50}})}),
    ]);
    const wallet = this.decode(doc) || {balanceMicros:0,heldMicros:0,currency:'USD'};
    return {...wallet, availableMicros:wallet.balanceMicros-wallet.heldMicros, entries:rows.filter(row=>row.document).map(row=>this.decode(row.document))};
  }
}

export class Wallet {
  constructor(repository) { this.repository = repository; }
  snapshot(owner) { return this.repository.snapshot(owner); }
  async credit(owner, key, amount, details = {}) {
    money(amount);
    return this.repository.transact(owner, key, (wallet, old) => {
      if (old) {
        if (old.amountMicros !== amount || old.kind !== 'topup') throw new BillingError('Payment reference conflict.',409);
        return null;
      }
      wallet.balanceMicros += amount;
      if (!Number.isSafeInteger(wallet.balanceMicros)) throw new BillingError('Invalid wallet balance.');
      const at = Date.now(), operation = {kind:'topup',amountMicros:amount,status:'settled',at};
      return {wallet,operation,entry:{...operation,...details,kind:'topup',deltaMicros:amount,at}};
    });
  }
  async reserve(owner, key, amount, details) {
    money(amount);
    return this.repository.transact(owner, key, (wallet, old) => {
      if (old) throw new BillingError('This paid operation has already been authorized. It will not be repeated.',409);
      if (wallet.blockedReason) throw new BillingError('Payments for this wallet need review.',402);
      if (wallet.balanceMicros-wallet.heldMicros < amount) throw new BillingError('Not enough credits. Top up your wallet to continue research.',402);
      wallet.heldMicros = money(wallet.heldMicros + amount, true);
      const at=Date.now(),operation={...details,reference:key,kind:'usage',status:'reserved',reservedMicros:amount,at};
      return {wallet,operation,entry:{...operation,kind:'reserve',deltaMicros:0,at}};
    });
  }
  async dispatch(owner, key) {
    return this.repository.transact(owner,key,(wallet,old)=>{
      if (old?.status !== 'reserved') throw new BillingError('Paid operation cannot be dispatched again.',409);
      return {wallet,operation:{...old,status:'dispatched'},entry:null};
    });
  }
  async settle(owner, key, amount, details = {}) {
    money(amount,true);
    return this.repository.transact(owner,key,(wallet,old)=>{
      if (old?.status === 'settled') {
        if (old.amountMicros !== amount) throw new BillingError('Usage reference conflict.',409);
        return null;
      }
      if (!old || !['dispatched','pending'].includes(old.status)) throw new BillingError('Usage is not awaiting settlement.',409);
      // Actual reported overages are visible and block further spending; never hide debt.
      wallet.balanceMicros -= amount; wallet.heldMicros -= old.reservedMicros;
      if (!Number.isSafeInteger(wallet.balanceMicros) || wallet.heldMicros < 0) throw new BillingError('Invalid wallet accounting.');
      const at=Date.now(),operation={...old,...details,status:'settled',amountMicros:amount,overage:amount>old.reservedMicros,at};
      return {wallet,operation,entry:{...operation,kind:'usage',deltaMicros:-amount,at}};
    });
  }
  async pending(owner,key,reason) {
    return this.repository.transact(owner,key,(wallet,old)=>{
      if (!old || ['settled','pending'].includes(old.status)) return null;
      if (old.status !== 'dispatched') throw new BillingError('Usage was not dispatched.',409);
      const at=Date.now(),operation={...old,status:'pending',reason,at};
      return {wallet,operation,entry:{...operation,kind:'pending',deltaMicros:0,at}};
    });
  }
  async releaseUndispatched(owner,key) {
    return this.repository.transact(owner,key,(wallet,old)=>{
      if(old?.status==='released')return null;
      if(old?.status!=='reserved')throw new BillingError('Only an undispatched reservation can be released.',409);
      wallet.heldMicros-=old.reservedMicros;
      const at=Date.now(),operation={...old,status:'released',at};
      return {wallet,operation,entry:{...operation,kind:'release',deltaMicros:0,at}};
    });
  }
  // Only the live authorization closure holds this guard. It calls this transition only before
  // invoking a provider, including cancellation while the durable dispatch mark is in flight.
  // Pending, settled and unrelated operations remain unreleasable. A crash loses the proof and
  // leaves the hold for reconciliation, rather than guessing that an attempted call was free.
  async releaseBeforeAttempt(owner,key,guard) {
    return this.repository.transact(owner,key,(wallet,old)=>{
      if(!guard||old?.dispatchGuardHash!==hash(guard))throw new BillingError('Missing proof of an unattempted operation.',409);
      if(old.status==='released')return null;
      if(!['reserved','dispatched'].includes(old.status))throw new BillingError('Attempted or unknown usage cannot be released.',409);
      wallet.heldMicros-=old.reservedMicros;
      if(wallet.heldMicros<0)throw new BillingError('Invalid wallet accounting.');
      const at=Date.now(),operation={...old,status:'released',reason:'Provider invocation did not start.',at};
      return {wallet,operation,entry:{...operation,kind:'release',deltaMicros:0,at}};
    });
  }
  async refund(owner,key,totalRefunded) {
    money(totalRefunded,true);
    return this.repository.transact(owner,key,(wallet,old)=>{
      const previous=old?.amountMicros || 0;
      if (totalRefunded<=previous) return null;
      const delta=totalRefunded-previous;wallet.balanceMicros-=delta;
      if (!Number.isSafeInteger(wallet.balanceMicros)) throw new BillingError('Invalid refund amount.');
      const at=Date.now(),operation={kind:'refund',amountMicros:totalRefunded,status:'settled',at};
      return {wallet,operation,entry:{...operation,kind:`refund-${totalRefunded}`,deltaMicros:-delta,at}};
    });
  }
  async block(owner,key) {
    return this.repository.transact(owner,key,(wallet,old)=>{
      if (old) return null;
      wallet.blockedReason='payment_dispute';
      const at=Date.now(),operation={kind:'dispute',status:'review',at};
      return {wallet,operation,entry:{...operation,deltaMicros:0,at}};
    });
  }
}

function tokenCharge(usage, rate) {
  const {inputTokens, cachedInputTokens, outputTokens} = usage || {};
  if (![inputTokens,cachedInputTokens,outputTokens].every(x=>Number.isSafeInteger(x)&&x>=0) || cachedInputTokens>inputTokens) return null;
  const cost = (BigInt(inputTokens-cachedInputTokens)*BigInt(rate.inputMicrosPerMillion)+BigInt(cachedInputTokens)*BigInt(rate.cachedInputMicrosPerMillion)+BigInt(outputTokens)*BigInt(rate.outputMicrosPerMillion)+999999n)/1000000n;
  return money(Number(cost),true);
}
export function validateRate(rate) {
  if (!rate || typeof rate.version !== 'string' || !rate.version || typeof rate.basis !== 'string' || !rate.basis || rate.basis.length > 300) throw new BillingError('Pricing is not configured for this provider.');
  money(rate.reserveMicros);
  if (!['estimated_call','estimated_tokens','reported_usd'].includes(rate.mode)) throw new BillingError('Unsupported metering policy.');
  if (rate.mode==='estimated_call') {money(rate.amountMicros,true);if(rate.amountMicros>rate.reserveMicros)throw new BillingError('Reservation is smaller than the configured cost.');}
  if (rate.mode==='estimated_tokens') for(const field of ['inputMicrosPerMillion','cachedInputMicrosPerMillion','outputMicrosPerMillion'])money(rate[field],true);
  // The field and unit must be explicitly verified against a provider contract.
  if (rate.mode==='reported_usd' && (!/^[a-z_][a-z0-9_.]*$/i.test(rate.chargeField||'') || rate.currency !== 'USD')) throw new BillingError('A verified USD charge field is required.');
  return rate;
}
// A run resumed after a restart (attempt 2) authorizes under its own keys, so the first attempt's
// holds stay as they were for reconciliation and are never mistaken for the new calls.
export function createUsageMeter({wallet,owner,runId,rates,emit=()=>{},attempt=1}) {
  let sequence=0;
  return {
    async authorize(provider,operation,override) {
      const rate=validateRate(override || rates[operation] || rates[provider]);
      const key=`${runId}:${attempt>1?`attempt${attempt}:`:''}${++sequence}:${operation}`;
      const signal=executionSignal(),dispatchGuard=randomUUID();
      signal?.throwIfAborted();
      await wallet.reserve(owner,key,rate.reserveMicros,{runId,provider,operation,dispatchGuardHash:hash(dispatchGuard),rateVersion:rate.version,basis:rate.basis,estimated:rate.mode!=='reported_usd'});
      let finalized=false,attempted=false,invoking=false;
      const release=async()=>{
        if(finalized)return;
        if(attempted)throw new BillingError('An attempted provider call must settle or remain pending.',409);
        await wallet.releaseBeforeAttempt(owner,key,dispatchGuard);finalized=true;
        emit('billing.released',{provider,operation,reservedMicros:rate.reserveMicros,reason:'Provider invocation did not start.'});
      };
      const authorization={
        async invoke(fn,{signal:providerSignal}={}) {
          if(finalized||invoking)throw new BillingError('Authorization can invoke a provider only once.',409);
          invoking=true;
          try{
            signal?.throwIfAborted();
            providerSignal?.throwIfAborted();
            await wallet.dispatch(owner,key);
            signal?.throwIfAborted();
            providerSignal?.throwIfAborted();
            // No await between the final cancellation check and the attempted invocation. The
            // invoked event lets a restart tell a paid call left unresolved (see ChatStore.recover).
            emit('billing.invoked',{provider,operation});
            attempted=true;
            return await fn();
          }catch(error){if(!attempted)await release();throw error;}
        },
        async settle(evidence) {
          if (finalized) return;
          if(!attempted)throw new BillingError('Usage cannot settle before a provider invocation.',409);
          let amount=null;
          if (rate.mode==='estimated_call') amount=rate.amountMicros;
          if (rate.mode==='estimated_tokens') amount=tokenCharge(evidence?.usage,rate);
          if (rate.mode==='reported_usd') {
            const value=rate.chargeField.split('.').reduce((node,part)=>node?.[part],evidence);
            if(value!==undefined && value!==null) {try{amount=decimalMicros(value);}catch{ /* Preserve hold for reconciliation. */ }}
          }
          if(amount===null) return this.pending('Provider cost could not be verified.');
          await wallet.settle(owner,key,amount,{usage:evidence?.usage || null});finalized=true;
          emit('billing.settled',{provider,operation,amountMicros:amount,estimated:rate.mode!=='reported_usd',basis:rate.basis});
        },
        async pending(reason='Provider outcome needs reconciliation.') {
          if(finalized)return;
          if(!attempted)return release();
          await wallet.pending(owner,key,reason);finalized=true;
          emit('billing.pending',{provider,operation,reservedMicros:rate.reserveMicros});
        },
      };
      if(signal?.aborted){await release();throw signal.reason;}
      return authorization;
    },
  };
}
