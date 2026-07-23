# Genolyx Variant Interpreter — Architecture

## System boundaries

Genolyx Variant Interpreter (GVI) separates the **clinical interpretation control plane** from the **heavy analysis execution plane**. The web application manages organizations, projects, cases, input file metadata, variants, evidence, interpretations, reports, and audit events. Jobs that may exceed request timeouts — such as FASTQ alignment and variant calling — do not run in the web process; the institution's internal Site Gateway fetches job manifests outbound, executes the pipeline, and pushes status and artifacts back.

| Layer | Technology / components | Responsibility |
|---|---|---|
| Web client | React 19, TypeScript, Tailwind, shadcn/ui | Organization-scoped clinical workflows, permission-based UI, accessibility states |
| API | Express, tRPC | Input validation, authentication, organization boundary, action permissions, state transitions |
| Domain | Pure TypeScript policy modules | ACMG/AMP codes, Copilot citation guardrails, report hash and immutability |
| Database | MySQL/TiDB, Drizzle ORM | Tenant-owned metadata, relationships, audit events |
| Object storage | S3-compatible storage | Input files and analysis artifacts, organization-prefix isolation |
| Site Gateway | Institution-internal `gx-daemon`/`gx-exome` integration | Manifest pull, FASTQ analysis, artifact push |
| AI gateway | Server-side built-in LLM API | Evidence Ledger-based summaries and drafts, allowed model list |

## Request and data flow

Browser requests identify the user via an OAuth session cookie. tRPC procedures accept `organizationId` as input; the server's organization permission boundary verifies active membership and the requested action first. Database queries include the validated organization identifier as a condition; successful mutations are recorded as audit events scoped to the same organization.

```text
Browser → OAuth session → tRPC input validation
        → organization membership + action permission
        → organization-scoped query/mutation → audit event
```

If the organization list or permission catalog query fails, the global layout does not render child routes and provides only retry and sign-out options.

## Core domain

| Aggregate | Key relationships and invariants |
|---|---|
| Organization | Root tenant for members, invites, and projects |
| Project | Belongs to one organization; groups cases as an operational unit |
| Case | Owns purpose, reference build, samples, files, and analysis jobs |
| Variant | Belongs to organization and case; holds normalized ID and clinical annotations |
| Evidence | Holds source, URL, access timestamp, excerpt, strength, and direction |
| Interpretation | Holds per-variant draft/review/approval and applied criteria |
| Report | Per-case version chain, JSON content, signer, and snapshot hash |
| Audit event | Organization, actor, action, target, before/after, request metadata |

Every tenant-owned table includes `organizationId`. Case child data uses a parent relationship that includes the organization identifier, preventing references to a parent in another organization.

## VCF and FASTQ

VCF and TSV files are uploaded via the web portal within a size limit; the server parses headers and variant rows. File bytes are stored in S3; only the key, URL, MIME type, size, and SHA-256 are kept in the database. Parsed variants are bulk-inserted within the same organization and case scope.

FASTQ and large inputs create an `analysis_job`. The Site Gateway authenticates with a Bearer token, fetches the queued manifest, runs the internal pipeline, and pushes progress, status, and artifact metadata. The web runtime does not run workers that must stay alive after a request.

## Interpretation and reporting

```text
Variant imported → Evidence Ledger reviewed → Interpretation draft
→ Submitted for review → Clinician approval → Report draft
→ In review → Electronic signature → Immutable snapshot + SHA-256
```

ACMG/AMP codes and report state transitions are validated by deterministic policies. The Copilot can only cite stored Evidence Ledger IDs and cannot perform verdict approval or electronic signing. Signed reports are not modified; subsequent changes are carried forward as new amendment versions.

## Deployment characteristics

The web application targets a single Node server process and serverless autoscale environments. Analysis requiring long execution time, fixed IP, or internal data access belongs behind the Site Gateway boundary. Before going live, finalize database backup/recovery, S3 lifecycle policies, key rotation, institution-specific gateway registration, and incident response procedures.
