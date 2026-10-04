import { useState } from "react";
import { Link } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/_core/hooks/useAuth";
import { isPlatformAdminRole } from "@shared/permissions";
import {
  CLASSIFICATION_FAST_SEARCH,
  classificationFastShort,
  type ClassificationFastShort,
} from "@shared/curation/classificationSearch";
import { caseDisplayName } from "@/lib/caseLabel";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { classificationTone } from "@/pages/workbench/status";

const PAGE_SIZE = 50;

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export default function ClassificationsPage() {
  const { user, loading } = useAuth();
  const isAdmin = isPlatformAdminRole(user?.role);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | "portal" | "gvc">("all");
  const [call, setCall] = useState<ClassificationFastShort | null>(null);
  const [offset, setOffset] = useState(0);
  const result = trpc.classifiedVariants.search.useQuery(
    { query, source, call: call ?? undefined, offset, limit: PAGE_SIZE },
    { enabled: isAdmin },
  );

  const applySearch = (nextSource = source) => {
    setSource(nextSource);
    setQuery(draft.trim());
    setOffset(0);
  };

  const applyCall = (short: ClassificationFastShort) => {
    setCall(current => (current === short ? null : short));
    setOffset(0);
  };

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
        title="Classifications are limited to platform admins"
        description="Classified variants from GVC cases and the portal API are visible only to platform admins."
      />
    );
  }

  const items = result.data?.items ?? [];
  const total = result.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Platform"
        title="Classifications"
        description="Variants classified by GVC, whether the case was opened here or sent through the portal API."
        badge={`${total}`}
      />
      <div className="space-y-3">
        <form
          className="flex max-w-xl items-center gap-2"
          onSubmit={event => {
            event.preventDefault();
            applySearch();
          }}
        >
          <Input
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="Gene, HGVS, case, or order"
            aria-label="Search classified variants"
          />
          <Button type="submit" size="sm">Search</Button>
        </form>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-2" role="group" aria-label="Source">
            <span className="text-xs font-medium text-muted-foreground">Source</span>
            {(["all", "portal", "gvc"] as const).map(value => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={source === value ? "default" : "outline"}
                onClick={() => applySearch(value)}
              >
                {value === "all" ? "All" : value === "portal" ? "Portal API" : "GVC"}
              </Button>
            ))}
          </div>
          <div className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
          <div className="flex items-center gap-2" role="group" aria-label="Classification">
            <span className="text-xs font-medium text-muted-foreground">Classification</span>
            {CLASSIFICATION_FAST_SEARCH.map(item => {
              const selected = call === item.short;
              return (
                <Button
                  key={item.short}
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-pressed={selected}
                  title={item.title}
                  className={cn(
                    "min-w-10 px-2.5",
                    selected && classificationTone(item.short === "VUS" ? "vus" : item.short === "B" || item.short === "LB" ? "benign" : "pathogenic")
                  )}
                  onClick={() => applyCall(item.short)}
                >
                  {item.short}
                </Button>
              );
            })}
          </div>
        </div>
      </div>
      {result.isLoading ? <Skeleton className="h-96" /> : null}
      {result.isError ? (
        <StatePanel
          type="error"
          title="Failed to read classifications"
          description={result.error.message}
          onRetry={() => { void result.refetch(); }}
        />
      ) : null}
      {result.data && items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No classified variants match this search.</p>
      ) : null}
      {items.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Gene</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Classification</TableHead>
              <TableHead>Institutional</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Case</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>Classified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(item => (
              <TableRow key={item.runId}>
                <TableCell className="font-medium">{item.gene || "—"}</TableCell>
                <TableCell className="max-w-xs">
                  <div className="font-mono text-xs">{item.hgvsC || `${item.chrom}:${item.pos} ${item.ref}>${item.alt}`}</div>
                  {item.hgvsP ? <div className="text-[11px] text-muted-foreground">{item.hgvsP}</div> : null}
                  {item.criteria.length > 0 ? (
                    <div className="text-[11px] text-muted-foreground">{item.criteria.join(", ")}</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs" title={item.classification || undefined}>
                  {classificationFastShort(item.classification) || "—"}
                </TableCell>
                <TableCell className="text-xs">{item.institutionalLabel || "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline">{item.source === "portal" ? "Portal API" : "GVC"}</Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {item.caseId ? (
                    <Link href={`/workbench/${item.caseId}`} className="underline-offset-2 hover:underline">
                      {caseDisplayName(item.caseNumber || "", item.externalOrderId) || item.caseId}
                    </Link>
                  ) : (
                    caseDisplayName(item.caseNumber || "", item.externalOrderId) || "—"
                  )}
                </TableCell>
                <TableCell className="text-xs">{item.organizationName}</TableCell>
                <TableCell className="text-xs">{formatWhen(item.completedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {total > PAGE_SIZE ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Button type="button" size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(current => Math.max(0, current - PAGE_SIZE))}>
            Previous
          </Button>
          <span>Page {page} of {pages}</span>
          <Button type="button" size="sm" variant="outline" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(current => current + PAGE_SIZE)}>
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
