// A conservative, illustrative layout derived from the saved room outlines and openings.
// It does not change the plan or claim code compliance. Distances are in metres.
import {levelOf,pointInPolygon} from './architecture-model.mjs';

const TYPES={kitchen:[['kitchen',1.6,0.58]],bath:[['vanity',0.75,0.48],['toilet',0.42,0.70]],bedroom:[['bed',1.4,2.0],['nightstand',.48,.46]],living:[['sofa',1.8,0.85],['coffee',0.75,0.48]],studio:[['bed',1.35,1.95],['sofa',1.6,0.8],['nightstand',.48,.46]]};

export function roomUse(room) {
  const name=String(room.name||'').toLowerCase(),kind=String(room.kind||'').toLowerCase();
  if(/stair|elevator|shaft|closet|storage|mechanical/.test(name+' '+kind))return null;
  if(/corridor|hall|lobby/.test(name+' '+kind))return 'hall';
  if(/kitchen|kitchenette/.test(name+' '+kind))return 'kitchen';
  if(/bath|washroom|restroom|toilet/.test(name+' '+kind))return 'bath';
  if(/living.*sleep|sleep.*living|studio/.test(name))return 'studio';
  if(/bedroom|sleeping|bed/.test(name+' '+kind))return 'bedroom';
  if(/living|lounge|sitting/.test(name+' '+kind))return 'living';
  return null;
}

// Baseboards follow the existing walls and stop at every doorway.
export function baseboardSegments(plan) {
  return (plan.walls||[]).flatMap(wall=>{
    const length=Math.hypot(wall.end[0]-wall.start[0],wall.end[1]-wall.start[1]);
    if(!length)return [];
    const doors=(plan.openings||[]).filter(o=>o.wallId===wall.id&&o.kind==='door')
      .map(o=>[Math.max(0,o.offset),Math.min(length,o.offset+o.width)])
      .filter(([start,end])=>end>start).sort((a,b)=>a[0]-b[0]);
    const spans=[];let start=0;
    for(const [a,b] of doors){if(a>start)spans.push([start,a]);start=Math.max(start,b);}
    if(start<length)spans.push([start,length]);
    return spans.filter(([a,b])=>b-a>.05).map(([a,b])=>({wall,start:a,end:b}));
  });
}
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1];
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const corners=(p,pad=0)=>{
  const w=p.width/2+pad,d=p.depth/2+pad;
  return [[-w,-d],[-w,d],[w,d],[w,-d]].map(([u,v])=>[p.center[0]+p.axis[0]*u+p.inward[0]*v,p.center[1]+p.axis[1]*u+p.inward[1]*v]);
};
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function crossesBoundary(vertices,polygon) {
  return vertices.some((a,i)=>polygon.some((c,j)=>{
    const b=vertices[(i+1)%vertices.length],d=polygon[(j+1)%polygon.length];
    return cross(a,b,c)*cross(a,b,d)<-1e-10&&cross(c,d,a)*cross(c,d,b)<-1e-10;
  }));
}
function intersects(a,b) {
  const d=sub(b.center,a.center);
  return [a.axis,a.inward,b.axis,b.inward].every(axis=>Math.abs(dot(d,axis)) < (Math.abs(dot(a.axis,axis))*a.width+Math.abs(dot(a.inward,axis))*a.depth+Math.abs(dot(b.axis,axis))*b.width+Math.abs(dot(b.inward,axis))*b.depth)/2+0.08);
}
function openingsFor(plan,levelId) {
  return (plan.openings||[]).map(opening=>{
    const wall=plan.walls.find(w=>w.id===opening.wallId);if(!wall)return null;
    if((opening.levelId||levelOf(plan,wall))!==levelId)return null;
    const dx=wall.end[0]-wall.start[0],dy=wall.end[1]-wall.start[1],len=Math.hypot(dx,dy);if(!len)return null;
    const axis=[dx/len,dy/len],along=opening.offset+opening.width/2;
    return {kind:opening.kind,center:[wall.start[0]+axis[0]*along,wall.start[1]+axis[1]*along],axis,inward:[-axis[1],axis[0]],width:opening.width,depth:opening.kind==='door'?1.05:0.25};
  }).filter(Boolean);
}
function fits(room,p,openings,occupied) {
  const vertices=corners(p),points=[...vertices,p.center,...vertices.map((point,i)=>[(point[0]+vertices[(i+1)%4][0])/2,(point[1]+vertices[(i+1)%4][1])/2])];
  return points.every(point=>pointInPolygon(point,room.polygon))&&!crossesBoundary(vertices,room.polygon)&&
    !openings.some(o=>intersects(p,o))&&!occupied.some(o=>intersects(p,o));
}
function place(room,type,width,depth,openings,occupied) {
  const polygon=room.polygon;
  if(type==='nightstand'){
    const bed=occupied.find(item=>item.type==='bed');if(!bed)return null;
    for(const side of [-1,1]){
      const along=side*(bed.width/2+width/2+.1),back=-bed.depth/2+depth/2;
      const p={type,width,depth,axis:bed.axis,inward:bed.inward,center:[bed.center[0]+bed.axis[0]*along+bed.inward[0]*back,bed.center[1]+bed.axis[1]*along+bed.inward[1]*back]};
      if(fits(room,p,openings,occupied))return p;
    }
    return null;
  }
  if(type==='coffee'){
    // A coffee table belongs in front of the sofa, not against a wall. Sofas sit with
    // their back to a wall and face along +inward, so try that spot first and fall
    // back to the generic wall placement when it does not fit.
    const sofa=occupied.find(item=>item.type==='sofa');
    if(sofa){
      const front=sofa.depth/2+depth/2+.3;
      const p={type,width,depth,axis:sofa.axis,inward:sofa.inward,center:[sofa.center[0]+sofa.inward[0]*front,sofa.center[1]+sofa.inward[1]*front]};
      if(fits(room,p,openings,occupied))return p;
    }
  }
  const edges=polygon.map((start,i)=>({start,end:polygon[(i+1)%polygon.length]})).map(edge=>({...edge,length:Math.hypot(edge.end[0]-edge.start[0],edge.end[1]-edge.start[1])})).filter(edge=>edge.length>=width+0.18).sort((a,b)=>b.length-a.length);
  for(const edge of edges) {
    const axis=[(edge.end[0]-edge.start[0])/edge.length,(edge.end[1]-edge.start[1])/edge.length];
    for(const sign of [1,-1]) {
      const inward=[-axis[1]*sign,axis[0]*sign];
      for(const fraction of [0.5,0.25,0.75]) {
        const along=Math.max(width/2+0.09,Math.min(edge.length-width/2-0.09,edge.length*fraction));
        const p={type,width,depth,axis,inward,center:[edge.start[0]+axis[0]*along+inward[0]*(depth/2+0.10),edge.start[1]+axis[1]*along+inward[1]*(depth/2+0.10)]};
        if(fits(room,p,openings,occupied))return p;
      }
    }
  }
  return null;
}
export function interiorLayout(plan,authoredRooms=new Set()) {
  // IFC or user-authored objects may already furnish the model; avoid overlaying guesses.
  const hasObjects=Boolean(plan.objects?.length);
  return (plan.rooms||[]).map(room=>{
    const levelId=levelOf(plan,room),level=plan.levels.find(l=>l.id===levelId),use=roomUse(room),occupied=[];
    if(!level||!use||room.polygon.length<3)return null;
    if(!hasObjects&&!authoredRooms.has(room.id))for(const [type,width,depth] of TYPES[use]||[]) {
      const item=place(room,type,width,depth,openingsFor(plan,levelId),occupied);
      if(item)occupied.push({...item,roomId:room.id,levelId,elevation:level.elevation});
    }
    return {roomId:room.id,name:room.name,levelId,elevation:level.elevation,height:level.height||2.7,polygon:room.polygon,use,items:occupied};
  }).filter(Boolean);
}
