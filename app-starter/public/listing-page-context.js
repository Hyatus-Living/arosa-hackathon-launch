import {PAGE_SIZE,money} from './listings-model.js';

export const LISTING_PAGE_SCHEMA_ID = 'acres.listing-page/1';

export function validateListingPage(page) {
  if (!page || page.schema !== LISTING_PAGE_SCHEMA_ID || !['ready','loading','error'].includes(page.status) || !Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(page.rows) || page.rows.length > PAGE_SIZE) throw new Error('Invalid listing page.');
  const reference = row => {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 300) throw new Error('Invalid listing reference.');
    const result = {id:row.id};
    for (const [key,limit] of [['address',1000],['bbl',20],['zoningDistrict',100]]) {
      if (row[key] !== null && (typeof row[key] !== 'string' || row[key].length > limit)) throw new Error('Invalid listing reference.');
      result[key] = row[key];
    }
    if (row.listPrice !== null && (typeof row.listPrice !== 'number' || !Number.isFinite(row.listPrice) || row.listPrice < 0)) throw new Error('Invalid listing reference price.');
    result.listPrice = row.listPrice;
    return result;
  };
  return {schema:LISTING_PAGE_SCHEMA_ID,status:page.status,offset:page.offset,total:page.total,rows:page.rows.map(reference),selected:page.selected === null ? null : reference(page.selected)};
}

export function captureListingPage({status,offset,total,deals,selected}) {
  const reference = deal => ({id:deal.id,address:deal.address ?? null,bbl:deal.bbl ?? null,zoningDistrict:deal.zoningDistrict ?? null,listPrice:Number.isFinite(deal.listPrice) ? deal.listPrice : null});
  return validateListingPage({schema:LISTING_PAGE_SCHEMA_ID,status,offset,total,rows:deals.map(reference),selected:selected ? reference(selected) : null});
}

export function listingPageResearchContext(page) {
  return `Captured loaded listing page (reference data, not verified property facts): ${JSON.stringify(page)}\nResolve first, last and nth on this page from the captured rows in order; overall result position is offset + row index + 1. These references can differ from a later search. Loading rows are the previously loaded cards; an error or empty page has no last row to invent. Verify property facts before underwriting.`;
}

const askedFrom = page => page.status === 'loading' ? 'Asked while results were updating' : page.status === 'error' ? 'Asked after listings failed to load' : page.rows.length ? `Asked from results ${page.offset+1} to ${page.offset+page.rows.length} of ${page.total}` : 'Asked from an empty results page';

// Earlier turns keep only where they asked from; the latest captured page in a history carries the rows.
export function listingPageHistoryNote(page) {
  return `${askedFrom(page)}${page.selected ? `, with ${page.selected.address || page.selected.id} open` : ''}. The rows of this earlier page are omitted; the latest captured page is the reference.`;
}

export function listingPageView(page) {
  const view = document.createElement('details'); view.className = 'listings-page-context';
  const summary = document.createElement('summary');
  summary.textContent = askedFrom(page);
  view.append(summary);
  const label = row => [row.address || row.id,row.bbl ? `BBL ${row.bbl}` : null,row.zoningDistrict,Number.isFinite(row.listPrice) ? `ask ${money(row.listPrice)}` : 'unpriced'].filter(Boolean).join(', ');
  if (page.status === 'loading') {const p = document.createElement('p');p.textContent = 'Listings were updating when you asked. These are the previously loaded results.';view.append(p);}
  if (page.selected) {const p = document.createElement('p');p.textContent = `Open listing: ${label(page.selected)}`;view.append(p);}
  const list = document.createElement('ol');list.setAttribute('start',String(page.offset+1));
  for (const row of page.rows) {const li = document.createElement('li');li.textContent = label(row);list.append(li);}
  view.append(list);return view;
}
