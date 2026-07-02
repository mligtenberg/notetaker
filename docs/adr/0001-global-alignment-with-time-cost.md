# Word sync uses banded global alignment with a soft time cost

Word sync matches transcript words to CTC-decoded words from the audio. The original greedy forward matcher (scan ahead 20 CTC words, take the first edit-distance hit) planted false anchors on repeated short words ("de", "en", "dat"), which dragged whole regions to the wrong time and collapsed runs of words onto a single timestamp. We replaced it with a banded Needleman-Wunsch global alignment over both word sequences: substitution cost is character edit distance, 1:many merge moves handle compounds ("stresshormoon" ↔ "stress" + "hormoon"), and the band is centered on the time diagonal predicted by Whisper's segment hints. A soft time cost (~2 seconds of deviation ≈ 1 character edit) breaks ties between textually identical candidates, so recurring phrases align to the occurrence nearest where Whisper heard them.

CTC timing always wins over Whisper segment hints: aligned words become anchors, unanchored words are interpolated between the nearest surrounding anchors, and segment hints are only used as a fallback when an anchor side is missing entirely. Interpolation additionally respects dead zones — stretches of ~2s or more without any surviving CTC word (silence, music) are positive evidence of non-speech, so unanchored runs squeeze into the speech-active parts of their window instead of spreading across the whole gap.

## Considered Options

- **Greedy matcher + hard time corridor** (reject matches falling outside segment hint ± 5s): cheaper, but keeps trusting a matcher that cannot recover once it commits to a wrong anchor, and a hard veto lets sloppy hints block genuinely correct matches.
- **Pure text global alignment without time cost**: cannot disambiguate repeated phrases; a meeting with forty occurrences of "ja precies" can still lock a region onto the wrong repetition.

## Consequences

- Alignment is O(N × band width) instead of O(N × 20); the band keeps a 1-hour meeting tractable.
- Whisper segment hints are advisory everywhere: they shape the band and the tie-breaking cost but never override CTC evidence.
