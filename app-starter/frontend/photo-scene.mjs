import {Group} from 'three';

export function lightState(scene) {
  const lights=[];
  scene.traverse(node=>{if(node.visible&&(node.isPointLight||node.isDirectionalLight||node.isSpotLight||node.isRectAreaLight))lights.push(node);});
  return {ids:lights.map(light=>light.uuid).join(','),values:lights.map(light=>`${light.uuid}:${light.position.toArray().join(',')}:${light.intensity}`).join('|')};
}

export function syncTraceLights(trace) {
  for(const [source,copy] of trace.pairs){
    copy.position.copy(source.position);copy.quaternion.copy(source.quaternion);copy.intensity=source.intensity;copy.color.copy(source.color);
    if(source.isPointLight||source.isSpotLight){copy.distance=source.distance;copy.decay=source.decay;}
  }
  trace.copy.updateMatrixWorld(true);
}

// Remove a hidden volume's mesh without hiding its furnished children.
export function makeTraceScene(scene) {
  const copy=scene.clone(true),pairs=[],remove=[];
  const pair=(source,target)=>{
    if(source.isLight)pairs.push([source,target]);
    source.children.forEach((child,index)=>pair(child,target.children[index]));
  };
  pair(scene,copy);copy.environment=scene.environment;
  if(scene.environment)copy.background=scene.environment;
  copy.traverseVisible(node=>{
    if(!node.isMesh)return;
    const materials=[node.material].flat();
    if(node.userData.spaceShell||node.userData.photoBackground||materials.every(m=>m?.visible===false)){remove.push(node);return;}
    if(materials.some(m=>!m?.isMeshStandardMaterial||m.visible===false))throw new Error('This model has materials not supported by detailed lighting');
  });
  for(const mesh of remove.reverse()){
    const parent=mesh.parent;if(!parent)continue;
    const group=new Group().copy(mesh,false);if(mesh.children.length)group.add(...mesh.children.slice());
    parent.remove(mesh);parent.add(group);
  }
  return {copy,pairs};
}
