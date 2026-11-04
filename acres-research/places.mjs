import {requestSignal,throwIfCancelled} from './execution-context.mjs';
import {providerJson, PublicToolError} from './public-http.mjs';

// Google Maps Platform access for the research service: Places API (New) nearby search for the
// answer and the plan, and Street View Static for a reference photo of the lot. The key stays on
// this host; the browser receives place facts and fetches the photo through the service.
export const placeGroups = {
  transit: ['subway_station', 'train_station', 'bus_station', 'light_rail_station', 'transit_station'],
  retail: ['supermarket', 'grocery_store', 'shopping_mall', 'pharmacy', 'convenience_store', 'department_store'],
  parks: ['park', 'playground', 'dog_park'],
  schools: ['school', 'primary_school', 'secondary_school', 'university'],
};
export const defaultCaps = {places_nearby: 200, streetview_metadata: 600, streetview_static: 400};
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const STREET_VIEW_URL = 'https://maps.googleapis.com/maps/api/streetview';
const PANO = /^[A-Za-z0-9_-]{8,128}$/;

const round = (n, d = 0) => Number(n.toFixed(d));
function distanceBearing(lat1, lon1, lat2, lon2) {
  const k = 111320, east = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180)), north = (lat2 - lat1) * k;
  return {distanceMeters: round(Math.hypot(east, north)), bearing: round(((Math.atan2(east, north) * 180) / Math.PI + 360) % 360)};
}
export const compass = bearing => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8];

// One budget per key: calls per SKU per UTC day, from secrets.GOOGLE_MAPS_DAILY_CAPS or defaults.
export function createBudget(caps = {}) {
  const limits = {...defaultCaps, ...Object.fromEntries(Object.entries(caps).filter(([, v]) => Number.isInteger(v) && v >= 0))};
  const used = new Map();
  return {
    take(sku, count = 1) {
      const day = new Date().toISOString().slice(0, 10), key = `${day}:${sku}`;
      const next = (used.get(key) || 0) + count;
      if (next > (limits[sku] ?? 0)) throw new PublicToolError('PROVIDER_BUDGET_EXHAUSTED', 'The map provider budget for today is spent.', 429);
      used.set(key, next);
      for (const k of used.keys()) if (!k.startsWith(day)) used.delete(k);
    },
    remaining(sku) { const day = new Date().toISOString().slice(0, 10); return Math.max(0, (limits[sku] ?? 0) - (used.get(`${day}:${sku}`) || 0)); },
  };
}

const instances = new Map();
export function createGoogleMaps(secrets = {}, {request = providerJson, fetcher = fetch, budget} = {}) {
  const key = typeof secrets.GOOGLE_MAPS_API_KEY === 'string' && secrets.GOOGLE_MAPS_API_KEY.length >= 20 ? secrets.GOOGLE_MAPS_API_KEY : null;
  if (!key) return null;
  if (instances.has(key)) return instances.get(key);
  budget ||= createBudget(secrets.GOOGLE_MAPS_DAILY_CAPS);
  const images = new Map();

  async function nearby({latitude, longitude, radiusMeters = 400, groups = Object.keys(placeGroups)}) {
    const lat = Number(latitude), lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('No coordinates are available for the property.');
    const radius = Math.max(100, Math.min(1500, Number(radiusMeters) || 400));
    const wanted = [...new Set((Array.isArray(groups) ? groups : []).filter(g => placeGroups[g]))];
    if (!wanted.length) throw new Error(`Choose place groups from ${Object.keys(placeGroups).join(', ')}.`);
    throwIfCancelled();
    budget.take('places_nearby', wanted.length);
    const results = Object.fromEntries(wanted.map(group=>[group,[]]));
    const loadGroup=async group=>{
      const response = await request(PLACES_URL, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': 'places.id,places.displayName,places.primaryType,places.types,places.location,places.shortFormattedAddress'},
        body: JSON.stringify({includedTypes: placeGroups[group], maxResultCount: 20, rankPreference: 'DISTANCE', locationRestriction: {circle: {center: {latitude: lat, longitude: lon}, radius}}}),
      });
      throwIfCancelled();
      results[group] = (Array.isArray(response?.places) ? response.places : []).slice(0, 20).map(place => {
        const plat = Number(place.location?.latitude), plon = Number(place.location?.longitude);
        if (!Number.isFinite(plat) || !Number.isFinite(plon)) return null;
        const {distanceMeters, bearing} = distanceBearing(lat, lon, plat, plon);
        return {
          id: typeof place.id === 'string' ? place.id.slice(0, 200) : null,
          name: String(place.displayName?.text ?? place.displayName ?? '').slice(0, 120) || 'Unnamed place',
          type: typeof place.primaryType === 'string' ? place.primaryType : (place.types || []).find(t => placeGroups[group].includes(t)) || group,
          group, latitude: plat, longitude: plon, distanceMeters, bearing, direction: compass(bearing),
          address: typeof place.shortFormattedAddress === 'string' ? place.shortFormattedAddress.slice(0, 160) : null,
        };
      }).filter(Boolean).sort((a, b) => a.distanceMeters - b.distanceMeters);
    };
    for(let i=0;i<wanted.length;i+=2){
      throwIfCancelled();
      const settled=await Promise.allSettled(wanted.slice(i,i+2).map(loadGroup));
      const failure=settled.find(result=>result.status==='rejected');if(failure)throw failure.reason;
    }
    return {radiusMeters: radius, groups: results, mapUrl: `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)}%2C${lon.toFixed(6)}`};
  }

  // Nearest outdoor panorama within reach of the lot, and the heading from it to the lot.
  async function streetViewMetadata({latitude, longitude, radiusMeters = 60}) {
    const lat = Number(latitude), lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    budget.take('streetview_metadata');
    const url = new URL(`${STREET_VIEW_URL}/metadata`);
    url.searchParams.set('location', `${lat.toFixed(6)},${lon.toFixed(6)}`);
    url.searchParams.set('radius', String(Math.max(10, Math.min(200, radiusMeters))));
    url.searchParams.set('source', 'outdoor');
    url.searchParams.set('key', key);
    const meta = await request(url);
    if (meta?.status !== 'OK' || !PANO.test(String(meta.pano_id || ''))) return null;
    const plat = Number(meta.location?.lat), plon = Number(meta.location?.lng);
    if (!Number.isFinite(plat) || !Number.isFinite(plon)) return null;
    const {distanceMeters, bearing} = distanceBearing(plat, plon, lat, lon);
    return {panoId: meta.pano_id, heading: bearing, distanceMeters, date: typeof meta.date === 'string' ? meta.date.slice(0, 7) : null, latitude: plat, longitude: plon};
  }

  // The photo itself, fetched with the key on this host and cached for repeat views.
  async function streetViewImage({pano, heading, fov = 90}) {
    if (!PANO.test(String(pano || ''))) throw new PublicToolError('INVALID_INPUT', 'Unknown panorama.', 400);
    const h = Math.round(Number(heading)), f = Math.round(Number(fov));
    if (!(h >= 0 && h <= 360) || !(f >= 40 && f <= 120)) throw new PublicToolError('INVALID_INPUT', 'Heading must be 0 to 360 and field of view 40 to 120.', 400);
    const cacheKey = `${pano}:${h}:${f}`;
    if (images.has(cacheKey)) return images.get(cacheKey);
    budget.take('streetview_static');
    const url = new URL(STREET_VIEW_URL);
    url.searchParams.set('size', '640x400'); url.searchParams.set('pano', pano); url.searchParams.set('heading', String(h));
    url.searchParams.set('fov', String(f)); url.searchParams.set('pitch', '8'); url.searchParams.set('return_error_code', 'true'); url.searchParams.set('key', key);
    let response;
    try { response = await fetcher(url, {signal: requestSignal(15000), redirect: 'error'}); }
    catch { throw new PublicToolError('PROVIDER_UNAVAILABLE', 'The street photo is unavailable.'); }
    if (!response.ok) throw new PublicToolError('PROVIDER_UNAVAILABLE', 'The street photo is unavailable.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024 || !/^image\//.test(response.headers.get('content-type') || '')) throw new PublicToolError('PROVIDER_UNAVAILABLE', 'The street photo is unavailable.');
    const image = {bytes, contentType: response.headers.get('content-type')};
    images.set(cacheKey, image);
    if (images.size > 120) images.delete(images.keys().next().value);
    return image;
  }

  const maps = {nearby, streetViewMetadata, streetViewImage, budget};
  instances.set(key, maps);
  return maps;
}

export const placesDefinition = {
  name: 'acres_nearby_places',
  description: 'List transit stops, retail, parks and schools near the selected property from Google Places, with distance and compass direction from the parcel, for context on access and amenities. Returns a source ID for citations and the places appear on the concept plan. Distance does not establish walkability, zoning use groups or any entitlement.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      radiusMeters: {type: 'number', minimum: 100, maximum: 1500, description: 'Search radius in metres. Defaults to 400 (about a five-minute walk).'},
      groups: {type: 'array', items: {type: 'string', enum: Object.keys(placeGroups)}, description: 'Which groups to search. Defaults to all four.'},
    },
    required: [],
  },
};

export function createPlacesTools({maps, getProperty = () => null, record = () => null}) {
  const places = [];
  async function nearby(args = {}) {
    if (!maps) throw new Error('Nearby places are not configured on this service.');
    const property = getProperty();
    if (!property) throw new Error('Select the subject property first.');
    const result = await maps.nearby({latitude: property.latitude, longitude: property.longitude, radiusMeters: args.radiusMeters, groups: args.groups});
    const flat = Object.values(result.groups).flat();
    const source = record({title: 'Google Places near the property', url: result.mapUrl, kind: 'places', text: JSON.stringify({bbl: property.bbl, radiusMeters: result.radiusMeters, places: flat.map(({latitude, longitude, id, ...rest}) => rest)})});
    for (const place of flat) if (!places.some(p => p.id && p.id === place.id)) places.push({...place, sourceId: source?.id ?? null});
    const summary = Object.fromEntries(Object.entries(result.groups).map(([group, list]) => [group, list.slice(0, 8).map(({id, latitude, longitude, group: _g, ...rest}) => rest)]));
    return {radiusMeters: result.radiusMeters, counts: Object.fromEntries(Object.entries(result.groups).map(([g, l]) => [g, l.length])), places: summary, sourceId: source?.id ?? null, note: 'Google Places results near the parcel centroid. Cite the source ID for these facts. They describe surroundings, not zoning or rights.'};
  }
  return {definitions: maps ? [placesDefinition] : [], places, handlers: maps ? {acres_nearby_places: nearby} : {}};
}
