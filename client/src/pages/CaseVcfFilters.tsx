import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import {
  DEFAULT_MAX_ALLELE_FREQUENCY,
  FREQUENCY_TRACKS,
  FREQUENCY_TRACK_LABEL,
  frequencyTrackSummary,
  type FrequencyTrack,
} from "@shared/germlineFrequency";
import { parseGeneList } from "@shared/geneList";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
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
  codingOnly: false,
  excludeClinvarBenign: false,
  excludeClinvarVus: false,
};

export function FrequencyRules({
  track,
  showTitle = true,
}: {
  track: FrequencyTrack;
  showTitle?: boolean;
}) {
  return (
    <div className="space-y-1 text-xs leading-5 text-muted-foreground">
      {showTitle ? (
        <p className="font-medium text-foreground">{FREQUENCY_TRACK_LABEL[track]}</p>
      ) : null}
      <p>{frequencyTrackSummary(track)}</p>
    </div>
  );
}

export function FilterTestTypeField({
  id,
  track,
  onChange,
}: {
  id: string;
  track: FrequencyTrack | "";
  onChange: (track: FrequencyTrack) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        Filter test type
        {track ? null : <span className="text-destructive"> *</span>}
      </Label>
      <select
        id={id}
        required
        className={`h-10 w-full max-w-xs rounded-lg border bg-background px-3 text-sm ${
          track ? "border-input" : "border-destructive"
        }`}
        value={track}
        onChange={event => {
          const value = event.target.value;
          if ((FREQUENCY_TRACKS as readonly string[]).includes(value)) {
            onChange(value as FrequencyTrack);
          }
        }}
      >
        <option value="">-</option>
        {FREQUENCY_TRACKS.map(item => (
          <option key={item} value={item}>
            {FREQUENCY_TRACK_LABEL[item]}
          </option>
        ))}
      </select>
    </div>
  );
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberField(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** Last analysis job, so Edit order can start from the filters that run used. */
export function filtersFromJobManifest(manifest: unknown): {
  values: CaseVcfFilterValues;
  track: FrequencyTrack | null;
} {
  const raw =
    manifest && typeof manifest === "object"
      ? (manifest as { vcfFilters?: unknown }).vcfFilters
      : null;
  const filters = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const trackValue = filters.track;
  const track =
    typeof trackValue === "string" &&
    (FREQUENCY_TRACKS as readonly string[]).includes(trackValue)
      ? (trackValue as FrequencyTrack)
      : null;
  return {
    track,
    values: {
      ...defaultVcfFilters,
      maxAf: numberField(filters.maxAf),
      minQual: numberField(filters.minQual),
      minGq: numberField(filters.minGenotypeQuality),
      minDepth: numberField(filters.minDepth),
      passOnly: filters.passOnly !== false,
      codingOnly: false,
    },
  };
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
    codingOnly: false,
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
  clinvar: "ClinVar benign, non-coding or homozygous",
  lab: "Benign or likely benign from a major laboratory",
  vus: "ClinVar VUS on carrier screening",
  clinvarMix: "ClinVar VUS with benign",
  intron: "more than 20 bp into the intron",
  utr: "UTR or flanking, away from the start codon",
};

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
  const [savedId, setSavedId] = useState("");
  const [geneQuery, setGeneQuery] = useState("");
  const listedGenes = parseGeneList(values.genes);
  const query = geneQuery.trim().toUpperCase();
  const visibleGenes = [...(listedGenes ?? [])].filter(gene => !query || gene.includes(query));
  const saved = trpc.germlinePanels.list.useQuery(
    { organizationId },
    { enabled: organizationId > 0 }
  );
  const geneLists = (saved.data ?? []).filter(panel => panel.geneCount > 0 && panel.regionCount === 0);
  const selected = geneLists.find(panel => String(panel.id) === savedId);
  return (
    <div className="space-y-2">
      <Label htmlFor="case-gene-list">Gene list</Label>
      <div className="flex flex-wrap items-center gap-2">
      <select
        id="case-gene-list"
        aria-label="Saved gene lists"
        value={savedId}
        onChange={async event => {
          const id = event.target.value;
          setSavedId(id);
          setGeneQuery("");
          onListId?.(id);
          if (!id || !organizationId) {
            onChange({ ...values, genes: "" });
            return;
          }
          try {
            const panel = await utils.germlinePanels.get.fetch({
              organizationId,
              panelId: Number(id),
            });
            onChange({ ...values, genes: panel.genes.join("\n") });
          } catch {
            setSavedId("");
            onListId?.("");
            toast.error("Could not load that gene list.");
          }
        }}
        className="h-9 min-w-48 flex-1 rounded-lg border border-input bg-background px-3 text-sm"
      >
        <option value="">No gene list</option>
        {geneLists.map(panel => (
          <option key={panel.id} value={panel.id}>
            {panel.name} · {panel.code} · {panel.geneCount.toLocaleString()} genes
            {panel.shared ? " · Shared" : ""}
          </option>
        ))}
      </select>
      <Input
        value={geneQuery}
        onChange={event => setGeneQuery(event.target.value)}
        placeholder="Search"
        aria-label="Search genes"
        disabled={!selected}
        className="h-9 w-44 font-mono"
      />
      </div>
      {selected && listedGenes?.size ? (
        visibleGenes.length ? (
          <GeneSymbolList genes={visibleGenes} />
        ) : (
          <p className="text-xs text-muted-foreground">No genes match {geneQuery.trim()}.</p>
        )
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        {selected
          ? `${query ? `${visibleGenes.length.toLocaleString()} of ` : ""}${selected.geneCount.toLocaleString()} genes. Code ${selected.code}. Portal analysis requests match this code.`
          : "Choose a shared panel or one saved for this organization, or use HPO terms."}
        {selected && hpo.trim() ? " A variant must also be linked to the HPO terms above." : ""}
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
  onTrackChange,
}: {
  organizationId: number;
  referenceBuild: "GRCh37" | "GRCh38";
  file: File | null;
  hpo: string;
  values: CaseVcfFilterValues;
  onChange: (values: CaseVcfFilterValues) => void;
  panelScope?: { panelId?: number; bedText?: string } | null;
  track: FrequencyTrack | "";
  onTrackChange: (track: FrequencyTrack) => void;
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
      <FilterTestTypeField id="case-filter-track" track={track} onChange={onTrackChange} />
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
      <div className="space-y-2">
        <label className="flex items-center gap-2.5 text-sm">
          <Checkbox checked={values.passOnly} onCheckedChange={checked => set({ passOnly: checked === true })} />
          FILTER is PASS
        </label>
        <p className="max-w-xl text-xs leading-5 text-muted-foreground">
          The VCF FILTER column. PASS means the caller did not flag the site. Uncheck this to also keep sites the caller marked, such as LowQual.
        </p>
      </div>
      {track ? <FrequencyRules track={track} showTitle={false} /> : null}
      <Button
        type="button"
        variant="outline"
        disabled={!file || !track || preview.isPending}
        onClick={async () => {
          if (!file || !track) return;
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
