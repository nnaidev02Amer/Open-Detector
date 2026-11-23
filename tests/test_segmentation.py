from detector.segmentation import Span, split_paragraphs, split_sentences, word_count


def test_paragraph_offsets_roundtrip():
    text = "First para here.\n\nSecond para\nwraps lines.\n\n\nThird."
    pars = split_paragraphs(text)
    assert len(pars) == 3
    for p in pars:
        assert text[p.start:p.end] == p.text


def test_sentence_split_and_offsets():
    text = "This is one. This is two! Is this three? Yes it is."
    sents = split_sentences(Span(0, len(text), text))
    assert [s.text for s in sents] == ["This is one.", "This is two!", "Is this three?", "Yes it is."]
    for s in sents:
        assert text[s.start:s.end] == s.text


def test_abbreviations_not_split():
    text = "Smith et al. showed this result, e.g. in Fig. 3. The next sentence follows. J. Doe agrees."
    sents = split_sentences(Span(0, len(text), text))
    assert len(sents) == 3, [s.text for s in sents]


def test_offsets_with_document_offset():
    doc = "Intro line.\n\nAlpha beta. Gamma delta."
    par = split_paragraphs(doc)[1]
    for s in split_sentences(par):
        assert doc[s.start:s.end] == s.text


def test_word_count():
    assert word_count("It's a well-known fact.") == 4
    assert word_count("") == 0
