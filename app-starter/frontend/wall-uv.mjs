import {Float32BufferAttribute} from 'three';

// IFC meshes often have no UVs. Project wall faces at a consistent scale without
// changing vertices, normals or the saved IFC model.
export function addWallUV(geometry) {
  if(geometry.attributes.uv)return geometry;
  const positions=geometry.getAttribute('position'),normals=geometry.getAttribute('normal');
  if(!positions||!normals)return geometry;
  const uv=[];
  for(let i=0;i<positions.count;i++) {
    const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i);
    const nx=Math.abs(normals.getX(i)),ny=Math.abs(normals.getY(i)),nz=Math.abs(normals.getZ(i));
    uv.push(nx>=ny&&nx>=nz?z:x,ny>=nx&&ny>=nz?z:y);
  }
  geometry.setAttribute('uv',new Float32BufferAttribute(uv,2));
  return geometry;
}
