import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from './store.mjs';
import {Architecture} from './architecture-artifacts.mjs';
import {Drawings} from './architecture-drawings.mjs';
import {createArchitectureTools} from './architecture-tools.mjs';
import {buildArchitectureRevision,planningCommand} from './planning.mjs';

const owner='a'.repeat(24),sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('saved Pascal revisions retain the exact upload through duplicate filenames, plan renames and reopen',{
  skip:existsSync(planningCommand().python)?false:'planning/.venv is not installed',timeout:60000,
},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'acres-pascal-source-')),database=join(dir,'chat.sqlite');
  let store=new ChatStore(database);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const options={stateDir:join(dir,'state'),buildPlan:buildArchitectureRevision};
  let architecture=new Architecture(store,options),drawings=new Drawings(store,options);
  const projectId=store.createConversation(owner).projectId;
  const toolsFor=id=>createArchitectureTools({plans:{projectId:id,
    summary:()=>architecture.summary(owner,id,row=>row),
    drawings:()=>drawings.list(owner,id),
    drawing:drawingId=>drawings.open(owner,id,drawingId),
    save:args=>architecture.save(owner,id,{...args,by:'agent'},row=>row),
  }});
  const tools=toolsFor(projectId);
  const scene=JSON.parse(readFileSync(new URL('./testing/pascal-courtyard-scene.json',import.meta.url),'utf8'));
  const firstBytes=Buffer.from(JSON.stringify(scene));
  Object.values(scene.nodes).find(node=>node.type==='zone'&&!node.metadata.floorVoid).name='Reviewed living room';
  const secondBytes=Buffer.from(JSON.stringify(scene));
  const first=drawings.add(owner,projectId,{bytes:firstBytes,name:'courtyard.pascal.json',by:'user'});
  const second=drawings.add(owner,projectId,{bytes:secondBytes,name:'courtyard.pascal.json',by:'user'});
  assert.equal(first.name,second.name);assert.notEqual(first.id,second.id);assert.notEqual(first.sha256,second.sha256);
  const source=drawing=>({kind:'pascal-scene',ref:drawing.name,drawingId:drawing.id,sha256:drawing.sha256});
  const saved=revision=>architecture.revision(owner,projectId,revision,row=>row);
  const firstResult=await tools.handlers.acres_import_pascal_scene({drawingId:first.id,parentRevision:0,name:'Initial courtyard review'});
  assert.equal(firstResult.saved,true,JSON.stringify(firstResult));assert.equal(firstResult.revision,1);
  assert.deepEqual(saved(1).plan.sources,[source(first)]);
  const secondResult=await tools.handlers.acres_import_pascal_scene({drawingId:second.id,parentRevision:1,name:'Renamed courtyard review'});
  assert.equal(secondResult.saved,true,JSON.stringify(secondResult));assert.equal(secondResult.revision,2);
  const document=tools.handlers.acres_read_plan({}).document;
  assert.deepEqual(document.sources,[{...source(second),calibration:undefined}]);
  assert.ok(document.rooms.some(room=>room.name==='Reviewed living room'));
  const edited=await tools.handlers.acres_save_plan({parentRevision:2,plan:{...document,name:'Final courtyard review'}});
  assert.equal(edited.saved,true,JSON.stringify(edited));assert.equal(edited.revision,3);
  const conflict=await tools.handlers.acres_import_pascal_scene({drawingId:first.id,parentRevision:2});
  assert.equal(conflict.saved,false);assert.equal(conflict.conflict,true);assert.equal(conflict.currentRevision,3);
  const otherProject=store.createConversation(owner).projectId;
  await assert.rejects(toolsFor(otherProject).handlers.acres_import_pascal_scene({drawingId:first.id,parentRevision:0}),/not attached to this project/);
  store.close();store=new ChatStore(database);
  architecture=new Architecture(store,options);drawings=new Drawings(store,options);
  const report=[];
  for(const [revision,drawing,bytes] of [[1,first,firstBytes],[2,second,secondBytes],[3,second,secondBytes]]){
    const current=saved(revision),expected=source(drawing);
    assert.deepEqual(current.plan.sources,[expected]);
    assert.equal(sha(drawings.open(owner,projectId,expected.drawingId).read()),sha(bytes));
    assert.equal(expected.sha256,sha(bytes));
    const artifact=kind=>architecture.artifactRow(projectId,current.artifacts.find(row=>row.kind===kind).id).path;
    const persisted=readFileSync(artifact('plan'));
    assert.deepEqual(JSON.parse(persisted).sources,[expected]);
    assert.match(readFileSync(artifact('ifc'),'utf8'),/^ISO-10303-21;/);
    report.push({revision,name:current.plan.name,source:expected,planSha256:sha(persisted),ifcSha256:sha(readFileSync(artifact('ifc')))});
  }
  assert.equal(architecture.summary(owner,projectId,row=>row).current.revision,3);
  assert.equal(saved(1).plan.name,'Initial courtyard review');
  assert.equal(saved(3).plan.name,'Final courtyard review');
  console.log('PASCAL_SOURCE '+JSON.stringify(report));
});
