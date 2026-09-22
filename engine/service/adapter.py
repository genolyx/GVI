"""Map the engine's native ``/api/analyze`` response onto CurationDocument v1.

The adapter builds the strict core of the document — the fields control-plane logic
branches on — and attaches the engine's response unmodified as the pass-through
layer. It deliberately does *not* restate the ~190 ``parsed_data`` keys: those
travel verbatim under ``engine.parsedData`` and the Curation UI reads them directly,
so an engine release that adds or renames a fact needs no change here.

The rule for deciding where something belongs: if the server branches on it, map it
into the core. If the server only forwards it to the screen, leave it in
``parsed_data``.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Optional

from .contract import (
    CURATION_CONTRACT_VERSION,
    CurationAcmg,
    CurationClassification,
    CurationCriterion,
    CurationDocument,
    CurationEngineOutput,
    CurationExon,
    CurationHighlights,
    CurationMeta,
    CurationScores,
    CurationVariant,
    PangolinScores,
    SpliceAiScores,
)

#: Engine weight strings → contract strength values.
_STRENGTH_MAP = {
    "stand_alone": "stand_alone",
    "standalone": "stand_alone",
    "very_strong": "very_strong",
    "verystrong": "very_strong",
    "strong": "strong",
    "moderate": "moderate",
    "supporting": "supporting",
}

_BASE_CODE_RE = re.compile(r"^(P(?:VS|S|M|P)\d|B(?:A|S|P)\d)", re.IGNORECASE)


def _text(value: Any) -> Optional[str]:
    """Normalise to a non-empty string or None. Engine uses "" for absent."""
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return str(value)


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _intish(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def _flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (list, tuple, dict, set)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _tribool(value: Any) -> Optional[bool]:
    return None if value is None else _flag(value)


def _mapping(value: Any) -> Optional[dict[str, Any]]:
    return value if isinstance(value, dict) else None


def _base_code(code: str) -> str:
    """Strip a strength suffix: "PVS1_Strong" → "PVS1"."""
    head = code.split("_", 1)[0].strip().upper()
    match = _BASE_CODE_RE.match(head)
    return match.group(1).upper() if match else head


def _criteria(raw: Any, warnings: list[str]) -> list[CurationCriterion]:
    items: list[CurationCriterion] = []
    for entry in raw or []:
        if not isinstance(entry, dict):
            continue
        code = _text(entry.get("code"))
        if not code:
            continue
        weight = (_text(entry.get("weight")) or "").lower()
        strength = _STRENGTH_MAP.get(weight)
        if strength is None:
            warnings.append(f"Unknown ACMG weight {weight!r} on {code}; recorded as supporting.")
            strength = "supporting"
        direction = "benign" if (_text(entry.get("type")) or "").lower() == "benign" else "pathogenic"
        items.append(
            CurationCriterion(
                code=code,
                baseCode=_base_code(code),
                strength=strength,
                direction=direction,
                rationale=_text(entry.get("desc")) or "",
            )
        )
    return items


def _classification(raw: Any) -> Optional[CurationClassification]:
    block = _mapping(raw)
    if not block:
        return None
    label = _text(block.get("label"))
    cls = (_text(block.get("class")) or "").lower()
    if not label:
        return None
    if cls not in ("pathogenic", "benign", "vus"):
        cls = "vus"
    return CurationClassification.model_validate({"label": label, "class": cls})


def _sources(parsed: dict[str, Any], hgmd_enabled: bool, gemini_enabled: bool) -> tuple[list[str], list[str]]:
    consulted: list[str] = ["Ensembl", "MyVariant", "ClinVar"]
    disabled: list[str] = []

    if _flag(parsed.get("spliceai_fetched")):
        consulted.append("SpliceAI")
    if _flag(parsed.get("pangolin_fetched")):
        consulted.append("Pangolin")
    if _flag(parsed.get("uniprot_domain_checked")):
        consulted.append("UniProt")
    if _text(parsed.get("clingen_haplo_score")) or _flag(parsed.get("has_clingen")):
        consulted.append("ClinGen")

    if hgmd_enabled:
        consulted.append("HGMD")
    else:
        disabled.append("HGMD")

    if gemini_enabled:
        consulted.append("Gemini")
    else:
        disabled.append("Gemini")

    return consulted, disabled


def to_curation_document(
    analyze_result: dict[str, Any],
    *,
    engine_version: str,
    duration_ms: int,
    hgmd_enabled: bool,
    gemini_enabled: bool,
    requested_gene: str = "",
    requested_hgvs_c: str = "",
) -> CurationDocument:
    """Build a CurationDocument from a successful ``/api/analyze`` response."""
    parsed: dict[str, Any] = analyze_result.get("parsed_data") or {}
    warnings: list[str] = []

    gene = _text(parsed.get("user_gene")) or _text(parsed.get("gene")) or _text(requested_gene)
    hgvs_c = _text(parsed.get("c_dot")) or _text(requested_hgvs_c)
    if not gene or not hgvs_c:
        raise ValueError("Engine response is missing gene or c_dot; cannot build a curation document")

    acmg_block = _mapping(analyze_result.get("results_acmg")) or {}
    literature_block = _mapping(analyze_result.get("literature")) or {}
    consulted, disabled = _sources(parsed, hgmd_enabled, gemini_enabled)

    return CurationDocument(
        contractVersion=CURATION_CONTRACT_VERSION,
        meta=CurationMeta(
            engineVersion=engine_version,
            generatedAt=datetime.now(timezone.utc).isoformat(),
            durationMs=max(0, int(duration_ms)),
            referenceBuild="GRCh38",
            sourcesConsulted=consulted,
            sourcesDisabled=disabled,
            warnings=warnings,
        ),
        variant=CurationVariant(
            gene=gene,
            effectiveGene=_text(analyze_result.get("effective_gene")) or _text(parsed.get("effective_gene")),
            transcript=_text(parsed.get("transcript")),
            ensemblTranscriptId=_text(parsed.get("ensembl_transcript_id")),
            hgvsC=hgvs_c,
            hgvsP=_text(parsed.get("hgvs_p")),
            consequence=_text(parsed.get("consequence")),
            chromosome=_text(parsed.get("grch38_chrom")) or _text(parsed.get("transcript_chrom")),
            start=_intish(parsed.get("grch38_start")),
            end=_intish(parsed.get("grch38_end")),
            referenceAllele=_text(parsed.get("ref")),
            alternateAllele=_text(parsed.get("alt")),
            strand=_intish(parsed.get("transcript_strand")),
            proteinLength=_intish(parsed.get("protein_length")),
            exon=CurationExon(
                rank=_intish(parsed.get("variant_exon")) or _intish(parsed.get("snpeff_exon_rank")),
                total=_intish(parsed.get("snpeff_exon_total")),
                codingRank=_intish(parsed.get("coding_exon_rank")),
                codingTotal=_intish(parsed.get("coding_exon_total")),
                mrnaTotal=_intish(parsed.get("mrna_exon_total")),
            ),
        ),
        scores=CurationScores(
            gnomadAf=_num(parsed.get("gnomad_af")),
            caddPhred=_num(parsed.get("cadd_phred")),
            revelScore=_num(parsed.get("revel_score")),
            spliceAi=SpliceAiScores(
                dsAg=_num(parsed.get("spliceai_ds_ag")),
                dsAl=_num(parsed.get("spliceai_ds_al")),
                dsDg=_num(parsed.get("spliceai_ds_dg")),
                dsDl=_num(parsed.get("spliceai_ds_dl")),
                dpAg=_intish(parsed.get("spliceai_dp_ag")),
                dpAl=_intish(parsed.get("spliceai_dp_al")),
                dpDg=_intish(parsed.get("spliceai_dp_dg")),
                dpDl=_intish(parsed.get("spliceai_dp_dl")),
                fetched=_flag(parsed.get("spliceai_fetched")),
                source=_text(parsed.get("spliceai_in_silico_source")),
            ),
            pangolin=PangolinScores(
                dsSg=_num(parsed.get("pangolin_ds_sg")),
                dsSl=_num(parsed.get("pangolin_ds_sl")),
                dpSg=_intish(parsed.get("pangolin_dp_sg")),
                dpSl=_intish(parsed.get("pangolin_dp_sl")),
                fetched=_flag(parsed.get("pangolin_fetched")),
            ),
        ),
        acmg=CurationAcmg(
            criteria=_criteria(acmg_block.get("criteria"), warnings),
            classification=_classification(acmg_block.get("classification")),
        ),
        highlights=CurationHighlights(
            clinvarSignificance=_text(parsed.get("clinvar_sig")),
            clinvarIdenticalPathogenic=_flag(parsed.get("identical_pathogenic")),
            hgmdEnabled=hgmd_enabled,
            hgmdMatch=_text(parsed.get("hgmd_local")),
            spliceApplicable=bool(
                _mapping(parsed.get("splice_viz"))
                or _mapping(parsed.get("junction_align_viz"))
                or _text(parsed.get("spliceai_narrative"))
            ),
            spliceIsInFrame=_tribool(parsed.get("splice_is_in_frame")),
            spliceNmdEscape=_tribool(parsed.get("nmd_escape")),
            literatureStatus=_text(literature_block.get("status")) or "skipped",
        ),
        engine=CurationEngineOutput(
            parsedData=parsed,
            resultsAcmg=analyze_result.get("results_acmg"),
            resultsCustom=analyze_result.get("results_custom"),
            literature=analyze_result.get("literature"),
            geneSummary=_text(analyze_result.get("gene_summary")),
        ),
    )
