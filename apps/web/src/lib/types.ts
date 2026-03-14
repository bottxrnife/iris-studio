export type JobMode = 'txt2img' | 'img2img' | 'multi-ref';
export type JobStatus = 'queued' | 'running' | 'saving' | 'done' | 'failed' | 'cancelled';
export type ModelId = 'flux-klein-4b' | 'flux-klein-base-4b' | 'flux-klein-9b' | 'flux-klein-base-9b' | 'zimage-turbo-6b';
export type ModelLicense = 'apache-2.0' | 'flux-non-commercial';
export type ModelVariant = 'distilled' | 'base' | 'turbo';
export type ModelParameterSize = '4B' | '6B' | '9B';
export type LocalModelSource = 'directory';
export type ModelDownloadStatus = 'idle' | 'preparing' | 'downloading' | 'installing' | 'stopping' | 'done' | 'failed' | 'cancelled' | 'paused';
export type ModelInstallStatus = 'missing' | 'partial' | 'installed';
export type LoraFormat = 'fal-ai' | 'comfyui' | 'unknown';
export type LoraFormatConfidence = 'metadata' | 'heuristic' | 'manual' | 'unknown';
export type LoraTensorDtype = 'bf16' | 'f16' | 'f32' | 'other' | 'mixed' | 'unknown';

export interface Job {
  id: string;
  status: JobStatus;
  mode: JobMode;
  prompt: string;
  model: ModelId;
  loraId: string | null;
  loraName: string | null;
  loraScale: number | null;
  width: number;
  height: number;
  seed: number | null;
  steps: number | null;
  guidance: number | null;
  inputPaths: string[] | null;
  outputPath: string | null;
  thumbPath: string | null;
  durationMs: number | null;
  queuePosition: number | null;
  estimatedRemainingMs: number | null;
  progress: JobProgress | null;
  metadata: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EditorDraft {
  mode: JobMode;
  prompt: string;
  model: ModelId;
  loraId: string | null;
  loraScale: number | null;
  width: number;
  height: number;
  seed: number | null;
  steps: number | null;
  guidance: number | null;
  inputPaths: string[] | null;
}

export interface JobProgress {
  step: number;
  totalSteps: number;
  percent: number;
  phase: string;
  substep?: number;
  totalSubsteps?: number;
}

export interface JobStatusEvent {
  status: JobStatus;
  seed?: number;
  durationMs?: number;
  outputPath?: string;
  thumbPath?: string;
  error?: string;
}

export type JobStreamEvent =
  | { type: 'status'; data: JobStatusEvent }
  | { type: 'progress'; data: JobProgress }
  | { type: 'done'; data: Job };

export interface JobListResponse {
  jobs: Job[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateJobRequest {
  mode: JobMode;
  prompt: string;
  model: ModelId;
  loraId?: string;
  loraScale?: number;
  width: number;
  height: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  inputPaths?: string[];
}

export interface EstimateJobRequest {
  mode: JobMode;
  model: ModelId;
  width: number;
  height: number;
  steps?: number;
  guidance?: number;
  inputCount: number;
  quantity: number;
}

export interface EstimateJobResponse {
  estimatedGenerationMs: number | null;
  estimatedBatchMs: number | null;
  estimatedQueueAheadMs: number;
  estimatedTotalMs: number | null;
  queueAheadCount: number;
}

export type BenchmarkStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface BenchmarkSample {
  id: string;
  mode: Extract<JobMode, 'txt2img' | 'img2img'>;
  label: string;
  width: number;
  height: number;
  inputCount: number;
  durationMs: number;
  createdAt: string;
}

export interface BenchmarkRun {
  id: string;
  model: ModelId | null;
  status: BenchmarkStatus;
  totalCases: number;
  completedCases: number;
  currentCaseLabel: string | null;
  currentProgress: JobProgress | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  samples: BenchmarkSample[];
}

export interface BenchmarkStatusResponse {
  currentRun: BenchmarkRun | null;
  latestRun: BenchmarkRun | null;
  latestUsableRun: BenchmarkRun | null;
  latestRunsByModel: Partial<Record<ModelId, BenchmarkRun | null>>;
  latestUsableRunsByModel: Partial<Record<ModelId, BenchmarkRun | null>>;
}

export interface ModelDownload {
  status: ModelDownloadStatus;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  error: string | null;
  progressPercent: number | null;
  speedMBps: number | null;
  etaSeconds: number | null;
  logLines: string[];
}

export interface ModelInfo {
  id: ModelId;
  label: string;
  summary: string;
  variant: ModelVariant;
  parameterSize: ModelParameterSize;
  repoId: string;
  huggingFaceUrl: string;
  recommendedSteps: number;
  recommendedGuidance: number | null;
  license: ModelLicense;
  gated: boolean;
  installDirName: string;
  installStatus: ModelInstallStatus;
  installed: boolean;
  localPath: string | null;
  localSource: LocalModelSource | null;
  missingComponents: string[];
  download: ModelDownload;
}

export interface ModelsResponse {
  modelsDir: string;
  activeDownloadModelId: ModelId | null;
  hasAnyInstalled: boolean;
  models: ModelInfo[];
}

export interface LoraInfo {
  id: string;
  filename: string;
  localPath: string;
  sizeBytes: number;
  manualFormat: Exclude<LoraFormat, 'unknown'> | null;
  manualModelId: ModelId | null;
  format: LoraFormat;
  formatConfidence: LoraFormatConfidence;
  tensorDtype: LoraTensorDtype;
  tensorCount: number;
  triggerPhrases: string[];
  baseModelHint: string | null;
  detectedBaseModelId: ModelId | null;
  compatibleModelIds: ModelId[];
  fileReady: boolean;
  fileReadyReason: string;
  runtimeReady: boolean;
  runtimeReadyReason: string;
  issues: string[];
}

export interface LorasResponse {
  lorasDir: string;
  runtimeSupport: {
    canApplyDuringGeneration: boolean;
    reason: string;
  };
  loras: LoraInfo[];
}

export const SIZE_PRESETS = [
  { label: '512 × 512', width: 512, height: 512 },
  { label: '768 × 768', width: 768, height: 768 },
  { label: '1024 × 1024', width: 1024, height: 1024 },
  { label: '768 × 512', width: 768, height: 512 },
  { label: '512 × 768', width: 512, height: 768 },
  { label: '1024 × 768', width: 1024, height: 768 },
  { label: '768 × 1024', width: 768, height: 1024 },
] as const;
