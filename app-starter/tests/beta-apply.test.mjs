import test from 'node:test';
import assert from 'node:assert/strict';
import {betaApplyAllowed} from '../beta-apply.mjs';
import {betaApplicationProblem} from '../../site/public/beta.js';
import {countText} from '../../site/public/beta-motion.js';

test('one address may apply five times an hour, then waits for the window to pass', () => {
  const log = new Map();
  for (let i = 0; i < 5; i++) assert.equal(betaApplyAllowed(log, '1.2.3.4', 1000 + i), true);
  assert.equal(betaApplyAllowed(log, '1.2.3.4', 2000), false);
  assert.equal(betaApplyAllowed(log, '5.6.7.8', 2000), true, 'another address is unaffected');
  assert.equal(betaApplyAllowed(log, '1.2.3.4', 1000 + 3600000), true, 'the window rolls');
});

test('the beta form asks for a name, a valid email and a role before sending', () => {
  assert.equal(betaApplicationProblem({name: '', email: 'a@b.co', role: 'developer'}), 'Enter your name.');
  assert.equal(betaApplicationProblem({name: 'Dana', email: 'dana@', role: 'developer'}), 'Enter a valid email address.');
  assert.equal(betaApplicationProblem({name: 'Dana', email: 'dana@example.com', role: ''}), 'Choose what best describes you.');
  assert.equal(betaApplicationProblem({name: 'Dana', email: 'dana@example.com', role: 'developer'}), '');
});

test('a counting figure starts at zero, rises without overshooting and lands on its exact text', () => {
  assert.equal(countText({to: 12000, suffix: '+'}, 0), '0+');
  assert.equal(countText({to: 12000, suffix: '+'}, 1), '12,000+');
  assert.equal(countText({to: 5, prefix: '$', suffix: 'M'}, 1), '$5M');
  assert.equal(countText({to: 50, suffix: '%'}, 2), '50%', 'progress past the end holds the final value');
  const shown = [0.1, 0.3, 0.5, 0.8].map((p) => Number(countText({to: 46000}, p).replace(/,/g, '')));
  assert.deepEqual(shown, [...shown].sort((a, b) => a - b));
  assert.ok(shown.every((n) => n > 0 && n < 46000));
});
