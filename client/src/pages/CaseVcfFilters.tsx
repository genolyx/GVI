import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  DEFAULT_MAX_ALLELE_FREQUENCY,
  FREQUENCY_TRACK_LABEL,
  frequencyTrackSummary,
  type FrequencyTrack,
} from "@shared/germlineFrequency";
import { parseGeneList } from "@shared/geneList";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export type CaseVcfFilterValues = {
  genes: string;
  maxAf: string;
  minQual: string;
  minGq: string;
  minDepth: string;
  passOnly: boolean;
  codingOnly: boolean;
  excludeClinvarBenign: boolean;
  excludeClinvarVus: boolean;
};

export const defaultVcfFilters: CaseVcfFilterValues = {
  genes: "",
  maxAf: String(DEFAULT_MAX_ALLELE_FREQUENCY),
  minQual: "",
  minGq: "",
  minDepth: "",
  passOnly: true,
  codingOnly: true,
  excludeClinvarBenign: false,
  excludeClinvarVus: false,
};

export function FrequencyRules({ track }: { track: FrequencyTrack }) {
  return (
    <div className="space-y-1 text-xs leading-5 text-muted-foreground">
      <p className="font-medium text-foreground">{FREQUENCY_TRACK_LABEL[track]}</p>
      <p>{frequencyTrackSummary(track)}</p>
    </div>
  );
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function vcfFiltersPayload(
  values: CaseVcfFilterValues,
  hpo: string,
  track: FrequencyTrack
) {
  return {
    hpo,
    genes: values.genes,
    maxAf: optionalNumber(values.maxAf),
    minQual: optionalNumber(values.minQual),
    minGenotypeQuality: optionalNumber(values.minGq),
    minDepth: optionalNumber(values.minDepth),
    passOnly: values.passOnly,
    codingOnly: values.codingOnly,
    excludeClinvarBenign: false,
    excludeClinvarVus: false,
    track,
  };
}

async function readVcf(file: File): Promise<string> {
  if (/\.gz$/i.test(file.name)) {
    const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return file.text();
}

const DROP_LABELS: Record<string, string> = {
  hpo: "outside the HPO genes",
  panel: "outside the interpretation panel",
  af: "allele frequency",
  qual: "QUAL",
  gq: "genotype quality",
  depth: "read depth",
  filter: "FILTER not PASS",
  impact: "low-impact or modifier",
  clinvar: "ClinVar benign or likely benign",
  vus: "ClinVar VUS on carrier screening",
  clinvarMix: "ClinVar VUS with benign",
};

function geneListCode(name: string, taken: Set<string>): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  let code = base.length >= 2 && /^[a-z0-9]/.test(base) ? base : "genes";
  if (!taken.has(code)) return code;
  let suffix = 2;
  while (taken.has(`${code}-${suffix}`)) suffix += 1;
  return `${code}-${suffix}`.slice(0, 80);
}

export function GeneSymbolList({ genes }: { genes: string[] }) {
  const sorted = [...genes].sort();
  return (
    <div className="max-h-40 overflow-y-auto rounded-lg border border-border/70 p-2">
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1">
        {sorted.map(gene => (
          <li
            key={gene}
            className="truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
            title={gene}
          >
            {gene}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GeneListField({
  organizationId,
  values,
  onChange,
  hpo,
  onListId,
}: {
  organizationId: number;
  values: CaseVcfFilterValues;
  onChange: (values: CaseVcfFilterValues) => void;
  hpo: string;
  onListId?: (panelId: string) => void;
}) {
  const utils = trpc.useUtils();
  const panelFileRef = useRef<HTMLInputElement>(null);
  const [listName, setListName] = useState("");
  const [savedId, setSavedId] = useState("");
  const [editingText, setEditingText] = useState(false);
  const listedGenes = parseGeneList(values.genes);
  const saved = trpc.germlinePanels.list.useQuery(
    { organizationId },
    { enabled: organizationId > 0 }
  );
  const geneLists = (saved.data ?? []).filter(panel => panel.geneCount > 0 && panel.regionCount === 0);
  const deleteList = trpc.germlinePanels.remove.useMutation({
    onSuccess: async result => {
      toast.success(`Deleted “${result.name}”.`);
      setSavedId("");
      await utils.germlinePanels.list.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const saveList = trpc.germlinePanels.create.useMutation({
    onSuccess: async result => {
      toast.success(`Saved “${listName.trim()}”.`);
      setListName("");
      setSavedId(String(result.id));
      await utils.germlinePanels.list.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label htmlFor="case-genes">Gene list</Label>
        <Button type="button" variant="outline" size="sm" onClick={() => panelFileRef.current?.click()}>
          Load gene list
        </Button>
        <input
          ref={panelFileRef}
          type="file"
          accept=".txt,.csv,.tsv,.genes"
          className="hidden"
          onChange={async event => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (!chosen) return;
            try {
              const text = await chosen.text();
              const combined = [values.genes.trim(), text.trim()].filter(Boolean).join("\n");
              onChange({ ...values, genes: combined });
              setEditingText(false);
            } catch {
              toast.error("Could not read that gene list.");
            }
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Saved gene lists"
          value={savedId}
          onChange={async event => {
            const id = event.target.value;
            setSavedId(id);
            if (!id || !organizationId) {
              onListId?.("");
              return;
            }
            try {
              const panel = await utils.germlinePanels.get.fetch({
                organizationId,
                panelId: Number(id),
              });
              onChange({ ...values, genes: panel.genes.join("\n") });
              setEditingText(false);
              onListId?.(id);
            } catch {
              toast.error("Could not load that gene list.");
            }
          }}
          className="h-9 min-w-48 rounded-lg border border-input bg-background px-3 text-sm"
        >
          <option value="">Use a saved list</option>
          {geneLists.map(panel => (
            <option key={panel.id} value={panel.id}>
              {panel.name} · {panel.geneCount.toLocaleString()} genes
            </option>
          ))}
        </select>
        <Input
          value={listName}
          onChange={event => setListName(event.target.value)}
          placeholder="Name this list"
          aria-label="Gene list name"
          className="h-9 w-44"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!listName.trim() || !listedGenes?.size || saveList.isPending || !organizationId}
          onClick={() => {
            if (!listedGenes?.size) return;
            const taken = new Set((saved.data ?? []).map(panel => panel.code));
            saveList.mutate({
              organizationId,
              code: geneListCode(listName, taken),
              name: listName.trim(),
              genomeBuild: null,
              genesText: values.genes,
            });
          }}
        >
          {saveList.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Save list
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!savedId || deleteList.isPending}
          onClick={() => {
            if (!savedId) return;
            deleteList.mutate({ organizationId, panelId: Number(savedId) });
          }}
        >
          Delete list
        </Button>
      </div>
      {listedGenes && listedGenes.size > 0 && !editingText ? (
        <GeneSymbolList genes={[...listedGenes]} />
      ) : (
        <Textarea
          id="case-genes"
          value={values.genes}
          onChange={event => {
            onChange({ ...values, genes: event.target.value });
            onListId?.("");
          }}
          placeholder="SCN1A, KCNQ2, STXBP1"
          className="field-sizing-fixed h-20 max-h-20 min-h-0 resize-none overflow-y-auto font-mono text-sm"
        />
      )}
      {listedGenes && listedGenes.size > 0 ? (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditingText(current => !current)}>
            {editingText ? "Show gene list" : "Edit as text"}
          </Button>
        </div>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        {listedGenes === null
          ? "Paste symbols or load a file. Commas, spaces, and new lines all work. Leave this empty to keep every gene."
          : listedGenes.size === 0
            ? "No gene symbols were recognized in that text."
            : `${listedGenes.size.toLocaleString()} ${listedGenes.size === 1 ? "gene" : "genes"}. A variant must be in this list${hpo.trim() ? " and linked to the HPO terms above" : ""}.`}
      </p>
    </div>
  );
}

export function CaseVcfFilters({
  organizationId,
  referenceBuild,
  file,
  hpo,
  values,
  onChange,
  panelScope,
  track,
}: {
  organizationId: number;
  referenceBuild: "GRCh37" | "GRCh38";
  file: File | null;
  hpo: string;
  values: CaseVcfFilterValues;
  onChange: (values: CaseVcfFilterValues) => void;
  panelScope?: { panelId?: number; bedText?: string } | null;
  track: FrequencyTrack;
}) {
  const preview = trpc.cases.previewVcf.useMutation({
    onError: error => toast.error(error.message),
  });
  const set = (patch: Partial<CaseVcfFilterValues>) => {
    preview.reset();
    onChange({ ...values, ...patch });
  };
  useEffect(() => {
    preview.reset();
    // Phenotype text lives on the case form. A change invalidates the last preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hpo, panelScope?.panelId, panelScope?.bedText]);

  return (
    <div className="space-y-8">
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="case-af">Maximum allele frequency</Label>
          <Input id="case-af" value={values.maxAf} onChange={event => set({ maxAf: event.target.value })} inputMode="decimal" placeholder="0.001" className="font-mono" />
          <p className="text-xs leading-5 text-muted-foreground">0.001 is 0.1%. Clear the field to skip the limit. 0.05 is 5%. Uses the VCF gnomAD or population frequency. A missing frequency is read from the local gnomAD file. Sample INFO AF is not used.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="case-qual">Minimum QUAL</Label>
          <Input id="case-qual" value={values.minQual} onChange={event => set({ minQual: event.target.value })} inputMode="decimal" placeholder="30" className="font-mono" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="case-gq">Minimum genotype quality (GQ)</Label>
          <Input id="case-gq" value={values.minGq} onChange={event => set({ minGq: event.target.value })} inputMode="decimal" placeholder="20" className="font-mono" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="case-dp">Minimum read depth (DP)</Label>
          <Input id="case-dp" value={values.minDepth} onChange={event => set({ minDepth: event.target.value })} inputMode="numeric" placeholder="10" className="font-mono" />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-10 gap-y-3">
        <label className="flex items-center gap-2.5 text-sm">
          <Checkbox checked={values.passOnly} onCheckedChange={checked => set({ passOnly: checked === true })} />
          FILTER is PASS
        </label>
        <label className="flex items-center gap-2.5 text-sm">
          <Checkbox checked={values.codingOnly} onCheckedChange={checked => set({ codingOnly: checked === true })} />
          Coding changes only
        </label>
      </div>
      <FrequencyRules track={track} />
      <Button
        type="button"
        variant="outline"
        disabled={!file || preview.isPending}
        onClick={async () => {
          if (!file) return;
          try {
            const vcfText = await readVcf(file);
            if (vcfText.length > 20_000_000) {
              toast.error("Preview reads the first portion of smaller VCFs. This file will still be filtered when the case is submitted.");
              return;
            }
            preview.mutate({
              organizationId,
              referenceBuild,
              vcfText,
              ...vcfFiltersPayload(values, hpo, track),
              germlinePanel: panelScope?.panelId
                ? { panelId: panelScope.panelId }
                : panelScope?.bedText
                  ? { bedText: panelScope.bedText }
                  : undefined,
            });
          } catch {
            toast.error("Could not read that VCF.");
          }
        }}
      >
        {preview.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        Preview what will be kept
      </Button>
      {preview.data ? (
        <div className="space-y-1 text-sm">
          <p>
            {preview.data.parsedCount.toLocaleString()} variants read.
            {preview.data.geneCount !== null ? ` HPO matched ${preview.data.geneCount.toLocaleString()} genes.` : ""}
            {preview.data.panelCount !== null ? ` Gene list has ${preview.data.panelCount.toLocaleString()} ${preview.data.panelCount === 1 ? "gene" : "genes"}.` : ""}
            {" "}
            <strong>{preview.data.kept.toLocaleString()}</strong> will be stored on the case.
          </p>
          <p className="text-muted-foreground">
            {Object.entries(preview.data.dropped)
              .filter(([, count]) => count > 0)
              .map(([reason, count]) => `${count.toLocaleString()} ${DROP_LABELS[reason] || reason}`)
              .join(" · ") || "Nothing was dropped."}
          </p>
          {preview.data.unmatched.length ? <p className="text-rose-700 dark:text-rose-300">Not in the HPO table: {preview.data.unmatched.join(", ")}</p> : null}
          {preview.data.sample.length ? <p className="font-mono text-xs">{preview.data.sample.map(row => `${row.gene || "?"} ${row.hgvsC || ""}`).join(" · ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
