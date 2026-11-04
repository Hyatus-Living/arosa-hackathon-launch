import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAddressSuggestions, parseGeosearchSuggestions } from '../public/nyc-address.mjs';

const payload = {
  features: [
    { geometry: { coordinates: [-73.94812, 40.807779] }, properties: { label: '152 WEST 124 STREET, New York, NY, USA', name: '152 WEST 124 STREET', borough: 'Manhattan', postalcode: '10027', addendum: { pad: { bbl: '1019080056', bin: '1057806' } } } },
    { geometry: { coordinates: [-73.9, 40.8] }, properties: { label: 'West 124th Street, New York, NY, USA', name: 'West 124th Street' } },
    { properties: { label: 'Broken', addendum: { pad: { bbl: '123' } } } },
  ],
};

test('only parcel-backed NYC addresses become suggestions, with their BBL', () => {
  assert.deepEqual(parseGeosearchSuggestions(payload), [{
    label: '152 WEST 124 STREET, New York, NY, USA',
    name: '152 WEST 124 STREET',
    borough: 'Manhattan',
    postalcode: '10027',
    bbl: '1019080056',
    bin: '1057806',
    coordinates: [-73.94812, 40.807779],
  }]);
  assert.deepEqual(parseGeosearchSuggestions(null), []);
  assert.deepEqual(parseGeosearchSuggestions({}), []);
});

test('short text never calls GeoSearch; a lookup failure is an honest error', async () => {
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, json: async () => payload }; };
  assert.deepEqual(await fetchAddressSuggestions('15', { fetcher: counting }), []);
  assert.equal(calls, 0);
  const found = await fetchAddressSuggestions('152 w 124', { fetcher: counting });
  assert.equal(found[0].bbl, '1019080056');
  await assert.rejects(fetchAddressSuggestions('152 w 124', { fetcher: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});
