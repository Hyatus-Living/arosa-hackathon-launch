#!/usr/bin/env node
// Arosa Pro sandbox setup: create (or find) the test product, its $100/mo and $600/yr prices,
// a billing-portal configuration, and the subscription webhook, then write the web app's env
// lines to a file OUTSIDE this repository. The secret key is read from STRIPE_SECRET_KEY in
// the environment and is never printed or written into the repo. Live keys are refused.
// The free-run limit (FREE_RUNS_PER_MONTH) is deliberately not set here: turn it on only
// after a test subscription verifies end to end (docs/BILLING.md, "Free plan and Arosa Pro").
//
// Usage:
//   STRIPE_SECRET_KEY=<test key> node scripts/stripe-sandbox-setup.mjs --out /path/outside/repo/arosa-stripe.env
//   node scripts/stripe-sandbox-setup.mjs --dry-run   (validates key shape, makes no API calls)
import {writeFileSync} from 'node:fs';
import {resolve, relative} from 'node:path';
import {pathToFileURL} from 'node:url';

export const PURPOSE = 'arosa-pro-v1';
export const WEBHOOK_URL = 'https://build.witharosa.ai/api/public/stripe/subscriptions';
export const EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed'];
export const PRICES = [
  {interval: 'month', amount: 10000, lookup: 'arosa_pro_monthly'},
  {interval: 'year', amount: 60000, lookup: 'arosa_pro_yearly'},
];

// Usage/key refusals exit 2 from the CLI, matching the script's original contract.
export class SetupUsageError extends Error {}

export function parseSetupArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const outIndex = argv.indexOf('--out');
  return {dryRun, outArg: outIndex >= 0 ? argv[outIndex + 1] : undefined};
}

export function assertSandboxSetupInput({dryRun, outArg, secretKey, cwd = process.cwd()}) {
  if (!dryRun && !outArg) throw new SetupUsageError('Pass --out <file outside this repository> for the env lines, or --dry-run.');
  if (!secretKey) throw new SetupUsageError('Set STRIPE_SECRET_KEY in the environment (a Stripe TEST key). It is never printed.');
  if (/^(sk|rk)_live_/.test(secretKey)) throw new SetupUsageError('Refusing a LIVE Stripe key. This setup is sandbox-only.');
  if (!/^(sk|rk)_test_/.test(secretKey)) throw new SetupUsageError('STRIPE_SECRET_KEY does not look like a Stripe test key (sk_test_/rk_test_). Refusing.');
  if (outArg) {
    const outPath = resolve(cwd, outArg);
    if (!relative(cwd, outPath).startsWith('..')) throw new SetupUsageError(`Refusing to write secrets inside the repository: ${outPath}`);
  }
}

export function buildEnvLines({secretKey, priceIds, webhookSecret}) {
  return [
    '# Arosa Pro SANDBOX env for the web app (app.env). Keep outside git. Test mode only.',
    `STRIPE_SECRET_KEY=${secretKey}`,
    'STRIPE_LIVE=false',
    `STRIPE_PRICE_PRO_MONTHLY=${priceIds.month}`,
    `STRIPE_PRICE_PRO_YEARLY=${priceIds.year}`,
    webhookSecret ? `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET=${webhookSecret}` : '# STRIPE_SUBSCRIPTION_WEBHOOK_SECRET=<reveal/roll the existing endpoint secret in the Stripe test dashboard>',
    '# Research service (/etc/acres-research/secrets.json): leave FREE_RUNS_PER_MONTH unset until',
    '# a test subscription verifies end to end; then set it to 10 and restart research.',
  ];
}

export async function runSandboxSetup({argv = [], secretKey = '', fetcher = fetch, cwd = process.cwd(), writeFile = writeFileSync} = {}) {
  const {dryRun, outArg} = parseSetupArgs(argv);
  assertSandboxSetupInput({dryRun, outArg, secretKey, cwd});
  if (dryRun) return {dryRun: true, keyMode: 'test', product: 'Arosa Pro', prices: PRICES, webhookUrl: WEBHOOK_URL, events: EVENTS};

  async function stripe(path, form, method = form ? 'POST' : 'GET') {
    const response = await fetcher('https://api.stripe.com/v1/' + path, {
      method,
      headers: {authorization: `Bearer ${secretKey}`, ...(form ? {'content-type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `arosa-sandbox:${PURPOSE}:${path}:${form.get('lookup_key') || form.get('url') || ''}`} : {})},
      ...(form ? {body: form.toString()} : {}),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Stripe ${method} ${path} failed (${response.status}): ${data?.error?.message || 'no message'}`);
    if (data.livemode === true) throw new Error(`Stripe ${path} returned a LIVE object in a sandbox setup. Stopping.`);
    return data;
  }
  const list = async path => (await stripe(path)).data || [];

  const products = await list('products?limit=100&active=true');
  let product = products.find(p => p.metadata?.purpose === PURPOSE);
  if (!product) product = await stripe('products', new URLSearchParams({name: 'Arosa Pro', description: 'Arosa Pro subscription (test mode)', 'metadata[purpose]': PURPOSE}));

  const existingPrices = await list(`prices?limit=100&active=true&product=${encodeURIComponent(product.id)}`);
  const priceIds = {};
  for (const spec of PRICES) {
    let price = existingPrices.find(p => p.lookup_key === spec.lookup) || existingPrices.find(p => p.currency === 'usd' && p.unit_amount === spec.amount && p.recurring?.interval === spec.interval);
    if (!price) price = await stripe('prices', new URLSearchParams({product: product.id, currency: 'usd', unit_amount: String(spec.amount), 'recurring[interval]': spec.interval, lookup_key: spec.lookup, 'metadata[purpose]': PURPOSE}));
    priceIds[spec.interval] = price.id;
  }

  let portal = 'not configured';
  try {
    const configs = await list('billing_portal/configurations?limit=10');
    if (configs.length) portal = `existing (${configs[0].id})`;
    else {
      const form = new URLSearchParams({'business_profile[headline]': 'Arosa Pro', 'features[payment_method_update][enabled]': 'true', 'features[subscription_cancel][enabled]': 'true', 'features[subscription_cancel][mode]': 'at_period_end', default_return_url: 'https://build.witharosa.ai/?plan=manage'});
      portal = `created (${(await stripe('billing_portal/configurations', form)).id})`;
    }
  } catch (error) { portal = `FAILED, configure the Customer Portal in the Stripe test dashboard: ${error.message}`; }

  let webhookSecret = null, webhookNote = '';
  const endpoints = await list('webhook_endpoints?limit=100');
  const endpoint = endpoints.find(e => e.url === WEBHOOK_URL);
  if (endpoint) webhookNote = `Webhook endpoint already exists (${endpoint.id}); its signing secret cannot be retrieved. Reveal/roll it in the Stripe test dashboard and set STRIPE_SUBSCRIPTION_WEBHOOK_SECRET from there.`;
  else {
    const form = new URLSearchParams({url: WEBHOOK_URL, description: 'Arosa Pro subscriptions (test mode)', 'metadata[purpose]': PURPOSE});
    EVENTS.forEach((event, i) => form.set(`enabled_events[${i}]`, event));
    webhookSecret = (await stripe('webhook_endpoints', form)).secret;
    webhookNote = 'Webhook endpoint created; its signing secret is in the env file (shown nowhere else).';
  }

  const outPath = resolve(cwd, outArg);
  writeFile(outPath, buildEnvLines({secretKey, priceIds, webhookSecret}).join('\n') + '\n', {mode: 0o600});
  return {mode: 'test', product: product.id, prices: priceIds, portal, webhook: webhookNote, envFile: outPath, freeRunLimit: 'left OFF'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    console.log(JSON.stringify(await runSandboxSetup({argv: process.argv.slice(2), secretKey: process.env.STRIPE_SECRET_KEY || ''}), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(error instanceof SetupUsageError ? 2 : 1);
  }
}
