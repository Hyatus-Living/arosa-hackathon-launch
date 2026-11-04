import {createHash} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';

export function arosaAccount(email) {
  return createHash('sha256').update(`arosa:${String(email).toLowerCase()}`).digest('hex').slice(0,24);
}

const envAccountLinks=JSON.parse(process.env.AROSA_ACCOUNT_LINKS||'{}');

export function resolveAccount(email,accountLinks=envAccountLinks) {
  const normalized=String(email||'').trim().toLowerCase();
  return accountLinks[normalized]||arosaAccount(normalized);
}

export const DEFAULT_ADMIN_EMAILS=[];

export function isAdminEmail(email,adminEmailsEnv=process.env.AROSA_ADMIN_EMAILS) {
  const normalized=String(email||'').trim().toLowerCase();
  if(!normalized)return false;
  const configured=String(adminEmailsEnv||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const allowlist=new Set(configured.length?configured:DEFAULT_ADMIN_EMAILS);
  return allowlist.has(normalized);
}

export function createAccountResolver(accountLinks={}) {
  return (email)=>resolveAccount(email,accountLinks);
}

export function createAuthenticator({issuer,audience,accountLinks={},adminEmails=process.env.AROSA_ADMIN_EMAILS},key=createRemoteJWKSet(new URL('/cdn-cgi/access/certs',issuer))) {
  const resolve=createAccountResolver(accountLinks);
  return async (req,res,next)=>{
    const token=req.get('cf-access-jwt-assertion');
    if(!token)return res.status(401).json({error:'Sign in with your Arosa account.'});
    try {
      const {payload}=await jwtVerify(token,key,{issuer,audience,algorithms:['RS256']});
      const email=typeof payload.email==='string'?payload.email.toLowerCase():'';
      // Access admits only the Arosa identity provider, where anyone can sign
      // up (Google or verified email), so every account gets its own namespace.
      if(!email||!payload.sub)throw new Error('Arosa identity required');
      req.email=email;
      req.account=resolve(email);
      req.isAdmin=isAdminEmail(email,adminEmails);
      next();
    } catch {res.status(401).json({error:'Your Arosa sign-in could not be verified. Reload Arosa and sign in again.'});}
  };
}

export const authenticate=createAuthenticator({
  issuer:process.env.AROSA_ACCESS_ISSUER||'https://hyatus-ai.cloudflareaccess.com',
  audience:process.env.AROSA_ACCESS_AUD||'unconfigured',
  accountLinks:envAccountLinks,
});

// The architecture plan editor and walkthrough are shown only while the feature is switched on for the
// deployment and, when an allowlist is configured, only to the listed accounts. An allowlist entry is
// an exact email, an `@domain` suffix admitting every account on that domain, or `*` admitting every
// verified account (the judging-window demo mode; pair it with FREE_RUNS_PER_MONTH to bound spend).
export function architectureAllowlistAdmits(email,emailsEnv) {
  const normalized=String(email||'').trim().toLowerCase();
  if(!normalized)return false;
  const allowed=String(emailsEnv||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  return allowed.length===0||allowed.some(entry=>entry==='*'||entry===normalized||(entry.startsWith('@')&&normalized.endsWith(entry)));
}
export function isArchitectureEnabled(email,enabledEnv=process.env.ACRES_ARCHITECTURE_ENABLED,emailsEnv=process.env.ACRES_ARCHITECTURE_EMAILS) {
  return enabledEnv==='true'&&architectureAllowlistAdmits(email,emailsEnv);
}
