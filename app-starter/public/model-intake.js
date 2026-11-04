import {exportPlan} from './plan-intake.js';

export function geometryKey(plan) {
  if(!plan)return '';
  const document=exportPlan(plan);
  return JSON.stringify(Object.fromEntries(['levels','walls','openings','rooms','objects'].map(key=>[key,document[key]])));
}

export async function modelInput({fetch,projectId,operation,file,plan,units,tolerance,signal}) {
  if(!file||!file.size||file.size>25*1024*1024)throw new Error('Choose a file of at most 25 MB.');
  const bytes=new Uint8Array(await file.arrayBuffer()),parts=[];
  for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
  const response=await fetch(`/api/projects/${encodeURIComponent(projectId)}/architecture/${operation}`,{
    method:'POST',headers:{'content-type':'application/json'},signal,
    body:JSON.stringify({name:file.name,data:btoa(parts.join('')),...(plan?{plan:exportPlan(plan),units,tolerance}:{})}),
  });
  const result=await response.json();
  if(!response.ok)throw new Error(result.error);
  return result;
}

export function downloadModelReport(report,name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=name;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
