import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DOMParser} from 'linkedom';
import {sanitizeSvg,extractPrimitives,proposeFromPrimitives} from '../public/plan-intake.js';
import {planFromSvg} from '../../acres-research/architecture-tools.mjs';

const deps={DOMParser},wrap=body=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 130">${body}</svg>`;
const line=(attrs='',x=0)=>`<line x1="${x}" y1="0" x2="${x+10}" y2="0" stroke="#000" ${attrs}/>`;
const extract=body=>extractPrimitives(sanitizeSvg(wrap(body),deps).svg,deps);
const fixture=readFileSync(new URL('./fixtures/hidden-floorplan.svg',import.meta.url),'utf8');

test('sanitization preserves safe visibility controls from attributes and inline declarations',()=>{
  const clean=sanitizeSvg(wrap('<g display="none"><path visibility="hidden" d="M0 0L1 1"/></g><g style="display:none;visibility:collapse"/>'),deps);
  const root=new DOMParser().parseFromString(clean.svg,'image/svg+xml');
  assert.equal(root.querySelector('g').getAttribute('display'),'none');
  assert.equal(root.querySelector('path').getAttribute('visibility'),'hidden');
  assert.equal(root.querySelectorAll('g')[1].getAttribute('visibility'),'collapse');
  assert.ok(clean.removed.every(item=>!/display|visibility/.test(item)));
});

test('the editor proposal ignores the fixture hidden prior floor and its label',()=>{
  const primitives=extractPrimitives(sanitizeSvg(fixture,deps).svg,deps),proposal=proposeFromPrimitives(primitives);
  assert.equal(primitives.segments.length,4);assert.deepEqual(primitives.labels.map(row=>row.text),['Living room']);
  assert.ok(proposal.walls.every(wall=>[wall.a[0],wall.b[0]].every(x=>x<=110)));
});

test('the backend calibrated SVG trace uses the visible 10 by 6 room rather than the hidden square',()=>{
  const plan=planFromSvg(fixture,{widthMetres:10,name:'Living room',ref:'fixture:hidden'});
  const ys=plan.walls.flatMap(wall=>[wall.start[1],wall.end[1]]),xs=plan.walls.flatMap(wall=>[wall.start[0],wall.end[0]]);
  assert.equal(Math.max(...xs)-Math.min(...xs),10);assert.equal(Math.max(...ys)-Math.min(...ys),6);
});

test('display none excludes its whole subtree even when a child requests display inline',()=>{
  const result=extract(`<g display="none">${line('display="inline"')}<path d="M0 0Z10 10" stroke="#000"/></g>${line('',30)}`);
  assert.equal(result.segments.length,1);assert.deepEqual(result.segments[0].a,[30,0]);
});

test('visibility is inherited while a visible child can restore its own strokes',()=>{
  const result=extract(`<g visibility="hidden">${line()}${line('visibility="visible"',20)}</g>`);
  assert.equal(result.segments.length,1);assert.deepEqual(result.segments[0].a,[20,0]);
});

test('collapse and explicit inheritance stay hidden while initial visibility restores a child',()=>{
  const result=extract(`<g visibility="collapse">${line('visibility="inherit"')}${line('visibility="unset"',20)}${line('visibility="initial"',40)}</g>`);
  assert.equal(result.segments.length,1);assert.deepEqual(result.segments[0].a,[40,0]);
});

test('zero or clamped-negative group opacity cannot be undone by a child opacity',()=>{
  for(const opacity of ['0','0%','-1']){
    const result=extract(`<g opacity="${opacity}">${line('opacity="1"')}<text opacity="1">Hidden</text></g>`);
    assert.equal(result.segments.length,0);assert.equal(result.labels.length,0);
  }
});

test('a partly transparent stroke remains a trace candidate',()=>{
  const result=extract(`<g opacity=".01">${line('stroke-opacity=".1"')}</g>`);
  assert.equal(result.segments.length,1);
});

test('stroke opacity inherits independently and a child can restore a visible stroke',()=>{
  const result=extract(`<g stroke-opacity="0">${line()}${line('stroke-opacity="1"',20)}${line('stroke-opacity="inherit"',40)}</g>`);
  assert.equal(result.segments.length,1);assert.deepEqual(result.segments[0].a,[20,0]);
});

test('a zero-opacity fill cannot become the background and erase genuine black wall candidates',()=>{
  const result=extract(`<rect width="240" height="130" fill="#000" fill-opacity="0"/>${line()}`);
  assert.equal(result.background,null);assert.equal(proposeFromPrimitives(result).walls.length,1);
});

test('labels contain only painted text runs, including visible descendants of hidden text',()=>{
  const result=extract('<text x="5" y="5">Living<tspan display="none"> draft</tspan><tspan opacity="0"> old</tspan><tspan visibility="hidden"> hidden</tspan><tspan> room</tspan><desc>metadata</desc></text><text visibility="hidden"><tspan visibility="visible">Kitchen</tspan><tspan>old</tspan></text><text fill-opacity="0">Gone</text><text fill="none" stroke="#000" stroke-opacity="0">Gone</text><text fill="none" stroke="#000">Porch</text><text fill-opacity="0"><tspan fill-opacity="1">Sunroom</tspan></text>');
  assert.deepEqual(result.labels.map(label=>label.text),['Living room','Kitchen','Porch','Sunroom']);
});

test('inline important visibility survives normal later declarations and attribute ordering',()=>{
  for(const attrs of ['display="inline" style="display:none !important;display:inline"','style="display:none !important;display:inline" display="inline"','style="display:inline;display:none !important"','display="none" style="display: "']){
    const result=extract(`<g ${attrs}>${line()}</g>`);assert.equal(result.segments.length,0);
    assert.match(sanitizeSvg(wrap(`<g ${attrs}/>`),deps).svg,/display="none"/);
  }
});

test('the backend uses the same safe inline drawing styles and hidden-layer handling as the editor',()=>{
  const source=wrap('<g style="stroke:#000;stroke-width:1;fill:none"><rect x="10" y="10" width="100" height="60"/></g><g style="display:none;stroke:#000;stroke-width:8;fill:none"><rect x="130" y="10" width="100" height="100"/></g>');
  const plan=planFromSvg(source,{widthMetres:10,ref:'fixture:inline'}),ys=plan.walls.flatMap(wall=>[wall.start[1],wall.end[1]]);
  assert.equal(Math.max(...ys)-Math.min(...ys),6);
});

test('a drawing containing only hidden strokes cannot create a phantom plan',()=>{
  assert.throws(()=>planFromSvg(wrap(`<g visibility="hidden">${line()}</g>`),{widthMetres:10}),/No wall lines/);
});

test('an entirely hidden background does not change the visible foreground proposal',()=>{
  const result=extract(`<rect display="none" width="240" height="130" fill="#000"/>${line()}`);
  assert.equal(result.background,null);assert.equal(proposeFromPrimitives(result).walls.length,1);
});

test('visibility support keeps reference stripping and sanitizer idempotence intact',()=>{
  const source=wrap('<g display="none" onclick="alert(1)" style="visibility:hidden;fill:url(https://example.com/a)"><script>alert(1)</script><line stroke="#000" x2="10"/></g>');
  const clean=sanitizeSvg(source,deps),again=sanitizeSvg(clean.svg,deps);
  assert.equal(again.svg,clean.svg);assert.doesNotMatch(clean.svg,/onclick|script|https:|url\(/);
  assert.match(clean.svg,/display="none"/);assert.match(clean.svg,/visibility="hidden"/);
});
