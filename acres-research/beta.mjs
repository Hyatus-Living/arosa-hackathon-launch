// Beta testers: people an admin invited to test Arosa early, keyed by their lower-cased sign-in
// email. A beta tester gets a larger monthly research allowance and a one-click way to send
// feedback. The flag belongs to the email, so someone who signs up later with it is a beta tester
// from their first visit. Revoking keeps the row, with when it ended.
const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(status,message) {const error=new Error(message);error.status=status;throw error;}
export const normalEmail=email=>String(email||'').trim().toLowerCase();

export class BetaTesters {
  constructor(store) {
    this.store=store;
    store.db.exec('CREATE TABLE IF NOT EXISTS beta_testers(email TEXT PRIMARY KEY,granted_by TEXT NOT NULL,granted_at INTEGER NOT NULL,revoked_at INTEGER)');
  }
  has(email) {
    const normalized=normalEmail(email);
    return Boolean(normalized)&&Boolean(this.store.one('SELECT 1 FROM beta_testers WHERE email=? AND revoked_at IS NULL',normalized));
  }
  list() {
    return this.store.query('SELECT email,granted_by AS grantedBy,granted_at AS grantedAt FROM beta_testers WHERE revoked_at IS NULL ORDER BY granted_at DESC');
  }
  grant(email,by,now=Date.now()) {
    const normalized=normalEmail(email);
    if(!emailRe.test(normalized)||normalized.length>320)fail(400,'Enter a valid email address.');
    this.store.write(`INSERT INTO beta_testers VALUES(?,?,?,NULL) ON CONFLICT(email) DO UPDATE SET
      granted_by=excluded.granted_by,granted_at=excluded.granted_at,revoked_at=NULL WHERE beta_testers.revoked_at IS NOT NULL`,
    normalized,normalEmail(by),now);
    return normalized;
  }
  revoke(email,now=Date.now()) {
    const normalized=normalEmail(email);
    if(!this.store.write('UPDATE beta_testers SET revoked_at=? WHERE email=? AND revoked_at IS NULL',now,normalized).changes)fail(404,'This person is not a beta tester.');
    return normalized;
  }
}
