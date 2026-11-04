import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MarketStore} from './market-store.mjs';
import {ChatStore} from './store.mjs';
import {createResearchServer} from './service.mjs';
import {parseFeed, storyAddresses, resolveStoryAddress, robotsAllows, syncNewsFeeds, createTradePressTools, canonicalLink} from './news-feeds.mjs';

const TRD = {id: 'trd', publisher: 'The Real Deal', url: 'https://therealdeal.com/new-york/feed/'};
const YIMBY = {id: 'yimby', publisher: 'New York YIMBY', url: 'https://newyorkyimby.com/feed'};

const item = ({title, link, date = 'Tue, 20 Oct 2026 12:00:02 +0000', description = '', categories = [], body = ''}) => `<item>
  <title>${title}</title><link>${link}</link><pubDate>${date}</pubDate>
  ${categories.map(c => `<category><![CDATA[${c}]]></category>`).join('')}
  <description><![CDATA[${description}]]></description>
  ${body ? `<content:encoded><![CDATA[${body}]]></content:encoded>` : ''}
</item>`;
const rss = items => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title>${items.join('')}</channel></rss>`;
const story = (title, summary = '', categories = []) => ({title, summary, categories});

// GeoSearch features: [name, borough, bbl].
const geo = features => ({features: features.map(([name, borough, bbl]) => ({properties: {name, borough, addendum: {pad: {bbl}}}}))});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'acres-news-'));
  const path = join(dir, 'market.sqlite');
  const store = new MarketStore(path);
  return {store, path, dir, cleanup: () => { try { store.close(); } catch {} rmSync(dir, {recursive: true, force: true}); }};
}

test('a feed item keeps its headline, canonical link, date and plain summary, never the article body', () => {
  const [s] = parseFeed(rss([item({
    title: 'Bond sale tied to Aby Rosen&#8217;s 475 Fifth Ave shelved',
    link: 'https://therealdeal.com/new-york/2026/10/20/bond-sale/?utm_source=feed&utm_medium=feed',
    description: '<p>The $175 million offering attached to 475 Fifth Avenue was postponed. [&#8230;]</p><p>This article originally appeared on The Real Deal. <a href="https://therealdeal.com/x">Click here</a> to read the full story.</p>',
    body: '<p>Full article text that must not be kept.</p>',
  })]), TRD);
  assert.equal(s.title, 'Bond sale tied to Aby Rosen’s 475 Fifth Ave shelved');
  assert.equal(s.url, 'https://therealdeal.com/new-york/2026/10/20/bond-sale/');
  assert.equal(s.publishedAt, '2026-10-20T12:00:02.000Z');
  assert.equal(s.summary, 'The $175 million offering attached to 475 Fifth Avenue was postponed. …');
  assert.equal(s.publisher, 'The Real Deal');
  assert.ok(!JSON.stringify(s).includes('Full article text'));
  assert.equal(canonicalLink('https://x.test/a/?utm_campaign=1&id=2#top'), 'https://x.test/a/?id=2');
});

test('addresses are read with the borough or neighborhood their own sentence names', () => {
  assert.deepEqual(storyAddresses(story('The Myles Nears Completion At 142 West 21st Street in Chelsea, Manhattan')).map(a => [a.street, a.boroughs]), [['142 West 21st Street', ['MN']]]);
  assert.deepEqual(storyAddresses(story('Community Center Announced for 70-02 34th Avenue In Jackson Heights, Queens')).map(a => a.street), ['70-02 34th Avenue']);
  // A count before the address is not its house number, and a combined frontage keeps its first number.
  assert.deepEqual(storyAddresses(story('Rabsky Plans 80 Units At 42 Kent Avenue in Williamsburg')).map(a => a.street), ['42 Kent Avenue']);
  assert.deepEqual(storyAddresses(story('Permits Filed for 761-769 East Tremont Avenue in Tremont, The Bronx')).map(a => a.street), ['761 East Tremont Avenue']);
  assert.deepEqual(storyAddresses(story('Observer Media Relocates Offices to 1330 Avenue of the Americas in Midtown')).map(a => a.street), ['1330 Avenue of the Americas']);
  // Commercial Observer tags a story with the addresses it covers.
  assert.deepEqual(storyAddresses(story('Brooklyn Powerhouse Sports to Open 11K-SF Facility in Sunset Park', '', ['Leases', '14 53rd Street', 'Brooklyn'])).map(a => [a.street, a.boroughs, a.storyBoroughs]), [['14 53rd Street', [], ['BK']]]);
});

test('stories outside the city, roundups and lowercase phrases yield no address', () => {
  assert.deepEqual(storyAddresses(story('Developer Files for 100 Main Street in Jersey City, New Jersey')), []);
  assert.deepEqual(storyAddresses(story('Owners of 1 Main Street in Thousand Oaks, Calif. secure bridge loan')), []);
  assert.deepEqual(storyAddresses(story('Brooklyn landlord buys 12 new rental buildings')), []);
  const roundup = story('Six Manhattan office deals', '1 Park Avenue, 2 Park Avenue, 3 Park Avenue, 4 Park Avenue, 5 Park Avenue and 6 Park Avenue traded in Midtown.');
  assert.deepEqual(storyAddresses(roundup), []);
});

test('GeoSearch places an address only on one lot, in the borough its sentence names or alone in the city', async () => {
  const both = geo([['100 GOLD STREET', 'Manhattan', '1000957501'], ['100 GOLD STREET', 'Brooklyn', '3000557503'], ['10 GOLD STREET', 'Manhattan', '1000690001']]);
  const http = {json: async () => both};
  const [named] = storyAddresses(story('HPD weighs 100 Gold Street in Lower Manhattan'));
  assert.equal((await resolveStoryAddress(named, http)).bbl, '1000957501');
  // The story mentions Brooklyn elsewhere, but the address exists in two boroughs.
  const [loose] = storyAddresses(story('Mamdani won’t back 485x reform', 'A Brooklyn rally followed. The agency at 100 Gold Street released data.'));
  assert.deepEqual(loose.boroughs, []);
  assert.equal(await resolveStoryAddress(loose, http), null);
  const one = {json: async () => geo([['2 GANSEVOORT STREET', 'Manhattan', '1006270043'], ['76 GANSEVOORT STREET', 'Manhattan', '1006430001']])};
  const [unique] = storyAddresses(story('LIV Method takes 12K SF at Sage’s 2 Gansevoort Street', 'A New York City lease.'));
  assert.equal((await resolveStoryAddress(unique, one)).bbl, '1006270043');
  // The only lot citywide is in a borough the story does not name.
  const [elsewhere] = storyAddresses(story('Deal at 2 Gansevoort Street', 'Queens buyers lined up.'));
  assert.equal(await resolveStoryAddress(elsewhere, one), null);
});

test('robots.txt rules for every agent or ArosaBot are honored', () => {
  const robots = 'User-agent: *\nDisallow: /wp-admin/\nDisallow: /?p=*\nAllow: *\n\nUser-agent: Twitterbot\nAllow: /\n\nUser-agent: ArosaBot\nDisallow: /private/';
  assert.equal(robotsAllows(robots, '/new-york/feed/'), true);
  assert.equal(robotsAllows(robots, '/new-york/feed/?paged=2'), true);
  assert.equal(robotsAllows(robots, '/?p=12'), false);
  assert.equal(robotsAllows(robots, '/private/feed'), false);
  assert.equal(robotsAllows('', '/feed'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/feed'), false);
});

function feedHttp(pages, {geoFor = () => geo([]), robots = ''} = {}) {
  const calls = [];
  return {
    calls,
    text: async url => {
      calls.push(url);
      if (url.endsWith('/robots.txt')) return robots;
      const page = Number(new URL(url).searchParams.get('paged') || 1);
      if (!pages[page - 1]) throw new Error('HTTP 404');
      return pages[page - 1];
    },
    json: async url => { calls.push(url); return geoFor(new URL(url).searchParams.get('text')); },
    wait: async () => {},
  };
}

test('a pass stores each story once, links matched lots and stops paging once a page brings nothing new', async () => {
  const {store, cleanup} = tempStore();
  try {
    const pages = [
      rss([item({title: 'Permits Filed for 2314 Cambreleng Avenue in Belmont, The Bronx', link: 'https://newyorkyimby.com/2026/10/a.html', date: 'Tue, 20 Oct 2026 12:00:00 +0000', body: 'BODY'}),
        item({title: 'Ten New Projects Across Jersey City, New Jersey', link: 'https://newyorkyimby.com/2026/10/b.html', date: 'Tue, 20 Oct 2026 11:00:00 +0000'})]),
      rss([item({title: 'Permits Filed for 2320 Cambreleng Avenue in the Bronx', link: 'https://newyorkyimby.com/2026/10/c.html', date: 'Mon, 19 Oct 2026 12:00:00 +0000'})]),
    ];
    const geoFor = text => text.startsWith('2314') ? geo([['2314 CAMBRELENG AVENUE', 'Bronx', '2030890010']]) : geo([['2320 CAMBRELENG AVENUE', 'Bronx', '2030890020']]);
    const now = Date.parse('2026-10-21T00:00:00Z');
    const first = await syncNewsFeeds(store, {feeds: [YIMBY], http: feedHttp(pages, {geoFor}), now});
    assert.deepEqual(first.feeds.yimby, {pages: 2, read: 3, stored: 3, addresses: 2, matched: 2, unresolved: 0});
    assert.deepEqual({...first.totals}, {stories: 3, matchedStories: 2, lots: 2});
    assert.ok(!store.query('SELECT * FROM news_stories').some(r => JSON.stringify(r).includes('BODY')));
    // The next pass reads the first page, finds nothing new and stops.
    const http = feedHttp(pages, {geoFor});
    const second = await syncNewsFeeds(store, {feeds: [YIMBY], http, now});
    assert.equal(second.feeds.yimby.pages, 1);
    assert.equal(second.feeds.yimby.stored, 0);
    assert.ok(!http.calls.some(u => u.includes('geosearch')));
    // A bot challenge's empty or HTML answer is reported as a failed read.
    const challenged = await syncNewsFeeds(store, {feeds: [YIMBY], http: feedHttp(['<html><body>Checking your browser</body></html>']), now});
    assert.equal(challenged.errors.yimby, 'newyorkyimby.com returned no RSS feed');
    assert.equal(challenged.feeds.yimby.pages, 0);
    // A feed robots.txt disallows is not read.
    const blocked = await syncNewsFeeds(store, {feeds: [YIMBY], http: feedHttp(pages, {robots: 'User-agent: *\nDisallow: /feed'}), now});
    assert.match(blocked.errors.yimby, /robots\.txt disallows/);
  } finally {
    cleanup();
  }
});

test('a lot reads up to five stories about itself and its block, newest first', async () => {
  const {store, path, dir, cleanup} = tempStore();
  try {
    const save = (n, bbl, day) => store.saveNewsStory({id: `s${n}`, feedId: 'trd', publisher: 'The Real Deal', title: `Story ${n}`, url: `https://therealdeal.com/${n}/`, publishedAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`, summary: `Summary ${n}`}, bbl ? [{bbl, address: `${n} MAIN STREET`, mention: `${n} Main Street`}] : []);
    save(1, '3000370001', 1);
    save(2, '3000370020', 9);
    save(3, '3000370001', 5);
    save(4, '3000380001', 20);
    save(5, null, 21);
    for (let n = 6; n <= 10; n++) save(n, '3000370030', n);
    const stories = store.newsForLot('3000370001');
    assert.deepEqual(stories.map(s => s.title), ['Story 10', 'Story 9', 'Story 2', 'Story 8', 'Story 7']);
    assert.deepEqual(store.newsForLot('3000370001', {limit: 20}).filter(s => s.onLot).map(s => s.title), ['Story 3', 'Story 1']);
    assert.deepEqual(stories[0].addresses, ['10 MAIN STREET']);

    const recorded = [];
    const tools = createTradePressTools({getProperty: () => ({bbl: '3000380001'}), record: source => { recorded.push(source); return {id: recorded.length}; }, openStore: () => new MarketStore(path, {readOnly: true})});
    const out = await tools.handlers.acres_trade_press({});
    assert.deepEqual(out.stories.map(s => [s.title, s.onLot, s.sourceId]), [['Story 4', true, 1]]);
    assert.equal(recorded[0].url, 'https://therealdeal.com/4/');
    assert.equal(recorded[0].publishedDate, '2026-10-20');
    assert.match(recorded[0].title, /^The Real Deal: Story 4$/);
    assert.equal((await tools.handlers.acres_trade_press({bbl: '1000010001'})).stories.length, 0);

    const chat = new ChatStore(join(dir, 'chat.sqlite'));
    const server = createResearchServer({secrets: {RESEARCH_TOKEN: 'news-token'}, store: chat, maps: null, marketStoreFactory: () => new MarketStore(path)});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const get = bbl => fetch(`http://127.0.0.1:${server.address().port}/news/lots/${bbl}`, {headers: {authorization: 'Bearer news-token', 'x-acres-account': 'a'.repeat(24), 'x-acres-email': 'alex@witharosa.ai'}});
      const response = await get('3000370001');
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).stories.map(s => s.title), ['Story 10', 'Story 9', 'Story 2', 'Story 8', 'Story 7']);
      assert.equal((await get('30003700')).status, 400);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      chat.close();
    }
  } finally {
    cleanup();
  }
});

test('a store opened read-only before the first feed pass has no stories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acres-news-ro-'));
  try {
    const path = join(dir, 'market.sqlite');
    new MarketStore(path).db.exec('DROP TABLE news_story_lots; DROP TABLE news_stories;');
    const store = new MarketStore(path, {readOnly: true});
    assert.deepEqual(store.newsForLot('1000010001'), []);
    store.close();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
