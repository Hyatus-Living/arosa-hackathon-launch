import test from 'node:test';
import assert from 'node:assert/strict';
import {numericCitationContradiction,numericCitationCoverage} from './citation-numbers.mjs';
import {validateCitations} from './lanes.mjs';

const source=text=>({id:1,title:'Captured evidence',url:'https://example.com/evidence',verified:true,text});
test('citation validation rejects the reproduced same-statement numeric contradiction',()=>{
  assert.throws(()=>validateCitations('The site permits 100 dwelling units [1].',[source('The site permits 10 dwelling units.')]),{code:'NUMERIC_CITATION_CONTRADICTION'});
  assert.deepEqual(validateCitations('The site permits 10 dwelling units [1].',[source('The site permits 10 dwelling units.')]),[1]);
});
test('matching clauses normalize quantity units and comma formatting, with display rounding',()=>{
  assert.equal(numericCitationContradiction('The floor contains 1,200 square feet.',[source('The floor contains 1200 sqft.')]),null);
  assert.ok(numericCitationContradiction('The floor contains 1,250 square feet.',[source('The floor contains 1200 sqft.')]));
  assert.equal(numericCitationContradiction('The project costs $1.2 million.',[source('The project costs $1,234,567.')]),null);
});
test('multi-number statements are compared as a whole, not by the presence of any digit',()=>{
  const sources=[source('The site permits 10 units across 2 buildings. The site permits 100 units across 3 buildings.')];
  assert.equal(numericCitationContradiction('The site permits 100 units across 3 buildings.',sources),null);
  // The arbitrary untyped building count is retained in the clause skeleton.
  assert.ok(numericCitationContradiction('The site permits 100 units across 2 buildings.',sources));
});
test('quoted and explicitly derived quantities are outside numeric verification coverage',()=>{
  const sources=[source('The site permits 10 dwelling units.')];
  for(const text of ['The claim "The site permits 100 dwelling units" is disputed.', '> The site permits 100 dwelling units.', 'If the sites are combined, the site permits 100 dwelling units.', 'The site could permit 100 dwelling units.']){
    assert.equal(numericCitationContradiction(text,sources),null,text);
  }
  assert.match(numericCitationCoverage,/does not establish semantic entailment/);
});
test('structured figures match labels and scenarios, preserving ambiguous multi-scenario evidence',()=>{
  const sources=[source(JSON.stringify({variants:[{label:'Rental A',profitAfterCarry:100000,unitCount:10},{label:'Rental B',profitAfterCarry:200000,unitCount:20}]}))];
  assert.equal(numericCitationContradiction('Profit after carry is $300,000.',sources),null,'no scenario selected, no guessed contradiction');
  assert.ok(numericCitationContradiction('Rental A: profit after carry is $300,000.',sources));
  assert.equal(numericCitationContradiction('Rental B: profit after carry is $200,000.',sources),null);
  assert.equal(numericCitationContradiction('Rental A and Rental B: profit after carry is $300,000 combined.',sources),null);
});
test('structured comparisons distinguish dimensions and allow rounded values',()=>{
  const sources=[source(JSON.stringify({metrics:{far:4.004},program:{grossBuildingSqft:10000},development:{totalDevelopmentCost:1234567}}))];
  assert.equal(numericCitationContradiction('FAR is 4.00.',sources),null);
  assert.ok(numericCitationContradiction('FAR is 5.00.',sources));
  assert.equal(numericCitationContradiction('Gross building area is 1,000 units.',sources),null,'incompatible unit is not compared');
  assert.ok(numericCitationContradiction('Gross building area is 1,000 square feet.',sources));
  assert.equal(numericCitationContradiction('Total development cost is $1.2 million.',sources),null);
});

test('structured checks abstain on ranges, qualified claims and unknown scenario names',()=>{
  const sources=[source(JSON.stringify({far:4,variants:[{label:'Rental A',profitAfterCarry:100000},{label:'Rental B',profitAfterCarry:200000}]}))];
  for(const text of ['FAR is 3-5.','FAR is 3 to 5.','FAR is at least 3.','FAR is not 3.','FAR is roughly 3.','Rental A2: profit after carry is $900,000.','Rental C: profit after carry is $900,000.','Rental A: profit after carry is $50 per square foot.','Rental A: profit after carry is $0.5 million to $0.9 million.'])assert.equal(numericCitationContradiction(text,sources),null,text);
  assert.ok(numericCitationContradiction('Rental A: profit after carry is $900,000.',sources));
});

test('citation validation abstains on unnormalized rates and explicit unsupported area units',()=>{
  const cases=[
    {claim:'Profit is $100 per day [1].',control:'Profit is $36,500 [1].',wrong:'Profit is $100 [1].',data:{profit:36500,profitPerDay:100,periodDays:365}},
    {claim:'Profit is $100 per room [1].',control:'Profit is $1,000 [1].',wrong:'Profit is $100 [1].',data:{profit:1000,profitPerRoom:100,roomCount:10}},
    {claim:'Gross building area is 100 square meters [1].',control:'Gross building area is 1,076.391 sqft [1].',wrong:'Gross building area is 100 sqft [1].',data:{grossBuildingSqft:1076.391,grossBuildingSquareMeters:100}},
  ];
  for(const {claim,control,wrong,data} of cases){
    const sources=[source(JSON.stringify(data))];
    assert.deepEqual(validateCitations(claim,sources),[1],claim);
    assert.deepEqual(validateCitations(control,sources),[1],control);
    assert.throws(()=>validateCitations(wrong,sources),{code:'NUMERIC_CITATION_CONTRADICTION'},wrong);
  }
  const sources=[source(JSON.stringify({profit:36500,grossBuildingSqft:1076.391}))];
  for(const claim of ['Daily profit is $100.','Profit is $100/day.','Profit is $100 a day.','Profit is $100 per occupied room.','Gross building area is 100 m².','Gross building area is 100 sqm.','Gross building area is 100.'])assert.equal(numericCitationContradiction(claim,sources),null,claim);
});

test('computed envelope and valuation figures are checked against their records',()=>{
  const envelope=source(JSON.stringify({floorArea:{maxFar:6.02,maxFloorAreaSqft:60120},controls:{heightLimitFeet:85},metrics:{storeys:8,heightFeet:84.5,floorAreaSqft:59800}}));
  assert.throws(()=>validateCitations('The lot allows a maximum zoning floor area of 48,000 sq ft [1].',[envelope]),{code:'NUMERIC_CITATION_CONTRADICTION'});
  for(const claim of ['The lot allows a maximum zoning floor area of 60,120 sq ft [1].','The lot allows a maximum zoning floor area of 60.1K sq ft [1].','The lot allows a maximum zoning floor area of 55,000 to 65,000 sq ft [1].','The lot allows a maximum zoning floor area of about 60,000 sq ft [1].']){
    assert.deepEqual(validateCitations(claim,[envelope]),[1],claim);
  }
  assert.ok(numericCitationContradiction('The maximum building height is 120 feet.',[envelope]));
  assert.equal(numericCitationContradiction('The maximum building height is 85 ft.',[envelope]),null);
  assert.equal(numericCitationContradiction('The maximum building height is 120.',[envelope]),null,'a height without a unit is not compared');
  const valuation=source(JSON.stringify({buildableSqft:60120,landValue:9000000,pricePerBuildableSf:150,maxStoreys:8,existing:{storeys:4}}));
  assert.ok(numericCitationContradiction('The maximum number of storeys is 12.',[valuation]));
  assert.equal(numericCitationContradiction('The maximum number of storeys is 8 storeys.',[valuation]),null);
  assert.equal(numericCitationContradiction('The maximum storeys: 8.',[valuation]),null,'an existing building storey count is not the maximum');
  assert.ok(numericCitationContradiction('The maximum buildable area is 48,000 sq ft.',[valuation]));
  assert.equal(numericCitationContradiction('The maximum buildable area is 60,120 sq ft.',[valuation]),null);
  assert.ok(numericCitationContradiction('The land value is $12 million.',[valuation]));
  assert.equal(numericCitationContradiction('The land value is $9.0 million.',[valuation]),null);
  assert.ok(numericCitationContradiction('The price per buildable SF is $210.',[valuation]));
  assert.equal(numericCitationContradiction('The price per buildable SF is $150.',[valuation]),null);
  assert.equal(numericCitationContradiction('The price per buildable SF is $150 per year.',[valuation]),null,'an added rate is still outside coverage');
});

test('a modifier before a computed-figure label names a different figure and is not compared',()=>{
  const envelope=source(JSON.stringify({floorArea:{maxFar:6.02,maxZfaSqft:60120},heightLimitFeet:85,metrics:{storeys:8,heightFeet:84.5,floorAreaSqft:59800}}));
  const capacity=source(JSON.stringify({existingFloorArea:{sqft:20000},byUse:{residential:{maxFar:3,maxFloorAreaSqft:30000,remainingFloorAreaSqft:10000}}}));
  const heights=source(JSON.stringify({baseHeightMinFeet:40,baseHeightMaxFeet:65,maxBuildingHeightFeet:85}));
  const valuation=source(JSON.stringify({landValue:9000000,buildableSqft:60120}));
  const comps=source(JSON.stringify({pricePerBsf:180,perBuildableSqft:180,buildableSqft:60120}));
  for(const [claim,sources] of [
    ['The modeled building has a zoning floor area of 59,800 sq ft.',[envelope]],
    ["The building's zoning floor area is 59,800 sq ft.",[envelope]],
    ["The building's maximum zoning floor area is 59,800 sq ft.",[envelope]],
    ["The existing building's zoning floor area is 20,000 sq ft.",[capacity]],
    ['The existing maximum zoning floor area is 20,000 sq ft.',[capacity]],
    ['The remaining buildable area is 10,000 sq ft.',[capacity]],
    ['The unused buildable floor area is 10,000 sq ft.',[valuation]],
    ['The base height limit is 65 feet.',[heights]],
    ['The street wall height limit is 65 ft.',[heights]],
    ['The assessed land value is $3.2 million.',[valuation]],
    ['The asking price per buildable SF is $210.',[comps]],
    ['The median price per buildable SF is $180.',[source(JSON.stringify({pricePerBuildableSf:150}))]],
    ['With the affordable housing bonus, the maximum zoning floor area is 72,000 sq ft.',[envelope]],
  ])assert.equal(numericCitationContradiction(claim,sources),null,claim);
  assert.ok(numericCitationContradiction('The maximum height is 120 feet.',[heights]));
  assert.ok(numericCitationContradiction('The residual land value is $12 million.',[valuation]));
  assert.ok(numericCitationContradiction('The asking price per buildable SF is $210.',[source(JSON.stringify({pricePerBuildableSf:150}))]));
});

test('a whole figure may be rounded at its last nonzero digit, within 1% of the figure',()=>{
  const envelope=source(JSON.stringify({floorArea:{maxZfaSqft:60120}}));
  for(const claim of ['The maximum zoning floor area is about 60,000 sq ft.','The maximum zoning floor area is 60,000 sq ft.','The maximum zoning floor area is 60,100 sq ft.'])assert.equal(numericCitationContradiction(claim,[envelope]),null,claim);
  assert.ok(numericCitationContradiction('The maximum zoning floor area is 61,000 sq ft.',[envelope]));
  assert.ok(numericCitationContradiction('The maximum zoning floor area is 60,500 sq ft.',[envelope]),'a figure written to the hundred is read to the hundred');
  const records=source(JSON.stringify({unitCount:1400,profit:2600,pricePerBuildableSf:620}));
  for(const claim of ['The unit count is 1,000 units.','Profit is $3,000.','The asking price per buildable SF is $1,000.'])assert.ok(numericCitationContradiction(claim,[records]),claim);
  assert.ok(numericCitationContradiction('The project has 1,000 units in total.',[source('The project has 1,400 units in total.')]));
});

test('a computed figure is compared only when the claim is about the site itself',()=>{
  const envelope=source(JSON.stringify({floorArea:{maxFloorAreaSqft:60120},controls:{heightLimitFeet:85},summary:{maxBuildingHeightFeet:85,modeledTotalHeightFeet:84.5}}));
  for(const claim of [
    'The modeled envelope reaches a maximum height of 84.5 feet.',
    'The R6B portion has a maximum building height of 50 feet.',
    'In the adjacent R8 district the maximum building height is 120 feet.',
    'For commercial use, the maximum zoning floor area is 48,000 sq ft.',
    'On the assembled site, the maximum zoning floor area is 45,000 sq ft.',
    'For the whole zoning lot, the maximum zoning floor area is 45,000 sq ft.',
    'After the 2024 City of Yes amendments, the maximum building height is 95 feet.',
    'The wide street maximum building height is 95 feet.',
    "The scheme's maximum height is 95 feet.",
    "Option B's maximum height is 95 feet.",
    "The tower's maximum height is 95 feet.",
    'Concerns about the site aside, the maximum zoning floor area is 48,000 sq ft.',
  ])assert.equal(numericCitationContradiction(claim,[envelope]),null,claim);
  for(const claim of [
    'The maximum building height is 95 feet.',
    "The site's maximum height is 95 feet.",
    "The lot's maximum zoning floor area is 48,000 sq ft.",
    'This property permits a maximum zoning floor area of 48,000 sq ft.',
    'Maximum zoning floor area: 48,000 sq ft.',
  ])assert.ok(numericCitationContradiction(claim,[envelope]),claim);
  const options=source(JSON.stringify({options:[{label:'As of right',landValue:9000000},{label:'Most floor area',landValue:12000000}]}));
  assert.ok(numericCitationContradiction('In the As of right option, the land value is $12 million.',[options]),'a named scenario is compared with its own record');
  assert.equal(numericCitationContradiction('In the Most floor area option, the land value is $12 million.',[options]),null);
});
