import { useEffect, useState } from 'react';
import type { SpeakerTurn } from '@notetaker/engine';
import type { MeetingDerivationKind } from '@notetaker/filesystem';
import styles from '../../../app.module.css';
import { Card } from '../../common/card';
import { ExportControls } from '../export-controls';
import { collectSpeakers } from './shared';

interface SpeakerNamesTabProps {
  meetingId: string;
  meetingName: string;
  present: boolean;
  revision: number;
  loadDerivation: <U>(
    meetingId: string,
    kind: MeetingDerivationKind,
  ) => Promise<U | null>;
  saveDerivation: <U>(
    meetingId: string,
    kind: MeetingDerivationKind,
    data: U,
  ) => Promise<void>;
  onSaved: () => void;
}

export function SpeakerNamesTab({
  meetingId,
  meetingName,
  present,
  revision,
  loadDerivation,
  saveDerivation,
  onSaved,
}: SpeakerNamesTabProps) {
  const [names, setNames] = useState<Record<string, string> | null>(null);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!present) {
      setNames(null);
      setSpeakers([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    Promise.all([
      loadDerivation<SpeakerTurn[]>(meetingId, 'diarization'),
      loadDerivation<Record<string, string>>(meetingId, 'speaker-names'),
    ])
      .then(([diarization, savedNames]) => {
        if (cancelled) {
          return;
        }

        if (diarization === null) {
          throw new Error('Diarization artifact missing.');
        }

        const nextSpeakers = collectSpeakers(diarization);
        const nextNames = Object.fromEntries(
          nextSpeakers.map((speaker) => [
            speaker,
            savedNames?.[speaker] ?? speaker,
          ]),
        );

        setSpeakers(nextSpeakers);
        setNames(nextNames);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [meetingId, present, revision, loadDerivation]);

  async function saveNames(nextNames: Record<string, string>): Promise<void> {
    setNames(nextNames);
    await saveDerivation(meetingId, 'speaker-names', nextNames);
    onSaved();
  }

  if (!present) {
    return <p className={styles.empty}>Generate diarization first.</p>;
  }

  if (loading) {
    return <p className={styles.empty}>Loading...</p>;
  }

  if (error !== null) {
    return <p className={styles.empty}>Failed to load: {error}</p>;
  }

  if (names === null) {
    return <p className={styles.empty}>No speaker names.</p>;
  }

  return (
    <div className={styles.transcriptResult}>
      <div className={styles.resultHeader}>
        <h3>
          Speaker names - {speakers.length} speaker
          {speakers.length === 1 ? '' : 's'}
        </h3>
        <ExportControls
          json={names}
          jsonFileName={`${meetingName}-speaker-names.json`}
        />
      </div>
      <ul className={styles.fileList}>
        {speakers.map((speaker) => (
          <Card
            as="li"
            key={speaker}
            className={styles.speakerNameRow}
            compact
          >
            <label>
              <span>{speaker}</span>
              <input
                type="text"
                value={names[speaker] ?? speaker}
                onChange={(event) =>
                  setNames({ ...names, [speaker]: event.target.value })
                }
                onBlur={(event) => {
                  const trimmed = event.target.value.trim();
                  void saveNames({
                    ...names,
                    [speaker]: trimmed.length > 0 ? trimmed : speaker,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
          </Card>
        ))}
      </ul>
    </div>
  );
}
