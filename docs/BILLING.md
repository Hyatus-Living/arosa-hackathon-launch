# Arosa prepaid wallet

## Product policy

Prepaid USD credits, no markup. $1 purchased adds 1,000,000 microcredits. Provider-reported USD costs are preferred. Codex subscription allocation and providers lacking trustworthy metering use an explicitly versioned estimate. This is cost recovery, not a claim that subscription tokens have API invoice prices. Card-processing fees are not deducted from purchased credits or separately passed through in this version.

The wallet shows available, held and total balances; $10/$25/$50 Stripe Checkout purchases; the current pricing policy; and the most recent 50 ledger records. Individual charges name the provider, operation, research run, policy version and reported/estimated basis. The complete ledger stays in Firestore. No browser balance, account identifier or claimed payment success can authorize funds.

## Storage and charging

Firestore in project `hyatus-openclaw`, default database:

- `acres_wallets/{verifiedAccount}`: signed balance and nonnegative reserved funds.
- `operations/{sha256(reference)}` beneath each wallet: durable idempotency state.
- `ledger/{sha256(reference + ':' + kind)}`: immutable transaction entries.

Firestore REST commits update the balance, operation and ledger atomically using version/existence preconditions, with bounded contention retries. Google metadata supplies the attached short-lived identity. No key files, browser SDK or public database rules are needed. The app runtime and research identities require approved Firestore access. Existing SQLite conversations are untouched.

The research server authorizes each Codex invocation and every Composio discovery, pricing-metadata and execution request before sending it. Exa execution is labeled `exa`; other routed tools are labeled `composio`. Free NYC parcel/knowledge lookups have no additional wallet debit. Reservations prevent concurrent authorization from exceeding the available balance. Settlement releases the full hold and debits the measured/estimated cost. A provider-reported overage is recorded as actual debt and blocks future spending when funds are insufficient; reservations are **not** provider-enforced hard cost limits. Configure conservative holds and provider-side spending caps.

A timeout, crash or unrecognized cost does not imply a free call. Dispatched funds remain held for reconciliation. A chat run cut off by a restart is queued again once from its saved request only when every paid call it made had settled; the resumed attempt authorizes its calls under new references, so they are new charges. A run with a paid call still unresolved, or one a restart cut off before, fails in SQLite and does not repeat its provider calls. Undispatched holds may be released administratively. Replaying the same run/operation reference never reexecutes it. Interrupted inference settles observed usage when available; otherwise its hold remains unresolved. Costs are charged before answer validation, because invalid output can still incur provider expense.

## Usage traces and per-user totals

Arosa persists run events in its existing private SQLite database, joined to the verified account and conversation through the run record. `turn.started` records the Codex thread/turn identifiers; `billing.usage` records input, cached-input and output counts when the harness reports them. Numeric usage counts survive credential redaction. Capture does not depend on the wallet billing flag, so deployment can collect usage before charging is enabled. Settled wallet operations also store their observed usage and cost-policy version in the account-scoped Firestore ledger when billing is enabled.

Scope is all research runs through **Arosa**, across its conversations—not unrelated builder or other Codex sessions. Each research run currently creates a fresh Codex thread. Usage notifications are cumulative snapshots; totals must select the latest valid snapshot per run/thread, never sum every notification. Missing snapshots remain unknown. There is not yet a per-user aggregation/reporting API or dashboard, and historical stripped/missing token counts cannot be reconstructed from saved traces alone. Cost estimates require a configured policy; capture alone does not establish incurred USD cost.

## Metering adapters

The research service's private configuration may contain `BILLING_ENABLED: true` and a `BILLING_RATES` object. Billing defaults off. Rates are selected by exact operation slug, then provider fallback. A missing/invalid policy fails closed before that provider call. Configure `codex`, `composio_discovery`, `composio_metadata`, Exa slugs and each supported paid tool. Parallel research adds optional slugs `SERPER_SEARCH` (provider `serper`), `cloudflare_markdown` (provider `cloudflare`, settled with the reported `browserMs`; an `estimated_call` rate is the honest default until a browser-time rate exists), and per-invocation Codex operations `codex_lane_zoning`, `codex_lane_cases`, `codex_lane_comps`, `codex_judge`, each falling back to the `codex` provider rate. A fan-out provider with no configured rate fails that provider only; the remaining providers still run. Direct URL fetches without Cloudflare are unmetered like other free public lookups. A broad `composio` fallback should only be used if its cost model genuinely covers every allowed Instant tool.

Supported rate schemas (all amounts are integer USD microcredits):

- Common: `version`, explanatory `basis`, `reserveMicros` (positive), `mode`.
- `estimated_call`: `amountMicros` (nonnegative, no greater than reservation).
- `estimated_tokens`: `inputMicrosPerMillion`, `cachedInputMicrosPerMillion`, `outputMicrosPerMillion`. Counts come from Codex `thread/tokenUsage/updated` cumulative totals. Missing counts stay unknown. Cached input is charged separately from uncached input; fractional microcredits round upward once per invocation.
- `reported_usd`: `currency: "USD"`, `chargeField` (explicit dotted response path). Accepts a nonnegative USD decimal with at most six decimals. Do not point this at an ambiguous count of provider credits.

No rates are shipped: actual provider prices, subscription allocation and units have not been verified. `instant_charge` exists in current Composio responses, but its shape, currency, inclusion of tool costs and availability for connected Exa must be verified with the current provider contract. A developer-platform switch may improve usage attribution; this implementation does not claim it is required or already completed. Discovery pricing metadata is not itself proof of the final execution charge. An operation's policy must account for its aggregate incurred cost exactly once, rather than double charging a tool cost already included in Composio's total. This version supports one aggregate reported or estimated charge per provider request, not an invoice-import reconciliation connector.

Always record subscription allocation as **estimated**, even if token rates are used. Keep policy versions stable; change the version when rates/basis change. Unrecognized reported fields leave holds pending, not zero-priced. Fixed-call estimates apply to completed provider responses, including failed responses that may incur expense; network failures remain pending.

## Stripe and activation

Cloud Run environment (managed outside this repository):

- `BILLING_ENABLED=true` only when both backend metering and payments are ready.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, supplied via managed secret bindings.
- `STRIPE_LIVE=true` for live Stripe; default false for test mode.

Stripe subscriptions/taxes/auto-top-up are not enabled. Hosted Checkout accepts USD card purchases only. The backend generates account metadata and amount; the browser chooses only a permitted denomination. A stable request UUID protects Checkout retries. Credits are added only by a signed, paid Checkout event, never by the success redirect. Webhook signatures use the original bytes and a five-minute timestamp window. Test/live environments must match.

Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, and `charge.dispute.created`. Refunds reconcile their original paid purchase before applying a cumulative debit, so out-of-order and duplicate events cannot create free credits. Negative balances after spent-credit refunds block further spending. A dispute freezes new purchases and usage pending administrative review; unfreezing/resolution is deliberately not automated. Verify funds movement before changing the dispute flag.

**IAP stays enabled. Stripe cannot deliver directly to this private service.** An administrator must prepare an approved external receiver/relay that preserves the exact raw body and Stripe signature and authenticates to IAP, or an equivalent approved integration. This change does not create a public service, alter Google access, install runtime secrets or enable charging. Signed hooks remain protected even behind the relay. App-side browser authentication is intentionally not required on the webhook route; infrastructure IAP and Stripe verification remain required.

The Cloud Run wallet validates that the research backend is billing-enabled with a valid Codex policy before displaying active pricing or creating purchases. Enable frontend only after backend readiness; until then keep both billing flags off. Billing during the pilot remains disabled.

## Review and release

1. Run `npm run check`, `npm test`, and `npm --prefix app-starter run build`.
2. Push `builder/prepaid-wallet`; an authorized maintainer must review and squash-merge the signed review PR.
3. An administrator must install the updated fixed research installer (`infra/acres-deploy-research`), which adds `wallet.mjs` to its explicit allowlist. Updating the repository copy does not update the running installer. Prepare Firestore access, Stripe secrets, private metering policy and approved webhook delivery separately; do not put secrets in the repository or shared chat.
4. Pull merged main; request research deployment, verify `.deploy-research-result`, then deploy `app-starter`. Its Docker build now uses the repository root to include the shared wallet module; only explicit app files enter the image. Keep IAP, minimum instances 0 and maximum 2.
5. In Stripe test mode verify signed-in wallet isolation, real Checkout and webhook crediting, duplicate delivery, concurrent paid calls, estimated/reported labels, actual provider usage, timeout/restart holds, partial/full refunds and disputes. Verify the live protected app/API before enabling live payments. Unit tests do not establish live payment readiness.

## Reconciliation

Use only an approved administrator identity attached to `hyatus-openclaw`. The following source command has no public app endpoint:

```sh
node scripts/wallet-reconcile.mjs inspect ACCOUNT_NAMESPACE
node scripts/wallet-reconcile.mjs settle ACCOUNT_NAMESPACE OPERATION_REFERENCE 0.012345
node scripts/wallet-reconcile.mjs release ACCOUNT_NAMESPACE OPERATION_REFERENCE
```

Operation references appear in reservation ledger entries and take the form `RUN_UUID:SEQUENCE:OPERATION`. Confirm the provider's outcome and actual USD cost before settling. A definitive zero charge can settle a dispatched hold with `0`. `release` only accepts an undispatched `reserved` operation; it never releases a dispatched timeout blindly. References and account namespaces are operational data, not authentication credentials; inspect them only in approved private administration. Provider invoice ingestion, policy administration UI, automated aging, dispute resolution and auto-recharge are follow-up features.

## Free plan and Arosa Pro

Everyone can use Arosa. Browsing listings is unlimited; research runs (each message to Arosa, each
underwriting step, and each listing investigation started) count against a monthly free allowance
that resets on the first of the month, UTC. A run counts against the person who sends it. Arosa Pro
removes the limit for $100 a month or $600 a year. `@witharosa.ai` accounts, admins and any email in
`PLAN_UNMETERED_EMAILS` are unlimited.

- Research (`/etc/acres-research/secrets.json`): `FREE_RUNS_PER_MONTH` (integer) turns the limit on;
  without it nobody is limited. `PLAN_UNMETERED_EMAILS` (array) lists extra unlimited accounts.
  `acres-research/plans.mjs` keeps a `subscriptions` table in `chat.sqlite` that mirrors Stripe.
- Web app (`app.env`): `STRIPE_SECRET_KEY`, `STRIPE_LIVE`, `STRIPE_PRICE_PRO_MONTHLY`,
  `STRIPE_PRICE_PRO_YEARLY` and `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`. Without all of them the
  Upgrade button stays visible but closed.
- Stripe: two recurring prices on one Arosa Pro product, a customer portal configuration (cancel and
  payment-method updates), and a webhook endpoint at
  `https://build.witharosa.ai/api/public/stripe/subscriptions` for `checkout.session.completed` and
  `customer.subscription.created`, `.updated`, `.deleted`, `.paused` and `.resumed`. Cloudflare
  Access must let `/api/public/stripe/subscriptions` through without sign-in; the Stripe signature
  authenticates it.

Turn on the limit only after checkout works end to end, so nobody hits it without a way to upgrade.

Sandbox setup: `scripts/stripe-sandbox-setup.mjs` creates the test product, both prices,
a portal configuration and the webhook above, and writes the web app env lines to a file
outside this repository (`--out <path>`, mode 0600). It reads `STRIPE_SECRET_KEY` from the
environment, refuses live keys, and never prints a secret. Checkout is Stripe-hosted and
created server-side, so the app needs no publishable (`pk_test_`) key. One command, with
the Stripe **test** secret in the environment (never in the repo or chat):

```sh
STRIPE_SECRET_KEY=<test key> node scripts/stripe-sandbox-setup.mjs --out /path/outside/repo/arosa-stripe.env
```

Then install the env lines into `/etc/arosa-acres.env` on the app host and restart
`acres-secrets.service` and the app. Durable route: store `STRIPE_SECRET_KEY` and
`STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` in Secret Manager as `acres-stripe-secret-key` and
`acres-stripe-subscription-webhook-secret`; `infra/acres-pull-secrets` pulls them as
optional app env keys (billing stays closed while they are missing, and fetched values
override the template lines). The price ids and `STRIPE_LIVE` are not secrets and stay in
the template. Keep
`FREE_RUNS_PER_MONTH` unset until a test subscription (card 4242…, a non-`@witharosa.ai`
test account) verifies: `/api/plan` shows Pro, webhook deliveries return 200, and the
portal opens. An unauthenticated POST to the webhook URL must return the app's JSON
signature error, not a Cloudflare Access redirect; on or after the Oct 22 Cloudflare
account move, recreate the Access bypass app in the new org first
(`docs/arosa-cloudflare-cutover.md`).
