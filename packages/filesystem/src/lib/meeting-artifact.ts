/**
 * An Artifact is a markdown document the assistant authors during meeting chat
 * (a summary, an action list, ...). Unlike a Derivation it is authored on
 * request, not derived from the recording, so prior versions are kept on disk.
 */
export interface MeetingArtifactSummary {
  /** Stable identifier without extension, e.g. "summary". */
  name: string;
  fileName: string;
  size: number;
  updatedAt: number;
  /** Number of prior versions retained in history (excludes the current one). */
  versionCount: number;
}

export interface MeetingArtifact extends MeetingArtifactSummary {
  content: string;
}

export interface MeetingArtifactVersion {
  /** Timestamp the version was superseded, encoded in its history filename. */
  supersededAt: number;
  fileName: string;
  size: number;
}
