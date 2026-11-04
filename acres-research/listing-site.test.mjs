import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
const alice='a'.repeat(24);
function setup(t){const dir=mkdtempSync(join(tmpdir(),'acres-listing-site-')),s=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}

test('a site started from a listing is found by its BBL before the first run identifies the parcel',t=>{
 const s=setup(t),c=s.createConversation(alice,{bbl:'1001620041'});
 s.createRun(alice,c.id,'Underwrite 6 Chatham Sq, MN in C6-1G, listed at $4,000,000');
 const [site]=s.projectPage(alice,{q:'1001620041'}).projects;
 assert.equal(site.id,c.projectId);assert.equal(site.bbl,'1001620041');assert.match(site.title,/^Underwrite 6 Chatham Sq/);
 assert.deepEqual(s.projectPage(alice,{sitesOnly:true}).projects.map(p=>p.id),[c.projectId]);
 assert.equal(site.progress.done,0);assert.equal(site.progress.underwritten,null);
});

test('a saved site reports when it was underwritten and its acquisition call',t=>{
 const s=setup(t),c=s.createConversation(alice,{bbl:'1001620041'}),at=Date.UTC(2026,9,18);
 s.project.write(c.projectId,{
  property:{value:{bbl:'1001620041',address:'6 CHATHAM SQUARE'},provenance:{tool:'acres_find_property',sources:[]}},
  comparisons:{value:[{variants:[],decision:{call:'below_price',verdict:'Rental does not support $4,000,000.'}}],provenance:{tool:'acres_compare_programs',sources:[]}},
 },at);
 const [site]=s.projectPage(alice,{q:'1001620041'}).projects;
 assert.equal(site.progress.underwritten,at);assert.equal(site.progress.call,'below_price');assert.equal(site.title,'6 CHATHAM SQUARE');
});

test('a new conversation takes a BBL only for a new site, as ten digits',async t=>{
 const s=setup(t),server=createResearchServer({secrets:{RESEARCH_TOKEN:'listing-site-proof'},store:s,execute:async()=>{throw new Error('Creating a conversation must not run research.');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer listing-site-proof','x-acres-account':alice,'content-type':'application/json'};
 const post=body=>fetch(base+'/conversations',{method:'POST',headers,body:JSON.stringify(body)});
 const created=await post({bbl:'1001620041'});assert.equal(created.status,201);
 const jobs=await fetch(base+'/runs',{headers});assert.equal(jobs.status,200);assert.deepEqual((await jobs.json()).runs,[]);
 assert.equal(s.project.row((await created.json()).projectId).bbl,'1001620041');
 for(const bbl of ['100162004','1001620041a',1001620041])assert.equal((await post({bbl})).status,400);
 const other=s.createConversation(alice);
 assert.equal((await post({bbl:'1001620041',projectId:other.projectId})).status,400);
});

test('running research on a site is a pending job for its owner and marks the site as running',t=>{
 const s=setup(t),site=s.createConversation(alice,{bbl:'1001620041'}),chat=s.createConversation(alice);
 const run=s.createRun(alice,site.id,'Underwrite 6 Chatham Sq, MN in C6-1G, listed at $4,000,000');s.createRun(alice,chat.id,'What is R6?');
 const [job]=s.activeSiteRuns(alice);
 assert.deepEqual({id:job.id,status:job.status,conversationId:job.conversationId,projectId:job.projectId,bbl:job.bbl,next:job.progress.next},{id:run.id,status:'queued',conversationId:site.id,projectId:site.projectId,bbl:'1001620041',next:1});
 assert.equal(s.activeSiteRuns(alice).length,1,'a chat question outside a site is not a job');
 assert.equal(s.activeSiteRuns('b'.repeat(24)).length,0);
 assert.equal(s.projectPage(alice,{q:'1001620041'}).projects[0].running,run.created);
 assert.equal(job.step,null,'a queued job is on no step yet');
 assert.deepEqual({waitingFor:job.waitingFor,queueAhead:job.queueAhead},{waitingFor:'slot',queueAhead:0},'it waits for a slot, first in line');
 s.begin(run);s.event(run.id,'tool.started',{tool:'acres_find_property'});
 assert.equal(s.activeSiteRuns(alice)[0].step,1);
 s.event(run.id,'tool.started',{tool:'acres_zoning_envelope'});
 assert.equal(s.activeSiteRuns(alice)[0].step,2,'the step follows the tools the run has started, before any field is saved');
 s.finish(run,'completed',{answer:'Done.',sources:[]});
 // A finished job stays listed as ended for half an hour, so a person who left sees it finish.
 const [ended]=s.activeSiteRuns(alice);
 assert.deepEqual({id:ended.id,status:ended.status,step:ended.step},{id:run.id,status:'completed',step:undefined});assert.ok(ended.endedAt>=run.created);
 assert.deepEqual(s.activeSiteRuns(alice,Date.now()+31*60000),[]);
 assert.equal(s.projectPage(alice,{q:'1001620041'}).projects[0].running,null);
});

test('a job reads its step from specialist tools run through the gateway and carries a measured time estimate',t=>{
 const s=setup(t),site=s.createConversation(alice,{bbl:'1001620041'});
 const ask='Underwrite this site end to end in one pass: resolve the parcel if it is missing';
 // Three finished runs of the same request took 4, 5 and 9 minutes from start to finish.
 for(const minutes of [4,9,5]){
  const done=s.createRun(alice,site.id,`${ask} (${minutes})`);s.begin(done);
  s.write("UPDATE events SET time=? WHERE run=? AND event='run.started'",Date.now()-minutes*60000,done.id);
  s.finish(done,'completed',{answer:'Done.',sources:[],property:{bbl:'1001620041',address:`${minutes} Chatham Sq`}});
 }
 // A run that only asked a question back saved nothing; its few seconds do not shorten the estimate.
 for(const n of [1,2]){const asked=s.createRun(alice,site.id,`${ask} (asked ${n})`);s.begin(asked);s.finish(asked,'completed',{answer:'Which property?',sources:[]});}
 const run=s.createRun(alice,site.id,ask);
 assert.equal(s.activeSiteRuns(alice)[0].typicalMs>4.9*60000&&s.activeSiteRuns(alice)[0].typicalMs<5.1*60000,true,'the median of the recent runs');
 assert.equal(s.activeSiteRuns(alice)[0].startedAt,null,'a queued job has not started');
 s.begin(run);s.event(run.id,'tool.started',{tool:'acres_find_property'});
 s.event(run.id,'tool.started',{tool:'acres_execute_capability',arguments:{name:'acres_pro_forma',arguments:{}}});
 const [job]=s.activeSiteRuns(alice);
 assert.equal(job.step,3,'a pro forma through the gateway puts the run on step 3');
 assert.ok(job.startedAt<=Date.now());
 assert.equal(s.typicalRunMs('A question asked only once'),null,'too few runs to say');
});
