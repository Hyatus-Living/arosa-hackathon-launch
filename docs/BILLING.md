# Free hosted access

Arosa is free to use. Signing in saves work and assigns each person their own daily allowance.
No card, prepaid balance, subscription, beta invitation or upgrade is required.

| Activity | Allowance per account per day |
| --- | ---: |
| Research requests, including listing investigations | 50 |
| AI illustrations | 20 |
| Photo selections | 100 |
| New 3D render jobs | 50 |

Allowances reset automatically at midnight in `America/New_York`, including daylight-saving
changes. Browsing, editing saved plans and downloading existing artifacts do not consume them.
Requests already saved under the same request ID and reused render artifacts do not consume a
second allowance. Dispatched image failures count because the provider may have done work.
Every account has the same limits; historical subscriptions and staff/beta labels do not bypass them.

`acres-research/plans.mjs` owns the defaults. Optional `DAILY_LIMITS` entries in the research
configuration override individual defaults for a self-hosted installation. Legacy
`FREE_RUNS_PER_MONTH`, `BETA_RUNS_PER_MONTH`, `PLAN_UNMETERED_EMAILS` and `BILLING_ENABLED`
do not restore paid access or monthly admission in the hosted service. The usage API returns each
remaining allowance and the next reset timestamp. Exhaustion returns HTTP 429 with
`daily_limit_reached`, the activity and reset time. It never offers payment.

New subscription and prepaid checkout routes return HTTP 410. Existing subscription records,
wallet ledgers and signed webhook delivery are retained for historical accounting; the change does
not cancel, refund or alter a past purchase. Provider usage recording continues independently of
user billing. The public MIT source is at https://github.com/Hyatus-Living/arosa-hackathon-launch.

## Historical prepaid-wallet design

The following documents the retained ledger and reconciliation format. It does not describe a
current paywall or authorize reactivation of charging.

### Previous product policy

Prepaid USD credits, no markup. $1 purchased adds 1,000,000 microcredits. Provider-reported USD costs are preferred. Codex subscription allocation and providers lacking trustworthy metering use an explicitly versioned estimate. This is cost recovery, not a claim that subscription tokens have API invoice prices. Card-processing fees are not deducted from purchased credits or separately passed through in this version.

The wallet shows available, held and total balances; $10/$25/$50 Stripe Checkout purchases; the current pricing policy; and the most recent 50 ledger records. Individual charges name the provider, operation, research run, policy version and reported/estimated basis. The complete ledger stays in Firestore. No browser balance, account identifier or claimed payment success can authorize funds.

## Storage and charging

Optional Firestore wallet storage uses the explicitly configured `ACRES_WALLET_PROJECT`, default database:

- `acres_wallets/{verifiedAccount}`: signed balance and nonnegative reserved funds.
- `operations/{sha256(reference)}` beneath each wallet: durable idempotency state.
- `ledger/{sha256(reference + ':' + kind)}`: immutable transaction entries.

Firestore REST commits update the balance, operation and ledger atomically using version/existence preconditions, with bounded contention retries. Google metadata supplies the attached short-lived identity. No key files, browser SDK or public database rules are needed. The app runtime and research identities require approved Firestore access. Existing SQLite conversations are untouched.

The research server authorizes each billable model invocation and every Composio discovery, pricing-metadata and execution request before sending it. Exa execution is labeled `exa`; other routed tools are labeled `composio`. Free NYC parcel/knowledge lookups have no additional wallet debit. Reservations prevent concurrent authorization from exceeding the available balance. Settlement releases the full hold and debits the measured/estimated cost. A provider-reported overage is recorded as actual debt and blocks future spending when funds are insufficient; reservations are **not** provider-enforced hard cost limits. Configure conservative holds and provider-side spending caps.

A timeout, crash or unrecognized cost does not imply a free call. Dispatched funds remain held for reconciliation. A chat run cut off by a restart is queued again once from its saved request only when every paid call it made had settled; the resumed attempt authorizes its calls under new references, so they are new charges. A run with a paid call still unresolved, or one a restart cut off before, fails in SQLite and does not repeat its provider calls. Undispatched holds may be released administratively. Replaying the same run/operation reference never reexecutes it. Interrupted inference settles observed usage when available; otherwise its hold remains unresolved. Costs are charged before answer validation, because invalid output can still incur provider expense.

## Usage traces and per-user totals

Arosa persists run events in its existing private SQLite database, joined to the verified account and conversation through the run record. Codex `turn.started` events record thread and turn identifiers; Meta lifecycle events retain the model and provider response context. `billing.usage` records input, cached-input and output counts when the provider reports them. Numeric usage counts survive credential redaction. Capture does not depend on the wallet billing flag, so deployment can collect usage before charging is enabled. Settled wallet operations also store their observed usage and cost-policy version in the account-scoped Firestore ledger when billing is enabled.

Scope is research runs through **Arosa**, across its conversations, excluding unrelated builder sessions. Codex runs create a fresh thread; Meta runs record their configured model and response lifecycle. Usage notifications are cumulative snapshots: select the latest valid snapshot per operation or response, never sum repeated notifications. Missing snapshots remain unknown. Historical stripped or missing token counts cannot be reconstructed from saved traces alone. Cost estimates require a configured policy; capture alone does not establish incurred USD cost.

General research, Modeling and Underwriting select their engines independently. Meta research records `meta_research` and lane operations under provider `meta`, with input, cached-input and output usage. Durable listing and CRM work retain Meta response IDs and usage across reconnections; replay upserts response-level usage rather than charging it again. Feedback and scheduled review record operator-owned provider usage, not user-wallet charges. Jev remains in decision and selection workflows. Legacy Gemini jobs retain their original provider for recovery.

## Metering adapters

The research service's private configuration may contain `BILLING_ENABLED: true` and a `BILLING_RATES` object. Billing defaults off. Rates are selected by exact operation slug, then provider fallback. A missing/invalid policy fails closed before that provider call. Configure the selected research engine (`meta` or `codex`), `composio_discovery`, `composio_metadata`, Exa slugs and each supported paid tool. Parallel research adds optional slugs `SERPER_SEARCH` (provider `serper`), `cloudflare_markdown` (provider `cloudflare`, settled with the reported `browserMs`; an `estimated_call` rate is the honest default until a browser-time rate exists), and per-invocation Codex operations `codex_lane_zoning`, `codex_lane_cases`, `codex_lane_comps`, `codex_judge`, each falling back to the `codex` provider rate. A fan-out provider with no configured rate fails that provider only; the remaining providers still run. Direct URL fetches without Cloudflare are unmetered like other free public lookups. A broad `composio` fallback should only be used if its cost model genuinely covers every allowed Instant tool.

Supported rate schemas (all amounts are integer USD microcredits):

- Common: `version`, explanatory `basis`, `reserveMicros` (positive), `mode`.
- `estimated_call`: `amountMicros` (nonnegative, no greater than reservation).
- `estimated_tokens`: `inputMicrosPerMillion`, `cachedInputMicrosPerMillion`, `outputMicrosPerMillion`. Counts come from provider usage, including Codex cumulative token totals and Meta input, cached-input and output usage. Missing counts stay unknown. Cached input is charged separately from uncached input; fractional microcredits round upward once per invocation.
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

Use only an approved administrator identity for your configured wallet project. The following source command has no public app endpoint:

```sh
node scripts/wallet-reconcile.mjs inspect ACCOUNT_NAMESPACE
node scripts/wallet-reconcile.mjs settle ACCOUNT_NAMESPACE OPERATION_REFERENCE 0.012345
node scripts/wallet-reconcile.mjs release ACCOUNT_NAMESPACE OPERATION_REFERENCE
```

Operation references appear in reservation ledger entries and take the form `RUN_UUID:SEQUENCE:OPERATION`. Confirm the provider's outcome and actual USD cost before settling. A definitive zero charge can settle a dispatched hold with `0`. `release` only accepts an undispatched `reserved` operation; it never releases a dispatched timeout blindly. References and account namespaces are operational data, not authentication credentials; inspect them only in approved private administration. Provider invoice ingestion, policy administration UI, automated aging, dispute resolution and auto-recharge are follow-up features.
