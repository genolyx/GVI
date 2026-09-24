"""Local gnomAD file selection. These tests never open the sites VCFs."""
from vc_engine.gnomad_local import (
    af_for_alt,
    apply_local_gnomad,
    homozygote_count,
    homozygote_total,
    pick_file_for_chrom,
    release_from_names,
)


def test_chr1_does_not_match_chr10():
    files = [
        "/data/gnomad.genomes.v3.1.2.sites.chr1.vcf.bgz",
        "/data/gnomad.genomes.v3.1.2.sites.chr10.vcf.bgz",
        "/data/gnomad.genomes.v3.1.2.sites.chrX.vcf.bgz",
    ]
    assert pick_file_for_chrom(files, "1").endswith("chr1.vcf.bgz")
    assert pick_file_for_chrom(files, "chr10").endswith("chr10.vcf.bgz")
    assert pick_file_for_chrom(files, "chrX").endswith("chrX.vcf.bgz")
    assert pick_file_for_chrom(files, "22") is None


def test_single_file_covers_every_chromosome():
    files = ["/data/gnomad.genomes.v4.1.sites.vcf.bgz"]
    assert pick_file_for_chrom(files, "chr2") == files[0]


def test_release_from_filename():
    assert release_from_names(["gnomad.genomes.v3.1.2.sites.chr22.vcf.bgz"]) == "v3.1.2"
    assert release_from_names(["notes.txt"]) is None


def test_af_uses_the_matching_alt():
    assert af_for_alt((0.01, 0.2), ["A", "T"], "T") == 0.2
    assert af_for_alt((0.01,), ["A"], "C") is None
    assert af_for_alt(0.05, ["G"], "G") == 0.05


def test_apply_uses_genomes_when_exomes_are_absent(monkeypatch):
    monkeypatch.setenv("VC_GNOMAD_DIR", "/data/reference/annotation/gnomad")
    parsed = {"grch38_chrom": "chr22", "grch38_start": 100, "ref": "A", "alt": "G", "gnomad_af": 0.9}

    def lookup(chrom, pos, ref, alt):
        assert (chrom, pos, ref, alt) == ("chr22", 100, "A", "G")
        return {"queried": True, "exomes": None, "genomes": 0.001}

    assert apply_local_gnomad(parsed, lookup=lookup) is True
    assert parsed["gnomad_af"] == 0.001
    assert parsed["gnomad_af_source"] == "genomes-file"
    assert parsed["gnomad_checked"] is True


def test_apply_prefers_a_nonzero_exome_frequency(monkeypatch):
    monkeypatch.setenv("VC_GNOMAD_DIR", "/data/reference/annotation/gnomad")
    parsed = {"grch38_chrom": "chr22", "grch38_start": 100, "ref": "A", "alt": "G"}
    apply_local_gnomad(
        parsed,
        lookup=lambda *_args: {"queried": True, "exomes": 0.2, "genomes": 0.001},
    )
    assert parsed["gnomad_af"] == 0.2
    assert parsed["gnomad_af_source"] == "exomes-file"


def test_absence_in_the_sites_file_is_zero(monkeypatch):
    monkeypatch.setenv("VC_GNOMAD_DIR", "/data/reference/annotation/gnomad")
    parsed = {"grch38_chrom": "chr22", "grch38_start": 100, "ref": "A", "alt": "G"}
    apply_local_gnomad(parsed, lookup=lambda *_args: {"queried": True, "exomes": None, "genomes": None})
    assert parsed["gnomad_af"] == 0
    assert parsed["gnomad_af_source"] == "absent"
    assert parsed["gnomad_checked"] is True


def test_myvariant_mode_leaves_the_local_file_unread(tmp_path, monkeypatch):
    monkeypatch.setenv("VC_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("VC_GNOMAD_DIR", "/data/reference/annotation/gnomad")
    (tmp_path / "gnomad-source").write_text("myvariant\n")
    parsed = {"grch38_chrom": "chr22", "grch38_start": 100, "ref": "A", "alt": "G"}
    calls = {"n": 0}

    def lookup(*_args):
        calls["n"] += 1
        return {"queried": True, "exomes": None, "genomes": 0.2}

    assert apply_local_gnomad(parsed, lookup=lookup) is False
    assert calls["n"] == 0
    assert "gnomad_af" not in parsed


def test_homozygote_count_reads_the_myvariant_total():
    assert homozygote_count({"hom": {"hom": 3, "hom_nfe": 1}}) == 3
    assert homozygote_total(3, None, 1) == 3
    assert homozygote_total(None, None) is None


def test_apply_keeps_the_higher_homozygote_count(monkeypatch):
    monkeypatch.setenv("VC_GNOMAD_DIR", "/data/reference/annotation/gnomad")
    parsed = {"grch38_chrom": "chr22", "grch38_start": 100, "ref": "A", "alt": "G"}
    apply_local_gnomad(
        parsed,
        lookup=lambda *_args: {
            "queried": True,
            "exomes": 0.01,
            "genomes": 0.002,
            "exomes_nhomalt": 1,
            "genomes_nhomalt": 4,
        },
    )
    assert parsed["gnomad_nhomalt"] == 4


def test_missing_coordinates_do_not_count_as_absent(monkeypatch):
    monkeypatch.setenv("VC_GNOMAD_DIR", "/data/reference/annotation/gnomad")
    parsed = {}
    assert apply_local_gnomad(parsed) is True
    assert "gnomad_af" not in parsed
    assert parsed["gnomad_af_source"] == "local_unmapped"
    assert parsed.get("gnomad_checked") is not True
