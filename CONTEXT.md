# Notetaker

A local-first meeting notetaker that records audio and derives Derivations from it (transcript, diarization, word sync) using on-device ML models.

## Language

**Derivation**:
An output the processing pipeline derives deterministically from the recording: transcript, diarization, word sync, speaker names. Re-running the pipeline on the same recording reproduces it.
_Avoid_: Artifact (legacy code name, now reserved for chat-authored documents), processing result

**Memory Budget**:
The app-wide byte limit on everything resident in memory at once: model weights, inference caches, and buffers. Derived from the device, user-adjustable. Token caps and similar guards are subordinate tools that exist only to protect it. When it can't stretch, recording always wins: the pipeline is never evicted to make room for chat.
_Avoid_: Token budget (that's a subordinate guard, not the root limit)

**Artifact**:
A markdown document saved to the meeting's artifact folder during chat (e.g. a summary, an action list). Authored on request, not derived from the recording; deleting it loses work. Written either by the main chat (via the write_artifact tool) or as the delivered output of a [[Delegate]] or [[Scan]] (named `research-…`/`scan-…`), which the main chat reads back on demand.
_Avoid_: Note, generated file, document

**Thread**:
One conversation with the assistant about one meeting; a meeting can have several. A Thread is resident in memory only while it is open or still generating — otherwise it exists only in storage. Its record includes the [[Delegate]] logs it spawned.
_Avoid_: Chat (the feature as a whole), session

**Delegate**:
A bounded, disposable researcher the chat spawns for a single, targeted research task. It forages the transcript with read-only tools in its own transient context. Its output is delivered as an [[Artifact]] (`research-…`); only a pointer plus a short preview enters the chat, which reads the full artifact on demand. Its working log is persisted so its memory can be reclaimed. A Delegate cannot call the write_artifact tool itself, spawn further Delegates, or start a [[Scan]].
_Avoid_: Sub-agent, agent

**Scan**:
A subagent the chat runs to cover the WHOLE transcript for exhaustive tasks (full summaries, "list every decision"). It sweeps consecutive bounded windows — read a window, write one note, move on — so the transcript is never resident all at once, then reduces the notes into one answer. Windows grow (never multiply past a cap) so a long meeting is still covered fully. Its output — the answer plus the per-window notes — is delivered as an [[Artifact]] (`scan-…`); only a pointer plus a preview enters the chat. Contrast with a [[Delegate]], which forages by search for targeted questions.
_Avoid_: Map-reduce, rolling summary

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
