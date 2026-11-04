// Research modes and lane contracts. The default mode is ONE lead agent with
// full discretion over tools, skills and whether parallel work is worth it
// (acres_spawn_lanes). The legacy forced pipeline (three fixed lanes plus a
// judge on every prompt) survives only behind RESEARCH_MODE=lanes, for explicit
// comparison in evals. Lane tool sets are derived from the capability registry
// by tag, never hand-listed per lane, so a new tool is reachable the moment it
// is registered.
import {laneInstructions,judgeInstructions} from './instructions.mjs';
import {numericCitationContradiction} from './citation-numbers.mjs';
import {CAPABILITIES,registeredToolNames,toolsForTags,laneDefaultToolNames} from './capabilities.mjs';
export {laneInstructions,judgeInstructions};

export function researchMode(secrets){
  return secrets?.RESEARCH_MODE==='lanes'?'lanes':'lead';
}
// Historical flag. It no longer forces the lanes pipeline; parallel work now
// happens only when the lead agent calls acres_spawn_lanes. Kept so older host
// configuration and tests keep a truthful answer about what was configured.
export function parallelEnabled(secrets){return secrets?.RESEARCH_PARALLEL_ENABLED===true;}
export function spawnEnabled(secrets){return secrets?.RESEARCH_SPAWN_ENABLED!==false;}

const LANE_TAGS={
  zoning:['evidence','property','zoning','entitlement'],
  cases:['evidence','legal'],
  comps:['evidence','property','context','market','finance','design','entitlement'],
};
export const LANES=[
  {id:'zoning',title:'Parcel and zoning text',tags:LANE_TAGS.zoning,
   charter:'Resolve the subject property and retrieve the operative regulatory text: PLUTO parcel identity, zoning district and overlays, the controlling Zoning Resolution sections, registration and use rules, and computed envelope or entitlement figures where the question needs them. Prefer saved knowledge and official nyc.gov / nysenate.gov text fetched in full. Report exact provisions with citations, applicability limits, and gaps. Do not research case law outcomes or market comparables beyond naming them as open items.',
   tools:toolsForTags(LANE_TAGS.zoning)},
  {id:'cases',title:'Cases and administrative decisions',tags:LANE_TAGS.cases,
   charter:'Find court opinions, BSA and administrative decisions, variances and special permits that bear on the question. Prefer full decision text over summaries; state court/board, date, holding, and why it does or does not control here. Flag contrary authority explicitly. Do not restate market data; do not claim a search was exhaustive.',
   tools:toolsForTags(LANE_TAGS.cases)},
  {id:'comps',title:'Comparables, context, and market',tags:LANE_TAGS.comps,
   charter:'Gather comparable properties and projects, nearby context and places, and market inputs with dated sources. Model a concept, plan, pro forma or program comparison only when the question asks for feasibility or capacity and the inputs are evidenced; label every assumption. Do not opine on controlling legal text beyond citing what other lanes need.',
   tools:toolsForTags(LANE_TAGS.comps)},
];
export const JUDGE_TOOLS=toolsForTags(['evidence']).filter(n=>n!=='acres_refresh_knowledge');

export function judgePacket({question,lanes,sources}){
  const drafts=lanes.map(l=>`=== LANE ${l.id} (${l.status}) ===\n${l.text||l.error||'No output.'}`).join('\n\n');
  const evidence=sources.map(s=>`[${s.id}] ${s.title} <${s.url}> kind=${s.kind} fetched=${s.fetchedAt}\n${s.text.slice(0,3000)}`).join('\n\n---\n\n');
  return `USER QUESTION:\n${question}\n\nLANE DRAFTS (untrusted until verified):\n${drafts}\n\nEVIDENCE (the only citable source IDs are the bracketed numbers below):\n${evidence||'No fetched evidence. Use your repair round or state the gap.'}`;
}
const SUBSTANTIVE_CLAIM_RE=/(\b(?:far|bbl|noi|irr|dscr|ulurp|uap|mih|485-?x|421-?a|zoning resolution|zr\s*\d|variance|permitted|prohibited|allowable|as-of-right)\b|\$\s*\d|\b\d[\d,]*\s*(?:sq\.?\s*ft|sqft|sf|units|stories|storeys|feet|ft)\b|§\s*\d)/i;
const CLAIM_STOP_WORDS=new Set(['the','and','for','with','from','that','this','what','which','when','where','can','could','would','should','does','need','have','has','are','was','were','will','how','while','about','into','under','over','more','less','than','also','only','such','very','some','any','all','both','each','other','not','but','verified','final','answer','legacy','lead','short','synthesis','partial','lane','evidence','page','case','coverage','missing','draft','citing','valid','source','corrected']);

function isClarifyingQuestionOnly(answer){
  const trimmed=String(answer||'').trim();
  return trimmed.endsWith('?')&&trimmed.length<=240&&!SUBSTANTIVE_CLAIM_RE.test(trimmed)&&!/[.!]\s+\S/.test(trimmed);
}

function claimTokens(text){
  return [...new Set((String(text||'').toLowerCase().match(/[a-z0-9§-]{3,}/g)||[]))].filter(w=>!CLAIM_STOP_WORDS.has(w)&&!/^\d+$/.test(w));
}

const CITATION_GROUP=/\[\d+(?:\s*,\s*\d+)*\]/g;
const CLAIM_SUPPORT_SHARE=1/3;
const LEADING_CITATIONS=/^((?:\[\d+(?:\s*,\s*\d+)*\]\s*)+)([\s\S]*)$/;

// Splits an answer into the sentences that carry citations, with the claim each citation covers.
// A citation group written after the full stop ("...no building. [1] Next sentence") belongs to
// the sentence it follows, and a citation closing a paragraph or table cell also covers the
// uncited sentences before it on that line, so a cited conclusion is checked with its reasons.
function citedClaims(answer){
  const claims=[];
  for(const line of String(answer||'').split(/\n+/)){
    const sentences=[];
    for(const part of line.split(/(?<=[.!?][*_)"'\u201d\u2019]*)\s+/)){
      const lead=part.match(LEADING_CITATIONS);
      if(lead&&sentences.length){
        sentences[sentences.length-1]+=` ${lead[1].trim()}`;
        if(lead[2].trim())sentences.push(lead[2]);
      }else sentences.push(part);
    }
    let pending=[];
    for(const sentence of sentences){
      if(!sentence.match(CITATION_GROUP)){pending.push(sentence);continue;}
      claims.push({sentence,context:[...pending,sentence].join(' ')});
      pending=[];
    }
  }
  return claims;
}

// A sentence that says something happened to a property (a default, foreclosure, sale, transfer,
// expiry, approval, disapproval, denial, violation, vacate order, demolition or filing) is supported
// only by a source that records that event, in its own word or one the records use for it. Names,
// years and topic words shared with a deed do not make the deed say the loan defaulted. Only a verb
// that states the event counts: a participle that names a kind of thing ("the approved zoning lot",
// "DOB-approved plans", "filed ZFA") states nothing, and neither does a clause that denies, conditions
// or recommends it ("does not establish a violation", "would need to be approved", "obtain the
// approved plans"), nor the analyst's own act ("I rejected the comparable"). A noun counts only where
// it reports an occurrence ("3 open violations", "a violation was issued"), never where it names
// what a rule would make of something ("is a zoning violation under the height limit").
const EVENTS=[
  ['default',/\bdefaulted\b|\bdefaults? (?:on|under)\b|\bin default\b/g,['default','delinquen','arrear','past due','nonpayment','non-payment','lis pendens','lis_pendens','foreclos']],
  ['foreclosure',/\bforeclos(?:ed|es|ing)\b/g,['foreclos','lis pendens','lis_pendens','referee','auction']],
  ['sale',/\b(?:sold|resold|purchased|bought)\b/g,['sale','sold','deed','convey','transfer','purchas','bought','acquir','transaction','consideration','comparab','grantee','grantor','buyer','seller','clos(?:ed|ing)(?![a-z])','trade[ds]?(?![a-z])']],
  ['transfer',/\b(?:transferred|conveyed)\b/g,['transfer','convey','deed','sale','sold','grantee','grantor','assign']],
  ['expiry',/\bexpir(?:es|ed|ing)\b/g,['expir','lapse','end date','enddate','end_date','end year','final year','last year','through','thru','terminat','sunset']],
  ['disapproval',/\b(?:disapproved|rejected)\b/g,['disapprov','reject','deni','deny','objection','refus']],
  ['approval',/\bapproved\b/g,['approv','adopt','permit','allow','enact','certif','authoriz','ratif','granted','issued','signed off','sign off','sign-off','signoff','pass(?:ed|es|ing|age)?(?![a-z])','vot(?:e|ed|es|ing)(?![a-z])']],
  ['denial',/\bdenied\b/g,['deni','deny','disapprov','reject','refus']],
  ['violation',/\bviolated\b/g,['violat','ecb','oath','summons','penalt','hazardous'],/\b(?:\d+|open|issued|received|outstanding|active|pending|unresolved|has|have|had)\s+(?:[a-z]+\s+){0,3}?violations?\b|\bviolations?\s+(?:(?:was|were|has been|have been)\s+)?(?:issued|filed|recorded|cited|served|imposed)\b/g],
  ['vacate order',/\bvacate orders?\b|\bvacated\b/g,['vacate']],
  ['demolition',/\b(?:demolished|razed|torn down)\b/g,['demoli','raze','torn down','dm(?![a-z])','remov','wreck']],
  // A recorder files a document by recording it.
  ['filing',/\bfiled\b/g,['filed','filing','submitted','submission','applied','application','recorded','recording','docketed']],
].map(([name,pattern,stated,occurrence])=>[name,pattern,new RegExp(`(?<![a-z])(?:${stated.join('|')})`),occurrence]);
// Words that stop a clause from asserting the event: denial, condition, modality, a request or need,
// a recommendation at the head of the clause, or the analyst speaking of their own work.
const NOT_ASSERTED=/\b(?:no|not|never|without|none|nor|neither|any|if|unless|whether|once|be|can|cannot|could|would|might|may|must|should|shall|requir\w*|need\w*|i|we|\w+n't)\b/;
const ADVISES=/^\s*(?:check|confirm|verify|obtain|review|request|ask|search|look|see|order|pull|get|find|consider|treat|assume)\b/;
const CLAUSE_BREAK=/[,;:()|\u2014]|\b(?:and|but|while|whereas|although|though|because)\b/g;
const PREDICATE=/\b(?:is|are|was|were|be|been|being|has|have|had|got)\s+(?:\w+ly\s+)?$/;
const ATTRIBUTIVE=/(?:-|\b(?:the|a|an|its|their|his|her|our|your|this|that|these|those|each|every|all|any|no|previously|already|newly|recently|originally)\s+)$/;
const VERB_FOLLOWS=/^(?:\s*$|\s*[.,;:!?)\]]|\s+(?:\d+|on|in|by|under|at|for|to|the|a|an|its|their|his|her|this|that|these|those|after|before|from|with|and|or|but|as|when|during|since|until|upon|into|over|out|it|them|him|title|ownership|all|both|each|every|some|several|two|three|four|five|last|next|within|soon|later|earlier|early|late|again|twice|once)\b)/;
// Words that look like negation, modality or the first person but are not: the month May, a number
// abbreviation and a Roman numeral one ("Phase I").
const asWritten=sentence=>sentence.replace(/\bNo\.(?=\s*\d)/g,'number').replace(/(?<=\S\s+)May\b|\bMay(?=\s+\d)/g,'month').toLowerCase()
  .replace(/\b(phase|part|title|article|section|class|type|tier|stage|chapter|volume|schedule|appendix|group|level|series|step|category|grade|division)\s+i\b/g,'$1 one');
const asserted=(text,match)=>{
  const clause=text.slice(0,match.index+match[0].length).split(CLAUSE_BREAK).at(-1);
  return !NOT_ASSERTED.test(clause)&&!ADVISES.test(clause);
};
function eventStated(text,match){
  const before=text.slice(0,match.index),after=text.slice(match.index+match[0].length);
  if(!asserted(text,match))return false;
  if(PREDICATE.test(before))return true;
  return !ATTRIBUTIVE.test(before)&&VERB_FOLLOWS.test(after);
}
function unrecordedEvent(sentence,evidence){
  const text=asWritten(sentence).replace(/[\u2018\u2019]/g,"'").replace(/[*_`]/g,'');
  for(const [name,pattern,stated,occurrence] of EVENTS){
    const states=[...text.matchAll(pattern)].some(match=>eventStated(text,match))||(occurrence&&[...text.matchAll(occurrence)].some(match=>asserted(text,match)));
    if(states&&!stated.test(evidence))return name;
  }
  return null;
}

export const citationIds=text=>[...String(text||'').matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap(m=>m[1].split(',').map(s=>Number(s.trim())).filter(Number.isFinite));
export function validateCitations(answer,sources){
  const extractIds=citationIds;
  const cited=extractIds(answer);
  const byId=new Map((sources||[]).map(s=>[s.id,s]));
  if(cited.some(id=>!byId.has(id)))throw new Error('The answer contained an invalid source reference. Please retry.');
  if(cited.some(id=>byId.get(id)?.verified===false))throw new Error('The answer cited an unverified source or assumption URL without fetching the underlying document. Please retry.');
  if(!cited.length&&sources.length&&!isClarifyingQuestionOnly(answer))throw new Error('The answer did not include source references. Please retry.');
  // Every sentence that fails is collected, so one repair turn can fix them all; the error names the
  // first, as before, and carries the rest in failures.
  const failures=[];
  for(const {sentence,context} of citedClaims(answer)){
    const ids=extractIds(sentence);
    const cleanSentence=sentence.replace(CITATION_GROUP,' ').trim();
    const tokens=claimTokens(cleanSentence);
    if(tokens.length<2&&!SUBSTANTIVE_CLAIM_RE.test(cleanSentence))continue;
    const citedSources=ids.map(id=>byId.get(id)).filter(Boolean);
    const checkable=citedSources.filter(s=>typeof s.text==='string'&&s.text.trim().length>=25&&s.text.trim()!=='{}'&&!/^(\s*Evidence page \d+\.\s*)+$/i.test(s.text));
    if(!checkable.length)continue;
    const contradiction=numericCitationContradiction(cleanSentence,checkable);
    if(contradiction){failures.push({message:`Numeric citation contradiction: ${contradiction} Correct the figure or cite the matching scenario.`,code:'NUMERIC_CITATION_CONTRADICTION',claim:cleanSentence.slice(0,400),sourceIds:ids,clean:cleanSentence});continue;}
    const corpus=checkable.map(s=>`${s.title||''} ${s.url||''} ${s.text||''}`.toLowerCase()).join(' ');
    // A section number such as 23-21; a Queens house number such as "32-10 31 Avenue" is an address.
    const statRefs=[...cleanSentence.toLowerCase().matchAll(/(?<![\d-])\b(\d{1,2}-\d{1,3}[a-z]?)\b(?![\d-]|\s+(?:\d{1,3}(?:st|nd|rd|th)?\b|(?:street|st|avenue|ave|road|rd|place|pl|boulevard|blvd|drive|dr|lane|ln|court|ct|parkway|pkwy|terrace|way)\b))/g)].map(m=>m[1]);
    if(statRefs.length&&!statRefs.some(ref=>corpus.includes(ref))){
      failures.push({message:'The answer cited a source that does not support the referenced statutory section. Please retry.',code:'UNSUPPORTED_STATUTE',claim:cleanSentence.slice(0,400),sourceIds:ids,clean:cleanSentence});continue;
    }
    // A claim of four or more content words must find at least a third of its own words (two or more) in
    // the cited text: one shared topic word does not support a different fact. Shorter conclusions may
    // lean on the reasons written before them on the same line. A sentence that passes on shared words
    // must still find the event it states; one that fails on both carries the event, so it is left out
    // after a failed repair rather than kept uncited.
    const supported=tokens.length>=4?tokens.filter(tok=>corpus.includes(tok)).length>=Math.max(2,Math.ceil(tokens.length*CLAIM_SUPPORT_SHARE)):claimTokens(context.replace(CITATION_GROUP,' ')).some(tok=>corpus.includes(tok));
    const event=unrecordedEvent(cleanSentence,checkable.map(s=>`${s.title||''} ${s.text||''}`.toLowerCase()).join(' '));
    if(tokens.length>=2&&!supported)failures.push({message:'The answer cited a source that does not support the claim. Please retry.',code:'UNSUPPORTED_CITATION',claim:cleanSentence.slice(0,400),sourceIds:ids,clean:cleanSentence,event});
    else if(event)failures.push({message:`The answer cited a source that does not support the claim: it records no ${event}. Cite a record of it or leave the sentence out.`,code:'UNSUPPORTED_EVENT',claim:cleanSentence.slice(0,400),sourceIds:ids,clean:cleanSentence,event});
  }
  if(failures.length){
    const [first]=failures;
    throw Object.assign(new Error(first.message),{code:first.code,claim:first.claim,sourceIds:first.sourceIds,failures});
  }
  return cited;
}

// Calendar dates in a text, each as YYYY-MM-DD, and the text with them blanked: records write
// 2026-09-01 or 09/01/2026 where an answer writes September 1, 2026, and both name the same day.
const MONTH_RE='(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function datesIn(text){
  const keys=[];
  const key=(y,m,d)=>{
    const mm=Number(m),dd=Number(d);
    if(mm<1||mm>12||dd<1||dd>31)return null;
    keys.push(`${y}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`);return ' ';
  };
  const month=name=>MONTHS.indexOf(name.slice(0,3).toLowerCase())+1;
  const rest=String(text)
    .replace(/(?<![\d.])(\d{4})-(\d{1,2})-(\d{1,2})(?:T[\d:.]+Z?)?(?![\d])/g,(all,y,m,d)=>key(y,m,d)??all)
    .replace(/(?<![\d.\/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d])/g,(all,m,d,y)=>key(y,m,d)??all)
    .replace(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?![\\d])`,'gi'),(all,m,d,y)=>key(y,month(m),d)??all)
    .replace(new RegExp(`(?<![\\d.])(\\d{1,2})\\s+${MONTH_RE},?\\s+(\\d{4})(?![\\d])`,'gi'),(all,d,m,y)=>key(y,month(m),d)??all);
  return {keys,rest};
}

const DEGRADED_NOTE=n=>`${n===1?'One statement was':`${n} statements were`} left out because the cited source did not confirm ${n===1?'it':'them'}.`;

// The last resort after a citation repair still fails: one bad sentence costs that sentence, never the
// answer. A sentence in words alone that the word-overlap test rejected loses only its brackets, so it
// no longer claims a source: these are almost always the model's own judgments. A sentence with
// figures keeps its citation when every figure (a date in any common form) appears in the cited
// sources, which then state it. Any other failing sentence (a figure the sources do not state, a
// figure they contradict, a statute they do not contain) is left out, and the answer ends by saying
// so. Returns {answer, dropped, figureSupported, removed}, or null when the answer itself fails (an
// unknown or unverified source, no citations) or would be left with no citations.
export function withoutUnsupportedCitations(answer,sources){
  let failures;
  try{validateCitations(answer,sources);return {answer,dropped:[],figureSupported:[],removed:[]};}
  catch(error){failures=error.failures;}
  if(!failures?.length||failures.some(f=>!f.clean))return null;
  const byId=new Map((sources||[]).map(s=>[s.id,s]));
  const figures=text=>(String(text).match(/\d[\d,]*(?:\.\d+)?/g)||[]).map(n=>n.replace(/,/g,''));
  const statedBy=f=>{
    const corpus=f.sourceIds.map(id=>byId.get(id)).filter(Boolean).map(s=>`${s.title||''} ${s.text||''}`).join(' ').replace(/(\d),(?=\d{3}\b)/g,'$1');
    const claim=datesIn(f.clean),stated=datesIn(corpus).keys;
    const found=figures(claim.rest);
    return found.length+claim.keys.length>0&&claim.keys.every(k=>stated.includes(k))&&found.every(n=>new RegExp(`(?<![\\d.])${n.replace('.','\\.')}(?![\\d])`).test(corpus));
  };
  const wordsOnly=f=>!/\d|\$|§/.test(f.clean);
  const unsupported=f=>f.code==='UNSUPPORTED_CITATION'&&!f.event;
  const drop=new Set(failures.filter(f=>unsupported(f)&&wordsOnly(f)).map(f=>f.clean));
  const remove=new Set(failures.filter(f=>!unsupported(f)||(!wordsOnly(f)&&!statedBy(f))).map(f=>f.clean));
  const strip=text=>text.replace(CITATION_GROUP,'').replace(/[ \t]+([.,;:!?)])/g,'$1').replace(/[ \t]{2,}/g,' ');
  const lines=String(answer).split(/(\n+)/).map((line,i)=>{
    if(i%2)return line;
    // The same split as citedClaims, keeping separators so the line rebuilds exactly.
    const pieces=line.split(/((?<=[.!?][*_)"'”’]*)\s+)/);
    const sentences=[];
    for(let k=0;k<pieces.length;k+=2){
      const lead=pieces[k].match(LEADING_CITATIONS);
      if(lead&&sentences.length){
        const prev=sentences.at(-1);prev.text+=` ${lead[1].trim()}`;prev.leadPiece=k;prev.lead=lead[1];
        if(lead[2].trim())sentences.push({text:lead[2],piece:k,after:lead[1]});
      }else sentences.push({text:pieces[k],piece:k});
    }
    let cut=false;
    for(const sentence of sentences){
      if(!sentence.text.match(CITATION_GROUP))continue;
      const clean=sentence.text.replace(CITATION_GROUP,' ').trim();
      const own=pieces[sentence.piece];
      if(remove.has(clean)){
        // A sentence is left out with its citations; one that follows it on the line keeps its own.
        pieces[sentence.piece]=sentence.after??'';cut=true;
        if(sentence.leadPiece!==undefined)pieces[sentence.leadPiece]=pieces[sentence.leadPiece].slice(sentence.lead.length).replace(/^\s+/,'');
      }else if(drop.has(clean)){
        pieces[sentence.piece]=sentence.after?sentence.after+strip(own.slice(sentence.after.length)):strip(own);
        if(sentence.leadPiece!==undefined)pieces[sentence.leadPiece]=pieces[sentence.leadPiece].slice(sentence.lead.length);
      }
    }
    if(!cut)return pieces.join('');
    const indent=line.match(/^[ \t]*/)[0];
    const rebuilt=indent+pieces.join('').trimStart().replace(/[ \t]{2,}/g,' ').replace(/\|[ \t]+\|/g,'|  |').replace(/[ \t]+$/,'');
    // A list item or paragraph left with nothing to say goes with its sentence.
    return /^\s*(?:[-*+]|\d+[.)])?\s*$/.test(rebuilt)?null:rebuilt;
  });
  // A dropped line takes its line break with it.
  const kept=[];
  for(let i=0;i<lines.length;i+=2){
    if(lines[i]===null)continue;
    if(kept.length)kept.push(lines[i-1]);
    kept.push(lines[i]);
  }
  let relaxed=kept.join('');
  if(remove.size)relaxed=`${relaxed.trimEnd()}\n\n${DEGRADED_NOTE(remove.size)}`;
  // What remains may fail only as figure sentences the cited sources state.
  let remaining=[];
  try{validateCitations(relaxed,sources);}
  catch(error){remaining=error.failures;if(!remaining||remaining.some(f=>f.code!=='UNSUPPORTED_CITATION'||!statedBy(f)))return null;}
  const tidy=text=>text.replace(/\s+([.,;:!?])/g,'$1');
  return {answer:relaxed,dropped:[...drop].map(tidy),figureSupported:remaining.map(f=>tidy(f.clean)),removed:[...remove].map(tidy)};
}

// Validate and normalize a lead agent's acres_spawn_lanes request. The lead
// writes its own charters; the server only bounds count, size and tool access
// (registered tools only, no meta/gateway tools, no recursive spawning).
const KNOWN_TAGS=new Set(CAPABILITIES.flatMap(c=>c.tags));
const KNOWN_TOOLS=new Set(registeredToolNames());
function slug(title,used){
  const base=(String(title||'lane').toLowerCase().match(/[a-z0-9]+/g)||['lane']).join('-').slice(0,40)||'lane';
  let id=base,n=2;
  while(used.has(id))id=`${base}-${n++}`;
  used.add(id);return id;
}
export function normalizeSpawnLanes(input){
  const lanes=input?.lanes;
  if(!Array.isArray(lanes)||lanes.length<1||lanes.length>4)throw new Error('acres_spawn_lanes takes 1 to 4 lanes.');
  const used=new Set();
  return lanes.map((raw,i)=>{
    if(!raw||typeof raw!=='object')throw new Error(`Lane ${i+1} must be an object with a title and charter.`);
    const title=String(raw.title||'').trim(),charter=String(raw.charter||'').trim();
    if(!title||title.length>120)throw new Error(`Lane ${i+1} needs a title of 1 to 120 characters.`);
    if(!charter||charter.length>2000)throw new Error(`Lane "${title}" needs a charter of 1 to 2000 characters.`);
    const question=raw.question===undefined?null:String(raw.question).trim();
    if(question!==null&&(!question||question.length>4000))throw new Error(`Lane "${title}" question must be 1 to 4000 characters.`);
    let tools;
    if(raw.tools!==undefined){
      if(!Array.isArray(raw.tools)||!raw.tools.length||raw.tools.length>24)throw new Error(`Lane "${title}" tools must list 1 to 24 tool names.`);
      for(const name of raw.tools)if(!KNOWN_TOOLS.has(name))throw new Error(`Unknown tool for lane "${title}": ${name}. Search with acres_search_capabilities.`);
      tools=[...new Set(raw.tools)].filter(n=>n!=='generateSandboxedUi');
    }else if(raw.tags!==undefined){
      if(!Array.isArray(raw.tags)||!raw.tags.length||raw.tags.length>8)throw new Error(`Lane "${title}" tags must list 1 to 8 tags.`);
      for(const tag of raw.tags)if(!KNOWN_TAGS.has(tag))throw new Error(`Unknown capability tag for lane "${title}": ${tag}. Known tags: ${[...KNOWN_TAGS].sort().join(', ')}.`);
      tools=toolsForTags(raw.tags).filter(n=>n!=='generateSandboxedUi');
    }else{
      tools=laneDefaultToolNames();
    }
    if(!tools.length)throw new Error(`Lane "${title}" resolved to no tools.`);
    return {id:slug(title,used),title,charter,question,tools};
  });
}
