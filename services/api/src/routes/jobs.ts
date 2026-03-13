import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJobSchema, downloadJobsSchema, estimateJobSchema, listJobsSchema } from '../schemas.js';
import { queries, type JobRow } from '../db.js';
import { cancelJob, enqueueJob, getJobProgress, getQueueSnapshot, onJobUpdate, type ProgressData, type QueueSnapshot } from '../worker.js';
import { config } from '../config.js';
import { BENCHMARK_CASES, isBenchmarkRunning } from '../benchmark.js';
import { getInstalledModelPath, isSupportedModelId } from '../models.js';
import { getLoraById } from '../loras.js';

const IRIS_REFERENCE_TEXT_SEQ = 512;
const FLUX_9B_REFERENCE_HEADS = 32;
const IRIS_REFERENCE_ATTENTION_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_SEQ = Math.floor(
  Math.sqrt(IRIS_REFERENCE_ATTENTION_MAX_BYTES / (FLUX_9B_REFERENCE_HEADS * Float32Array.BYTES_PER_ELEMENT))
);
const VALID_BENCHMARK_CASE_KEYS = new Set(
  BENCHMARK_CASES.map((benchmarkCase) => `${benchmarkCase.mode}:${benchmarkCase.width}:${benchmarkCase.height}:${benchmarkCase.inputCount}`)
);

export async function jobRoutes(app: FastifyInstance) {
  // Create a new generation job
  app.post('/api/jobs', async (req, reply) => {
    if (isBenchmarkRunning()) {
      return reply.status(409).send({ error: 'Benchmark is running. Wait for it to finish before queueing a job.' });
    }

    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { mode, prompt, model, loraId, loraScale, width, height, seed, steps, guidance, inputPaths } = parsed.data;
    const selectedModel = model ?? config.defaultModel;

    if (!isSupportedModelId(selectedModel)) {
      return reply.status(400).send({ error: 'Unsupported model' });
    }

    if (!getInstalledModelPath(selectedModel)) {
      return reply.status(409).send({ error: `Model is not installed: ${selectedModel}` });
    }

    const selectedLora = loraId ? getLoraById(loraId) : null;
    if (loraId && !selectedLora) {
      return reply.status(404).send({ error: `LoRA not found: ${loraId}` });
    }
    if (selectedLora && !selectedLora.runtimeReady) {
      return reply.status(409).send({ error: selectedLora.runtimeReadyReason });
    }
    if (selectedLora && !selectedLora.compatibleModelIds.includes(selectedModel)) {
      return reply.status(409).send({ error: `${selectedLora.filename} is not compatible with ${selectedModel}` });
    }

    // Validate mode vs inputs
    if (mode === 'img2img' && (!inputPaths || inputPaths.length === 0)) {
      return reply.status(400).send({ error: 'img2img requires at least one input image' });
    }
    if (mode === 'multi-ref' && (!inputPaths || inputPaths.length < 2)) {
      return reply.status(400).send({ error: 'multi-ref requires at least two input images' });
    }

    const id = randomUUID();
    const resolvedSize = mode === 'txt2img'
      ? { width, height }
      : fitImageEditSizeForReferenceBudget(width, height, inputPaths?.length ?? 0);

    queries.insertJob.run(
      id,
      mode,
      prompt,
      resolvedSize.width,
      resolvedSize.height,
      selectedModel,
      selectedLora?.id ?? null,
      selectedLora?.filename ?? null,
      selectedLora ? (loraScale ?? 1) : null,
      steps ?? null,
      guidance ?? null,
      inputPaths ? JSON.stringify(inputPaths) : null
    );

    if (seed != null) {
      queries.updateJobResult.run(
        'queued', seed, null, null, null, null, null, id
      );
    }

    enqueueJob(id);

    const job = queries.getJob.get(id) as JobRow;
    return reply.status(201).send(formatJob(job, buildFormatJobContext()));
  });

  app.post('/api/jobs/estimate', async (req, reply) => {
    const parsed = estimateJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { mode, model, width, height, steps, guidance, inputCount, quantity } = parsed.data;

    if (mode === 'img2img' && inputCount < 1) {
      return reply.status(400).send({ error: 'img2img requires at least one input image' });
    }
    if (mode === 'multi-ref' && inputCount < 2) {
      return reply.status(400).send({ error: 'multi-ref requires at least two input images' });
    }

    const resolvedSize = mode === 'txt2img'
      ? { width, height }
      : fitImageEditSizeForReferenceBudget(width, height, inputCount);
    const context = buildFormatJobContext({
      includeProjectedActiveSample: false,
      benchmarkModelId: model,
      targetModel: model,
    });
    const target: EstimationTarget = {
      mode,
      pixels: resolvedSize.width * resolvedSize.height,
      aspectRatio: resolvedSize.width / resolvedSize.height,
      inputCount,
      steps: steps ?? null,
      guidance: guidance ?? null,
    };

    const estimatedGenerationMs = estimateTargetDurationMs(target, context);
    const estimatedBatchMs = estimatedGenerationMs != null
      ? estimatedGenerationMs * quantity
      : null;
    const estimatedQueueAheadMs = getCurrentQueueRemainingMs(context);
    const estimatedTotalMs = estimatedBatchMs != null
      ? estimatedQueueAheadMs + estimatedBatchMs
      : null;
    const queueAheadCount = context.queuedJobIds.length + (context.activeJobId ? 1 : 0);

    return reply.send({
      estimatedGenerationMs,
      estimatedBatchMs,
      estimatedQueueAheadMs,
      estimatedTotalMs,
      queueAheadCount,
    });
  });

  // List jobs (paginated)
  app.get('/api/jobs', async (req, reply) => {
    const parsed = listJobsSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { limit, offset } = parsed.data;
    const jobs = queries.listJobs.all(limit, offset) as JobRow[];
    const countRow = queries.countJobs.get() as { count: number };

    const context = buildFormatJobContext();

    return reply.send({
      jobs: jobs.map((job) => formatJob(job, context)),
      total: countRow.count,
      limit,
      offset,
    });
  });

  // Get single job
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = queries.getJob.get(req.params.id) as JobRow | undefined;
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    return reply.send(formatJob(job, buildFormatJobContext()));
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = queries.getJob.get(req.params.id) as JobRow | undefined;
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    if (job.status === 'queued' || job.status === 'running' || job.status === 'saving') {
      return reply.status(409).send({ error: 'Only completed, failed, or stopped jobs can be deleted' });
    }

    removeStoredFile(config.outputDir, job.output_path);
    removeStoredFile(config.thumbDir, job.thumb_path);
    queries.deleteJob.run(job.id);

    return reply.status(204).send();
  });

  app.post('/api/jobs/download', async (req, reply) => {
    const parsed = downloadJobsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const requestedJobs = parsed.data.jobIds
      .map((jobId) => queries.getJob.get(jobId) as JobRow | undefined)
      .filter((job): job is JobRow => job != null);
    const sourcePaths = requestedJobs
      .filter((job) => job.status === 'done' && job.output_path)
      .map((job) => path.join(config.outputDir, path.basename(job.output_path!)))
      .filter((filePath) => fs.existsSync(filePath));

    if (sourcePaths.length === 0) {
      return reply.status(404).send({ error: 'No generated images were found for the selected jobs' });
    }

    const zipFilename = `iris-history-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const zipPath = path.join(os.tmpdir(), `${randomUUID()}.zip`);

    try {
      await createZipArchive(zipPath, sourcePaths);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create zip archive';
      return reply.status(500).send({ error: message });
    }

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const stream = fs.createReadStream(zipPath);
    stream.on('close', () => {
      fs.rmSync(zipPath, { force: true });
    });
    stream.on('error', () => {
      fs.rmSync(zipPath, { force: true });
    });

    return reply.send(stream);
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req, reply) => {
    const job = queries.getJob.get(req.params.id) as JobRow | undefined;
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    if (isTerminalStatus(job.status)) {
      return reply.status(409).send({ error: 'Only queued or active jobs can be stopped' });
    }

    const cancelled = cancelJob(job.id);
    if (!cancelled) {
      return reply.status(409).send({ error: 'Job is no longer stoppable' });
    }

    const updatedJob = queries.getJob.get(job.id) as JobRow | undefined;
    if (!updatedJob) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    return reply.send(formatJob(updatedJob, buildFormatJobContext()));
  });

  // SSE stream for job events
  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', async (req, reply) => {
    const job = queries.getJob.get(req.params.id) as JobRow | undefined;
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current status immediately
    const sendEvent = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('status', { status: job.status });
    const currentProgress = getJobProgress(job.id);
    if (currentProgress) {
      sendEvent('progress', currentProgress);
    }

    // If already terminal, close
    if (isTerminalStatus(job.status)) {
      sendEvent('done', formatJob(job, buildFormatJobContext()));
      reply.raw.end();
      return;
    }

    const unsubscribe = onJobUpdate((jobId, event, data) => {
      if (jobId !== req.params.id) return;

      if (event === 'progress') {
        sendEvent('progress', data ?? {});
      } else {
        sendEvent('status', { status: event, ...data });
      }

      if (isTerminalStatus(event)) {
        const updatedJob = queries.getJob.get(jobId) as JobRow;
        sendEvent('done', formatJob(updatedJob, buildFormatJobContext()));
        reply.raw.end();
        unsubscribe();
      }
    });

    req.raw.on('close', () => {
      unsubscribe();
    });
  });
}

function removeStoredFile(baseDir: string, storedFilename: string | null) {
  if (!storedFilename) return;

  const filePath = path.join(baseDir, path.basename(storedFilename));
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    console.error(`[jobs] failed to delete file ${filePath}:`, err);
  }
}

function createZipArchive(zipPath: string, sourcePaths: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/zip', ['-j', zipPath, ...sourcePaths], (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || 'zip command failed'));
        return;
      }

      resolve();
    });
  });
}

function isTerminalStatus(status: string) {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

function floorToMultiple(value: number, multiple: number) {
  return Math.floor(value / multiple) * multiple;
}

function getMaxReferenceImageTokens(referenceCount: number) {
  const totalImageStreams = Math.max(2, referenceCount + 1);
  return Math.floor((MAX_REFERENCE_TOTAL_SEQ - IRIS_REFERENCE_TEXT_SEQ) / totalImageStreams);
}

function fitImageEditSizeForReferenceBudget(width: number, height: number, referenceCount: number) {
  const longestEdge = Math.max(width, height);
  const maxDimensionScale = longestEdge > config.maxDimension ? config.maxDimension / longestEdge : 1;
  let resolvedWidth = Math.max(64, Math.min(config.maxDimension, floorToMultiple(width * maxDimensionScale, 16)));
  let resolvedHeight = Math.max(64, Math.min(config.maxDimension, floorToMultiple(height * maxDimensionScale, 16)));

  const maxTokens = getMaxReferenceImageTokens(referenceCount);
  const currentTokens = (resolvedWidth / 16) * (resolvedHeight / 16);

  if (currentTokens > maxTokens) {
    const attentionScale = Math.sqrt(maxTokens / currentTokens);
    resolvedWidth = Math.max(64, floorToMultiple(resolvedWidth * attentionScale, 16));
    resolvedHeight = Math.max(64, floorToMultiple(resolvedHeight * attentionScale, 16));
  }

  return { width: resolvedWidth, height: resolvedHeight };
}

interface FormatJobContext extends QueueSnapshot {
  now: number;
  targetModel: string | null;
  timingSamples: TimingSample[];
  queuedJobsById: Map<string, JobRow>;
  activeJob: JobRow | null;
}

interface TimingSample {
  source: 'job' | 'benchmark';
  model: string | null;
  mode: string;
  pixels: number;
  aspectRatio: number;
  inputCount: number;
  steps: number | null;
  guidance: number | null;
  durationMs: number;
  recencyRank: number;
}

interface EstimationTarget {
  mode: string;
  pixels: number;
  aspectRatio: number;
  inputCount: number;
  steps: number | null;
  guidance: number | null;
}

const HISTORY_SAMPLE_LIMIT = 50;
const NEIGHBOR_SAMPLE_LIMIT = 10;
const MIN_MODE_SAMPLE_COUNT = 3;

interface BuildFormatJobContextOptions {
  includeProjectedActiveSample?: boolean;
  benchmarkModelId?: string | null;
  targetModel?: string | null;
}

function buildFormatJobContext(options: BuildFormatJobContextOptions = {}): FormatJobContext {
  const { includeProjectedActiveSample = true, benchmarkModelId = null, targetModel = null } = options;
  const queueSnapshot = getQueueSnapshot();
  const now = Date.now();
  const activeJob = queueSnapshot.activeJobId
    ? (queries.getJob.get(queueSnapshot.activeJobId) as JobRow | undefined) ?? null
    : null;
  const queuedJobsById = new Map<string, JobRow>();

  for (const jobId of queueSnapshot.queuedJobIds) {
    const row = queries.getJob.get(jobId) as JobRow | undefined;
    if (row) {
      queuedJobsById.set(jobId, row);
    }
  }

  const resolvedModel = targetModel ?? benchmarkModelId ?? activeJob?.model ?? null;

  return {
    ...queueSnapshot,
    now,
    targetModel: resolvedModel,
    timingSamples: getTimingSamples(activeJob, queueSnapshot, now, includeProjectedActiveSample, benchmarkModelId, resolvedModel),
    queuedJobsById,
    activeJob,
  };
}

function getTimingSamples(
  activeJob: JobRow | null,
  snapshot: QueueSnapshot,
  now: number,
  includeProjectedActiveSample: boolean,
  benchmarkModelId: string | null,
  targetModel: string | null
): TimingSample[] {
  const modelForJobs = targetModel ?? benchmarkModelId ?? null;
  const modelJobRows = modelForJobs
    ? queries.listRecentCompletedTimingSamplesByModel.all(modelForJobs, HISTORY_SAMPLE_LIMIT) as Array<{
      mode: string; model: string; width: number; height: number;
      steps: number | null; guidance: number | null; input_paths: string | null; duration_ms: number;
    }>
    : [];
  const allJobRows = queries.listRecentCompletedTimingSamples.all(HISTORY_SAMPLE_LIMIT) as Array<{
    mode: string; model: string; width: number; height: number;
    steps: number | null; guidance: number | null; input_paths: string | null; duration_ms: number;
  }>;
  const jobRows = modelJobRows.length >= MIN_MODE_SAMPLE_COUNT ? modelJobRows : allJobRows;

  const jobSamples: TimingSample[] = [];
  for (let index = 0; index < jobRows.length; index++) {
    const row = jobRows[index];
    const pixels = row.width * row.height;
    if (!Number.isFinite(row.duration_ms) || pixels <= 0) continue;
    jobSamples.push({
      source: 'job',
      model: row.model,
      mode: row.mode,
      pixels,
      aspectRatio: row.width / row.height,
      inputCount: getInputCount(row.input_paths),
      steps: row.steps,
      guidance: row.guidance,
      durationMs: row.duration_ms,
      recencyRank: index,
    });
  }

  const benchmarkRows = benchmarkModelId
    ? queries.listLatestBenchmarkTimingSamples.all(benchmarkModelId, HISTORY_SAMPLE_LIMIT) as Array<{
      mode: string; width: number; height: number; input_count: number; duration_ms: number;
    }>
    : [];

  const benchmarkSamples: TimingSample[] = [];
  let benchmarkIndex = 0;
  for (const row of benchmarkRows) {
    if (!VALID_BENCHMARK_CASE_KEYS.has(`${row.mode}:${row.width}:${row.height}:${row.input_count}`)) continue;
    const pixels = row.width * row.height;
    if (!Number.isFinite(row.duration_ms) || pixels <= 0) continue;
    benchmarkSamples.push({
      source: 'benchmark',
      model: benchmarkModelId,
      mode: row.mode,
      pixels,
      aspectRatio: row.width / row.height,
      inputCount: row.input_count,
      steps: null,
      guidance: null,
      durationMs: row.duration_ms,
      recencyRank: benchmarkIndex,
    });
    benchmarkIndex++;
  }

  let samples: TimingSample[] = [...benchmarkSamples, ...jobSamples];

  samples = removeOutliers(samples, targetModel);

  if (includeProjectedActiveSample) {
    const projectedActiveSample = getProjectedActiveSample(activeJob, snapshot, now);
    if (projectedActiveSample) {
      samples.unshift(projectedActiveSample);
    }
  }

  return samples;
}

function removeOutliers(samples: TimingSample[], targetModel: string | null): TimingSample[] {
  if (samples.length < 6) return samples;

  const groups = new Map<string, TimingSample[]>();
  for (const sample of samples) {
    const key = `${sample.mode}:${sample.model ?? 'any'}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(sample);
  }

  const kept: TimingSample[] = [];
  for (const [, group] of groups) {
    if (group.length < 4) {
      kept.push(...group);
      continue;
    }

    const msPerPixelValues = group
      .map((s) => s.durationMs / s.pixels)
      .sort((a, b) => a - b);

    const q1 = msPerPixelValues[Math.floor(msPerPixelValues.length * 0.25)]!;
    const q3 = msPerPixelValues[Math.floor(msPerPixelValues.length * 0.75)]!;
    const iqr = q3 - q1;
    const lowerBound = q1 - 2.0 * iqr;
    const upperBound = q3 + 2.0 * iqr;

    for (const sample of group) {
      const mspp = sample.durationMs / sample.pixels;
      if (mspp >= lowerBound && mspp <= upperBound) {
        kept.push(sample);
      }
    }
  }

  return kept.length >= 3 ? kept : samples;
}

function getProjectedActiveSample(activeJob: JobRow | null, snapshot: QueueSnapshot, now: number): TimingSample | null {
  if (!activeJob || !snapshot.activeJobStartedAt) {
    return null;
  }

  const progress = getJobProgress(activeJob.id);
  if (!progress || progress.step < 2 || progress.totalSteps <= 0) {
    return null;
  }

  const pixels = activeJob.width * activeJob.height;
  if (pixels <= 0) {
    return null;
  }

  const elapsedMs = Math.max(0, now - snapshot.activeJobStartedAt);
  const projectedTotalMs = getProjectedTotalDurationMsFromProgress(progress, elapsedMs);
  if (projectedTotalMs == null || !Number.isFinite(projectedTotalMs) || projectedTotalMs <= 0) {
    return null;
  }

  return {
    source: 'job',
    model: activeJob.model,
    mode: activeJob.mode,
    pixels,
    aspectRatio: activeJob.width / activeJob.height,
    inputCount: getInputCount(activeJob.input_paths),
    steps: activeJob.steps,
    guidance: activeJob.guidance,
    durationMs: projectedTotalMs,
    recencyRank: -1,
  } satisfies TimingSample;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getDenoisingProgressRatio(progress: ProgressData | null) {
  if (!progress || progress.totalSteps <= 0 || progress.step <= 0) {
    return null;
  }

  return clamp(progress.step / progress.totalSteps, 0, 1);
}

function getProjectedTotalDurationMsFromProgress(progress: ProgressData | null, elapsedMs: number | null) {
  if (elapsedMs == null || elapsedMs <= 0) {
    return null;
  }

  const denoisingRatio = getDenoisingProgressRatio(progress);
  if (denoisingRatio == null || denoisingRatio <= 0 || denoisingRatio >= 1) {
    return null;
  }

  return Math.round(elapsedMs / denoisingRatio);
}

function getProgressProjectionBlend(progress: ProgressData | null) {
  if (!progress || progress.totalSteps <= 1 || progress.step < 2) {
    return 0;
  }

  return clamp((progress.step - 1) / Math.max(1, progress.totalSteps - 1), 0.2, 0.8);
}

function getInputCount(inputPaths: string | null) {
  if (!inputPaths) {
    return 0;
  }

  try {
    const parsed = JSON.parse(inputPaths) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function getTargetFromRow(row: Pick<JobRow, 'mode' | 'width' | 'height' | 'steps' | 'guidance' | 'input_paths'>): EstimationTarget {
  return {
    mode: row.mode,
    pixels: row.width * row.height,
    aspectRatio: row.width / row.height,
    inputCount: getInputCount(row.input_paths),
    steps: row.steps,
    guidance: row.guidance,
  };
}

function getWeightedMedian(entries: Array<{ value: number; weight: number }>) {
  const sorted = [...entries]
    .filter((entry) => Number.isFinite(entry.value) && entry.value > 0 && entry.weight > 0)
    .sort((a, b) => a.value - b.value);

  if (sorted.length === 0) {
    return null;
  }

  const totalWeight = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let cumulativeWeight = 0;

  for (const entry of sorted) {
    cumulativeWeight += entry.weight;
    if (cumulativeWeight >= totalWeight / 2) {
      return entry.value;
    }
  }

  return sorted[sorted.length - 1]?.value ?? null;
}

function getNormalizedDifference(current: number | null, sample: number | null, scale: number) {
  if (current == null && sample == null) {
    return 0;
  }

  if (current == null || sample == null) {
    return 0.35;
  }

  return Math.min(1.5, Math.abs(current - sample) / scale);
}

function getRecencyWeight(sample: TimingSample) {
  const baseWeight = sample.source === 'benchmark' ? 1.2 : 1;
  return sample.recencyRank < 0
    ? baseWeight * 1.35
    : baseWeight * Math.pow(sample.source === 'benchmark' ? 0.96 : 0.93, sample.recencyRank);
}

function getModelFactor(targetModel: string | null, sample: TimingSample): number {
  if (!targetModel || !sample.model) return 1;
  return sample.model === targetModel ? 2.5 : 0.15;
}

function getNeighborWeight(target: EstimationTarget, sample: TimingSample, targetModel: string | null = null) {
  const areaDelta = Math.abs(Math.log(target.pixels / sample.pixels));
  const aspectDelta = Math.abs(Math.log(target.aspectRatio / sample.aspectRatio));
  const stepDelta = getNormalizedDifference(target.steps, sample.steps, 8);
  const guidanceDelta = getNormalizedDifference(target.guidance, sample.guidance, 4);
  const inputDelta = Math.abs(target.inputCount - sample.inputCount);
  const distance =
    1 +
    areaDelta * 2.4 +
    aspectDelta * 0.9 +
    stepDelta * 0.45 +
    guidanceDelta * 0.2 +
    inputDelta * 0.4;
  const modeFactor = sample.mode === target.mode ? 1.7 : 0.45;
  const modelFactor = getModelFactor(targetModel, sample);

  return (modeFactor * modelFactor * getRecencyWeight(sample)) / (distance * distance);
}

function getRegressionWeight(target: EstimationTarget, sample: TimingSample, targetModel: string | null = null) {
  const areaDelta = Math.abs(Math.log(target.pixels / sample.pixels));
  const aspectDelta = Math.abs(Math.log(target.aspectRatio / sample.aspectRatio));
  const inputDelta = Math.abs(target.inputCount - sample.inputCount);
  const modeFactor = sample.mode === target.mode ? 1.5 : 0.65;
  const modelFactor = getModelFactor(targetModel, sample);

  return (modeFactor * modelFactor * getRecencyWeight(sample)) / (1 + areaDelta * 1.1 + aspectDelta * 0.4 + inputDelta * 0.25);
}

function getCandidateSamples(target: EstimationTarget, context: FormatJobContext) {
  const sameModeSamples = context.timingSamples.filter((sample) => sample.mode === target.mode);
  const hasBenchmarkCoverage = sameModeSamples.some((sample) => sample.source === 'benchmark');
  const minimumModeSamples = hasBenchmarkCoverage ? 3 : MIN_MODE_SAMPLE_COUNT;
  return sameModeSamples.length >= minimumModeSamples ? sameModeSamples : context.timingSamples;
}

function hasSufficientSameModeCoverage(target: EstimationTarget, context: FormatJobContext) {
  const sameModeSamples = context.timingSamples.filter((sample) => sample.mode === target.mode);
  const hasBenchmarkCoverage = sameModeSamples.some((sample) => sample.source === 'benchmark');
  const minimumModeSamples = hasBenchmarkCoverage ? 3 : MIN_MODE_SAMPLE_COUNT;
  return sameModeSamples.length >= minimumModeSamples;
}

function getModeBaselineMsPerPixel(samples: TimingSample[]) {
  const entries = samples
    .map((sample) => ({
      value: sample.durationMs / sample.pixels,
      weight: getRecencyWeight(sample),
    }))
    .filter((entry) => Number.isFinite(entry.value) && entry.value > 0 && entry.weight > 0);

  return getWeightedMedian(entries);
}

function getDefaultModeAdjustment(target: EstimationTarget) {
  if (target.mode === 'img2img') {
    return 1.45;
  }

  if (target.mode === 'multi-ref') {
    return Math.max(1.6, 1.3 + target.inputCount * 0.2);
  }

  return 1;
}

function getSparseModeAdjustment(target: EstimationTarget, context: FormatJobContext) {
  if (target.mode === 'txt2img' || hasSufficientSameModeCoverage(target, context)) {
    return 1;
  }

  const sameModeSamples = context.timingSamples.filter((sample) => sample.mode === target.mode);
  const txt2imgSamples = context.timingSamples.filter((sample) => sample.mode === 'txt2img');
  const defaultAdjustment = getDefaultModeAdjustment(target);
  const sameModeMsPerPixel = getModeBaselineMsPerPixel(sameModeSamples);
  const txt2imgMsPerPixel = getModeBaselineMsPerPixel(txt2imgSamples);

  if (sameModeMsPerPixel == null || txt2imgMsPerPixel == null || txt2imgMsPerPixel <= 0) {
    return defaultAdjustment;
  }

  return clamp(sameModeMsPerPixel / txt2imgMsPerPixel, defaultAdjustment, defaultAdjustment + 0.9);
}

function getLocalNeighborEstimateMs(target: EstimationTarget, samples: TimingSample[], targetModel: string | null) {
  const weightedNeighbors = samples
    .map((sample) => ({
      weight: getNeighborWeight(target, sample, targetModel),
      value: sample.durationMs,
    }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, NEIGHBOR_SAMPLE_LIMIT);

  return getWeightedMedian(weightedNeighbors);
}

function getRegressionEstimateMs(target: EstimationTarget, samples: TimingSample[], targetModel: string | null) {
  let sumWeight = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let sampleCount = 0;

  for (const sample of samples) {
    const weight = getRegressionWeight(target, sample, targetModel);
    if (weight <= 0) {
      continue;
    }

    const x = Math.log(sample.pixels);
    const y = Math.log(sample.durationMs);
    sumWeight += weight;
    sumX += weight * x;
    sumY += weight * y;
    sumXX += weight * x * x;
    sumXY += weight * x * y;
    sampleCount += 1;
  }

  if (sampleCount < 2 || sumWeight <= 0) {
    return null;
  }

  const denominator = sumWeight * sumXX - sumX * sumX;
  const rawSlope = denominator === 0
    ? 1
    : (sumWeight * sumXY - sumX * sumY) / denominator;
  const slope = clamp(rawSlope, 0.85, 1.45);
  const intercept = (sumY - slope * sumX) / sumWeight;
  const targetLogPixels = Math.log(target.pixels);
  const predictedDurationMs = Math.exp(intercept + slope * targetLogPixels);

  if (!Number.isFinite(predictedDurationMs) || predictedDurationMs <= 0) {
    return null;
  }

  const correctionEntries = samples
    .map((sample) => {
      const predictedSampleDurationMs = Math.exp(intercept + slope * Math.log(sample.pixels));
      if (!Number.isFinite(predictedSampleDurationMs) || predictedSampleDurationMs <= 0) {
        return null;
      }

      return {
        value: sample.durationMs / predictedSampleDurationMs,
        weight: getNeighborWeight(target, sample, targetModel),
      };
    })
    .filter((entry): entry is { value: number; weight: number } => entry !== null);

  const correctionFactor = getWeightedMedian(correctionEntries) ?? 1;
  return Math.round(predictedDurationMs * clamp(correctionFactor, 0.7, 1.35));
}

function getFallbackEstimateMs(target: EstimationTarget, samples: TimingSample[], targetModel: string | null) {
  const entries = samples
    .map((sample) => ({
      value: sample.durationMs / sample.pixels,
      weight: getNeighborWeight(target, sample, targetModel),
    }))
    .filter((entry) => entry.weight > 0);

  const msPerPixel = getWeightedMedian(entries);
  if (msPerPixel == null) {
    return null;
  }

  return Math.round(msPerPixel * target.pixels);
}

function estimateJobTotalDurationMs(
  row: Pick<JobRow, 'mode' | 'width' | 'height' | 'steps' | 'guidance' | 'input_paths'>,
  context: FormatJobContext
) {
  const target = getTargetFromRow(row);
  return estimateTargetDurationMs(target, context);
}

function estimateTargetDurationMs(target: EstimationTarget, context: FormatJobContext) {
  if (target.pixels <= 0) {
    return null;
  }

  const samples = getCandidateSamples(target, context);
  const tm = context.targetModel;
  const localEstimateMs = getLocalNeighborEstimateMs(target, samples, tm);
  const regressionEstimateMs = getRegressionEstimateMs(target, samples, tm);
  const fallbackEstimateMs = getFallbackEstimateMs(target, samples, tm);

  const blendedEstimateMs =
    localEstimateMs != null && regressionEstimateMs != null
      ? Math.round(localEstimateMs * 0.65 + regressionEstimateMs * 0.35)
      : localEstimateMs ?? regressionEstimateMs ?? fallbackEstimateMs;

  if (blendedEstimateMs == null) {
    return null;
  }

  const adjustedEstimateMs = Math.round(blendedEstimateMs * getSparseModeAdjustment(target, context));
  return Math.max(1000, adjustedEstimateMs);
}

function getCurrentQueueRemainingMs(context: FormatJobContext) {
  let remainingMs = 0;

  if (context.activeJobId && context.activeJob) {
    const activeRemainingMs = estimateActiveRemainingMs(context.activeJob, context);
    if (activeRemainingMs != null) {
      remainingMs += activeRemainingMs;
    }
  }

  for (const queuedJobId of context.queuedJobIds) {
    const queuedJob = context.queuedJobsById.get(queuedJobId);
    if (!queuedJob) {
      continue;
    }

    const queuedJobDurationMs = estimateJobTotalDurationMs(queuedJob, context);
    if (queuedJobDurationMs != null) {
      remainingMs += queuedJobDurationMs;
    }
  }

  return remainingMs;
}

function estimateActiveRemainingMs(row: JobRow, context: FormatJobContext) {
  const elapsedMs = context.activeJobId === row.id && context.activeJobStartedAt
    ? Math.max(0, context.now - context.activeJobStartedAt)
    : null;
  const progress = getJobProgress(row.id);
  const estimatedTotalMs = estimateJobTotalDurationMs(row, context);

  if (estimatedTotalMs != null && elapsedMs != null) {
    const progressProjectedTotalMs = getProjectedTotalDurationMsFromProgress(progress, elapsedMs);
    const progressBlend = getProgressProjectionBlend(progress);

    if (progressProjectedTotalMs != null && progressBlend > 0) {
      const blendedTotalMs = Math.round(
        estimatedTotalMs * (1 - progressBlend) + progressProjectedTotalMs * progressBlend
      );
      return Math.max(0, blendedTotalMs - elapsedMs);
    }

    return Math.max(0, estimatedTotalMs - elapsedMs);
  }

  if (elapsedMs != null) {
    const progressProjectedTotalMs = getProjectedTotalDurationMsFromProgress(progress, elapsedMs);
    if (progressProjectedTotalMs != null) {
      return Math.max(0, progressProjectedTotalMs - elapsedMs);
    }
  }

  return estimatedTotalMs;
}

function getQueuePosition(jobId: string, context: FormatJobContext) {
  const queueIndex = context.queuedJobIds.indexOf(jobId);
  return queueIndex === -1 ? null : queueIndex + 1;
}

function estimateRemainingMs(row: JobRow, context: FormatJobContext) {
  if (isTerminalStatus(row.status)) {
    return null;
  }

  if (row.id === context.activeJobId) {
    return estimateActiveRemainingMs(row, context);
  }

  const queuePosition = getQueuePosition(row.id, context);
  if (queuePosition == null) {
    return null;
  }

  let remainingMs = 0;

  if (context.activeJobId) {
    const activeRemainingMs = context.activeJob
      ? estimateActiveRemainingMs(context.activeJob, context)
      : null;

    if (activeRemainingMs != null) {
      remainingMs += activeRemainingMs;
    }
  }

  for (const queuedJobId of context.queuedJobIds) {
    const queuedJob = context.queuedJobsById.get(queuedJobId);
    if (!queuedJob) {
      continue;
    }

    const queuedJobDurationMs = estimateJobTotalDurationMs(queuedJob, context);
    if (queuedJobDurationMs != null) {
      remainingMs += queuedJobDurationMs;
    }

    if (queuedJobId === row.id) {
      break;
    }
  }

  return remainingMs > 0 ? remainingMs : null;
}

function formatJob(row: JobRow, context: FormatJobContext = buildFormatJobContext({ targetModel: row.model })) {
  const progress = isTerminalStatus(row.status) ? null : getJobProgress(row.id);
  const queuePosition = row.status === 'queued' ? getQueuePosition(row.id, context) : null;
  const estimatedRemainingMs = estimateRemainingMs(row, context);

  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    prompt: row.prompt,
    width: row.width,
    height: row.height,
    seed: row.seed,
    model: row.model,
    loraId: row.lora_id,
    loraName: row.lora_name,
    loraScale: row.lora_scale,
    steps: row.steps,
    guidance: row.guidance,
    inputPaths: row.input_paths ? JSON.parse(row.input_paths) : null,
    outputPath: row.output_path,
    thumbPath: row.thumb_path,
    durationMs: row.duration_ms,
    queuePosition,
    estimatedRemainingMs,
    progress,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: serializeUtcTimestamp(row.created_at),
    updatedAt: serializeUtcTimestamp(row.updated_at),
  };
}

function serializeUtcTimestamp(value: string) {
  if (!value) {
    return value;
  }

  const withTimeSeparator = value.includes('T') ? value : value.replace(' ', 'T');
  return withTimeSeparator.endsWith('Z') ? withTimeSeparator : `${withTimeSeparator}Z`;
}
