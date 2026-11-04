import {createHash} from 'node:crypto';

// Match the existing website's verified IAP claims.sub exactly. In particular,
// do not strip an accounts.google.com prefix that IAP may include in that value.
// This function is used only for administrator-verified membership linking.
export function existingGoogleAccountId(verifiedIapSubject:string):string {
  return createHash('sha256').update(`accounts.google.com:${verifiedIapSubject}`).digest('hex').slice(0,24);
}

// Self-service namespace for a verified Arosa OAuth subject with no reviewed
// membership. Deterministic per subject, isolated from every linked account.
export function publicAccountId(subject:string):string {
  return createHash('sha256').update(`arosa-mcp:${subject}`).digest('hex').slice(0,24);
}
