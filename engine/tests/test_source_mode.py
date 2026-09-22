"""Settings source choices. These tests do not open the ClinVar VCF."""
from vc_engine.clinvar import _fetch_clinvar_esummary_map
from vc_engine.source_mode import clinvar_file_active, clinvar_mode, clinvar_remote_active


def test_clinvar_defaults_to_the_local_file_when_it_is_installed(monkeypatch, tmp_path):
    vcf = tmp_path / "reference" / "clinvar" / "clinvar.vcf.gz"
    vcf.parent.mkdir(parents=True)
    vcf.write_bytes(b"vcf")
    monkeypatch.setenv("VC_DATA_ROOT", str(tmp_path))
    monkeypatch.delenv("VC_CLINVAR_PATH", raising=False)
    assert clinvar_mode() == "local"
    assert clinvar_file_active() is True
    assert clinvar_remote_active() is False


def test_ncbi_choice_leaves_the_local_file_unused(monkeypatch, tmp_path):
    monkeypatch.setenv("VC_DATA_ROOT", str(tmp_path))
    (tmp_path / "clinvar-source").write_text("ncbi\n")
    assert clinvar_mode() == "ncbi"
    assert clinvar_file_active() is False
    assert clinvar_remote_active() is True


def test_local_choice_skips_the_clinvar_api(monkeypatch, tmp_path):
    monkeypatch.setenv("VC_DATA_ROOT", str(tmp_path))
    (tmp_path / "clinvar-source").write_text("local\n")

    class Session:
        def get(self, *_args, **_kwargs):
            raise AssertionError("NCBI should not be called")

    assert _fetch_clinvar_esummary_map(Session(), ["1"]) == {}
