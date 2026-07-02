# Notetaker

A local-first meeting notetaker that records audio and derives artifacts from it (transcript, diarization, word sync) using on-device ML models.

## Language

**Active Word**:
The word whose own time span (`timestampInMs` to `endTimeInMs`) contains the playhead during recording playback. At most one word is active at a time; during gaps (silence, music) no word is active.
_Avoid_: Current word, highlighted word

**Word Sync**:
The artifact giving every transcript word a start and end time in the recording, produced by aligning the transcript against the audio.
_Avoid_: Alignment (reserved for the process), word timestamps

**Anchor**:
A transcript word whose timing is confirmed by CTC evidence from the audio. Words without an anchor are interpolated between the nearest surrounding anchors.
_Avoid_: Match, matched word

**Dead Zone**:
A stretch of the recording with no speech evidence (silence, music). No word is ever placed inside a dead zone.
_Avoid_: Gap, pause
