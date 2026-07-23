# Genolyx Variant Interpreter — Validation Record

This document records the **per-route state UI, permission boundary, keyboard accessibility, automated test, and build validation evidence** for the current implementation. It does not replace regulatory approval or medical device conformance certification; separate validation under the organization's quality management system is required before real clinical use.

## Per-route state and accessibility audit

| Route | Loading | Empty state | Error / retry | Insufficient permission | Keyboard / focus |
|---|---|---|---|---|---|
| `/` | Dashboard query skeleton | Onboarding / no recent cases | Retryable `StatePanel` | Menu and actions gated by permission | Native buttons/links and global focus ring |
| `/cases` | List skeleton | Common `StatePanel` + new case action | List retry | `case:read` direct-URL guard | Mobile buttons / desktop row Enter/Space |
| `/cases/new` | Project loading state | No projects | Project, upload, submit retry | `case:create` guard | Labelled form controls |
| `/cases/:id` | Detail skeleton | Tenant-concealed not-found state | Detail, timeline, report draft retry | `case:read` direct-URL guard | Native buttons/links |
| `/workbench` | N/A | Case selection prompt | N/A | `variant:read` guard | Native CTA |
| `/workbench/:caseId` | Case, variant, detail, Copilot loading | No variants, evidence, conversations | Per-operation retry for all queries and refresh/save/approve/ask | `variant:read` direct-URL guard | Variant row Enter/Space, labelled filters |
| `/reports` | List skeleton | Common `StatePanel` + go to cases | List retry | `report:read` direct-URL guard | Report cards are native buttons |
| `/reports/:id` | Document skeleton | Tenant-concealed not-found state | Get, save, review, sign errors | `report:read` direct-URL guard, per-action permission | Form labels, dialog focus management |
| `/organization` | Member and invite loading | No invites | List, invite, role-change retry | `member:manage` guard | Native form controls |
| `/audit` | Log skeleton | Common `StatePanel` | Log retry | `audit:view` guard | Native filter controls |
| `/security` | Security context skeleton | No projects | Context retry | `security:view` guard | Read-focused structure |
| Unregistered paths | N/A | 404 guidance | N/A | N/A | Native back link |

## Global state and interaction rules

`OrganizationContext` exposes loading and error states for the organization list and permission catalog in the global layout. Child routes are not rendered until the organization context is confirmed after authentication; on failure, only retry or sign-out is provided. `StatePanel` provides `loading`, `empty`, `error`, and `forbidden` variants; the error variant applies `role="alert"` and an assertive live region.

`client/src/index.css` provides a 2 px global `:focus-visible` outline on buttons, links, input controls, and elements with a positive `tabIndex`. Under `prefers-reduced-motion: reduce`, animation and transition durations are effectively eliminated. Clickable case and variant rows include `tabIndex`, semantic role, `Enter`/`Space` handlers, and a focus ring.

## Security and clinical boundary validation

| Validation area | Automated evidence |
|---|---|
| Organization trespass concealment | Tenant tests confirming non-member organization requests converge to `NOT_FOUND` |
| Server RBAC | Analyst/clinician/viewer action separation and denial tests |
| Audit records | Tests for organization, actor, target, before/after, and request metadata recording |
| ACMG/AMP | Tests for valid codes, duplicate codes, final classifications, and purpose-specific constraints |
| Copilot | Tests rejecting citations outside the Evidence Ledger, missing citations, and allowing valid citations |
| Report immutability | Policy tests confirming only draft is mutable; reviewed/signed/amended are immutable |
| Gateway authentication | Optional Bearer token authentication success and failure tests |

## Reproduction commands

```bash
pnpm install
pnpm check
pnpm vitest run
pnpm build
```

The final source ZIP was extracted into a clean temporary directory without linking `node_modules` or build artifacts from an existing project, and the commands above were executed in order. `pnpm install` completed against the lockfile with no TypeScript errors. **22 tests across 7 test files passed** even with `GVI_GATEWAY_TOKEN` removed from the process, and both the production Vite bundle and `dist/index.js` server bundle were generated successfully. Gateway auth tests inject their own test-only token and restore the original environment on exit, so no local secrets are required.

| Standalone ZIP reproduction step | Result |
|---|---|
| Archive integrity | `unzip -t` — no errors |
| Dependency install | `pnpm install` — success |
| Type check | `tsc --noEmit` — success |
| Automated tests | 22 tests across 7 files passed without `GVI_GATEWAY_TOKEN` |
| Production build | Vite client and server bundles generated successfully |

Vite's >500 kB chunk warnings and pnpm's build-script approval warnings for some dependencies are present but do not constitute install, test, or build failures. A subsequent performance phase can evaluate per-page dynamic imports and explicit dependency build policies.

## Pre-production checklist

Before real clinical operation, separately approve per-organization role mapping, invite policy, signing authority, data retention and deletion policy, S3 access logs, database backup and recovery, external evidence licensing, privacy policy, incident response procedures, and cross-border data transfer conditions under institutional policy and applicable regulations. AI Copilot output must not be used as automated verdict or signature input; treat it only as a draft backed by stored Evidence Ledger items and expert review.
