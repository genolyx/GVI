import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, Copy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type TemplateSchema = NonNullable<
  Awaited<ReturnType<typeof templateShape>>
>;

function templateShape() {
  return {
    schemaVersion: "1" as const,
    name: "Somatic Cancer Biomarker Report",
    locale: "en",
    sections: [] as Array<{
      id:
        | "case_summary"
        | "significant_findings"
        | "genomic_signatures"
        | "vus"
        | "variant_details"
        | "methodology"
        | "limitations"
        | "references"
        | "signatures";
      visible: boolean;
      title: string;
      editableIntro?: string;
    }>,
    includeTierIV: false,
    header: "",
    footer: "",
    disclaimer: "",
    negativeResult: {
      title:
        "Somatic Cancer Biomarker Report — No Reportable Alteration Detected",
      summary:
        "No reportable somatic alteration was detected within the validated scope of this assay.",
      interpretation:
        "No clinically reportable SNV/indel or reviewed biomarker alteration was identified. This result does not exclude alterations outside the validated reportable regions or below the assay limit of detection.",
      limitations:
        "A negative result is limited to the approved panel version, reportable-region artifact, specimen quality, validated alteration classes, and complete coverage documented in this report.",
    },
  };
}

export default function SomaticReportTemplatesPage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const query = trpc.somaticReports.templates.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId && hasPermission("report:read")) }
  );
  const [templateId, setTemplateId] = useState<number | undefined>();
  const [schema, setSchema] = useState<TemplateSchema>(templateShape());
  const [draftVersionId, setDraftVersionId] = useState<number | null>(null);

  useEffect(() => {
    const first = query.data?.[0];
    if (!first?.activeVersion) return;
    setTemplateId(first.template.id);
    setSchema(first.activeVersion.schema as TemplateSchema);
    setDraftVersionId(null);
  }, [query.data]);

  const createVersion = trpc.somaticReports.createTemplateVersion.useMutation({
    onSuccess: result => {
      setDraftVersionId(result.id);
      toast.success(`Template version ${result.version} saved as draft.`);
    },
    onError: error => toast.error(error.message),
  });
  const publish = trpc.somaticReports.publishTemplateVersion.useMutation({
    onSuccess: async result => {
      setDraftVersionId(null);
      await query.refetch();
      toast.success(`Template version ${result.version} published.`);
    },
    onError: error => toast.error(error.message),
  });

  if (!hasPermission("report:read")) {
    return (
      <StatePanel
        type="forbidden"
        title="Report template access required"
        description="Your organization role cannot view clinical report templates."
      />
    );
  }
  if (query.isLoading)
    return (
      <StatePanel
        type="loading"
        title="Loading report templates"
        description="Loading the active organization template and published version."
      />
    );
  if (query.isError) {
    return (
      <StatePanel
        type="error"
        title="Failed to load report templates"
        description={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Somatic clinical reporting"
        title="Report Templates"
        description="Customize organization-scoped, versioned Somatic Clinical Report sections. Published versions are immutable."
      />
      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Template identity</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <Field label="Template name">
            <Input
              value={schema.name}
              onChange={event =>
                setSchema(current => ({ ...current, name: event.target.value }))
              }
            />
          </Field>
          <Field label="Locale">
            <Input
              value={schema.locale}
              onChange={event =>
                setSchema(current => ({ ...current, locale: event.target.value }))
              }
            />
          </Field>
          <Field label="Header">
            <Input
              value={schema.header || ""}
              onChange={event =>
                setSchema(current => ({ ...current, header: event.target.value }))
              }
            />
          </Field>
          <Field label="Footer">
            <Input
              value={schema.footer || ""}
              onChange={event =>
                setSchema(current => ({ ...current, footer: event.target.value }))
              }
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            Validated full-panel negative wording
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Used only when the run, reportable regions, complete coverage, and
            organization negative-reporting policy all pass server-side gates.
          </p>
          <Field label="Negative report title">
            <Input
              value={schema.negativeResult?.title || ""}
              onChange={event =>
                setSchema(current => ({
                  ...current,
                  negativeResult: {
                    ...(current.negativeResult || templateShape().negativeResult),
                    title: event.target.value,
                  },
                }))
              }
            />
          </Field>
          {(
            [
              ["summary", "Result summary"],
              ["interpretation", "Interpretation"],
              ["limitations", "Negative-result limitations"],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <Textarea
                rows={4}
                value={schema.negativeResult?.[key] || ""}
                onChange={event =>
                  setSchema(current => ({
                    ...current,
                    negativeResult: {
                      ...(current.negativeResult ||
                        templateShape().negativeResult),
                      [key]: event.target.value,
                    },
                  }))
                }
              />
            </Field>
          ))}
        </CardContent>
      </Card>

      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Sections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {schema.sections.map((section, index) => (
            <div
              key={section.id}
              className="grid items-center gap-3 rounded-xl border border-border/70 p-4 sm:grid-cols-[auto_1fr]"
            >
              <Checkbox
                checked={section.visible}
                onCheckedChange={value =>
                  setSchema(current => ({
                    ...current,
                    sections: current.sections.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, visible: Boolean(value) }
                        : item
                    ),
                  }))
                }
              />
              <div>
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {section.id.replaceAll("_", " ")}
                </Label>
                <Input
                  className="mt-2"
                  value={section.title}
                  onChange={event =>
                    setSchema(current => ({
                      ...current,
                      sections: current.sections.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, title: event.target.value }
                          : item
                      ),
                    }))
                  }
                />
              </div>
            </div>
          ))}
          <label className="flex items-center gap-3 rounded-xl border border-border/70 p-4 text-sm">
            <Checkbox
              checked={schema.includeTierIV}
              onCheckedChange={value =>
                setSchema(current => ({
                  ...current,
                  includeTierIV: Boolean(value),
                }))
              }
            />
            Include Tier IV findings in the clinician report
          </label>
        </CardContent>
      </Card>

      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Clinical disclaimer</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            rows={6}
            value={schema.disclaimer}
            onChange={event =>
              setSchema(current => ({
                ...current,
                disclaimer: event.target.value,
              }))
            }
          />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          disabled={!hasPermission("report:draft") || createVersion.isPending}
          onClick={() =>
            createVersion.mutate({
              organizationId: activeOrganizationId!,
              templateId,
              name: schema.name,
              schema,
            })
          }
        >
          {createVersion.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Copy className="mr-2 size-4" />
          )}
          Save as new draft version
        </Button>
        {draftVersionId && hasPermission("report:review") ? (
          <Button
            disabled={publish.isPending}
            onClick={() =>
              publish.mutate({
                organizationId: activeOrganizationId!,
                versionId: draftVersionId,
              })
            }
          >
            <CheckCircle2 className="mr-2 size-4" />
            Publish this version
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
