// A switchable illustrative interior layered over the existing architectural model.
// All positions are derived from room polygons and openings; it never edits the saved plan.
import React,{useEffect,useMemo,useState} from 'react';
import {RoundedBox} from '@react-three/drei';
import {Box3,CanvasTexture,DoubleSide,RepeatWrapping,SRGBColorSpace,Shape,TextureLoader,Vector2,Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {baseboardSegments,interiorLayout} from './interior-layout.mjs';
import {levelOf,pointInPolygon} from './architecture-model.mjs';
import {disposeScene} from './architecture-loader.mjs';
import {addWallUV} from './wall-uv.mjs';

const FINISH={wood:'#b68b62',cabinet:'#e9e4d9',worktop:'#ddd8cc',metal:'#a8aaa8',dark:'#343b3b',sofa:'#b6aaa0',linen:'#eee9df',accent:'#a98264',ceramic:'#f2f1eb',glass:'#b4d6df'};
function Box({at,size,color,roughness=0.8,metalness=0}) {
  return <mesh position={at} castShadow receiveShadow><boxGeometry args={size}/><meshStandardMaterial color={color} roughness={roughness} metalness={metalness}/></mesh>;
}
function Rounded({at,size,color,radius=0.055}) {
  return <RoundedBox args={size} position={at} radius={radius} smoothness={3} castShadow receiveShadow><meshStandardMaterial color={color} roughness={0.9}/></RoundedBox>;
}
function Cylinder({at,radius,height,color,rotation}) {
  return <mesh position={at} rotation={rotation} castShadow><cylinderGeometry args={[radius,radius,height,16]}/><meshStandardMaterial color={color} metalness={color===FINISH.metal?0.65:0} roughness={0.45}/></mesh>;
}
function Sofa({width:w,depth:d}) {
  const seat=(w-0.32)/2;
  return <group>
    <Rounded at={[0,.30,0]} size={[w,.30,d]} color={FINISH.sofa}/>
    <Rounded at={[0,.75,-d/2+.09]} size={[w,.62,.18]} color={FINISH.sofa}/>
    {[-1,1].map(s=><group key={s}>
      <Rounded at={[s*(w/2-.09),.56,0]} size={[.18,.55,d]} color={FINISH.sofa}/>
      <Rounded at={[s*seat/2,.50,.04]} size={[seat-.035,.16,d-.23]} color="#cdc0b4"/>
      <Rounded at={[s*seat/2,.76,-d/2+.23]} size={[seat-.05,.36,.18]} color="#cec2b7"/>
      {[-1,1].map(t=><Cylinder key={t} at={[s*(w/2-.17),.09,t*(d/2-.12)]} radius={.035} height={.18} color={FINISH.wood}/>)}
    </group>)}
  </group>;
}
function Bed({width:w,depth:d}) {
  return <group>
    <Rounded at={[0,.28,0]} size={[w,.30,d]} color="#b5aa9d"/>
    <Rounded at={[0,.48,.04]} size={[w-.04,.20,d-.10]} color={FINISH.linen}/>
    <Rounded at={[0,.61,-d/2+.04]} size={[w,.95,.10]} color={FINISH.wood}/>
    <Rounded at={[0,.60,d*.16]} size={[w-.10,.09,d*.60]} color="#bac2b9"/>
    {[-1,1].map(s=><Rounded key={s} at={[s*w*.23,.65,-d*.30]} size={[w*.42,.12,.38]} color="#faf8f1"/>)}
    {[-1,1].flatMap(s=>[-1,1].map(t=><Cylinder key={`${s}-${t}`} at={[s*(w/2-.12),.08,t*(d/2-.12)]} radius={.035} height={.16} color={FINISH.wood}/>))}
  </group>;
}
function Kitchen({width:w,depth:d,sinkModel}) {
  const sections=Math.max(2,Math.floor(w/.45));
  const sinkWidth=Math.min(.65,w*.34),sinkDepth=d*.65,sinkX=-w*.19;
  const left=sinkX-sinkWidth/2+w/2,right=w/2-(sinkX+sinkWidth/2),front=(d-sinkDepth)/2;
  return <group>
    <Box at={[0,.36,0]} size={[w,.68,d]} color={FINISH.cabinet}/>
    <Box at={[0,.80,d/2-.02]} size={[w,.10,.04]} color={FINISH.cabinet}/>
    {sinkModel?<>
      <Box at={[-w/2+left/2,.87,0]} size={[left,.05,d]} color={FINISH.worktop}/>
      <Box at={[w/2-right/2,.87,0]} size={[right,.05,d]} color={FINISH.worktop}/>
      {[-1,1].map(side=><Box key={side} at={[sinkX,.87,side*(sinkDepth/2+front/2)]} size={[sinkWidth,.05,front]} color={FINISH.worktop}/>)}
      <group position={[sinkX,.905,0]}><DetailedFurniture model={sinkModel} width={sinkWidth} depth={sinkDepth} top/></group>
    </>:<Box at={[0,.87,0]} size={[w+.03,.05,d+.03]} color={FINISH.worktop}/>}
    <Box at={[0,.07,0]} size={[w-.04,.14,d-.08]} color="#8a8176"/>
    {Array.from({length:sections},(_,i)=>{
      const x=-w/2+(i+.5)*w/sections;
      return <group key={i}><Box at={[x,.43,d/2+.004]} size={[w/sections-.018,.68,.012]} color="#f5f1e9"/><Cylinder at={[x,.72,d/2+.018]} radius={.012} height={.11} color={FINISH.metal} rotation={[0,0,Math.PI/2]}/></group>;
    })}
    {!sinkModel&&<Rounded at={[sinkX,.905,.02]} size={[sinkWidth,.025,sinkDepth]} color="#6c7778" radius={.025}/>}
    <Box at={[w*.25,.905,.02]} size={[Math.min(.55,w*.30),.018,d*.60]} color="#292e2e"/>
    <Cylinder at={[-w*.19,1.00,-d*.24]} radius={.018} height={.20} color={FINISH.metal}/>
    <Cylinder at={[-w*.19,1.11,-d*.14]} radius={.018} height={.18} color={FINISH.metal} rotation={[Math.PI/2,0,0]}/>
    <Box at={[0,1.65,-d/2+.16]} size={[w,.65,.32]} color={FINISH.cabinet}/>
    {Array.from({length:sections},(_,i)=><Box key={`upper-${i}`} at={[-w/2+(i+.5)*w/sections,1.65,-d/2+.325]} size={[w/sections-.02,.59,.012]} color="#f5f1e9"/>)}
  </group>;
}
function Vanity({width:w,depth:d}) {
  return <group>
    <Box at={[0,.40,0]} size={[w,.76,d]} color="#b9a28b"/>
    <Box at={[0,.80,0]} size={[w+.03,.06,d+.03]} color={FINISH.ceramic}/>
    <Rounded at={[0,.845,0]} size={[w*.62,.018,d*.55]} color="#c9d2d0" radius={.06}/>
    <Cylinder at={[0,.94,-d*.30]} radius={.018} height={.20} color={FINISH.metal}/>
    <Box at={[0,1.45,-d/2+.018]} size={[w*.82,.78,.025]} color="#8eabb2" roughness={.12} metalness={.25}/>
  </group>;
}
function Toilet({width:w,depth:d}) {
  return <group>
    <Rounded at={[0,.47,-d*.30]} size={[w*.88,.65,d*.26]} color={FINISH.ceramic}/>
    <mesh position={[0,.27,d*.08]} scale={[w*.48,.27,d*.46]} castShadow><sphereGeometry args={[1,24,16]}/><meshStandardMaterial color={FINISH.ceramic} roughness={.24}/></mesh>
    <mesh position={[0,.47,d*.08]} rotation={[-Math.PI/2,0,0]} scale={[w*.31,d*.30,1]}><torusGeometry args={[1,.11,8,24]}/><meshStandardMaterial color="#e5e4df" roughness={.25}/></mesh>
  </group>;
}
function Coffee({width:w,depth:d}) {
  return <group><Rounded at={[0,.43,0]} size={[w,.06,d]} color={FINISH.wood} radius={.025}/>{[-1,1].flatMap(x=>[-1,1].map(z=><Cylinder key={`${x}-${z}`} at={[x*(w/2-.08),.21,z*(d/2-.08)]} radius={.022} height={.42} color={FINISH.metal}/>))}</group>;
}
function DetailedFurniture({model,width,depth,top=false}) {
  const fitted=useMemo(()=>{
    const scene=model.clone(true);
    scene.traverse(node=>{
      if(node.isLight||node.isCamera)node.visible=false;
      if(!node.isMesh)return;
      node.castShadow=true;node.receiveShadow=true;
    });
    const box=new Box3().setFromObject(scene),size=box.getSize(new Vector3()),center=box.getCenter(new Vector3());
    const scale=Math.min(width/size.x,depth/size.z);
    return {scene,scale,offset:[-center.x,top?-box.max.y:-box.min.y,-center.z]};
  },[model,width,depth,top]);
  return <group scale={fitted.scale}><primitive object={fitted.scene} position={fitted.offset}/></group>;
}
function Furniture({item,models}) {
  const {type,width,depth,center,axis,inward,elevation}=item;
  const sign=Math.sign(axis[0]*inward[1]-axis[1]*inward[0])||1;
  const props={width,depth};
  const visual=models[type]?<DetailedFurniture model={models[type]} {...props}/>:({sofa:<Sofa {...props}/>,bed:<Bed {...props}/>,kitchen:<Kitchen {...props} sinkModel={models.sink}/>,vanity:<Vanity {...props}/>,toilet:<Toilet {...props}/>,coffee:<Coffee {...props}/>} [type]);
  return <group position={[center[0],elevation+.02,-center[1]]} rotation={[0,Math.atan2(axis[1],axis[0]),0]} scale={[1,1,-sign]}>{visual}</group>;
}
function floorTexture(tile) {
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;
  const c=canvas.getContext('2d');
  if(tile){
    c.fillStyle='#d9d6cd';c.fillRect(0,0,512,512);c.strokeStyle='#a9a59c';c.lineWidth=3;
    for(let i=0;i<=512;i+=128){c.beginPath();c.moveTo(i,0);c.lineTo(i,512);c.moveTo(0,i);c.lineTo(512,i);c.stroke();}
  } else {
    c.fillStyle='#be9a76';c.fillRect(0,0,512,512);
    for(let y=0;y<512;y+=64){c.fillStyle=y%128?'#c4a17e':'#b98f6c';c.fillRect(0,y,512,62);c.strokeStyle='#907255';c.lineWidth=2;c.beginPath();c.moveTo(0,y+63);c.lineTo(512,y+63);c.stroke();
      for(let x=(y%128?100:250);x<512;x+=300){c.beginPath();c.moveTo(x,y);c.lineTo(x,y+63);c.stroke();}
      c.strokeStyle='rgba(93,65,41,.16)';c.lineWidth=1;for(let z=8;z<62;z+=12){c.beginPath();c.moveTo(0,y+z);c.bezierCurveTo(140,y+z+2,340,y+z-3,512,y+z);c.stroke();}}
  }
  const texture=new CanvasTexture(canvas);texture.colorSpace=SRGBColorSpace;texture.wrapS=texture.wrapT=RepeatWrapping;texture.repeat.set(.55,.55);return texture;
}
function RoomFloor({room,wood,tile}) {
  const shape=useMemo(()=>{const s=new Shape();room.polygon.forEach(([x,y],i)=>i?s.lineTo(x,y):s.moveTo(x,y));s.closePath();return s;},[room]);
  const surface=room.use==='bath'?tile:wood;
  return <>
    <mesh rotation={[-Math.PI/2,0,0]} position={[0,room.elevation+.015,0]} receiveShadow raycast={()=>null}><shapeGeometry args={[shape]}/><meshStandardMaterial map={surface.color} normalMap={surface.normal} roughnessMap={surface.roughness} roughness={.85}/></mesh>
    <mesh rotation={[-Math.PI/2,0,0]} position={[0,room.elevation+room.height-.015,0]} castShadow receiveShadow raycast={()=>null}><shapeGeometry args={[shape]}/><meshStandardMaterial color="#f2eee7" roughness={1} side={DoubleSide}/></mesh>
  </>;
}
function useInteriorAssets(fallback) {
  const [loaded,setLoaded]=useState({models:{},surfaces:{},ready:false});
  useEffect(()=>{
    let active=true;const textures=[],scenes=[],tasks=[];
    const textureLoader=new TextureLoader(),modelLoader=new GLTFLoader();
    for(const [type,repeat] of [['wood',1/1.8],['tile',1],['door',1]]) {
      tasks.push(Promise.all(['color','normal','roughness'].map(async kind=>{
        const texture=await textureLoader.loadAsync(`/architecture-assets/${type}-${kind}.jpg`);
        if(!active){texture.dispose();return null;}
        textures.push(texture);texture.wrapS=texture.wrapT=RepeatWrapping;texture.repeat.set(repeat,repeat);
        if(kind==='color')texture.colorSpace=SRGBColorSpace;
        return texture;
      })).then(([color,normal,roughness])=>{if(active)setLoaded(current=>({...current,surfaces:{...current.surfaces,[type]:{color,normal,roughness}}}));}).catch(()=>{}));
    }
    tasks.push(Promise.all(['normal','roughness'].map(async kind=>{
      const texture=await textureLoader.loadAsync(`/architecture-assets/plaster-${kind}.jpg`);
      if(!active){texture.dispose();return null;}
      textures.push(texture);texture.wrapS=texture.wrapT=RepeatWrapping;
      return texture;
    })).then(([normal,roughness])=>{if(active)setLoaded(current=>({...current,surfaces:{...current.surfaces,plaster:{normal,roughness}}}));}).catch(()=>{}));
    for(const type of ['bed','sofa','sink','toilet','vanity','nightstand'])tasks.push(modelLoader.loadAsync(`/architecture-assets/${type}.glb`).then(({scene})=>{
      if(!active){disposeScene(scene);return;}
      scenes.push(scene);setLoaded(current=>({...current,models:{...current.models,[type]:scene}}));
    }).catch(()=>{}));
    Promise.all(tasks).then(()=>{if(active)setLoaded(current=>({...current,ready:true}));});
    return ()=>{active=false;textures.forEach(texture=>texture.dispose());scenes.forEach(disposeScene);};
  },[]);
  return {models:loaded.models,wood:loaded.surfaces.wood||{color:fallback[0]},tile:loaded.surfaces.tile||{color:fallback[1]},plaster:loaded.surfaces.plaster,door:loaded.surfaces.door,ready:loaded.ready};
}
function OpeningDetails({plan}) {
  return <group>{(plan.openings||[]).map(opening=>{
    const wall=plan.walls.find(w=>w.id===opening.wallId),level=plan.levels.find(l=>l.id===(opening.levelId||wall?.levelId||plan.levels[0].id));
    if(!wall||!level)return null;
    const dx=wall.end[0]-wall.start[0],dy=wall.end[1]-wall.start[1],length=Math.hypot(dx,dy);if(!length)return null;
    const ux=dx/length,uy=dy/length,along=opening.offset+opening.width/2,x=wall.start[0]+ux*along,y=wall.start[1]+uy*along;
    const w=opening.width,h=opening.height,sill=opening.sill||0,face=(wall.thickness||.18)/2+.015;
    const isWindow=opening.kind==='window';
    return <group key={opening.id} position={[x,level.elevation+sill,-y]} rotation={[0,Math.atan2(uy,ux),0]}>
      {[-1,1].map(side=><group key={side} position={[0,0,side*face]}>
        {[-1,1].map(edge=><Box key={edge} at={[edge*(w/2+.025),h/2,0]} size={[.05,h+.06,.035]} color="#eee9e1"/>)}
        <Box at={[0,h+.025,0]} size={[w+.1,.05,.035]} color="#eee9e1"/>
        {isWindow?<><Box at={[0,-.025,0]} size={[w+.1,.05,.035]} color="#eee9e1"/><Box at={[0,h/2,0]} size={[.035,h,.035]} color="#eee9e1"/></>:<>
          <Box at={[w*.32,1.00,side*.025]} size={[.035,.12,.025]} color={FINISH.metal} metalness={.65}/>
          <Cylinder at={[w*.32,1.01,side*.045]} radius={.025} height={.08} color={FINISH.metal} rotation={[Math.PI/2,0,0]}/>
        </>}
      </group>)}
    </group>;
  })}</group>;
}
const Baseboards=React.memo(function Baseboards({plan}) {
  return <group>{baseboardSegments(plan).map(({wall,start,end},index)=>{
    const level=plan.levels.find(item=>item.id===levelOf(plan,wall));if(!level)return null;
    const dx=wall.end[0]-wall.start[0],dy=wall.end[1]-wall.start[1],length=Math.hypot(dx,dy);
    const x=wall.start[0]+dx/length*(start+end)/2,y=wall.start[1]+dy/length*(start+end)/2,face=(wall.thickness||.18)/2+.014;
    return <group key={`${wall.id}-${index}`} position={[x,level.elevation,-y]} rotation={[0,Math.atan2(dy,dx),0]}>
      {[-1,1].map(side=><group key={side} position={[0,0,side*face]}>
        <Box at={[0,.045,0]} size={[end-start,.09,.018]} color="#ece8df"/>
        <Box at={[0,.094,0]} size={[end-start,.012,.024]} color="#f5f2eb"/>
      </group>)}
    </group>;
  })}</group>;
});
export function InteriorScene({plan,model,authoredRooms,authoredFloors,walker,legacyUnstyled,onSceneReady}) {
  const rooms=useMemo(()=>interiorLayout(plan,authoredRooms),[plan,authoredRooms]);
  const textures=useMemo(()=>[floorTexture(false),floorTexture(true)],[]);
  useEffect(()=>()=>textures.forEach(texture=>texture.dispose()),[textures]);
  const assets=useInteriorAssets(textures);
  useEffect(()=>{
    const originals=[];
    for(const mesh of model.meshes) {
      const surface=mesh.userData.implicitWall?assets.plaster:mesh.userData.implicitDoor?assets.door:null;
      if(!surface)continue;
      const geometry=mesh.geometry,materials=[mesh.material].flat().filter(material=>material.isMeshStandardMaterial);
      if(!materials.length||!geometry.attributes.position||!geometry.attributes.normal)continue;
      mesh.geometry=addWallUV(geometry.clone());
      for(const material of materials) {
        originals.push({mesh,geometry,material,map:material.map,color:material.color.clone(),normalMap:material.normalMap,roughnessMap:material.roughnessMap,normalScale:material.normalScale.clone()});
        if(surface.color){material.map=surface.color;material.color.set('#ffffff');}
        material.normalMap=surface.normal;material.roughnessMap=surface.roughness;material.normalScale=new Vector2(.18,.18);material.needsUpdate=true;
      }
    }
    return ()=>{for(const {mesh,geometry,material,map,color,normalMap,roughnessMap,normalScale} of originals){if(mesh.geometry!==geometry){mesh.geometry.dispose();mesh.geometry=geometry;}material.map=map;material.color.copy(color);material.normalMap=normalMap;material.roughnessMap=roughnessMap;material.normalScale=normalScale;material.needsUpdate=true;}};
  },[model,assets.plaster,assets.door]);
  useEffect(()=>{if(assets.ready)onSceneReady?.(true);return ()=>onSceneReady?.(false);},[assets.ready,onSceneReady]);
  const centers=useMemo(()=>rooms.map(room=>({room,center:room.polygon.reduce((a,p)=>[a[0]+p[0]/room.polygon.length,a[1]+p[1]/room.polygon.length],[0,0])})),[rooms]);
  const nearby=centers.filter(({room})=>!walker||room.levelId===walker.levelId).sort((a,b)=>walker?Math.hypot(a.center[0]-walker.x,a.center[1]-walker.y)-Math.hypot(b.center[0]-walker.x,b.center[1]-walker.y):0).slice(0,2);
  const furnishings=useMemo(()=><group>
    {rooms.map(room=><group key={room.roomId}>
      {!authoredFloors?.has(room.roomId)&&<RoomFloor room={room} wood={assets.wood} tile={assets.tile}/>}
      {room.items.map((item,i)=><Furniture key={`${item.type}-${i}`} item={item} models={assets.models}/>)}
      {legacyUnstyled&&(()=>{const center=room.polygon.reduce((a,p)=>[a[0]+p[0]/room.polygon.length,a[1]+p[1]/room.polygon.length],[0,0]);return pointInPolygon(center,room.polygon)&&<Cylinder at={[center[0],room.elevation+room.height-.04,-center[1]]} radius={.16} height={.035} color="#efebe3"/>;})()}
    </group>)}
    {legacyUnstyled && <OpeningDetails plan={plan}/>}
    {legacyUnstyled && <Baseboards plan={plan}/>}
  </group>,[rooms,authoredFloors,assets.wood,assets.tile,assets.models,legacyUnstyled,plan]);
  return <group>
    {furnishings}
    {nearby.map(({room,center},index)=>{const reach=Math.min(7,Math.max(2.5,...room.polygon.map(p=>Math.hypot(p[0]-center[0],p[1]-center[1])))+.3);return <pointLight key={index} position={[center[0],room.elevation+Math.min(room.height-.15,2.5),-center[1]]} intensity={8} distance={reach} decay={2} color="#fff3de"/>;})}
  </group>;
}
