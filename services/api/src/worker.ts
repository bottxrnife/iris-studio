import { spawn, type ChildProcessByStdio } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { config } from './config.js';
import { queries, type JobRow } from './db.js';
import { consumeProgressBuffer, createInitialProgressState, parseProgressLine, stripAnsi, type ProgressData } from './iris-progress.js';

export type JobPhase = 'queued' | 'running' | 'saving' | 'done' | 'failed' | 'cancelled';
export type JobEventType = JobPhase | 'progress';
export type { ProgressData } from './iris-progress.js';

export interface QueueSnapshot {
  activeJobId: string | null;
  activeJobStartedAt: number | null;
  queuedJobIds: string[];
}

type JobEventData = Record<string, unknown> | ProgressData;
type JobListener = (jobId: string, event: JobEventType, data?: JobEventData) => void;

const listeners = new Set<JobListener>();
const latestProgress = new Map<string, ProgressData>();

export function onJobUpdate(fn: JobListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(jobId: string, event: JobEventType, data?: JobEventData) {
  if (event === 'progress' && data) {
    latestProgress.set(jobId, data as unknown as ProgressData);
  }

  if (event === 'done' || event === 'failed' || event === 'cancelled') {
    latestProgress.delete(jobId);
  }

  for (const fn of listeners) {
    try { fn(jobId, event, data); } catch { /* ignore */ }
  }
}

export function getJobProgress(jobId: string): ProgressData | null {
  return latestProgress.get(jobId) ?? null;
}

let running = false;
const queue: string[] = [];
const CANCEL_KILL_TIMEOUT_MS = 3000;
let activeJobId: string | null = null;
let activeJobStartedAt: number | null = null;
let activeProc: ChildProcessByStdio<null, Readable, Readable> | null = null;
const cancelRequested = new Set<string>();

export function enqueueJob(jobId: string) {
  if (activeJobId === jobId || queue.includes(jobId)) {
    return;
  }

  queue.push(jobId);
  processNext();
}

export function getQueueSnapshot(): QueueSnapshot {
  return {
    activeJobId,
    activeJobStartedAt,
    queuedJobIds: [...queue],
  };
}

export function restoreQueuedJobs() {
  if (running || activeJobId || queue.length > 0) {
    return;
  }

  const recoverableJobs = queries.listRecoverableJobs.all() as JobRow[];
  for (const row of recoverableJobs) {
    cleanupStoredArtifacts(row);
    if (row.status !== 'queued') {
      queries.updateJobStatus.run('queued', row.id);
    }
    queue.push(row.id);
  }

  processNext();
}

export function cancelJob(jobId: string): boolean {
  const queuedIndex = queue.indexOf(jobId);
  if (queuedIndex !== -1) {
    queue.splice(queuedIndex, 1);
    markJobCancelled(jobId, null, null);
    processNext();
    return true;
  }

  if (activeJobId === jobId) {
    cancelRequested.add(jobId);
    stopActiveProcess(jobId);
    return true;
  }

  const row = queries.getJob.get(jobId) as JobRow | undefined;
  if (!row) {
    return false;
  }

  if (row.status === 'queued' || row.status === 'running' || row.status === 'saving') {
    cleanupStoredArtifacts(row);
    markJobCancelled(jobId, row.duration_ms, row.iris_stderr);
    return true;
  }

  return false;
}

function processNext() {
  if (running || queue.length === 0) return;

  const jobId = queue.shift()!;
  running = true;
  activeJobId = jobId;
  activeJobStartedAt = Date.now();

  runJob(jobId)
    .catch((err) => {
      console.error(`[worker] job ${jobId} failed:`, err);
    })
    .finally(() => {
      running = false;
      if (activeJobId === jobId) {
        activeJobId = null;
        activeJobStartedAt = null;
        activeProc = null;
      }
      cancelRequested.delete(jobId);
      processNext();
    });
}

async function runJob(jobId: string) {
  const row = queries.getJob.get(jobId) as JobRow | undefined;
  if (!row) {
    console.error(`[worker] job ${jobId} not found`);
    return;
  }

  if (row.status === 'cancelled' || isCancelRequested(jobId)) {
    cleanupStoredArtifacts(row);
    markJobCancelled(jobId, row.duration_ms, row.iris_stderr);
    return;
  }

  queries.updateJobStatus.run('running', jobId);
  emit(jobId, 'running');

  const outputFilename = `${jobId}.png`;
  const outputPath = path.join(config.outputDir, outputFilename);

  fs.mkdirSync(config.outputDir, { recursive: true });

  const args = buildIrisArgs(row, outputPath);
  console.log(`[worker] running: ${config.irisBin} ${args.join(' ')}`);

  const startTime = Date.now();

  const result = await spawnIris(jobId, args);

  const durationMs = Date.now() - startTime;

  if (result.cancelled || isCancelRequested(jobId)) {
    cleanupStoredArtifacts(row, outputPath);
    markJobCancelled(jobId, durationMs, result.stderr);
    return;
  }

  if (result.exitCode !== 0) {
    queries.updateJobResult.run(
      'failed', null, null, null, durationMs, result.stderr, null, jobId
    );
    emit(jobId, 'failed', { error: result.stderr });
    return;
  }

  emit(jobId, 'saving');
  queries.updateJobStatus.run('saving', jobId);

  if (isCancelRequested(jobId)) {
    cleanupStoredArtifacts(row, outputPath);
    markJobCancelled(jobId, durationMs, result.stderr);
    return;
  }

  const seed = parseSeedFromStderr(result.stderr);

  let thumbPath: string | null = null;
  try {
    const thumbFilename = `${jobId}_thumb.webp`;
    thumbPath = path.join(config.thumbDir, thumbFilename);
    fs.mkdirSync(config.thumbDir, { recursive: true });
    await sharp(outputPath)
      .resize(config.thumbSize, config.thumbSize, { fit: 'inside' })
      .webp({ quality: 80 })
      .toFile(thumbPath);
    thumbPath = thumbFilename;
  } catch (err) {
    console.error(`[worker] thumb generation failed:`, err);
    thumbPath = null;
  }

  if (isCancelRequested(jobId)) {
    cleanupStoredArtifacts(row, outputPath, thumbPath ? path.join(config.thumbDir, thumbPath) : null);
    markJobCancelled(jobId, durationMs, result.stderr);
    return;
  }

  const metadata = parseMetadataFromStderr(result.stderr);

  queries.updateJobResult.run(
    'done',
    seed,
    outputFilename,
    thumbPath,
    durationMs,
    result.stderr,
    metadata ? JSON.stringify(metadata) : null,
    jobId
  );

  emit(jobId, 'done', { seed, durationMs, outputPath: outputFilename, thumbPath });
}

function buildIrisArgs(row: JobRow, outputPath: string): string[] {
  const args: string[] = [
    '-d', config.irisModelDir,
    '-p', row.prompt,
    '-W', String(row.width),
    '-H', String(row.height),
    '-o', outputPath,
    '-v',
  ];

  if (row.seed != null) {
    args.push('-S', String(row.seed));
  }

  if (row.steps != null) {
    args.push('-s', String(row.steps));
  }

  if (row.guidance != null) {
    args.push('-g', String(row.guidance));
  }

  const inputPaths = row.input_paths ? JSON.parse(row.input_paths) as string[] : [];
  for (const inputFile of inputPaths) {
    const resolved = path.isAbsolute(inputFile)
      ? inputFile
      : path.join(config.uploadDir, inputFile);
    args.push('-i', resolved);
  }

  return args;
}

function spawnIris(jobId: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string; cancelled: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(config.irisBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProc = proc;

    let stdout = '';
    let stderr = '';
    let stderrBuf = '';
    let progressState = createInitialProgressState();

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const result = consumeProgressBuffer(stderrBuf + text, progressState, (progress) => {
        emit(jobId, 'progress', progress);
      });
      stderrBuf = result.remainder;
      progressState = result.state;
    });

    proc.on('close', (code) => {
      if (activeProc === proc) {
        activeProc = null;
      }

      const result = consumeProgressBuffer(stderrBuf, progressState, (progress) => {
        emit(jobId, 'progress', progress);
      });
      stderrBuf = result.remainder;
      progressState = result.state;

      const remainingLine = stripAnsi(stderrBuf).trim();
      if (remainingLine) {
        progressState = parseProgressLine(remainingLine, progressState, (progress) => {
          emit(jobId, 'progress', progress);
        });
      }
      resolve({ exitCode: code ?? 1, stdout, stderr, cancelled: isCancelRequested(jobId) });
    });

    proc.on('error', (err) => {
      if (activeProc === proc) {
        activeProc = null;
      }
      resolve({ exitCode: 1, stdout, stderr: stderr + '\n' + err.message, cancelled: isCancelRequested(jobId) });
    });
  });
}

function isCancelRequested(jobId: string) {
  return cancelRequested.has(jobId);
}

function stopActiveProcess(jobId: string) {
  if (!activeProc || activeJobId !== jobId || activeProc.killed) {
    return;
  }

  activeProc.kill('SIGTERM');

  const proc = activeProc;
  setTimeout(() => {
    if (activeJobId === jobId && activeProc === proc && proc.exitCode == null && proc.signalCode == null) {
      proc.kill('SIGKILL');
    }
  }, CANCEL_KILL_TIMEOUT_MS).unref();
}

function cleanupStoredArtifacts(
  row: Pick<JobRow, 'output_path' | 'thumb_path'>,
  outputPath?: string | null,
  thumbPath?: string | null
) {
  removeFile(outputPath ?? (row.output_path ? path.join(config.outputDir, row.output_path) : null));
  removeFile(thumbPath ?? (row.thumb_path ? path.join(config.thumbDir, row.thumb_path) : null));
}

function removeFile(filePath: string | null | undefined) {
  if (!filePath) return;

  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    console.error(`[worker] failed to remove file ${filePath}:`, err);
  }
}

function markJobCancelled(jobId: string, durationMs: number | null, stderr: string | null) {
  const row = queries.getJob.get(jobId) as JobRow | undefined;
  const seed = row?.seed ?? parseSeedFromStderr(stderr ?? '');

  queries.updateJobResult.run(
    'cancelled',
    seed,
    null,
    null,
    durationMs,
    stderr,
    null,
    jobId
  );

  emit(jobId, 'cancelled', { durationMs });
}

function parseSeedFromStderr(stderr: string): number | null {
  // iris.c prints "Seed: <number>" to stderr
  const match = stderr.match(/Seed:\s*(\d+)/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

function parseMetadataFromStderr(stderr: string): Record<string, string> | null {
  const metadata: Record<string, string> = {};

  const patterns = [
    { key: 'seed', regex: /Seed:\s*(\d+)/i },
    { key: 'steps', regex: /Steps:\s*(\d+)/i },
    { key: 'guidance', regex: /Guidance:\s*([\d.]+)/i },
    { key: 'model', regex: /Model:\s*(.+)/i },
    { key: 'scheduler', regex: /Scheduler:\s*(.+)/i },
    { key: 'total_time', regex: /Total time:\s*(.+)/i },
    { key: 'generation_time', regex: /Generation time:\s*(.+)/i },
  ];

  for (const { key, regex } of patterns) {
    const match = stderr.match(regex);
    if (match) metadata[key] = match[1].trim();
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}
