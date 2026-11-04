import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DOMParser} from 'linkedom';
import {
  PLAN_SCHEMA,DEFAULTS,LIMITS,checkUpload,sanitizeSvg,extractPrimitives,proposeFromPrimitives,
  calibrate,toMetres,toPixels,planFromDrawing,planFromFixture,detectRooms,validatePlan,exportPlan,
  addWall,moveWall,splitWall,deleteWall,placeOpening,reprojectPlan,wallLength,
  savePlan,loadPlan,draftKey,writeDraft,readDraft,
  listDrawings,uploadDrawing,fetchDrawing,drawingUrl,planEventActions,readingLosses,roomLabel,
} from '../public/plan-intake.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/sample-floorplan.json',import.meta.url),'utf8'));
const svgText=readFileSync(new URL('./fixtures/sample-floorplan.svg',import.meta.url),'utf8');
const deps={DOMParser};
const MM=0.001;
const near=(a,b,msg)=>assert.ok(Math.abs(a-b)<=MM,`${msg}: ${a} vs ${b}`);
const nearPt=(a,b,msg)=>{near(a[0],b[0],msg+' x');near(a[1],b[1],msg+' y');};
const bounds=(poly)=>{const xs=poly.map(p=>p[0]),ys=poly.map(p=>p[1]);return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];};
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const sameSegment=(w,s)=>(dist(w.start,s.start)<=MM&&dist(w.end,s.end)<=MM)||(dist(w.start,s.end)<=MM&&dist(w.end,s.start)<=MM);
// The fixture drawing places the 10.00 m south wall from (60,500) to (620,500).
const fixtureCalibration=()=>calibrate([60,500],[620,500],10);
const drawingPlan=()=>{
  const clean=sanitizeSvg(svgText,deps);
  const prims=extractPrimitives(clean.svg,deps);
  const proposal=proposeFromPrimitives(prims);
  return {plan:planFromDrawing({proposal,calibration:fixtureCalibration(),source:{kind:'svg',ref:'sample-floorplan.svg'}}),prims,proposal,clean};
};

test('uploads: svg, pdf, png, jpeg and webp are accepted by type or extension, each with a size bound',()=>{
  assert.deepEqual(checkUpload({name:'plan.svg',type:'image/svg+xml',size:2000}),{kind:'svg',contentType:'image/svg+xml'});
  assert.equal(checkUpload({name:'plan.PDF',type:'application/pdf',size:2000}).kind,'pdf');
  assert.equal(checkUpload({name:'scan.png',type:'image/png',size:2000}).kind,'png');
  assert.deepEqual(checkUpload({name:'photo.JPG',type:'',size:2000}),{kind:'jpeg',contentType:'image/jpeg'});
  assert.equal(checkUpload({name:'photo.jpeg',type:'image/jpeg',size:2000}).kind,'jpeg');
  assert.deepEqual(checkUpload({name:'listing.webp',type:'image/webp',size:2000}),{kind:'webp',contentType:'image/webp'});
  // A drawing from the server keeps its name; its content type decides the kind.
  assert.equal(checkUpload({name:'Floor plan from the listing',type:'image/webp',size:2000}).kind,'webp');
  assert.throws(()=>checkUpload({name:'plan.dwg',type:'',size:10}),/SVG, PDF, PNG, JPEG or WebP/);
  assert.throws(()=>checkUpload({name:'plan.gif',type:'image/gif',size:10}),/SVG, PDF, PNG, JPEG or WebP/);
  assert.throws(()=>checkUpload({name:'plan.svg',type:'image/svg+xml',size:LIMITS.svgBytes+1}),/too large/);
  assert.throws(()=>checkUpload({name:'scan.png',type:'image/png',size:LIMITS.pngBytes+1}),/too large/);
  assert.throws(()=>checkUpload({name:'scan.jpg',type:'image/jpeg',size:LIMITS.jpegBytes+1}),/limit is 15 MB/);
  assert.throws(()=>checkUpload({name:'scan.webp',type:'image/webp',size:LIMITS.webpBytes+1}),/limit is 15 MB/);
  assert.throws(()=>checkUpload({name:'a.pdf',type:'application/pdf',size:LIMITS.pdfBytes+1}),/too large/);
});

test('drawings: list, upload the raw bytes with the encoded name, and download one by id',async()=>{
  const view={id:'drw_1',name:'Unit 4B plan.png',kind:'png',contentType:'image/png',bytes:4,by:'user'};
  const calls=[];
  const api=async(url,init={})=>{
    calls.push([url,init]);
    if(init.method==='POST')return new Response(JSON.stringify(view),{status:201});
    if(url.endsWith('/drawings'))return new Response(JSON.stringify({drawings:[view]}),{status:200});
    return new Response(new Uint8Array([137,80,78,71]),{status:200,headers:{'content-type':'image/png'}});
  };
  assert.deepEqual(await listDrawings({fetch:api,projectId:'proj 1'}),[view]);
  assert.equal(calls[0][0],'/api/projects/proj%201/architecture/drawings');
  const file=new File([new Uint8Array([1,2,3])],'Unit 4B plan.png',{type:''});
  assert.deepEqual(await uploadDrawing({fetch:api,projectId:'proj_1',file}),view);
  const [url,init]=calls[1];
  assert.equal(url,'/api/projects/proj_1/architecture/drawings');
  assert.equal(init.method,'POST');assert.equal(init.body,file);
  assert.deepEqual(init.headers,{'content-type':'image/png','x-drawing-name':'Unit%204B%20plan.png'});
  assert.equal(drawingUrl('proj_1','drw/1'),'/api/projects/proj_1/architecture/drawings/drw%2F1');
  const downloaded=await fetchDrawing({fetch:api,projectId:'proj_1',drawing:view});
  assert.equal(downloaded.name,'Unit 4B plan.png');assert.equal(downloaded.type,'image/png');assert.equal(downloaded.size,4);
  assert.equal(checkUpload(downloaded).kind,'png');
  const refused=async()=>new Response(JSON.stringify({error:'Drawings must be SVG, PNG, JPEG, WebP or PDF.'}),{status:415});
  await assert.rejects(uploadDrawing({fetch:refused,projectId:'proj_1',file}),/must be SVG/);
  await assert.rejects(listDrawings({fetch:refused,projectId:'proj_1'}),/must be SVG/);
  await assert.rejects(fetchDrawing({fetch:async()=>new Response('',{status:404}),projectId:'proj_1',drawing:view}),/could not be downloaded/);
});

test('live updates: replayed history is dropped, newer revisions load or are offered, drawings refresh or fill an empty canvas',()=>{
  const base={projectId:'proj_1',revision:3,own:new Set([3]),dirty:false,empty:false,drawingIds:new Set(['drw_old'])};
  const none={revision:null,refreshDrawings:false,showDrawing:null};
  const rev=(revision,by='agent',projectId='proj_1')=>({seq:revision,event:'architecture.revision',projectId,revision,parentRevision:revision-1,by});
  const drawing=(drawingId,by='agent')=>({event:'architecture.drawing',projectId:'proj_1',drawingId,name:`${drawingId}.pdf`,kind:'pdf',by});
  assert.deepEqual(planEventActions([rev(4)],base),{...none,revision:{action:'load',revision:4,by:'agent'}});
  assert.deepEqual(planEventActions([rev(4,'user')],base).revision,{action:'load',revision:4,by:'user'});
  assert.deepEqual(planEventActions([rev(4)],{...base,dirty:true}).revision,{action:'offer',revision:4,by:'agent'});
  // A reconnect replays the project's whole history: nothing up to the loaded revision, no listed drawing.
  const history=[rev(1,'user'),drawing('drw_old'),rev(2),rev(3,'user'),drawing('drw_old','user')];
  assert.deepEqual(planEventActions(history,{...base,dirty:true,empty:true}),none);
  assert.deepEqual(planEventActions([rev(5,'user')],{...base,own:new Set([3,5])}),none);
  assert.deepEqual(planEventActions([rev(4,'agent','proj_2')],base),none);
  assert.deepEqual(planEventActions([rev(1)],{...base,revision:null,own:new Set()}).revision.action,'load');
  // Held events collapse: the newest revision wins, one list refresh, the newest Arosa drawing fills an empty canvas.
  assert.deepEqual(planEventActions([rev(4),rev(6,'user'),rev(5)],base).revision,{action:'load',revision:6,by:'user'});
  assert.deepEqual(planEventActions([drawing('drw_a'),drawing('drw_b')],{...base,empty:true}),{...none,refreshDrawings:true,showDrawing:'drw_b'});
  assert.deepEqual(planEventActions([drawing('drw_a'),drawing('drw_b','user')],{...base,empty:true}),{...none,refreshDrawings:true,showDrawing:'drw_a'});
  assert.deepEqual(planEventActions([drawing('drw_a')],base),{...none,refreshDrawings:true});
  assert.deepEqual(planEventActions([drawing('drw_a','user')],{...base,empty:true}),{...none,refreshDrawings:true});
  assert.deepEqual(planEventActions([{event:'state.updated',projectId:'proj_1',version:9},{event:'architecture.job',projectId:'proj_1',revision:9}],base),none);
});

test('svg sanitizing strips scripts, external references, foreignObject and event attributes',()=>{
  const hostile=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50" onload="alert(1)">
    <script>alert(2)</script>
    <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
    <image href="https://evil.example/a.png" width="5" height="5"/>
    <use xlink:href="https://evil.example/s.svg#a"/>
    <a href="javascript:alert(3)"><path d="M0,0 L10,0" stroke="#000"/></a>
    <style>path{fill:url(https://evil.example/f)}</style>
    <g onclick="alert(4)" style="stroke:#111;stroke-width:4;fill:url(https://evil.example/x)"><path d="M0,10 L50,10" onmouseover="alert(5)"/></g>
    <rect width="100" height="50" fill="url(https://evil.example/p)"/>
  </svg>`;
  const {svg,removed,viewBox}=sanitizeSvg(hostile,deps);
  for(const bad of ['script','foreignObject','<image','<use','javascript:','onload','onclick','onmouseover','evil.example','<style','<a ','xlink'])
    assert.ok(!svg.includes(bad),`${bad} survived: ${svg}`);
  assert.deepEqual(viewBox,[0,0,100,50]);
  // Presentation from the style attribute survives as plain attributes so lines stay extractable.
  assert.match(svg,/stroke="#111"/);assert.match(svg,/stroke-width="4"/);
  assert.match(svg,/M0,10 L50,10/);
  assert.ok(removed.length>=8,removed.join(','));
  assert.throws(()=>sanitizeSvg('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"/>',deps),/DOCTYPE/);
  assert.throws(()=>sanitizeSvg('<html><body/></html>',deps),/not an SVG/);
  assert.throws(()=>sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg">'+' '.repeat(LIMITS.svgBytes)+'</svg>',deps),/too large/);
  const fixtureClean=sanitizeSvg(svgText,deps);
  assert.deepEqual(fixtureClean.removed,[]);
  assert.deepEqual(fixtureClean.viewBox,[0,0,690,580]);
});

test('a drawing with a curved wall says it could not read the curve, and stray marks are counted',()=>{
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><line x1="0" y1="0" x2="80" y2="0" stroke="#000" stroke-width="4"/>
    <line x1="80" y1="0" x2="80" y2="60" stroke="#000" stroke-width="4"/><path d="M0,0 A60,60 0 0 0 0,60" stroke="#000" stroke-width="4"/></svg>`;
  const proposal=proposeFromPrimitives(extractPrimitives(sanitizeSvg(svg,deps).svg,deps));
  assert.equal(proposal.walls.length,2);assert.equal(proposal.skipped,1);
  assert.equal(readingLosses(proposal),'1 curved path could not be read as walls. Compare the plan with the drawing and add what is missing.');
  assert.equal(readingLosses({skipped:2,ignored:3}),'2 curved paths could not be read as walls; 3 marks could not be read as a wall or opening. Compare the plan with the drawing and add what is missing.');
  assert.equal(readingLosses(drawingPlan().proposal),'','the clean fixture reads completely');
  const editor=readFileSync(new URL('../frontend/plan-editor.jsx',import.meta.url),'utf8');
  assert.match(editor,/const losses = readingLosses\(proposal\);\s+say\(losses \? 'warning' : 'info'/,'the upload notice carries the losses and stays up');
});

test('primitive extraction reads line paths, applies transforms and skips curves',()=>{
  const prims=extractPrimitives(sanitizeSvg(svgText,deps).svg,deps);
  assert.equal(prims.segments.length,17);
  assert.equal(prims.background,'#f9f8f3');
  assert.deepEqual(prims.labels.map(l=>l.text).filter(t=>!/\d/.test(t)),['Living / dining','Kitchen','Bedroom A','Bedroom B','Bathroom']);
  const other=extractPrimitives(sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
    <path d="M0,0 C1,1 2,2 3,3" stroke="#000"/><g transform="translate(5,1) scale(2)"><line x1="0" y1="0" x2="1" y2="0" stroke="#000"/></g>
    <polyline points="0,5 4,5 4,9" stroke="#000"/><path d="m1,1 h2 v2 z" stroke="#000"/></svg>`,deps).svg,deps);
  assert.equal(other.skipped,1);
  const keys=other.segments.map(s=>[...s.a,...s.b].join(','));
  assert.ok(keys.includes('5,1,7,1'),keys.join(' | '));
  assert.ok(keys.includes('0,5,4,5')&&keys.includes('4,5,4,9'));
  assert.ok(keys.includes('1,1,3,1')&&keys.includes('3,1,3,3')&&keys.includes('3,3,1,1'));
});

test('proposals: the heaviest stroke group becomes candidate walls, collinear marks become openings',()=>{
  const {proposal}=drawingPlan();
  assert.equal(proposal.walls.length,8);
  assert.equal(proposal.openings.filter(o=>o.kind==='door').length,5);
  assert.equal(proposal.openings.filter(o=>o.kind==='window').length,4);
});

test('calibration: two points and a typed distance give metres per pixel; bad input is refused',()=>{
  const cal=fixtureCalibration();
  near(cal.metresPerPixel,10/560,'metres per pixel');
  assert.deepEqual(cal.pointA,[60,500]);assert.deepEqual(cal.pointB,[620,500]);assert.equal(cal.distanceMetres,10);
  nearPt(toMetres([620,52],cal),[10,8],'north-east corner');
  nearPt(toPixels([10,8],cal),[620,52],'round trip');
  assert.throws(()=>calibrate([1,1],[1,1],5),/two different points/);
  assert.throws(()=>calibrate([0,0],[10,0],0),/known distance/);
  assert.throws(()=>calibrate([0,0],[10,0],Number.NaN),/known distance/);
  assert.throws(()=>planFromDrawing({proposal:{walls:[],openings:[],labels:[]},calibration:null,source:{kind:'svg',ref:'x'}}),/Calibrate/);
});

test('SVG path: a calibrated drawing reproduces the source walls, openings and rooms within 1 mm',()=>{
  const {plan}=drawingPlan();
  assert.equal(plan.walls.length,fixture.walls.length);
  for(const src of fixture.walls)assert.ok(plan.walls.some(w=>sameSegment(w,src)),`wall ${src.id} missing`);
  for(const w of plan.walls){near(w.thickness,0.18,'thickness');near(w.height,2.8,'height');}
  assert.equal(plan.openings.length,fixture.openings.length);
  for(const src of fixture.openings){
    const srcWall=fixture.walls.find(w=>w.id===src.wall);
    const match=plan.openings.find(o=>{
      const w=plan.walls.find(x=>x.id===o.wallId);
      if(!sameSegment(w,srcWall)||o.kind!==src.kind)return false;
      const offset=dist(w.start,srcWall.start)>MM?wallLength(w)-o.offset-o.width:o.offset;
      return Math.abs(offset-src.offset)<=MM&&Math.abs(o.width-src.width)<=MM;
    });
    assert.ok(match,`opening ${src.id} missing`);
  }
  assert.deepEqual(plan.rooms.map(r=>r.name).sort(),fixture.rooms.map(r=>r.name).sort());
  for(const src of fixture.rooms){
    const room=plan.rooms.find(r=>r.name===src.name);
    bounds(room.polygon).forEach((v,i)=>near(v,src.bounds[i],`${src.name} bound ${i}`));
  }
  assert.deepEqual(plan.sources,[{kind:'svg',ref:'sample-floorplan.svg',calibration:{pointA:[60,500],pointB:[620,500],distanceMetres:10}}]);
  assert.deepEqual(validatePlan(plan).filter(i=>i.severity==='error'),[]);
});

test('JSON path: the fixture loads deterministically and exports the source numerically within 1 mm',()=>{
  const plan=planFromFixture(fixture,{ref:'sample-floorplan.json'});
  const doc=exportPlan(plan);
  assert.equal(doc.schema,PLAN_SCHEMA);assert.equal(doc.units,'m');assert.equal(doc.name,fixture.name);
  assert.equal(doc.revision,null);assert.equal(doc.parentRevision,null);
  assert.deepEqual(doc.levels,[{id:'level-1',name:'Level 1',elevation:0,height:2.8}]);
  assert.deepEqual(doc.walls.map(w=>w.id),fixture.walls.map(w=>w.id));
  for(const src of fixture.walls){
    const w=doc.walls.find(x=>x.id===src.id);
    nearPt(w.start,src.start,src.id);nearPt(w.end,src.end,src.id);
    near(w.thickness,fixture.wall_thickness,'thickness');near(w.height,fixture.height,'height');
    assert.equal(w.levelId,'level-1');
  }
  assert.deepEqual(doc.openings.map(o=>o.id),fixture.openings.map(o=>o.id));
  for(const src of fixture.openings){
    const o=doc.openings.find(x=>x.id===src.id);
    assert.equal(o.wallId,src.wall);assert.equal(o.kind,src.kind);
    for(const k of ['offset','width','height','sill'])near(o[k],src[k],`${src.id}.${k}`);
  }
  assert.deepEqual(doc.rooms.map(r=>[r.id,r.name]),fixture.rooms.map(r=>[r.id,r.name]));
  for(const src of fixture.rooms)bounds(doc.rooms.find(r=>r.id===src.id).polygon).forEach((v,i)=>near(v,src.bounds[i],`${src.id} bound ${i}`));
  // Room associations come from the shared geometry: the kitchen wall separates living and kitchen.
  assert.deepEqual(doc.walls.find(w=>w.id==='kitchen').roomIds.toSorted(),['kitchen','living']);
  assert.deepEqual(doc.walls.find(w=>w.id==='south').roomIds.toSorted(),['kitchen','living']);
  assert.deepEqual(doc.walls.find(w=>w.id==='rooms').roomIds.toSorted(),['bathroom','bedroom-a','bedroom-b','kitchen','living']);
  assert.deepEqual(doc.sources,[{kind:'json',ref:'sample-floorplan.json',calibration:null}]);
  assert.deepEqual(validatePlan(doc),[]);
  assert.deepEqual(exportPlan(planFromFixture(fixture,{ref:'sample-floorplan.json'})),doc);
});

test('JSON path: feet input converts to metres numerically',()=>{
  const ft=0.3048;
  const scale=(p)=>p.map(v=>v/ft);
  const feet={...fixture,units:'feet',height:fixture.height/ft,wall_thickness:fixture.wall_thickness/ft,
    walls:fixture.walls.map(w=>({...w,start:scale(w.start),end:scale(w.end)})),
    openings:fixture.openings.map(o=>({...o,offset:o.offset/ft,width:o.width/ft,height:o.height/ft,sill:o.sill/ft})),
    rooms:fixture.rooms.map(r=>({...r,bounds:scale(r.bounds)}))};
  const metres=exportPlan(planFromFixture(fixture,{ref:'a'})),converted=exportPlan(planFromFixture(feet,{ref:'a'}));
  converted.walls.forEach((w,i)=>{nearPt(w.start,metres.walls[i].start,w.id);nearPt(w.end,metres.walls[i].end,w.id);near(w.height,2.8,'h');near(w.thickness,0.18,'t');});
  converted.openings.forEach((o,i)=>{for(const k of ['offset','width','height','sill'])near(o[k],metres.openings[i][k],`${o.id}.${k}`);});
  assert.throws(()=>planFromFixture({...fixture,units:'cubits'},{ref:'a'}),/units/);
});

test('room detection finds closed wall loops and keeps ids and names stable',()=>{
  const plan=planFromFixture(fixture,{ref:'a'});
  const detected=detectRooms({...plan,rooms:[]},{labels:[]});
  assert.equal(detected.length,5);
  assert.deepEqual(detected.map(r=>r.name).sort(),['Room 1','Room 2','Room 3','Room 4','Room 5']);
  for(const r of detected)assert.equal(r.polygon.length,4,`${r.name} has collinear points removed`);
  const again=detectRooms(plan,{labels:[]});
  assert.deepEqual(again.map(r=>[r.id,r.name]).sort(),plan.rooms.map(r=>[r.id,r.name]).sort());
  // Removing the bathroom divider merges bedroom B and the bathroom into one room.
  const merged=detectRooms(deleteWall(plan,'bathroom'),{labels:[]});
  assert.equal(merged.length,4);
  assert.ok(merged.find(r=>bounds(r.polygon).join()===[4,4,10,8].join()),'merged room');
  // A stray wall inside a room does not create a room or a spike in the boundary.
  const stray=detectRooms(addWall(plan,{start:[1,1],end:[2,1]}),{labels:[]});
  assert.equal(stray.length,5);assert.equal(stray.find(r=>r.id==='living').polygon.length,4);
});

test('validation: closure, shared walls and opening rules report inline errors',()=>{
  const plan=planFromFixture(fixture,{ref:'a'});
  const codes=(p)=>validatePlan(p).map(i=>`${i.code}:${i.ref.id}`);
  assert.deepEqual(codes(plan),[]);
  assert.ok(codes(deleteWall(plan,'kitchen')).includes('room-open-boundary:living'));
  const dup={...plan,walls:[...plan.walls,{...plan.walls[0],id:'south-copy',start:[2,0],end:[6,0],roomIds:[]}]};
  assert.ok(codes(dup).includes('wall-duplicate:south-copy'));
  const set=(id,patch)=>({...plan,openings:plan.openings.map(o=>o.id===id?{...o,...patch}:o)});
  assert.ok(codes(set('entry',{offset:9.5})).includes('opening-outside-wall:entry'));
  assert.ok(codes(set('entry',{offset:-0.1})).includes('opening-outside-wall:entry'));
  assert.ok(codes(set('entry',{offset:1.0})).includes('opening-overlap:entry'));
  assert.ok(codes(set('living-window',{sill:2})).includes('opening-too-tall:living-window'));
  assert.ok(codes(set('entry',{width:0})).includes('opening-size:entry'));
  assert.ok(codes(set('entry',{wallId:'ghost'})).includes('opening-wall-missing:entry'));
  assert.ok(codes({...plan,rooms:[...plan.rooms,{...plan.rooms[0]}]}).includes('duplicate-id:living'));
  const stub=addWall(plan,{start:[2,2],end:[3,2]});
  const issue=validatePlan(stub).find(i=>i.code==='wall-open-end');
  assert.equal(issue.severity,'warning');assert.equal(issue.ref.kind,'wall');
  for(const i of validatePlan(set('entry',{offset:9.5})))assert.ok(i.message.length>0&&!i.message.includes('—'));
});

test('edits: draw, move, split and delete walls; place openings; ids survive edits',()=>{
  const plan=planFromFixture(fixture,{ref:'a'});
  const drawn=addWall(plan,{start:[1,1],end:[2,1]});
  const added=drawn.walls.at(-1);
  assert.equal(added.id,'wall-1');assert.equal(added.thickness,DEFAULTS.thickness);assert.equal(added.height,DEFAULTS.height);
  assert.equal(addWall(drawn,{start:[1,2],end:[2,2]}).walls.at(-1).id,'wall-2');
  const moved=moveWall(plan,'east',{start:[11,0],end:[11,8]});
  assert.deepEqual(moved.walls.find(w=>w.id==='east').end,[11,8]);
  assert.equal(moved.openings.find(o=>o.id==='kitchen-window').wallId,'east');
  const split=splitWall(plan,'south',[4,0]);
  const west=split.walls.find(w=>w.id==='south'),east=split.walls.find(w=>w.id==='wall-1');
  assert.deepEqual(west.end,[4,0]);assert.deepEqual(east.start,[4,0]);assert.deepEqual(east.end,[10,0]);
  const entry=split.openings.find(o=>o.id==='entry');
  assert.equal(entry.wallId,'wall-1');near(entry.offset,0.55,'entry offset after split');
  assert.equal(split.openings.find(o=>o.id==='living-window').wallId,'south');
  assert.throws(()=>splitWall(plan,'south',[4.9,0]),/opening/);
  const gone=deleteWall(plan,'north');
  assert.ok(!gone.walls.some(w=>w.id==='north'));
  assert.ok(!gone.openings.some(o=>o.wallId==='north'));
  const placed=placeOpening(plan,{wallId:'west',kind:'window',at:[0,2]});
  const win=placed.openings.at(-1);
  assert.equal(win.id,'opening-1');assert.equal(win.wallId,'west');
  near(win.offset,8-2-DEFAULTS.window.width/2,'window offset');near(win.sill,DEFAULTS.window.sill,'sill');
  const door=placeOpening(plan,{wallId:'west',kind:'door',at:[0,2]}).openings.at(-1);
  assert.equal(door.swing,null);near(door.width,DEFAULTS.door.width,'door width');
});

test('recalibration reprojects traced geometry through the drawing',()=>{
  const {plan}=drawingPlan();
  const halfScale=calibrate([60,500],[620,500],5);
  const re=reprojectPlan(plan,fixtureCalibration(),halfScale);
  assert.ok(re.walls.some(w=>Math.abs(w.start[1])<MM&&Math.abs(w.end[1])<MM&&Math.abs(wallLength(w)-5)<MM),'south wall halves');
  for(const o of re.openings)assert.ok(o.offset+o.width<=wallLength(re.walls.find(w=>w.id===o.wallId))+MM);
  near(re.walls[0].height,2.8,'heights are not scaled');
  assert.equal(re.sources[0].calibration.distanceMetres,5);
  assert.deepEqual(re.walls.map(w=>w.id),plan.walls.map(w=>w.id));
});

test('recalibrating one level\'s drawing moves only that level',()=>{
  const {plan}=drawingPlan();
  const upper={...plan,levels:[...plan.levels,{...plan.levels[0],id:'level-2',name:'Level 2',elevation:3}],
    walls:[...plan.walls,...plan.walls.map(w=>({...w,id:`${w.id}:upper`,levelId:'level-2'}))],
    openings:[...plan.openings,...plan.openings.map(o=>({...o,id:`${o.id}:upper`,wallId:`${o.wallId}:upper`}))],
    rooms:[...plan.rooms,...plan.rooms.map(r=>({...r,id:`${r.id}:upper`,levelId:'level-2'}))]};
  const re=reprojectPlan(upper,fixtureCalibration(),calibrate([60,500],[620,500],5),upper.sources[0],'level-1');
  const on=(p,level)=>p.walls.filter(w=>w.levelId===level);
  assert.deepEqual(on(re,'level-2'),on(upper,'level-2'),'the other level keeps its walls');
  assert.deepEqual(re.rooms.filter(r=>r.levelId==='level-2'),upper.rooms.filter(r=>r.levelId==='level-2'));
  assert.deepEqual(re.openings.filter(o=>o.id.endsWith(':upper')),upper.openings.filter(o=>o.id.endsWith(':upper')));
  assert.ok(on(re,'level-1').some(w=>Math.abs(wallLength(w)-5)<MM),'the recalibrated level halves');
  // Recalibrating the second floor's drawing leaves the first floor where it was.
  const second=reprojectPlan(upper,fixtureCalibration(),calibrate([60,500],[620,500],5),upper.sources[0],'level-2');
  assert.deepEqual(on(second,'level-1'),on(upper,'level-1'));
  assert.ok(on(second,'level-2').some(w=>Math.abs(wallLength(w)-5)<MM));
  // The editor recalibrates the level it is showing, the one the underlay is traced on.
  const editor=readFileSync(new URL('../frontend/plan-editor.jsx',import.meta.url),'utf8');
  assert.match(editor,/reprojectPlan\(plan, calibration, next, underlay, level\.id\)/);
});

test('save: PUT with the parent revision, surface 409 conflicts, keep a local draft',async()=>{
  const plan=planFromFixture(fixture,{ref:'a'});
  const calls=[];
  const created=async(url,init)=>{calls.push([url,init]);const body=JSON.parse(init.body);return new Response(JSON.stringify({revision:1,parentRevision:null,planId:'p-1',plan:{...body.plan,id:'p-1',revision:1}}),{status:201});};
  const saved=await savePlan({fetch:created,projectId:'proj_1',plan});
  assert.equal(calls[0][0],'/api/projects/proj_1/architecture/plan');
  assert.equal(calls[0][1].method,'PUT');
  const sent=JSON.parse(calls[0][1].body);
  assert.equal(sent.parentRevision,null);assert.equal(sent.plan.schema,PLAN_SCHEMA);assert.equal(sent.plan.parentRevision,null);
  assert.equal(saved.status,'saved');assert.equal(saved.plan.revision,1);assert.equal(saved.plan.id,'p-1');
  const second=async(_u,init)=>{const body=JSON.parse(init.body);assert.equal(body.parentRevision,1);assert.equal(body.plan.parentRevision,1);return new Response(JSON.stringify({revision:2,parentRevision:1,planId:'p-1',plan:{...body.plan,revision:2}}),{status:201});};
  assert.equal((await savePlan({fetch:second,projectId:'proj_1',plan:saved.plan})).plan.revision,2);
  const conflict=async()=>new Response(JSON.stringify({error:'Revision 3 is newer.',revision:3}),{status:409});
  assert.deepEqual(await savePlan({fetch:conflict,projectId:'proj_1',plan:saved.plan}),{status:'conflict',revision:3,message:'Revision 3 is newer.'});
  const rejected=async()=>new Response(JSON.stringify({error:'openings[0].wallId is unknown.'}),{status:400});
  await assert.rejects(savePlan({fetch:rejected,projectId:'proj_1',plan}),/openings\[0\]\.wallId/);
  const current=async(url)=>{assert.equal(url,'/api/projects/proj_1/architecture');return new Response(JSON.stringify({current:{revision:3,plan:{...exportPlan(plan),id:'p-1',revision:3}},revisions:[]}),{status:200});};
  assert.equal((await loadPlan({fetch:current,projectId:'proj_1'})).revision,3);
  const none=async()=>new Response(JSON.stringify({current:null,revisions:[]}),{status:200});
  assert.equal(await loadPlan({fetch:none,projectId:'proj_1'}),null);
  const store=new Map();const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  assert.equal(draftKey('proj_1'),'arosa-plan-draft-proj_1');
  writeDraft(storage,'proj_1',plan);
  assert.deepEqual(readDraft(storage,'proj_1'),plan);
  assert.equal(readDraft(storage,'proj_2'),null);
});

test('joints: moving a corner drags every wall that meets there; translating a wall keeps its neighbours attached',async()=>{
  const {moveJoint,translateWall,snapPoint}=await import('../public/plan-intake.js');
  const plan=planFromFixture(fixture,{ref:'a'});
  const moved=moveJoint(plan,[10,0],[10.5,0],plan.levels[0].id);
  assert.deepEqual(moved.walls.find(w=>w.id==='south').end,[10.5,0]);
  assert.deepEqual(moved.walls.find(w=>w.id==='east').start,[10.5,0]);
  const shifted=translateWall(plan,'kitchen',[0.5,0]);
  assert.deepEqual(shifted.walls.find(w=>w.id==='kitchen').start,[7.5,0]);
  // The kitchen wall's ends sit on the middle of the south and rooms walls, which stay put.
  assert.deepEqual(shifted.walls.find(w=>w.id==='south').end,[10,0]);
  const east=translateWall(plan,'east',[1,0]);
  assert.deepEqual(east.walls.find(w=>w.id==='south').end,[11,0]);assert.deepEqual(east.walls.find(w=>w.id==='north').start,[11,8]);
  assert.deepEqual(validatePlan(east).filter(i=>i.severity==='error').map(i=>i.code),['room-open-boundary','room-open-boundary']);
  assert.deepEqual(validatePlan({...east,rooms:detectRooms(east,{labels:[]})}).filter(i=>i.severity==='error'),[]);
  assert.deepEqual(snapPoint(plan,[9.95,0.04],0.1),{point:[10,0],kind:'joint'});
  assert.deepEqual(snapPoint(plan,[5,0.04],0.1),{point:[5,0],kind:'wall'});
  assert.deepEqual(snapPoint(plan,[5.123456,2.2],0.1),{point:[5.12,2.2],kind:'grid'});
});

test('entry gate: the floor plan item shows on a site and its plan page when the session enables architecture',async()=>{
  const {planEntryState}=await import('../public/plan-editor-loader.js');
  assert.deepEqual(planEntryState({architectureEnabled:true},'/sites/proj_1234'),{visible:false,projectId:null});
  assert.deepEqual(planEntryState({architectureEnabled:true},'/core/proj_1234'),{visible:false,projectId:null});
  assert.deepEqual(planEntryState({architectureEnabled:true},'/sites/proj_1234/plan'),{visible:true,projectId:'proj_1234'});
  assert.deepEqual(planEntryState({architectureEnabled:true},'/core/proj_1234/plan'),{visible:true,projectId:'proj_1234'});
  assert.deepEqual(planEntryState({architectureEnabled:true},'/core'),{visible:false,projectId:null});
  assert.deepEqual(planEntryState({namespace:'a'},'/core/proj_1234'),{visible:false,projectId:null});
  assert.deepEqual(planEntryState({architectureEnabled:'yes'},'/core/proj_1234'),{visible:false,projectId:null});
  assert.deepEqual(planEntryState(null,'/core/proj_1234'),{visible:false,projectId:null});
});

test("a collinear wall beyond a room edge does not open the room", () => {
  const wall = (id, start, end) => ({ id, levelId: "level-1", start, end, thickness: 0.18, height: 2.8, material: "generic", roomIds: [] });
  const plan = {
    schema: PLAN_SCHEMA, id: null, revision: null, parentRevision: null, name: "Gap", units: "m",
    levels: [{ id: "level-1", name: "Level 1", elevation: 0, height: 2.8 }],
    walls: [wall("s", [0, 0], [3, 0]), wall("e", [3, 0], [3, 2]), wall("n", [0, 2], [3, 2]), wall("w", [0, 0], [0, 2]), wall("e-beyond", [3, 3], [3, 5])],
    openings: [], objects: [], sources: [],
    rooms: [{ id: "r", levelId: "level-1", name: "Room", polygon: [[0, 0], [3, 0], [3, 2], [0, 2]], netAreaMethod: "centerline" }],
  };
  assert.deepEqual(validatePlan(plan).filter((i) => i.code === "room-open-boundary"), []);
});

test('room labels show only what fits the room at the zoom, so a floor of 60 rooms reads without overlaps', () => {
  const room = (name, w, h, kind) => ({name, kind, polygon: [[0, 0], [w, 0], [w, h], [0, h]]});
  const living = room('Unit 12 living and kitchen', 4.5, 6, 'living');
  assert.deepEqual(roomLabel(living, 60), {name: 'Unit 12 living and kitchen', area: true}, 'zoomed in, name and area');
  assert.deepEqual(roomLabel(living, 14), {name: 'Unit 12', area: false}, 'at the zoom that fits a whole floor, the unit number on its living room');
  assert.equal(roomLabel(room('Unit 12 bath', 1.7, 2.6, 'bath'), 14), null, 'other rooms of the unit stay unlabelled');
  assert.equal(roomLabel(room('Unit 12 living and kitchen', 4.5, 6, 'living'), 4), null, 'too small even for the number');
  assert.deepEqual(roomLabel(room('Living / dining', 7, 4), 40), {name: 'Living / dining', area: true}, 'an apartment plan reads as before');
});
