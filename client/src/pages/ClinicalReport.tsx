import { StatePanel } from "@/components/StatePanel";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { useParams } from "wouter";
import ReportEditorPage from "./ReportEditor";
import SomaticReportEditorPage from "./SomaticReportEditor";

/**
 * Purpose-safe report entry point.
 *
 * Existing untagged reports keep their existing renderer. New somatic reports
 * always carry an immutable template version and use the isolated somatic
 * renderer; no germline report code is reused for somatic sign-out.
 */
export default function ClinicalReportPage() {
  const params = useParams<{ id: string }>();
  const reportId = Number(params.id);
  const { activeOrganizationId, hasPermission } = useOrganization();
  const query = trpc.reports.get.useQuery(
    { organizationId: activeOrganizationId || 0, reportId },
    {
      enabled: Boolean(
        activeOrganizationId && reportId && hasPermission("report:read")
      ),
    }
  );
  if (query.isLoading)
    return (
      <StatePanel
        type="loading"
        title="Loading report"
        description="Selecting the purpose-specific clinical report renderer."
      />
    );
  if (query.isError || !query.data) {
    return (
      <StatePanel
        type="error"
        title="Failed to route clinical report"
        description={query.error?.message || "Report not found."}
      />
    );
  }
  return query.data.report.somaticTemplateVersionId ? (
    <SomaticReportEditorPage reportId={reportId} />
  ) : (
    <ReportEditorPage />
  );
}
