import test from 'node:test';
import assert from 'node:assert/strict';
import {poolFixture,compatibilityFixture} from './testing/comparable-pool.mjs';

test('a deal page streams the entire peer pool once and preserves every per-subject ranking',t=>{
  const f=poolFixture(t,1600);
  for(let i=0;i<14;i++)f.add(`page-${i}`,{listPrice:1200000,lastSeen:i});
  const page=f.store.searchDealsPage({limit:15,includeSimilarComps:false});
  const expected=new Map(page.deals.map(deal=>[deal.id,f.store.getSimilarCompsForDeal(deal.id)]));
  let scans=0,visits=0;
  const prepare=f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare=sql=>{
    const statement=prepare(sql);
    if(!sql.includes('candidate_order'))return statement;
    scans++;assert.doesNotMatch(sql,/\bLIMIT\b/i);
    return {iterate:function*(...args){for(const row of statement.iterate(...args)){visits++;yield row;}}};
  };
  const actual=f.store.searchDealsPage({limit:15});
  assert.equal(actual.deals.length,15);assert.equal(scans,1);assert.ok(visits>1600);
  assert.equal(visits,f.store.one('SELECT count(*) n FROM market_listings').n);
  for(const deal of actual.deals)assert.deepEqual(deal.similarComps,expected.get(deal.id));
});

test('shared scans preserve mixed ZIP and borough scopes, nulls, and subject aliases',t=>{
  const f=compatibilityFixture(t),other=f.add('queens',{listPrice:1200000}),zipOnly=f.add('zip-only',{listPrice:1200000});
  f.store.write("UPDATE market_listings SET zip_code='11350',borough='QN' WHERE id=?",other);
  f.store.write("UPDATE market_listings SET borough=NULL WHERE id=?",zipOnly);
  const subjects=[f.subject(),f.store.one('SELECT * FROM market_listings WHERE id=?',other),f.store.one('SELECT * FROM market_listings WHERE id=?',zipOnly),{...f.subject(),id:'without-scope',bbl:null,property_id:null,zip_code:null,borough:null}];
  const expected=subjects.map(s=>f.store.getSimilarCompsForDeal(s,{limit:15}));
  const together=f.store.getSimilarCompsForDeals(subjects,{limit:15});
  subjects.forEach((s,i)=>assert.deepEqual(together.get(s),expected[i]));
  assert.ok(together.get(subjects[2]).every(comp=>comp.zipCode==='11201'));
});
