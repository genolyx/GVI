import { parseGeneList } from "@shared/geneList";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { GeneSymbolList } from "./CaseVcfFilters";

export default function GermlinePanelsPage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const utils = trpc.useUtils();
  const panels = trpc.germlinePanels.list.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId && hasPermission("case:read")) }
  );
  const create = trpc.germlinePanels.create.useMutation({
    onSuccess: async result => {
      toast.success(
        `Panel saved with ${result.geneCount.toLocaleString()} genes${
          result.regionCount
            ? ` and ${result.regionCount.toLocaleString()} intervals`
            : ""
        }.`
      );
      setCode("");
      setName("");
      setDescription("");
      setGenesText("");
      setBedText("");
      setBedFileName("");
      await utils.germlinePanels.list.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [genomeBuild, setGenomeBuild] = useState<"" | "GRCh37" | "GRCh38">("");
  const [source, setSource] = useState<"genes" | "bed">("genes");
  const [genesText, setGenesText] = useState("");
  const [bedText, setBedText] = useState("");
  const [bedFileName, setBedFileName] = useState("");

  if (!hasPermission("case:read")) {
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="Germline interpretation"
          title="Interpretation panels"
          description="Named gene lists and BED intervals that limit which VCF variants are stored."
        />
        <StatePanel
          type="forbidden"
          title="You do not have permission to view panels"
          description="Ask your organization administrator for a role that includes case:read."
        />
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Germline interpretation"
        title="Interpretation panels"
        description="Save a gene list such as Carrier_302, or a BED of reportable intervals. A case copies the panel when it is created, and VCF ingest keeps variants in that scope."
      />
      <div className="clinical-card overflow-hidden">
        <div className="border-b border-border/70 px-5 py-4">
          <h2 className="font-display text-base">Saved panels</h2>
        </div>
        {panels.isError ? (
          <div className="p-4">
            <StatePanel
              compact
              type="error"
              title="Failed to load panels"
              description={panels.error.message}
              onRetry={() => {
                void panels.refetch();
              }}
            />
          </div>
        ) : panels.isLoading ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">Loading panels…</p>
        ) : panels.data?.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border/70">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Code</th>
                <th className="px-5 py-3 font-medium">Build</th>
                <th className="px-5 py-3 font-medium">Genes</th>
                <th className="px-5 py-3 font-medium">Intervals</th>
              </tr>
            </thead>
            <tbody>
              {panels.data.map(panel => (
                <tr key={panel.id} className="border-b border-border/50 last:border-0">
                  <td className="px-5 py-3 font-medium">{panel.name}</td>
                  <td className="px-5 py-3 font-mono text-xs">{panel.code}</td>
                  <td className="px-5 py-3">{panel.genomeBuild || "Either"}</td>
                  <td className="px-5 py-3">{panel.geneCount.toLocaleString()}</td>
                  <td className="px-5 py-3">{panel.regionCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-4">
            <StatePanel
              compact
              type="empty"
              title="No interpretation panels yet"
              description="Add a gene list or BED. Cases can then use it without re-uploading the same scope."
            />
          </div>
        )}
      </div>
      {hasPermission("case:create") ? (
        <form
          className="clinical-card space-y-5 p-5"
          onSubmit={event => {
            event.preventDefault();
            if (!activeOrganizationId) return;
            create.mutate({
              organizationId: activeOrganizationId,
              code,
              name,
              description: description || undefined,
              genomeBuild: genomeBuild || null,
              genesText: source === "genes" ? genesText : undefined,
              bedText: source === "bed" ? bedText : undefined,
            });
          }}
        >
          <div>
            <h2 className="font-display text-base">New panel</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              A gene list filters by symbol. A BED also keeps variants whose coordinates overlap an interval, including rows whose gene annotation is missing.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="panel-code">Code</Label>
              <Input
                id="panel-code"
                value={code}
                onChange={event => setCode(event.target.value)}
                placeholder="carrier_302"
                className="font-mono"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="panel-name">Display name</Label>
              <Input
                id="panel-name"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="Carrier 302"
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="panel-description">Description</Label>
            <Input
              id="panel-description"
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder="Optional note for reviewers"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="panel-build">Reference build</Label>
            <select
              id="panel-build"
              value={genomeBuild}
              onChange={event =>
                setGenomeBuild(event.target.value as "" | "GRCh37" | "GRCh38")
              }
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm sm:max-w-xs"
            >
              <option value="">Gene list, either build</option>
              <option value="GRCh38">GRCh38</option>
              <option value="GRCh37">GRCh37</option>
            </select>
          </div>
          <div className="flex gap-2">
            {(["genes", "bed"] as const).map(item => (
              <button
                key={item}
                type="button"
                onClick={() => setSource(item)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  source === item
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {item === "genes" ? "Gene list" : "BED intervals"}
              </button>
            ))}
          </div>
          {source === "genes" ? (
            <div className="space-y-2">
              <Label htmlFor="panel-genes">Genes</Label>
              <Textarea
                id="panel-genes"
                value={genesText}
                onChange={event => setGenesText(event.target.value)}
                placeholder="CFTR, HBB, GJB2"
                className="field-sizing-fixed h-20 max-h-20 min-h-0 resize-none overflow-y-auto font-mono text-sm"
                required
              />
              {(() => {
                const genes = parseGeneList(genesText);
                return genes?.size ? <GeneSymbolList genes={[...genes]} /> : null;
              })()}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="panel-bed">BED file</Label>
              <Input
                id="panel-bed"
                type="file"
                accept=".bed,.txt"
                onChange={async event => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  if (text.length > 20_000_000) {
                    toast.error("That BED is larger than 20 MB.");
                    event.target.value = "";
                    return;
                  }
                  setBedText(text);
                  setBedFileName(file.name);
                }}
                required={!bedText}
              />
              {bedFileName ? (
                <p className="text-xs text-muted-foreground">
                  {bedFileName} · {bedText.length.toLocaleString()} characters
                </p>
              ) : null}
            </div>
          )}
          <Button type="submit" disabled={create.isPending || !activeOrganizationId}>
            {create.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Save panel
          </Button>
        </form>
      ) : null}
    </div>
  );
}
