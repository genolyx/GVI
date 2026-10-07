"""Forward-strand left alignment for ClinVar indel lookup."""

import os

from vc_engine.allele_norm import align_forward_indel, align_query_allele, reference_fasta_path

# chr17:43124020-43124040, the BRCA1 c.68_69del neighborhood.
_ORIGIN = 43124020
_SEQUENCE = "ATGGGACACTCTAAGATTTTC"


def _base_at(site: int):
    index = site - _ORIGIN
    if index < 0 or index >= len(_SEQUENCE):
        return None
    return _SEQUENCE[index]


def test_coding_strand_brca1_deletion_aligns_to_clinvar():
    assert align_forward_indel(43124028, "AG", "-", _base_at) == (43124027, "ACT", "A")


def test_forward_dash_deletion_aligns_to_the_same_allele():
    assert align_forward_indel(43124028, "CT", "-", _base_at) == (43124027, "ACT", "A")


def test_already_left_aligned_allele_stays_put():
    assert align_forward_indel(43124027, "ACT", "A", _base_at) == (43124027, "ACT", "A")


def test_right_shifted_repeat_moves_left_to_the_clinvar_allele():
    assert align_forward_indel(43124029, "TCT", "T", _base_at) == (43124027, "ACT", "A")


def test_one_base_deletion_does_not_become_the_two_base_allele():
    assert align_forward_indel(43124028, "C", "-", _base_at) == (43124027, "AC", "A")


def test_snv_is_not_rewritten():
    assert align_forward_indel(43124027, "A", "G", _base_at) is None


def test_unproven_reference_is_not_rewritten():
    assert align_forward_indel(43124028, "GG", "-", _base_at) is None


def test_local_fasta_places_brca1_on_the_clinvar_allele():
    if not os.path.exists(reference_fasta_path()):
        return
    assert align_query_allele("17", 43124028, "AG", "-") == (43124027, "ACT", "A")
    assert align_query_allele("chr17", 43124027, "ACT", "A") == (43124027, "ACT", "A")
