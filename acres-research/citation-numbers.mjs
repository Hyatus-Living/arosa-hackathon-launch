// A narrow contradiction check, not an entailment score. Compare only identical
// quantitative clauses or named fields in structured evidence. Ambiguous scopes,
// derived arithmetic and quotations require review rather than a guessed verdict.
const NUMBER = String.raw`-?(?:\d[\d,]*)(?:\.\d+)?`;
const QUANTITY = new RegExp(String.raw`(\$?\s*${NUMBER})\s*(million\b|billion\b|thousand\b|[mkb]\b)?\s*(dwelling units?\b|apartments?\b|units?\b|square feet\b|sq\.?\s*ft\.?\b|sqft\b|sf\b|feet\b|ft\b|storeys?\b|stories\b|%|percent\b|FAR\b)?`, 'gi');
const DERIVATION = /\b(?:assuming|hypothetical|illustrative|would|could|if|difference|sum of|combined|calculated|derived|times|plus|minus|per unit|per apartment)\b|[×=]/i;
const QUALIFIED = /\b(?:not|between|from|to|through|at least|at most|more than|less than|above|below|over|under|minimum|maximum of|approximately|roughly|or|annually|monthly|per (?:unit|apartment|square foot|sq\.?\s*ft|sqft|sf|year|month))\b|[<>≤≥]|\d\s*[-–—]\s*\$?\d/i;
// A recognized computed-figure label such as "price per buildable SF" is not itself a rate.
const PER_BUILDABLE = /\bper buildable (?:square foot|sq\.?\s*ft\.?|sqft|sf|zfa)\b/gi;
// Computed fields hold one record per site, under whichever scenario produced it. A claim is compared
// with that record only when the figure is the site's own: the label opens the sentence after a
// determiner, a lot, site, property or parcel possessive, or "the lot has/allows a". Any other subject
// or context (the existing building, a district, an option, a use, an assemblage) may be another figure.
const COMPUTED = new Set(['zoningFloorArea','buildableArea','landValue','pricePerBuildable','maxHeight','maxStoreys']);
const SITE_SUBJECT = /^(?:(?:the|this|its|(?:the|this) (?:lot|site|property|parcel)['’]s) |(?:the|this) (?:lot|site|property|parcel) (?:has|allows|permits|supports|carries) (?:an? )?)?$/i;
const RATE = /\b(?:per|hourly|daily|nightly|weekly|monthly|quarterly|annual|annually|yearly)\b|\//i;
const canonicalUnit = unit => /units?|apartments?/i.test(unit) ? 'units' : /square|sq|^sf$/i.test(unit) ? 'sqft' : /feet|^ft$/i.test(unit) ? 'feet' : /store|stori/i.test(unit) ? 'stories' : /percent|%/i.test(unit) ? 'percent' : /far/i.test(unit) ? 'far' : 'usd';
const unquoted = text => String(text).replace(/^\s*>.*$/gm, '').replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*'/g, ' ');
const clean = text => unquoted(text).replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '').replace(/[*_`]/g, '').trim();
const normalize = text => text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?;]+$/, '').trim();

function amount(raw, scale = '') {
  const text = raw.replace(/[$,\s]/g, '');
  const multiplier = ({million:1e6,m:1e6,billion:1e9,b:1e9,thousand:1e3,k:1e3})[scale.toLowerCase()] || 1;
  const value = Number(text)*multiplier;
  const decimals = text.split('.')[1]?.length||0;
  // A whole figure ending in zeros may be rounded at its last nonzero digit (60,000 or 60,100 for
  // 60,120), but never by more than 1% of the figure, so 1,000 still differs from 1,400.
  const zeros = decimals ? 0 : text.match(/0*$/)[0].length;
  const rounded = Math.min(multiplier*10**zeros/2, Math.abs(value)/100);
  return {value, tolerance:Math.max(multiplier*10**-decimals/2, rounded)};
}

function clause(text) {
  const quantities=[];
  const skeleton=normalize(clean(text).replace(QUANTITY,(whole,raw,scale,unit)=>{
    if(!raw.includes('$')&&!unit)return whole;
    const kind=canonicalUnit(unit||'');
    quantities.push({...amount(raw,scale),unit:kind});
    return `<${kind}>`;
  }));
  return {skeleton,quantities};
}

const fields = new Map([
  ['far','far'],['unitcount','units'],['units','units'],['maxdwellingunits','maxUnits'],['maximumunits','maxUnits'],
  ['grossbuildingsqft','grossArea'],['netresidentialsqft','netArea'],['totaldevelopmentcost','developmentCost'],
  ['profit','profit'],['profitaftercarry','profitAfterCarry'],['entitlementcarrycost','approvalCarry'],
  ['maxfloorareasqft','zoningFloorArea'],['maxzfasqft','zoningFloorArea'],['zoningfloorareasqft','zoningFloorArea'],
  ['buildablesqft','buildableArea'],
  ['landvalue','landValue'],
  // The ask divided by buildable area; median prices from nearby sales are a different figure.
  ['priceperbuildablesf','pricePerBuildable'],['priceperbuildablezfa','pricePerBuildable'],
  ['maxheightfeet','maxHeight'],['heightlimitfeet','maxHeight'],['maxbuildingheightfeet','maxHeight'],
  ['maxstoreys','maxStoreys'],['maxstories','maxStoreys'],
]);
const labels = [
  ['profitAfterCarry',String.raw`profit after (?:incremental approval |approval )?carry`,'usd'],
  ['approvalCarry',String.raw`(?:incremental )?(?:approval|entitlement) (?:land )?carry(?: cost)?`,'usd'],
  ['developmentCost',String.raw`total development cost`,'usd'],
  ['grossArea',String.raw`gross (?:building|floor) area`,'sqft'],
  ['netArea',String.raw`net residential area`,'sqft'],
  ['maxUnits',String.raw`(?:maximum|max) (?:dwelling )?units`,'units'],
  ['units',String.raw`unit count`,'units'],
  // Area figures are compared with the maximum only when the claim says maximum, permitted or allowable.
  ['zoningFloorArea',String.raw`(?:maximum|max|permitted|allowable|as-of-right) zoning floor area`,'sqft'],
  ['buildableArea',String.raw`(?:maximum|max|permitted|allowable|as-of-right) buildable (?:floor )?area`,'sqft'],
  ['landValue',String.raw`(?:residual )?land value`,'usd'],
  ['pricePerBuildable',String.raw`(?:asking )?price per buildable (?:square foot|sq\.?\s*ft\.?|sqft|sf|zfa)`,'usd'],
  ['maxHeight',String.raw`(?:(?:maximum|max) (?:building )?height|(?:building )?height limit)`,'feet'],
  ['maxStoreys',String.raw`(?:maximum|max) (?:number of )?(?:storeys|stories)`,'stories'],
  ['far',String.raw`FAR`,'far'],
  ['profit',String.raw`(?<!after )profit(?! after)`,'usd'],
];

function structuredFigures(sources) {
  const figures=[];
  function walk(value,scope=null){
    if(!value||typeof value!=='object')return;
    const named=[value.scenario,value.label,value.name].find(v=>typeof v==='string'&&v.trim());
    const currentScope=named||scope;
    for(const [key,item] of Object.entries(value)){
      const field=fields.get(key.toLowerCase());
      if(field&&Number.isFinite(item))figures.push({field,value:item,scope:currentScope});
      else if(item&&typeof item==='object')walk(item,currentScope);
    }
  }
  for(const source of sources){
    const text=String(source.text||'').trim();
    if(!/^[{[]/.test(text))continue;
    let value;
    try{value=JSON.parse(text);}catch{continue;}
    walk(value);
  }
  return figures;
}

function different(observed,expected){
  return Math.abs(observed.value-expected)>observed.tolerance+Math.abs(expected)*1e-10;
}

export function numericCitationContradiction(sentence,sources) {
  const text=clean(sentence);
  if(!text||DERIVATION.test(text)||QUALIFIED.test(text)||RATE.test(text.replace(PER_BUILDABLE,' ')))return null;
  const claim=clause(text);
  if(claim.quantities.length&&claim.skeleton.replace(/<[^>]+>/g,'').match(/[a-z]{2,}/gi)?.length>=3){
    const matches=sources.flatMap(s=>String(s.text||'').split(/(?<=[.!?])\s+|\n+/).map(clause))
      .filter(s=>s.skeleton===claim.skeleton&&s.quantities.length===claim.quantities.length);
    if(matches.length&&!matches.some(s=>s.quantities.every((q,i)=>q.unit===claim.quantities[i].unit&&!different(claim.quantities[i],q.value)))){
      return 'The cited text gives different quantities for the same statement.';
    }
  }
  const figures=structuredFigures(sources);
  for(const [field,label,unit] of labels){
    const pattern=new RegExp(String.raw`\b${label}\s*(?::|=|is|of|was|at)?\s*(\$?\s*${NUMBER})\s*(million\b|billion\b|thousand\b|[mkb]\b)?\s*(square feet\b|sq\.?\s*ft\.?\b|sqft\b|sf\b|units?\b|feet\b|ft\b|storeys?\b|stories\b|%)?`,'gi');
    for(const match of text.matchAll(pattern)){
      // Do not interpret an unrecognized unit or denominator as an absent unit.
      // This narrow structured comparison only accepts a complete field/value clause.
      if(!/^[.!?;]*$/.test(text.slice(match.index+match[0].length).trim()))continue;
      if((unit==='sqft'||unit==='feet')&&!match[3])continue;
      if(match[3]&&canonicalUnit(match[3])!==unit)continue;
      if(unit==='usd'&&!match[1].includes('$'))continue;
      const candidates=figures.filter(f=>f.field===field);
      const named=candidates.filter(f=>f.scope&&new RegExp(`(?:^|[^a-z0-9])${normalize(f.scope).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=$|[^a-z0-9])`,'i').test(normalize(text)));
      if(COMPUTED.has(field)&&!named.length&&!SITE_SUBJECT.test(text.slice(0,match.index)))continue;
      const selected=named.length?named:candidates.filter(f=>!f.scope);
      const values=[...new Set(selected.map(f=>f.value))];
      // Several values without an unambiguous scenario match are not a contradiction.
      if(values.length===1&&different(amount(match[1],match[2]),values[0])){
        return `The cited structured evidence gives a different ${field} value for this scope.`;
      }
    }
  }
  return null;
}

export const numericCitationCoverage='Checks matching quantitative clauses and unambiguous structured fields only; does not establish semantic entailment, legal applicability, completeness or the validity of derived calculations.';
