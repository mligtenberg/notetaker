import { useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import styles from './app.module.css';
import {
  PAGE_PATHS,
  resolveActivePage,
  resolveSettingsModel,
  resolveViewingMeetingId,
  resolveMeetingTab,
} from './app-routing';
import { Page } from './components/common/page';
import { DownloadProgressDialog } from './components/dialogs/download-progress-dialog';
import { EngineLogDialog } from './components/dialogs/engine-log-dialog';
import { MeetingDetailPage } from './components/pages/meeting-detail-page';
import { MeetingsPage } from './components/pages/meetings-page';
import { ModelsPage } from './components/pages/models-page';
import {
  MODEL_DOWNLOAD_SECTIONS,
  MODEL_DOWNLOAD_TARGETS,
  getDirectDownloadKey,
  getKnownDownloadSize,
  getModelVersionTitle,
} from './services/model-downloads';
import { formatBytes, formatDate, formatTimestamp } from './utils/formatters';
import { useEngineRunner } from './hooks/use-engine-runner';
import { useMeetingsController } from './hooks/use-meetings-controller';
import { useModelManagerController } from './hooks/use-model-manager-controller';

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const activePage = resolveActivePage(location.pathname);
  const viewingMeetingId = resolveViewingMeetingId(location.pathname);
  const activeSettingsModel = resolveSettingsModel(location.pathname);
  const activeTab = viewingMeetingId !== null ? resolveMeetingTab(location.pathname) : undefined;

  const meetingsController = useMeetingsController({
    navigate,
    viewingMeetingId,
    onSelectedMeetingDeleted: () => undefined,
  });
  const modelController = useModelManagerController();
  const engineRunner = useEngineRunner({
    meetingsRepoRef: meetingsController.meetingsRepoRef,
    meetings: meetingsController.meetings,
    selectedMeetingId: meetingsController.selectedMeetingId,
    refreshMeetings: meetingsController.refreshMeetings,
    setArtifactRevision: meetingsController.setArtifactRevision,
    getActiveModelVersion: modelController.getActiveModelVersion,
  });

  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      navigate('/meetings', { replace: true });
    }

    if (
      location.pathname === '/settings' ||
      location.pathname === '/settings/models'
    ) {
      navigate('/settings/models/transcription', { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => () => engineRunner.disposeEngineWorker(), []);

  const activeModelCount = MODEL_DOWNLOAD_TARGETS.filter(
    (target) => modelController.getActiveModelVersion(target.model) !== undefined,
  ).length;
  const downloadPercent = modelController.downloadProgress?.totalBytes
    ? Math.min(
        100,
        Math.round(
          (modelController.downloadProgress.loadedBytes /
            modelController.downloadProgress.totalBytes) *
            100,
        ),
      )
    : null;

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span>Notetaker Lab</span>
          <strong>Local meeting engine</strong>
        </div>
        <nav className={styles.nav} aria-label="Application sections">
          {(
            [
              ['meetings', 'Meetings', `${meetingsController.meetings.length} saved`],
              ['settings', 'Settings', `${activeModelCount}/4 models ready`],
            ] as const
          ).map(([page, label, detail]) => (
            <NavLink
              key={page}
              to={PAGE_PATHS[page]}
              data-active={activePage === page}
            >
              <span>{label}</span>
              <small>{detail}</small>
            </NavLink>
          ))}
        </nav>
      </aside>

      <section className={styles.workspace}>
        {activePage === 'settings' ? (
        <ModelsPage
          modelVersions={modelController.modelVersions}
          modelMessage={modelController.modelMessage}
          downloadingModel={modelController.downloadingModel}
          modelTargets={MODEL_DOWNLOAD_TARGETS}
          downloadSections={MODEL_DOWNLOAD_SECTIONS}
          getKnownDownloadSize={getKnownDownloadSize}
          getDirectDownloadKey={getDirectDownloadKey}
          getDirectDownloadVersion={modelController.getDirectDownloadVersion}
          getModelVersions={modelController.getModelVersions}
          getModelVersionTitle={getModelVersionTitle}
          onDownloadDirectModel={(download) =>
            void modelController.downloadDirectModel(download)
          }
          onSetActiveModelVersion={(model, version) =>
            void modelController.setActiveModelVersion(model, version)
          }
          onRemoveModelVersion={(version) =>
            void modelController.removeModelVersion(version)
          }
          activeModel={activeSettingsModel ?? 'transcription'}
          formatBytes={formatBytes}
        />
        ) : null}

        {activePage === 'meetings' && viewingMeetingId !== null
          ? (() => {
              const viewedMeeting = meetingsController.meetings.find(
                (meeting) => meeting.id === viewingMeetingId,
              );

              if (viewedMeeting === undefined) {
                return (
                  <Page
                    title="Meeting not found"
                    subtitle="The selected meeting could not be found in local storage."
                  >
                    <p className={styles.empty}>Meeting not found.</p>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        onClick={() => navigate('/meetings')}
                      >
                        Back to meetings
                      </button>
                    </div>
                  </Page>
                );
              }

              return (
                <MeetingDetailPage
                  meeting={viewedMeeting}
                  meetingUrl={meetingsController.meetingUrls[viewedMeeting.id]}
                  isRecording={
                    meetingsController.recordingMeetingId === viewedMeeting.id
                  }
                  status={meetingsController.status}
                  engineStatus={engineRunner.engineStatus}
                  engineMessage={engineRunner.engineMessage}
                  artifactRevision={meetingsController.artifactRevision}
                  liveTranscriptSegments={
                    engineRunner.engineStatus === 'processing' &&
                    engineRunner.liveTranscriptMeetingId === viewedMeeting.id
                      ? engineRunner.liveTranscriptSegments
                      : []
                  }
                  loadArtifact={meetingsController.loadMeetingArtifact}
                  saveArtifact={meetingsController.saveMeetingArtifact}
                  deleteArtifact={meetingsController.deleteMeetingArtifact}
                  onUpdateMeeting={(id, patch) =>
                    void meetingsController.updateMeeting(id, patch)
                  }
                  onStartRecording={() =>
                    void meetingsController.startRecording(viewedMeeting.id)
                  }
                  onStopRecording={() => void meetingsController.stopRecording()}
                  onCancelRecording={meetingsController.cancelRecording}
                  onUploadRecording={(file) =>
                    void meetingsController.uploadRecording(viewedMeeting.id, file)
                  }
                  onDeleteMeeting={() =>
                    void meetingsController.deleteMeeting(viewedMeeting)
                  }
                  onRunTranscript={() =>
                    void engineRunner.runTranscription(viewedMeeting.id)
                  }
                  onRunDiarization={() =>
                    void engineRunner.runDiarization(viewedMeeting.id)
                  }
                  onRunWordSync={() =>
                    void engineRunner.runWordSync(viewedMeeting.id)
                  }
                  onRunSpeakerNaming={() =>
                    void engineRunner.runSpeakerNaming(viewedMeeting.id)
                  }
                  onOpenLogging={engineRunner.openLogging}
                  activeTab={activeTab}
                  onBack={() => navigate('/meetings')}
                  formatBytes={formatBytes}
                  formatDate={formatDate}
                  formatTimestamp={formatTimestamp}
                />
              );
            })()
          : null}

        {activePage === 'meetings' && viewingMeetingId === null ? (
          <MeetingsPage
            meetings={meetingsController.meetings}
            message={meetingsController.message}
            isCreating={meetingsController.creatingMeeting}
            onCreateMeeting={() => void meetingsController.createMeeting()}
            onOpenMeeting={(meeting) => navigate(`/meetings/${meeting.id}`)}
            formatDate={formatDate}
          />
        ) : null}
      </section>

      {engineRunner.engineDialogOpen ? (
        <EngineLogDialog
          mode={engineRunner.engineDialogMode}
          status={engineRunner.engineStatus}
          meetingName={
            meetingsController.meetings.find(
              (meeting) => meeting.id === meetingsController.selectedMeetingId,
            )?.name ?? ''
          }
          logLines={engineRunner.engineLog}
          liveTranscriptSegments={engineRunner.liveTranscriptSegments}
          onClose={() => engineRunner.setEngineDialogOpen(false)}
        />
      ) : null}

      {modelController.downloadProgress !== null ? (
        <DownloadProgressDialog
          progress={modelController.downloadProgress}
          percent={downloadPercent}
          formatBytes={formatBytes}
          onClose={() => modelController.setDownloadProgress(null)}
        />
      ) : null}
    </main>
  );
}

export default App;
