# Arosa knowledge pipeline

Arosa stores public source documents separately from chat history. The initial registry covers NYC short-term rental guidance, registration rules and the NYC Buildings copy of the New York Multiple Dwelling Law. This is a bounded corpus, not comprehensive zoning or case-law coverage.

## Storage and retrieval

`knowledge.sqlite` resides beside `chat.sqlite` in the private Arosa state directory. It retains original HTML/PDF bytes, content hashes, extracted text, immutable source versions, structured metadata and paragraph chunks. Each changed chunk is embedded once per configured embedding space. SQLite FTS5 and exact vector similarity provide hybrid retrieval after jurisdiction filtering. NYC queries include state and federal documents when present. Topic labels boost rather than exclude results.

The default storage engine deliberately shares the existing SQLite operational model. At larger scale, move the same source/version/chunk boundaries into PostgreSQL with pgvector and PostGIS. Do not introduce approximate retrieval without testing filtered recall.

Unknown legal effective dates remain null. Historical searches require known effective ranges and report incomplete coverage. Current searches exclude future-effective provisions. A recently downloaded document does not establish that its legal text remains controlling. The state-law copy explicitly warns that the Senate source may have later amendments.

## Configuration

Create `/etc/acres-research/knowledge.json` owned by root:openclaw with mode 0640, using the authorized secret store. Never commit its contents. It accepts `OPENROUTER_API_KEY` for embeddings. The default embedding model is `openai/text-embedding-3-small`; custom compatible endpoints use `KNOWLEDGE_EMBEDDING_URL`, `KNOWLEDGE_EMBEDDING_API_KEY` and `KNOWLEDGE_EMBEDDING_MODEL`.

For Jev classification, supply `TYPESAFE_API_KEY`. Set `KNOWLEDGE_CLASSIFIER_PROVIDER` to `openrouter` to explicitly select the alternative classifier, which uses the same OpenRouter key and defaults to `openai/gpt-4.1-mini`. `KNOWLEDGE_CLASSIFIER_MODEL` overrides that model. There is no silent classifier-provider switch. Classifier failures preserve the prior published version.

`ACRES_KNOWLEDGE_CONFIG` and `ACRES_KNOWLEDGE_DB` override the configuration and database paths for local verification. All credentials remain server-side. The application never gives them to the Codex child or browser.

## Installation and operation

Deploy the research modules through the existing research deployment workflow. On the dedicated research VM, install `poppler-utils` for PDF extraction and run `sudo bash infra/acres-install-knowledge` from the canonical checkout after the private configuration exists. The installer installs locked parser dependencies, performs the initial refresh and enables the timers. The application service does not need write access outside its existing state directory.

The daily timer runs at 4:00 a.m. Eastern with up to ten minutes of jitter. The queue timer checks bounded on-demand requests every five minutes. Both use the same ingester and a shared lease. No source URLs supplied by chat are fetched: only the registry's approved hosts and identifiers are allowed. Redirects are checked before following them.

Use `node /opt/acres-research/knowledge-query.mjs status` to inspect source success times and errors. Use `... knowledge-query.mjs search 'Can I rent my apartment on Airbnb?'` for an evidence retrieval check. Use `... knowledge-query.mjs refresh nyc-ose-host-faq` to queue that source, or start `acres-knowledge.service` to refresh the complete registry. These commands should run as the existing openclaw service user.

## Chat tools and diagnostics

- `acres_search_knowledge`: retrieves eligible passages with citation IDs, source versions, effective dates and freshness.
- `acres_get_knowledge_source`: retrieves a version already discovered during that turn.
- `acres_refresh_knowledge`: queues an existing source, with per-source request deduplication.

Each search stores its query, jurisdiction filters, retrieval mode, candidate count, latency and returned version IDs. Retrieval traces are retained for 30 days. Existing chat tool events carry these results into the account-scoped run trace. Ingestion runs record per-source changes and failures. Source failures do not update `last_success` or delete old evidence. Scheduled failures are visible through systemd status and the ingestion records.

If embeddings fail during a query, keyword retrieval continues with an explicit degradation notice. If the corpus is missing, the tool reports that it is unavailable and the harness may use its existing public research tools. No generated answer is automatically promoted to a verified fact.

`acres_get_knowledge_source` reads an exact version discovered in the current request. Each response is bounded to 24,000 characters and includes `offset`, `totalCharacters` and `nextOffset`. Pass `nextOffset` as `offset` to read later pages when useful; a null value means the version is fully read. Later pages retain their own citation IDs and excerpts. This makes complete stored versions accessible without loading a long document into every answer or removing the source-access guard.

## External source discovery registry

The separate `source_registry` table is a directory of external information, not part of the ingested document corpus. Its approved definitions live in `source-registry.json`. The initial entries cover PLUTO, GeoSearch, the Zoning Resolution, ZoLa and BSA applications. `acres_search_source_registry` applies an additive, idempotent migration and syncs these definitions into the same SQLite database when first used. No external content is fetched during registration or search.

Each row represents one source edition and jurisdiction. Indexed scalar fields are `id`, `name`, `publisher`, `jurisdiction`, `authority`, `method`, `status`, `last_verified_at` and `enabled`. A JSON `metadata` field contains categories, answerable questions, keywords, access points, source outline, identifiers, retrieval templates, prerequisites, restrictions, limitations and verification evidence. Verification dates in the seed are day precision. Metadata verification is distinct from a dataset's publication or legal effective date.

The derived FTS5 index searches names, questions, keywords and outlines. A `(jurisdiction, enabled, method)` index supports scoped selection. Search includes the requested jurisdiction's state/country parents and never automatically crosses into another city. Optional categories are exact filters. Search returns at most ten candidates and labels verification older than 90 days as due for review. This is a review hint, not an expiration date or an automatic monitoring job. For this small directory, lexical search avoids an embedding dependency; semantic ranking can reuse the existing embedding provider if measured recall requires it later.

The harness selects relevant sources and uses existing tools to retrieve current data. PLUTO and GeoSearch templates point to `acres_find_property`. Website templates require `acres_discover_tools` and `acres_execute_tool`, or browser capabilities where explicitly stated. Templates are declarative hints, never executable SQL, shell commands or permissions. The registry adds no arbitrary URL fetcher, credential access or writes. Metadata search does not add citation IDs; only retrieved source content enters the existing evidence flow.

If a source is incomplete or unavailable, report that limitation, try another appropriate candidate or discover a public research tool. A missing identifier can require clarification. A failed search is not evidence that a regulation or decision does not exist. The BSA and ZoLa entries deliberately distinguish tested landing pages from untested interactive retrieval. Authors update the approved manifest after verifying a changed access path; set `enabled: false` to retire a source while retaining its metadata. Removing a manifest entry alone does not delete or disable its database row.

For example, registry discovery for “What zoning applies at 120 Broadway in Manhattan?” finds parcel and regulatory sources. `acres_find_property` then retrieves the current published PLUTO row and creates an evidence citation. A local live check returned BBL 1000477501, district C5-5, special-district code LM and release 26v2. These are reported parcel attributes. The next research step is to retrieve applicable current Zoning Resolution sections and maps; the registry itself neither establishes an allowable building envelope nor proves those later retrievals worked.

`source-registry.test.mjs` verifies migration and sync, metadata-only storage, jurisdiction boundaries, search, updates, retirement, verification flags and chat-tool integration. The deployment script includes the registry module and manifest. These additions require a normal research-service release before appearing in the live chat.

## Zoning facts and guidelines

The `zoning_facts` table holds curated, source-cited zoning and development facts and practitioner guidelines. Its approved entries live in `zoning-facts.json`. `acres_search_zoning_facts` applies an additive, idempotent migration and syncs the manifest into the same SQLite database on first use, following the source registry's model: no external content is fetched, and removing an entry retires it without touching unrelated rows.

Each row is one statement for one jurisdiction. Indexed scalar fields are `id`, `jurisdiction`, `kind` (`fact` or `guideline`), `topic`, `title`, `statement`, `authority`, `status`, `verified_at`, `source_amended_at` and `enabled`. The JSON `metadata` field adds qualifiers, misconceptions the entry corrects, district codes, answerable questions, keywords, structured values such as FAR and height figures, and citations. FTS5 searches titles, statements, questions, keywords, districts and qualifiers; topic, kind and district code are exact filters, and jurisdiction scoping matches the registry.

Facts must cite a controlling source (Zoning Resolution, City Charter, state statute or agency rule or guidance) and carry the date they were checked against it. `needs_confirmation` marks a fact whose evidence is incomplete. Guidelines are review methods and checklists with status `reviewed`; they are not law. Results are orientation, not citable evidence: read the cited section before stating a parcel-specific figure, because special districts and later amendments control. Search flags entries checked more than 180 days ago as due for review.

The initial NYC set was finalized from a claim-by-claim review of a developer cheat sheet against the Zoning Resolution, City Charter, RPTL §485-x, HPD rules and the Comptroller's wage schedule as of October 18, 2026. Update an entry by editing the manifest after rechecking its source, then release the research service. `zoning-facts.test.mjs` covers migration and sync, validation, retrieval of corrected facts, filters, jurisdiction boundaries and agreement with the FAR figures in `zoning-rules.json`.

## Verification

`npm test` covers jurisdiction isolation and inherited state scope, historical effective ranges, future-effective documents, version preservation, unchanged-update idempotency, failed refreshes, concurrent ingestion, redirect safety, citation access and provider response validation. A live acceptance run must also fetch the registry, verify real classifier and embedding calls, repeat an unchanged refresh, and query through the deployed chat before claiming production readiness.
