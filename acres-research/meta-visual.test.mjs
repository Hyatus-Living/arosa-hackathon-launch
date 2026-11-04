import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {segmentHousingPhoto,illustrateHousing} from './meta-visual.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const emptyStream=()=>new Response('data: {"type":"response.output_text.done","item_id":"m1","output_index":0,"content_index":0,"text":""}\n\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',{status:200});

test('SAM accepts an image and returns an honest empty result when nothing matches',async()=>{
  let sent;
  const result=await segmentHousingPhoto({photo:png,subject:'building'},{key:'test',fetcher:async(url,init)=>{sent={url,body:JSON.parse(init.body)};return emptyStream();}});
  assert.deepEqual(result.masks,[]);assert.equal(sent.body.model,'sam-3.1');assert.equal(sent.body.store,false);assert.equal(sent.body.input[0].content[0].text,'building');assert.equal(sent.body.input[0].content[1].image_url,png);
});

test('SAM point corrections use source image coordinates',async()=>{
  let sent;
  await segmentHousingPhoto({photo:png,size:{width:100,height:80},points:[{x:20,y:30,label:'positive'},{x:40,y:50,label:'negative'}]},{key:'test',fetcher:async(_url,init)=>{sent=JSON.parse(init.body);return emptyStream();}});
  assert.match(sent.input[0].content[0].text,/<\|point;x=20;y=30;w=100;h=80\|>/);
  assert.match(sent.input[0].content[0].text,/-<\|point;x=40;y=50;w=100;h=80\|>/);
});

test('Muse Image receives both references, the chosen housing use and no web tools',async()=>{
  let sent;
  const result=await illustrateHousing({photo:png,modelImage:png,goal:'adu',note:'A small garden home.'},{key:'test',fetcher:async(url,init)=>{sent={url,body:JSON.parse(init.body)};return Response.json({data:[{b64_json:png.split(',')[1]}]});}});
  assert.equal(sent.url,'https://api.meta.ai/v1/images/edits');assert.equal(sent.body.model,'muse-image-1.0');assert.equal(sent.body.images.length,2);assert.match(sent.body.prompt,/accessory dwelling unit/);assert.deepEqual(sent.body.tool_enablement,{enable_image_search:false,enable_web_search:false,enable_shell:false});assert.equal(result.image,png);assert.equal(result.photoSha256,result.modelImageSha256);
});

test('selected regions are passed as an annotated reference to guide Muse Image',async()=>{
  let sent;
  await illustrateHousing({photo:png,modelImage:png,selectionImage:png,goal:'adu'},{key:'test',fetcher:async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({data:[{b64_json:png.split(',')[1]}]});}});
  assert.equal(sent.images.length,3);assert.equal(sent.images[2].image_url,png);
  assert.match(sent.prompt,/green translucent highlights/);assert.match(sent.prompt,/Do not reproduce the green highlights/);
});

test('illustration provenance records every input and the generated image',async()=>{
  const pngSha256=createHash('sha256').update(Buffer.from(png.split(',')[1],'base64')).digest('hex');
  const fetcher=async()=>Response.json({data:[{b64_json:png.split(',')[1]}]});
  const plain=await illustrateHousing({photo:png,modelImage:png,goal:'adu'},{key:'test',fetcher});
  assert.deepEqual(plain.provenance,{model:'muse-image-1.0',goal:'adu',photoSha256:pngSha256,modelImageSha256:pngSha256,selectionImageSha256:null,imageSha256:pngSha256});
  const guided=await illustrateHousing({photo:png,modelImage:png,selectionImage:png,goal:'adu'},{key:'test',fetcher});
  assert.equal(guided.provenance.selectionImageSha256,pngSha256);
});

test('invalid images, unsupported goals and unconfigured providers fail before a request',async()=>{
  let calls=0;const fetcher=async()=>{calls++;throw new Error('unexpected request');};
  await assert.rejects(segmentHousingPhoto({photo:'data:image/png;base64,YWJj',subject:'building'},{key:'test',fetcher}),/invalid/);
  await assert.rejects(illustrateHousing({photo:png,modelImage:png,goal:'skyscraper'},{key:'test',fetcher}),/project type/);
  await assert.rejects(segmentHousingPhoto({photo:png,subject:'building'},{fetcher}),/not configured/);
  assert.equal(calls,0);
});
