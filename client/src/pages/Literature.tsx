import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/_core/hooks/useAuth";
import { isPlatformAdminRole } from "@shared/permissions";
import { trpc } from "@/lib/trpc";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function LiteraturePage() {
  const { user, loading } = useAuth();
  const isAdmin = isPlatformAdminRole(user?.role);
  const query = trpc.referenceData.literature.useQuery(undefined, { enabled: isAdmin });

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
        title="Literature is limited to platform admins"
        description="Saved PubMed files are visible only to accounts with the platform admin role."
      />
    );
  }
  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="space-y-7">
        <PageHeader eyebrow="Platform" title="Literature" description="PubMed articles saved on this server." />
        <StatePanel type="error" title="Failed to read saved literature" description={query.error?.message || "No literature returned."} onRetry={() => { void query.refetch(); }} />
      </div>
    );
  }

  const data = query.data;
  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Platform"
        title="Literature"
        description={`${data.paperCount} saved file${data.paperCount === 1 ? "" : "s"} under ${data.pdfDir}. Articles appear after a curation run downloads them. PubMed itself is queried live and is not mirrored in full.`}
        badge={`${data.paperCount}`}
      />
      {data.papers.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No literature files have been saved yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>PMID</TableHead>
              <TableHead>File</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Saved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.papers.map(paper => (
              <TableRow key={paper.relativePath}>
                <TableCell className="font-mono text-xs">{paper.pmid || "—"}</TableCell>
                <TableCell className="max-w-md truncate font-mono text-[10px]">{paper.relativePath}</TableCell>
                <TableCell className="text-xs">{formatBytes(paper.bytes)}</TableCell>
                <TableCell className="text-xs">{paper.savedAt.slice(0, 10)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data.paperCount > data.papers.length ? (
        <p className="text-xs text-muted-foreground">Showing the {data.papers.length} most recent files of {data.paperCount}.</p>
      ) : null}
    </div>
  );
}
