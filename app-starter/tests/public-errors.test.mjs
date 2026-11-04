import test from 'node:test';
import assert from 'node:assert/strict';
import {publicErrorMessage,chatRequest} from '../public/chat-api.js';
test('public failures name the next action and never repeat raw server sentences',async()=>{
 for(const status of [403,404,409,500,502,0]){const text=publicErrorMessage({status,message:'Internal Server Error'},'This site');assert.doesNotMatch(text,/Internal Server Error|Not found\./);assert.match(text,/Ask|Return|Reload|Try|Check/);}
 assert.equal(publicErrorMessage({status:400,message:'Enter a ten-digit BBL.',userFacing:true}),'Enter a ten-digit BBL.');
 const original=global.fetch;try{for(const status of [404,500]){global.fetch=async()=>new Response(JSON.stringify({error:status===404?'Not found.':'Internal Server Error'}),{status,headers:{'content-type':'application/json'}});await assert.rejects(chatRequest('/projects/example/state'),e=>e.status===status&&!/Not found\.|Internal Server Error/.test(e.message));}}finally{global.fetch=original;}
});
