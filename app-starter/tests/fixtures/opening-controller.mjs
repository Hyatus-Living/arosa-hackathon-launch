import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as intake from '../../public/plan-intake.js';

const source=readFileSync(new URL('../../frontend/plan-editor.jsx',import.meta.url),'utf8');
const history=source.slice(source.indexOf('function useHistory('),source.indexOf('async function renderPdfPage('));
const handlers=source.slice(source.indexOf('  function onPointerMove('),source.indexOf('  function chooseTool('));
if(!history||!handlers)throw new Error('Production opening controller was not found');

export function openingController(initial,id=initial.openings[0].id) {
  const c={...intake,plan:initial,selection:{kind:'opening',id},tool:'select',dragRef:{current:null},pointer:e=>[e.x,e.y],fromView:p=>p,
    useRef:value=>({current:value}),geometry(){throw new Error('An opening edit must not rebuild wall geometry');}};
  c.useState=value=>[value,next=>{c.historyState=next;c.plan=next.plan;}];
  vm.createContext(c);
  vm.runInContext(source.split('\n').find(line=>line.startsWith('const num ='))+'\n'+history+'\n'+handlers,c);
  c.history=c.useHistory(initial);c.historyState={past:[],plan:initial,future:[]};
  c.key=(key,shiftKey=false)=>c.onKeyDown({key,shiftKey,metaKey:false,ctrlKey:false,target:{closest:()=>null},preventDefault(){}});
  c.drag=(delta)=>{const base=c.plan;c.dragRef.current={type:'opening',id,base,start:[0,0],moved:false};c.onPointerMove({x:delta[0],y:delta[1]});c.onPointerUp();};
  return c;
}
