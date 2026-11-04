# Arosa Hackathon Launch

Help New York build more housing. Arosa helps homeowners, small builders and developers understand what a New York lot could become, connecting property and zoning research with building options, independent Underwriting, editable plans and interactive walkthroughs. The goal is to make housing opportunities clearer in a city facing a housing affordability crisis, before professional design and approvals.

Explore the product at [witharosa.ai](https://witharosa.ai/) or [open Modeling](https://app.witharosa.ai/modeling). [Watch One more home, with Muse](https://videos.gptguest.com/s/j8yg9afw1qhfz7s). The demonstration follows an Astoria question: could one more home fit while keeping the existing building? Sources and assumptions remain visible, and conceptual illustrations stay separate from measured geometry.

This repository contains the full Arosa application source: the website, web application and API, research service, independent Modeling and Underwriting workflows, planning tools, Pascal integration, Blender worker, MCP service, tests and deployment recipes. This is the public launch repository for the Meta Global AI Developer Hackathon. Its Git history begins with the complete application snapshot published here; source provenance and project attribution are recorded in [CONTRIBUTIONS.md](CONTRIBUTIONS.md).

Run the research service, gateway and rendering worker with your own providers and sign-in using the [self-hosting guide](docs/SELF_HOSTING.md). Local startup keeps authentication enabled; paid billing is documented separately.

## Try the interface locally

Use Node 24 or newer. From this directory:

```sh
npm ci
npm --prefix app-starter ci
npm --prefix app-starter run build
node app-starter/tests/plan-page-fixture/server.mjs
```

Open http://127.0.0.1:4795/sites/fx-plan/plan for the editable sample plan, then use the Modeling navigation. This loopback-only development server uses synthetic data and in-memory storage. It is a UI demonstration, not a live zoning or Meta research run. Do not deploy it publicly.

For the broader site and Underwriting UI preview:

```sh
node scripts/ui-preview/server.mjs
```

Open http://127.0.0.1:8090. Both previews use the real frontend. Saved projects in these previews do not survive a restart.

## Run the services

The complete runtime code is here. A production installation needs its own authentication, data stores, provider credentials and worker installation. The included infrastructure files are reference configurations from Arosa; review and adapt their project IDs, hostnames and paths before running a deployment. They do not grant access to Arosa's infrastructure. No automatic deployment is connected to this repository.

- `app-starter/`: React/Three.js viewers, web pages, Express gateway, project authorization, wallet and sharing.
- `acres-research/`: research tools and agents, source registry, durable project state, Underwriting, market research, listings, CRM, alerts and Meta image workflows.
- `planning/`: geometry, floor-plan editing, IFC import/export, scan validation and Pascal scene export/import.
- `worker/`: versioned Blender/Bonsai rendering, editable `.blend`, GLB and previews. See [worker setup](docs/architecture-worker.md).
- `acres-mcp/`: OAuth-protected property and evidence tools.
- `site/`: public website and help pages.
- `infra/` and `scripts/`: service and deployment recipes. GCP is the reference hosting target.

See [research setup](acres-research/README.md), [app deployment](docs/arosa-deployment.md), and [architecture plan format](docs/architecture-plan.md). Configure your own `AROSA_ADMIN_EMAILS`; web admin access has no built-in operator accounts.

## Meta integration

Muse Spark can run the registered research and architectural tools. Set `RESEARCH_ENGINE` to `meta` and provide `MODEL_API_KEY` in the research service's private JSON configuration. `MODELING_RESEARCH_ENGINE` and `UNDERWRITING_RESEARCH_ENGINE` can override that choice independently. Selecting the same model does not couple their projects, state or workflow. A failed Meta call does not silently switch providers.

SAM 3.1 selections guide Muse Image illustrations. Editable plans and geometric checks remain separate from generated imagery. The Blender worker executes deterministic scripts against plan-derived IFC and produces editable artifacts; it is not a desktop computer-use agent.

Jev is retained for decision and selection tasks, including listing-filter interpretation and knowledge-source routing. Its role is disclosed alongside Meta rather than presenting Arosa as exclusively Meta-powered.

New listing and CRM deep research use durable Meta responses; historical Gemini jobs retain their provider for recovery. Feedback and the scheduled improvement judge also use Meta, with operator-owned usage logging. Data retrieval continues through configured services such as Exa and Firecrawl. The [submission guide](docs/hackathon/index.html) records the remaining migration and live verification steps.

## Verify

```sh
npm --prefix acres-mcp ci
python3 -m venv planning/.venv
planning/.venv/bin/pip install -r planning/requirements.txt
npm run check
npm run check:mcp
npm test
```

Python 3.13 is the reference interpreter. The worker contract tests use a fake Blender process; run the worker's own health and render checks when installing real Blender. Live provider calls require your own credentials. Frontend smoke tests are separate from unit tests.

## Hackathon contributions

Arosa is being built for the Meta Global AI Developer Hackathon. [CONTRIBUTIONS.md](CONTRIBUTIONS.md) records the project timeline supplied by Michael Ort, the exact source snapshot used for this launch repository, and third-party attribution. The [Startup submission guide](docs/hackathon/index.html) maps the requirements, architecture and three-minute demonstration.

## License and data

Arosa-authored source and documentation are licensed under [MIT](LICENSE), copyright 2026 Hyatus Living. Third-party packages, Blender/Bonsai, SAM, fonts and visual assets retain their own licenses; see [LICENSES.md](LICENSES.md). API access and external data are governed by their providers' terms. This repository does not include API keys, private deployment credentials, customer databases or private Git history.

Models and research are preliminary planning aids. They are not permits, surveys, final legal determinations or construction documents.
