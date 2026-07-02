import { useEffect, useState } from 'react';
import type { StoredMeetingSummary } from '@notetaker/filesystem';
import styles from '../../../app.module.css';
import type { RecorderStatus } from './types';

interface DetailsTabProps {
  meeting: StoredMeetingSummary;
  status: RecorderStatus;
  isRecording: boolean;
  onUpdateMeeting: (
    id: string,
    patch: Partial<{ name: string; date: string; participantCount: number }>,
  ) => void;
  onDeleteMeeting: () => void;
  formatDate: (timestamp: number) => string;
}

export function DetailsTab({
  meeting,
  status,
  isRecording,
  onUpdateMeeting,
  onDeleteMeeting,
  formatDate,
}: DetailsTabProps) {
  const [name, setName] = useState(meeting.name);
  const [date, setDate] = useState(meeting.date);
  const [participantCount, setParticipantCount] = useState(
    meeting.participantCount,
  );

  useEffect(() => {
    setName(meeting.name);
    setDate(meeting.date);
    setParticipantCount(meeting.participantCount);
  }, [meeting.id, meeting.name, meeting.date, meeting.participantCount]);

  const editingDisabled = isRecording || status === 'saving';

  function commitName(): void {
    const trimmed = name.trim();
    if (trimmed.length > 0 && trimmed !== meeting.name) {
      onUpdateMeeting(meeting.id, { name: trimmed });
    } else {
      setName(meeting.name);
    }
  }

  function commitDate(): void {
    if (date.length > 0 && date !== meeting.date) {
      onUpdateMeeting(meeting.id, { date });
    } else {
      setDate(meeting.date);
    }
  }

  function commitParticipants(): void {
    const safe = Math.max(1, participantCount);
    if (safe !== meeting.participantCount) {
      onUpdateMeeting(meeting.id, { participantCount: safe });
    } else {
      setParticipantCount(meeting.participantCount);
    }
  }

  return (
    <>
      <div className={styles.engineModelGrid}>
        <label className={styles.engineModelPicker}>
          <span>Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            disabled={editingDisabled}
          />
        </label>
        <label className={styles.engineModelPicker}>
          <span>Date</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            onBlur={commitDate}
            disabled={editingDisabled}
          />
        </label>
        <label className={styles.engineModelPicker}>
          <span>Participants</span>
          <input
            type="number"
            min={1}
            max={50}
            value={participantCount}
            onChange={(event) =>
              setParticipantCount(
                Math.max(1, Number.parseInt(event.target.value, 10) || 1),
              )
            }
            onBlur={commitParticipants}
            disabled={editingDisabled}
          />
        </label>
      </div>

      <p className={styles.message}>Created {formatDate(meeting.createdAt)}</p>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={onDeleteMeeting}
          disabled={isRecording || status === 'saving'}
        >
          Delete meeting
        </button>
      </div>
    </>
  );
}
