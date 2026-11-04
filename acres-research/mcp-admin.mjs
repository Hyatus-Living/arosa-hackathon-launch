import {EvidenceStore} from './mcp-store.mjs';

// Host administration only; none of these operations is an MCP tool.
const [command,...args]=process.argv.slice(2);
const store=new EvidenceStore(process.env.ACRES_MCP_EVIDENCE_DB||'/home/openclaw/.openclaw/acres-state/mcp-evidence.sqlite');
try {
  if(command==='backup'&&args.length===1) {await store.backup(args[0]);console.log('Evidence backup completed. Verify restoration before relying on it.');}
  else if(command==='prune'&&!args.length) {store.prune();console.log('Expired evidence and old quota counters removed.');}
  else if(command==='delete-account'&&args.length===2&&/^[A-Za-z0-9_-]{1,64}$/.test(args[0])&&/^[a-f0-9]{24}$/.test(args[1])) {store.deleteOwner(`${args[0]}:${args[1]}`);console.log('Account evidence deleted from the active database. Backup retention is separate.');}
  else throw new Error('Use backup DESTINATION, prune, or delete-account WORKSPACE ACCOUNT_ID.');
} finally {store.close();}
