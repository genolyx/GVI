from vc_engine.hgvs import format_genomic_hgvs, rsid_from_vep_hit


def test_format_genomic_hgvs_snv():
    assert format_genomic_hgvs("chr17", 7675088, 7675088, "C", "T") == "chr17:g.7675088C>T"
    assert format_genomic_hgvs("17", 7675088, 7675088, "c", "t") == "chr17:g.7675088C>T"


def test_format_genomic_hgvs_requires_alleles():
    assert format_genomic_hgvs("chr17", 7675088, 7675088, "", "T") == ""


def test_rsid_from_vep_hit_prefers_colocated_rs_at_the_same_start():
    hit = {
        "id": "17_7675088_C/T",
        "start": 7675088,
        "colocated_variants": [
            {"id": "CM062017", "start": 7675088},
            {"id": "rs28934578", "start": 7675088, "allele_string": "C/A/G/T"},
        ],
    }
    assert rsid_from_vep_hit(hit) == "rs28934578"
