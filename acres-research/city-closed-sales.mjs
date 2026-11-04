import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MarketStore, marketDbPath, CITY_CLOSED_SALES_SOURCE, classifyBuildingClass} from './market-store.mjs';
import {socrataHeaders} from './public-http.mjs';

// Importer for a city closed-sales file (one row per closing) into market_listings as sold comps.
// The data file itself is never committed; run it where the file lives:
//
//   node acres-research/city-closed-sales.mjs <path-to-sales.csv> [--dry-run] [--db=<sqlite path>]
//        [--min-price=10000] [--no-unit-areas]
//
// Without --db it writes to ACRES_MARKET_DB (see marketDbPath). Rows land with
// source 'city_closed_sales'; ZIP rollups count sourced closings (see recomputeZipRollup),
// and a sold row's identity carries its sold date, so repeat closings of one property
// are kept as separate comps while re-importing the same file updates in place.
// Closed sales are comps, not listings: the public counts, listing totals and deal search leave them out.
//
// Header names are matched after lower-casing and turning spaces and punctuation into '_', so
// "SALE PRICE", "Sale-Price" and "sale_price" are the same column; the first alias found wins.
//   address        address | street_address | property_address | street_line   (or property id / BBL)
//   unit           unit | apartment_number | apt | unit_number, else a unit-like suffix after the
//                  last comma of the address ("310 EAST HOUSTON STREET, 5A")
//   property id    property_id | propertyid | apn | parcel_id
//   BBL            bbl, or borough (1-5 or name) + block + lot
//   zip            zip | zip_code | zipcode | postal_code                       (required)
//   sold price     sold_price | sale_price | soldprice | saleprice | price     (required, >= --min-price)
//   sold date      sold_date | sale_date | close_date | closing_date | solddate (required; ISO or M/D/YYYY)
//   optional       city, state, neighborhood, beds|bedrooms, baths|bathrooms,
//                  sqft|sq_ft|living_area (the unit's or home's own area),
//                  gross_sqft|gross_square_feet (a whole lot's building area), lot_sqft|lot_size|land_square_feet,
//                  year_built, building_class_at_time_of_sale|building_class|bldg_class, property_type|type|style,
//                  residential_units|units_res, total_units, list_price, latitude|lat, longitude|lng|lon
// Numbers may carry '$' and thousands commas. Skipped rows are counted by reason.
//
// The BBL is kept in the row's property id, not in the bbl column: bbl marks a listing matched to its
// PLUTO parcel, which the deal search and the parcel backfills select on, and a closing is neither.
// A condominium unit sale names its own unit lot but no area, so unless --no-unit-areas is given the
// unit's gross square feet are read from the DOF assessment roll; co-op units share the building's lot
// and stay without an area. The building's gross area never stands in for the area of a sold unit.

export {CITY_CLOSED_SALES_SOURCE, classifyBuildingClass};
export const CITY_CLOSED_SALES_SOURCE_NAME = 'City closed sales file';
export const DEFAULT_MIN_SALE_PRICE = 10000;
export const DOF_ASSESSMENT_ROLL_URL = 'https://data.cityofnewyork.us/resource/8y4t-faws.json';

const ALIASES = {
  address: ['address', 'street_address', 'property_address', 'street_line'],
  unit: ['unit', 'apartment_number', 'apt', 'unit_number'],
  propertyId: ['property_id', 'propertyid', 'apn', 'parcel_id'],
  bbl: ['bbl'],
  borough: ['borough', 'boro', 'borough_code'],
  block: ['block'],
  lot: ['lot'],
  zipCode: ['zip', 'zip_code', 'zipcode', 'postal_code'],
  soldPrice: ['sold_price', 'sale_price', 'soldprice', 'saleprice', 'price'],
  soldDate: ['sold_date', 'sale_date', 'close_date', 'closing_date', 'solddate'],
  city: ['city'],
  state: ['state'],
  neighborhood: ['neighborhood'],
  beds: ['beds', 'bedrooms', 'bed'],
  baths: ['baths', 'bathrooms', 'bath'],
  livingSqft: ['sqft', 'sq_ft', 'living_area'],
  grossSqft: ['gross_sqft', 'gross_square_feet'],
  lotSqft: ['lot_sqft', 'lot_size', 'land_square_feet'],
  yearBuilt: ['year_built', 'yearbuilt'],
  buildingClass: ['building_class_at_time_of_sale', 'building_class', 'bldg_class', 'building_class_at_present'],
  propertyType: ['property_type', 'type', 'style'],
  unitsRes: ['residential_units', 'units_res'],
  unitsTotal: ['total_units', 'units_total'],
  listPrice: ['list_price', 'listprice'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lng', 'lon'],
};

const normalizeHeader = h => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Minimal RFC 4180 parser: quoted fields, embedded commas/quotes/newlines, CRLF or LF.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i <= src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"' || ch === undefined) quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === undefined) { row.push(field); field = ''; rows.push(row); row = []; }
    else if (ch !== '\r') field += ch;
  }
  const nonEmpty = rows.filter(r => r.some(v => String(v).trim() !== ''));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map(normalizeHeader);
  return nonEmpty.slice(1).map(values => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])));
}

const pick = (rec, names) => {
  for (const name of names) {
    const value = rec[name];
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
};
const num = value => {
  if (value == null) return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const positive = value => {
  const n = num(value);
  return n > 0 ? n : null;
};

export function normalizeSoldDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

const BOROUGH_CODES = {
  manhattan: '1', 'new york': '1', mn: '1', bronx: '2', bx: '2', brooklyn: '3', kings: '3', bk: '3',
  queens: '4', qn: '4', 'staten island': '5', richmond: '5', si: '5',
};

// The 10-digit borough-block-lot id, from a BBL column or from borough, block and lot.
export function bblOf(rec) {
  const direct = num(pick(rec, ALIASES.bbl));
  if (direct && /^[1-5]\d{9}$/.test(String(Math.trunc(direct)))) return String(Math.trunc(direct));
  const boroRaw = String(pick(rec, ALIASES.borough) || '').toLowerCase();
  const boro = /^[1-5]$/.test(boroRaw) ? boroRaw : BOROUGH_CODES[boroRaw];
  const block = num(pick(rec, ALIASES.block));
  const lot = num(pick(rec, ALIASES.lot));
  if (!boro || !(block > 0 && block < 100000) || !(lot > 0 && lot < 10000)) return null;
  return `${boro}${String(Math.trunc(block)).padStart(5, '0')}${String(Math.trunc(lot)).padStart(4, '0')}`;
}

// A trailing ", 5A" / ", APT 2" / ", PH" on the street address is the unit; ", Brooklyn" is not.
const UNIT_SUFFIX = /^(?:(?:apt|unit|#|ph)\.?\s*)?[a-z0-9][a-z0-9\-\/ ]{0,9}$/i;
export function splitUnit(address, unitField) {
  const raw = String(address || '').trim();
  const match = raw.match(/^(.*\S)\s*,\s*([^,]+)$/);
  const suffix = match && UNIT_SUFFIX.test(match[2].trim()) && /\d|^ph/i.test(match[2].trim()) ? match[2].trim() : null;
  const street = suffix ? match[1].trim() : raw;
  return {street: street || null, unit: unitField || suffix || null};
}

function assetClassFor(propertyType) {
  const t = String(propertyType || '').toLowerCase();
  if (/condo|co-?op|apartment/.test(t)) return 'condo_coop_apartment';
  if (/single|townhouse|townhome|house|duplex|triplex|multi/.test(t)) return 'townhouse_single_family';
  return 'unknown';
}

// One CSV record -> one market_listings sold row, or {skip: reason}.
export function mapClosedSaleRow(rec, {minSalePrice = DEFAULT_MIN_SALE_PRICE} = {}) {
  const bbl = bblOf(rec);
  const {street, unit} = splitUnit(pick(rec, ALIASES.address), pick(rec, ALIASES.unit));
  const sourceId = pick(rec, ALIASES.propertyId) || bbl;
  if (!street && !sourceId) return {skip: 'missing_address_and_property_id'};
  const zipCode = (pick(rec, ALIASES.zipCode) || '').slice(0, 5);
  if (!/^\d{5}$/.test(zipCode) || zipCode === '00000') return {skip: 'missing_or_bad_zip'};
  const soldPrice = num(pick(rec, ALIASES.soldPrice));
  if (!(soldPrice > 0)) return {skip: 'missing_or_bad_sold_price'};
  if (soldPrice < minSalePrice) return {skip: 'below_min_sale_price'};
  const soldDate = normalizeSoldDate(pick(rec, ALIASES.soldDate));
  if (!soldDate) return {skip: 'missing_or_bad_sold_date'};
  const buildingClass = pick(rec, ALIASES.buildingClass);
  const propertyType = pick(rec, ALIASES.propertyType);
  const cls = classifyBuildingClass(buildingClass);
  // A row naming a unit sold less than the whole lot, whatever the building's class.
  const unitSale = Boolean(cls?.unitSale || unit);
  // A unit's own area only; a whole lot may fall back to the building's gross area.
  const sqft = unitSale ? positive(pick(rec, ALIASES.livingSqft)) : positive(pick(rec, ALIASES.livingSqft)) ?? positive(pick(rec, ALIASES.grossSqft));
  // Co-op units share the building's lot, so the unit joins the identity.
  const identity = sourceId ? `city-sale:${sourceId}${unitSale && unit ? `:${unit.toLowerCase().replace(/\s+/g, '')}` : ''}` : null;
  return {row: {
    ...(identity ? {propertyId: identity} : {}),
    listingType: 'sold',
    mlsStatus: 'sold',
    address: street && unit ? `${street}, ${unit}` : street,
    unit,
    city: pick(rec, ALIASES.city),
    state: pick(rec, ALIASES.state) || 'NY',
    zipCode,
    neighborhood: pick(rec, ALIASES.neighborhood),
    beds: num(pick(rec, ALIASES.beds)),
    baths: num(pick(rec, ALIASES.baths)),
    sqft: sqft ? Math.round(sqft) : null,
    lotSqft: unitSale ? null : positive(pick(rec, ALIASES.lotSqft)),
    yearBuilt: positive(pick(rec, ALIASES.yearBuilt)),
    listPrice: num(pick(rec, ALIASES.listPrice)),
    soldPrice,
    soldDate,
    pricePerSqft: sqft ? Math.round(soldPrice / sqft) : null,
    style: cls?.style ?? propertyType,
    assetClass: cls?.assetClass ?? assetClassFor(propertyType),
    latitude: num(pick(rec, ALIASES.latitude)),
    longitude: num(pick(rec, ALIASES.longitude)),
    source: CITY_CLOSED_SALES_SOURCE,
    sourceName: CITY_CLOSED_SALES_SOURCE_NAME,
    lastUpdateDate: soldDate,
  }, bbl, unitSale, condoUnit: cls?.style === 'condos'};
}

export function mapClosedSalesCsv(text, options = {}) {
  const records = parseCsv(text);
  const mapped = [];
  const skipped = {};
  const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
  for (const rec of records) {
    const m = mapClosedSaleRow(rec, options);
    if (m.row) mapped.push(m);
    else skip(m.skip);
  }
  // One deed over several lots repeats its total price on every lot's row, so no row carries its own
  // price: rows of one block (or ZIP, without a BBL) sharing a sale date and price are left out.
  const deedKey = m => `${m.bbl ? m.bbl.slice(0, 6) : m.row.zipCode}|${m.row.soldDate}|${m.row.soldPrice}`;
  const lotsPerDeed = new Map();
  for (const m of mapped) lotsPerDeed.set(deedKey(m), (lotsPerDeed.get(deedKey(m)) || 0) + 1);
  const kept = mapped.filter(m => lotsPerDeed.get(deedKey(m)) === 1 || (skip('multi_lot_sale'), false));
  return {rows: kept.map(m => m.row), mapped: kept, parsed: records.length, skipped};
}

// Gross square feet of condominium unit lots from the DOF assessment roll, keyed by BBL.
export async function fetchUnitAreas(bbls, {fetcher = fetch, batchSize = 100} = {}) {
  const areas = new Map();
  for (let i = 0; i < bbls.length; i += batchSize) {
    const batch = bbls.slice(i, i + batchSize);
    const url = new URL(DOF_ASSESSMENT_ROLL_URL);
    url.searchParams.set('$select', 'parid,max(gross_sqft) AS gross_sqft');
    url.searchParams.set('$where', `parid in (${batch.map(b => `'${b}'`).join(',')})`);
    url.searchParams.set('$group', 'parid');
    url.searchParams.set('$limit', String(batch.length));
    const res = await fetcher(url, {headers: socrataHeaders(url)});
    if (!res.ok) throw new Error(`DOF assessment roll HTTP ${res.status}`);
    for (const r of await res.json()) {
      const area = Number(r.gross_sqft);
      if (area >= 100 && area <= 20000) areas.set(String(r.parid), Math.round(area));
    }
  }
  return areas;
}

// Fills the area and $/sqft of condominium unit sales that arrived without one.
export async function addUnitAreas(mapped, options = {}) {
  const missing = mapped.filter(m => m.condoUnit && m.bbl && !m.row.sqft);
  const areas = await fetchUnitAreas([...new Set(missing.map(m => m.bbl))], options);
  let filled = 0;
  for (const m of missing) {
    const area = areas.get(m.bbl);
    if (!area) continue;
    m.row.sqft = area;
    m.row.pricePerSqft = Math.round(m.row.soldPrice / area);
    filled++;
  }
  return {condoUnitsWithoutArea: missing.length, filled};
}

export function importClosedSales(store, rows, {batchSize = 5000, now = Date.now()} = {}) {
  const totals = {inserted: 0, updated: 0, rollupsUpdated: 0};
  for (let i = 0; i < rows.length; i += batchSize) {
    const res = store.ingestListings(rows.slice(i, i + batchSize), now);
    totals.inserted += res.inserted;
    totals.updated += res.updated;
    totals.rollupsUpdated += res.rollupsUpdated;
  }
  return totals;
}

function acceptedSummary(rows) {
  const byAssetClass = {};
  for (const r of rows) byAssetClass[r.assetClass] = (byAssetClass[r.assetClass] || 0) + 1;
  return {accepted: rows.length, withArea: rows.filter(r => r.sqft).length, byAssetClass};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const csvPath = args.find(a => !a.startsWith('--'));
  if (!csvPath) {
    console.error('Usage: node acres-research/city-closed-sales.mjs <path-to-sales.csv> [--dry-run] [--db=<sqlite path>] [--min-price=10000] [--no-unit-areas]');
    process.exit(2);
  }
  const minArg = args.find(a => a.startsWith('--min-price='));
  const {rows, mapped, parsed, skipped} = mapClosedSalesCsv(readFileSync(csvPath, 'utf8'), {minSalePrice: minArg ? Number(minArg.slice(12)) : DEFAULT_MIN_SALE_PRICE});
  const unitAreas = args.includes('--no-unit-areas') ? null : await addUnitAreas(mapped);
  const report = {parsed, ...acceptedSummary(rows), skipped, unitAreas};
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({dryRun: true, ...report}, null, 2));
  } else {
    const dbArg = args.find(a => a.startsWith('--db='));
    const store = new MarketStore(dbArg ? dbArg.slice(5) : marketDbPath());
    try {
      console.log(JSON.stringify({...report, ...importClosedSales(store, rows)}, null, 2));
    } finally {
      store.close();
    }
  }
}
