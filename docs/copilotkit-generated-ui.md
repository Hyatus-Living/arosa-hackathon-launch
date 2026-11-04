# CopilotKit generated UI in Arosa

Arosa uses one deliberately narrow slice of CopilotKit: the Open Generative
UI renderer from `@copilotkit/react-core/v2`. It does not use the CopilotKit
runtime, `BuiltInAgent`, `CopilotChat`, AG-UI transport, or CopilotKit
Intelligence threads.

That boundary is intentional. The research agent is the existing Codex
harness, and conversations, runs, sharing, sources, project state, rate
limits, and wallet metering already live in `acres-research` and its SQLite
store. The CopilotKit quickstart warns that registering `BuiltInAgent` as the
default agent replaces an existing agent rather than connecting to it. The
Next.js onboarding flow is therefore not the setup path for this repository.

References:

- [CopilotKit quickstart](https://docs.copilotkit.ai/quickstart)
- [Open Generative UI](https://docs.copilotkit.ai/generative-ui/open-generative-ui)

## Current flow

1. `acres-research/research.mjs` exposes a Codex dynamic tool named
   `generateSandboxedUi`. The tool is available to the final research turn,
   not to isolated fanout lanes, and is capped at three views per run.
2. `acres-research/generated-ui.mjs` validates the tool arguments and converts
   them to complete `OpenGenerativeUIContent`. HTML and CSS must be non-empty
   and within fixed size limits. External resources and network APIs are
   rejected before rendering.
3. The research service emits `ui.generated` for live display and persists the
   same content on the assistant message, so a saved conversation renders the
   same view after reload and for shared-thread participants.
4. `app-starter/public/app.js` lazily loads `genui/generated-ui.js` and its
   stylesheet only when a conversation contains generated UI.
5. `app-starter/frontend/generated-ui.jsx` mounts CopilotKit's
   `OpenGenerativeUIActivityRenderer` in an iframe-backed root and applies an
   additional strict content-security policy.

Unlike the CopilotKit runtime middleware, this path does not stream partial
tool arguments. The Codex tool boundary supplies complete arguments, so the
browser shows CopilotKit's generating placeholder until the iframe reports
that the interface is ready.

## Design and sandbox contract

The Arosa equivalent of CopilotKit's `designSkill` is the
`generateSandboxedUi` tool description in `acres-research/generated-ui.mjs`.
Keep design guidance there so every generated view follows the same Arosa
colors, spacing, typography, source labeling, and mobile rules.

The iframe is intentionally more restrictive than the public CopilotKit demo:

- no network requests or external CDN libraries;
- no forms, embeds, top navigation, downloads, or modals;
- no access to host storage, account data, or server credentials;
- inline HTML, CSS, and JavaScript only;
- fixed limits for HTML, CSS, functions, expressions, placeholders, and height.

Only one sandbox function is exposed:

- `sendPrompt({text})` asks the host app to submit a follow-up. It is limited
  to 400 characters and requires browser user activation in the React shim.
  The host application's normal sender, sharing, length, rate-limit, and
  wallet rules still apply.

Add a sandbox function only when a generated view needs a small, explicit
host capability. Define and validate it in
`app-starter/frontend/generated-ui.jsx`, describe it in the tool prompt, and
add tests for both allowed and rejected calls. Do not expose generic fetch,
storage, navigation, or credential-bearing APIs.

## Packages and build

CopilotKit is a build-time frontend dependency of `app-starter`:

- declared as `@copilotkit/react-core` and `@copilotkit/core` `^1.78.0`;
- currently resolved by the lockfile to the latest compatible 1.x release;
- bundled by `npm --prefix app-starter run build` into
  `public/genui/generated-ui.js` and `public/genui/generated-ui.css`;
- no CopilotKit runtime package, runtime URL, public license key, or model
  API key is required for this renderer-only integration.

The generated bundle is build output. Do not edit files under
`app-starter/public/genui/` directly.

## Local setup and verification

Install the repository dependencies that CI uses:

```sh
npm ci --ignore-scripts
npm --prefix app-starter ci
npm --prefix acres-mcp ci
```

Run the focused generated-UI tests:

```sh
node --test acres-research/generated-ui.test.mjs app-starter/tests/generated-ui-loader.test.mjs
```

Then run the repository gates and frontend build:

```sh
npm run check
npm run check:mcp
npm test
npm run test:mcp
npm --prefix app-starter test
npm --prefix app-starter run build
```

For a production change, deploy the research service before the web app when
both sides change. The old web app ignores the additive backend validation,
and the new web bundle can render previously saved generated UI.

## When to reconsider the full runtime

Adopt `CopilotRuntime` only as an explicit architecture migration, not as an
addon install. That work would need an AG-UI-compatible adapter or a
replacement agent, authenticated runtime routing through Arosa, a mapping
between CopilotKit threads and Arosa conversations, and preservation of
per-sender wallet and rate-limit accounting. `BuiltInAgent` must not be
registered as a silent replacement for the Codex research agent.
