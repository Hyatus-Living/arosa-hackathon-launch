import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {existingGoogleAccountId} from './identity.js';
import {scopes} from './contracts.js';

export const membershipSchema=z.object({
  subject:z.string().min(1).max(300),
  accountId:z.string().regex(/^[a-f0-9]{24}$/).optional(),
  googleIapSubject:z.string().min(1).max(300).optional(),
  workspaceId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  enabled:z.boolean(),
  // Rows without scopes predate scoped access and keep read-only access.
  scopes:z.array(z.enum(scopes)).min(1).max(scopes.length).refine(list=>new Set(list).size===list.length).default(['acres:read']),
}).strict().superRefine((member,context)=>{
  if(!member.accountId&&!member.googleIapSubject)context.addIssue({code:'custom',message:'A verified account link is required.'});
  if(member.accountId&&member.googleIapSubject&&member.accountId!==existingGoogleAccountId(member.googleIapSubject))context.addIssue({code:'custom',message:'The account link conflicts with the existing Google namespace.'});
}).transform(member=>({subject:member.subject,accountId:member.googleIapSubject?existingGoogleAccountId(member.googleIapSubject):member.accountId!,workspaceId:member.workspaceId,enabled:member.enabled,scopes:member.scopes}));
export type Membership=z.infer<typeof membershipSchema>;
export interface GatewayConfig {
  resourceUrl:string;
  issuer:string;
  jwksUrl:string;
  backendUrl:string;
  serviceToken:string;
  allowedHosts:string[];
  allowedOrigins:string[];
  memberships:()=>Membership[];
  publicAccess:boolean;
  openaiChallengeToken?:string;
}

export function readMemberships(path:string):Membership[] {
  // An empty reviewed list boots the gateway but authorizes nobody. This lets
  // the real OAuth flow establish subjects before explicit account linking.
  const result=z.array(membershipSchema).max(500).safeParse(JSON.parse(readFileSync(path,'utf8')));
  if(!result.success)throw new Error('The MCP membership file is invalid.');
  const seen=new Set<string>();
  for(const member of result.data){const id=member.subject+'\n'+member.workspaceId;if(seen.has(id))throw new Error('Duplicate MCP membership.');seen.add(id);}
  return result.data;
}

export function loadConfig(env:NodeJS.ProcessEnv=process.env):GatewayConfig {
  const schema=z.object({
    MCP_PUBLIC_URL:z.url(),MCP_OAUTH_ISSUER:z.url(),MCP_OAUTH_JWKS_URL:z.url(),
    MCP_BACKEND_URL:z.url(),MCP_SERVICE_TOKEN:z.string().min(32),MCP_MEMBERSHIPS_FILE:z.string().min(1),
  });
  const result=schema.safeParse(env);
  if(!result.success)throw new Error('Missing or invalid MCP configuration: '+result.error.issues.map(issue=>issue.path.join('.')).join(', '));
  const value=result.data,resource=new URL(value.MCP_PUBLIC_URL),issuer=new URL(value.MCP_OAUTH_ISSUER),jwks=new URL(value.MCP_OAUTH_JWKS_URL),backend=new URL(value.MCP_BACKEND_URL);
  if([resource,issuer,jwks].some(url=>url.protocol!=='https:'||url.username||url.password||url.search||url.hash))throw new Error('Public MCP and OAuth URLs must be fixed HTTPS URLs.');
  if(resource.pathname!=='/mcp')throw new Error('The public MCP URL must end in /mcp.');
  if(!['https:','http:'].includes(backend.protocol)||backend.username||backend.password||backend.search||backend.hash||backend.pathname!=='/')throw new Error('Use a private backend origin without a path or credentials.');
  const allowedHosts=[resource.hostname,...(env.MCP_ALLOWED_HOSTS||'').split(',').filter(Boolean)];
  if(allowedHosts.some(host=>!/^[A-Za-z0-9.-]+$/.test(host)))throw new Error('MCP_ALLOWED_HOSTS must contain exact hostnames.');
  const allowedOrigins=[resource.origin,...(env.MCP_ALLOWED_ORIGINS||'').split(',').filter(Boolean)];
  if(allowedOrigins.some(origin=>{try{return new URL(origin).origin!==origin||!origin.startsWith('https://');}catch{return true;}}))throw new Error('MCP_ALLOWED_ORIGINS must contain exact HTTPS origins.');
  const openaiChallengeToken=env.OPENAI_APPS_CHALLENGE_TOKEN?.trim()||undefined;
  if(openaiChallengeToken&&!/^[A-Za-z0-9._~-]{1,512}$/.test(openaiChallengeToken))throw new Error('OPENAI_APPS_CHALLENGE_TOKEN must be the plain portal token.');
  readMemberships(value.MCP_MEMBERSHIPS_FILE);
  return {resourceUrl:resource.href,issuer:issuer.href,jwksUrl:jwks.href,backendUrl:backend.origin,serviceToken:value.MCP_SERVICE_TOKEN,allowedHosts,allowedOrigins,memberships:()=>readMemberships(value.MCP_MEMBERSHIPS_FILE),publicAccess:env.MCP_PUBLIC_ACCESS==='true',openaiChallengeToken};
}
