import {createRemoteJWKSet,jwtVerify,type JWTVerifyGetKey} from 'jose';
import type {GatewayConfig} from './config.js';
import {publicAccountId} from './identity.js';
import {scopes,type Scope} from './contracts.js';

export interface Account {accountId:string;workspaceId:string;subject:string;scopes:Scope[]}
export class AuthenticationError extends Error {
  constructor(public status:401|403,public code:string,public scope:Scope='acres:read'){super(code);}
}
// Isolated public accounts never exceed read access, whatever the token says.
const publicScopes:readonly Scope[]=['acres:read'];
const effectiveScopes=(granted:string[],allowed:readonly Scope[])=>scopes.filter(scope=>granted.includes(scope)&&allowed.includes(scope));
export const workspaceClaim='https://acres.witharosa.ai/workspace_id';

export function createAuthenticator(config:GatewayConfig,key:JWTVerifyGetKey=createRemoteJWKSet(new URL(config.jwksUrl),{timeoutDuration:5000})) {
  return async (authorization:string|undefined):Promise<Account>=>{
    if(!authorization||!/^Bearer [^\s]+$/i.test(authorization)||authorization.length>8192)throw new AuthenticationError(401,'invalid_token');
    let payload;
    try {
      ({payload}=await jwtVerify(authorization.slice(7),key,{
        issuer:config.issuer,audience:config.resourceUrl,algorithms:['RS256'],
        requiredClaims:['sub','exp','iat'],maxTokenAge:'10m',clockTolerance:5,
      }));
      // Enforce short-lived access tokens, not arbitrary signed ID tokens.
      if(!payload.exp||!payload.iat||payload.exp-payload.iat>600||payload.exp<=payload.iat)throw new Error('Invalid lifetime');
    } catch {throw new AuthenticationError(401,'invalid_token');}
    const granted=typeof payload.scope==='string'?payload.scope.split(/\s+/):[];
    if(!effectiveScopes(granted,scopes).length)throw new AuthenticationError(403,'insufficient_scope');
    let members,knownSubject=false;
    try {
      const all=config.memberships().filter(member=>member.subject===payload.sub);
      knownSubject=all.length>0;
      members=all.filter(member=>member.enabled);
    }
    catch {throw new AuthenticationError(403,'access_denied');}
    const workspace=payload[workspaceClaim];
    if(workspace!==undefined)members=members.filter(member=>member.workspaceId===workspace);
    // Multiple workspaces require a signed selection; a caller header cannot select it.
    if(members.length!==1) {
      // A subject with no reviewed membership row gets an isolated public
      // account when public access is on. A disabled membership stays denied.
      if(members.length===0&&!knownSubject&&config.publicAccess&&workspace===undefined) {
        const effective=effectiveScopes(granted,publicScopes);
        if(!effective.length)throw new AuthenticationError(403,'insufficient_scope');
        return {accountId:publicAccountId(payload.sub!),workspaceId:'public',subject:payload.sub!,scopes:effective};
      }
      throw new AuthenticationError(403,'access_denied');
    }
    const member=members[0]!,effective=effectiveScopes(granted,member.scopes);
    if(!effective.length)throw new AuthenticationError(403,'insufficient_scope',member.scopes[0]);
    return {accountId:member.accountId,workspaceId:member.workspaceId,subject:payload.sub!,scopes:effective};
  };
}

// Each tool names its scope; the effective scopes are token ∩ membership.
export function requireScope(account:Account,scope:Scope) {
  if(!account.scopes.includes(scope))throw new AuthenticationError(403,'insufficient_scope',scope);
}

export function resourceMetadata(config:GatewayConfig) {
  return {resource:config.resourceUrl,resource_name:'Arosa NYC property research',authorization_servers:[config.issuer],scopes_supported:[...scopes],bearer_methods_supported:['header']};
}

export function authenticationChallenge(config:GatewayConfig,error:AuthenticationError) {
  const metadata=new URL('/.well-known/oauth-protected-resource/mcp',config.resourceUrl).href;
  return `Bearer resource_metadata="${metadata}"${error.code==='access_denied'?'':`, error="${error.code}"`}${error.code==='insufficient_scope'?`, scope="${error.scope}"`:''}`;
}
