import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";

const state = vi.hoisted(() => ({
  role: "analyst" as "analyst" | "clinician",
  rows: [] as unknown[][],
  somaticCaseVisible: true,
  permissions: [] as string[],
}));

function nextRows() {
  return state.rows.shift() ?? [];
}

function queryBuilder(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  for (const method of [
    "from",
    "where",
    "limit",
    "orderBy",
    "innerJoin",
    "leftJoin",
    "groupBy",
    "offset",
    "set",
    "values",
    "onConflictDoUpdate",
    "onConflictDoNothing",
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.returning = vi.fn(async () => nextRows());
  builder.then = (
    resolve: (value: unknown[]) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(nextRows()).then(resolve, reject);
  return builder;
}

const db = {
  select: vi.fn(() => queryBuilder()),
  insert: vi.fn(() => queryBuilder()),
  update: vi.fn(() => queryBuilder()),
  transaction: vi.fn(async (callback: (tx: typeof db) => unknown) =>
    callback(db)
  ),
};

vi.mock("../domain/tenant", () => ({
  requireDb: vi.fn(async () => db),
  requireOrganizationPermission: vi.fn(
    async (_userId: number, _organizationId: number, permission: string) => {
      state.permissions.push(permission);
      const analystDenied = [
        "interpretation:approve",
        "report:review",
        "report:sign",
      ];
      if (state.role === "analyst" && analystDenied.includes(permission)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Missing permission: ${permission}`,
        });
      }
      return { role: state.role };
    }
  ),
  getMembership: vi.fn(async () => ({ role: state.role })),
}));

vi.mock("../domain/audit", () => ({
  writeAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("../domain/somatic/runProcessor", () => ({
  SOMATIC_PIPELINE_VERSION: "test-pipeline",
  SOMATIC_RUN_RULESET_VERSION: "test-rules",
  addSomaticRunEvent: vi.fn(async () => undefined),
  processSomaticRun: vi.fn(async () => undefined),
  loadSomaticCase: vi.fn(async () => {
    if (!state.somaticCaseVisible) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Somatic case not found.",
      });
    }
    return {};
  }),
}));

import { casesRouter } from "./cases";
import { reportsRouter } from "./reports";
import { somaticRouter } from "./somatic";
import { somaticFoundationRouter } from "./somaticFoundation";
import { somaticReportsRouter } from "./somaticReports";
import { variantsRouter } from "./variants";

const ctx = {
  user: {
    id: 101,
    name: "Test User",
    email: "test@example.com",
    role: "user",
  },
  req: {},
  res: {},
} as TrpcContext;

const somatic = somaticRouter.createCaller(ctx);
const foundation = somaticFoundationRouter.createCaller(ctx);
const somaticReports = somaticReportsRouter.createCaller(ctx);
const variants = variantsRouter.createCaller(ctx);
const cases = casesRouter.createCaller(ctx);
const reports = reportsRouter.createCaller(ctx);

const assertionInput = {
  organizationId: 7,
  assertionId: 41,
  finalTier: "Tier III" as const,
  finalLevel: null,
  oncogenicity: "VUS" as const,
  rationale: "A sufficiently detailed expert review rationale.",
};

const somaticVariantRecord = {
  variant: { id: 51, reviewStatus: "unreviewed" },
  clinicalCase: { id: 61, purpose: "somatic" },
};

beforeEach(() => {
  state.role = "analyst";
  state.rows = [];
  state.somaticCaseVisible = true;
  state.permissions = [];
  vi.clearAllMocks();
});

describe("somatic tenant IDOR boundaries", () => {
  it("conceals a foreign interpretation run case", async () => {
    state.somaticCaseVisible = false;
    await expect(
      somatic.caseReview({ organizationId: 7, caseId: 9001 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("conceals a foreign assertion", async () => {
    state.rows = [[]];
    await expect(
      somatic.assertionDetail({ organizationId: 7, assertionId: 9002 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("conceals a foreign somatic report", async () => {
    state.rows = [[]];
    await expect(
      somaticReports.get({ organizationId: 7, reportId: 9003 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("conceals a foreign coverage summary", async () => {
    state.role = "clinician";
    state.rows = [[]];
    await expect(
      foundation.validateCoverageSummary({
        organizationId: 7,
        coverageSummaryId: 9004,
        validationArtifactHash: "a".repeat(64),
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("conceals a foreign assay finding", async () => {
    state.role = "clinician";
    state.rows = [[]];
    await expect(
      foundation.reviewAssayFinding({
        organizationId: 7,
        findingId: 9005,
        reportable: false,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("somatic analyst and clinician RBAC", () => {
  it("allows an analyst to save review work but not approve it", async () => {
    const before = {
      id: 41,
      systemTier: "Tier III",
      systemLevel: null,
      finalTier: null,
      finalLevel: null,
      oncogenicity: null,
      status: "proposed",
    };
    const saved = { ...before, status: "in_review" };
    state.rows = [[before], [saved]];

    await expect(
      somatic.reviewAssertion({ ...assertionInput, decision: "save" })
    ).resolves.toMatchObject({ status: "in_review" });

    await expect(
      somatic.reviewAssertion({ ...assertionInput, decision: "approve" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows a clinician to approve an assertion", async () => {
    state.role = "clinician";
    const before = {
      id: 41,
      systemTier: "Tier III",
      systemLevel: null,
      finalTier: null,
      finalLevel: null,
      oncogenicity: null,
      status: "in_review",
    };
    state.rows = [[before], [{ ...before, status: "approved" }]];

    await expect(
      somatic.reviewAssertion({ ...assertionInput, decision: "approve" })
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("blocks analyst report review and signing", async () => {
    await expect(
      somaticReports.submitReview({ organizationId: 7, reportId: 71 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      somaticReports.sign({
        organizationId: 7,
        reportId: 71,
        confirmReportId: 71,
        attestation: true,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows clinician review and authorizes the signing path", async () => {
    state.role = "clinician";
    const draft = {
      id: 71,
      organizationId: 7,
      caseId: 61,
      status: "draft",
      somaticTemplateVersionId: 81,
      content: {},
    };
    state.rows = [
      [draft],
      [],
      [
        {
          clinicalCase: { id: 61, purpose: "somatic" },
          context: {},
          tumor: {},
          panel: {},
          panelVersion: {},
        },
      ],
      [],
      [],
      [],
      [],
      [],
    ];
    await expect(
      somaticReports.submitReview({ organizationId: 7, reportId: 71 })
    ).resolves.toEqual({ success: true });

    state.rows = [[]];
    await expect(
      somaticReports.sign({
        organizationId: 7,
        reportId: 71,
        confirmReportId: 71,
        attestation: true,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.permissions).toContain("report:sign");
  });

  it("blocks Somatic report review while reinterpretation is open", async () => {
    state.role = "clinician";
    state.rows = [
      [
        {
          id: 71,
          organizationId: 7,
          caseId: 61,
          status: "draft",
          somaticTemplateVersionId: 81,
          content: {},
        },
      ],
      [{ id: 91 }],
    ];

    await expect(
      somaticReports.submitReview({ organizationId: 7, reportId: 71 })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("legacy germline-only variant endpoints", () => {
  it.each([
    ["detail", () => variants.detail({ organizationId: 7, variantId: 51 })],
    [
      "refreshEvidence",
      () => variants.refreshEvidence({ organizationId: 7, variantId: 51 }),
    ],
    [
      "addEvidence",
      () =>
        variants.addEvidence({
          organizationId: 7,
          variantId: 51,
          source: "Internal",
          clinicalDomain: "other",
          title: "Internal evidence",
          excerpt: "Somatic evidence must stay isolated.",
          direction: "neutral",
        }),
    ],
    [
      "saveInterpretation",
      () =>
        variants.saveInterpretation({
          organizationId: 7,
          variantId: 51,
          somaticTier: "Tier II",
          rationale: "Legacy somatic interpretation must remain blocked.",
          submitForReview: false,
        }),
    ],
  ])("blocks %s for a somatic case", async (_name, invoke) => {
    state.rows = [[somaticVariantRecord]];
    await expect(invoke()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("case purpose and context validation", () => {
  const baseCase = {
    organizationId: 7,
    projectId: 1,
    caseNumber: "CASE-1",
    patientAlias: "Patient A",
    inputType: "vcf" as const,
    referenceBuild: "GRCh38" as const,
    consentClinicalAnalysis: true as const,
    samples: [
      {
        sampleCode: "S1",
        role: "proband" as const,
        specimenType: "blood",
      },
    ],
  };
  const somaticContext = {
    tumor: {
      code: "LUAD",
      label: "Lung adenocarcinoma",
      primarySite: "Lung",
    },
    panel: {
      manufacturer: "Acme",
      name: "Cancer Panel",
      version: "1",
    },
    specimenCollectionSite: "Lung",
  };

  it("requires tumor and panel context for somatic cases", async () => {
    await expect(
      cases.create({ ...baseCase, purpose: "somatic" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects somatic context on germline cases", async () => {
    await expect(
      cases.create({
        ...baseCase,
        purpose: "germline",
        somaticContext,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("legacy report purpose routing", () => {
  it.each([
    ["somatic", "Use the Somatic Clinical Report workflow"],
    ["germline", "Germline Clinical Reports are not enabled"],
  ] as const)(
    "routes %s report creation explicitly",
    async (purpose, message) => {
      state.rows = [[{ id: 61, purpose }]];
      await expect(
        reports.createDraft({ organizationId: 7, caseId: 61 })
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining(message),
      });
    }
  );
});
