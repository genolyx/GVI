"""CurationDocument v1 — Python mirror of ``shared/curation/document.ts``.

The document has two layers with opposite trade-offs.

``core`` (meta / variant / scores / acmg / highlights) is strict and versioned,
because control-plane logic branches on it: triage thresholds, ACMG merge, report
findings and the signature hash chain. Adding a field here is deliberately costly.

``engine`` carries the engine's own response unmodified. Curation is the product's
core value and it evolves on the engine's schedule, so re-typing all ~190
``parsed_data`` keys in two languages would make every engine release a contract
change. The Curation UI reads those keys directly instead, and an engine that adds
a fact needs no change here at all.

``shared/curation/document.test.ts`` validates documents produced here with the Zod
schema, so any drift between the two definitions fails the test suite.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

CURATION_CONTRACT_VERSION = "1.0"

CriterionStrength = Literal[
    "stand_alone",
    "very_strong",
    "strong",
    "moderate",
    "supporting",
]

#: ``parsed_data`` keys holding engine-rendered HTML. Mirrors ``ENGINE_HTML_KEYS``
#: in the TypeScript contract, where the client sanitises them before rendering.
#: Unlisted keys render as text, so an omission is cosmetic rather than unsafe.
ENGINE_HTML_KEYS = (
    "clinical_publication_summary_html",
    "cryptic_splice_narrative",
    "deep_intronic_splice_html",
    "junction_model_summary",
    "logic_explanation",
    "splice_frame_math",
    "splice_frame_math_exon_skip_ref",
    "splice_products_panel_html",
    "splice_pvs1_logic_sentence",
    "spliceai_secondary_splice_frame_math",
)


class _Model(BaseModel):
    # Reject unknown keys so an adapter typo surfaces as a validation error rather
    # than silently dropping a field the client expects.
    model_config = ConfigDict(extra="forbid")


class CurationMeta(_Model):
    engineVersion: str = Field(min_length=1, max_length=40)
    generatedAt: str = Field(min_length=1)
    durationMs: int = Field(ge=0)
    # The engine hardcodes hg38 in its external API calls.
    referenceBuild: Literal["GRCh38"]
    sourcesConsulted: list[str]
    sourcesDisabled: list[str]
    warnings: list[str]


class CurationExon(_Model):
    rank: Optional[int]
    total: Optional[int]
    codingRank: Optional[int]
    codingTotal: Optional[int]
    mrnaTotal: Optional[int]


class CurationVariant(_Model):
    gene: str = Field(min_length=1, max_length=80)
    effectiveGene: Optional[str] = Field(max_length=80)
    transcript: Optional[str] = Field(max_length=120)
    ensemblTranscriptId: Optional[str] = Field(max_length=60)
    hgvsC: str = Field(min_length=1, max_length=255)
    hgvsP: Optional[str] = Field(max_length=255)
    consequence: Optional[str] = Field(max_length=160)
    chromosome: Optional[str] = Field(max_length=16)
    start: Optional[int]
    end: Optional[int]
    referenceAllele: Optional[str]
    alternateAllele: Optional[str]
    strand: Optional[int]
    proteinLength: Optional[int]
    exon: CurationExon


class SpliceAiScores(_Model):
    dsAg: Optional[float]
    dsAl: Optional[float]
    dsDg: Optional[float]
    dsDl: Optional[float]
    dpAg: Optional[int]
    dpAl: Optional[int]
    dpDg: Optional[int]
    dpDl: Optional[int]
    fetched: bool
    source: Optional[str] = Field(max_length=60)


class PangolinScores(_Model):
    dsSg: Optional[float]
    dsSl: Optional[float]
    dpSg: Optional[int]
    dpSl: Optional[int]
    fetched: bool


class CurationScores(_Model):
    """Numeric evidence the triage pass thresholds on."""

    gnomadAf: Optional[float]
    caddPhred: Optional[float]
    revelScore: Optional[float]
    spliceAi: SpliceAiScores
    pangolin: PangolinScores


class CurationCriterion(_Model):
    # Engine code, which may carry a strength suffix such as "PVS1_Strong".
    code: str = Field(min_length=2, max_length=24)
    # Code stripped of any strength suffix; always a bare ACMG 2015 code.
    baseCode: str = Field(min_length=2, max_length=8)
    strength: CriterionStrength
    direction: Literal["pathogenic", "benign"]
    rationale: str


class CurationClassification(_Model):
    label: str = Field(min_length=1, max_length=80)
    cls: Literal["pathogenic", "benign", "vus"] = Field(alias="class")

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class CurationAcmg(_Model):
    criteria: list[CurationCriterion]
    classification: Optional[CurationClassification]


class CurationHighlights(_Model):
    """Non-numeric engine facts that control-plane logic branches on.

    Anything the server merely forwards to the UI stays in the pass-through layer.
    """

    clinvarSignificance: Optional[str]
    clinvarIdenticalPathogenic: bool
    hgmdEnabled: bool
    hgmdMatch: Optional[str]
    spliceApplicable: bool
    spliceIsInFrame: Optional[bool]
    spliceNmdEscape: Optional[bool]
    literatureStatus: str = Field(max_length=40)


class CurationEngineOutput(_Model):
    """The engine's response, unmodified.

    Validated for container shape only, so a new or renamed engine fact can never
    fail a run.
    """

    #: ``parsed_data`` verbatim: every fact the engine computed, ~190 keys.
    parsedData: dict[str, Any]
    #: ``results_acmg`` verbatim, as ``vc_engine/scoring.py`` emitted it.
    resultsAcmg: Any
    #: ``results_custom`` verbatim: the institutional rubric, when enabled.
    resultsCustom: Any
    #: Literature block attached after analysis by ``enrich_with_literature``.
    literature: Any
    geneSummary: Optional[str]


class CurationDocument(_Model):
    contractVersion: Literal["1.0"]
    meta: CurationMeta
    variant: CurationVariant
    scores: CurationScores
    acmg: CurationAcmg
    highlights: CurationHighlights
    engine: CurationEngineOutput


def document_json_schema() -> dict[str, Any]:
    """JSON Schema for the committed ``contracts/curation-document.v1.json``."""
    return CurationDocument.model_json_schema(by_alias=True)
