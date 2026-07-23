# Genolyx Variant Interpreter — Security Model

## Security objectives

GVI's core security objectives are: **prevention of cross-organization clinical data access**, **least-privilege by role**, **change traceability**, **report integrity**, and **separation of AI output from clinical authority**. The UI hides menus and actions without permission, but final authorization is always re-validated on the server.

## Roles and actions

| Role | Representative permitted actions | Explicit restrictions |
|---|---|---|
| Administrator | Manage organization, members, projects, security, audit | Cannot sign clinical reports electronically |
| Analyst | Create cases, review variants and evidence, edit interpretation drafts | Cannot approve interpretations, sign reports, or manage members |
| Clinician | Clinical review, interpretation approval, report review and electronic sign-out | Cannot manage members or organization security |
| Viewer | Read-only access to permitted cases, variants, and reports | Cannot create, modify, approve, sign, or invite |

Permissions are defined as an action catalog in `shared/permissions.ts`. Even if a role exists, access is denied unless the organization membership status is `active`.

## Tenant isolation

Every protected procedure verifies active membership for the current user and the requested `organizationId`. Non-member requests converge to `NOT_FOUND` to avoid revealing resource existence. Parent–child queries and mutations always include the same organization condition.

| Control | Implementation principle |
|---|---|
| Application RBAC | Action permission check at procedure entry |
| Query scoping | `organizationId` condition included in every tenant read/write |
| Relational boundary | Parent relationships and unique keys that include the organization identifier |
| Storage prefix | `organizations/{organizationId}/...` key namespace |
| Concealed lookup | Direct object references to other organizations return `NOT_FOUND` |
| UI transparency | Active organization, role, permitted actions, and project scope displayed to the user |

MySQL-compatible deployments do not provide native PostgreSQL-style RLS, so isolation is enforced at three layers: schema ownership, mandatory organization predicates, and procedure action permissions. Database and S3 policies should also be configured with least privilege.

## Authentication, audit, and report integrity

User authentication uses an OAuth session cookie; the client never manipulates the cookie directly. The Site Gateway uses optional `GVI_GATEWAY_TOKEN` Bearer authentication with a timing-safe comparison. Secrets are not committed to the repository.

Audit events record the organization, actor, action, target type and ID, before/after state, request ID, IP, user agent, and timestamp. On signing, the report's clinical content and identifying metadata are normalized to produce a SHA-256 digest. Signed versions cannot be modified; subsequent changes become new versions.

## AI safety boundary

The Copilot uses only the server-provided Evidence Ledger as context. All citation IDs in the response are verified to belong to the permitted evidence set for the current variant; responses citing evidence outside the set, or containing uncited claims, are rejected. The model cannot approve interpretations, sign reports, or make final patient-specific decisions.

## Threats and mitigations

| Threat | Primary mitigation | Residual operational risk |
|---|---|---|
| Injected foreign organization ID | Membership pre-check, organization condition, concealed errors | Missing scope in new procedures; code review and testing required |
| Privilege escalation | Server action permissions, role-change audit | Administrator account takeover; MFA and access review required |
| File tampering | S3 storage, SHA-256 metadata | Malicious content; AV/content scanning recommended |
| Post-sign report modification | State transitions, immutable snapshot, digest | External PDF integrity verification procedure required |
| AI hallucination | Ledger-only context, citation verification | Errors or bias in source evidence; expert review mandatory |
| Gateway token leak | Bearer verification, secret injection, audit | Per-institution token rotation recommended |
| Audit log tampering | Append-only in application | DB operator threat; WORM/SIEM integration recommended |

## Operations checklist

Before going live, separate administrator and clinician accounts by organization, and set up regular access reviews and secret rotation. Data retention/deletion, backup encryption and recovery drills, S3 access logs, incident notification, external evidence licensing, privacy policy, and cross-border data transfer conditions must be approved in accordance with institutional policy and applicable regulations. See [`VALIDATION.md`](../VALIDATION.md) for validation evidence.
