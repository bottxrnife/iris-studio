export type JobMode = 'txt2img' | 'img2img' | 'multi-ref';
export type JobStatus = 'queued' | 'running' | 'saving' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  status: JobStatus;
  mode: JobMode;
  prompt: string;
  width: number;
  height: number;
  seed: number | null;
  model: string;
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
  width: number;
  height: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  inputPaths?: string[];
}

export interface EstimateJobRequest {
  mode: JobMode;
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

export const PROMPT_EXAMPLES = [
  'editorial portrait, natural skin texture, soft diffused light, medium format photo',
  'oil painting of a coastal village at golden hour, impressionist brushwork, warm palette',
  'macro photograph of morning dew on a spider web, bokeh background, natural light',
  'architectural interior, minimalist concrete space, dramatic shadows, wide angle',
  'watercolor illustration of a forest path in autumn, loose brushstrokes, muted earth tones',
] as const;
