import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as intake from '../public/plan-intake.js';
import {followUpMessage} from '../public/core-model.js';
import {ChatStore} from '../../acres-research/store.mjs';
import {createResearchServer} from '../../acres-research/service.mjs';
import {Architecture} from '../../acres-research/architecture-artifacts.mjs';
import {Drawings} from '../../acres-research/architecture-drawings.mjs';
import {createArchitectureTools} from '../../acres-research/architecture-tools.mjs';

const source=readFileSync(new URL('../frontend/plan-editor.jsx',import.meta.url),'utf8');
const slice=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a);assert.ok(a>=0&&b>a,from);return source.slice(a,b);};
const editorCode=slice('  async function onDrawing(','  async function refreshDrawings(')+slice('  async function attachDrawing(','  async function openDrawing(');
const alice='a'.repeat(24);
const buildPlan=async(doc,{outDir})=>{
  const ifc=`ISO-10303-21;\n/* r${doc.revision} */\nEND-ISO-10303-21;\n`;
  writeFileSync(join(outDir,'model.ifc'),ifc);
  return {hasIfc:true,ifcSha256:createHash('sha256').update(ifc).digest('hex')};
};
const node=(id,type,extra={})=>({object:'node',id,type,name:id,parentId:null,visible:true,...extra});
// One room with a door, as Pascal exports it (the same scene the import tool test uses).
const scene={nodes:{
  site_1:node('site_1','site',{metadata:{acresId:'site'},polygon:{type:'polygon',points:[[-2,2],[12,2],[12,-10],[-2,-10]]},children:['building_1']}),
  building_1:node('building_1','building',{name:'Unit 4B edited',parentId:'site_1',metadata:{acresId:'building'},children:['level_1'],position:[0,0,0],rotation:[0,0,0]}),
  level_1:node('level_1','level',{name:'Level 1',parentId:'building_1',metadata:{acresId:'level-1'},level:0,baseElevation:0,height:2.8,children:['wall_s','wall_n','wall_w','wall_e','zone_1']}),
  wall_s:node('wall_s','wall',{parentId:'level_1',metadata:{acresId:'wall-south'},start:[0,0],end:[10,0],thickness:0.18,height:2.8,children:['door_1']}),
  wall_n:node('wall_n','wall',{parentId:'level_1',metadata:{acresId:'wall-north'},start:[10,-8],end:[0,-8],thickness:0.18,height:2.8}),
  wall_w:node('wall_w','wall',{parentId:'level_1',start:[0,-8],end:[0,0],thickness:0.18,height:2.8}),
  wall_e:node('wall_e','wall',{parentId:'level_1',start:[10,0],end:[10,-8],thickness:0.18,height:2.8}),
  door_1:node('door_1','door',{name:'opening-entry',parentId:'wall_s',wallId:'wall_s',metadata:{acresId:'opening-entry'},doorType:'hinged',position:[6,1.05,0],rotation:[0,0,0],width:0.9,height:2.1}),
  zone_1:node('zone_1','zone',{name:'Living',parentId:'level_1',metadata:{acresId:'room-living'},polygon:[[0.09,-0.09],[9.91,-0.09],[9.91,-7.91],[0.09,-7.91]],spaceRole:'room',enclosureStatus:'enclosed',boundaryWallIds:['wall_s','wall_n','wall_w','wall_e'],ceilingHeight:2.8}),
},rootNodeIds:['site_1']};
const fileOf=(name,text)=>({name,type:'application/json',size:Buffer.byteLength(text),text:async()=>text,stream:()=>new Blob([text]).stream(),
  arrayBuffer:async()=>new TextEncoder().encode(text).buffer});

function editor(fetch,projectId){
  const attached=Promise.withResolvers();
  const c={...intake,plan:null,projectId,fetch,drawingGeneration:{current:0},pdfPageGeneration:{current:0},scene:null,underlay:null,drawings:[],notices:[],actions:[],
    beginDrawing:()=>++c.drawingGeneration.current,
    setScene:value=>{c.scene=typeof value==='function'?value(c.scene):value;},
    setUnderlay:value=>{c.underlay=typeof value==='function'?value(c.underlay):value;},
    setDrawings:value=>{c.drawings=typeof value==='function'?value(c.drawings):value;},
    history:{linkDrawing(){}},attached:attached.promise,onAction:action=>{c.actions.push(action);attached.resolve(action);},say:(tone,text)=>c.notices.push({tone,text}),
  };
  vm.createContext(c);vm.runInContext(editorCode,c);
  return c;
}

test('an edited .pascal.json uploads from the editor as a Pascal scene drawing that Arosa then imports',{timeout:10000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-pascal-upload-')),store=new ChatStore(join(dir,'chat.sqlite'));
  const options={stateDir:join(dir,'state'),buildPlan,worker:null,pipelineVersion:'test'};
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({answer:'x',sources:[]}),architecture:options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.architectureJobs?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  const projectId=store.createConversation(alice).projectId,sent=[];
  // The web app's proxy streams any non-JSON drawing body to the research service as it is.
  const fetch=async(url,init={})=>{
    sent.push(init.headers);
    assert.notEqual(init.headers['content-type'],'application/json','a JSON body would be read as an attach-by-URL request');
    return globalThis.fetch(`http://127.0.0.1:${server.address().port}${url.replace(/^\/api/,'')}`,{...init,...(init.body?{body:Buffer.from(await init.body.arrayBuffer())}:{}),
      headers:{...init.headers,authorization:'Bearer test','x-acres-account':alice}});
  };
  const c=editor(fetch,projectId);
  await c.onDrawing(fileOf('unit-4b.pascal.json',JSON.stringify(scene)));
  await c.attached;
  assert.equal(c.underlay,null,'a scene is never drawn as an underlay');
  assert.equal(c.notices[0].tone,'info');assert.match(c.notices[0].text,/edited 3D scene with 9 parts\. Import it with Arosa/);
  assert.equal(c.drawings[0].kind,'pascal-scene');assert.equal(c.scene.drawingId,c.drawings[0].id);
  const listed=await (await fetch(`/api/projects/${projectId}/architecture/drawings`,{headers:{}})).json();
  assert.deepEqual(listed.drawings.map(d=>[d.name,d.kind]),[['unit-4b.pascal.json','pascal-scene']]);
  assert.match(followUpMessage({field:'architecture',action:'import',drawing:c.scene.name}),/^Import the edited Pascal scene "unit-4b\.pascal\.json" from this site's drawings as the next revision of the architecture plan/);
  const architecture=new Architecture(store,options),drawings=new Drawings(store,options),view=row=>({jobId:row.job_id,status:row.status});
  const tools=createArchitectureTools({plans:{projectId,summary:()=>architecture.summary(alice,projectId,view),drawings:()=>drawings.list(alice,projectId),
    drawing:id=>drawings.open(alice,projectId,id),save:({parentRevision,plan})=>architecture.save(alice,projectId,{parentRevision,plan,by:'agent'},view)}});
  const imported=await tools.handlers.acres_import_pascal_scene({drawingId:c.scene.drawingId,parentRevision:0});
  assert.equal(imported.saved,true,JSON.stringify(imported));assert.equal(imported.revision,1);
});

test('a JSON file that is not a Pascal scene is refused before upload, and the limit is 10 MB',async()=>{
  const uploads=[],c=editor(async()=>{uploads.push(1);},'p1');
  await c.onDrawing(fileOf('plan.json',JSON.stringify({schema:intake.PLAN_SCHEMA,walls:[]})));
  assert.deepEqual(uploads,[]);assert.equal(c.notices[0].tone,'danger');assert.match(c.notices[0].text,/not a Pascal scene\. To open a plan saved as JSON, use Load plan JSON/);
  assert.deepEqual(intake.checkUpload({name:'scene.pascal.json',type:'',size:100}),{kind:'pascal-scene',contentType:'application/json'});
  assert.throws(()=>intake.checkUpload({name:'scene.pascal.json',type:'application/json',size:10*1024*1024+1}),/limit is 10 MB/);
});
