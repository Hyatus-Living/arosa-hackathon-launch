import {readFileSync} from 'node:fs';
import {KnowledgeStore,knowledgePath} from './knowledge.mjs';
import {embeddingProvider} from './knowledge-providers.mjs';

const [command='status',...args]=process.argv.slice(2),store=new KnowledgeStore(knowledgePath());
try {
  if(command==='status')console.log(JSON.stringify(store.status(),null,2));
  else if(command==='refresh')console.log(JSON.stringify(store.requestRefresh(args[0])));
  else if(command==='search') {
    const config=JSON.parse(readFileSync(process.env.ACRES_KNOWLEDGE_CONFIG||'/etc/acres-research/knowledge.json','utf8'));
    console.log(JSON.stringify(await store.search({query:args.join(' '),city:'US-NY-NYC'},embeddingProvider(config)),null,2));
  }else throw new Error('Use status, refresh SOURCE_ID, or search QUESTION.');
}finally{store.close();}
