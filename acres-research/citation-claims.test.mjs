import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCitations} from './lanes.mjs';

test('ISO dates are not mistaken for statutory sections',()=>{
  const deed=[{id:1,title:'Property deed',text:'The property deed was recorded by the city register on February 16, 2010.'}];
  assert.doesNotThrow(()=>validateCitations('The property deed was recorded on 2010-02-16 [1].',deed));
  assert.throws(()=>validateCitations('The property deed was recorded under ZR 23-22 [1].',deed),/statutory section/);
});

const sources=[
  {id:1,title:'NYC Planning PLUTO parcel records',url:'https://data.cityofnewyork.us/resource/64uk-42ks.json',text:JSON.stringify([{bbl:'5012340001',zonedist1:'R2',bldgclass:'V0',numbldgs:'0',lotarea:'83200'}])},
  {id:2,title:'Zoning Resolution 23-22 floor area for qualifying residential sites',url:'https://zr.planning.nyc.gov/article-ii/chapter-3/23-22',text:'A qualifying residential site in R1 and R2 districts may use a floor area ratio of 1.0 where the transit eligibility route applies; the ordinary transit route excludes R1 and R2 districts.'},
];

test('a citation written after the full stop belongs to the sentence it follows',()=>{
  const answer='Conversion is excluded from the current model because PLUTO records a vacant parcel with numbldgs 0. [1] These possibilities contribute no acquisition value in this underwriting.';
  assert.doesNotThrow(()=>validateCitations(answer,sources));
  assert.throws(()=>validateCitations('Rents average forty dollars per foot along the corridor. [1] Nothing else follows.',sources),/does not support the claim/);
});

test('a citation closing a paragraph or table cell covers the reasons before its conclusion',()=>{
  const answer=[
    '| Route | Finding |',
    '| Qualifying residential site | The separate 1.0-FAR route would calculate to 83,200 ZFA, but eligibility remains unsupported. The ordinary transit route excludes R2. **No uplift credited.** [1][2] |',
    'Standard R2 zoning applies to the whole lot. **No subdivision yield credited.** [2]',
  ].join('\n');
  assert.doesNotThrow(()=>validateCitations(answer,sources));
});

test('an unrelated citation is still rejected and names the rejected sentence',()=>{
  const answer='The lot sits in an R2 district [1].\nComparable condominiums sold quickly near the waterfront promenade. [2]';
  assert.throws(()=>validateCitations(answer,sources),error=>{
    assert.equal(error.code,'UNSUPPORTED_CITATION');
    assert.equal(error.claim,'Comparable condominiums sold quickly near the waterfront promenade.');
    assert.deepEqual(error.sourceIds,[2]);
    return true;
  });
  // A paragraph's reasons do not carry across a line break into a separate conclusion.
  assert.throws(()=>validateCitations('The ordinary transit route excludes R2 districts.\n**No uplift credited.** [2]',sources),/does not support the claim/);
});

test('a longer claim needs its own words in the cited text, not one shared topic word',()=>{
  // Right topic, wrong fact: the source is about R2 floor area, the claim only borrows "districts".
  assert.throws(()=>validateCitations('R2 districts allow commercial office towers with rooftop helipads. [2]',sources),error=>error.code==='UNSUPPORTED_CITATION');
  assert.throws(()=>validateCitations('The ground lease on the parcel expires with a renewal option for the tenant. [1]',sources),/does not support the claim/);
  // A paraphrase that keeps most of the source's own words is supported.
  assert.doesNotThrow(()=>validateCitations('The ordinary transit route excludes R1 and R2 districts, so qualifying residential sites need the eligibility route. [2]',sources));
  // A conclusion of three words or fewer still leans on the reasons before it.
  assert.doesNotThrow(()=>validateCitations('The ordinary transit route excludes R2. **No uplift credited.** [2]',sources));
});

test('every unsupported cited sentence is reported at once, with the first as the error',()=>{
  const answer='Rents average forty dollars per foot along the corridor. [1] The parcel is zoned R2 with 83,200 square feet of lot area. [1] Condominiums sold quickly near the waterfront promenade. [2]';
  const error=(()=>{try{validateCitations(answer,sources);}catch(e){return e;}})();
  assert.equal(error.code,'UNSUPPORTED_CITATION');
  assert.equal(error.claim,'Rents average forty dollars per foot along the corridor.');
  assert.deepEqual(error.failures.map(f=>f.claim),['Rents average forty dollars per foot along the corridor.','Condominiums sold quickly near the waterfront promenade.']);
  assert.deepEqual(error.failures.map(f=>f.sourceIds),[[1],[2]]);
});

test('after a failed repair, word-only sentences citing sources that lack their terms lose only their brackets',async()=>{
  const {withoutUnsupportedCitations}=await import('./lanes.mjs');
  const answer=[
    'The parcel is zoned R2 with 83,200 square feet of lot area [1]. Physical layout and approvals still constrain the count [2].',
    '| Item | Note |',
    '| Delivery | The listing alone does not verify delivery. [1] Ask the broker. |',
  ].join('\n');
  const out=withoutUnsupportedCitations(answer,sources);
  assert.deepEqual(out.answer.split('\n'),[
    'The parcel is zoned R2 with 83,200 square feet of lot area [1]. Physical layout and approvals still constrain the count.',
    '| Item | Note |',
    '| Delivery | The listing alone does not verify delivery. Ask the broker. |',
  ]);
  assert.equal(out.dropped.length,2);
  assert.doesNotThrow(()=>validateCitations(out.answer,sources));
  assert.equal(withoutUnsupportedCitations('Rents average forty dollars per foot along the corridor [1].',sources),null,'an answer is never left with no citations at all');
  assert.equal(withoutUnsupportedCitations('Rents average 40 dollars per foot along the corridor [1].',sources),null,'a sentence with a figure is never left uncited');
  assert.deepEqual(withoutUnsupportedCitations('The parcel is zoned R2 [1].',sources),{answer:'The parcel is zoned R2 [1].',dropped:[],figureSupported:[],removed:[]});
  // A figure sentence keeps its citation when the cited source states every figure in it.
  const figure='The listing records a lot of 83,200 square feet beside the promenade walkway gardens [1]. Physical layout and approvals still constrain the count [2].';
  const kept=withoutUnsupportedCitations(figure,sources);
  assert.equal(kept.answer,'The listing records a lot of 83,200 square feet beside the promenade walkway gardens [1]. Physical layout and approvals still constrain the count.');
  assert.deepEqual(kept.figureSupported,['The listing records a lot of 83,200 square feet beside the promenade walkway gardens.']);
  assert.equal(withoutUnsupportedCitations('The listing records a lot of 83,300 square feet beside the promenade walkway gardens [1].',sources),null,'a lone figure the source does not state leaves nothing cited');
});

test('a Queens house number is an address, not a Zoning Resolution section',()=>{
  const queens=[{id:1,title:'HPD Certification of No Harassment pilot list, Queens',url:'https://www.nyc.gov/hpd/conh',text:'Queens addresses on the pilot list: 25-21 94 Street, 41-12 Main Street. Updated September 24, 2026.'}];
  assert.doesNotThrow(()=>validateCitations('The Queens pilot list, updated September 24, 2026, contains no 32-10 31 Avenue entry [1].',queens));
  assert.doesNotThrow(()=>validateCitations('The Queens pilot list names 41-12 Main Street, updated September 24, 2026 [1].',queens));
  assert.throws(()=>validateCitations('The Queens pilot list applies under ZR 23-21 since September 24, 2026 [1].',queens),/statutory section/);
});

// An HPD registration record as the registrations source returns it: dates in ISO form.
const hpd=[...sources,{id:3,title:'HPD multiple dwelling registrations, BBL 4004870001',url:'https://data.cityofnewyork.us/resource/tesw-yqqr.json',text:JSON.stringify([{registrationid:'412345',lastregistrationdate:'2025-08-14T00:00:00.000',registrationenddate:'2026-09-01T00:00:00.000'}])}];

test('a date written out in words is the same figure as the record date',async()=>{
  const {withoutUnsupportedCitations}=await import('./lanes.mjs');
  for(const date of ['September 1, 2026','Sept. 1, 2026','1 September 2026']){
    const answer=`The parcel is zoned R2 [1]. Their recorded registration expiration is ${date} [3].`;
    const out=withoutUnsupportedCitations(answer,hpd);
    assert.ok(out,date);
    assert.equal(out.answer,answer,'the sentence keeps its citation');
    assert.deepEqual(out.removed,[]);
  }
  const us=[{id:1,title:'Registration',url:'https://example.gov/r',text:'Registration ends 09/01/2026 for the building at this lot.'}];
  assert.ok(withoutUnsupportedCitations('The parcel is zoned R2 [2]. The registration ends September 1, 2026 [1].',[us[0],{...sources[1],id:2}]));
  // A different day is not stated, so that sentence is left out and the rest of the answer stands.
  const wrong=withoutUnsupportedCitations('The parcel is zoned R2 [1]. Their recorded registration expiration is September 2, 2026 [3].',hpd);
  assert.equal(wrong.answer,'The parcel is zoned R2 [1].\n\nOne statement was left out because the cited source did not confirm it.');
  assert.deepEqual(wrong.removed,['Their recorded registration expiration is September 2, 2026.']);
});

test('one sentence that fails its citation costs that sentence, never the answer',async()=>{
  const {withoutUnsupportedCitations}=await import('./lanes.mjs');
  const queens=[...sources,{id:3,title:'HPD Certification of No Harassment pilot list, Queens',url:'https://www.nyc.gov/hpd/conh',text:'Queens addresses on the pilot list: 25-21 94 Street, 41-12 Main Street. Updated September 24, 2026.'},
    {id:4,title:'Building record',url:'https://example.gov/b',text:'The site permits 10 dwelling units.'}];
  const answer=[
    'The parcel is zoned R2 with 83,200 square feet of lot area [1].',
    '- The Queens pilot list applies under ZR 23-21 since September 24, 2026 [3].',
    'The site permits 100 dwelling units [4].',
    '- Physical layout and approvals still constrain the count [2].',
    'The listing records a lot of 99,999 square feet beside the promenade [1]. Standard R2 zoning applies to the whole lot [2].',
  ].join('\n');
  const out=withoutUnsupportedCitations(answer,queens);
  assert.ok(out,'the answer survives');
  assert.equal(out.answer,[
    'The parcel is zoned R2 with 83,200 square feet of lot area [1].',
    '- Physical layout and approvals still constrain the count.',
    'Standard R2 zoning applies to the whole lot [2].',
    '',
    '3 statements were left out because the cited source did not confirm them.',
  ].join('\n'));
  assert.equal(out.removed.length,3,'the statute, the contradicted figure and the unstated figure');
  assert.deepEqual(out.dropped,['- Physical layout and approvals still constrain the count.']);
  assert.doesNotThrow(()=>validateCitations(out.answer,queens));
  // What fails the answer as a whole still fails it.
  assert.equal(withoutUnsupportedCitations('The parcel is zoned R2 [9]. The site permits 100 dwelling units [4].',queens),null,'an unknown source');
  assert.equal(withoutUnsupportedCitations('The site permits 100 dwelling units [4].',queens),null,'nothing cited would remain');
});
