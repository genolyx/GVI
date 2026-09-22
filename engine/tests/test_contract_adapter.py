"""Contract conformance for the parsed_data → CurationDocument adapter.

SAM-VC already keeps golden `/api/analyze` responses under
``tests/regression/baseline/``. Running the adapter over those exact payloads proves
the mapping works against real engine output without needing network access, a
reference-data mount, or a warm engine process.

Each adapted document is also written to ``engine/tests/contract_fixtures/`` so
``shared/curation/document.test.ts`` can validate the same bytes with the Zod
schema. That round trip is what actually guarantees the Python and TypeScript
definitions agree.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from engine.service.adapter import _base_code, to_curation_document
from engine.service.contract import ENGINE_HTML_KEYS, CurationDocument, document_json_schema

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BASELINE_DIR = Path(__file__).resolve().parent / "regression" / "baseline"
FIXTURE_DIR = Path(__file__).resolve().parent / "contract_fixtures"
SCHEMA_PATH = REPO_ROOT / "contracts" / "curation-document.v1.json"

BASELINES = sorted(BASELINE_DIR.glob("*.baseline.json"))


def _adapt(path: Path) -> CurationDocument:
    payload = json.loads(path.read_text())
    return to_curation_document(
        payload,
        engine_version="v11",
        duration_ms=1234,
        hgmd_enabled=True,
        gemini_enabled=True,
    )


def test_baselines_exist() -> None:
    assert BASELINES, f"No regression baselines found in {BASELINE_DIR}"


@pytest.mark.parametrize("baseline", BASELINES, ids=lambda p: p.name)
def test_adapter_produces_valid_document(baseline: Path) -> None:
    document = _adapt(baseline)

    assert document.contractVersion == "1.0"
    assert document.meta.referenceBuild == "GRCh38"
    assert document.variant.gene
    assert document.variant.hgvsC.startswith(("c.", "n.", "r."))

    # Re-validating the serialised form catches adapter output that only happens to
    # satisfy the constructor.
    CurationDocument.model_validate(json.loads(document.model_dump_json(by_alias=True)))


@pytest.mark.parametrize("baseline", BASELINES, ids=lambda p: p.name)
def test_acmg_criteria_are_mapped(baseline: Path) -> None:
    document = _adapt(baseline)
    for criterion in document.acmg.criteria:
        assert criterion.direction in ("pathogenic", "benign")
        assert criterion.strength in (
            "stand_alone",
            "very_strong",
            "strong",
            "moderate",
            "supporting",
        )
        # The base code must be a bare ACMG 2015 code so it can key a
        # `criteria_assessments` row in the control plane.
        assert criterion.baseCode == criterion.baseCode.upper()
        assert criterion.code.upper().startswith(criterion.baseCode)


def test_strength_suffixed_codes_are_split() -> None:
    assert _base_code("PVS1_Strong") == "PVS1"
    assert _base_code("PP1_Strong") == "PP1"
    assert _base_code("PM2") == "PM2"
    assert _base_code("BA1") == "BA1"
    assert _base_code("BP7") == "BP7"


def test_amt_baseline_maps_known_values() -> None:
    """Pin the mapping against a baseline whose expected values are known."""
    baseline = BASELINE_DIR / "AMT_c.878-1G_A.baseline.json"
    document = _adapt(baseline)

    assert document.variant.gene == "AMT"
    assert document.variant.effectiveGene == "AMT"
    assert document.acmg.classification is not None
    assert document.acmg.classification.label == "Likely Pathogenic"
    assert document.acmg.classification.cls == "pathogenic"

    codes = {criterion.code for criterion in document.acmg.criteria}
    assert codes == {"PVS1_Strong", "PM2", "PP3"}

    pvs1 = next(c for c in document.acmg.criteria if c.code == "PVS1_Strong")
    assert pvs1.baseCode == "PVS1"
    # The engine downgraded PVS1 to Strong; that must survive into the contract so
    # the control plane can store it as a strengthOverride.
    assert pvs1.strength == "strong"

    assert document.highlights.spliceApplicable is True
    assert document.engine.geneSummary is not None


def test_hgmd_disabled_is_recorded() -> None:
    document = to_curation_document(
        json.loads((BASELINE_DIR / "AMT_c.878-1G_A.baseline.json").read_text()),
        engine_version="v11",
        duration_ms=10,
        hgmd_enabled=False,
        gemini_enabled=False,
    )
    assert "HGMD" in document.meta.sourcesDisabled
    assert "HGMD" not in document.meta.sourcesConsulted
    assert document.highlights.hgmdEnabled is False
    assert "Gemini" in document.meta.sourcesDisabled


@pytest.mark.parametrize("baseline", BASELINES, ids=lambda p: p.name)
def test_no_engine_fact_is_dropped(baseline: Path) -> None:
    """Every ``parsed_data`` key must reach the client.

    This is the guarantee that makes the pass-through layer worth its lack of type
    safety: the adapter can never quietly hide something the engine computed, so
    SAM-VC's analytical output arrives in GVI complete.
    """
    payload = json.loads(baseline.read_text())
    document = _adapt(baseline)

    source = payload["parsed_data"]
    delivered = json.loads(document.model_dump_json(by_alias=True))["engine"]["parsedData"]

    assert set(delivered) == set(source), "adapter changed the parsed_data key set"
    assert delivered == source, "adapter mutated parsed_data values"

    # Sibling blocks of the engine response travel alongside parsed_data.
    engine = json.loads(document.model_dump_json(by_alias=True))["engine"]
    assert engine["resultsAcmg"] == payload.get("results_acmg")
    assert engine["resultsCustom"] == payload.get("results_custom")


def test_html_key_list_covers_every_html_value() -> None:
    """Keep ``ENGINE_HTML_KEYS`` honest, since the client renders from that list.

    An unlisted HTML key renders as literal tags rather than markup, so the omission
    is cosmetic — but it is still a display bug, and the baselines can spot it.
    """
    html_like = re.compile(r"<(b|br|span|div|p|ul|li|table|a)\b", re.IGNORECASE)
    found: set[str] = set()
    for baseline in BASELINES:
        for key, value in json.loads(baseline.read_text())["parsed_data"].items():
            if isinstance(value, str) and html_like.search(value):
                found.add(key)

    assert found <= set(ENGINE_HTML_KEYS), (
        f"engine emits HTML in unlisted keys: {sorted(found - set(ENGINE_HTML_KEYS))}"
    )


def test_missing_gene_is_rejected() -> None:
    with pytest.raises(ValueError, match="missing gene or c_dot"):
        to_curation_document(
            {"parsed_data": {"c_dot": "c.1A>G"}},
            engine_version="v11",
            duration_ms=1,
            hgmd_enabled=True,
            gemini_enabled=True,
        )


def test_write_cross_language_fixtures() -> None:
    """Emit fixtures and the JSON Schema consumed by the TypeScript test suite."""
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True)

    for baseline in BASELINES:
        document = _adapt(baseline)
        name = baseline.name.replace(".baseline.json", ".document.json")
        # `generatedAt` is wall-clock, so pin it to keep fixtures diff-free.
        payload = json.loads(document.model_dump_json(by_alias=True))
        payload["meta"]["generatedAt"] = "2026-01-01T00:00:00+00:00"
        (FIXTURE_DIR / name).write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")

    schema = document_json_schema()
    schema["$id"] = "https://genolyx.com/contracts/curation-document.v1.json"
    schema["title"] = "CurationDocument v1"
    SCHEMA_PATH.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")

    assert list(FIXTURE_DIR.glob("*.document.json"))
