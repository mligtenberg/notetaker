import { useCallback, useEffect, useState, type RefObject } from 'react';
import type {
  MeetingArtifactSummary,
  MeetingArtifactVersion,
  MeetingsRepository,
} from '@notetaker/filesystem';
import { Markdown } from '../../common/markdown';
import styles from '../../../app.module.css';

interface ArtifactsTabProps {
  meetingsRepoRef: RefObject<MeetingsRepository | null>;
  meetingId: string;
  formatDate: (timestamp: number) => string;
}

/** Label the origin of an artifact from its name prefix. */
function originOf(name: string): string {
  if (name.startsWith('research-')) return 'research';
  if (name.startsWith('scan-')) return 'scan';
  return 'chat';
}

function downloadMarkdown(name: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ArtifactsTab({
  meetingsRepoRef,
  meetingId,
  formatDate,
}: ArtifactsTabProps) {
  const [summaries, setSummaries] = useState<MeetingArtifactSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [versions, setVersions] = useState<MeetingArtifactVersion[]>([]);
  const [viewingVersion, setViewingVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (): Promise<void> => {
    const repo = meetingsRepoRef.current;
    if (repo === null) {
      return;
    }
    setError(null);
    try {
      setSummaries(await repo.listArtifacts(meetingId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [meetingsRepoRef, meetingId]);

  useEffect(() => {
    setSelected(null);
    setContent(null);
    setVersions([]);
    setViewingVersion(null);
    void loadList();
  }, [loadList]);

  const openArtifact = useCallback(
    async (name: string): Promise<void> => {
      const repo = meetingsRepoRef.current;
      if (repo === null) {
        return;
      }
      setSelected(name);
      setViewingVersion(null);
      setLoading(true);
      setError(null);
      try {
        const [artifact, versionList] = await Promise.all([
          repo.readArtifact(meetingId, name),
          repo.listArtifactVersions(meetingId, name),
        ]);
        setContent(artifact?.content ?? null);
        setVersions(versionList);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    },
    [meetingsRepoRef, meetingId],
  );

  async function viewVersion(versionFileName: string): Promise<void> {
    const repo = meetingsRepoRef.current;
    if (repo === null || selected === null) {
      return;
    }
    setLoading(true);
    try {
      if (versionFileName === 'current') {
        setViewingVersion(null);
        setContent((await repo.readArtifact(meetingId, selected))?.content ?? null);
      } else {
        setViewingVersion(versionFileName);
        setContent(await repo.readArtifactVersion(meetingId, versionFileName));
      }
    } finally {
      setLoading(false);
    }
  }

  async function deleteArtifact(name: string): Promise<void> {
    const repo = meetingsRepoRef.current;
    if (repo === null) {
      return;
    }
    await repo.deleteArtifact(meetingId, name);
    if (selected === name) {
      setSelected(null);
      setContent(null);
      setVersions([]);
    }
    await loadList();
  }

  return (
    <div className={styles.artifactBrowser}>
      <aside className={styles.artifactList}>
        <div className={styles.artifactListHeader}>
          <h3>Artifacts</h3>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => void loadList()}
          >
            Refresh
          </button>
        </div>
        {summaries.length === 0 ? (
          <p className={styles.empty}>
            No artifacts yet. Ask the chat to write a summary or action list.
          </p>
        ) : (
          <ul>
            {summaries.map((artifact) => (
              <li key={artifact.name}>
                <button
                  type="button"
                  data-active={artifact.name === selected}
                  className={styles.artifactListItem}
                  onClick={() => void openArtifact(artifact.name)}
                >
                  <span className={styles.artifactName}>
                    {artifact.name}
                    <em className={styles.artifactOrigin}>
                      {originOf(artifact.name)}
                    </em>
                  </span>
                  <small>
                    {formatDate(artifact.updatedAt)}
                    {artifact.versionCount > 0
                      ? ` · ${artifact.versionCount} older`
                      : ''}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className={styles.artifactReader}>
        {error !== null ? <p className={styles.chatError}>{error}</p> : null}

        {selected === null ? (
          <p className={styles.empty}>Select an artifact to read it.</p>
        ) : (
          <>
            <div className={styles.artifactReaderHeader}>
              <h3>{selected}</h3>
              <div className={styles.artifactReaderActions}>
                {versions.length > 0 ? (
                  <select
                    value={viewingVersion ?? 'current'}
                    onChange={(event) => void viewVersion(event.target.value)}
                    aria-label="Version"
                  >
                    <option value="current">Current</option>
                    {versions.map((version) => (
                      <option key={version.fileName} value={version.fileName}>
                        {formatDate(version.supersededAt)} (older)
                      </option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={content === null}
                  onClick={() =>
                    content !== null && downloadMarkdown(selected, content)
                  }
                >
                  Download
                </button>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => void deleteArtifact(selected)}
                >
                  Delete
                </button>
              </div>
            </div>
            {viewingVersion !== null ? (
              <p className={styles.artifactVersionNote}>
                Viewing an older version (read-only).
              </p>
            ) : null}
            {loading ? (
              <p className={styles.empty}>Loading…</p>
            ) : content !== null && content.trim().length > 0 ? (
              <Markdown content={content} className={styles.artifactContent} />
            ) : (
              <p className={styles.empty}>(empty)</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
