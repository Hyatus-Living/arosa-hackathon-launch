import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {resolveAccount,isArchitectureEnabled} from '../auth.js';

const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
function routes(){
  const registered=new Map(),middleware=[],calls=[];
  const app={use:(paths,handler)=>middleware.push({paths,handler})};
  for(const method of ['all','get','post','patch','put','delete'])app[method]=(path,handler)=>registered.set(`${method} ${path}`,handler);
  const context=vm.createContext({app,resolveAccount,isArchitectureEnabled:email=>isArchitectureEnabled(email,'true','@allowed.example.com'),proxy:(req,res,path,body)=>calls.push({path,body}),isAdminEmail:()=>false});
  const guards=source.split('\n').filter(line=>line.startsWith("app.use(['/api/conversations/:id'")||line.startsWith("app.use(['/api/projects/:id/architecture'"));
  assert.equal(guards.length,2);
  vm.runInContext(guards.join('\n')+'\n'+source.slice(source.indexOf("app.all('/api/conversations'"),source.indexOf('const architecturePath=')),context);
  const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}});
  return {registered,middleware,calls,response};
}
const id='a'.repeat(8)+'-'+('b'.repeat(4)+'-').repeat(3)+'c'.repeat(12);

test('proxy identifiers cannot rewrite backend paths, and run actions are bounded',()=>{
  const f=routes(),guard=f.middleware[0].handler;
  for(const decoded of ['../people','x/../../people?q=','..','x?query=value','x#fragment']){
    const res=f.response();let admitted=false;guard({params:{id:decoded}},res,()=>{admitted=true;});
    assert.equal(res.statusCode,404);assert.equal(admitted,false);
  }
  let admitted=false;guard({params:{id}},f.response(),()=>{admitted=true;});assert.equal(admitted,true);
  for(const route of ['all /api/conversations/:id','post /api/conversations/:id/runs','get /api/runs/:id','get /api/runs/:id/status','get /api/runs/:id/events']){
    const handler=f.registered.get(route);
    handler({params:{id},body:{message:'Research'},query:{},get:()=>null},f.response());
    assert.ok(f.calls.at(-1).path.includes(id));
    handler({params:{id:'../people?x'},body:{message:'Research'},query:{},get:()=>null},f.response());
    const path=f.calls.at(-1).path;
    assert.ok(path.includes('..%2Fpeople%3Fx'));assert.ok(new URL(path,'https://unit.test').pathname.includes('%2Fpeople%3Fx'));
  }
  const action=f.registered.get('post /api/runs/:id/:action');
  for(const value of ['..','../people','steer?x','unknown']){
    const before=f.calls.length,res=f.response();action({params:{id,action:value},body:{}},res);
    assert.equal(res.statusCode,404);assert.equal(f.calls.length,before);
  }
  for(const value of ['steer','interrupt']){action({params:{id,action:value},body:{message:'Question'}},f.response());assert.equal(f.calls.at(-1).path,`/runs/${id}/${value}`);}
});

test('email invitations resolve the account from the email, preserving linked account resolution',()=>{
  const f=routes();
  for(const route of ['all /api/conversations/:id/members','all /api/teams/:id/members']){
    const handler=f.registered.get(route);
    handler({method:'POST',params:{id},body:{email:' New@Example.com ',account:'victim',principal:'victim',principalType:'account',role:'viewer'}},f.response());
    assert.equal(f.calls.at(-1).body.account,resolveAccount('new@example.com'));
    assert.equal(f.calls.at(-1).body.principal,undefined);assert.equal(f.calls.at(-1).body.email,'new@example.com');
    handler({method:'POST',params:{id},body:{account:'known-account',role:'viewer'}},f.response());
    assert.equal(f.calls.at(-1).body.account,'known-account');
  }
});

test('architecture middleware gates model intake, plans, drawings, artifacts and renders before forwarding',()=>{
  const f=routes(),{paths,handler}=f.middleware[1];
  assert.deepEqual(Array.from(paths),['/api/projects/:id/architecture','/api/projects/:id/schemes/:schemeId/render']);
  for(const email of [undefined,'outsider@example.com']){
    let admitted=false;const res=f.response();handler({email},res,()=>{admitted=true;});
    assert.equal(res.statusCode,404);assert.equal(admitted,false);
  }
  let admitted=false;handler({email:'member@allowed.example.com'},f.response(),()=>{admitted=true;});assert.equal(admitted,true);
  assert.ok(source.indexOf("app.use(['/api/projects/:id/architecture'")<source.indexOf('mountModelInputProxy(app,proxy)'));
});
