import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {DOMParser} from 'linkedom';
import {addressIdentity} from './parcels.mjs';
import {boroughCode} from './broker-listings.mjs';
import {MarketStore, marketDbPath, openMarketStore} from './market-store.mjs';

// NYC real estate trade press, read from each publisher's public RSS feed. Only what the feed
// itself carries is kept: headline, link, publisher, publish date and the feed's short summary.
// No article bodies (Commercial Observer's feed embeds one in content:encoded; it is never read)
// and nothing behind a paywall. Stories are linked to a tax lot only when an address in the
// headline or summary resolves to exactly one lot in a borough the story names.
export const NEWS_FEEDS = [
  {id: 'trd', publisher: 'The Real Deal', url: 'https://therealdeal.com/new-york/feed/'},
  {id: 'yimby', publisher: 'New York YIMBY', url: 'https://newyorkyimby.com/feed'},
  {id: 'co', publisher: 'Commercial Observer', url: 'https://commercialobserver.com/feed/'},
];

const USER_AGENT = 'Mozilla/5.0 (compatible; ArosaBot/1.0; +https://witharosa.ai)';
const GEOSEARCH_URL = 'https://geosearch.planninglabs.nyc/v2/search';
// Two seconds between requests to one publisher, a fifth of a second between GeoSearch calls.
const FEED_INTERVAL_MS = 2000;
const GEOSEARCH_INTERVAL_MS = 200;
const SUMMARY_MAX = 600;
const BOROUGH_CITY = {MN: 'Manhattan', BK: 'Brooklyn', QN: 'Queens', BX: 'Bronx', SI: 'Staten Island'};

// Neighborhood names the trade press uses in place of a borough. Only names that are not also
// a common word or a place outside the city are listed.
const NEIGHBORHOODS = {
  MN: ['Midtown', 'Midtown South', 'Midtown East', 'Chelsea', 'SoHo', 'NoHo', 'Nolita', 'Tribeca', 'Harlem', 'East Harlem', 'Upper East Side', 'Upper West Side', 'East Village', 'West Village', 'Greenwich Village', 'Lower East Side', 'Financial District', 'FiDi', 'Hudson Yards', 'Hudson Square', 'Flatiron', 'NoMad', 'Murray Hill', 'Kips Bay', 'Gramercy', "Hell's Kitchen", 'Meatpacking District', 'Inwood', 'Washington Heights', 'Chinatown', 'Two Bridges', 'Battery Park City', 'Times Square', 'Turtle Bay', 'Lenox Hill', 'Yorkville', 'Morningside Heights', 'Sutton Place', 'Garment District', 'Union Square', 'Lower Manhattan', 'Herald Square', 'Hamilton Heights', 'Manhattan Valley', 'Roosevelt Island'],
  BK: ['Williamsburg', 'Greenpoint', 'Bushwick', 'Bed-Stuy', 'Bedford-Stuyvesant', 'Crown Heights', 'Park Slope', 'Gowanus', 'Dumbo', 'Downtown Brooklyn', 'Brooklyn Heights', 'Cobble Hill', 'Carroll Gardens', 'Red Hook', 'Sunset Park', 'Bay Ridge', 'Flatbush', 'Prospect Heights', 'Fort Greene', 'Clinton Hill', 'Boerum Hill', 'East New York', 'Brownsville', 'Bensonhurst', 'Borough Park', 'Sheepshead Bay', 'Coney Island', 'Brighton Beach', 'Canarsie', 'Prospect Lefferts Gardens', 'Ocean Hill', 'Midwood', 'Gravesend', 'Dyker Heights', 'Windsor Terrace', 'East Williamsburg', 'Bath Beach', 'Marine Park', 'Cypress Hills'],
  QN: ['Long Island City', 'Astoria', 'Flushing', 'Jackson Heights', 'Sunnyside', 'Woodside', 'Ridgewood', 'Forest Hills', 'Elmhurst', 'Rego Park', 'Far Rockaway', 'Rockaway Beach', 'Arverne', 'Bayside', 'Kew Gardens', 'Maspeth', 'Hunters Point', 'Ozone Park', 'Richmond Hill', 'Fresh Meadows', 'Middle Village', 'Woodhaven', 'Whitestone', 'College Point', 'South Jamaica', 'Briarwood', 'Dutch Kills', 'Ditmars'],
  BX: ['Mott Haven', 'Port Morris', 'South Bronx', 'Hunts Point', 'Fordham', 'Riverdale', 'Kingsbridge', 'Morrisania', 'Highbridge', 'Melrose', 'Tremont', 'Parkchester', 'Soundview', 'Throggs Neck', 'Pelham Bay', 'Co-op City', 'Wakefield', 'Norwood', 'Longwood', 'Bedford Park', 'University Heights', 'Morris Heights', 'Concourse Village', 'Castle Hill', 'Van Nest', 'Williamsbridge'],
  SI: ['St. George', 'Stapleton', 'Tompkinsville', 'Tottenville', 'New Dorp', 'Great Kills', 'Port Richmond'],
};
const BOROUGH_NAMES = {MN: ['Manhattan'], BK: ['Brooklyn'], QN: ['Queens'], BX: ['Bronx'], SI: ['Staten Island']};
const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOROUGH_PATTERNS = Object.entries(BOROUGH_NAMES).map(([code, names]) => [code, new RegExp(`\\b(?:${[...names, ...NEIGHBORHOODS[code]].map(escapeRe).join('|')})\\b`, 'i')]);
// Places outside the five boroughs that share street names with them. A sentence naming one,
// with no borough in it, is not read as a city address.
const OUTSIDE_CITY = /\b(?:New Jersey|N\.J\.|Jersey City|Hoboken|Newark|Long Island(?! City)|Nassau|Suffolk|Westchester|Yonkers|White Plains|New Rochelle|Connecticut|Conn\.|Stamford|Philadelphia|Boston|Miami|Florida|Fla\.|California|Calif\.|Los Angeles|Chicago|Texas|Atlanta|Washington, D\.C\.|Hudson Valley|upstate)\b/i;
const NYC_SIGNAL = /\b(?:New York City|NYC|five boroughs)\b/i;

// "142 West 21st Street", "475 Fifth Ave", "1211 Avenue of the Americas", "57-01 Junction Boulevard".
// Street words must be capitalized and only ordinals may be numbers, so "12 new rental buildings"
// is not an address and "80 Units At 42 Kent Avenue" yields "42 Kent Avenue".
const SUFFIX = '(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Place|Pl|Parkway|Pkwy|Drive|Dr|Lane|Ln|Court|Ct|Terrace|Square|Sq|Highway|Hwy|Way|Plaza|Concourse|Slip|Turnpike|Tpke|Expressway|Row|Walk|Loop)\\b\\.?';
const WORD = "(?:(?:[A-Z][\\w'’.-]*|\\d+(?:st|nd|rd|th))\\s+)";
const ADDRESS_RE = new RegExp(
  `\\b(\\d{1,5}(?:-\\d{1,5})?[A-Z]?(?:\\s*(?:-|–|&|and|,)\\s*\\d{1,5}(?:-\\d{1,5})?)*)\\s+` +
  `(Avenue of the Americas|Central Park (?:West|South)|(?:Avenue|Ave\\.?) [A-Z]\\b|Broadway|Bowery|${WORD}{0,4}${SUFFIX})`, 'g');

// The first number of a combined frontage ("18, 24 & 30"), and of a house-number range outside
// Queens ("761-769"). Queens numbers such as "57-01" are one address.
function houseNumber(raw, borough) {
  const first = raw.replace(/–/g, '-').split(/\s*(?:&|and|,)\s*/)[0].replace(/\s+/g, '');
  const range = first.match(/^(\d+)-(\d+)$/);
  return range && borough !== 'QN' && range[1].length === range[2].length && Number(range[2]) > Number(range[1]) ? range[1] : first;
}

const decodeEntities = value => String(value || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// The feed summary as plain text: markup, the publisher's "read the full story" footer and the
// trailing ellipsis marker are dropped, and long summaries are cut at a word.
export function plainSummary(html) {
  const text = decodeEntities(String(html || '')
    .replace(/<p>\s*This article originally appeared on[\s\S]*$/i, '')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\[(?:…|\.\.\.)\]/g, '…').replace(/\s+/g, ' ').trim();
  if (text.length <= SUMMARY_MAX) return text;
  return `${text.slice(0, SUMMARY_MAX).replace(/\s+\S*$/, '')}…`;
}

// A feed link without tracking parameters or fragment identifies the story.
export function canonicalLink(link) {
  const url = new URL(String(link).trim());
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
  return url.href;
}

export const storyId = url => createHash('sha256').update(url).digest('hex').slice(0, 24);

export function parseFeed(xml, feed) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return [...doc.querySelectorAll('item')].map(item => {
    const field = name => item.getElementsByTagName(name)[0]?.textContent?.trim() || '';
    const link = field('link');
    const published = Date.parse(field('pubDate'));
    if (!link || !Number.isFinite(published)) return null;
    const url = canonicalLink(link);
    return {
      id: storyId(url),
      feedId: feed.id,
      publisher: feed.publisher,
      title: decodeEntities(field('title')).replace(/\s+/g, ' ').trim(),
      url,
      publishedAt: new Date(published).toISOString(),
      summary: plainSummary(field('description')),
      // Commercial Observer tags each story with the addresses it covers.
      categories: [...item.getElementsByTagName('category')].map(c => decodeEntities(c.textContent).trim()).filter(Boolean),
    };
  }).filter(Boolean);
}

const boroughsIn = text => new Set(BOROUGH_PATTERNS.filter(([, re]) => re.test(text)).map(([code]) => code));

// A story naming more addresses than this is a roundup or a profile, not a report about any one lot.
const MAX_STORY_ADDRESSES = 5;

// Street addresses a story names. `boroughs` are the boroughs or neighborhoods named in the
// address's own sentence; `storyBoroughs` those named anywhere in the story. A sentence that names
// a place outside the city and no borough yields no address, a story with no place in the city
// yields none, and a story naming more than five addresses yields none.
export function storyAddresses(story) {
  const sentences = [story.title, ...story.summary.split(/(?<=[.!?])\s+(?=[A-Z“"])/), ...story.categories.filter(c => /^\d/.test(c))];
  const whole = [story.title, story.summary, ...story.categories].join(' . ');
  const storyBoroughs = boroughsIn(whole);
  if (!storyBoroughs.size && !NYC_SIGNAL.test(whole)) return [];
  const found = new Map();
  for (const sentence of sentences) {
    const local = boroughsIn(sentence);
    if (!local.size && OUTSIDE_CITY.test(sentence)) continue;
    for (const match of sentence.matchAll(ADDRESS_RE)) {
      const street = `${houseNumber(match[1], local.size === 1 ? [...local][0] : null)} ${match[2].replace(/\.$/, '')}`;
      const identity = addressIdentity(street);
      if (!identity || found.has(identity)) continue;
      found.set(identity, {street, identity, boroughs: [...local], storyBoroughs: [...storyBoroughs]});
    }
  }
  return found.size > MAX_STORY_ADDRESSES ? [] : [...found.values()];
}

// GeoSearch candidates must carry the address's house number and street, and the match stands
// only when exactly one lot remains. With a borough in the address's sentence, only lots there
// count. Without one, the address must name one lot in the whole city, in a borough the story
// names when it names any: "100 Gold Street" exists in Manhattan and Brooklyn, so a story that
// only mentions Brooklyn elsewhere does not place it.
export async function resolveStoryAddress(address, http) {
  const url = new URL(GEOSEARCH_URL);
  url.searchParams.set('text', address.boroughs.length === 1 ? `${address.street}, ${BOROUGH_CITY[address.boroughs[0]]}, NY` : `${address.street}, NY`);
  url.searchParams.set('size', '10');
  const result = await http.json(url.href);
  const lots = new Map();
  for (const f of result.features) {
    const bbl = String(f.properties.addendum?.pad?.bbl || '');
    const borough = boroughCode(f.properties.borough);
    if (!/^[1-5]\d{9}$/.test(bbl) || addressIdentity(f.properties.name) !== address.identity) continue;
    if (address.boroughs.length && !address.boroughs.includes(borough)) continue;
    lots.set(bbl, {bbl, borough, address: f.properties.name});
  }
  if (lots.size !== 1) return null;
  const [lot] = lots.values();
  if (!address.boroughs.length && address.storyBoroughs.length && !address.storyBoroughs.includes(lot.borough)) return null;
  return lot;
}

// robots.txt groups for "*" and ArosaBot; the longest matching Allow or Disallow rule wins.
export function robotsAllows(robotsText, path) {
  const rules = [];
  let agents = [], inRules = false;
  for (const raw of String(robotsText || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim();
    if (key === 'user-agent') {
      if (inRules) { agents = []; inRules = false; }
      agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (value && agents.some(a => a === '*' || a === 'arosabot')) rules.push({allow: key === 'allow', pattern: value});
    }
  }
  const matches = rules.filter(r => new RegExp(`^${r.pattern.split('*').map(escapeRe).join('.*').replace(/\\\$$/, '$')}`).test(path));
  if (!matches.length) return true;
  const longest = Math.max(...matches.map(r => r.pattern.length));
  return matches.filter(r => r.pattern.length === longest).some(r => r.allow);
}

async function request(url) {
  const response = await fetch(url, {headers: {'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5'}, signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`${new URL(url).host} HTTP ${response.status}`);
  return response;
}

export const defaultNewsHttp = {
  text: async url => (await request(url)).text(),
  json: async url => (await request(url)).json(),
  wait: ms => delay(ms),
};

const pageUrl = (feed, page) => {
  const url = new URL(feed.url);
  if (page > 1) url.searchParams.set('paged', String(page));
  return url.href;
};

// One pass over every feed. A routine pass reads the newest pages until a page brings nothing
// new; a backfill walks the feed's archive pages back to the cutoff. Stories already stored are
// not resolved again. A feed that fails is reported and keeps what it stored.
export async function syncNewsFeeds(store, {feeds = NEWS_FEEDS, http = defaultNewsHttp, backfill = false, maxPages = backfill ? 400 : 10, backfillDays = 365, now = Date.now()} = {}) {
  const cutoff = new Date(now - backfillDays * 86400000).toISOString();
  const report = {feeds: {}, errors: {}};
  for (const feed of feeds) {
    const counts = {pages: 0, read: 0, stored: 0, addresses: 0, matched: 0, unresolved: 0};
    report.feeds[feed.id] = counts;
    try {
      const robotsUrl = new URL('/robots.txt', feed.url).href;
      const robots = await http.text(robotsUrl).catch(() => '');
      for (let page = 1; page <= maxPages; page++) {
        const url = pageUrl(feed, page);
        if (!robotsAllows(robots, new URL(url).pathname + new URL(url).search)) throw new Error(`robots.txt disallows ${url}`);
        if (page > 1) await http.wait(FEED_INTERVAL_MS);
        // A page past the end of the archive answers 404.
        const xml = await http.text(url).catch(err => { if (page > 1 && /HTTP 404$/.test(err.message)) return null; throw err; });
        if (xml === null) break;
        // A bot challenge answers 202 or 200 with an empty or HTML body; that is a failed read, not an empty feed.
        if (!/<rss[\s>]/.test(xml)) throw new Error(`${new URL(url).host} returned no RSS feed`);
        const stories = parseFeed(xml, feed);
        counts.pages++;
        counts.read += stories.length;
        const fresh = stories.filter(s => s.publishedAt >= cutoff && !store.one('SELECT 1 FROM news_stories WHERE id = ?', s.id));
        for (const story of fresh) {
          const lots = [];
          for (const address of storyAddresses(story)) {
            counts.addresses++;
            await http.wait(GEOSEARCH_INTERVAL_MS);
            const lot = await resolveStoryAddress(address, http);
            if (lot) lots.push({...lot, mention: address.street});
            else counts.unresolved++;
          }
          store.saveNewsStory(story, lots, now);
          counts.stored++;
          if (lots.length) counts.matched++;
        }
        const oldest = stories.at(-1)?.publishedAt;
        if (!stories.length || oldest < cutoff || (!backfill && !fresh.length)) break;
      }
    } catch (err) {
      report.errors[feed.id] = err.message;
    }
  }
  report.totals = store.newsStoryCounts();
  return report;
}

export const tradePressDefinition = {
  name: 'acres_trade_press',
  description: 'NYC real estate trade press (The Real Deal, New York YIMBY, Commercial Observer, read from their public RSS feeds) about the subject lot or another lot on its tax block: reported sales, filings, financings, leases and construction, newest first. Each story carries its publisher, publish date, headline, link and the feed\'s own short summary, never the article body, and is recorded as a citable source. A story is linked to a lot only when an address in its headline or summary resolved to that one lot.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: [],
    properties: {
      bbl: {type: 'string', pattern: '^[1-5]\\d{9}$', description: 'Optional 10-digit NYC BBL; defaults to the selected subject property.'},
      limit: {type: 'integer', minimum: 1, maximum: 20, description: 'Most stories to return (default 5).'},
    },
  },
};

export function createTradePressTools({getProperty = () => null, record = () => null, emit = () => {}, openStore = () => openMarketStore({readOnly: true})} = {}) {
  async function run(args = {}) {
    const bbl = args.bbl || getProperty()?.bbl;
    if (!bbl) throw new Error('Supply a 10-digit NYC BBL or select a subject property with acres_set_subject first.');
    const store = openStore();
    if (!store) throw new Error('The trade press store is unavailable.');
    let stories;
    try {
      stories = store.newsForLot(String(bbl), {limit: args.limit ?? 5});
    } finally {
      store.close();
    }
    const cited = stories.map(story => {
      const source = record({title: `${story.publisher}: ${story.title}`, url: story.url, text: `${story.title}\n${story.publisher}, ${story.publishedAt.slice(0, 10)}\n${story.summary}`, publishedDate: story.publishedAt.slice(0, 10)});
      return {...story, sourceId: source?.id || null};
    });
    emit('trade_press.read', {bbl: String(bbl), stories: cited.length});
    return {
      bbl: String(bbl), stories: cited,
      proseReportingMandate: cited.length
        ? 'These are trade-press reports, not official records: attribute each fact to its publisher and date and cite its sourceId. Say whether a story names this lot (onLot) or another lot on its block. Only the headline and the feed summary are known; do not describe the rest of the article.'
        : 'No trade-press story in the stored feeds names this lot or its block. Say so; it does not mean nothing happened on the lot.',
    };
  }
  return {definitions: [tradePressDefinition], handlers: {acres_trade_press: run}};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = new MarketStore(marketDbPath());
  try {
    console.log(JSON.stringify(await syncNewsFeeds(store, {backfill: process.argv.includes('--backfill')}), null, 2));
  } finally {
    store.close();
  }
}
