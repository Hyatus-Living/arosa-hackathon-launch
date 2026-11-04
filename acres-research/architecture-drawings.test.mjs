import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {sniffDrawing,drawingName,fetchDrawing} from './architecture-drawings.mjs';

const alice='a'.repeat(24),bob='b'.repeat(24),carol='c'.repeat(24);
const sha=data=>createHash('sha256').update(data).digest('hex');
const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(64,1)]);
const JPEG=Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.alloc(64,2)]);
const SVG=Buffer.from('<?xml version="1.0"?>\n<!-- plan -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><line x1="0" y1="0" x2="100" y2="0" stroke="#000"/></svg>');
const PDF=Buffer.from('%PDF-1.7\n%stub\n');

const buildPlan=async(doc,{outDir})=>{
  const ifc=`ISO-10303-21;\n/* r${doc.revision} */\nEND-ISO-10303-21;\n`;
  writeFileSync(join(outDir,'model.ifc'),ifc);
  return {hasIfc:true,ifcSha256:sha(ifc)};
};
const plan={schema:'acres.architecture.plan/1',name:'Sample',units:'m',levels:[{id:'level-1',name:'Level 1',elevation:0,height:2.8}],
  walls:[{id:'w1',levelId:'level-1',start:[0,0],end:[4,0],thickness:0.18,height:2.8,material:'generic',roomIds:[]}],openings:[],rooms:[],objects:[],sources:[]};

async function open(t,{fetchDrawing:fetcher}={}){
  const dir=mkdtempSync(join(tmpdir(),'acres-drawings-'));
  const store=new ChatStore(join(dir,'chat.sqlite'));
  const server=createResearchServer({secrets:{RESEARCH_TOKEN:'test'},store,execute:async()=>({answer:'x',sources:[],ui:[]}),
    architecture:{stateDir:join(dir,'state'),buildPlan,worker:null,pipelineVersion:'test',...(fetcher?{fetchDrawing:fetcher}:{})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=(path,{method='GET',body,account=alice,headers={}}={})=>fetch(base+path,{method,headers:{authorization:'Bearer test','x-acres-account':account,...headers},...(body!==undefined?{body}:{})});
  t.after(async()=>{server.architectureJobs?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  const conversation=await (await api('/conversations',{method:'POST',body:'{}',headers:{'content-type':'application/json'}})).json();
  return {store,api,projectId:conversation.projectId,conversationId:conversation.id};
}
const upload=(api,projectId,bytes,{type='application/octet-stream',name,account}={})=>api(`/projects/${projectId}/architecture/drawings`,{method:'POST',body:bytes,account,headers:{'content-type':type,...(name?{'x-drawing-name':encodeURIComponent(name)}:{})}});

test('sniffDrawing reads the type from the bytes and drawingName keeps names printable',()=>{
  assert.equal(sniffDrawing(PNG),'png');
  assert.equal(sniffDrawing(JPEG),'jpeg');
  assert.equal(sniffDrawing(SVG),'svg');
  assert.equal(sniffDrawing(PDF),'pdf');
  assert.equal(sniffDrawing(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')),'webp');
  assert.equal(sniffDrawing(Buffer.from('<html><body>plan</body></html>')),null);
  assert.equal(drawingName('Unit 4B "plan".jpeg','jpeg'),'Unit 4B plan.jpg');
  assert.equal(drawingName('','pdf'),'drawing.pdf');
  assert.equal(drawingName('unit-4b.pascal.json','pascal-scene'),'unit-4b.pascal.json','an edited scene keeps one .pascal.json');
  assert.equal(drawingName('../../etc/passwd','svg'),'....etcpasswd.svg');
});

test('uploaded drawings are stored, listed, served with their sniffed type and announced',async t=>{
  const {api,store,projectId}=await open(t);
  const created=await upload(api,projectId,PNG,{type:'image/svg+xml',name:'Unit 4B plan.png'});
  assert.equal(created.status,201);
  const drawing=await created.json();
  assert.deepEqual({kind:drawing.kind,contentType:drawing.contentType,bytes:drawing.bytes,sha256:drawing.sha256,name:drawing.name,by:drawing.by,createdBy:drawing.createdBy,sourceUrl:drawing.sourceUrl},
    {kind:'png',contentType:'image/png',bytes:PNG.length,sha256:sha(PNG),name:'Unit 4B plan.png',by:'user',createdBy:alice,sourceUrl:null});
  await upload(api,projectId,SVG,{name:'floor.svg'});
  const list=await (await api(`/projects/${projectId}/architecture/drawings`)).json();
  assert.deepEqual(list.drawings.map(d=>d.kind),['svg','png'],'newest first');
  const served=await api(`/projects/${projectId}/architecture/drawings/${drawing.id}`);
  assert.equal(served.status,200);
  assert.equal(served.headers.get('content-type'),'image/png');
  assert.equal(served.headers.get('etag'),`"${sha(PNG)}"`);
  assert.match(served.headers.get('content-security-policy'),/sandbox/);
  assert.equal(served.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()),PNG);
  assert.equal((await api(`/projects/${projectId}/architecture/drawings/${drawing.id}`,{headers:{'if-none-match':`"${sha(PNG)}"`}})).status,304);
  const events=store.projectEvents(projectId).filter(e=>e.event==='architecture.drawing');
  assert.deepEqual(events.map(e=>({drawingId:e.drawingId,kind:e.kind,by:e.by,projectId:e.projectId})),
    [{drawingId:drawing.id,kind:'png',by:'user',projectId},{drawingId:list.drawings[0].id,kind:'svg',by:'user',projectId}]);
});

test('a drawing named outside ASCII is still served, with an ASCII fallback name',async t=>{
  const {api,projectId}=await open(t);
  const {id}=await (await upload(api,projectId,PNG,{name:'Façade plan.png'})).json();
  const served=await api(`/projects/${projectId}/architecture/drawings/${id}`);
  assert.equal(served.status,200);
  assert.equal(served.headers.get('content-disposition'),`inline; filename="Fa_ade plan.png"; filename*=UTF-8''${encodeURIComponent('Façade plan.png')}`);
});

test('drawing uploads enforce the type and per-type size limits',async t=>{
  const {api,projectId}=await open(t);
  const html=await upload(api,projectId,Buffer.from('<html>not a plan</html>'));
  assert.equal(html.status,415);
  const bigSvg=Buffer.concat([SVG,Buffer.alloc(2*1024*1024,32)]);
  assert.equal((await upload(api,projectId,bigSvg)).status,413);
  const bigPng=Buffer.concat([PNG,Buffer.alloc(15*1024*1024)]);
  assert.equal((await upload(api,projectId,bigPng)).status,413);
  const okPdf=Buffer.concat([PDF,Buffer.alloc(16*1024*1024)]);
  assert.equal((await upload(api,projectId,okPdf)).status,201,'a PDF may be up to 25 MB');
  const overAll=Buffer.concat([PDF,Buffer.alloc(25*1024*1024)]);
  assert.equal((await upload(api,projectId,overAll)).status,413);
});

test('drawings are account scoped: strangers see nothing and viewers cannot add',async t=>{
  const {api,store,projectId,conversationId}=await open(t);
  const {id}=await (await upload(api,projectId,PNG)).json();
  assert.equal((await api(`/projects/${projectId}/architecture/drawings`,{account:bob})).status,404);
  assert.equal((await api(`/projects/${projectId}/architecture/drawings/${id}`,{account:bob})).status,404);
  assert.equal((await upload(api,projectId,PNG,{account:bob})).status,404);
  store.grantMember(alice,conversationId,'account',carol,'viewer');
  assert.equal((await api(`/projects/${projectId}/architecture/drawings`,{account:carol})).status,200);
  assert.equal((await upload(api,projectId,PNG,{account:carol})).status,403);
  assert.equal((await api(`/projects/${projectId}/architecture/drawings/not-a-uuid`)).status,404);
});

test('a drawing can be attached by URL; the service fetches it and records where it came from',async t=>{
  const seen=[];
  const fetcher=async url=>{seen.push(url);return {bytes:JPEG,finalUrl:'https://cdn.example.com/plans/4b.jpg',contentType:'image/jpeg'};};
  const {api,projectId}=await open(t,{fetchDrawing:fetcher});
  const response=await api(`/projects/${projectId}/architecture/drawings`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com/listing/4b-plan'})});
  assert.equal(response.status,201);
  const drawing=await response.json();
  assert.deepEqual(seen,['https://example.com/listing/4b-plan']);
  assert.deepEqual({kind:drawing.kind,name:drawing.name,sourceUrl:drawing.sourceUrl},{kind:'jpeg',name:'4b.jpg',sourceUrl:'https://cdn.example.com/plans/4b.jpg'});
});

test('fetchDrawing only reads public HTTPS addresses and re-checks every redirect',async()=>{
  const lookup=async host=>[{address:host==='internal.example.com'?'10.0.0.5':'93.184.216.34'}];
  const response=(status,headers={},body=[])=>({status,ok:status>=200&&status<300,headers:new Headers(headers),body});
  await assert.rejects(fetchDrawing('http://example.com/a.png',{lookup,request:async()=>response(200)}),/public https/);
  await assert.rejects(fetchDrawing('https://127.0.0.1/a.png',{lookup,request:async()=>response(200)}),/public https/);
  await assert.rejects(fetchDrawing('https://internal.example.com/a.png',{lookup,request:async()=>response(200)}),/private/);
  const hops=[];
  const request=async url=>{hops.push(url);return url.endsWith('/start')?response(302,{location:'https://internal.example.com/x'}):url.endsWith('/nowhere')?response(302):response(200,{'content-type':'image/png'},[PNG]);};
  await assert.rejects(fetchDrawing('https://example.com/nowhere',{lookup,request}),/redirects/);
  await assert.rejects(fetchDrawing('https://example.com/plan.png',{lookup,request,allow:()=>false}),/not a usable/);
  hops.length=0;
  await assert.rejects(fetchDrawing('https://example.com/start',{lookup,request}),/private/);
  assert.deepEqual(hops,['https://example.com/start']);
  const ok=await fetchDrawing('https://example.com/plan.png',{lookup,request});
  assert.deepEqual(ok.bytes,PNG);
  assert.equal(ok.contentType,'image/png');
  const huge={[Symbol.asyncIterator]:async function*(){for(let i=0;i<27;i++)yield Buffer.alloc(1024*1024);}};
  await assert.rejects(fetchDrawing('https://example.com/huge.pdf',{lookup,request:async()=>response(200,{},huge)}),/25 MB/);
});

test('saving a plan through PUT announces the revision as the user\'s',async t=>{
  const {api,store,projectId}=await open(t);
  const put=body=>api(`/projects/${projectId}/architecture/plan`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await put({parentRevision:null,plan})).status,201);
  assert.equal((await put({parentRevision:1,plan})).status,201);
  const revisions=store.projectEvents(projectId).filter(e=>e.event==='architecture.revision');
  assert.deepEqual(revisions.map(({revision,parentRevision,by,projectId:p})=>({revision,parentRevision,by,p})),
    [{revision:1,parentRevision:null,by:'user',p:projectId},{revision:2,parentRevision:1,by:'user',p:projectId}]);
});
