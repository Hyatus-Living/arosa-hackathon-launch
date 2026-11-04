import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleMaps, createPlacesTools, createBudget, placeGroups, compass} from './places.mjs';
import {createConceptTools} from './concepts.mjs';

const LAT = 40.708, LON = -74.0107;
const secrets = {GOOGLE_MAPS_API_KEY: 'test-key-abcdefghijklmnopqrstuvwxyz', GOOGLE_MAPS_DAILY_CAPS: {places_nearby: 6, streetview_static: 1}};
const place = (name, type, dLat, dLon) => ({id: `id-${name}`, displayName: {text: name}, primaryType: type, types: [type], location: {latitude: LAT + dLat, longitude: LON + dLon}, shortFormattedAddress: `${name} St`});

test('nearby search groups places with distance and direction, records a source and keeps the key off the client', async () => {
  const calls = [], sources = [];
  const request = async (url, options) => {
    calls.push({url: String(url), options});
    const body = JSON.parse(options.body);
    assert.equal(options.headers['x-goog-api-key'], secrets.GOOGLE_MAPS_API_KEY);
    assert.deepEqual(body.locationRestriction.circle.center, {latitude: LAT, longitude: LON});
    if (body.includedTypes.includes('subway_station')) return {places: [place('Wall St', 'subway_station', 0.0018, 0), place('Fulton St', 'subway_station', 0, 0.003), {displayName: {text: 'Broken'}}]};
    if (body.includedTypes.includes('park')) return {places: [place('Zuccotti Park', 'park', -0.001, -0.001)]};
    return {places: []};
  };
  const maps = createGoogleMaps(secrets, {request});
  const tools = createPlacesTools({maps, getProperty: () => ({bbl: '1000470001', latitude: String(LAT), longitude: String(LON)}), record: s => { sources.push(s); return {id: sources.length}; }});
  assert.equal(tools.definitions[0].name, 'acres_nearby_places');
  const result = await tools.handlers.acres_nearby_places({radiusMeters: 500, groups: ['transit', 'parks']});
  assert.equal(calls.length, 2);
  assert.deepEqual(result.counts, {transit: 2, parks: 1});
  assert.equal(result.places.transit[0].name, 'Wall St');
  assert.equal(result.places.transit[0].direction, 'N');
  assert.ok(Math.abs(result.places.transit[0].distanceMeters - 200) < 3);
  assert.equal(result.places.transit[1].direction, 'E');
  assert.equal(result.places.parks[0].direction, 'SW');
  assert.equal(result.sourceId, 1);
  assert.equal(sources[0].url, 'https://www.google.com/maps/search/?api=1&query=40.708000%2C-74.010700');
  assert.ok(!sources[0].text.includes('latitude'));
  assert.ok(!JSON.stringify(result).includes(secrets.GOOGLE_MAPS_API_KEY));
  assert.equal(tools.places.length, 3);
  assert.equal(tools.places[0].latitude, LAT + 0.0018);
  assert.equal(tools.places[0].sourceId, 1);
  // Repeating the search does not duplicate the retained places, and the daily cap holds.
  await tools.handlers.acres_nearby_places({groups: ['transit', 'parks']});
  assert.equal(tools.places.length, 3);
  await tools.handlers.acres_nearby_places({groups: ['retail', 'schools']});
  await assert.rejects(tools.handlers.acres_nearby_places({}), /budget/);
  await assert.rejects(tools.handlers.acres_nearby_places({groups: ['bars']}), /Choose place groups/);
  assert.equal(compass(350), 'N');
  assert.ok(Object.keys(placeGroups).length === 4);
});

test('street view metadata gives the heading from the panorama to the lot and the image is fetched once', async () => {
  const request = async url => {
    assert.match(String(url), /streetview\/metadata\?/);
    return {status: 'OK', pano_id: 'CAoSLEFGMVFpcE', date: '2024-05', location: {lat: LAT - 0.0003, lng: LON}};
  };
  let fetches = 0;
  const fetcher = async url => { fetches++; assert.match(String(url), /pano=CAoSLEFGMVFpcE&heading=0&fov=90/); return new Response(Buffer.from('jpegbytes'), {status: 200, headers: {'content-type': 'image/jpeg'}}); };
  const maps = createGoogleMaps({...secrets, GOOGLE_MAPS_API_KEY: 'another-key-abcdefghijklmnopqrstuvwxyz'}, {request, fetcher});
  const view = await maps.streetViewMetadata({latitude: LAT, longitude: LON});
  assert.equal(view.panoId, 'CAoSLEFGMVFpcE');
  assert.equal(view.heading, 0);
  assert.equal(view.date, '2024-05');
  assert.ok(Math.abs(view.distanceMeters - 33) < 2);
  const image = await maps.streetViewImage({pano: view.panoId, heading: view.heading});
  assert.equal(image.contentType, 'image/jpeg');
  assert.equal(image.bytes.toString(), 'jpegbytes');
  await maps.streetViewImage({pano: view.panoId, heading: 0.2});
  assert.equal(fetches, 1);
  await assert.rejects(maps.streetViewImage({pano: 'bad pano!', heading: 0}), /Unknown panorama/);
  await assert.rejects(maps.streetViewImage({pano: view.panoId, heading: 400}), /Heading/);
  await assert.rejects(maps.streetViewImage({pano: 'different-pano', heading: 10}), /budget/);
  assert.equal(await maps.streetViewMetadata({latitude: 'x', longitude: LON}), null);
  assert.equal(createGoogleMaps({}), null);
  assert.equal(createGoogleMaps({GOOGLE_MAPS_API_KEY: 'short'}), null);
  const budget = createBudget({places_nearby: 1});
  budget.take('places_nearby');
  assert.equal(budget.remaining('places_nearby'), 0);
  assert.throws(() => budget.take('places_nearby'), /budget/);
});

test('a concept records the street view panorama with its context', async () => {
  const k = 111320, kx = k * Math.cos((LAT * Math.PI) / 180);
  const box = (x1, z1, x2, z2) => [[x1, z1], [x2, z1], [x2, z2], [x1, z2], [x1, z1]].map(([x, z]) => [LON + x / kx, LAT - z / k]);
  const rows = [{bin: '1', base_bbl: '1000470001', height_roof: '85', the_geom: {type: 'MultiPolygon', coordinates: [[box(-10, -15, 10, 15)]]}}];
  let metadataCalls = 0;
  const tools = createConceptTools({
    getProperty: () => ({bbl: '1000470001', latitude: String(LAT), longitude: String(LON)}),
    request: async () => rows,
    streetView: async () => { metadataCalls++; return {panoId: 'pano12345', heading: 90, distanceMeters: 20, date: '2023-10'}; },
  });
  const lot = [[0, 0], [66, 0], [66, 98], [0, 98]];
  const result = await tools.handlers.acres_model_concept({name: 'A', lot, levels: [{footprint: lot, height: 12}]});
  assert.match(result.note, /Street View photo facing the lot \(captured 2023-10\)/);
  assert.deepEqual(tools.concepts[0].context.streetView, {panoId: 'pano12345', heading: 90, distanceMeters: 20, date: '2023-10'});
  assert.ok(tools.concepts[0].context.frame.lotCenter);
  await tools.handlers.acres_model_concept({name: 'B', lot, levels: [{footprint: lot, height: 12}]});
  assert.equal(metadataCalls, 1);
  const failing = createConceptTools({getProperty: () => ({bbl: '1000470001', latitude: String(LAT), longitude: String(LON)}), request: async () => rows, streetView: async () => { throw new Error('quota'); }});
  await failing.handlers.acres_model_concept({name: 'C', lot, levels: [{footprint: lot, height: 12}]});
  assert.equal(failing.concepts[0].context.streetView, null);
  assert.equal(failing.concepts[0].context.buildings.length, 1);
});
test('nearby groups overlap in bounded pairs without changing request count, budget or output order',async()=>{
  let active=0,peak=0,count=0,firstPair;const gates=[],started=new Promise(resolve=>{firstPair=resolve;});
  const budget=createBudget({places_nearby:4});
  const maps=createGoogleMaps({GOOGLE_MAPS_API_KEY:'concurrency-test-abcdefghijklmnopqrstuvwxyz'},{budget,request:async()=>{
    count++;active++;peak=Math.max(peak,active);
    if(count<=2){const wait=new Promise(resolve=>gates.push(resolve));if(count===2)firstPair();await wait;}
    active--;return {places:[]};
  }});
  const pending=maps.nearby({latitude:LAT,longitude:LON});
  await started;assert.equal(count,2);assert.equal(active,2);gates.reverse().forEach(resolve=>resolve());
  const out=await pending;assert.equal(count,4);assert.equal(peak,2);assert.equal(budget.remaining('places_nearby'),0);
  assert.deepEqual(Object.keys(out.groups),['transit','retail','parks','schools']);
});

test('a failed nearby group stops later groups and does not return an undisclosed partial result',async()=>{
  let count=0;
  const maps=createGoogleMaps({GOOGLE_MAPS_API_KEY:'failure-test-abcdefghijklmnopqrstuvwxyz'},{request:async()=>{count++;if(count===1)throw new Error('provider down');return {places:[]};}});
  await assert.rejects(maps.nearby({latitude:LAT,longitude:LON}),/provider down/);assert.equal(count,2);
});
