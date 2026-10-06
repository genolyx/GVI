import { GeneListSettings } from "@/pages/GermlinePanels";
import { ClassifierLimitPanel } from "@/components/ClassifierLimitPanel";
import { PartnerAccessPanel } from "@/components/PartnerAccessPanel";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/_core/hooks/useAuth";
import { isPlatformAdminRole } from "@shared/permissions";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

const statusLabel: Record<string, string> = {
  ready: "Ready",
  missing: "Not installed",
  remote: "Live API",
  license: "License required",
  optional: "Not mounted",
  downloading: "Downloading",
};

function statusClass(status: string): string {
  if (status === "ready" || status === "remote") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "downloading") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (status === "license" || status === "missing") return "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200";
  return "border-border bg-muted text-muted-foreground";
}

export default function SettingsPage() {
  const { user, loading } = useAuth();
  const isAdmin = isPlatformAdminRole(user?.role);
  const query = trpc.referenceData.status.useQuery(undefined, { enabled: isAdmin });
  const setGnomad = trpc.referenceData.setGnomadSource.useMutation({
    onSuccess: () => {
      void query.refetch();
    },
    onError: error => {
      toast.error(error.message);
    },
  });
  const setClinvar = trpc.referenceData.setClinvarSource.useMutation({
    onSuccess: () => {
      void query.refetch();
    },
    onError: error => {
      toast.error(error.message);
    },
  });

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <StatePanel
        type="forbidden"
        title="Settings is limited to platform admins"
        description="Reference databases and the partner API are visible only to accounts with the platform admin role."
      />
    );
  }
  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <GeneListSettings />
        <PartnerAccessPanel />
        <ClassifierLimitPanel />
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="space-y-7">
        <PageHeader eyebrow="Platform" title="Settings" description="Reference data mounted for curation." />
        <GeneListSettings />
        <PartnerAccessPanel />
        <ClassifierLimitPanel />
        <StatePanel type="error" title="Failed to read reference data" description={query.error?.message || "No status returned."} onRetry={() => { void query.refetch(); }} />
      </div>
    );
  }

  const data = query.data;
  const ready = data.sources.filter(source => source.status === "ready" || source.status === "remote").length;

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Platform"
        title="Settings"
        description="Databases and services the curation engine can use on this server."
        badge={`${ready}/${data.sources.length} available`}
      />
      <GeneListSettings />
      <PartnerAccessPanel />
      <ClassifierLimitPanel />
      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="font-display text-base">Reference databases</CardTitle>
          <CardDescription className="text-xs">
            Data root <span className="font-mono">{data.dataRoot}</span>. Germline and somatic sources that are live APIs do not have a local file. OMIM stays empty until a licensed copy is placed on the server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Use</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>GVI usage</TableHead>
                <TableHead>Location</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.sources.map(source => (
                <TableRow key={source.id}>
                  <TableCell className="font-medium">{source.name}</TableCell>
                  <TableCell className="font-mono text-xs">{source.track}</TableCell>
                  <TableCell>
                    {source.choice && source.remoteChoice && source.remoteLabel ? (
                      <Select
                        value={source.choice}
                        disabled={source.id === "gnomad" ? setGnomad.isPending : setClinvar.isPending}
                        onValueChange={value => {
                          if (source.id === "gnomad" && (value === "myvariant" || value === "v3.1.2" || value === "v4.1")) {
                            setGnomad.mutate({ mode: value });
                          }
                          if (source.id === "clinvar" && (value === "local" || value === "ncbi")) {
                            setClinvar.mutate({ mode: value });
                          }
                        }}
                      >
                        <SelectTrigger size="sm" className="w-[15rem] text-xs" aria-label={`${source.name} source`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {source.localOptions ? (
                            source.localOptions.map(option => (
                              <SelectItem key={option.value} value={option.value} disabled={!option.ready}>
                                {option.label}
                              </SelectItem>
                            ))
                          ) : (
                            <SelectItem value="local" disabled={!source.localReady}>
                              {source.localVersion ? `Local file ${source.localVersion}` : "Local file"}
                            </SelectItem>
                          )}
                          <SelectItem value={source.remoteChoice}>{source.remoteLabel}</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="outline" className={statusClass(source.status)}>{statusLabel[source.status] || source.status}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{source.version}</TableCell>
                  <TableCell className="max-w-xs text-xs text-muted-foreground">{source.purpose}</TableCell>
                  <TableCell className="max-w-xs font-mono text-[10px] text-muted-foreground">{source.location}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
