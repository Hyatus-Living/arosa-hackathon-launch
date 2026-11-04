import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call,accountA} from './fixture.mjs';

test('the actual read-only MCP gateway traverses every saved site with the same query and cursor',async()=>{
  const f=await fixture({state:true,members:[{subject:'google|user-a',accountId:accountA,workspaceId:'pilot',enabled:true,scopes:['acres:state:read']}]});
  try{
    for(let i=0;i<205;i++){const c=f.chat.createConversation(accountA);f.chat.write('UPDATE projects SET title=?,updated=? WHERE id=?',`Paged site ${i}`,1000,c.projectId);}
    const client=await f.connect('google|user-a',{}, {scope:'acres:state:read'}),pages=[];let cursor;
    for(let i=0;i<5;i++){const page=await call(client,'list_projects',{q:'Paged',...(cursor?{cursor}:{})});pages.push(page);if(page.nextCursor===null)break;cursor=page.nextCursor;}
    assert.deepEqual(pages.map(page=>page.projects.length),[100,100,5]);assert.equal(pages.at(-1).nextCursor,null);
    assert.equal(new Set(pages.flatMap(page=>page.projects.map(project=>project.projectId))).size,205);
  }finally{await f.done();}
});
