// Fixture shaped like GET /api/projects: the signed-in account's sites, newest first.
// Addresses and identifiers are synthetic.
const T0 = Date.UTC(2026, 9, 15, 14, 0);
const owner = { account: 'owner@example.com', name: 'Site Owner' };
const site = (id, title, extra = {}) => ({ id, siteKey: null, bbl: null, title, owner, access: 'owner', version: 3, conversationCount: 1, ...extra });

export const projects = [
  site('p_fulton', '1234 Fulton Street, Brooklyn', { bbl: '3012340056', siteKey: 'bbl:3012340056', updated: T0 }),
  site('p_oak', '88 Oak Avenue, Austin, TX', { siteKey: 'addr:88-oak-avenue-austin-tx', updated: T0 - 86400000 }),
  site('p_main', '410 Main Street, Columbus, OH', { updated: T0 - 2 * 86400000 }),
  site('p_shared', null, { siteKey: 'addr:12-elm-row-denver-co', access: 'viewer', updated: T0 - 3 * 86400000 }),
  site('p_pine', '7 Pine Court, Portland, OR', { updated: T0 - 4 * 86400000 }),
  site('p_lake', '1500 Lake Shore Drive, Chicago, IL', { updated: T0 - 5 * 86400000 }),
  site('p_bay', '21 Bay Street, Tampa, FL', { updated: T0 - 6 * 86400000 }),
];
