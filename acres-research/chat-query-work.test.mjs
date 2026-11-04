import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'acres-chat-work-')),store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}

test('100 conversation summaries use three batched queries with unchanged names and counts',t=>{
  const s=fixture(t);s.touchPerson('alice','alice@example.com');s.setMyName('alice','alice@example.com','Alice');
  for(let i=0;i<100;i++){const c=s.createConversation('alice');s.addMessage(c.id,null,'user',`message ${i}`,{},'alice');}
  let statements=0;
  for(const method of ['query','one']){const original=s[method].bind(s);s[method]=(...args)=>{statements++;return original(...args);};}
  const list=s.list('alice');assert.equal(list.length,100);assert.equal(statements,3);
  for(const row of list){assert.equal(row.access,'owner');assert.equal(row.owner.name,'Alice');assert.equal(row.lastAuthor.name,'Alice');assert.equal(row.memberCount,0);}
});

test('startup loads only the history window while retaining earlier coauthor attribution and filtering errors',t=>{
  const s=fixture(t),c=s.createConversation('alice');
  s.touchPerson('alice','alice@example.com');s.touchPerson('bob','bob@example.com');
  s.db.exec('BEGIN');
  s.addMessage(c.id,null,'user','Old Bob question',{},'bob');
  for(let i=0;i<1500;i++)s.addMessage(c.id,null,i%2?'assistant':'user',`history ${i}`,i%7===0?{error:true}:{},i%2?null:'alice');
  s.db.exec('COMMIT');
  const expected=s.messageRows(c.id).filter(m=>!m.error).slice(-12).map(m=>({role:m.role,text:m.role==='user'?`[alice] ${m.text}`:m.text}));
  const run=s.createRun('alice',c.id,'Current question');let rowsLoaded=0,authorRows=0;
  const query=s.query.bind(s);s.query=(sql,...args)=>{const rows=query(sql,...args);if(sql.includes('WITH selected AS MATERIALIZED'))rowsLoaded+=rows.length;if(sql.includes('SELECT DISTINCT COALESCE'))authorRows+=rows.length;return rows;};
  assert.deepEqual(s.begin(run),expected);assert.equal(rowsLoaded,13);assert.ok(authorRows<=2);
  assert.equal(s.harnessAuthorName(run),'alice');assert.equal(rowsLoaded,13);
});
