import type { StoredMeetingSummary } from '@notetaker/filesystem';
import styles from '../../app.module.css';
import { Page } from '../common/page';

interface MeetingsPageProps {
  meetings: StoredMeetingSummary[];
  message: string;
  isCreating: boolean;
  onCreateMeeting: () => void;
  onOpenMeeting: (meeting: StoredMeetingSummary) => void;
  formatDate: (timestamp: number) => string;
}

const ARTIFACT_LABELS: Record<keyof StoredMeetingSummary['artifacts'], string> =
  {
    transcript: 'Transcript',
    diarization: 'Diarization',
    'word-sync': 'Word sync',
    'speaker-names': 'Speaker names',
  };

export function MeetingsPage({
  meetings,
  message,
  isCreating,
  onCreateMeeting,
  onOpenMeeting,
  formatDate,
}: MeetingsPageProps) {
  return (
    <Page
      title="Meetings"
      subtitle="Create meetings, capture recordings, and keep notes organized in OPFS."
      toolbar={
        <div className={styles.panelToolbar}>
          <button type="button" onClick={onCreateMeeting} disabled={isCreating}>
            {isCreating ? 'Creating...' : '+ New meeting'}
          </button>
        </div>
      }
    >
      {message.length > 0 ? <p className={styles.message}>{message}</p> : null}

      {meetings.length === 0 ? (
        <p className={styles.empty}>
          No meetings yet. Click "New meeting" to create one.
        </p>
      ) : (
        <ul className={styles.meetingGrid}>
          {meetings.map((meeting) => (
            <li key={meeting.id}>
              <button
                type="button"
                className={styles.meetingCard}
                onClick={() => onOpenMeeting(meeting)}
              >
                <header>
                  <strong>{meeting.name}</strong>
                  <span>{meeting.date}</span>
                </header>
                <dl>
                  <div>
                    <dt>Participants</dt>
                    <dd>{meeting.participantCount}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatDate(meeting.createdAt)}</dd>
                  </div>
                </dl>
                <ul className={styles.meetingPills}>
                  <li
                    data-status={
                      meeting.recordingFileName !== null
                        ? 'completed'
                        : 'pending'
                    }
                  >
                    Recording
                  </li>
                  {(
                    Object.entries(ARTIFACT_LABELS) as [
                      keyof StoredMeetingSummary['artifacts'],
                      string,
                    ][]
                  ).map(([kind, label]) => (
                    <li
                      key={kind}
                      data-status={
                        meeting.artifacts[kind] ? 'completed' : 'pending'
                      }
                    >
                      {label}
                    </li>
                  ))}
                </ul>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
