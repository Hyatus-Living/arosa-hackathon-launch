// Administrator-only maintenance command. No HTTP endpoint exposes this capability.
import {Wallet,FirestoreWalletRepository,decimalMicros} from '../acres-research/wallet.mjs';
const [action,owner,reference,value]=process.argv.slice(2);
const wallet=new Wallet(new FirestoreWalletRepository());
if(!/^[a-f0-9]{24}$/.test(owner||''))throw new Error('Supply the verified 24-character account namespace.');
if(action==='inspect')console.log(JSON.stringify(await wallet.snapshot(owner),null,2));
else if(action==='settle' && reference && value!==undefined)console.log(JSON.stringify(await wallet.settle(owner,reference,decimalMicros(value),{reconciled:true})));
else if(action==='release' && reference)console.log(JSON.stringify(await wallet.releaseUndispatched(owner,reference)));
else throw new Error('Usage: wallet-reconcile.mjs inspect OWNER | settle OWNER REFERENCE USD | release OWNER REFERENCE');
