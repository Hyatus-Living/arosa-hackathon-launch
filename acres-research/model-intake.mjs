import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnPlanner} from './planning.mjs';
import {planFromJson, detectRooms, exportPlan, validatePlan} from './plan-intake.mjs';

const fail = message => {throw Object.assign(new Error(message), {status:400});};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const MODEL_INPUT_MAX_BYTES = 25 * 1024 * 1024;
export const geometryDocument = plan => Object.fromEntries(['levels','walls','openings','rooms','objects'].map(k=>[k,plan[k]]));

// The caller enforces project membership and Modeling workflow before reading the upload.
export async function processModelInput(operation, input, {run=spawnPlanner, retain}={}) {
  if(!['import-ifc','validate-scan'].includes(operation))fail('Unknown model operation.');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200)fail('Choose a file with a name of 1 to 200 characters.');
  if(typeof input.data!=='string'||!input.data.length||input.data.length>Math.ceil(MODEL_INPUT_MAX_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))fail('Send a file of at most 25 MB.');
  const bytes=Buffer.from(input.data,'base64');
  if(!bytes.length||bytes.length>MODEL_INPUT_MAX_BYTES)fail('Send a file of at most 25 MB.');
  const extension=input.name.toLowerCase().split('.').at(-1);
  if(operation==='import-ifc'&&(extension!=='ifc'||!bytes.subarray(0,256).toString().trimStart().startsWith('ISO-10303-21;')))fail('Choose an IFC STEP (.ifc) file.');
  let plan;
  if(operation==='validate-scan') {
    if(!['ply','las','laz','xyz'].includes(extension))fail('Choose a PLY, LAS, LAZ or XYZ point cloud.');
    if(!['m','mm','ft'].includes(input.units)||!Number.isFinite(input.tolerance)||input.tolerance<.001||input.tolerance>1)fail('Choose scan units and a tolerance between 1 and 1,000 mm.');
    try {plan=exportPlan(planFromJson(input.plan,{ref:'Current model'}));}catch(e){fail(e.message);}
    if(validatePlan(plan).some(x=>x.severity==='error'))fail('Fix the model errors before checking a scan.');
    if(!plan.walls.length)fail('Add walls before checking a scan.');
  }
  const directory=await mkdtemp(join(tmpdir(),'arosa-model-input-'));
  try {
    const inputPath=join(directory,`source.${extension}`);
    await writeFile(inputPath,bytes,{mode:0o600});
    let result;
    try {result=await run({operation,inputPath,name:input.name,extension,...(plan?{plan,units:input.units,tolerance:input.tolerance}:{})});}
    catch(error){throw Object.assign(error,{status:422});}
    if(operation==='import-ifc') {
      const imported=planFromJson(result.plan,{ref:input.name});
      imported.rooms=detectRooms(imported,{labels:[]});
      const drawing=await retain({bytes,name:input.name});
      imported.sources=[{kind:'ifc',ref:drawing.name,drawingId:drawing.id,sha256:drawing.sha256,omittedElements:result.report.omitted.length}];
      return {plan:exportPlan(imported),report:result.report,source:drawing};
    }
    return {...result,file:{name:input.name,sha256:hash(bytes),units:input.units},modelFingerprint:hash(JSON.stringify(geometryDocument(plan))),revision:plan.revision,checkedAt:new Date().toISOString()};
  } finally {await rm(directory,{recursive:true,force:true});}
}
