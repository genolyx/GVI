import { OmimFactCells, type OmimFact } from "@/components/OmimFacts";
import { TableWidthToggle, tableFrameClass, tableWidthClass, type TableWidthMode } from "@/components/TableWidthToggle";
import { AnalysisLogDialog } from "./AnalysisLogDialog";
import { clinvarRecordUrl, clinvarShortLabels } from "@/lib/clinvarLabel";
import { EffectLabel } from "@/components/EffectLabel";
import { alleleDepthLabel, zygosityLabel } from "@/lib/genotype";
import { classificationTone, entryAction, entryChip, focusClassifierRun, workbenchStatusClass, workbenchStatusLabel } from "./status";
import { SortHeader, compareSortValues, type SortDirection } from "./sort";
import { shortCallLabel } from "@shared/curation/institutional";
import { codingHgvs, displayHgvs, displayTranscript } from "@shared/transcript";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { carrierReviewBanner } from "@shared/carrierReview";
import { isAcmgSecondaryFindingGene } from "@shared/secondaryFindings";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export type CarrierVariantRow = {
  id: number;
  gene: string | null;
  transcript: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  consequence: string | null;
  zygosity: string | null;
  populationAf: string | null;
  vaf: string | null;
  readDepth: number | null;
  referenceDepth: number | null;
  alternateDepth: number | null;
  clinvarSignificance: string | null;
  heldReason?: string | null;
  reviewStatus: string;
  germlineClassification: string | null;
  institutionalLabel?: string | null;
  institutionalClass?: string | null;
  diseaseContext: string | null;
  omim?: OmimFact[];
  chromosome: string;
  position: number;
};

type PgxGene = {
  gene: string;
  source: string;
  diplotype: string;
  phenotype: string;
  alleleFunctions: string;
  category: "" | "actionable" | "normal";
  include: boolean;
};

type PgxExtended = {
  gene: string;
  rsid: string;
  variantName: string;
  genotype: string;
  zygosity: string;
  significance: string;
  drugs: string;
  evidenceLevel: string;
  include: boolean;
};

type GeneRecord = {
  gene: string;
  language: string;
  disorder: string;
  omimNumber: string;
  inheritance: string;
  functionSummary: string;
  diseaseAssociation: string;
};

const CLASS_OPTIONS = [
  "Pathogenic",
  "Likely Pathogenic",
  "VUS",
  "Likely Benign",
  "Benign",
] as const;

const TABS = ["Variants", "ClinVar filtered", "Secondary findings", "PGx", "Review Case", "Gene database"] as const;

function ClinVarChips({ significance, href }: { significance: string; href: string | null }) {
  const chips = clinvarShortLabels(significance).map(label => (
    <Badge key={label} variant="outline" className={cn(entryChip, classificationTone(classificationClass(label)))}>
      {label}
    </Badge>
  ));
  if (!href) return <span className="inline-flex flex-wrap gap-1">{chips}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title="Open this call in ClinVar"
      className="inline-flex flex-wrap gap-1 text-primary underline-offset-2 hover:underline"
    >
      {chips}
    </a>
  );
}

function heldReasonLabel(reason: string | null | undefined) {
  if (reason === "vus") return "ClinVar VUS";
  if (reason === "lab") return "Major lab benign";
  if (reason === "benign") return "ClinVar benign";
  return reason || "";
}

function isPlp(value: string | null) {
  const text = (value || "").toLowerCase();
  return text === "pathogenic" || text === "likely pathogenic";
}

function classificationClass(label: string) {
  const text = label.toLowerCase();
  if (text === "p" || text === "path" || text === "lp" || text.includes("pathogenic")) return "pathogenic";
  if (text === "b" || text === "benign" || text === "lb" || text.includes("benign")) return "benign";
  return "vus";
}

const DISEASE_NAME_LIMIT = 60;

function diseasePreview(name: string): { text: string; title?: string } {
  if (name.length <= DISEASE_NAME_LIMIT) return { text: name };
  return { text: `${name.slice(0, DISEASE_NAME_LIMIT - 1)}…`, title: name };
}

function omimFactsFor(variants: CarrierVariantRow[], gene: string): OmimFact[] {
  return variants.find(row => (row.gene || "").toUpperCase() === gene)?.omim ?? [];
}

function clippedHgvs(value: string | null | undefined) {
  const text = value?.trim() || "";
  if (!text) return "—";
  return (
    <span className="block max-w-[16rem] truncate" title={text.length > 22 ? text : undefined}>
      {text}
    </span>
  );
}

function formatAf(value: string | null) {
  if (!value) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number === 0) return "0";
  return number >= 0.001 ? number.toFixed(4) : number.toExponential(2);
}

type VariantSortKey =
  | "gene"
  | "hgvs"
  | "hgvsp"
  | "transcript"
  | "omim"
  | "inheritance"
  | "disease"
  | "effect"
  | "zygosity"
  | "depth"
  | "af"
  | "clinvar"
  | "acmg"
  | "institutional";

function variantSortValue(
  row: CarrierVariantRow,
  key: VariantSortKey,
  runStatus: string | undefined
): string | number | null {
  if (key === "gene") return row.gene || "";
  if (key === "hgvs") return codingHgvs(row.hgvsC) || "";
  if (key === "hgvsp") return row.hgvsP || "";
  if (key === "transcript") return displayTranscript(row.transcript) || "";
  if (key === "omim") return (row.omim ?? []).map(item => item.omimId).join(" ");
  if (key === "inheritance") return (row.omim ?? []).map(item => item.inheritance).filter(Boolean).join(" ");
  if (key === "disease") return (row.omim ?? []).map(item => item.disease).filter(Boolean).join(" ");
  if (key === "effect") return row.consequence || "";
  if (key === "zygosity") return row.zygosity || "";
  if (key === "depth") return row.readDepth;
  if (key === "af") {
    if (!row.populationAf) return null;
    const number = Number(row.populationAf);
    return Number.isFinite(number) ? number : null;
  }
  if (key === "clinvar") return row.clinvarSignificance || "";
  if (key === "acmg") return row.germlineClassification || (runStatus ? workbenchStatusLabel(runStatus) : "");
  if (key === "institutional") return row.institutionalLabel || "";
  return row.reviewStatus === "unreviewed" ? "" : row.reviewStatus;
}

function alleleDepth(row: CarrierVariantRow) {
  return alleleDepthLabel(row.readDepth, row.alternateDepth, row.referenceDepth);
}

function vafPercent(value: string | null) {
  if (!value) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number <= 1 ? number * 100 : number;
}

function emptyGene(): PgxGene {
  return {
    gene: "",
    source: "",
    diplotype: "",
    phenotype: "",
    alleleFunctions: "",
    category: "",
    include: true,
  };
}

function emptyExtended(): PgxExtended {
  return {
    gene: "",
    rsid: "",
    variantName: "",
    genotype: "",
    zygosity: "",
    significance: "",
    drugs: "",
    evidenceLevel: "",
    include: true,
  };
}

export function GermlineCarrierReview({
  organizationId,
  caseId,
  patientAlias,
  panelName,
  variants,
  loading,
  error,
  onRetry,
  onClassify,
  canCurate,
  secondaryFindingsConsent,
}: {
  organizationId: number;
  caseId: number;
  patientAlias: string;
  panelName: string | null;
  variants: CarrierVariantRow[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onClassify: (variantId: number) => void;
  canCurate: boolean;
  secondaryFindingsConsent: boolean;
}) {
  const utils = trpc.useUtils();
  const review = trpc.germlineReview.get.useQuery({ organizationId, caseId });
  const classifier = trpc.curation.list.useQuery(
    { organizationId, caseId, limit: 200 },
    {
      refetchInterval: query => {
        const rows = query.state.data;
        if (!rows?.some(row => row.status === "queued" || row.status === "loading" || row.status === "running")) {
          return false;
        }
        return 3000;
      },
    }
  );
  const runHeld = trpc.curation.enqueueVariant.useMutation({
    onSuccess: async result => {
      toast.success(result.deduped ? "Already queued." : "Queued for classification.");
      await classifier.refetch();
    },
    onError: err => toast.error(err.message),
  });
  const enqueueClassifier = trpc.curation.enqueueCase.useMutation({
    onSuccess: async result => {
      toast.success(result.message);
      await Promise.all([classifier.refetch(), utils.variants.list.invalidate()]);
    },
    onError: err => toast.error(err.message),
  });
  const cancelClassifier = trpc.curation.cancelCase.useMutation({
    onSuccess: async result => {
      toast.success(
        result.cancelled
          ? `Cancelled ${result.cancelled} waiting variant${result.cancelled === 1 ? "" : "s"}. Any variant already running will finish.`
          : "Nothing else was waiting. Any variant already running will finish."
      );
      await classifier.refetch();
    },
    onError: err => toast.error(err.message),
  });
  const classifiedCount = classifier.data?.filter(row => row.status === "succeeded").length ?? 0;
  const seenClassified = useRef<number | null>(null);
  useEffect(() => {
    if (seenClassified.current === null) {
      seenClassified.current = classifiedCount;
      return;
    }
    if (classifiedCount === seenClassified.current) return;
    seenClassified.current = classifiedCount;
    void utils.variants.list.invalidate();
  }, [classifiedCount, utils]);
  const runByVariant = new Map<number, string>();
  for (const run of classifier.data ?? []) {
    if (!run.variantId) continue;
    if (!runByVariant.has(run.variantId)) runByVariant.set(run.variantId, run.status);
  }
  const classifierRuns = classifier.data ?? [];
  const classifierActive = classifierRuns.some(
    row => row.status === "queued" || row.status === "loading" || row.status === "running"
  );
  const queuedCount = classifierRuns.filter(row => row.status === "queued").length;
  const cancelledCount = classifierRuns.filter(row => row.status === "cancelled").length;
  const runningCount = classifierRuns.filter(row => row.status === "running" || row.status === "loading").length;
  const classifiedPercent =
    classifiedCount + queuedCount + runningCount > 0
      ? Math.round((classifiedCount / (classifiedCount + queuedCount + runningCount)) * 100)
      : 0;
  const focusedRun = focusClassifierRun(classifierRuns);
  const focusedVariant = focusedRun?.variantId
    ? variants.find(row => row.id === focusedRun.variantId)
    : undefined;
  const focusedGene = focusedVariant?.gene || focusedRun?.input?.gene || focusedRun?.gene || "Variant";
  const focusedTranscript = focusedVariant?.transcript || focusedRun?.input?.transcript;
  const focusedHgvs = displayHgvs(
    focusedTranscript,
    focusedVariant?.hgvsC || focusedRun?.input?.hgvsC || focusedRun?.hgvsC
  );
  const focusedLabel = focusedRun ? `${focusedGene} ${focusedHgvs}`.trim() : "";
  const save = trpc.germlineReview.save.useMutation({
    onSuccess: () => toast.success("Review saved."),
    onError: err => toast.error(err.message),
  });
  const saveGene = trpc.germlineReview.saveGene.useMutation({
    onSuccess: async () => {
      toast.success("Gene text saved.");
      await review.refetch();
    },
    onError: err => toast.error(err.message),
  });
  const saveNote = trpc.germlineReview.saveVariantNote.useMutation({
    onSuccess: async () => {
      toast.success("Variant note saved.");
      await review.refetch();
    },
    onError: err => toast.error(err.message),
  });
  const hydrated = useRef(false);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Variants");
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState("");
  const [geneFilter, setGeneFilter] = useState("");
  const [clinvarFilter, setClinvarFilter] = useState("");
  const [vafMode, setVafMode] = useState<"" | "include" | "exclude">("");
  const [vafFrom, setVafFrom] = useState("");
  const [vafTo, setVafTo] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [reviewerName, setReviewerName] = useState("");
  const [reviewerCode, setReviewerCode] = useState("");
  const [institution, setInstitution] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientDob, setPatientDob] = useState("");
  const [patientGender, setPatientGender] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [languages, setLanguages] = useState<string[]>(["EN"]);
  const [pgxGenes, setPgxGenes] = useState<PgxGene[]>([]);
  const [pgxExtended, setPgxExtended] = useState<PgxExtended[]>([]);
  const [pgxDraft, setPgxDraft] = useState<PgxGene>(emptyGene());
  const [extendedDraft, setExtendedDraft] = useState<PgxExtended>(emptyExtended());
  const [pgxQuery, setPgxQuery] = useState("");
  const [geneLang, setGeneLang] = useState<"EN" | "CN" | "KO">("EN");
  const [geneQuery, setGeneQuery] = useState("");
  const [editGene, setEditGene] = useState<GeneRecord | null>(null);
  const [noteVariantId, setNoteVariantId] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");
  const [preview, setPreview] = useState(false);
  const [tableWidth, setTableWidth] = useState<TableWidthMode>("full");
  const [sort, setSort] = useState<{ key: VariantSortKey; direction: SortDirection } | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    if (!review.data || hydrated.current) return;
    if (review.data.selectedVariantIds === null && loading) return;
    hydrated.current = true;
    setReviewerName(review.data.reviewerName);
    setReviewerCode(review.data.reviewerCode);
    setInstitution(review.data.institution);
    setPatientName(review.data.patientName || patientAlias);
    setPatientDob(review.data.patientDob);
    setPatientGender(review.data.patientGender);
    setPartnerName(review.data.partnerName);
    setLanguages(review.data.languages.length ? review.data.languages : ["EN"]);
    setPgxGenes(review.data.pgxGenes);
    setPgxExtended(review.data.pgxExtended);
    setSelected(
      new Set(
        review.data.selectedVariantIds ??
          variants.filter(row => !row.heldReason && isPlp(row.germlineClassification)).map(row => row.id)
      )
    );
  }, [review.data, variants, loading, patientAlias]);

  const reviewVariants = useMemo(
    () =>
      variants.filter(
        row =>
          !row.heldReason ||
          Boolean(row.germlineClassification) ||
          runByVariant.get(row.id) === "succeeded"
      ),
    [variants, classifier.data]
  );
  const heldVariants = useMemo(
    () =>
      variants.filter(
        row =>
          Boolean(row.heldReason) &&
          !row.germlineClassification &&
          runByVariant.get(row.id) !== "succeeded"
      ),
    [variants, classifier.data]
  );
  const secondaryCount = secondaryFindingsConsent
    ? reviewVariants.filter(row => isAcmgSecondaryFindingGene(row.gene)).length
    : 0;
  const showingHeld = tab === "ClinVar filtered";
  const tableVariants = showingHeld ? heldVariants : reviewVariants;
  const genes = useMemo(
    () =>
      Array.from(
        new Set(tableVariants.map(row => (row.gene || "").toUpperCase()).filter(Boolean))
      ).sort(),
    [tableVariants]
  );
  const banner = carrierReviewBanner(
    reviewVariants.map(row => ({
      gene: row.gene,
      classification: row.germlineClassification,
    }))
  );
  const visible = tableVariants.filter(row => {
    const query = search.trim().toLowerCase();
    if (query) {
      const haystack = [
        row.gene,
        row.hgvsC,
        row.transcript,
        displayTranscript(row.transcript),
        row.hgvsP,
        row.diseaseContext,
        row.chromosome,
        String(row.position),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (classFilter && (row.germlineClassification || "") !== classFilter) return false;
    if (geneFilter && (row.gene || "").toUpperCase() !== geneFilter) return false;
    if (clinvarFilter) {
      const clinvar = (row.clinvarSignificance || "").toLowerCase();
      if (clinvarFilter === "Benign") {
        if (!clinvar.includes("benign")) return false;
      } else if (!clinvar.includes(clinvarFilter.toLowerCase().replace(/_/g, " "))) {
        return false;
      }
    }
    if (vafMode) {
      const from = vafFrom.trim() ? Number(vafFrom) : 0;
      const to = vafTo.trim() ? Number(vafTo) : 100;
      const percent = vafPercent(row.vaf);
      const inside =
        percent != null &&
        percent >= Math.min(from, to) &&
        percent <= Math.max(from, to);
      if (vafMode === "include" && !inside) return false;
      if (vafMode === "exclude" && inside) return false;
    }
    return true;
  });
  const secondary = tab === "Secondary findings";
  const listed = secondary
    ? visible.filter(row => isAcmgSecondaryFindingGene(row.gene))
    : visible;
  const sortedListed = sort
    ? [...listed].sort((left, right) =>
        compareSortValues(
          variantSortValue(left, sort.key, runByVariant.get(left.id)),
          variantSortValue(right, sort.key, runByVariant.get(right.id)),
          sort.direction
        )
      )
    : listed;
  const toggleSort = (key: VariantSortKey) => {
    setSort(current =>
      current?.key === key && current.direction === "asc"
        ? { key, direction: "desc" }
        : { key, direction: "asc" }
    );
  };
  const notes = new Map((review.data?.notes ?? []).map(row => [row.variantId, row.notes]));
  const knowledge = review.data?.genes ?? [];

  const persist = () =>
    save.mutate({
      organizationId,
      caseId,
      reviewerName,
      reviewerCode,
      institution,
      patientName,
      patientDob,
      patientGender,
      partnerName,
      languages: languages.length ? (languages as ("EN" | "CN" | "KO")[]) : ["EN"],
      selectedVariantIds: Array.from(selected),
      pgxGenes,
      pgxExtended,
    });

  const selectedRows = variants.filter(row => selected.has(row.id));
  const geneScope = selectedRows.length
    ? Array.from(new Set(selectedRows.map(row => (row.gene || "").toUpperCase()).filter(Boolean)))
    : genes;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {patientAlias}
        {panelName ? ` · ${panelName}` : ""} · {reviewVariants.length.toLocaleString()} variants
        {banner.pathogenic ? ` · ${banner.pathogenic} P/LP` : ""}
        {banner.vus ? ` · ${banner.vus} VUS` : ""}
      </p>
      {classifierActive ? (
        <div className="flex w-full items-center gap-4 rounded-xl border border-sky-400 bg-sky-50 px-4 py-4 text-left text-sky-950 shadow-sm dark:border-sky-300/30 dark:bg-sky-300/10 dark:text-sky-100 dark:shadow-none">
          <Loader2 className="size-6 shrink-0 animate-spin text-sky-700 dark:text-sky-200" />
          <button type="button" onClick={() => setLogOpen(true)} className="min-w-0 flex-1 text-left">
            <span className="block text-base font-semibold">Classifier running</span>
            <span className="mt-1 block truncate font-mono text-sm">{focusedLabel}</span>
            <span className="mt-1 block text-sm">
              {classifiedCount} classified · {runningCount} running · {queuedCount} waiting
            </span>
            <span className="mt-2 block h-2 overflow-hidden rounded-full bg-sky-200 dark:bg-sky-300/20">
              <span className="block h-full bg-sky-600 dark:bg-sky-300" style={{ width: `${classifiedPercent}%` }} />
            </span>
          </button>
          <span className="flex shrink-0 flex-col items-stretch gap-2">
            {canCurate ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={cancelClassifier.isPending}
                onClick={() => cancelClassifier.mutate({ organizationId, caseId })}
              >
                {cancelClassifier.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Cancel
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="outline" onClick={() => setLogOpen(true)}>
              Log
            </Button>
          </span>
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-3">
        {classifierRuns.length ? (
          <p className="text-xs text-muted-foreground">
            Variant classifier: {classifiedCount} classified
            {cancelledCount ? ` · ${cancelledCount} cancelled` : ""}
          </p>
        ) : null}
        {classifierRuns.length ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setLogOpen(true)}>
            Log
          </Button>
        ) : null}
        {canCurate ? (
          <Button
            type="button"
            size="sm"
            disabled={enqueueClassifier.isPending || variants.length === 0}
            onClick={() => enqueueClassifier.mutate({ organizationId, caseId })}
          >
            {enqueueClassifier.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Run variant classifier
          </Button>
        ) : null}
      </div>
      )}
      <AnalysisLogDialog
        organizationId={organizationId}
        target={(() => {
          if (!logOpen) return null;
          const runs = classifier.data ?? [];
          const focused = focusClassifierRun(runs);
          if (!focused) return null;
          const done = runs.filter(run => run.status === "succeeded").length;
          return {
            runId: focused.id,
            gene: focusedVariant?.gene || focused.input?.gene || focused.gene || "",
            hgvs: displayHgvs(
              focusedVariant?.transcript || focused.input?.transcript,
              focusedVariant?.hgvsC || focused.input?.hgvsC || focused.hgvsC
            ),
            status: focused.status,
            note: `${done} done of ${runs.length}`,
          };
        })()}
        onClose={() => setLogOpen(false)}
      />
      <div
        className={`rounded-xl border px-4 py-3 ${
          banner.tone === "detected"
            ? "border-rose-500/40 bg-rose-50 text-rose-950 dark:bg-card dark:text-rose-300"
            : banner.tone === "uncertain"
              ? "border-amber-500/40 bg-amber-50 text-amber-950 dark:bg-card dark:text-amber-200"
              : "border-emerald-500/40 bg-emerald-50 text-emerald-950 dark:bg-card dark:text-emerald-300"
        }`}
      >
        <p className="text-sm font-semibold">{banner.title}</p>
        <p className="mt-1 text-xs">{banner.detail}</p>
      </div>
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-muted/40 p-1">
        {TABS.map(item => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              tab === item ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            {item === "Variants"
              ? `Variants (${reviewVariants.length})`
              : item === "ClinVar filtered"
                ? `ClinVar filtered (${heldVariants.length})`
                : item === "Secondary findings"
                  ? `Secondary findings (${secondaryCount})`
                  : item}
          </button>
        ))}
      </div>

      {tab === "Variants" || tab === "Secondary findings" || tab === "ClinVar filtered" ? (
        secondary && !secondaryFindingsConsent ? (
          <div className="rounded-xl border border-dashed px-4 py-10 text-center">
            <p className="text-sm font-medium">Secondary findings were not selected</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
              The Secondary findings checkbox next to the gene list was left off, so this list stays empty.
            </p>
          </div>
        ) : (
        <div className="space-y-3">
          {secondary ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Secondary findings is on. These stored variants are on the ACMG SF v3.2 list. Genes on that list are kept even when they are not on the selected gene list, and they use the same filter test type as the rest of this case.
            </p>
          ) : null}
          {showingHeld ? (
            <p className="text-xs leading-5 text-muted-foreground">
              These passed the panel, frequency, and intron or UTR window. Carrier screening sets aside a ClinVar VUS, a homozygous benign call, or a benign call from a major laboratory. Rare disease and hereditary cancer set aside Benign and Likely benign calls. They are not classified until you press Run.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search gene, position, disease..."
              className="max-w-xs"
            />
            <select
              aria-label="Classification"
              value={classFilter}
              onChange={event => setClassFilter(event.target.value)}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            >
              <option value="">All Classifications</option>
              {CLASS_OPTIONS.map(item => (
                <option key={item} value={item}>{shortCallLabel(item)}</option>
              ))}
            </select>
            <select
              aria-label="Gene"
              value={geneFilter}
              onChange={event => setGeneFilter(event.target.value)}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            >
              <option value="">All Genes</option>
              {genes.map(gene => (
                <option key={gene}>{gene}</option>
              ))}
            </select>
            <select
              aria-label="ClinVar"
              value={clinvarFilter}
              onChange={event => setClinvarFilter(event.target.value)}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            >
              <option value="">All ClinVar</option>
              <option value="Pathogenic">P</option>
              <option value="Likely pathogenic">LP</option>
              <option value="Uncertain">VUS</option>
              <option value="Benign">B / LB</option>
            </select>
            <select
              aria-label="VAF filter"
              value={vafMode}
              onChange={event =>
                setVafMode(event.target.value as "" | "include" | "exclude")
              }
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            >
              <option value="">VAF any</option>
              <option value="include">Show VAF range</option>
              <option value="exclude">Hide VAF range</option>
            </select>
            <Input
              value={vafFrom}
              onChange={event => setVafFrom(event.target.value)}
              placeholder="from %"
              disabled={!vafMode}
              className="w-24"
            />
            <Input
              value={vafTo}
              onChange={event => setVafTo(event.target.value)}
              placeholder="to %"
              disabled={!vafMode}
              className="w-24"
            />
            <span className="text-xs text-muted-foreground">
              {listed.length.toLocaleString()} variants
            </span>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const next = new Set(selected);
                  listed
                    .filter(row => isPlp(row.germlineClassification))
                    .forEach(row => next.add(row.id));
                  setSelected(next);
                }}
              >
                Select P/LP
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setSelected(current => {
                    const next = new Set(current);
                    listed.forEach(row => next.add(row.id));
                    return next;
                  })
                }
              >
                Select All Visible
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                Deselect All
              </Button>
              <TableWidthToggle mode={tableWidth} onChange={setTableWidth} />
            </div>
          </div>
          {error ? (
            <p className="text-sm text-rose-700">
              {error}{" "}
              <button type="button" className="underline" onClick={onRetry}>
                Retry
              </button>
            </p>
          ) : null}
          <div className={`rounded-xl border ${tableFrameClass(tableWidth)}`}>
            <table className={`${tableWidthClass(tableWidth)} text-left text-sm`}>
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2" />
                  {(
                    [
                      ["gene", "Gene"],
                      ["hgvs", "HGVSc"],
                      ["hgvsp", "HGVSp"],
                      ["transcript", "Transcript (NM)"],
                      ["omim", "OMIM"],
                      ["inheritance", "Inheritance"],
                      ["disease", "Disease"],
                      ["effect", "Effect"],
                      ["zygosity", "Zygosity"],
                      ["depth", "Ref / alt"],
                      ["af", "gnomAD AF"],
                      ["clinvar", "ClinVar"],
                      ["acmg", "ACMG"],
                      ["institutional", "Institutional"],
                    ] as const
                  ).map(([key, label]) => (
                    <SortHeader
                      key={key}
                      label={label}
                      className="px-3 py-2 font-medium"
                      active={sort?.key === key}
                      direction={sort?.direction ?? "asc"}
                      onClick={() => toggleSort(key)}
                    />
                  ))}
                  <th className="px-3 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={16} className="px-3 py-6 text-muted-foreground">
                      Loading variants…
                    </td>
                  </tr>
                ) : listed.length ? (
                  sortedListed.map(row => (
                    <tr
                      key={row.id}
                      className={cn(
                        "border-t border-border/60",
                        selected.has(row.id) && "[&>td]:bg-sky-400/20"
                      )}
                    >
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selected.has(row.id)}
                          onCheckedChange={checked =>
                            setSelected(current => {
                              const next = new Set(current);
                              if (checked) next.add(row.id);
                              else next.delete(row.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-2">{row.gene || "—"}</td>
                      <td className="px-3 py-2">{clippedHgvs(codingHgvs(row.hgvsC))}</td>
                      <td className="px-3 py-2">{clippedHgvs(row.hgvsP)}</td>
                      <td className="px-3 py-2" title={row.transcript || undefined}>
                        {displayTranscript(row.transcript) || "—"}
                      </td>
                      <OmimFactCells items={row.omim} className="px-3 py-2" />
                      <td className="max-w-[14rem] px-3 py-2">
                        <EffectLabel value={row.consequence} className="block" />
                      </td>
                      <td className="px-3 py-2" title={zygosityLabel(row.zygosity, row.readDepth, row.alternateDepth).title}>
                        {zygosityLabel(row.zygosity, row.readDepth, row.alternateDepth).label}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap" title={alleleDepth(row).title}>
                        {alleleDepth(row).text}
                        {alleleDepth(row).percent ? (
                          <span className="ml-2 text-muted-foreground">{alleleDepth(row).percent}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">{formatAf(row.populationAf)}</td>
                      <td className="px-3 py-2" title={row.clinvarSignificance || undefined}>
                        {row.clinvarSignificance && clinvarShortLabels(row.clinvarSignificance).length ? (
                          <ClinVarChips
                            significance={row.clinvarSignificance}
                            href={showingHeld ? clinvarRecordUrl(row) : null}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.germlineClassification ? (
                          <Badge
                            variant="outline"
                            className={cn(entryChip, classificationTone(classificationClass(row.germlineClassification)))}
                          >
                            {shortCallLabel(row.germlineClassification)}
                          </Badge>
                        ) : runByVariant.get(row.id) === "queued" || runByVariant.get(row.id) === "loading" || runByVariant.get(row.id) === "running" || runByVariant.get(row.id) === "failed" ? (
                          <Badge variant="outline" className={cn(entryChip, workbenchStatusClass(runByVariant.get(row.id) || ""))}>
                            {workbenchStatusLabel(runByVariant.get(row.id) || "")}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.institutionalLabel ? (
                          <Badge
                            variant="outline"
                            className={cn(entryChip, classificationTone(row.institutionalClass))}
                          >
                            {shortCallLabel(row.institutionalLabel)}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {showingHeld ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className={entryAction}
                            disabled={
                              !canCurate ||
                              runHeld.isPending ||
                              runByVariant.get(row.id) === "queued" ||
                              runByVariant.get(row.id) === "loading" ||
                              runByVariant.get(row.id) === "running"
                            }
                            title={heldReasonLabel(row.heldReason)}
                            onClick={() =>
                              runHeld.mutate({
                                organizationId,
                                variantId: row.id,
                                runLiterature: false,
                              })
                            }
                          >
                            {runByVariant.get(row.id) === "queued" ||
                            runByVariant.get(row.id) === "loading" ||
                            runByVariant.get(row.id) === "running"
                              ? "Running"
                              : "Run"}
                          </Button>
                        ) : (
                          <Button type="button" size="sm" variant="outline" className={entryAction} onClick={() => onClassify(row.id)}>
                            Classify
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={16} className="px-3 py-6 text-muted-foreground">
                      {secondary
                        ? "None of the stored variants are on the ACMG SF v3.2 list."
                        : showingHeld
                          ? "No ClinVar VUS or benign variants were held."
                          : "No variants match these filters."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        )
      ) : null}

      {tab === "PGx" ? (
        <div className="space-y-6">
          <p className="text-xs text-muted-foreground">
            Pharmacogenomic calls stored on this case. Add PharmCAT-style gene rows or extended-panel rows, then save which ones belong on the review.
          </p>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">PharmCAT genes</h3>
            <Input
              value={pgxQuery}
              onChange={event => setPgxQuery(event.target.value)}
              placeholder="Filter by gene, phenotype, diplotype..."
              className="max-w-sm"
            />
            <div className={`rounded-xl border ${tableFrameClass(tableWidth)}`}>
              <table className={`${tableWidthClass(tableWidth)} text-left text-xs`}>
                <thead className="bg-muted/50 text-[10px] uppercase text-muted-foreground">
                  <tr>
                    {["Include", "Gene", "Source", "Diplotype", "Phenotype", "Allele functions", "Category", ""].map(label => (
                      <th key={label || "remove"} className="px-3 py-2 font-medium">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pgxGenes.filter(row =>
                    `${row.gene} ${row.phenotype} ${row.diplotype}`.toLowerCase().includes(pgxQuery.trim().toLowerCase())
                  ).length ? (
                    pgxGenes.map((row, index) =>
                      `${row.gene} ${row.phenotype} ${row.diplotype}`.toLowerCase().includes(pgxQuery.trim().toLowerCase()) ? (
                        <tr key={`${row.gene}-${index}`} className="border-t">
                          <td className="px-3 py-2">
                            <Checkbox
                              checked={row.include}
                              onCheckedChange={checked =>
                                setPgxGenes(current =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, include: Boolean(checked) } : item
                                  )
                                )
                              }
                            />
                          </td>
                          <td className="px-3 py-2 font-semibold">{row.gene}</td>
                          <td className="px-3 py-2">{row.source || "—"}</td>
                          <td className="px-3 py-2 font-mono">{row.diplotype || "—"}</td>
                          <td className="px-3 py-2">{row.phenotype || "—"}</td>
                          <td className="px-3 py-2">{row.alleleFunctions || "—"}</td>
                          <td className="px-3 py-2">{row.category || "—"}</td>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              className="text-rose-700"
                              onClick={() => setPgxGenes(current => current.filter((_, itemIndex) => itemIndex !== index))}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ) : null
                    )
                  ) : (
                    <tr>
                      <td colSpan={8} className="px-3 py-4 text-muted-foreground">
                        No PharmCAT rows on this case.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input placeholder="Gene" value={pgxDraft.gene} onChange={event => setPgxDraft(current => ({ ...current, gene: event.target.value }))} />
              <Input placeholder="Source" value={pgxDraft.source} onChange={event => setPgxDraft(current => ({ ...current, source: event.target.value }))} />
              <Input placeholder="Diplotype" value={pgxDraft.diplotype} onChange={event => setPgxDraft(current => ({ ...current, diplotype: event.target.value }))} />
              <Input placeholder="Phenotype" value={pgxDraft.phenotype} onChange={event => setPgxDraft(current => ({ ...current, phenotype: event.target.value }))} />
              <Input placeholder="Allele functions" value={pgxDraft.alleleFunctions} onChange={event => setPgxDraft(current => ({ ...current, alleleFunctions: event.target.value }))} />
              <select
                value={pgxDraft.category}
                onChange={event =>
                  setPgxDraft(current => ({
                    ...current,
                    category: event.target.value as PgxGene["category"],
                  }))
                }
                className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">Category</option>
                <option value="actionable">Actionable</option>
                <option value="normal">Normal</option>
              </select>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!pgxDraft.gene.trim()) return;
                setPgxGenes(current => [...current, { ...pgxDraft, gene: pgxDraft.gene.trim().toUpperCase() }]);
                setPgxDraft(emptyGene());
              }}
            >
              Add gene call
            </Button>
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Extended PGx panel</h3>
            <div className={`rounded-xl border ${tableFrameClass(tableWidth)}`}>
              <table className={`${tableWidthClass(tableWidth)} text-left text-xs`}>
                <thead className="bg-muted/50 text-[10px] uppercase text-muted-foreground">
                  <tr>
                    {["Include", "Gene", "rsID", "Variant", "Genotype", "Zygosity", "Significance", "Drugs", "Evidence"].map(label => (
                      <th key={label} className="px-3 py-2 font-medium">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pgxExtended.length ? (
                    pgxExtended.map((row, index) => (
                      <tr key={`${row.gene}-${row.rsid}-${index}`} className="border-t">
                        <td className="px-3 py-2">
                          <Checkbox
                            checked={row.include}
                            onCheckedChange={checked =>
                              setPgxExtended(current =>
                                current.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, include: Boolean(checked) } : item
                                )
                              )
                            }
                          />
                        </td>
                        <td className="px-3 py-2 font-semibold">{row.gene}</td>
                        <td className="px-3 py-2">{row.rsid || "—"}</td>
                        <td className="px-3 py-2">{row.variantName || "—"}</td>
                        <td className="px-3 py-2 font-mono">{row.genotype || "—"}</td>
                        <td className="px-3 py-2">{row.zygosity || "—"}</td>
                        <td className="px-3 py-2">{row.significance || "—"}</td>
                        <td className="px-3 py-2">{row.drugs || "—"}</td>
                        <td className="px-3 py-2">{row.evidenceLevel || "—"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={9} className="px-3 py-4 text-muted-foreground">
                        No extended-panel rows.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input placeholder="Gene" value={extendedDraft.gene} onChange={event => setExtendedDraft(current => ({ ...current, gene: event.target.value }))} />
              <Input placeholder="rsID" value={extendedDraft.rsid} onChange={event => setExtendedDraft(current => ({ ...current, rsid: event.target.value }))} />
              <Input placeholder="Variant" value={extendedDraft.variantName} onChange={event => setExtendedDraft(current => ({ ...current, variantName: event.target.value }))} />
              <Input placeholder="Genotype" value={extendedDraft.genotype} onChange={event => setExtendedDraft(current => ({ ...current, genotype: event.target.value }))} />
              <Input placeholder="Zygosity" value={extendedDraft.zygosity} onChange={event => setExtendedDraft(current => ({ ...current, zygosity: event.target.value }))} />
              <Input placeholder="Significance" value={extendedDraft.significance} onChange={event => setExtendedDraft(current => ({ ...current, significance: event.target.value }))} />
              <Input placeholder="Affected drugs" value={extendedDraft.drugs} onChange={event => setExtendedDraft(current => ({ ...current, drugs: event.target.value }))} />
              <Input placeholder="Evidence level" value={extendedDraft.evidenceLevel} onChange={event => setExtendedDraft(current => ({ ...current, evidenceLevel: event.target.value }))} />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!extendedDraft.gene.trim()) return;
                setPgxExtended(current => [
                  ...current,
                  { ...extendedDraft, gene: extendedDraft.gene.trim().toUpperCase() },
                ]);
                setExtendedDraft(emptyExtended());
              }}
            >
              Add extended row
            </Button>
          </div>
          <Button type="button" onClick={persist} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Save PGx review
          </Button>
        </div>
      ) : null}

      {tab === "Review Case" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-xl border p-4 lg:col-span-2">
            <h3 className="text-sm font-semibold">Selected variants for report</h3>
            {selectedRows.length ? (
              <ul className="space-y-1 text-sm">
                {selectedRows.map(row => (
                  <li key={row.id} className="font-mono text-xs">
                    {row.gene || "—"} {displayHgvs(row.transcript, row.hgvsC)} {row.hgvsP || ""} · {row.germlineClassification || "Unclassified"}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No variants selected. Choose rows on the Variants tab.</p>
            )}
          </div>
          <div className="space-y-3 rounded-xl border p-4">
            <h3 className="text-sm font-semibold">Reviewer</h3>
            <Label htmlFor="rev-name">Reviewer name</Label>
            <Input id="rev-name" value={reviewerName} onChange={event => setReviewerName(event.target.value)} placeholder="Dr. Smith" />
            <Label htmlFor="rev-id">Reviewer ID</Label>
            <Input id="rev-id" value={reviewerCode} onChange={event => setReviewerCode(event.target.value)} placeholder="REV-001" />
            <Label htmlFor="rev-inst">Institution</Label>
            <Input id="rev-inst" value={institution} onChange={event => setInstitution(event.target.value)} placeholder="Genolyx Lab" />
          </div>
          <div className="space-y-3 rounded-xl border p-4">
            <h3 className="text-sm font-semibold">Patient</h3>
            <Label htmlFor="pat-name">Patient name</Label>
            <Input id="pat-name" value={patientName} onChange={event => setPatientName(event.target.value)} />
            <Label htmlFor="pat-dob">Date of birth</Label>
            <Input id="pat-dob" type="date" value={patientDob} onChange={event => setPatientDob(event.target.value)} />
            <Label htmlFor="pat-gender">Gender</Label>
            <select
              id="pat-gender"
              value={patientGender}
              onChange={event => setPatientGender(event.target.value)}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
            >
              <option value="">—</option>
              <option>Male</option>
              <option>Female</option>
            </select>
            <Label htmlFor="pat-partner">Partner name</Label>
            <Input id="pat-partner" value={partnerName} onChange={event => setPartnerName(event.target.value)} placeholder="For a couple test" />
          </div>
          <div className="space-y-3 rounded-xl border p-4 lg:col-span-2">
            <h3 className="text-sm font-semibold">Report languages</h3>
            <div className="flex flex-wrap gap-4 text-sm">
              {(["EN", "CN", "KO"] as const).map(code => (
                <label key={code} className="flex items-center gap-2">
                  <Checkbox
                    checked={languages.includes(code)}
                    onCheckedChange={checked =>
                      setLanguages(current => {
                        const next = new Set(current);
                        if (checked) next.add(code);
                        else next.delete(code);
                        return next.size ? Array.from(next) : ["EN"];
                      })
                    }
                  />
                  {code === "EN" ? "English (EN)" : code === "CN" ? "Chinese (CN)" : "Korean (KO)"}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setPreview(true)}>
                Preview HTML
              </Button>
              <Button type="button" onClick={persist} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Save review
              </Button>
            </div>
            {preview ? (
              <article className="space-y-3 rounded-xl bg-muted/30 p-4 text-sm">
                <h4 className="font-semibold">
                  {patientName || patientAlias} · {languages.join(", ")}
                </h4>
                <p>
                  Reviewer {reviewerName || "—"}
                  {institution ? `, ${institution}` : ""}
                  {partnerName ? ` · Partner ${partnerName}` : ""}
                </p>
                <p>{banner.title}</p>
                {selectedRows.map(row => {
                  const gene = knowledge.find(
                    item => item.gene === (row.gene || "").toUpperCase() && item.language === (languages[0] || "EN")
                  );
                  return (
                    <section key={row.id} className="border-t pt-2">
                      <p className="font-mono text-xs">
                        {row.gene} {displayHgvs(row.transcript, row.hgvsC)} {row.hgvsP || ""} · {row.germlineClassification || "Unclassified"}
                      </p>
                      {gene?.diseaseAssociation ? <p className="mt-1">{gene.diseaseAssociation}</p> : null}
                      {notes.get(row.id) ? <p className="mt-1 text-muted-foreground">{notes.get(row.id)}</p> : null}
                    </section>
                  );
                })}
                {pgxGenes.filter(row => row.include).length ? (
                  <section className="border-t pt-2">
                    <p className="font-semibold">PGx included</p>
                    {pgxGenes.filter(row => row.include).map(row => (
                      <p key={row.gene} className="text-xs">
                        {row.gene} {row.diplotype} {row.phenotype}
                      </p>
                    ))}
                  </section>
                ) : null}
              </article>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "Gene database" ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {selectedRows.length
              ? "Showing genes from the variants checked on the Variants tab."
              : "No variants are checked, so every gene on this case is listed."}{" "}
            Text is saved for the organization and reused on later cases.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={geneQuery}
              onChange={event => setGeneQuery(event.target.value)}
              placeholder="Filter gene or text..."
              className="max-w-xs"
            />
            <select
              aria-label="Narrative language"
              value={geneLang}
              onChange={event => setGeneLang(event.target.value as "EN" | "CN" | "KO")}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            >
              <option value="EN">English (EN)</option>
              <option value="CN">Chinese (CN)</option>
              <option value="KO">Korean (KO)</option>
            </select>
            <span className="text-xs text-muted-foreground">{geneScope.length} genes</span>
          </div>
          <div className={`rounded-xl border ${tableFrameClass(tableWidth)}`}>
            <table className={`${tableWidthClass(tableWidth)} text-left text-xs`}>
              <thead className="bg-muted/50 text-[10px] uppercase text-muted-foreground">
                <tr>
                  {["Gene", "HGVS", "Transcript (NM)", "Disorder", "OMIM", "Inheritance", "Gene function", "Disease association", "Variant notes", ""].map(label => (
                    <th key={label || "edit"} className="px-3 py-2 font-medium">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {geneScope
                  .filter(gene => {
                    const record = knowledge.find(item => item.gene === gene && item.language === geneLang);
                    const facts = omimFactsFor(variants, gene);
                    const blob = `${gene} ${record?.disorder || ""} ${record?.omimNumber || ""} ${record?.inheritance || ""} ${record?.functionSummary || ""} ${record?.diseaseAssociation || ""} ${facts.map(item => `${item.omimId} ${item.inheritance} ${item.disease}`).join(" ")}`.toLowerCase();
                    return blob.includes(geneQuery.trim().toLowerCase());
                  })
                  .map(gene => {
                    const record = knowledge.find(item => item.gene === gene && item.language === geneLang);
                    const rows = variants.filter(row => (row.gene || "").toUpperCase() === gene);
                    const facts = rows[0]?.omim ?? [];
                    const omimIds = record?.omimNumber?.trim()
                      ? record.omimNumber.trim().split(/[,\s]+/).filter(Boolean)
                      : [...new Set(facts.map(item => item.omimId))];
                    const inheritances = record?.inheritance?.trim()
                      ? [record.inheritance.trim()]
                      : [...new Set(facts.map(item => item.inheritance).filter(Boolean))];
                    const diseases = record?.disorder?.trim()
                      ? [record.disorder.trim()]
                      : [...new Set(facts.map(item => item.disease).filter(Boolean))];
                    return (
                      <tr key={gene} className="border-t align-top">
                        <td className="px-3 py-2 font-semibold">{gene}</td>
                        <td className="px-3 py-2 font-mono">
                          {rows.slice(0, 3).map(row => (
                            <div key={row.id}>
                              {displayHgvs(row.transcript, row.hgvsC) || "—"}
                              <div>{row.hgvsP || ""}</div>
                            </div>
                          ))}
                        </td>
                        <td className="px-3 py-2 font-mono">{displayTranscript(rows[0]?.transcript) || "—"}</td>
                        <td className="max-w-[16rem] px-3 py-2">
                          {diseases.length
                            ? diseases.map(name => {
                                const label = diseasePreview(name);
                                return (
                                  <div key={name} className="whitespace-nowrap" title={label.title}>
                                    {label.text}
                                  </div>
                                );
                              })
                            : "—"}
                        </td>
                        <td className="px-3 py-2">
                          {omimIds.length
                            ? omimIds.map(id => (
                                <div key={id}>
                                  <a
                                    href={facts.find(item => item.omimId === id)?.url || `https://omim.org/entry/${id}`}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="text-primary hover:underline"
                                  >
                                    {id}
                                  </a>
                                </div>
                              ))
                            : "—"}
                        </td>
                        <td className="px-3 py-2">
                          {inheritances.length ? inheritances.map(mode => <div key={mode}>{mode}</div>) : "—"}
                        </td>
                        <td className="max-w-[14rem] px-3 py-2">{record?.functionSummary || "—"}</td>
                        <td className="max-w-[16rem] px-3 py-2">
                          {record?.diseaseAssociation?.trim()
                            ? record.diseaseAssociation
                            : diseases.length
                              ? diseases.map(name => {
                                  const label = diseasePreview(name);
                                  return (
                                    <div key={name} title={label.title}>
                                      {label.text}
                                    </div>
                                  );
                                })
                              : "—"}
                        </td>
                        <td className="px-3 py-2">
                          {rows.map(row => (
                            <button
                              key={row.id}
                              type="button"
                              className="block text-left underline"
                              onClick={() => {
                                setNoteVariantId(row.id);
                                setNoteText(notes.get(row.id) || "");
                              }}
                            >
                              {row.hgvsC || row.id}: {notes.get(row.id) ? "edit" : "add"}
                            </button>
                          ))}
                        </td>
                        <td className="px-3 py-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setEditGene({
                                gene,
                                language: geneLang,
                                disorder: record?.disorder || diseases.join("; "),
                                omimNumber: record?.omimNumber || omimIds.join(", "),
                                inheritance: record?.inheritance || inheritances.join(", "),
                                functionSummary: record?.functionSummary || "",
                                diseaseAssociation: record?.diseaseAssociation || diseases.join("; "),
                              })
                            }
                          >
                            Edit
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {editGene ? (
            <div className="space-y-2 rounded-xl border p-4">
              <h3 className="text-sm font-semibold">
                {editGene.gene} · {editGene.language}
              </h3>
              <Input placeholder="Disorder" value={editGene.disorder} onChange={event => setEditGene({ ...editGene, disorder: event.target.value })} />
              <div className="grid gap-2 sm:grid-cols-2">
                <Input placeholder="OMIM" value={editGene.omimNumber} onChange={event => setEditGene({ ...editGene, omimNumber: event.target.value })} />
                <Input placeholder="Inheritance" value={editGene.inheritance} onChange={event => setEditGene({ ...editGene, inheritance: event.target.value })} />
              </div>
              <Textarea placeholder="Gene function" value={editGene.functionSummary} onChange={event => setEditGene({ ...editGene, functionSummary: event.target.value })} />
              <Textarea placeholder="Disease association" value={editGene.diseaseAssociation} onChange={event => setEditGene({ ...editGene, diseaseAssociation: event.target.value })} />
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={saveGene.isPending}
                  onClick={() =>
                    saveGene.mutate({
                      organizationId,
                      gene: editGene.gene,
                      language: editGene.language as "EN" | "CN" | "KO",
                      disorder: editGene.disorder,
                      omimNumber: editGene.omimNumber,
                      inheritance: editGene.inheritance,
                      functionSummary: editGene.functionSummary,
                      diseaseAssociation: editGene.diseaseAssociation,
                    })
                  }
                >
                  Save gene
                </Button>
                <Button type="button" variant="outline" onClick={() => setEditGene(null)}>
                  Close
                </Button>
              </div>
            </div>
          ) : null}
          {noteVariantId != null ? (
            <div className="space-y-2 rounded-xl border p-4">
              <h3 className="text-sm font-semibold">Variant note</h3>
              <Textarea value={noteText} onChange={event => setNoteText(event.target.value)} />
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={saveNote.isPending}
                  onClick={() =>
                    saveNote.mutate({
                      organizationId,
                      caseId,
                      variantId: noteVariantId,
                      notes: noteText,
                    })
                  }
                >
                  Save note
                </Button>
                <Button type="button" variant="outline" onClick={() => setNoteVariantId(null)}>
                  Close
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
