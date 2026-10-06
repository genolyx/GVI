import { geneListCode, parseGeneList } from "@shared/geneList";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { Copy, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { GeneSymbolList } from "./CaseVcfFilters";

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function GeneListSettings() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const utils = trpc.useUtils();
  const panels = trpc.germlinePanels.list.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId && hasPermission("case:read")) }
  );
  const create = trpc.germlinePanels.create.useMutation({
    onSuccess: async result => {
      toast.success(
        `Saved ${result.code} with ${result.geneCount.toLocaleString()} genes${
          result.regionCount
            ? ` and ${result.regionCount.toLocaleString()} intervals`
            : ""
        }.`
      );
      resetForm();
      await utils.germlinePanels.list.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const update = trpc.germlinePanels.update.useMutation({
    onSuccess: async result => {
      toast.success(`Updated ${result.code}.`);
      resetForm();
      await utils.germlinePanels.list.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingCode, setEditingCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [genomeBuild, setGenomeBuild] = useState<"" | "GRCh37" | "GRCh38">("");
  const [source, setSource] = useState<"genes" | "bed">("genes");
  const [genesText, setGenesText] = useState("");
  const [bedText, setBedText] = useState("");
  const [bedFileName, setBedFileName] = useState("");
  const takenCodes = new Set((panels.data ?? []).map(panel => panel.code));
  const draftCode = editingId ? editingCode : name.trim() ? geneListCode(name, takenCodes) : "";
  function resetForm() {
    setEditingId(null);
    setEditingCode("");
    setName("");
    setDescription("");
    setGenesText("");
    setBedText("");
    setBedFileName("");
    setGenomeBuild("");
    setSource("genes");
  }
  async function beginEdit(panelId: number) {
    if (!activeOrganizationId) return;
    try {
      const panel = await utils.germlinePanels.get.fetch({
        organizationId: activeOrganizationId,
        panelId,
      });
      setEditingId(panel.id);
      setEditingCode(panel.code);
      setName(panel.name);
      setDescription(panel.description ?? "");
      setGenomeBuild(panel.genomeBuild ?? "");
      if (panel.regions?.length) {
        setSource("bed");
        setGenesText("");
        setBedText(
          panel.regions
            .map(region =>
              [region.chromosome, String(region.start - 1), String(region.end), region.name ?? ""]
                .join("\t")
                .trimEnd()
            )
            .join("\n")
        );
        setBedFileName("Saved intervals");
      } else {
        setSource("genes");
        setGenesText(panel.genes.join("\n"));
        setBedText("");
        setBedFileName("");
      }
      document.getElementById("gene-list-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      toast.error("Could not open that gene list.");
    }
  }
  const remove = trpc.germlinePanels.remove.useMutation({
    onSuccess: async result => {
      toast.success(`Deleted “${result.name}”.`);
      await utils.germlinePanels.list.invalidate();
    },
    onError: error => toast.error(error.message),
  });

  if (!activeOrganizationId) {
    return (
      <StatePanel
        compact
        type="empty"
        title="Select an organization"
        description="Gene lists belong to the organization chosen in the sidebar."
      />
    );
  }
  if (!hasPermission("case:read")) {
    return (
      <StatePanel
        compact
        type="forbidden"
        title="You do not have permission to view gene lists"
        description="Ask your organization administrator for a role that includes case:read."
      />
    );
  }

  return (
    <Card className="clinical-card shadow-none">
      <CardHeader>
        <CardTitle className="font-display text-base">Gene lists</CardTitle>
        <CardDescription className="text-xs">
          Lists for {activeOrganization?.name || "this organization"}. A case chooses one of these lists. Portal analysis requests match the code. A BED keeps variants that overlap an interval.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
      <div className="overflow-hidden rounded-lg border border-border/70">
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
                <th className="px-5 py-3 font-medium"> </th>
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
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-2">
                      {hasPermission("case:create") ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void beginEdit(panel.id)}
                        >
                          Edit
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void copyText(panel.code).then(ok => {
                            if (ok) toast.success(`Copied ${panel.code}.`);
                            else toast.error("Could not copy the code.");
                          });
                        }}
                      >
                        <Copy className="mr-2 size-3.5" />
                        Copy
                      </Button>
                      {hasPermission("case:create") ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate({ organizationId: activeOrganizationId, panelId: panel.id })}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  </td>
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
          id="gene-list-editor"
          className="clinical-card space-y-5 p-5"
          onSubmit={event => {
            event.preventDefault();
            if (!activeOrganizationId || !draftCode) return;
            const body = {
              organizationId: activeOrganizationId,
              name,
              description: description || undefined,
              genomeBuild: genomeBuild || null,
              genesText: source === "genes" ? genesText : undefined,
              bedText: source === "bed" ? bedText : undefined,
            };
            if (editingId) update.mutate({ ...body, panelId: editingId });
            else create.mutate({ ...body, code: draftCode });
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-base">{editingId ? "Edit gene list" : "New gene list"}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {editingId
                  ? "Saving updates this list for new cases and Portal requests. Cases already created keep the genes they copied. The code stays the same."
                  : "A gene list filters by symbol. A BED also keeps variants whose coordinates overlap an interval, including rows whose gene annotation is missing."}
              </p>
            </div>
            {editingId ? (
              <Button type="button" variant="outline" size="sm" onClick={resetForm}>
                Cancel
              </Button>
            ) : null}
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="panel-name">Name</Label>
              <Input
                id="panel-name"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="Carrier 302"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="panel-code">Code</Label>
              <div className="flex gap-2">
                <Input
                  id="panel-code"
                  readOnly
                  value={draftCode}
                  placeholder="carrier-302"
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!draftCode}
                  onClick={() => {
                    void copyText(draftCode).then(ok => {
                      if (ok) toast.success(`Copied ${draftCode}.`);
                      else toast.error("Could not copy the code.");
                    });
                  }}
                >
                  <Copy className="mr-2 size-4" />
                  Copy
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {editingId
                  ? "Portal analysis requests keep matching this code."
                  : "The code is created from the name. Portal analysis requests match this code."}
              </p>
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
          <Button type="submit" disabled={create.isPending || update.isPending || !activeOrganizationId || !draftCode}>
            {create.isPending || update.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {editingId ? "Save changes" : "Save gene list"}
          </Button>
        </form>
      ) : null}
      </CardContent>
    </Card>
  );
}
