import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const resolver = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'openclaw-gsm-resolver.mjs');

function run(request) {
  return new Promise((resolve, reject) => {
    // Spawn via the current node: the installed file's shebang targets the VM's /usr/local/bin/node.
    const child = spawn(process.execPath, [resolver], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
    child.stdin.end(JSON.stringify(request));
  });
}

test('gsm resolver answers empty id sets without network access', async () => {
  const {code, stdout} = await run({protocolVersion: 1, provider: 'gsm', ids: []});
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {protocolVersion: 1, values: {}, errors: {}});
});

test('gsm resolver fails closed on unmapped ids without network access', async () => {
  const {code, stdout} = await run({protocolVersion: 1, provider: 'gsm', ids: ['openclaw/unknown', 'anything/else']});
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.values, {});
  assert.deepEqual(out.errors, {'openclaw/unknown': {code: 'NOT_FOUND'}, 'anything/else': {code: 'NOT_FOUND'}});
});

test('gsm resolver rejects unsupported protocol versions', async () => {
  const {code, stdout} = await run({protocolVersion: 2, provider: 'gsm', ids: []});
  assert.notEqual(code, 0);
  assert.equal(stdout, '');
});
