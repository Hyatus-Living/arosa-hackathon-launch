import {DataTexture,EquirectangularReflectionMapping,FloatType,RGBAFormat} from 'three';

// An illustrative atmosphere supplies daylight without inventing the view outside a property.
// The bright sun lobe sits at the walkthrough Sky sunPosition so the raster view and the
// detailed (path-traced) view, which uses this texture as its background, agree on where
// the sun is. Texel directions invert three.js equirectUv (common.glsl.js):
// u = atan(dir.z, dir.x) / 2PI + .5 and v = asin(dir.y) / PI + .5, with data row 0 at v = 0.
export function daylightEnvironment(width=512,height=256,sunPosition=[100,35,100]) {
  const data=new Float32Array(width*height*4);
  const sunLength=Math.hypot(...sunPosition),sun=sunPosition.map(value=>value/sunLength);
  for(let y=0;y<height;y++){
    const altitude=-Math.cos(Math.PI*(y+.5)/height);
    const sky=Math.max(0,altitude),horizon=Math.pow(1-sky,3);
    const horizontal=Math.sqrt(Math.max(0,1-altitude*altitude));
    for(let x=0;x<width;x++){
      const i=(y*width+x)*4;
      if(altitude<0){data[i]=.26;data[i+1]=.25;data[i+2]=.23;}
      else {data[i]=.30+sky*.08+horizon*.32;data[i+1]=.43+sky*.10+horizon*.25;data[i+2]=.68+sky*.15+horizon*.12;}
      if(altitude>=0){
        const phi=((x+.5)/width-.5)*2*Math.PI;
        const dot=Math.max(0,horizontal*Math.cos(phi)*sun[0]+altitude*sun[1]+horizontal*Math.sin(phi)*sun[2]);
        const glow=Math.pow(dot,900)*5+Math.pow(dot,90)*.55;
        data[i]+=glow;data[i+1]+=glow*.93;data[i+2]+=glow*.78;
      }
      data[i+3]=1;
    }
  }
  const texture=new DataTexture(data,width,height,RGBAFormat,FloatType);
  texture.mapping=EquirectangularReflectionMapping;texture.needsUpdate=true;
  return texture;
}
