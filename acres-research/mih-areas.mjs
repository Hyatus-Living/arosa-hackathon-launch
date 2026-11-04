import {requestSignal} from './execution-context.mjs';
import {socrataHeaders} from './public-http.mjs';

// Mandatory Inclusionary Housing areas as DCP maps them (ZR Appendix F), one row per adopted area.
export const MIH_AREAS_URL = 'https://data.cityofnewyork.us/resource/m79g-k9r4.json';

// What MIH requires of new residential floor area in a mapped area (ZR 27-131). Inside these areas
// the Universal Affordability Preference is unavailable (ZR 27-111). Option 1 also puts 10% at 40% AMI
// within its 60% average; Option 4 lapses ten years after the amendment that mapped it and never
// applies in the Manhattan Core (Manhattan Community Districts 1 to 8).
export const MIH_RULES = {
  asOf: '2026-10-18',
  source: 'NYC Zoning Resolution 27-111 and 27-131; MIH areas from DCP, NYC Open Data m79g-k9r4',
  sourceUrl: 'https://zoningresolution.planning.nyc.gov/article-ii/chapter-7',
  options: {
    option1: {label: 'Option 1', affordableShare: 0.25, amiPct: 60},
    option2: {label: 'Option 2', affordableShare: 0.30, amiPct: 80},
    option3: {label: 'Option 3', affordableShare: 0.20, amiPct: 40},
    option4: {label: 'Option 4 (Workforce)', affordableShare: 0.30, amiPct: 115},
  },
  option4Years: 10,
  manhattanCoreDistrictMax: 8,
  smallProject: {maxUnits: 10, maxResidentialSqft: 12_500},
  fund: {maxUnits: 25, residentialSqftUnder: 25_000},
};

// The options a DCP row names, e.g. "Option 1, Option 2, and Workforce Option".
export function parseMihOptions(text) {
  const keys = [...String(text || '').matchAll(/option\s*([1-4])/gi)].map(m => `option${m[1]}`);
  if (/workforce/i.test(text)) keys.push('option4');
  const options = Object.keys(MIH_RULES.options).filter(key => keys.includes(key));
  if (!options.length) throw new Error(`Unrecognized MIH option "${text}".`);
  return options;
}

// One DCP row as the area the store keeps: identity, mapped options and rings for the point test.
export function normalizeMihArea(row) {
  const coordinates = row.the_geom.type === 'Polygon' ? [row.the_geom.coordinates] : row.the_geom.coordinates;
  const points = coordinates.flat(2);
  return {
    name: row.project_nam,
    projectId: row.project_id ?? null,
    ulurp: row.zr_ulurpno ?? null,
    adopted: String(row.date_adopte || '').slice(0, 10) || null,
    borough: String(row.boro),
    communityDistrict: Number(row.cd),
    options: parseMihOptions(row.mih_option),
    polygons: coordinates,
    box: {
      west: Math.min(...points.map(p => p[0])), east: Math.max(...points.map(p => p[0])),
      south: Math.min(...points.map(p => p[1])), north: Math.max(...points.map(p => p[1])),
    },
  };
}

export async function defaultMihAreasFetcher() {
  const url = new URL(MIH_AREAS_URL);
  url.searchParams.set('$select', 'the_geom,boro,cd,project_nam,project_id,zr_ulurpno,date_adopte,mih_option');
  url.searchParams.set('$limit', '5000');
  const res = await fetch(url, {headers: socrataHeaders(url), signal: requestSignal(30000)});
  if (!res.ok) throw new Error(`MIH areas Socrata HTTP ${res.status}`);
  return (await res.json()).map(normalizeMihArea);
}

const inRing = (ring, lon, lat) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// The MIH area holding this point, the latest adopted when areas overlap, or null outside every area.
export function mihAreaAt(areas, latitude, longitude) {
  const lat = Number(latitude), lon = Number(longitude);
  const hits = areas.filter(a => lon >= a.box.west && lon <= a.box.east && lat >= a.box.south && lat <= a.box.north
    && a.polygons.some(([outer, ...holes]) => inRing(outer, lon, lat) && !holes.some(h => inRing(h, lon, lat))));
  if (!hits.length) return null;
  const {polygons, box, ...area} = hits.sort((a, b) => String(b.adopted).localeCompare(String(a.adopted)))[0];
  return area;
}

// The mapped options a new building can still use: Option 4 drops out in the Manhattan Core and once lapsed.
export function availableMihOptions(area, now = Date.now()) {
  return area.options.filter(key => {
    if (key !== 'option4') return true;
    if (area.borough === '1' && area.communityDistrict <= MIH_RULES.manhattanCoreDistrictMax) return false;
    const lapses = new Date(area.adopted);
    lapses.setUTCFullYear(lapses.getUTCFullYear() + MIH_RULES.option4Years);
    return now < lapses.getTime();
  });
}
