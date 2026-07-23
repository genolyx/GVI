# Genolyx Variant Interpreter

**Genolyx Variant Interpreter (GVI)** is a clinical genomics interpretation SaaS that connects the full workflow — from FASTQ or VCF input through germline/somatic variant review, evidence tracing, expert verdict, and electronically signed reports.

> GVI is software that assists expert judgment. AI outputs are evidence drafts and do not replace clinical verdicts or electronic signatures. Use in a real diagnostic environment requires institution-specific validation, a QMS, regulatory review and approval, and licensed data sources.

## Product principles

| Principle | Implementation |
|---|---|
| Tenant isolation | Enforce `organizationId` on every tenant record; verify active membership and action permission before every server read/write. |
| Evidence first | Classifications and report statements are linked to evidence records, source URLs, access timestamps, and original excerpts. |
| Deterministic before generative | ACMG/AMP codes and report state transitions are processed by deterministic rules; LLMs are used only for evidence summarization and drafting. |
| Human sign-out | AI cannot approve interpretations or sign reports. Only the `clinician` role may sign. |
| Immutable reporting | Signing generates a JSON snapshot of the report and a SHA-256 hash; only new amendment versions can be created afterward. |
| Transparent security | Users can directly inspect the active organization, role, data scope, isolation controls, and audit events. |

## Architecture

The GVI web control plane is built on React, TypeScript, tRPC, Drizzle/MySQL, and S3-compatible storage. Heavy FASTQ analysis does not run inside a web request — the institution's internal Site Gateway picks up job manifests outbound and returns status and artifacts. VCF files can be uploaded and parsed directly in the portal within a size limit; large files use the same Site Gateway path.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/security-model.md`](docs/security-model.md) for detailed design.

## Local development

```bash
pnpm install
pnpm dev
```

Validation commands:

```bash
pnpm check
pnpm test
pnpm build
```

Environment variables and secrets are not committed to the repository. The managed runtime injects authentication, database, file storage, and server-side LLM credentials.

## Current implementation target

The first release delivers organizations, projects, and cases; VCF vertical workflow; FASTQ job manifest; germline/somatic interpretation workbench; evidence-based AI copilot; immutable reports; electronic signature; audit log; and security transparency console — all in a single verifiable flow.
