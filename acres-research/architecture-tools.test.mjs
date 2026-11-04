import test from 'node:test';
import {pdfDocument} from './testing/pdf-document.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {Architecture} from './architecture-artifacts.mjs';
import {Drawings,fetchDrawing} from './architecture-drawings.mjs';
import {createArchitectureTools,draftPlan,planFromSvg,planCandidates,excludedSource,typicalFloor} from './architecture-tools.mjs';
import {validatePlan} from './plan-intake.mjs';

const alice='a'.repeat(24);
const sha=data=>createHash('sha256').update(data).digest('hex');
const buildPlan=async(doc,{outDir})=>{
  const ifc=`ISO-10303-21;\n/* r${doc.revision} */\nEND-ISO-10303-21;\n`;
  writeFileSync(join(outDir,'model.ifc'),ifc);
  return {hasIfc:true,ifcSha256:sha(ifc)};
};
const JPEG=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.alloc(32,2)]);
const jobView=row=>({jobId:row.job_id,status:row.status});

// Two rooms side by side in feet: a 15 x 12 living room and a 10 x 12 bedroom, a door between them.
const twoRooms={units:'ft',rooms:[{name:'Living',x:0,y:0,width:15,depth:12},{name:'Bedroom',x:15,y:0,width:10,depth:12}],
  openings:[{kind:'door',x:15,y:6},{kind:'window',x:7.5,y:0,width:4}]};

function setup(t,{fetchDrawing}={}){
  const dir=mkdtempSync(join(tmpdir(),'acres-plan-tools-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  const options={stateDir:join(dir,'state'),buildPlan,...(fetchDrawing?{fetchDrawing}:{})};
  const architecture=new Architecture(store,options),drawings=new Drawings(store,options);
  const conversation=store.createConversation(alice);
  const projectId=conversation.projectId;
  const plans={projectId,summary:()=>architecture.summary(alice,projectId,jobView),drawings:()=>drawings.list(alice,projectId),
    drawing:id=>drawings.open(alice,projectId,id),attach:input=>drawings.addFromUrl(alice,projectId,{...input,by:'agent'}),
    save:({parentRevision,plan})=>architecture.save(alice,projectId,{parentRevision,plan,by:'agent'},jobView)};
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,drawings,projectId,plans};
}

test('excludedSource refuses short-term and furnished rental platforms only',()=>{
  for(const url of ['https://www.airbnb.com/rooms/1','https://airbnb.co.uk/x','https://www.vrbo.com/1','https://www.booking.com/h','https://www.furnishedfinder.com/p','https://www.airdna.co/x','https://blueground.com/a','https://nyc.furnishedapartments.com/a','not a url'])
    assert.equal(excludedSource(url),true,url);
  for(const url of ['https://streeteasy.com/building/x','https://www.corcoran.com/listing/1','https://www.loopnet.com/Listing/1','https://images.example.com/fp.jpg'])
    assert.equal(excludedSource(url),false,url);
});

test('draftPlan lays rectangles out as one wall per shared edge, named rooms and placed openings',()=>{
  const plan=draftPlan({...twoRooms,name:'Unit 4B'});
  assert.equal(plan.walls.length,5,'two rooms share their middle wall and their long walls merge');
  assert.deepEqual(plan.rooms.map(r=>r.name).sort(),['Bedroom','Living']);
  const living=plan.rooms.find(r=>r.name==='Living');
  assert.ok(Math.abs(Math.abs(living.polygon.reduce((s,p,i,a)=>s+p[0]*a[(i+1)%a.length][1]-a[(i+1)%a.length][0]*p[1],0)/2)-15*12*0.3048**2)<1e-6);
  const door=plan.openings.find(o=>o.kind==='door'),shared=plan.walls.find(w=>w.id===door.wallId);
  assert.deepEqual([shared.start[0],shared.end[0]],[15*0.3048,15*0.3048],'the door sits on the shared wall');
  assert.ok(Math.abs(door.offset-(6*0.3048-0.45))<1e-6,'centred on its point');
  assert.ok(Math.abs(plan.openings.find(o=>o.kind==='window').width-4*0.3048)<1e-6);
  assert.deepEqual(validatePlan(plan).filter(i=>i.severity==='error'),[]);
  assert.throws(()=>draftPlan({rooms:[{name:'A',x:0,y:0,width:0,depth:3}]}),/width and depth/);
  assert.deepEqual(draftPlan({rooms:[{name:'Bath \u2014 approximate',x:0,y:0,width:5,depth:8}]}).rooms.map(r=>r.name),['Bath, approximate']);
  assert.throws(()=>draftPlan({rooms:[{name:'A',x:0,y:0,width:3,depth:3}],openings:[{kind:'door',x:10,y:10}]}),/not on a wall/);
  const rounded=draftPlan({units:'ft',rooms:[{name:'Living',x:0,y:0,width:15,depth:12},{name:'Bedroom',x:15.02,y:0,width:10,depth:12.03}]});
  assert.equal(rounded.walls.length,5,'edges a fraction of an inch apart are one wall');
  assert.deepEqual(validatePlan(rounded).filter(i=>i.severity==='error'),[]);
  assert.throws(()=>draftPlan({units:'ft',rooms:[{name:'Apartment',x:0,y:0,width:30,depth:20},{name:'Closet',x:2,y:2,width:3,depth:3}]}),/Apartment and Closet overlap/);
});

const MIX=[{name:'studio',share:0.2,targetSqft:450},{name:'1 bedroom',share:0.5,targetSqft:650},{name:'2 bedroom',share:0.3,targetSqft:950}];
const rect=r=>[r.x,r.y,r.x+r.width,r.y+r.depth];
const overlaps=rooms=>rooms.some((a,i)=>rooms.slice(i+1).some(b=>{const[p,q]=[rect(a),rect(b)];return Math.min(p[2],q[2])-Math.max(p[0],q[0])>1e-6&&Math.min(p[3],q[3])-Math.max(p[1],q[1])>1e-6;}));

test('typicalFloor lays out a wide plate double-loaded and a narrow one around a stair hall, filling the plate with the mix',()=>{
  for(const [width,depth] of [[100,60],[60,140]]){
    const floor=typicalFloor({width,depth,mix:MIX});
    const names=floor.rooms.map(r=>r.name);
    assert.deepEqual(names.filter(n=>!n.startsWith('Unit ')),['Corridor','Stair A','Stair B','Elevator core']);
    assert.equal(names.filter(n=>n.startsWith('Unit ')).length,floor.unitsPerFloor);
    assert.ok(floor.unitsPerFloor>=6,`${width} by ${depth}`);
    assert.ok(new Set(names.filter(n=>n.startsWith('Unit ')).map(n=>n.split(', ')[1])).size>=2,'more than one unit type');
    assert.ok(Math.abs(floor.rooms.reduce((s,r)=>s+r.width*r.depth,0)-width*depth)<1e-6,'the rooms tile the plate');
    assert.equal(overlaps(floor.rooms),false);
    const plan=draftPlan({...floor,name:'Typical floor'});
    assert.deepEqual(validatePlan(plan).filter(i=>i.severity==='error'),[]);
    assert.equal(plan.openings.filter(o=>o.kind==='window').length,floor.unitsPerFloor,'one window per unit');
  }
  const narrow=typicalFloor({width:25,depth:80,mix:MIX});
  assert.deepEqual(narrow.rooms.map(r=>r.name),['Stair hall','Unit 1, 1 bedroom','Unit 2, 2 bedroom']);
  assert.deepEqual(validatePlan(draftPlan(narrow)).filter(i=>i.severity==='error'),[]);
  assert.throws(()=>typicalFloor({width:10,depth:30,mix:MIX}),/too small/);
  assert.throws(()=>typicalFloor({width:60,depth:100,mix:[{name:'studio',share:0,targetSqft:450}]}),/share above zero/);
});

test('an underwriting saves its typical floor once: a plan already there is kept, not drafted again',async t=>{
  const {plans}=setup(t);
  const tools=createArchitectureTools({plans});
  const first=await tools.handlers.acres_save_plan({parentRevision:0,typicalFloor:{width:100,depth:60,mix:MIX}});
  assert.equal(first.saved,true);
  assert.equal(first.revision,1);
  assert.equal(first.unitsPerFloor,first.rooms.filter(r=>r.name.startsWith('Unit ')).length);
  assert.equal(plans.summary().current.plan.name,`Typical floor, ${first.unitsPerFloor} units`);
  const again=await tools.handlers.acres_save_plan({parentRevision:0,typicalFloor:{width:100,depth:60,mix:MIX}});
  assert.deepEqual({saved:again.saved,conflict:again.conflict},{saved:false,conflict:true});
  assert.match(again.note,/already has a floor plan\. Keep it/);
  assert.equal(plans.summary().current.revision,1);
  await assert.rejects(tools.handlers.acres_save_plan({parentRevision:1,draft:twoRooms,typicalFloor:{width:100,depth:60,mix:MIX}}),/exactly one of draft, plan, fromDrawing or typicalFloor/);
});

test('the agent saves, reads and revises the plan through the same revision guard as the editor',async t=>{
  const {store,projectId,plans}=setup(t);
  const tools=createArchitectureTools({plans});
  assert.deepEqual(tools.definitions.map(d=>d.name),['acres_find_floor_plan','acres_attach_drawing','acres_view_drawing','acres_read_plan','acres_save_plan','acres_render_plan','acres_import_pascal_scene']);
  const empty=tools.handlers.acres_read_plan({});
  assert.equal(empty.revision,null);
  const first=await tools.handlers.acres_save_plan({parentRevision:0,name:'Unit 4B',draft:twoRooms});
  assert.equal(first.saved,true);assert.equal(first.revision,1);
  assert.deepEqual(first.rooms.map(r=>[r.name,r.areaSqft]).sort(),[['Bedroom',120],['Living',180]]);
  const read=tools.handlers.acres_read_plan({});
  assert.equal(read.revision,1);assert.equal(read.walls.length,5);assert.equal(read.openings.length,2);
  assert.equal(read.issues.filter(i=>i.severity==='error').length,0);
  const stale=await tools.handlers.acres_save_plan({parentRevision:0,draft:twoRooms});
  assert.deepEqual({saved:stale.saved,conflict:stale.conflict,currentRevision:stale.currentRevision},{saved:false,conflict:true,currentRevision:1});
  const current=read.document;
  const roundTrip=await tools.handlers.acres_save_plan({parentRevision:1,plan:current});
  assert.equal(roundTrip.saved,true,'the document read_plan returns saves back unchanged');
  const edited=await tools.handlers.acres_save_plan({parentRevision:2,plan:{...current,rooms:current.rooms.map(r=>r.name==='Bedroom'?{...r,name:'Primary bedroom'}:r)}});
  assert.equal(edited.revision,3);
  assert.ok(edited.rooms.some(r=>r.name==='Primary bedroom'));
  const broken=await tools.handlers.acres_save_plan({parentRevision:3,plan:{...current,walls:current.walls.slice(1)}});
  assert.equal(broken.saved,false);
  assert.ok(broken.issues.some(i=>i.code==='room-open-boundary'));
  assert.equal(plans.summary().current.revision,3,'an invalid plan is never saved');
  const events=store.projectEvents(projectId).filter(e=>e.event==='architecture.revision');
  assert.deepEqual(events.map(e=>[e.revision,e.by]),[[1,'agent'],[2,'agent'],[3,'agent']]);
  assert.equal(store.project.read(projectId).architecture.provenance.tool,'acres_save_plan');
  await assert.rejects(tools.handlers.acres_save_plan({parentRevision:3}),/exactly one/);
  await assert.rejects(tools.handlers.acres_save_plan({draft:twoRooms}),/parentRevision/);
});

test('an attached SVG drawing is traced into a plan at the scale the agent gives',async t=>{
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#fff"/>
    <g stroke="#111" stroke-width="6"><line x1="20" y1="20" x2="380" y2="20"/><line x1="380" y1="20" x2="380" y2="280"/><line x1="380" y1="280" x2="20" y2="280"/><line x1="20" y1="280" x2="20" y2="20"/><line x1="200" y1="20" x2="200" y2="280"/></g>
    <text x="100" y="150">Kitchen</text><text x="290" y="150">Bedroom</text></svg>`;
  const plan=planFromSvg(svg,{widthMetres:10,name:'Traced',ref:'plan.svg'});
  assert.equal(plan.walls.length,5);
  assert.deepEqual(plan.rooms.map(r=>r.name).sort(),['Bedroom','Kitchen']);
  assert.ok(Math.abs(plan.walls[0].thickness-0.18)<1e-9);
  const width=Math.max(...plan.walls.flatMap(w=>[w.start[0],w.end[0]]))-Math.min(...plan.walls.flatMap(w=>[w.start[0],w.end[0]]));
  assert.ok(Math.abs(width-10)<1e-6,'the walls span the published 10 m');
  assert.ok(Math.abs(plan.scale.metresPerDrawingUnit-10/360)<1e-9);
  assert.throws(()=>planFromSvg(svg,{widthMetres:0}),/widthMetres/);
  const {drawings,projectId,plans}=setup(t);
  const stored=drawings.add(alice,projectId,{bytes:Buffer.from(svg),name:'plan.svg',by:'user'});
  const tools=createArchitectureTools({plans});
  const saved=await tools.handlers.acres_save_plan({parentRevision:0,fromDrawing:{drawingId:stored.id,widthMetres:10}});
  assert.equal(saved.saved,true);
  assert.equal(plans.summary().current.plan.sources[0].ref,'plan.svg');
});

test('acres_find_floor_plan gathers plan images and brochures from search and the given pages, never rental platforms',async t=>{
  const {plans}=setup(t);
  const pages={
    'https://building.example.com/residences':`<html><body><img src="/logo.png" alt="Logo"><img data-src="/img/fp-4b.jpg" alt="Residence 4B floor plan">
      <a href="/docs/offering-memorandum.pdf">Offering memorandum</a><a href="https://www.airbnb.com/rooms/9">Stay here</a><a href="/about">About</a></body></html>`,
    'https://listings.example.com/4b':`<html><body><img srcset="https://cdn.example.com/plans/floorplan-4b.webp 1x, x 2x" alt="">Living room 15' x 12'</body></html>`,
  };
  const requests=[];
  const request=async(url,options)=>{
    requests.push(url);
    if(url==='https://google.serper.dev/images')return new Response(JSON.stringify({images:[
      {title:'245 Example St floor plan',imageUrl:'https://img.example.com/245-fp.png',link:'https://broker.example.com/245'},
      {title:'Cozy loft',imageUrl:'https://a0.muscache.com/x.jpg',link:'https://www.airbnb.com/rooms/1'}]}));
    if(url==='https://google.serper.dev/search'){
      assert.equal(JSON.parse(options.body).q,'245 Example St, New York, NY floor plan');
      return new Response(JSON.stringify({organic:[{link:'https://listings.example.com/4b',title:'Unit 4B'},{link:'https://broker.example.com/245-brochure.pdf',title:'245 Example St offering memorandum'},{link:'https://www.vrbo.com/1',title:'Vacation'}]}));
    }
    if(pages[url])return new Response(pages[url],{headers:{'content-type':'text/html; charset=utf-8'}});
    return new Response('missing',{status:404});
  };
  const lookup=async()=>[{address:'93.184.216.34'}];
  const tools=createArchitectureTools({plans,secrets:{SERPER_API_KEY:'k'.repeat(20)},request,lookup});
  const found=await tools.handlers.acres_find_floor_plan({query:'245 Example St, New York, NY',url:'https://building.example.com/residences'});
  const urls=found.candidates.map(c=>c.url);
  assert.ok(urls.includes('https://img.example.com/245-fp.png'));
  assert.ok(urls.includes('https://building.example.com/img/fp-4b.jpg'));
  assert.ok(urls.includes('https://building.example.com/docs/offering-memorandum.pdf'));
  assert.ok(urls.includes('https://broker.example.com/245-brochure.pdf'));
  assert.ok(urls.includes('https://cdn.example.com/plans/floorplan-4b.webp'));
  assert.ok(!urls.some(u=>/logo|muscache|airbnb|vrbo/.test(u)),'no logos or rental platforms');
  assert.ok(!requests.some(u=>/vrbo|airbnb/.test(u)),'rental platforms are never fetched');
  const fp=found.candidates.find(c=>c.url.endsWith('fp-4b.jpg'));
  assert.deepEqual({kind:fp.kind,foundOn:fp.foundOn,foundVia:fp.foundVia,label:fp.label},{kind:'image',foundOn:'https://building.example.com/residences',foundVia:'page image',label:'Residence 4B floor plan'});
  assert.equal(found.candidates.find(c=>c.url.endsWith('245-fp.png')).foundOn,'https://broker.example.com/245');
  assert.deepEqual(found.pagesRead.map(p=>p.url).sort(),['https://building.example.com/residences','https://listings.example.com/4b']);
  await assert.rejects(tools.handlers.acres_find_floor_plan({url:'https://www.airbnb.com/rooms/1'}),/excluded/);
  await assert.rejects(tools.handlers.acres_find_floor_plan({}),/address/);
  assert.deepEqual(planCandidates('<img src="/a.png" alt="Kitchen photo">','https://x.example.com/'),[]);
});

test('acres_attach_drawing stores the file as the agent\'s and refuses rental platforms, also behind a redirect',async t=>{
  const fetcher=async(url,{allow})=>{
    const lookup=async()=>[{address:'93.184.216.34'}];
    const request=async u=>u.includes('short.example.com')?{status:302,ok:false,headers:new Headers({location:'https://a0.muscache.com/plan.jpg'})}:new Response(JPEG);
    return fetchDrawing(url,{allow,lookup,request});
  };
  const {store,projectId,plans}=setup(t,{fetchDrawing:fetcher});
  const tools=createArchitectureTools({plans});
  const {drawing}=await tools.handlers.acres_attach_drawing({url:'https://img.example.com/245-fp.jpg',name:'245 typical floor',foundOn:'https://broker.example.com/245'});
  assert.deepEqual({kind:drawing.kind,name:drawing.name,by:drawing.by,foundOn:drawing.foundOn,sourceUrl:drawing.sourceUrl},
    {kind:'jpeg',name:'245 typical floor.jpg',by:'agent',foundOn:'https://broker.example.com/245',sourceUrl:'https://img.example.com/245-fp.jpg'});
  assert.equal(store.projectEvents(projectId).find(e=>e.event==='architecture.drawing').by,'agent');
  assert.deepEqual(tools.handlers.acres_read_plan({}).drawings.map(d=>d.id),[drawing.id]);
  await assert.rejects(tools.handlers.acres_attach_drawing({url:'https://a0.muscache.com/x.jpg',foundOn:'https://www.airbnb.com/rooms/1'}),/excluded/);
  await assert.rejects(tools.handlers.acres_attach_drawing({url:'https://short.example.com/p'}),/not a usable plan source/);
  assert.equal(store.projectEvents(projectId).filter(e=>e.event==='architecture.drawing').length,1);
});

test('a research run gets plan access to its own project as its sender, and none when architecture is off or the sender is not in the rollout',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-plan-run-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const [enabled,emails] of [[true,'alice@example.com'],[false,''],['rollout','someone@example.com']]){
    const store=new ChatStore(join(dir,`chat-${enabled}.sqlite`));
    store.touchPerson(alice,'alice@example.com');
    let seen;
    const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async input=>{seen=input.architecture;return {answer:'x',sources:[],ui:[]};},
      architecture:enabled?{stateDir:join(dir,'state'),buildPlan,worker:null,pipelineVersion:'test',emails}:null});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const api=(path,method='GET',body)=>fetch(base+path,{method,headers:{authorization:'Bearer test','x-acres-account':alice,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}).then(r=>r.json());
    const conversation=await api('/conversations','POST',{});
    const run=await api(`/conversations/${conversation.id}/runs`,'POST',{message:'Find the floor plan'});
    for(let i=0;i<100&&!['completed','failed'].includes((await api(`/runs/${run.id}`)).status);i++)await sleep(20);
    if(enabled===true){
      assert.equal(seen.projectId,conversation.projectId);
      assert.equal(seen.summary().current,null);
      const saved=await createArchitectureTools({plans:seen}).handlers.acres_save_plan({parentRevision:0,draft:twoRooms});
      assert.equal(saved.revision,1);
      assert.equal((await api(`/projects/${conversation.projectId}/architecture`)).current.createdBy,alice);
    } else assert.equal(seen,null);
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();
  }
});

test('modeling creation follows the rollout list: exact emails, whole domains and the judging-window wildcard',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-rollout-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const [emails,touch,expected] of [['alice@example.com',true,201],['@EXAMPLE.com',true,201],['@other.test',true,404],['@sub.example.com',true,404],['*',true,201],['*',false,404],['someone@example.com',true,404]]){
    const store=new ChatStore(join(dir,`chat-${emails}-${touch}.sqlite`));
    if(touch)store.touchPerson(alice,'alice@example.com');
    const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({answer:'x',sources:[],ui:[]}),
      architecture:{stateDir:join(dir,'state'),buildPlan,worker:null,pipelineVersion:'test',emails}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const response=await fetch(`http://127.0.0.1:${server.address().port}/projects`,{method:'POST',headers:{authorization:'Bearer test','x-acres-account':alice,'content-type':'application/json'},body:JSON.stringify({workflow:'modeling',address:'123 Main Street'})});
      assert.equal(response.status,expected,`emails=${emails} touch=${touch}`);
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
  }
});

test('acres_view_drawing shows a raster plan as an image, a PDF as its text and an SVG as its labels',async t=>{
  const {drawings,projectId,plans}=setup(t);
  const tools=createArchitectureTools({plans});
  const jpeg=drawings.add(alice,projectId,{bytes:JPEG,name:'plan.jpg',by:'agent'});
  const seen=await tools.handlers.acres_view_drawing({drawingId:jpeg.id});
  assert.deepEqual(seen.contentImages,[`data:image/jpeg;base64,${JPEG.toString('base64')}`]);
  assert.equal(seen.drawing.kind,'jpeg');
  const svg=drawings.add(alice,projectId,{bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="1" y="1">Kitchen</text><text x="5" y="5">12\' x 10\'</text></svg>'),name:'p.svg',by:'user'});
  const labels=await tools.handlers.acres_view_drawing({drawingId:svg.id});
  assert.deepEqual(labels.labels,['Kitchen',"12' x 10'"]);
  assert.equal(labels.contentImages,undefined);
  await assert.rejects(tools.handlers.acres_view_drawing({drawingId:'missing'}),/not attached/);
});

test('acres_view_drawing says what a trace would miss and when a PDF is a scan without text',async t=>{
  const {drawings,projectId,plans}=setup(t);
  const tools=createArchitectureTools({plans});
  const curved=drawings.add(alice,projectId,{bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><line x1="0" y1="0" x2="80" y2="0" stroke="#000" stroke-width="4"/><line x1="80" y1="0" x2="80" y2="60" stroke="#000" stroke-width="4"/><path d="M0,0 A60,60 0 0 0 0,60" stroke="#000" stroke-width="4"/><line x1="40" y1="90" x2="45" y2="95" stroke="#888"/></svg>'),name:'curved.svg',by:'user'});
  const read=await tools.handlers.acres_view_drawing({drawingId:curved.id});
  assert.match(read.note,/1 curved path could not be read as walls; 1 mark could not be read as a wall or opening\./);
  const scanned=drawings.add(alice,projectId,{bytes:pdfDocument([[]]),name:'scan.pdf',by:'user'});
  const scan=await tools.handlers.acres_view_drawing({drawingId:scanned.id});
  assert.equal(scan.text.trim(),'');assert.match(scan.note,/no readable text, so it is likely a scanned image/);
  const typed=drawings.add(alice,projectId,{bytes:pdfDocument([['Living 14 x 12']]),name:'typed.pdf',by:'user'});
  assert.doesNotMatch((await tools.handlers.acres_view_drawing({drawingId:typed.id})).note,/scanned/);
});

test('an agent save queues the walkthrough finished products, and acres_render_plan reports them without faking readiness',async t=>{
  const {plans}=setup(t);
  await assert.rejects(createArchitectureTools({plans:{...plans,render:async()=>{throw new Error('must not run');}}}).handlers.acres_render_plan({}),/no plan revision to render/i);
  const calls=[];
  let job={id:'job-1',revision:1,status:'queued',reason:null,artifacts:[]};
  const rendering={...plans,render:async({revision})=>{calls.push(revision);return {...job,revision};}};
  const tools=createArchitectureTools({plans:rendering});
  const first=await tools.handlers.acres_save_plan({parentRevision:0,name:'Unit 4B',draft:twoRooms});
  assert.equal(first.saved,true);
  assert.deepEqual(calls,[1],'saving revision 1 queues its finished products');
  assert.deepEqual(first.walkthrough,{status:'queued',jobId:'job-1',reason:null,outputs:[]});
  assert.match(first.note,/queued/i);
  assert.doesNotMatch(first.note,/preview is ready|already built/i,'a queued job is never reported as finished');
  const queued=await tools.handlers.acres_render_plan({});
  assert.equal(queued.revision,1);assert.equal(queued.walkthrough.status,'queued');
  job={id:'job-1',status:'succeeded',reason:null,artifacts:[{kind:'preview',bytes:2048},{kind:'glb',bytes:4096},{kind:'blend',bytes:8192},{kind:'manifest',bytes:512},{kind:'verification',bytes:256}]};
  const done=await tools.handlers.acres_render_plan({revision:1});
  assert.equal(done.walkthrough.status,'succeeded');
  assert.deepEqual(done.walkthrough.outputs.map(o=>o.kind),['preview','glb','blend','manifest','verification']);
  assert.match(done.note,/ready/i);
  await assert.rejects(tools.handlers.acres_render_plan({revision:'1; rm -rf /'}),/revision/);
});

test('a disabled walkthrough worker never fails an agent save, and is reported as unavailable',async t=>{
  const {plans}=setup(t);
  const disabled=Object.assign(new Error('Architecture processing is not enabled.'),{status:503});
  const tools=createArchitectureTools({plans:{...plans,render:async()=>{throw disabled;}}});
  const first=await tools.handlers.acres_save_plan({parentRevision:0,name:'Unit 4B',draft:twoRooms});
  assert.equal(first.saved,true,'the plan still saves when rendering is off');
  assert.equal(first.walkthrough.status,'unavailable');
  assert.match(first.walkthrough.reason,/not enabled/);
  const render=await tools.handlers.acres_render_plan({});
  assert.equal(render.queued,false);
  assert.equal(render.walkthrough.status,'unavailable');
  const bare=createArchitectureTools({plans});
  const second=await bare.handlers.acres_render_plan({});
  assert.equal(second.walkthrough.status,'unavailable','a host with no renderer says so instead of throwing');
});

test('an edited Pascal scene imports as a new revision through the same guard and queues rendering', async t => {
  const {drawings, projectId, plans} = setup(t);
  const rendering = {...plans, render: async ({revision}) => ({id: 'job-9', revision, status: 'queued', artifacts: []})};
  const tools = createArchitectureTools({plans: rendering});
  const node = (id, type, extra = {}) => ({object: 'node', id, type, name: id, parentId: null, visible: true, ...extra});
  const scene = {nodes: {
    site_1: node('site_1', 'site', {metadata: {acresId: 'site'}, polygon: {type: 'polygon', points: [[-2, 2], [12, 2], [12, -10], [-2, -10]]}, children: ['building_1']}),
    building_1: node('building_1', 'building', {name: 'Unit 4B edited', parentId: 'site_1', metadata: {acresId: 'building'}, children: ['level_1'], position: [0, 0, 0], rotation: [0, 0, 0]}),
    level_1: node('level_1', 'level', {name: 'Level 1', parentId: 'building_1', metadata: {acresId: 'level-1'}, level: 0, baseElevation: 0, height: 2.8, children: ['wall_s', 'wall_n', 'wall_w', 'wall_e', 'zone_1']}),
    wall_s: node('wall_s', 'wall', {parentId: 'level_1', metadata: {acresId: 'wall-south'}, start: [0, 0], end: [10, 0], thickness: 0.18, height: 2.8, children: ['door_1']}),
    wall_n: node('wall_n', 'wall', {parentId: 'level_1', metadata: {acresId: 'wall-north'}, start: [10, -8], end: [0, -8], thickness: 0.18, height: 2.8}),
    wall_w: node('wall_w', 'wall', {parentId: 'level_1', start: [0, -8], end: [0, 0], thickness: 0.18, height: 2.8}),
    wall_e: node('wall_e', 'wall', {parentId: 'level_1', start: [10, 0], end: [10, -8], thickness: 0.18, height: 2.8}),
    door_1: node('door_1', 'door', {name: 'opening-entry', parentId: 'wall_s', wallId: 'wall_s', metadata: {acresId: 'opening-entry'}, doorType: 'hinged', position: [6, 1.05, 0], rotation: [0, 0, 0], width: 0.9, height: 2.1}),
    zone_1: node('zone_1', 'zone', {name: 'Living', parentId: 'level_1', metadata: {acresId: 'room-living'}, polygon: [[0.09, -0.09], [9.91, -0.09], [9.91, -7.91], [0.09, -7.91]], spaceRole: 'room', enclosureStatus: 'enclosed', boundaryWallIds: ['wall_s', 'wall_n', 'wall_w', 'wall_e'], ceilingHeight: 2.8}),
  }, rootNodeIds: ['site_1']};
  const drawing = drawings.add(alice, projectId, {bytes: Buffer.from(JSON.stringify(scene)), name: 'unit-4b.pascal.json', by: 'user'});
  assert.equal(drawing.kind, 'pascal-scene');
  const imported = await tools.handlers.acres_import_pascal_scene({drawingId: drawing.id, parentRevision: 0});
  assert.equal(imported.saved, true, JSON.stringify(imported));
  assert.equal(imported.revision, 1);
  assert.equal(imported.walkthrough.status, 'queued');
  assert.match(imported.note, /Imported from Pascal scene/);
  const read = tools.handlers.acres_read_plan({});
  assert.equal(read.rooms[0].name, 'Living');
  assert.equal(read.document.openings.find(o => o.id === 'opening-entry').offset, 5.55, 'the door edit made in Pascal is the saved offset');
  const notScene = drawings.add(alice, projectId, {bytes: JPEG, name: 'photo.jpg', by: 'user'});
  await assert.rejects(tools.handlers.acres_import_pascal_scene({drawingId: notScene.id, parentRevision: 1}), /not a Pascal scene/);
  const conflict = await tools.handlers.acres_import_pascal_scene({drawingId: drawing.id, parentRevision: 0});
  assert.equal(conflict.saved, false);
  assert.equal(conflict.conflict, true);
});
