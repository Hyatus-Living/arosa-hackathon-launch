import test from 'node:test';
import assert from 'node:assert/strict';
import {firmKey,personKey,projectFilings,rankFirms,importPayload,firmsCsv,fetchNewBuildingFilings} from './crm-filings.mjs';
import {NB_FILINGS} from './crm.mjs';

let seq=0;
const filing=(over={})=>({job_filing_number:`B0${String(++seq).padStart(7,'0')}-I1`,filing_status:'Approved',filing_date:'2025-01-01T00:00:00.000',
  borough:'Brooklyn',house_no:String(seq),street_name:'MAIN    STREET',bbl:`30000${String(seq).padStart(5,'0')}`,proposed_dwelling_units:'8',
  total_construction_floor_area:'9000',owner_type:'Corporation',owner_s_business_name:`${seq} MAIN ST LLC`,owner_first_name:'',owner_last_name:'',
  applicant_professional_title:'RA',applicant_license:'',applicant_first_name:'',applicant_last_name:'',applicant_business_name:'',
  filing_representative_first_name:'',filing_representative_last_name:'',filing_representative_business_name:'',...over});

test('firm keys merge suffix, punctuation, spacing and spelling variants and keep distinct firms apart',()=>{
  assert.equal(firmKey('SLCE ARCHITECTS, LLP','architect'),firmKey('slce architect','architect'));
  assert.equal(firmKey('SLCE Architecture P.C.','architect'),firmKey('SLCE','architect'));
  assert.equal(firmKey('Acme Developers LLC'),firmKey('ACME DEVELOPMENT, L.L.C.'));
  assert.equal(firmKey('The Grun Group, Inc.'),firmKey('GRUN GROUP'));
  assert.equal(firmKey('FX Collaborative LLP'),firmKey('FXCOLLABORATIVE'));
  assert.equal(firmKey('Xpdite Group (103) LLC','expediter'),firmKey('XPDITE GROUP LLC (105)','expediter'));
  assert.equal(firmKey('Wallace Avenue Const.LLC'),firmKey('WALLACE AVENUE CONSTRUCTION'));
  assert.notEqual(firmKey('Acme Realty'),firmKey('Acme Development'));
  assert.notEqual(firmKey('S9 Architecture','developer'),firmKey('S9','developer'),'only architect names drop the profession word');
  for(const placeholder of ['PR','N/A','NOT APPLICABLE','none','Self','Owners Rep','',null])assert.equal(firmKey(placeholder),null,String(placeholder));
});

test('person keys skip initials, placeholders and company names',()=>{
  assert.equal(personKey(' Steven ','Westreich'),'STEVEN WESTREICH');
  assert.equal(personKey('M.','B.'),null);
  assert.equal(personKey('N/A','N/A'),null);
  assert.equal(personKey('CITISCAPE','CONSULTING'),null);
});

test('only initial multifamily filings that were not withdrawn or abandoned count',()=>{
  const kept=filing();
  const rows=[kept,filing({proposed_dwelling_units:'2'}),filing({filing_status:'Filing Withdrawn'}),filing({filing_status:'Incomplete'}),
    filing({job_filing_number:'B09999999-S1'})];
  assert.deepEqual(projectFilings(rows),[kept]);
});

test('developers group their project LLCs by the person on the filing, keep the raw names and count each lot once',()=>{
  const rows=[
    filing({owner_s_business_name:'WESTORCHARD MANAGEMENT',owner_first_name:'STEVEN',owner_last_name:'WESTREICH',filing_date:'2024-03-01T00:00:00.000',proposed_dwelling_units:'40'}),
    filing({owner_s_business_name:'744 E 215 LLC',owner_first_name:'Steven',owner_last_name:'Westreich',filing_date:'2025-05-01T00:00:00.000',borough:'Bronx'}),
    filing({owner_s_business_name:'Westorchard Management LLC',owner_first_name:'Andrea',owner_last_name:'Gjini',filing_date:'2025-06-01T00:00:00.000',borough:'Bronx'}),
    filing({owner_s_business_name:'Small Builder LLC',owner_first_name:'Pat',owner_last_name:'Lee',proposed_dwelling_units:'100'}),
    filing({owner_s_business_name:'NYC HPD',owner_type:'NYC Agency',owner_first_name:'Steven',owner_last_name:'Westreich'}),
  ];
  // The same lot filed again after a withdrawal counts once, as its latest filing.
  rows.push({...rows[1],job_filing_number:'B07777777-I1',filing_date:'2025-07-01T00:00:00.000'});
  const [first,second]=rankFirms(rows,'developer');
  assert.equal(first.name,'WESTORCHARD MANAGEMENT');
  assert.equal(first.person,'Steven Westreich');
  assert.deepEqual(first.people,['Steven Westreich','Andrea Gjini']);
  assert.deepEqual([...first.rawNames].sort(),['744 E 215 LLC','WESTORCHARD MANAGEMENT','Westorchard Management LLC']);
  assert.equal(first.filings,3);
  assert.equal(first.units,56);
  assert.deepEqual(first.boroughs,['Bronx','Brooklyn']);
  assert.deepEqual([first.firstFiling,first.lastFiling],['2024-03-01','2025-07-01']);
  assert.deepEqual(first.recent.map(r=>r.date),['2025-07-01','2025-06-01','2024-03-01']);
  assert.equal(first.recent[0].address,`${rows[1].house_no} MAIN STREET`);
  assert.equal(first.recent[0].job,'B07777777');
  assert.equal(second.name,'Small Builder LLC','fewer filings rank lower even with more units');
  assert.equal(second.rank,2);
});

test('an expediter named in the owner field never links two developers, but a developer filing for itself still does',()=>{
  const rows=[
    filing({owner_s_business_name:'Real Owner LLC',filing_representative_business_name:'Citiscape Consulting'}),
    filing({owner_s_business_name:'CITISCAPE CONSULTING LTD',owner_first_name:'Ann',owner_last_name:'One'}),
    filing({owner_s_business_name:'CITISCAPE CONSULTING LTD',owner_first_name:'Bo',owner_last_name:'Two'}),
    filing({owner_s_business_name:'Grun Group LLC',owner_first_name:'Yonah',owner_last_name:'Grunhut',filing_representative_business_name:'Grun Group'}),
    filing({owner_s_business_name:'Grun Group',owner_first_name:'',owner_last_name:''}),
  ];
  const groups=rankFirms(rows,'developer');
  assert.deepEqual(groups.map(g=>[g.name,g.filings]),[['Grun Group',2],['Ann One',1],['Bo Two',1],['Real Owner LLC',1]]);
});

test('architects of record are registered architects, linked across firm name variants by license',()=>{
  const rows=[
    filing({applicant_business_name:'LESTER KATZ, R.A.',applicant_license:'012345',applicant_first_name:'LESTER',applicant_last_name:'KATZ'}),
    filing({applicant_business_name:'XPdite Group LLC',applicant_license:'12345',applicant_first_name:'Lester',applicant_last_name:'Katz'}),
    filing({applicant_business_name:'XPdite Group LLC',applicant_license:'12345',applicant_first_name:'Lester',applicant_last_name:'Katz'}),
    filing({applicant_professional_title:'PE',applicant_business_name:'R & O ENGINEERING',applicant_license:'102862'}),
  ];
  const groups=rankFirms(rows,'architect');
  assert.equal(groups.length,1);
  assert.equal(groups[0].name,'XPdite Group LLC');
  assert.equal(groups[0].filings,3);
});

test('expediters group by their firm and the representative named',()=>{
  const rows=[filing({filing_representative_business_name:'JM ZONING LLC',filing_representative_first_name:'Mark',filing_representative_last_name:'Levin'}),
    filing({filing_representative_business_name:'JM Zoning, LLC'}),filing({filing_representative_business_name:''})];
  assert.deepEqual(rankFirms(rows,'expediter').map(g=>[g.name,g.filings,g.person]),[['JM ZONING LLC',2,'Mark Levin']]);
});

test('ranked firms become CRM leads with filings evidence and no invented contact details',()=>{
  const rows=[filing({owner_s_business_name:'Acme Development LLC',owner_first_name:'PAT',owner_last_name:"O'NEIL",applicant_business_name:'Kao Hwa Lee Architects PC',
    applicant_license:'777',applicant_first_name:'KAO HWA',applicant_last_name:'LEE'})];
  const payload=importPayload({developer:rankFirms(rows,'developer'),architect:rankFirms(rows,'architect')});
  assert.equal(payload.source,NB_FILINGS);
  const [dev,arch]=payload.contacts;
  assert.equal(dev.name,"Pat O'Neil");
  assert.equal(dev.company,'Acme Development LLC');
  assert.equal(dev.sourceRef,'developer:ACMEDEVELOPMENT');
  assert.equal(dev.borough,'Brooklyn');
  assert.equal(dev.email,undefined);
  assert.equal(dev.phone,undefined);
  assert.deepEqual([dev.details.segment,dev.details.rank,dev.details.filings,dev.details.units],['developers',1,1,8]);
  assert.equal(dev.details.recentFilings.length,1);
  assert.equal(arch.title,'Registered architect');
  assert.equal(arch.details.segment,'architects');
  assert.equal(arch.sourceRef,'architect:KAOHWALEE');
  assert.equal(importPayload({developer:Array(3).fill(rankFirms(rows,'developer')[0]),architect:[]},{developers:2}).contacts.length,2);
});

test('the CSV quotes names with commas and joins lists',()=>{
  const groups=rankFirms([filing({owner_s_business_name:'Smith, Jones & Co',owner_first_name:'Al',owner_last_name:'Smith'})],'developer');
  const [head,row]=firmsCsv(groups).trim().split('\n');
  assert.match(head,/^rank,name,person,filings,units/);
  assert.match(row,/^1,"Smith, Jones & Co",Al Smith,1,8,9000,Brooklyn,/);
});

test('the filings pull pages until a short page and stops at its page limit',async()=>{
  const urls=[];
  const page=(n)=>async(url)=>{urls.push(String(url));return {ok:true,json:async()=>Array(n).fill({})};};
  let calls=0;
  const rows=await fetchNewBuildingFilings({since:'2023-10-01',pageSize:2,fetchImpl:async(url)=>page(++calls<3?2:1)(url)});
  assert.equal(rows.length,5);
  assert.match(decodeURIComponent(urls[2]),/filing_date>='2023-10-01'.*offset=4/s);
  await assert.rejects(fetchNewBuildingFilings({since:'2023-10-01',pageSize:2,maxPages:2,fetchImpl:page(2)}),/raise maxPages/);
  await assert.rejects(fetchNewBuildingFilings({since:'2023-10-01',fetchImpl:async()=>({ok:false,status:503})}),/503/);
});
