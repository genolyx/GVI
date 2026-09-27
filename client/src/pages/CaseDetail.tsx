import { ClinicalStatus } from "@/components/ClinicalStatus";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Database,
  Dna,
  FileArchive,
  FlaskConical,
} from "lucide-react";
import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/datetime";
import { GermlineOrderFields } from "./GermlineOrderFields";
import {
  defaultGermlineOrder,
  GERMLINE_TEST_CATEGORY_LABEL,
  type GermlineOrderInput,
} from "@shared/germlineOrder";

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const caseId = Number(params.id);
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const query = trpc.cases.get.useQuery(
    { organizationId: activeOrganizationId || 0, caseId },
    {
      enabled: Boolean(
        activeOrganizationId && caseId && hasPermission("case:read")
      ),
    }
  );
  const timeline = trpc.cases.timeline.useQuery(
    { organizationId: activeOrganizationId || 0, caseId },
    {
      enabled: Boolean(
        activeOrganizationId && caseId && hasPermission("case:read")
      ),
    }
  );
  const createReport = trpc.somaticReports.createDraft.useMutation({
    onSuccess: result => navigate(`/reports/${result.id}`),
    onError: error => toast.error(error.message),
  });
  const [editingOrder, setEditingOrder] = useState(false);
  const [orderDraft, setOrderDraft] =
    useState<GermlineOrderInput>(defaultGermlineOrder);
  const saveOrder = trpc.cases.updateGermlineOrder.useMutation({
    onSuccess: async () => {
      toast.success("Order details saved.");
      setEditingOrder(false);
      await query.refetch();
    },
    onError: error => toast.error(error.message),
  });
  if (!hasPermission("case:read"))
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="Case management"
          title="Cases"
          description="View clinical cases within the organization boundary."
        />
        <StatePanel
          type="forbidden"
          title="You do not have permission to view cases"
          description="Ask your organization administrator for a role that includes the case:read action."
          action={
            <Button variant="outline" onClick={() => navigate("/")}>
              Dashboard
            </Button>
          }
        />
      </div>
    );
  if (query.isLoading)
    return (
      <div className="space-y-5">
        <Skeleton className="h-24" />
        <Skeleton className="h-80" />
      </div>
    );
  if (query.isError)
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="Case management"
          title="Case error"
          description="Unable to verify the requested case and organization access boundary."
        />
        <StatePanel
          type="error"
          title="Failed to load case"
          description={query.error.message}
          onRetry={() => {
            void query.refetch();
          }}
          action={
            <Button variant="outline" onClick={() => navigate("/cases")}>
              <ArrowLeft className="mr-2 size-4" />
              Back
            </Button>
          }
        />
      </div>
    );
  if (!query.data)
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="Case management"
          title="Case not found"
          description="Please verify the requested case identifier."
        />
        <StatePanel
          type="empty"
          title="Case not found"
          description="Cases that have been deleted or do not belong to the current organization are not shown."
          action={
            <Button variant="outline" onClick={() => navigate("/cases")}>
              <ArrowLeft className="mr-2 size-4" />
              Back
            </Button>
          }
        />
      </div>
    );
  const item = query.data;
  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow={`${item.purpose} · ${item.inputType}`}
        title={item.caseNumber}
        description={`${item.patientAlias} · ${item.referenceBuild} · ${item.panelName || "No panel"}${item.germlinePanel ? ` · ${item.germlinePanel.geneCount.toLocaleString()} genes${item.germlinePanel.regionCount ? `, ${item.germlinePanel.regionCount.toLocaleString()} intervals` : ""}` : ""}`}
        badge={item.status}
        actions={
          <>
            <Button variant="outline" onClick={() => navigate("/cases")}>
              <ArrowLeft className="mr-2 size-4" />
              Back
            </Button>
            {item.variantCount > 0 ? (
              <>
                {item.purpose === "somatic" && hasPermission("report:draft") ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      createReport.mutate({
                        organizationId: activeOrganizationId!,
                        caseId: item.id,
                      })
                    }
                    disabled={createReport.isPending}
                  >
                    Draft Somatic Report
                  </Button>
                ) : null}
                <Button onClick={() => navigate(`/workbench/${item.id}`)}>
                  <FlaskConical className="mr-2 size-4" />
                  {item.variantCount.toLocaleString()} variants
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {createReport.error ? (
        <StatePanel
          compact
          type="error"
          title="Failed to create report draft"
          description={createReport.error.message}
          onRetry={() =>
            createReport.mutate({
              organizationId: activeOrganizationId!,
              caseId: item.id,
            })
          }
        />
      ) : null}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Analysis status",
            value: <ClinicalStatus status={item.status} />,
            icon: Dna,
          },
          {
            label: "Variants",
            value: item.variantCount.toLocaleString(),
            icon: Database,
          },
          { label: "Samples", value: item.samples.length, icon: FlaskConical },
          { label: "Files", value: item.files.length, icon: FileArchive },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label} className="clinical-card shadow-none">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs text-muted-foreground">{label}</p>
                <div className="mt-2 text-lg font-semibold">{value}</div>
              </div>
              <Icon className="size-5 text-primary" />
            </CardContent>
          </Card>
        ))}
      </section>
      {item.purpose === "germline" ? (
        <GermlineOrderSection
          order={item.germlineOrder}
          patientAlias={item.patientAlias}
          canEdit={hasPermission("case:edit")}
          editing={editingOrder}
          draft={orderDraft}
          saving={saveOrder.isPending}
          onEdit={() => {
            setOrderDraft({
              ...defaultGermlineOrder,
              ...(item.germlineOrder ?? {}),
              patientName: item.germlineOrder?.patientName || item.patientAlias,
              testCategory:
                (item.germlineOrder?.testCategory as GermlineOrderInput["testCategory"]) ||
                defaultGermlineOrder.testCategory,
              reportMode:
                item.germlineOrder?.reportMode === "couples" ? "couples" : "single",
              patientGender:
                (item.germlineOrder?.patientGender as GermlineOrderInput["patientGender"]) ||
                "",
              patient2Gender:
                (item.germlineOrder?.patient2Gender as GermlineOrderInput["patient2Gender"]) ||
                "",
              patient3Gender:
                (item.germlineOrder?.patient3Gender as GermlineOrderInput["patient3Gender"]) ||
                "",
              patient2Affected:
                (item.germlineOrder?.patient2Affected as GermlineOrderInput["patient2Affected"]) ||
                "",
              patient3Affected:
                (item.germlineOrder?.patient3Affected as GermlineOrderInput["patient3Affected"]) ||
                "",
              affected:
                (item.germlineOrder?.affected as GermlineOrderInput["affected"]) || "",
              reportLanguage:
                (item.germlineOrder?.reportLanguage as GermlineOrderInput["reportLanguage"]) ||
                "",
              reportType:
                (item.germlineOrder?.reportType as GermlineOrderInput["reportType"]) || "",
              specimenType:
                (item.germlineOrder?.specimenType as GermlineOrderInput["specimenType"]) ||
                "Blood",
            });
            setEditingOrder(true);
          }}
          onCancel={() => setEditingOrder(false)}
          onChange={setOrderDraft}
          onSave={() =>
            saveOrder.mutate({
              organizationId: activeOrganizationId!,
              caseId: item.id,
              ...orderDraft,
            })
          }
        />
      ) : null}
      <section className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <CardTitle className="font-display text-base">
              Analysis timeline
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            {timeline.isError ? (
              <StatePanel
                compact
                type="error"
                title="Failed to load timeline"
                description={timeline.error.message}
                onRetry={() => {
                  void timeline.refetch();
                }}
              />
            ) : timeline.data?.length ? (
              timeline.data.map((event, index) => (
                <div key={event.id} className="grid grid-cols-[28px_1fr] gap-3">
                  <div className="flex flex-col items-center">
                    <div
                      className={`grid size-7 place-items-center rounded-full ${index === 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                    >
                      {index === 0 ? (
                        <CheckCircle2 className="size-3.5" />
                      ) : (
                        <Clock3 className="size-3.5" />
                      )}
                    </div>
                    {index < timeline.data.length - 1 ? (
                      <div className="h-full w-px bg-border" />
                    ) : null}
                  </div>
                  <div className="pb-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <ClinicalStatus status={event.status} />
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {event.progressPercent}%
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6">{event.message}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <StatePanel
                compact
                type="empty"
                title="No timeline entries"
                description="Status change history will appear here once analysis begins."
              />
            )}
          </CardContent>
        </Card>
        <div className="space-y-5">
          <Card className="clinical-card shadow-none">
            <CardHeader>
              <CardTitle className="font-display text-base">Samples</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {item.samples.map(sample => (
                <div
                  key={sample.id}
                  className="flex items-center justify-between rounded-xl border border-border/70 px-4 py-3"
                >
                  <div>
                    <p className="font-mono text-xs font-medium">
                      {sample.sampleCode}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {sample.specimenType}
                    </p>
                  </div>
                  <span className="text-xs capitalize text-muted-foreground">
                    {sample.role}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="clinical-card shadow-none">
            <CardHeader>
              <CardTitle className="font-display text-base">
                Input files
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {item.files.map(file => (
                <div
                  key={file.id}
                  className="rounded-xl border border-border/70 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-xs font-medium">
                      {file.fileName}
                    </p>
                    <span className="font-mono text-[9px] uppercase text-muted-foreground">
                      {file.kind}
                    </span>
                  </div>
                  <p className="mt-2 truncate font-mono text-[9px] text-muted-foreground">
                    SHA-256 {file.sha256}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}

function dash(value: string | null | undefined) {
  return value && value.trim() ? value : "—";
}

function OrderCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string]>;
}) {
  return (
    <Card className="clinical-card shadow-none">
      <CardHeader>
        <CardTitle className="font-display text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className={label === "Clinical information" ? "sm:col-span-2" : ""}
            >
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </dt>
              <dd className="mt-1 whitespace-pre-wrap text-sm">{dash(value)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function GermlineOrderSection({
  order,
  patientAlias,
  canEdit,
  editing,
  draft,
  saving,
  onEdit,
  onCancel,
  onChange,
  onSave,
}: {
  order: { [K in keyof GermlineOrderInput]: string } | null;
  patientAlias: string;
  canEdit: boolean;
  editing: boolean;
  draft: GermlineOrderInput;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onChange: (value: GermlineOrderInput) => void;
  onSave: () => void;
}) {
  const empty: Record<keyof GermlineOrderInput, string> = {
    ...defaultGermlineOrder,
    testCategory: "",
    reportMode: "",
    packageCode: "",
    patientName: patientAlias,
    reportLanguage: "",
    reportType: "",
    specimenType: "",
  };
  const current = order ?? empty;
  const category =
    order && order.testCategory in GERMLINE_TEST_CATEGORY_LABEL
      ? GERMLINE_TEST_CATEGORY_LABEL[
          order.testCategory as GermlineOrderInput["testCategory"]
        ]
      : "";
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-base font-semibold">Order details</h2>
        {canEdit ? (
          editing ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={onSave} disabled={saving}>
                Save order
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={onEdit}>
              Edit order
            </Button>
          )
        ) : null}
      </div>
      {editing ? (
        <GermlineOrderFields value={draft} onChange={onChange} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <OrderCard
            title="Test type and report pairing"
            rows={[
              ["Test category", category],
              ["Other test type", current.otherTestType],
              ["Package code (test type)", current.packageCode],
              ["Report mode", current.reportMode],
              ["Partner order ID", current.partnerCaseNumber],
              ["Prior order (follow-up)", current.priorCaseNumber],
            ]}
          />
          <OrderCard
            title="Hospital and identifiers"
            rows={[
              ["Hospital name", current.hospitalName],
              ["Doctor", current.doctor],
              ["Medical record ID", current.medicalRecordId],
              ["Sample ID", current.sampleId],
              ["Affected", current.affected],
              ["Clinical information", current.clinicalInformation],
            ]}
          />
          <OrderCard
            title="Patient"
            rows={[
              ["Patient name", current.patientName || patientAlias],
              ["Patient birth", current.patientBirth],
              ["Patient gender", current.patientGender],
              ...(current.patient2Name || current.patient2Gender
                ? ([
                    ["Patient 2", current.patient2Name],
                    ["Patient 2 birth", current.patient2Birth],
                    ["Patient 2 gender", current.patient2Gender],
                    ["Affected 2", current.patient2Affected],
                  ] as Array<[string, string]>)
                : []),
              ...(current.patient3Name || current.patient3Gender
                ? ([
                    ["Patient 3", current.patient3Name],
                    ["Patient 3 birth", current.patient3Birth],
                    ["Patient 3 gender", current.patient3Gender],
                    ["Affected 3", current.patient3Affected],
                  ] as Array<[string, string]>)
                : []),
            ]}
          />
          <OrderCard
            title="Sample and report details"
            rows={[
              ["Sample collection date", current.sampleCollectionDate],
              ["Receipt date", current.receiptDate],
              ["Report language", current.reportLanguage],
              ["Report type", current.reportType],
              ["Sample specimen type", current.specimenType],
              ["Sample barcode", current.sampleBarcode],
            ]}
          />
        </div>
      )}
    </section>
  );
}
