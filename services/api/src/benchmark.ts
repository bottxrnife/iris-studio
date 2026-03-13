import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { config } from './config.js';
import { queries, type BenchmarkRunRow, type BenchmarkSampleRow } from './db.js';
import { consumeProgressBuffer, createInitialProgressState, parseProgressLine, stripAnsi, type ProgressData } from './iris-progress.js';
import { getInstalledModelPath, SUPPORTED_MODELS, type ModelId } from './models.js';

type BenchmarkMode = 'txt2img' | 'img2img';

interface BenchmarkCase {
  mode: BenchmarkMode;
  label: string;
  width: number;
  height: number;
  inputCount: number;
  prompt: string;
}

const BENCHMARK_SEED = 42;
const BENCHMARK_PROMPT_TXT = 'benchmark scene, studio lighting, detailed textures, balanced composition';
const BENCHMARK_PROMPT_IMG = 'polished editorial illustration, preserve the subject and composition, clean edges';

export const BENCHMARK_CASES: BenchmarkCase[] = [
  { mode: 'txt2img', label: '512 x 512', width: 512, height: 512, inputCount: 0, prompt: BENCHMARK_PROMPT_TXT },
  { mode: 'txt2img', label: '768 x 768', width: 768, height: 768, inputCount: 0, prompt: BENCHMARK_PROMPT_TXT },
  { mode: 'txt2img', label: '1024 x 1024', width: 1024, height: 1024, inputCount: 0, prompt: BENCHMARK_PROMPT_TXT },
  { mode: 'img2img', label: '512 x 512', width: 512, height: 512, inputCount: 1, prompt: BENCHMARK_PROMPT_IMG },
  { mode: 'img2img', label: '768 x 768', width: 768, height: 768, inputCount: 1, prompt: BENCHMARK_PROMPT_IMG },
  { mode: 'img2img', label: '1024 x 1024', width: 1024, height: 1024, inputCount: 1, prompt: BENCHMARK_PROMPT_IMG },
];

const BENCHMARK_STOP_KILL_TIMEOUT_MS = 3000;
let runningBenchmarkId: string | null = null;
let currentBenchmarkProgress: ProgressData | null = null;
let activeBenchmarkProc: ChildProcessByStdio<null, null, Readable> | null = null;
let cancelBenchmarkRequested = false;

class BenchmarkCancelledError extends Error {}

export function restoreBenchmarkRuns() {
  queries.failInterruptedBenchmarkRuns.run('Interrupted by API restart');
  runningBenchmarkId = null;
  currentBenchmarkProgress = null;
  activeBenchmarkProc = null;
  cancelBenchmarkRequested = false;
}

export function isBenchmarkRunning() {
  if (runningBenchmarkId) {
    return true;
  }

  const runningRow = queries.getRunningBenchmarkRun.get() as BenchmarkRunRow | undefined;
  if (runningRow) {
    runningBenchmarkId = runningRow.id;
    return true;
  }

  return false;
}

export function getCurrentBenchmarkRun() {
  const row = queries.getRunningBenchmarkRun.get() as BenchmarkRunRow | undefined;
  if (!row) {
    return null;
  }

  return {
    row,
    samples: queries.listBenchmarkSamplesByRun.all(row.id) as BenchmarkSampleRow[],
    progress: currentBenchmarkProgress,
  };
}

export function getLatestBenchmarkRun() {
  const row = queries.getLatestFinishedBenchmarkRun.get() as BenchmarkRunRow | undefined;
  if (!row) {
    return null;
  }

  return {
    row,
    samples: queries.listBenchmarkSamplesByRun.all(row.id) as BenchmarkSampleRow[],
    progress: null,
  };
}

export function getLatestUsableBenchmarkRun() {
  const row = queries.getLatestFinishedBenchmarkRunWithSamples.get() as BenchmarkRunRow | undefined;
  if (!row) {
    return null;
  }

  return {
    row,
    samples: queries.listBenchmarkSamplesByRun.all(row.id) as BenchmarkSampleRow[],
    progress: null,
  };
}

export function getLatestBenchmarkRunsByModel() {
  const result = {} as Partial<Record<ModelId, ReturnType<typeof getLatestBenchmarkRun>>>;

  for (const model of SUPPORTED_MODELS) {
    const row = queries.getLatestFinishedBenchmarkRunByModel.get(model.id) as BenchmarkRunRow | undefined;
    if (!row) {
      continue;
    }

    result[model.id] = {
      row,
      samples: queries.listBenchmarkSamplesByRun.all(row.id) as BenchmarkSampleRow[],
      progress: null,
    };
  }

  return result;
}

export function getLatestUsableBenchmarkRunsByModel() {
  const result = {} as Partial<Record<ModelId, ReturnType<typeof getLatestUsableBenchmarkRun>>>;

  for (const model of SUPPORTED_MODELS) {
    const row = queries.getLatestFinishedBenchmarkRunWithSamplesByModel.get(model.id) as BenchmarkRunRow | undefined;
    if (!row) {
      continue;
    }

    result[model.id] = {
      row,
      samples: queries.listBenchmarkSamplesByRun.all(row.id) as BenchmarkSampleRow[],
      progress: null,
    };
  }

  return result;
}

export function startBenchmarkRun(modelId: ModelId = config.defaultModel as ModelId) {
  if (isBenchmarkRunning()) {
    const current = getCurrentBenchmarkRun();
    if (current) {
      return current;
    }
    throw new Error('Benchmark is already running');
  }

  const runId = randomUUID();
  queries.insertBenchmarkRun.run(runId, modelId, BENCHMARK_CASES.length, BENCHMARK_CASES[0]?.label ?? null);
  runningBenchmarkId = runId;
  cancelBenchmarkRequested = false;

  void runBenchmark(runId, modelId);

  const row = queries.getBenchmarkRun.get(runId) as BenchmarkRunRow;
  return {
    row,
    samples: [] as BenchmarkSampleRow[],
    progress: null,
  };
}

export function cancelBenchmarkRun() {
  if (!isBenchmarkRunning()) {
    return false;
  }

  cancelBenchmarkRequested = true;

  if (activeBenchmarkProc && !activeBenchmarkProc.killed) {
    const proc = activeBenchmarkProc;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (activeBenchmarkProc === proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }, BENCHMARK_STOP_KILL_TIMEOUT_MS);
  }

  return true;
}

async function runBenchmark(runId: string, modelId: ModelId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-benchmark-'));

  try {
    let completedCases = 0;

    for (const benchmarkCase of BENCHMARK_CASES) {
      if (cancelBenchmarkRequested) {
        throw new BenchmarkCancelledError('Benchmark stopped by user');
      }

      currentBenchmarkProgress = null;
      queries.updateBenchmarkRunProgress.run(completedCases, benchmarkCase.label, runId);
      const durationMs = await runBenchmarkCase(benchmarkCase, tmpDir, modelId);

      queries.insertBenchmarkSample.run(
        randomUUID(),
        runId,
        benchmarkCase.mode,
        benchmarkCase.label,
        benchmarkCase.width,
        benchmarkCase.height,
        benchmarkCase.inputCount,
        durationMs
      );

      completedCases += 1;
      queries.updateBenchmarkRunProgress.run(
        completedCases,
        BENCHMARK_CASES[completedCases]?.label ?? null,
        runId
      );
    }

    queries.finishBenchmarkRun.run(runId);
  } catch (error) {
    if (error instanceof BenchmarkCancelledError || cancelBenchmarkRequested) {
      queries.failBenchmarkRun.run('cancelled', 'Stopped by user', runId);
    } else {
      const message = error instanceof Error ? error.message : 'Benchmark failed';
      queries.failBenchmarkRun.run('failed', message, runId);
    }
  } finally {
    runningBenchmarkId = null;
    currentBenchmarkProgress = null;
    activeBenchmarkProc = null;
    cancelBenchmarkRequested = false;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function runBenchmarkCase(benchmarkCase: BenchmarkCase, tmpDir: string, modelId: ModelId) {
  const modelPath = getInstalledModelPath(modelId);
  if (!modelPath) {
    throw new Error(`Benchmark model is not installed: ${modelId}`);
  }

  const outputPath = path.join(tmpDir, `${benchmarkCase.mode}-${benchmarkCase.width}x${benchmarkCase.height}.png`);
  const args: string[] = [
    '-d', modelPath,
    '-p', benchmarkCase.prompt,
    '-W', String(benchmarkCase.width),
    '-H', String(benchmarkCase.height),
    '-o', outputPath,
    '-S', String(BENCHMARK_SEED),
    '-v',
  ];

  let referencePath: string | null = null;
  if (benchmarkCase.mode === 'img2img') {
    referencePath = path.join(tmpDir, `reference-${benchmarkCase.width}x${benchmarkCase.height}.png`);
    await createBenchmarkReferenceImage(referencePath, benchmarkCase.width, benchmarkCase.height);
    args.push('-i', referencePath);
  }

  try {
    const startedAt = Date.now();
    const result = await spawnBenchmarkProcess(args, (progress) => {
      currentBenchmarkProgress = progress;
    });
    const durationMs = Date.now() - startedAt;

    if (result.cancelled || cancelBenchmarkRequested) {
      throw new BenchmarkCancelledError('Benchmark stopped by user');
    }

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `iris exited with code ${result.exitCode}`);
    }

    return durationMs;
  } finally {
    fs.rmSync(outputPath, { force: true });
    if (referencePath) {
      fs.rmSync(referencePath, { force: true });
    }
  }
}

async function createBenchmarkReferenceImage(filePath: string, width: number, height: number) {
  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f172a" />
          <stop offset="100%" stop-color="#475569" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#bg)" />
      <circle cx="${Math.round(width * 0.32)}" cy="${Math.round(height * 0.34)}" r="${Math.round(Math.min(width, height) * 0.18)}" fill="#f59e0b" opacity="0.85" />
      <rect x="${Math.round(width * 0.52)}" y="${Math.round(height * 0.22)}" width="${Math.round(width * 0.24)}" height="${Math.round(height * 0.46)}" rx="${Math.round(Math.min(width, height) * 0.04)}" fill="#38bdf8" opacity="0.9" />
      <rect x="${Math.round(width * 0.18)}" y="${Math.round(height * 0.7)}" width="${Math.round(width * 0.64)}" height="${Math.round(height * 0.12)}" rx="${Math.round(Math.min(width, height) * 0.03)}" fill="#e2e8f0" opacity="0.85" />
    </svg>
  `;

  await sharp(Buffer.from(svg))
    .png()
    .toFile(filePath);
}

function spawnBenchmarkProcess(args: string[], onProgress: (progress: ProgressData) => void) {
  return new Promise<{ exitCode: number; stderr: string; cancelled: boolean }>((resolve) => {
    const proc = spawn(config.irisBin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    activeBenchmarkProc = proc;

    let stderr = '';
    let stderrBuf = '';
    let progressState = createInitialProgressState();

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const result = consumeProgressBuffer(stderrBuf + text, progressState, onProgress);
      stderrBuf = result.remainder;
      progressState = result.state;
    });

    proc.on('close', (code) => {
      const result = consumeProgressBuffer(stderrBuf, progressState, onProgress);
      stderrBuf = result.remainder;
      progressState = result.state;

      const remainingLine = stripAnsi(stderrBuf).trim();
      if (remainingLine) {
        progressState = parseProgressLine(remainingLine, progressState, onProgress);
      }

      if (activeBenchmarkProc === proc) {
        activeBenchmarkProc = null;
      }

      resolve({ exitCode: code ?? 1, stderr, cancelled: cancelBenchmarkRequested });
    });

    proc.on('error', (error) => {
      if (activeBenchmarkProc === proc) {
        activeBenchmarkProc = null;
      }

      resolve({ exitCode: 1, stderr: `${stderr}\n${error.message}`, cancelled: cancelBenchmarkRequested });
    });
  });
}
