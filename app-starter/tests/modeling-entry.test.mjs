import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {parseRoute,needsUnderwritingSetup} from '../public/core-route.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf("$('#modeling-nav').hidden");
const boot=source.slice(start,source.indexOf('const storeKey',start));

test('production boot exposes Modeling on Home and does not require financial setup for model routes',async()=>{
  for(const [path,allowed,expected] of [['/',true,1],['/modeling',true,0],['/modeling/example',true,0],['/sites/example/plan',true,0],['/sites/example',true,1],['/modeling',false,1],['/modeling',null,0]]){
    const {document}=parseHTML('<a id="modeling-nav" hidden></a>');let calls=0;
    const result=await vm.runInNewContext(`(async()=>{${boot};return {modelingBoot,underwritingBoot};})()`,{
      $:selector=>document.querySelector(selector),session:allowed===null?null:{architectureEnabled:allowed},
      window:{location:{pathname:path}},parseRoute,needsUnderwritingSetup,settingsRequest:Promise.resolve({}),
      ensureDeveloperCosts:async(response,modelingAvailable)=>{calls++;assert.equal(modelingAvailable,allowed);return {costsConfirmed:true};},
    });
    assert.equal(calls,expected,path);
    assert.equal(document.querySelector('#modeling-nav').hidden,allowed!==true,path);
    assert.equal(result.modelingBoot,allowed===true&&expected===0,path);
  }
});

test('leaving a Modeling-only boot checks Underwriting setup through a normal page load',()=>{
  const navigate=source.slice(source.indexOf('function navigate('),source.indexOf('function applyRoute('));
  const calls=[];
  const context={modelingBoot:true,session:{architectureEnabled:true},parseRoute,needsUnderwritingSetup,
    window:{location:{assign:path=>calls.push(['assign',path]),replace:path=>calls.push(['replace',path])}}};
  vm.runInNewContext(`${navigate};navigate('/sites');navigate('/sites/example',null,{replace:true});`,context);
  assert.deepEqual(calls,[['assign','/sites'],['replace','/sites/example']]);
});
