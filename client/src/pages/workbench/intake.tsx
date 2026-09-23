import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";

export type VariantIntakeValues = {
  gene: string;
  hgvsC: string;
  transcript?: string;
  hgvsP?: string;
  labId?: string;
  externalCaseId?: string;
  pmids?: string;
  clinicalNotes?: string;
};

export function VariantIntakeForm({
  pending,
  submitLabel,
  extras,
  onSubmit,
}: {
  pending: boolean;
  submitLabel: string;
  extras?: boolean;
  onSubmit: (values: VariantIntakeValues) => void;
}) {
  const [gene, setGene] = useState("");
  const [hgvsC, setHgvsC] = useState("");
  const [transcript, setTranscript] = useState("");
  const [hgvsP, setHgvsP] = useState("");
  const [labId, setLabId] = useState("");
  const [externalCaseId, setExternalCaseId] = useState("");
  const [pmids, setPmids] = useState("");
  const [clinicalNotes, setClinicalNotes] = useState("");
  const canSubmit = gene.trim().length > 0 && hgvsC.trim().length > 2 && !pending;

  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={event => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit({
          gene: gene.trim(),
          hgvsC: hgvsC.trim(),
          transcript: transcript.trim() || undefined,
          hgvsP: hgvsP.trim() || undefined,
          labId: labId.trim() || undefined,
          externalCaseId: externalCaseId.trim() || undefined,
          pmids: pmids.trim() || undefined,
          clinicalNotes: clinicalNotes.trim() || undefined,
        });
        setHgvsC("");
        setTranscript("");
        setHgvsP("");
        setLabId("");
        setExternalCaseId("");
        setPmids("");
        setClinicalNotes("");
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="wb-gene">Gene</Label>
        <Input id="wb-gene" value={gene} onChange={event => setGene(event.target.value.toUpperCase())} placeholder="e.g. BRCA1" className="font-mono" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="wb-cdot">HGVSc</Label>
        <Input id="wb-cdot" value={hgvsC} onChange={event => setHgvsC(event.target.value)} placeholder="e.g. c.5266dupC" className="font-mono" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="wb-tx">Transcript (optional)</Label>
        <Input id="wb-tx" value={transcript} onChange={event => setTranscript(event.target.value)} placeholder="e.g. NM_007294.4" className="font-mono" />
      </div>
      {extras ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="wb-p">p. (optional)</Label>
            <Input id="wb-p" value={hgvsP} onChange={event => setHgvsP(event.target.value)} placeholder="e.g. p.Gln1756ProfsTer74" className="font-mono" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wb-lab">Lab ID (optional)</Label>
            <Input id="wb-lab" value={labId} onChange={event => setLabId(event.target.value)} placeholder="Sample / DNA ID" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wb-case">Case ID (optional)</Label>
            <Input id="wb-case" value={externalCaseId} onChange={event => setExternalCaseId(event.target.value)} placeholder="Case identifier" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="wb-pmids">PMIDs (optional)</Label>
            <Input id="wb-pmids" value={pmids} onChange={event => setPmids(event.target.value)} placeholder="e.g. 12345678, 23456789" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="wb-notes">Clinical notes (optional)</Label>
            <Textarea id="wb-notes" value={clinicalNotes} onChange={event => setClinicalNotes(event.target.value)} placeholder="Phenotype, family history, or other notes for literature summarization…" className="min-h-24 text-xs" />
          </div>
        </>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={!canSubmit}>
          {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Plus className="mr-2 size-4" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
