import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { parseGeneList } from "@shared/geneList";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

export type CaseVcfFilterValues = {
  genes: string;
  maxAf: string;
  minQual: string;
  minGq: string;
  minDepth: string;
  passOnly: boolean;
  codingOnly: boolean;
};

export const defaultVcfFilters: CaseVcfFilterValues = {
  genes: "",
  maxAf: "0.01",
  minQual: "",
  minGq: "",
  minDepth: "",
  passOnly: true,
  codingOnly: true,
};

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function vcfFiltersPayload(values: CaseVcfFilterValues, hpo: string) {
  return {
    hpo,
    genes: values.genes,
    maxAf: optionalNumber(values.maxAf),
    minQual: optionalNumber(values.minQual),
    minGenotypeQuality: optionalNumber(values.minGq),
    minDepth: optionalNumber(values.minDepth),
    passOnly: values.passOnly,
    codingOnly: values.codingOnly,
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
  panel: "outside the gene list",
  af: "allele frequency",
  qual: "QUAL",
  gq: "genotype quality",
  depth: "read depth",
  filter: "FILTER not PASS",
  impact: "low-impact or modifier",
};

export function CaseVcfFilters({
  organizationId,
  referenceBuild,
  file,
  hpo,
  values,
  onChange,
}: {
  organizationId: number;
  referenceBuild: "GRCh37" | "GRCh38";
  file: File | null;
  hpo: string;
  values: CaseVcfFilterValues;
  onChange: (values: CaseVcfFilterValues) => void;
}) {
  const panelFileRef = useRef<HTMLInputElement>(null);
  const listedGenes = parseGeneList(values.genes);
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
  }, [hpo]);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label htmlFor="case-genes">Gene panel or list</Label>
          <Button type="button" variant="outline" size="sm" onClick={() => panelFileRef.current?.click()}>Load panel file</Button>
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
                set({ genes: combined });
              } catch {
                toast.error("Could not read that panel file.");
              }
            }}
          />
        </div>
        <Textarea
          id="case-genes"
          value={values.genes}
          onChange={event => set({ genes: event.target.value })}
          placeholder="SCN1A, KCNQ2, STXBP1"
          className="min-h-24 font-mono text-sm"
        />
        <p className="text-xs leading-5 text-muted-foreground">
          {listedGenes === null
            ? "Paste a list or load a panel file. Commas, spaces, and new lines all work. Leave this empty to keep every gene from the HPO terms."
            : listedGenes.size === 0
              ? "No gene symbols were recognized in that text."
              : `${listedGenes.size.toLocaleString()} ${listedGenes.size === 1 ? "gene" : "genes"}. A variant must be in this list${hpo.trim() ? " and linked to the HPO terms above" : ""}.`}
        </p>
      </div>
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="case-af">Maximum allele frequency</Label>
          <Input id="case-af" value={values.maxAf} onChange={event => set({ maxAf: event.target.value })} inputMode="decimal" placeholder="0.01" className="font-mono" />
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
            preview.mutate({ organizationId, referenceBuild, vcfText, ...vcfFiltersPayload(values, hpo) });
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
