#!/usr/local/bin/node
// OpenClaw exec SecretRef resolver backed by Google Secret Manager, using the VM's own
// identity (metadata token; secretAccessor on exactly the mapped secrets). Protocol v1:
// stdin {protocolVersion, provider, ids} -> stdout {protocolVersion, values, errors}.
// Ref ids are allowlisted here; anything unmapped is NOT_FOUND, never guessed.
// Source of truth is this repo file; acres-deploy-research installs it to
// /usr/local/bin/openclaw-gsm-resolver.mjs on the builder VM.
const PROJECT = 'hyatus-openclaw';
const MAP = {
  'openclaw/typesafe/apiKey': 'acres-typesafe-api-key',
  'openclaw/gateway/password': 'openclaw-gateway-password',
};

const readStdin = () => new Promise((resolve, reject) => {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk.toString(); });
  process.stdin.on('end', () => resolve(input));
  process.stdin.on('error', reject);
});

async function token() {
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {headers: {'Metadata-Flavor': 'Google'}});
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  return (await res.json()).access_token;
}

async function access(tok, secretId) {
  const res = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${secretId}/versions/latest:access`, {headers: {Authorization: `Bearer ${tok}`}});
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`secret ${secretId} access ${res.status}`);
  return Buffer.from((await res.json()).payload.data, 'base64').toString('utf8');
}

const request = JSON.parse((await readStdin()) || '{}');
if (request.protocolVersion !== 1) throw new Error('Unsupported SecretRef protocolVersion');
const ids = Array.isArray(request.ids) ? request.ids.filter(id => typeof id === 'string' && id.length > 0) : [];
const values = {}, errors = {};
// Unmapped ids fail closed without any network call.
const mapped = [];
for (const id of ids) {
  if (MAP[id]) mapped.push(id);
  else errors[id] = {code: 'NOT_FOUND'};
}
if (mapped.length) {
  const tok = await token();
  for (const id of mapped) {
    const value = await access(tok, MAP[id]);
    if (value === null || value === '') errors[id] = {code: 'NOT_FOUND'};
    else values[id] = value;
  }
}
process.stdout.write(JSON.stringify({protocolVersion: 1, values, errors}));
