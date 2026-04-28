import type { EngineProgressStatus } from './engine-progress-status';
import type { EngineStage } from './engine-stage';

export interface EngineProgressEvent {
  stage: EngineStage;
  status: EngineProgressStatus;
}
