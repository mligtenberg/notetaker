import type { MeetingTab } from '../../app-routing';
import type { StoredMeetingSummary } from '@notetaker/filesystem';
import { getMeetingTabPath } from '../../app-routing';
import { Tabs, type TabItem } from '../common/tabs';
import { TrafficLightStatus } from '../common/traffic-light-status';

interface MeetingTabsProps {
  meetingId: string;
  activeTab: MeetingTab;
  meeting: StoredMeetingSummary;
  speakerNamesSaved: boolean;
  onTabChange?: () => void;
}

const TAB_LABELS: Record<MeetingTab, string> = {
  details: 'Details',
  recording: 'Recording',
  transcript: 'Transcript',
  diarization: 'Diarization',
  'word-sync': 'Word sync',
  'speaker-names': 'Speaker names',
  chat: 'Chat',
  artifacts: 'Artifacts',
};

const TABS: MeetingTab[] = [
  'details',
  'recording',
  'transcript',
  'diarization',
  'word-sync',
  'speaker-names',
  'chat',
  'artifacts',
];

function getTabStatus(
  tab: MeetingTab,
  meeting: StoredMeetingSummary,
  speakerNamesSaved: boolean,
): 'completed' | 'pending' {
  if (tab === 'details' || tab === 'chat' || tab === 'artifacts') {
    return 'completed';
  }
  if (tab === 'recording') {
    return meeting.recordingFileName !== null ? 'completed' : 'pending';
  }
  if (tab === 'speaker-names') {
    return speakerNamesSaved ? 'completed' : 'pending';
  }
  return meeting.derivations[tab] ? 'completed' : 'pending';
}

export function MeetingTabs({
  meetingId,
  activeTab,
  meeting,
  speakerNamesSaved,
  onTabChange,
}: MeetingTabsProps) {
  const items: TabItem[] = TABS.map((tab) => ({
    label: TAB_LABELS[tab],
    path: getMeetingTabPath(meetingId, tab),
    prefix: <TrafficLightStatus status={getTabStatus(tab, meeting, speakerNamesSaved)} />,
  }));

  return (
    <Tabs
      items={items}
      activePath={getMeetingTabPath(meetingId, activeTab)}
      onTabChange={onTabChange}
    />
  );
}
