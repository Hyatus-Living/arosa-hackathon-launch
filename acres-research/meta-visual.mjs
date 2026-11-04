import {createHash} from 'node:crypto';
import {parseImageStream,recordsOfKind,decodeMaskToRaster,buildObjectPrompt} from '@meta-sam/parser';
import {sniffDrawing} from './architecture-drawings.mjs';
import {streamEvents} from './meta.mjs';

const MAX_IMAGE_BYTES=5*1024*1024;
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
const goals={adu:'a small accessory dwelling unit or backyard cottage',addition:'a modest addition to the existing home',infill:'a small residential infill building'};

function imageData(value,maxBytes=MAX_IMAGE_BYTES) {
  if(typeof value!=='string')throw bad('Choose a PNG, JPEG or WebP image.');
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if(!match||match[2].length>Math.ceil(maxBytes/3)*4)throw bad('Choose a valid PNG, JPEG or WebP image.');
  const bytes=Buffer.from(match[2],'base64');
  if(!bytes.length||bytes.length>maxBytes||bytes.toString('base64')!==match[2]||`image/${sniffDrawing(bytes)}`!==match[1])throw bad('The image is invalid or too large.');
  return {url:value,sha256:createHash('sha256').update(bytes).digest('hex')};
}
async function request(path,body,key,fetcher,signal) {
  if(!key)throw bad('Meta image tools are not configured.',503);
  const response=await fetcher(`https://api.meta.ai/v1/${path}`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(180000)])});
  if(!response.ok)throw bad(`Meta image tools returned HTTP ${response.status}.`,502);
  return response;
}
export async function segmentHousingPhoto(input,{key,fetcher=fetch,signal=new AbortController().signal}={}) {
  const photo=imageData(input.photo);
  let subject=typeof input.subject==='string'?input.subject.trim():'';
  if(input.points!==undefined) {
    if(!Array.isArray(input.points)||!input.points.length||input.points.length>30)throw bad('Mark up to 30 points on the photo.');
    try{subject=buildObjectPrompt({size:input.size,objects:[{id:1,prompts:[{frame:0,points:input.points}]}]});}
    catch{throw bad('The photo selection points are invalid.');}
  } else if(!subject||subject.length>80||/[\r\n<>]/.test(subject))throw bad('Enter a short object name to select.');
  const response=await request('responses',{model:'sam-3.1',stream:true,store:false,metadata:{mask_encoding:'one_bit',include_confidence:'true'},input:[{role:'user',content:[{type:'input_text',text:subject},{type:'input_image',image_url:photo.url}]}]},key,fetcher,signal);
  const result=await parseImageStream(streamEvents(response.body)).finalResult;
  if(result.outcome.status!=='completed'||result.diagnostics.some(d=>d.severity==='error'))throw bad('The photo could not be segmented. Try another image.',502);
  let totalPixels=0;
  const records=recordsOfKind(result.records,'mask');
  if(records.length>30)throw bad('Too many objects were found. Try a more specific description.',413);
  const masks=records.map(record=>{
    const {width,height}=record.mask;
    totalPixels+=width*height;
    if(width*height>16_000_000||totalPixels>24_000_000)throw bad('The selected image is too large to segment.',413);
    return {id:record.objectId,width,height,bounds:record.bounds,confidence:record.confidence??null,pixels:Buffer.from(decodeMaskToRaster(record.mask)).toString('base64')};
  });
  return {photoSha256:photo.sha256,masks};
}
export async function illustrateHousing(input,{key,fetcher=fetch,signal=new AbortController().signal}={}) {
  const photo=imageData(input.photo),model=imageData(input.modelImage);
  const selection=input.selectionImage?imageData(input.selectionImage):null;
  const goal=goals[input.goal];
  if(!goal)throw bad('Choose a housing project type.');
  const note=typeof input.note==='string'?input.note.trim():'';
  if(note.length>500)throw bad('Keep the design description under 500 characters.');
  const prompt=`Create a conceptual architectural visualization of ${goal}. The first image is the existing site and the second is the proposed 3D massing reference. Keep the proposed building's overall massing close to the second image, and place it plausibly in the first image. ${selection?'The third image repeats the site with green translucent highlights showing the user-selected regions. Use those regions to guide where the proposed changes relate to the site. Do not reproduce the green highlights.':''} Do not add text or claims of approvals. ${note}`;
  const images=[{image_url:photo.url},{image_url:model.url},...(selection?[{image_url:selection.url}]:[])];
  const response=await request('images/edits',{model:'muse-image-1.0',prompt,images,n:1,output_format:'png',tool_enablement:{enable_image_search:false,enable_web_search:false,enable_shell:false}},key,fetcher,signal);
  const result=await response.json(),base64=result.data?.[0]?.b64_json;
  let image;
  try{image=imageData(`data:image/png;base64,${base64}`,15*1024*1024);}catch{throw bad('Meta returned an invalid illustration.',502);}
  // Provenance travels with the illustration so a saved copy can be tied back to the
  // exact photo, model view and selection that produced it.
  const provenance={model:'muse-image-1.0',goal:input.goal,photoSha256:photo.sha256,modelImageSha256:model.sha256,selectionImageSha256:selection?.sha256??null,imageSha256:image.sha256};
  return {image:image.url,photoSha256:photo.sha256,modelImageSha256:model.sha256,goal:input.goal,provenance};
}
