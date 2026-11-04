#!/usr/bin/env node
// Host CLI for the dream review queue. Run it on the research host as the service user:
//   npm run dream:report -- --out /tmp/dream.md [--runs 5]
//   npm run dream:approve -- --id <id> --kind memory|expansion|source [--scope global] [--by name]
//   npm run dream:reject -- --id <id> --kind memory|expansion|source [--by name]
import {writeFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {parseArgs} from 'node:util';
import {ChatStore} from '../acres-research/store.mjs';
import {KnowledgeStore} from '../acres-research/knowledge.mjs';
import {dreamReport,reviewDreamItem} from '../acres-research/dream.mjs';

const [command,...rest]=process.argv.slice(2);
const {values}=parseArgs({args:rest,options:{
  out:{type:'string'},runs:{type:'string',default:'5'},
  id:{type:'string'},kind:{type:'string'},by:{type:'string',default:process.env.SUDO_USER||userInfo().username},scope:{type:'string'},
}});
if(!['report','approve','reject'].includes(command))throw new Error('Usage: dream-review.mjs report|approve|reject [options]');
if(command==='report'&&!values.out)throw new Error('dream:report needs --out <path>.');
if(command!=='report'&&(!values.id||!values.kind))throw new Error(`dream:${command} needs --id and --kind memory|expansion|source.`);

const store=new ChatStore(process.env.RESEARCH_STATE_PATH||'/home/openclaw/.openclaw/acres-state/chat.sqlite');
const knowledge=new KnowledgeStore(process.env.KNOWLEDGE_DB_PATH||'/home/openclaw/.openclaw/acres-state/knowledge.sqlite');
try{
  if(command==='report'){
    writeFileSync(values.out,dreamReport({store,knowledge,runs:Number(values.runs)}));
    console.log(values.out);
  }else{
    const row=reviewDreamItem({store,knowledge,kind:values.kind,id:values.id,decision:command,by:values.by,scope:values.scope??null});
    console.log(JSON.stringify({kind:values.kind,id:values.id,status:values.kind==='source'?row.review_status:row.status,by:values.by}));
  }
}finally{
  knowledge.close();
  store.close();
}
