import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useOrganization } from "@/contexts/OrganizationContext";
import { formatDateTime } from "@/lib/datetime";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, ArrowRight, Microscope } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";

const activeStatuses = new Set([
  "queued",
  "validating",
  "normalizing",
  "annotating",
]);

export default function SomaticWorkbenchHomePage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const canRead = hasPermission("variant:read");
  const queue = trpc.somatic.listReviewQueue.useQuery(
    { organizationId: activeOrganizationId || 0 },
    {
      enabled: Boolean(activeOrganizationId && canRead),
      refetchInterval: query =>
        query.state.data?.some(
          item => item.latestRun && activeStatuses.has(item.latestRun.status)
        )
          ? 3000
          : false,
    }
  );
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return queue.data ?? [];
    return (queue.data ?? []).filter(item =>
      [
        item.clinicalCase.caseNumber,
        item.clinicalCase.patientAlias,
        item.tumor.label,
        item.tumor.code,
        item.panel.manufacturer,
        item.panel.name,
        item.panelVersion.version,
        item.latestRun?.status,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [queue.data, search]);

  if (!canRead) {
    return (
      <StatePanel
        type="forbidden"
        title="Somatic workbench access required"
        description="Your organization role cannot read variant interpretations."
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Somatic cancer interpretation"
        title="Somatic Review Queue"
        description="Review target-panel cases using tumor-aware evidence and expert-controlled AMP assertions."
        actions={
          <div className="flex gap-2">
            {hasPermission("interpretation:edit") ? (
              <Button
                variant="outline"
                onClick={() => navigate("/somatic-governance")}
              >
                Governance
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => navigate("/workbench")}>
              <ArrowLeft className="mr-2 size-4" />
              Workbench
            </Button>
          </div>
        }
      />
      <Card className="clinical-card shadow-none">
        <CardContent className="space-y-4 p-5">
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Case, tumor, panel, version, or status"
            aria-label="Search somatic review queue"
            className="max-w-lg"
          />
          {queue.isError ? (
            <StatePanel
              compact
              type="error"
              title="Failed to load somatic cases"
              description={queue.error.message}
              onRetry={() => void queue.refetch()}
            />
          ) : queue.isLoading ? (
            <StatePanel
              compact
              type="loading"
              title="Loading somatic review queue"
              description="Loading case context and interpretation status."
            />
          ) : rows.length === 0 ? (
            <StatePanel
              compact
              type="empty"
              title={
                search.trim() ? "No matching somatic cases" : "No somatic cases"
              }
              description={
                search.trim()
                  ? "Try a different case, tumor, panel, or status."
                  : "Create a Somatic Case with a target-panel VCF to start this workflow."
              }
              action={
                !search.trim() && hasPermission("case:create") ? (
                  <Button onClick={() => navigate("/cases/new")}>
                    New Somatic Case
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-4">Case</th>
                    <th className="py-2 pr-4">Tumor</th>
                    <th className="py-2 pr-4">Panel / Version</th>
                    <th className="py-2 pr-4">Run</th>
                    <th className="py-2 pr-4">Assertions</th>
                    <th className="py-2 pr-4">Updated</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(item => (
                    <tr
                      key={item.clinicalCase.id}
                      className="border-b border-border/60"
                    >
                      <td className="py-3 pr-4">
                        <p className="font-mono text-xs font-semibold">
                          {item.clinicalCase.caseNumber}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.clinicalCase.patientAlias}
                        </p>
                      </td>
                      <td className="py-3 pr-4">
                        <p className="font-medium">{item.tumor.label}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.tumor.ontologySystem}{" "}
                          {item.tumor.ontologyVersion} · {item.tumor.code}
                        </p>
                      </td>
                      <td className="py-3 pr-4">
                        <p>
                          {item.panel.manufacturer} {item.panel.name}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.panelVersion.version} ·{" "}
                          {item.panelVersion.genomeBuild}
                        </p>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant="outline">
                          {item.latestRun?.status ?? "not started"}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4 text-xs">
                        <span className="text-emerald-700">
                          {item.assertionCounts.approved} approved
                        </span>
                        <span className="mx-2 text-muted-foreground">·</span>
                        <span
                          className={
                            item.assertionCounts.unresolved
                              ? "text-amber-700"
                              : "text-muted-foreground"
                          }
                        >
                          {item.assertionCounts.unresolved} unresolved
                        </span>
                      </td>
                      <td className="whitespace-nowrap py-3 pr-4 text-xs text-muted-foreground">
                        {formatDateTime(item.clinicalCase.updatedAt)}
                      </td>
                      <td className="py-3 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            navigate(`/workbench/${item.clinicalCase.id}`)
                          }
                        >
                          <Microscope className="mr-2 size-4" />
                          Review
                          <ArrowRight className="ml-2 size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
