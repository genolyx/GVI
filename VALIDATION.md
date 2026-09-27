# Genolyx Variant Interpreter — Validation Record

This document records the **per-route state UI, permission boundary, keyboard accessibility, automated test, and build validation evidence** for the current implementation. It does not replace regulatory approval or medical device conformance certification; separate validation under the organization's quality management system is required before real clinical use.

## Per-route state and accessibility audit

| Route                | Loading                                | Empty state                           | Error / retry                                                    | Insufficient permission                               | Keyboard / focus                           |
| -------------------- | -------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `/`                  | Dashboard query skeleton               | Onboarding / no recent cases          | Retryable `StatePanel`                                           | Menu and actions gated by permission                  | Native buttons/links and global focus ring |
| `/cases`             | List skeleton                          | Common `StatePanel` + new case action | List retry                                                       | `case:read` direct-URL guard                          | Mobile buttons / desktop row Enter/Space   |
| `/cases/new`         | Project loading state                  | No projects                           | Project, upload, submit retry                                    | `case:create` guard                                   | Labelled form controls                     |
| `/cases/:id`         | Detail skeleton                        | Tenant-concealed not-found state      | Detail, timeline, report draft retry                             | `case:read` direct-URL guard                          | Native buttons/links                       |
| `/workbench`         | N/A                                    | Case selection prompt                 | N/A                                                              | `variant:read` guard                                  | Native CTA                                 |
| `/workbench/:caseId` | Case, variant, detail, Copilot loading | No variants, evidence, conversations  | Per-operation retry for all queries and refresh/save/approve/ask | `variant:read` direct-URL guard                       | Variant row Enter/Space, labelled filters  |
| `/reports`           | List skeleton                          | Common `StatePanel` + go to cases     | List retry                                                       | `report:read` direct-URL guard                        | Report cards are native buttons            |
| `/reports/:id`       | Document skeleton                      | Tenant-concealed not-found state      | Get, save, review, sign errors                                   | `report:read` direct-URL guard, per-action permission | Form labels, dialog focus management       |
| `/organization`      | Member and invite loading              | No invites                            | List, invite, role-change retry                                  | `member:manage` guard                                 | Native form controls                       |
| `/audit`             | Log skeleton                           | Common `StatePanel`                   | Log retry                                                        | `audit:view` guard                                    | Native filter controls                     |
| `/security`          | Security context skeleton              | No projects                           | Context retry                                                    | `security:view` guard                                 | Read-focused structure                     |
| Unregistered paths   | N/A                                    | 404 guidance                          | N/A                                                              | N/A                                                   | Native back link                           |

## Global state and interaction rules

`OrganizationContext` exposes loading and error states for the organization list and permission catalog in the global layout. Child routes are not rendered until the organization context is confirmed after authentication; on failure, only retry or sign-out is provided. `StatePanel` provides `loading`, `empty`, `error`, and `forbidden` variants; the error variant applies `role="alert"` and an assertive live region.

`client/src/index.css` provides a 2 px global `:focus-visible` outline on buttons, links, input controls, and elements with a positive `tabIndex`. Under `prefers-reduced-motion: reduce`, animation and transition durations are effectively eliminated. Clickable case and variant rows include `tabIndex`, semantic role, `Enter`/`Space` handlers, and a focus ring.

## Security and clinical boundary validation

| Validation area                   | Automated evidence                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Organization trespass concealment | Tenant tests confirming non-member organization requests converge to `NOT_FOUND`                       |
| Server RBAC                       | Analyst/clinician/viewer action separation and denial tests                                            |
| Audit records                     | Tests for organization, actor, target, before/after, and request metadata recording                    |
| ACMG/AMP                          | Tests for valid codes, duplicate codes, final classifications, and purpose-specific constraints        |
| Copilot                           | Tests rejecting citations outside the Evidence Ledger, missing citations, and allowing valid citations |
| Report immutability               | Policy tests confirming only draft is mutable; reviewed/signed/amended are immutable                   |
| Gateway authentication            | Optional Bearer token authentication success and failure tests                                         |

## Somatic CDS Phase 1 clinical validation

Phase 1 is validated against the AMP/ASCO/CAP 2017 somatic interpretation framework. The validation pack is synthetic/public and deterministic: it exercises software behavior and clinical safety boundaries, but it is not a substitute for an institution-approved expert truth set or assay validation.

The versioned fixture pack is stored under `shared/fixtures/somatic/v1`. Its manifest covers EGFR therapeutic evidence, BRAF evidence from another tumor context, prognostic evidence, unknown/other-tumor evidence, conflicting evidence, no evidence, low VAF, low depth, reference-build mismatch, INDEL manual review, and provider outage. All `reviewerGold` values intentionally remain `null` until an authorized molecular pathology review set is supplied.

Automated coverage includes:

- deterministic VCF normalization and fixture-provider behavior without live CIViC access;
- QC, evidence provenance, disease match, AMP proposal, conflict, and fail-closed provider behavior;
- analyst/clinician RBAC, organization IDOR concealment, legacy API isolation, and Germline ACMG/SAM-VC golden regressions;
- report signing preconditions, approved-assertion-only snapshots, JSON-stable SHA-256 digests, immutable signatures, and amendment lineage;
- PostgreSQL/tRPC run-to-review-to-sign-to-amend acceptance plus deliberate rollback of 12 foreign-key/check-constraint violations.

The database-backed acceptance run completed with a `ready_for_review` run, pass QC for EGFR and BRAF, `low_depth` for MET, assertion states covering in-review/approved/rejected, a signed immutable report, and an amendment draft linked to that report. Browser acceptance confirmed organization isolation, the Germline/Somatic Workbench split, Somatic review/QC presentation, signed snapshot provenance and digest display, amendment flow, and continued access to the unchanged Germline Workbench.

Release gate order:

1. Apply and verify database migrations.
2. Run `pnpm check`.
3. Run the complete Vitest suite.
4. Run `pnpm exec tsx scripts/somatic-e2e.ts all` against a disposable validation database or approved local validation database.
5. Confirm Germline ACMG and SAM-VC golden regressions.
6. Run `pnpm build`.
7. Complete browser acceptance for `/workbench`, `/workbench/somatic`, a seeded Somatic case, `/reports`, the signed report snapshot/amendment, and `/workbench/germline`.
8. Remove validation seed data with `pnpm exec tsx scripts/somatic-e2e.ts cleanup`.

Before clinical release, provide a de-identified expert-reviewed target-panel set (recommended 15–30 representative cases) with tumor ontology codes, expected oncogenicity/domain/effect, final AMP tier and level, reportability, and rationale. Also provide the institution's SOP/report wording, actual panel BED/coverage thresholds, and licensed evidence access that the institution intends to validate. The maintained preparation checklist and machine-validated manifest format are documented in `docs/somatic-clinical-inputs.md`. Negative, not-tested, and insufficient-coverage conclusions remain blocked until panel/BED and assay coverage validation are complete.

## Somatic CDS Phase 2-A evidence context validation

Phase 2-A adds version-pinned disease matching and active guideline proposal rules without changing expert sign-out authority.

- Disease matching uses ontology system, exact version, code, and explicit ancestry only. Labels and token overlap are never used. Cross-version or incomplete hierarchy input remains `unknown`.
- Only enabled, license-approved providers with a validated active release can contribute guideline rules.
- Guideline JSON is schema-validated on input. Tier I/II rules require an AMP level; Tier III/IV rules cannot assign one.
- A review-only proposal requires exact tumor context, compatible variant/domain/direction, no evidence conflict, and exactly one matching active rule.
- Zero or multiple matching rules, broader/narrower/unknown disease context, or conflicting directions fail closed without an AMP proposal.
- Provider-native evidence levels remain separate and are never copied into AMP Tier/Level.
- Migration `0012_somatic_phase2a_proposals.sql` freezes conflict flags, reason codes, disease matches, and applied-rule provenance with each assertion.
- The Somatic Workbench displays proposal reasons, applied release provenance, evidence direction, and a conflict alert. Final classification still requires authorized expert review.

The deterministic database acceptance run verified an EGFR Tier I/Level A review-only proposal from one synthetic active rule, a fail-closed BRAF assertion without a matching rule, immutable signed report provenance, and 13 deliberate database-constraint violations rolled back. Browser acceptance confirmed the applied rule key/provider/release and the separation between system proposal and expert final values.

## Somatic CDS Phase 2-B offline release validation

Phase 2-B removes live CIViC lookup from the production Somatic path. A run can use CIViC evidence only from one organization-scoped release that is enabled, license-approved, validated, active, and populated with immutable normalized offline records. If no such release exists, the provider fails closed with `CIViC:offline_release_unavailable`; there is no live CIViC fallback.

- Import validation requires a release-pinned tumor ontology, normalized variant identity, source record ID, provider-native evidence level, clinical domain, effect direction, raw-record SHA-256, and release content hash.
- Provider-native evidence levels remain source facts only. Import strips provider-derived AMP/final classification fields, and expert-controlled Tier/Level sign-out remains unchanged.
- CIViC release activation is blocked until offline evidence records are present and all existing license, approval, validation, and guideline gates pass.
- Activating a replacement release computes added, removed, and changed normalized evidence. Cases containing impacted Somatic variants receive organization-scoped reinterpretation tasks in the same transaction.
- Migration `0013_somatic_offline_knowledge.sql` enforces organization/release ownership, immutable source-record identity, variant lookup indexes, and SHA-256 shape constraints.
- The Governance page displays offline evidence totals, per-release record counts, guideline rule counts, and the release-impact review queue.

The deterministic database acceptance run imported and activated two version-pinned synthetic CIViC releases without network access. It verified one changed EGFR evidence record, the impacted normalized ID `GRCh38:7:55259515:T:G`, one reinterpretation task, signed-report amendment continuity, and rollback of 15 deliberate database-constraint violations. Direct tRPC verification confirmed two offline records on each release and the v1-to-v2 impact task. Browser acceptance confirmed that the Governance route renders the offline-evidence and release-impact surfaces; temporary validation data was removed afterward.

## Somatic CDS Phase 3-A panel and assay validation

Phase 3-A connects the existing Panel/Coverage/CNV/Fusion/Signature foundation to the clinical review and report path.

- A normalized reportable-region artifact is imported in one transaction with an exact file name and SHA-256. Duplicate keys, invalid coordinates, invalid fusion targets, and an artifact without reportable regions are rejected.
- A clinician must approve the exact imported hash. Passed panel regions become immutable; any revision requires a new panel version.
- Case coverage is bulk imported by approved `regionKey`. QC pass/fail is derived server-side from panel minimum depth and coverage thresholds; client-supplied verdicts are not accepted.
- Missing or failed regions keep coverage validation failed. The approval hash must equal the imported coverage artifact hash, and passed coverage is immutable.
- Negative/not-tested findings additionally require an approved panel-region artifact, complete passed case coverage, a valid active organization policy, and both panel and coverage SHA-256 provenance.
- CNV, fusion, MSI, TMB, and HRD findings are created non-reportable and require expert review. Any unreviewed assay finding blocks report review and sign-out.
- Reviewed reportable assay findings, linked coverage summaries, panel artifact provenance, and negative-reporting policy are frozen in `somatic-report-snapshot-3`.
- Migration `0014_somatic_panel_coverage_artifacts.sql` adds panel artifact approval and coverage source-hash constraints.

The deterministic database acceptance run approved one reportable-region artifact, derived and passed one coverage record, reviewed one TMB-high finding, rendered it in the Somatic Clinical Report, signed snapshot version 3, and rolled back 17 deliberate database-constraint violations. Browser acceptance confirmed the panel/coverage status, typed assay review controls, TMB finding, report genomic-signature section, coverage provenance, signature, and digest.

## Somatic CDS Phase 3-B artifact and worker validation

- Strict BED4 parsing requires an explicit unique `regionKey` and converts 0-based half-open BED coordinates to 1-based inclusive coordinates without guessing.
- Coverage TSV requires the exact `regionKey`, `meanDepth`, and `coveredPercent` header; equivalent JSON arrays are also accepted. Duplicate keys, invalid percentages, oversized files, and hash mismatches fail closed.
- Exact uploaded UTF-8 text is SHA-256 verified server-side and retained as a tenant/case-scoped `panel_bed` or `coverage` object before structured import.
- The Workbench supports BED and coverage file selection while preserving the normalized JSON path for gene/transcript-specific and fusion/signature definitions.
- Somatic interpretation execution uses a PostgreSQL queue with `FOR UPDATE SKIP LOCKED`, worker identity, lease expiry, bounded attempts, exponential retry, and stale-lease recovery.
- Retry resets only the selected run's derived analyses, evidence, and assertions before deterministic reprocessing. An active lease is extended during processing and cleared on completion.
- Migration `0015_somatic_artifacts_and_durable_jobs.sql` adds artifact file kinds, queue/lease fields, a worker index, and attempt-count constraints.

The database acceptance workflow now starts the run through the production enqueue API and completes it through the durable worker claim path. It verifies one attempt, cleared lease ownership, the unchanged clinical result package, and the new attempt constraint probe.

## Somatic CDS Phase 4 operational change control

Phase 4 connects versioned knowledge governance to the durable Somatic interpretation queue without changing Germline analysis or review behavior.

- Governance users can configure provider license state, create draft releases, import version-pinned offline evidence and guideline rules, record validation, and create policy profiles from the UI. Providers and releases still fail closed until server-side license, validation, evidence, rule, and policy gates pass.
- A release impact preview shows added, changed, and removed evidence, impacted normalized variant identities, and affected Somatic cases before activation or rollback.
- Activating a replacement release creates one deduplicated open reinterpretation task per impacted case. Tasks can be queued individually or in batches of up to 100 and are linked to the durable interpretation run.
- The run queue enforces one active Somatic run per organization/case. Repeated enqueue requests link to the existing run instead of creating parallel processing.
- A task cannot be completed until its linked run reaches `ready_for_review`. Completed and dismissed tasks remain immutable.
- Somatic report review and signing fail closed while the case has an open or in-review reinterpretation task. Existing signed snapshots remain immutable; changed conclusions continue through the existing amendment workflow.
- A validated retired release can be restored only through an approve-gated controlled rollback with a change-control ID and reason. The current active release is retired atomically, the restored release is rechecked against current activation gates, impacted-case tasks are created, and the action is audited.
- Migration `0016_somatic_phase4_operations.sql` links tasks to runs, records enqueue provenance, prevents duplicate open tasks for the same case/release, and prevents parallel active runs for the same Somatic case.

The database E2E workflow includes impact preview, v2 activation, task enqueue, durable worker completion, task completion, rollback to the validated v1 release, and rollback impact-task creation. Constraint probes include duplicate active-run and duplicate open-task rejection.

## OncoKB API adapter validation

OncoKB is an explicitly governed API evidence provider alongside version-pinned offline CIViC; it is not a fallback and its native levels are never copied into AMP Tier/Level.

- Runtime modes are `disabled`, `demo`, `research`, and `commercial`. The token comes only from `ONCOKB_API_TOKEN`; Governance reports only whether it is configured.
- Organization use additionally requires an enabled OncoKB provider with an approved license reference and an active policy with `enableOncoKb=true`.
- Protein-change and genomic-change queries use batch POST with explicit GRCh37/GRCh38 and an OncoTree code only when the case tumor is version-pinned to OncoTree.
- Batching, bounded concurrency, timeout, 429/5xx/network retry, `Retry-After`, authentication-error detection, process-local TTL cache, and non-PHI runtime metrics are implemented.
- Evidence stores endpoint, normalized request, data version, last update, retrieval time, raw-response hash, exact/manual tumor mapping, source-native oncogenicity, separate sensitivity/resistance records, treatments, and license mode. The token is never persisted.
- `demo` and `research` records are marked `researchOnly`. They are visible for evaluation but excluded from automatic proposals and block Somatic Clinical Report review/signing. Only governed `commercial` mode can produce non-research OncoKB evidence.

Deterministic tests use an injected HTTP implementation and cover demo batch payloads, OncoTree context, genomic fallback without guessed tumor mapping, cache hits, missing research token, commercial provenance, non-retried 401/403 behavior, and 429 retry. The public demo batch endpoint was also smoke-tested with nested `gene.hugoSymbol`, BRAF V600E, GRCh38, and OncoTree code MEL; it returned HTTP 200, `geneExist=true`, `variantExist=true`, Oncogenic, Level 1, and data version `v7.5`. Automated tests do not call the real service or require a token.

## CIViC GraphQL V2 offline-import validation

CIViC live access is isolated to a durable snapshot-import worker. Production Somatic interpretation still reads only an organization-approved, validated, active offline release and has no live API fallback.

- Fixed operations cover gene resolution, candidate variants, coordinate detail, candidate molecular profiles, Accepted evidence, and CI-only schema contract introspection.
- The client enforces timeout, bounded 429/5xx/network retry, `Retry-After`, rate limiting, cursor progress/page limits, process-local cache, safe metrics, and explicit complete/empty/partial/unavailable states.
- Matching distinguishes exact genomic alleles, protein changes, variant classes, and ambiguity. Complex profiles use tri-state logic and remain review-required.
- Only Accepted EIDs are normalized. Native level, rating, direction, significance, origin, disease, therapies/interaction, source and citation remain separate; no field is copied to AMP Tier/Level.
- Flagged/retracted/deprecated/unknown or non-exact evidence is marked `researchOnly` with explicit auto-apply blockers.
- Migration `0017_somatic_civic_import.sql` adds tenant-scoped jobs, leases, retries, checkpoints and raw-response archive metadata. Exact raw bodies are stored outside PostgreSQL without authorization secrets.
- Imports target draft releases only. Partial, failed, running, queued, or cancelled imports block validation/activation; successful imports never validate or activate themselves.
- Governance can enqueue a non-PHI normalized-variant scope, observe job status/stats/warnings, and cancel active work.

The deterministic CIViC suite uses injected transport/time and does not depend on the public service. On 2026-09-27, a non-PHI BRAF V600E live smoke executed all six fixed operations successfully: gene 5, variant 12, GRCh37 coordinates, paged profiles, Accepted-only evidence, and 37 introspected EvidenceItem fields. Database E2E requires PostgreSQL, migration `0017`, and configured object storage; it remains pending locally because the Docker daemon is unavailable.

## Somatic reference FASTA normalization

- GRCh37 and GRCh38 use separate deployment paths, versions, and full-file SHA-256 values; a samtools-compatible `.fai` is required.
- The full FASTA digest is verified once per process before indexed reads are trusted.
- Submitted REF is checked against the pinned build before normalization. Build, contig, interval, REF, index, or digest disagreement fails closed.
- Repeat-aware INDEL left alignment retains the original VCF representation while recording normalized ID, shifted bases, FASTA version/hash/path provenance.
- Evidence lookup receives normalized coordinates; database variant identity remains linked to the submitted record and the signed report snapshot retains both representations.
- Without an approved FASTA configuration, INDELs remain `manual_review_required` and cannot become automatic candidates.

Deterministic tests cover a homopolymer deletion shifted to its leftmost representation, provenance capture, REF mismatch rejection, and the unconfigured fail-closed path.

## Full-panel negative Somatic reporting

- Absence of approved variants alone can never produce a negative conclusion.
- Eligibility requires a `ready_for_review` run, no positive or unresolved findings, an approved reportable-region artifact, complete passed coverage with source/validation hashes, and an active validated negative-reporting policy.
- Draft creation, clinical review, and signing independently re-evaluate the gates; a stale negative draft fails closed if Panel, coverage, finding, or policy state changes.
- Organization templates version customizable negative title, summary, interpretation, and limitation text.
- The immutable snapshot records the negative conclusion type, Panel hash, coverage identity/hash, and policy ID/version. `not_tested` is not treated as a full-panel negative result.

Pure tests cover successful eligibility, incomplete coverage/policy failure, positive/unresolved result rejection, and sign-out with no variant assertion only when the separate negative gate passes.

## Assay result bulk import

- Vendor-neutral normalized JSON and strict TSV support CNV, fusion, MSI, TMB, and HRD typed results.
- Detected calls require a result whose discriminant matches the finding type; malformed JSON, invalid enums/numbers, oversized files, and foreign coverage IDs fail closed.
- Exact source text is SHA-256 verified and retained as a case-scoped `assay_result` artifact before database import.
- Bulk records are inserted non-reportable and remain subject to the existing individual expert-review, Panel capability, coverage, negative-policy, report-review, and sign-out gates.
- Device-specific column adapters are intentionally deferred until de-identified vendor exports and versioned field specifications are supplied.
- Migration `0018_somatic_assay_bulk_provenance.sql` links every bulk finding to the tenant/case-scoped source artifact and freezes its SHA-256.

## Policy, Panel, and assay change impact

- Policy activation classifies content, negative-reporting, and OncoKB-control changes and creates deduplicated Somatic case tasks.
- Panel impact preview compares immutable versions of the same panel, including capabilities, metadata, artifact hashes, regions, and thresholds. Task creation requires a validated target, an approved change-control ID, and an unchanged preview hash.
- New assay artifacts are compared with prior reviewed reportable findings by case and finding type. They remain non-reportable, and impact task creation is an explicit approval action.
- Migration `0019_somatic_policy_impact.sql` adds generic change provenance and open-task deduplication while retaining active validated knowledge-release pinning.

## Reproduction commands

```bash
pnpm install
pnpm check
pnpm vitest run
pnpm exec tsx scripts/somatic-e2e.ts all
pnpm build
```

The Phase 1 Somatic validation gate, expert-gold input validation, Phase 2 evidence-context/offline-release workflow, Phase 3 panel/assay/artifact workflow, Phase 4 report-gate regression, deterministic OncoKB/CIViC adapters, reference FASTA normalization, negative-report safety, assay bulk-parser, and change-impact suites currently complete with no TypeScript errors and **357 tests across 53 test files passing**. Migrations `0016`–`0019` were applied to the local PostgreSQL validation database and the complete Somatic DB E2E passed: version-pinned offline workflow, report signing/amendment, panel/coverage/assay provenance, release-impact task creation, all 18 expected constraints, and 20 deliberate violations rolled back. The latest browser acceptance confirmed the Somatic Governance route, Panel version selectors, generalized change-impact queue empty state, and updated change-control labels.

The current local build uses Node.js 18.19.1 and succeeds, but Vite 7 declares Node.js 20.19+ or 22.12+ as its supported runtime. Upgrade the build and deployment environment to a supported Node.js version before release and rerun the complete gate.

The earlier standalone source ZIP was extracted into a clean temporary directory without linking `node_modules` or build artifacts from an existing project. Its historical reproduction results are retained below.

| Standalone ZIP reproduction step | Result                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| Archive integrity                | `unzip -t` — no errors                                     |
| Dependency install               | `pnpm install` — success                                   |
| Type check                       | `tsc --noEmit` — success                                   |
| Automated tests                  | 22 tests across 7 files passed without `GVI_GATEWAY_TOKEN` |
| Production build                 | Vite client and server bundles generated successfully      |

Vite's >500 kB chunk warnings and pnpm's build-script approval warnings for some dependencies are present but do not constitute install, test, or build failures. A subsequent performance phase can evaluate per-page dynamic imports and explicit dependency build policies.

## Pre-production checklist

Before real clinical operation, separately approve per-organization role mapping, invite policy, signing authority, data retention and deletion policy, S3 access logs, database backup and recovery, external evidence licensing, privacy policy, incident response procedures, and cross-border data transfer conditions under institutional policy and applicable regulations. AI Copilot output must not be used as automated verdict or signature input; treat it only as a draft backed by stored Evidence Ledger items and expert review.
