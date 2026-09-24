from vc_engine.myvariant import revel_score_from_dbnsfp


def test_revel_list_of_transcript_scores_is_read():
    revel = {"rankscore": 0.80664, "score": [0.538, 0.538, 0.538]}
    assert revel_score_from_dbnsfp(revel) == 0.538


def test_revel_keeps_the_highest_score_when_transcripts_disagree():
    assert revel_score_from_dbnsfp({"score": ["0.21", "0.88"]}) == 0.88


def test_revel_single_number_and_missing_stay_distinct():
    assert revel_score_from_dbnsfp(0.71) == 0.71
    assert revel_score_from_dbnsfp(None) is None
    assert revel_score_from_dbnsfp({"score": []}) is None
    assert revel_score_from_dbnsfp({"score": 0}) is None
