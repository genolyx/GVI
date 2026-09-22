"""MetaDome missense tolerance helpers — offline unit tests."""
from __future__ import annotations

from vc_engine.metadome import (
    _pick_metadome_transcript,
    _position_entry,
    _tolerance_label,
    apply_metadome_missense_lookup,
    metadome_ui_url,
)


def test_tolerance_bins():
    assert _tolerance_label(0.1) == "highly intolerant"
    assert _tolerance_label(0.4) == "intolerant"
    assert _tolerance_label(0.65) == "slightly intolerant"
    assert _tolerance_label(0.9) == "tolerant"
    assert _tolerance_label(None) == "unknown"


def test_pick_transcript_prefers_nm_match():
    entries = [
        {
            "gencode_id": "ENST00000455263.2",
            "aa_length": 346,
            "has_protein_data": True,
            "refseq_ids": ["NM_001126113.2"],
        },
        {
            "gencode_id": "ENST00000269305.4",
            "aa_length": 393,
            "has_protein_data": True,
            "refseq_ids": ["NM_000546.5", "NM_001126112.2"],
        },
    ]
    picked = _pick_metadome_transcript(entries, target_nm="NM_000546.6")
    assert picked["gencode_id"] == "ENST00000269305.4"


def test_position_entry_by_index():
    landscape = {
        "positional_annotation": [
            {"protein_pos": 1, "sw_dn_ds": 1.0},
            {"protein_pos": 2, "sw_dn_ds": 0.2},
        ]
    }
    e = _position_entry(landscape, 2)
    assert e and e["sw_dn_ds"] == 0.2


def test_ui_link_includes_gene():
    assert "TP53" in metadome_ui_url("TP53")


class _FakeResp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeSession:
    def get(self, url, timeout=20):
        if "/get_transcripts/" in url:
            return _FakeResp(
                200,
                {
                    "trancript_ids": [
                        {
                            "gencode_id": "ENST00000269305.4",
                            "aa_length": 393,
                            "has_protein_data": True,
                            "refseq_nm_numbers": "NM_000546.5",
                        }
                    ]
                },
            )
        if "/status/" in url:
            return _FakeResp(200, {"status": "SUCCESS"})
        if "/result/" in url:
            return _FakeResp(
                200,
                {
                    "positional_annotation": [
                        {
                            "protein_pos": 175,
                            "sw_dn_ds": 0.44,
                            "ref_aa": "R",
                            "domains": {
                                "PF00870": {
                                    "consensus_pos": [81],
                                    "pathogenic_missense_variant_count": 2,
                                    "normal_missense_variant_count": 1,
                                }
                            },
                            "ClinVar": [{"clinvar_ID": "12374"}],
                        }
                    ]
                    + [{"protein_pos": i, "sw_dn_ds": 1.0} for i in range(1, 175)]
                },
            )
        return _FakeResp(404, {})

    def post(self, url, json=None, timeout=20):
        return _FakeResp(200, {"transcript_id": (json or {}).get("transcript_id")})


def test_apply_metadome_ready_for_missense():
    # Landscape list in fake result is wrong order — rebuild correctly
    class Sess(_FakeSession):
        def get(self, url, timeout=20):
            if "/result/" in url:
                positions = []
                for i in range(1, 394):
                    entry = {"protein_pos": i, "sw_dn_ds": 1.0, "domains": {}, "ClinVar": []}
                    if i == 175:
                        entry = {
                            "protein_pos": 175,
                            "sw_dn_ds": 0.44,
                            "ref_aa": "R",
                            "domains": {
                                "PF00870": {
                                    "consensus_pos": [81],
                                    "pathogenic_missense_variant_count": 2,
                                    "normal_missense_variant_count": 1,
                                }
                            },
                            "ClinVar": [{"clinvar_ID": "12374"}],
                        }
                    positions.append(entry)
                return _FakeResp(200, {"positional_annotation": positions})
            return super().get(url, timeout=timeout)

    pd = {
        "consequence": "missense_variant",
        "protein_start": 175,
        "hgvs_p": "p.Arg175His",
        "transcript": "NM_000546.5",
    }
    out = apply_metadome_missense_lookup(Sess(), pd, "TP53")
    assert out.get("status") == "ready"
    assert pd["metadome_status"] == "ready"
    assert pd["metadome_intolerant"] is True
    assert "intolerant" in pd["metadome_tolerance_label"]
    assert "PF00870" in pd["metadome_summary"]


def test_apply_metadome_skips_noncoding():
    pd = {"noncoding_track": True, "consequence": "non_coding_transcript_exon_variant"}
    apply_metadome_missense_lookup(_FakeSession(), pd, "RNU4-2")
    assert pd["metadome_status"] == "skipped"
