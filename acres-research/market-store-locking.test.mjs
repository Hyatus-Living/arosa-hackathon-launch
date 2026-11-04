import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MarketStore} from './market-store.mjs';

// Another process holds the write lock and commits while ingestListings waits for it. A deferred
// transaction would read first, then fail on its first write with SQLITE_BUSY_SNAPSHOT once the other
// commit lands; an immediate one waits on busy_timeout and then writes.
test('ingestListings waits for a concurrent writer instead of failing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'market-lock-'));
  const path = join(dir, 'market.sqlite');
  const store = new MarketStore(path);
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  store.ingestListings([{propertyId: 'seed', listingType: 'for_sale', zipCode: '10001', listPrice: 1}]);

  const writer = spawn(process.execPath, ['-e', `
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('BEGIN IMMEDIATE');
    db.exec("UPDATE market_listings SET mls_status = 'held' WHERE property_id = 'seed'");
    console.log('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);
  `], {stdio: ['ignore', 'pipe', 'inherit']});
  await new Promise(resolve => writer.stdout.once('data', resolve));

  const res = store.ingestListings([{propertyId: 'after', listingType: 'sold', zipCode: '10001', soldPrice: 500000, soldDate: '2026-01-02'}]);
  assert.equal(res.inserted, 1);
  await new Promise(resolve => writer.once('exit', resolve));
  assert.equal(store.one("SELECT mls_status FROM market_listings WHERE property_id = 'seed'").mls_status, 'held');
});
