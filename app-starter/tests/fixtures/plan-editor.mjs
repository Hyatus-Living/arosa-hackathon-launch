import {buildSync} from 'esbuild';
import {parseHTML} from 'linkedom';
import {createRequire,Module} from 'node:module';
import {fileURLToPath} from 'node:url';
import {PLAN_SCHEMA} from '../../public/plan-intake.js';

const require=createRequire(new URL('../../package.json',import.meta.url));
const {act}=require('react');
const source=fileURLToPath(new URL('../../frontend/plan-editor.jsx',import.meta.url));
const bundle=buildSync({entryPoints:[source],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/*','react-dom/*','pdfjs-dist'],loader:{'.css':'empty'},logLevel:'silent'}).outputFiles[0].text;

export function multiLevelPlan() {
  const levels=[{id:'ground',name:'Ground floor',elevation:0,height:2.8},{id:'upper',name:'Upper floor',elevation:3,height:3.2}];
  const walls=levels.flatMap((level,n)=>[[[0,0],[8,0]],[[8,0],[8,6]],[[8,6],[0,6]],[[0,6],[0,0]]].map(([start,end],i)=>({id:`${level.id}-${i}`,levelId:level.id,start,end,thickness:.18,height:level.height,material:'generic',roomIds:[`${level.id}-room`]})));
  return {schema:PLAN_SCHEMA,id:'two-level-plan',name:'Two-level plan',units:'m',revision:1,parentRevision:null,levels,walls,openings:levels.map(l=>({id:`${l.id}-door`,wallId:`${l.id}-0`,kind:'door',offset:1,width:.9,height:2.1,sill:0,swing:null})),rooms:levels.map(l=>({id:`${l.id}-room`,levelId:l.id,name:`${l.name} room`,polygon:[[0,0],[8,0],[8,6],[0,6]],netAreaMethod:'centerline'})),objects:[],sources:[]};
}

export async function mountEditor(initial=multiLevelPlan(),{transport}={}) {
  const {window}=parseHTML('<!doctype html><html><body><div id="editor"></div></body></html>');
  const originals=new Map();
  const set=(key,value)=>{originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});};
  set('window',window);set('document',window.document);set('navigator',{userAgent:'node'});set('IS_REACT_ACT_ENVIRONMENT',true);
  set('EventSource',class{close(){}});set('ResizeObserver',class{observe(){}disconnect(){}});
  const drafts=new Map();window.localStorage={getItem:k=>drafts.get(k)||null,setItem:(k,v)=>drafts.set(k,v),removeItem:k=>drafts.delete(k)};
  Object.defineProperties(window.SVGElement.prototype,{clientWidth:{configurable:true,get:()=>800},clientHeight:{configurable:true,get:()=>600}});
  window.SVGElement.prototype.createSVGPoint=()=>({x:0,y:0,matrixTransform(){return{x:this.x,y:this.y};}});
  window.SVGElement.prototype.getScreenCTM=()=>({inverse(){return this;}});
  window.SVGElement.prototype.setPointerCapture=()=>{};window.SVGElement.prototype.focus=()=>{};
  let current=structuredClone(initial);const requests=[],actions=[],initialRequests=[];
  set('fetch',async(url,options={})=>{
    requests.push({url,...options});
    if(transport){const pending=transport(url,options);initialRequests.push(pending);return pending;}
    if(url.endsWith('/drawings'))return{ok:true,json:async()=>({drawings:[]})};
    if(options.method==='PUT'){
      const input=JSON.parse(options.body);current={...input.plan,revision:current.revision+1};
      return{ok:true,status:200,json:async()=>({plan:current,planId:current.id,revision:current.revision,parentRevision:input.parentRevision})};
    }
    return{ok:true,json:async()=>({current:{plan:current,revision:current.revision}})};
  });
  const compiled=new Module(source);compiled.filename=source;compiled.paths=require.resolve.paths('react');compiled._compile(bundle,source);
  const root=window.document.querySelector('#editor');
  await act(async()=>{window.acresPlanEditor.mount(root,{projectId:'fixture-project',onAction:action=>actions.push(action)});});
  if(initialRequests.length)await act(async()=>{await Promise.all(initialRequests);});
  const props=element=>element[Object.keys(element).find(k=>k.startsWith('__reactProps$'))];
  async function action(element,event='onClick',data={}){
    if(!element)throw new Error('Editor control not found.');
    const handler=props(element)?.[event];if(!handler)throw new Error(`Editor control has no ${event}.`);
    await act(async()=>{await handler({target:element,currentTarget:element,preventDefault(){},...data});});
  }
  const api={root,window,requests,actions,drafts,props,action,get saved(){return current;},
    button:label=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label),
    async level(id){await action(root.querySelector('select[aria-label="Plan level"]'),'onChange',{target:{value:id}});},
    async pointer(x,y,target=root.querySelector('svg.plan-canvas')){await action(root.querySelector('svg.plan-canvas'),'onPointerDown',{target,button:0,clientX:x,clientY:-y,pointerId:1});},
    async key(key,extra={}){await action(root.querySelector('.plan-editor'),'onKeyDown',{key,metaKey:false,ctrlKey:false,shiftKey:false,...extra});},
    async close(){await act(async()=>window.acresPlanEditor.unmount(root));for(const[key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}},
  };
  return api;
}
