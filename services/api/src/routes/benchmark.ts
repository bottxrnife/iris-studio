import type { FastifyInstance } from 'fastify';
import { getQueueSnapshot } from '../worker.js';
import { cancelBenchmarkRun, getCurrentBenchmarkRun, getLatestBenchmarkRun, getLatestUsableBenchmarkRun, isBenchmarkRunning, startBenchmarkRun } from '../benchmark.js';
import type { BenchmarkRunRow, BenchmarkSampleRow } from '../db.js';
import type { ProgressData } from '../iris-progress.js';

export async function benchmarkRoutes(app: FastifyInstance) {
  app.get('/api/benchmark', async () => {
    const currentRun = getCurrentBenchmarkRun();
    const latestRun = getLatestBenchmarkRun();
    const latestUsableRun = getLatestUsableBenchmarkRun();

    return {
      currentRun: currentRun ? formatBenchmarkRun(currentRun.row, currentRun.samples, currentRun.progress) : null,
      latestRun: latestRun ? formatBenchmarkRun(latestRun.row, latestRun.samples, latestRun.progress) : null,
      latestUsableRun: latestUsableRun ? formatBenchmarkRun(latestUsableRun.row, latestUsableRun.samples, latestUsableRun.progress) : null,
    };
  });

  app.post('/api/benchmark/run', async (req, reply) => {
    if (isBenchmarkRunning()) {
      const currentRun = getCurrentBenchmarkRun();
      return reply.status(409).send({
        error: 'Benchmark is already running',
        currentRun: currentRun ? formatBenchmarkRun(currentRun.row, currentRun.samples, currentRun.progress) : null,
      });
    }

    const queueSnapshot = getQueueSnapshot();
    if (queueSnapshot.activeJobId || queueSnapshot.queuedJobIds.length > 0) {
      return reply.status(409).send({ error: 'Benchmark requires an empty generation queue' });
    }

    const run = startBenchmarkRun();
    return reply.status(202).send(formatBenchmarkRun(run.row, run.samples, run.progress));
  });

  app.post('/api/benchmark/cancel', async (req, reply) => {
    const currentRun = getCurrentBenchmarkRun();
    if (!currentRun) {
      return reply.status(409).send({ error: 'No benchmark is currently running' });
    }

    const cancelled = cancelBenchmarkRun();
    if (!cancelled) {
      return reply.status(409).send({ error: 'Benchmark is no longer stoppable' });
    }

    return reply.send(formatBenchmarkRun(currentRun.row, currentRun.samples, currentRun.progress));
  });
}

function formatBenchmarkRun(row: BenchmarkRunRow, samples: BenchmarkSampleRow[], progress: ProgressData | null) {
  return {
    id: row.id,
    status: row.status,
    totalCases: row.total_cases,
    completedCases: row.completed_cases,
    currentCaseLabel: row.current_case_label,
    currentProgress: progress,
    error: row.error,
    startedAt: serializeUtcTimestamp(row.started_at),
    finishedAt: row.finished_at ? serializeUtcTimestamp(row.finished_at) : null,
    samples: samples.map((sample) => ({
      id: sample.id,
      mode: sample.mode,
      label: sample.label,
      width: sample.width,
      height: sample.height,
      inputCount: sample.input_count,
      durationMs: sample.duration_ms,
      createdAt: serializeUtcTimestamp(sample.created_at),
    })),
  };
}

function serializeUtcTimestamp(value: string) {
  const withTimeSeparator = value.includes('T') ? value : value.replace(' ', 'T');
  return withTimeSeparator.endsWith('Z') ? withTimeSeparator : `${withTimeSeparator}Z`;
}
