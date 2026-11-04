import React,{useEffect,useRef,useState} from 'react';
import {useFrame,useThree} from '@react-three/fiber';
import {ClampToEdgeWrapping,DepthTexture,DoubleSide,HalfFloatType,MeshNormalMaterial,ShaderMaterial,UniformsUtils,Vector2,WebGLRenderTarget} from 'three';
import {GenerateMeshBVHWorker} from 'three-mesh-bvh/worker';
import {RenderTarget2DArray} from 'three-gpu-pathtracer/src/uniforms/RenderTarget2DArray.js';
import {FullScreenQuad} from 'three/addons/postprocessing/Pass.js';
import {lightState,makeTraceScene,syncTraceLights} from './photo-scene.mjs';
import {isBlackDetail} from './black-frame.mjs';

// Spatial, edge-aware filtering of the progressively accumulated linear image.
const denoiseShader={
  uniforms:{source:{value:null},normalGuide:{value:null},depthGuide:{value:null},texel:{value:new Vector2()},opacity:{value:1}},
  vertexShader:`varying vec2 uvCoord; void main(){uvCoord=uv;gl_Position=vec4(position.xy,0.,1.);}`,
  fragmentShader:`
    uniform sampler2D source;uniform sampler2D normalGuide;uniform sampler2D depthGuide;uniform vec2 texel;uniform float opacity;varying vec2 uvCoord;
    void main(){
      vec3 center=min(texture2D(source,uvCoord).rgb,vec3(6.));vec3 total=vec3(0.);float weight=0.;
      vec3 normal=normalize(texture2D(normalGuide,uvCoord).rgb*2.-1.);float depth=texture2D(depthGuide,uvCoord).r;
      for(int y=-3;y<=3;y++)for(int x=-3;x<=3;x++){
        vec2 offset=vec2(float(x),float(y));vec2 p=uvCoord+offset*texel;vec3 sampleColor=min(texture2D(source,p).rgb,vec3(6.));
        vec3 sampleNormal=normalize(texture2D(normalGuide,p).rgb*2.-1.);float sampleDepth=texture2D(depthGuide,p).r;
        vec3 delta=sampleColor-center;float spatial=exp(-dot(offset,offset)*.16);
        float range=exp(-dot(delta,delta)*.2);float edge=pow(max(dot(normal,sampleNormal),0.),16.)*exp(-abs(depth-sampleDepth)*900.);
        float w=spatial*range*edge;total+=sampleColor*w;weight+=w;
      }
      gl_FragColor=vec4(total/max(weight,.00001),opacity);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
};


export function PhotoRenderer({version,onFailure}) {
  const {gl,scene,camera}=useThree(),state=useRef({});
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    const restore=()=>{if(document.visibilityState==='visible'){state.current={};setRefresh(value=>value+1);}};
    gl.domElement.addEventListener('webglcontextrestored',restore);
    document.addEventListener('visibilitychange',restore);
    return ()=>{gl.domElement.removeEventListener('webglcontextrestored',restore);document.removeEventListener('visibilitychange',restore);};
  },[gl]);
  useEffect(()=>{
    let alive=true,instance=null,material=null,guide=null,normalMaterial=null,worker=null,textureTarget=null,iesTarget=null,probeQuad=null,detailProbe=null,rasterProbe=null;
    (async()=>{
      if(!gl.capabilities.isWebGL2||!gl.extensions.has('EXT_color_buffer_float'))throw new Error('Required GPU rendering support is unavailable');
      const {WebGLPathTracer}=await import('three-gpu-pathtracer');
      if(!alive)return;
      const trace=makeTraceScene(scene);
      const initialLights=lightState(scene);
        instance=new WebGLPathTracer(gl);instance.renderScale=.6;instance.textureSize.set(512,512);instance.tiles.set(2,2);instance.bounces=4;instance.filterGlossyFactor=.7;
        instance.minSamples=96;instance.fadeDuration=350;instance.renderDelay=250;instance.dynamicLowRes=false;
        instance.rasterizeSceneCallback=()=>gl.render(scene,camera);
        // Own the packed texture render targets so they can be released on mode changes.
        const pathMaterial=instance._pathTracer.material;
        pathMaterial.textures.dispose();pathMaterial.iesProfiles.dispose();
        textureTarget=new RenderTarget2DArray();iesTarget=new RenderTarget2DArray(360,180,{type:HalfFloatType,wrapS:ClampToEdgeWrapping,wrapT:ClampToEdgeWrapping});
        pathMaterial.textures=textureTarget.texture;pathMaterial.iesProfiles=iesTarget.texture;
        worker=new GenerateMeshBVHWorker();
        // This renderer starts one build per worker. Calling runTask directly avoids the
        // pinned worker's unobserved rejected promise when a worker cannot load.
        instance.setBVHWorker({generate:(geometry,options)=>worker.runTask(worker.worker,geometry,options)});
        material=new ShaderMaterial({...denoiseShader,uniforms:UniformsUtils.clone(denoiseShader.uniforms),transparent:true,depthTest:false,depthWrite:false});
        guide=new WebGLRenderTarget(1,1,{depthTexture:new DepthTexture(1,1)});normalMaterial=new MeshNormalMaterial({side:DoubleSide});
        detailProbe=new WebGLRenderTarget(16,16,{depthBuffer:false});rasterProbe=new WebGLRenderTarget(16,16);
        probeQuad=new FullScreenQuad(new ShaderMaterial({uniforms:{source:{value:null}},vertexShader:'varying vec2 v;void main(){v=uv;gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:'uniform sampler2D source;varying vec2 v;void main(){gl_FragColor=vec4(texture2D(source,v).rgb,1.);}',depthTest:false,depthWrite:false,toneMapped:false}));
        instance.renderToCanvasCallback=(target,renderer,quad)=>{
          if(!state.current.checked&&instance.samples>=instance.minSamples){
            const previousTarget=renderer.getRenderTarget(),autoClear=renderer.autoClear,shadows=renderer.shadowMap.autoUpdate;
            const detail=new Uint8Array(16*16*4),raster=new Uint8Array(16*16*4);
            try{
              renderer.shadowMap.autoUpdate=false;renderer.autoClear=true;
              renderer.setRenderTarget(rasterProbe);renderer.render(scene,camera);renderer.readRenderTargetPixels(rasterProbe,0,0,16,16,raster);
              probeQuad.material.uniforms.source.value=target.texture;renderer.setRenderTarget(detailProbe);probeQuad.render(renderer);renderer.readRenderTargetPixels(detailProbe,0,0,16,16,detail);
            }finally{renderer.shadowMap.autoUpdate=shadows;renderer.autoClear=autoClear;renderer.setRenderTarget(previousTarget);}
            state.current.checked=true;
            if(isBlackDetail(detail,raster))throw new Error('Detailed lighting returned a black frame');
          }
          if(state.current.guideDirty||guide.width!==target.width||guide.height!==target.height){
            guide.setSize(target.width,target.height);
            const guideScene=trace.copy,previousTarget=renderer.getRenderTarget(),override=guideScene.overrideMaterial,background=guideScene.background;
            try{guideScene.overrideMaterial=normalMaterial;guideScene.background=null;renderer.setRenderTarget(guide);renderer.clear();renderer.render(guideScene,camera);}
            finally{guideScene.overrideMaterial=override;guideScene.background=background;renderer.setRenderTarget(previousTarget);}
            state.current.guideDirty=false;
          }
          material.uniforms.source.value=target.texture;
          material.uniforms.normalGuide.value=guide.texture;material.uniforms.depthGuide.value=guide.depthTexture;
          material.uniforms.texel.value.set(1/target.width,1/target.height);
          const previous=quad.material,autoClear=renderer.autoClear;material.uniforms.opacity.value=previous.opacity;quad.material=material;
          try{renderer.setRenderTarget(null);renderer.autoClear=false;quad.render(renderer);}finally{quad.material=previous;renderer.autoClear=autoClear;}
        };
        await instance.setSceneAsync(trace.copy,camera);
        if(alive){
          const lights=lightState(scene);
          if(lights.ids!==initialLights.ids){setRefresh(value=>value+1);return;}
          syncTraceLights(trace);instance.updateLights();
          state.current={instance,trace,previous:null,projection:null,changed:performance.now(),guideDirty:true,checked:false,lights,lightChecked:0};
        }
    })().catch(error=>{console.warn('Enhanced rendering unavailable',error);if(alive)onFailure();});
    // Release resources that the pinned renderer's dispose() leaves allocated.
    return ()=>{
      alive=false;state.current={};worker?.dispose();
      if(instance){
        const materials=new Set([instance._pathTracer.material,instance._lowResPathTracer.material]);
        for(const item of materials){for(const key of ['bvh','attributesArray','materialIndexAttribute','materials','envMapInfo'])item[key]?.dispose?.();item.lights?.tex?.dispose();item.dispose();}
        instance.dispose();instance._lowResPathTracer.dispose();
      }
      textureTarget?.dispose();iesTarget?.dispose();material?.dispose();guide?.dispose();normalMaterial?.dispose();
      detailProbe?.dispose();rasterProbe?.dispose();probeQuad?.material.dispose();probeQuad?.dispose();
    };
  },[gl,scene,camera,version,onFailure,refresh]);
  useFrame(()=>{
    const current=state.current,pt=current.instance;
    if(!pt){gl.render(scene,camera);return;}
    const now=performance.now();camera.updateMatrixWorld();const matrix=camera.matrixWorld.elements,projection=camera.projectionMatrix.elements;
    if(!current.previous||matrix.some((value,index)=>Math.abs(value-current.previous[index])>1e-5)||projection.some((value,index)=>Math.abs(value-current.projection[index])>1e-5)){
      pt.updateCamera();current.previous=[...matrix];current.projection=[...projection];current.changed=now;current.guideDirty=true;current.checked=false;
    }
    try{
      if(now-current.lightChecked>250){
        current.lightChecked=now;const lights=lightState(scene);
        if(lights.ids!==current.lights.ids){state.current={};setRefresh(value=>value+1);gl.render(scene,camera);return;}
        if(lights.values!==current.lights.values){
          syncTraceLights(current.trace);pt.updateLights();current.changed=now;current.checked=false;
        }
        current.lights=lights;
      }
      pt.enablePathTracing=now-current.changed>300;pt.pausePathTracing=pt.samples>=512;pt.renderSample();
    }catch(error){console.warn('Enhanced rendering stopped',error);onFailure();gl.render(scene,camera);}
  },1);
  return null;
}
