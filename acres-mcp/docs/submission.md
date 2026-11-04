# ChatGPT Plugins Directory submission

The Arosa tools publish to the universal Plugins Directory (ChatGPT + Codex)
as the `arosa` package in [`../plugin/`](../plugin/): root
`plugin.json` (Agent Plugins format), `mcp.json` (one remote server, OAuth
with Dynamic Client Registration), the `nyc-property-research` skill and
listing icons. Official flow:
<https://developers.openai.com/plugins/deploy/submission>.

## Status

| Gate | State |
| --- | --- |
| Live MCP endpoint `https://mcp.witharosa.ai/mcp` with OAuth discovery | Live |
| Public self-service accounts (`MCP_PUBLIC_ACCESS=true` + Arosa sign-up) | Code ready; needs gateway redeploy + auth deploy |
| Privacy / terms / support at witharosa.ai | In `site/public/`; live on merge to `main` |
| Plugin ZIP package | Built from `plugin/` (below) |
| Domain verification token | Gateway serves `OPENAI_APPS_CHALLENGE_TOKEN`; token comes from the portal |
| Reviewer demo account | Create with the operator endpoint (below) |
| OpenAI identity verification + Apps Management Write | Michael, in the OpenAI Platform organization |
| ChatGPT acceptance cases + demo video | Run the five positive and three negative cases in `plugin.json` in ChatGPT developer mode with the reviewer account; record the walkthrough |

## Build the ZIP

```sh
cd acres-mcp/plugin
zip -r /tmp/arosa-acres-plugin.zip plugin.json mcp.json skills assets
```

The ZIP root is the package root: `plugin.json` and `mcp.json` sit at the top
level. Never add secrets, `.env` files or credentials to the ZIP.

## Reviewer demo account

Create one pre-verified account whose password is known and entered only in
the portal's Review details (never in the ZIP, source or chat):

```sh
curl -X POST https://login.witharosa.ai/operator/create-user \
  -H "X-Arosa-Operator: $AROSA_OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"openai-review@witharosa.ai","name":"OpenAI Review","password":"<choose 15+ chars>"}'
```

The route is proxied; run it through the authenticated gateway path used for
other `/operator/*` calls. Verify the account signs in at
<https://login.witharosa.ai/sign-in> and completes the ChatGPT connection and
all five positive test cases before submitting.

## Portal sequence (Michael)

1. OpenAI Platform → organization settings: complete individual or business
   verification; ensure your user has Apps Management Write.
2. <https://platform.openai.com/plugins> → Upload new or existing plugin →
   verified developer identity → upload `arosa-acres-plugin.zip`.
3. Metadata & Skills: resolve any automated findings (fix package, re-upload).
4. MCPs → acres → Connect: the portal shows a domain-verification token.
   Set `OPENAI_APPS_CHALLENGE_TOKEN` on the `acres-mcp` Cloud Run service to
   that exact token and redeploy/revise, then confirm
   `curl https://mcp.witharosa.ai/.well-known/openai-apps-challenge` returns
   only the token. Connect and authorize with the reviewer account; check the
   tool scan lists exactly the ten tools with no findings. Only the six
   `acres:read` tools run for the reviewer's public account; the project
   state and admin tools answer with `INSUFFICIENT_SCOPE`.
5. Review information → Review details: confirm the imported five positive
   and three negative cases, add the demo recording URL, and enter the
   reviewer credentials (login URL `https://login.witharosa.ai/sign-in`,
   workspace `public`, no MFA or verification step).
6. Submit for review and complete the policy attestations. After approval,
   Publish plugin.

After publication, hosted tool changes are rescanned automatically; metadata
or skill changes need a new ZIP upload on the same plugin.
