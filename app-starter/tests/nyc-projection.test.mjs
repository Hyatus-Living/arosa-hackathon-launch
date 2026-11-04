import test from 'node:test';
import assert from 'node:assert/strict';
import {projectNyc,MAP_FRAME} from '../public/deal-map.js';
import {NYC_BOROUGHS} from '../public/nyc-boroughs.js';

// Ray casting on projected coordinates, independent of the map that draws them.
const inRing=([x,y],ring)=>{let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j];if((yi>y)!==(yj>y)&&x<((xj-xi)*(y-yi))/(yj-yi)+xi)hit=!hit;}return hit;};
const boroughAt=(lat,lon)=>{
  const {x,y}=projectNyc(lat,lon);
  const projected=(ring)=>ring.map(([rlon,rlat])=>{const p=projectNyc(rlat,rlon);return [p.x,p.y];});
  return NYC_BOROUGHS.filter((b)=>b.rings.some((ring)=>inRing([x,y],projected(ring)))).map((b)=>b.name);
};

test('the drawn city is north up at one ground scale, and each borough outline holds its own places',()=>{
  const a=projectNyc(40.7,-74.0),north=projectNyc(40.8,-74.0),east=projectNyc(40.7,-73.9);
  assert.ok(north.y<a.y&&east.x>a.x);
  assert.ok(Math.abs((east.x-a.x)/(a.y-north.y)-Math.cos((40.7*Math.PI)/180))<0.02,'a degree of longitude is shorter than a degree of latitude');
  for(const [lat,lon] of [[40.4774,-74.2591],[40.9176,-73.7004]]){const p=projectNyc(lat,lon);assert.ok(p.x>=0&&p.x<=MAP_FRAME.width&&p.y>=0&&p.y<=MAP_FRAME.height,'the five boroughs fit the frame');}
  assert.deepEqual(boroughAt(40.7484,-73.9857),['Manhattan']);
  assert.deepEqual(boroughAt(40.6602,-73.9690),['Brooklyn']);
  assert.deepEqual(boroughAt(40.7580,-73.8303),['Queens']);
  assert.deepEqual(boroughAt(40.8448,-73.8648),['Bronx']);
  assert.deepEqual(boroughAt(40.5795,-74.1502),['Staten Island']);
  assert.deepEqual(boroughAt(40.5560,-73.9280),['Queens'],'Breezy Point is on the Rockaway peninsula');
  assert.deepEqual(boroughAt(40.5776,-73.9389),['Brooklyn'],'Manhattan Beach stays in Brooklyn');
  assert.deepEqual(boroughAt(40.7178,-74.0431),[],'Jersey City is outside the five boroughs');
});
