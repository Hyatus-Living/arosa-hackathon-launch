import test from 'node:test';
import assert from 'node:assert/strict';
import {baseboardSegments,interiorLayout,roomUse} from '../frontend/interior-layout.mjs';
import {pointInPolygon} from '../frontend/architecture-model.mjs';

const plan=()=>({
  levels:[{id:'ground',elevation:0,height:2.8},{id:'upper',elevation:3,height:2.8}],
  rooms:[
    {id:'studio',name:'Living / sleeping',levelId:'upper',polygon:[[0,0],[5,0],[5,4],[0,4]]},
    {id:'kitchen',name:'Kitchen',levelId:'ground',polygon:[[6,0],[10,0],[10,4],[6,4]]},
    {id:'stairs',name:'Stair enclosure',levelId:'ground',polygon:[[11,0],[13,0],[13,4],[11,4]]},
  ],
  walls:[{id:'upper-south',levelId:'upper',start:[0,0],end:[5,0]}],
  openings:[{id:'door',wallId:'upper-south',kind:'door',offset:2,width:1}],objects:[],
});

test('room labels guide furnishing inside rooms while respecting doors and leaving the source unchanged',()=>{
  const source=plan(),before=structuredClone(source),rooms=interiorLayout(source);
  const studio=rooms.find(r=>r.roomId==='studio');
  assert.deepEqual(studio.items.map(i=>i.type),['bed','sofa','nightstand']);
  const bed=studio.items.find(item=>item.type==='bed'),nightstand=studio.items.find(item=>item.type==='nightstand');
  assert.ok(Math.hypot(...nightstand.center.map((value,i)=>value-bed.center[i]))<1.5,'nightstand must be beside the bed');
  for(const item of studio.items){
    for(const u of [-item.width/2,item.width/2])for(const v of [-item.depth/2,item.depth/2]){
      const p=[item.center[0]+u*item.axis[0]+v*item.inward[0],item.center[1]+u*item.axis[1]+v*item.inward[1]];
      assert.ok(pointInPolygon(p,studio.polygon));
      assert.ok(p[1]>.525||p[0]<2||p[0]>3,'furniture must not occupy the door clearance');
    }
  }
  assert.equal(rooms.find(r=>r.roomId==='kitchen').items[0].type,'kitchen');
  assert.ok(!rooms.some(r=>r.roomId==='stairs'));
  assert.deepEqual(source,before);
});

test('existing furnishings are preserved without suppressing room finishes',()=>{
  const source=plan(),rooms=interiorLayout(source,new Set(['studio']));
  assert.equal(rooms.find(r=>r.roomId==='studio').items.length,0);
  assert.equal(rooms.find(r=>r.roomId==='kitchen').items.length,1);
  source.objects.push({id:'authored-object'});
  assert.ok(interiorLayout(source).every(r=>r.items.length===0));
  assert.equal(roomUse({name:'Elevator / stair lobby'}),null);
  assert.equal(roomUse({name:'Common corridor'}),'hall');
});

test('baseboards follow the plan and leave door openings clear',()=>{
  const source=plan();
  source.openings.push({id:'second-door',wallId:'upper-south',kind:'door',offset:2.75,width:1});
  assert.deepEqual(baseboardSegments(source).map(({start,end})=>[start,end]),[[0,2],[3.75,5]]);
});

test('the coffee table sits in front of the sofa in a living room',()=>{
  const living={
    levels:[{id:'ground',elevation:0,height:2.8}],
    rooms:[{id:'living',name:'Living room',levelId:'ground',polygon:[[0,0],[6,0],[6,5],[0,5]]}],
    walls:[],openings:[],objects:[],
  };
  const room=interiorLayout(living)[0];
  const sofa=room.items.find(i=>i.type==='sofa'),coffee=room.items.find(i=>i.type==='coffee');
  assert.ok(sofa&&coffee,'both sofa and coffee table are placed');
  const along=(coffee.center[0]-sofa.center[0])*sofa.inward[0]+(coffee.center[1]-sofa.center[1])*sofa.inward[1];
  const side=(coffee.center[0]-sofa.center[0])*sofa.axis[0]+(coffee.center[1]-sofa.center[1])*sofa.axis[1];
  assert.ok(Math.abs(along-(sofa.depth/2+coffee.depth/2+.3))<1e-9,`coffee table is in front of the sofa (offset ${along})`);
  assert.ok(Math.abs(side)<1e-9,'coffee table is centred on the sofa');
  assert.ok(pointInPolygon(coffee.center,room.polygon));
});
