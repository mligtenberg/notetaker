import type { ManagedModel } from '@notetaker/model-manager';
import type { AppPage } from './app.types';

interface SettingsModelPage {
  model: ManagedModel;
  path: string;
}

export const PAGE_PATHS: Record<AppPage, string> = {
  meetings: '/meetings',
  settings: '/settings/models',
};

export const SETTINGS_MODEL_PAGES: SettingsModelPage[] = [
  { model: 'transcription', path: 'transcription' },
  { model: 'diarization', path: 'diarization' },
  { model: 'language', path: 'language' },
  { model: 'text-audio-sync', path: 'text-audio-sync' },
];

export function resolveActivePage(pathname: string): AppPage {
  const segment = pathname.split('/')[1] ?? '';

  if (segment === 'meetings') {
    return segment;
  }

  if (segment === 'settings') {
    return 'settings';
  }

  return 'meetings';
}

export function resolveViewingMeetingId(pathname: string): string | null {
  const parts = pathname.split('/');
  if (
    parts[1] === 'meetings' &&
    parts[2] !== undefined &&
    parts[2].length > 0
  ) {
    return parts[2];
  }
  return null;
}

export function resolveSettingsModel(pathname: string): ManagedModel | null {
  const parts = pathname.split('/');
  if (parts[1] !== 'settings' || parts[2] !== 'models') {
    return null;
  }

  const modelPath = parts[3] ?? '';
  const match = SETTINGS_MODEL_PAGES.find((page) => page.path === modelPath);
  return match?.model ?? null;
}

export type MeetingTab =
  | 'details'
  | 'recording'
  | 'transcript'
  | 'diarization'
  | 'word-sync'
  | 'speaker-names';

export const MEETING_TABS: MeetingTab[] = [
  'details',
  'recording',
  'transcript',
  'diarization',
  'word-sync',
  'speaker-names',
];

export function resolveMeetingTab(pathname: string): MeetingTab {
  const parts = pathname.split('/');
  const tab = parts[3];
  if (tab !== undefined && MEETING_TABS.includes(tab as MeetingTab)) {
    return tab as MeetingTab;
  }
  return 'details';
}

export function getMeetingTabPath(meetingId: string, tab: MeetingTab): string {
  return `/meetings/${meetingId}/${tab}`;
}

export function getModelPagePath(model: string): string {
  return `/settings/models/${model}`;
}
