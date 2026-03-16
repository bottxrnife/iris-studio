import Database from 'better-sqlite3';
import { config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db: Database.Database = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    mode TEXT NOT NULL DEFAULT 'txt2img',
    prompt TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    seed INTEGER,
    model TEXT NOT NULL,
    lora_id TEXT,
    lora_name TEXT,
    lora_scale REAL,
    steps INTEGER,
    guidance REAL,
    input_paths TEXT,
    output_path TEXT,
    thumb_path TEXT,
    duration_ms INTEGER,
    iris_stderr TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

  CREATE TABLE IF NOT EXISTS benchmark_runs (
    id TEXT PRIMARY KEY,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    total_cases INTEGER NOT NULL,
    completed_cases INTEGER NOT NULL DEFAULT 0,
    current_case_label TEXT,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS benchmark_samples (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    label TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    input_count INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(run_id) REFERENCES benchmark_runs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_benchmark_runs_started_at ON benchmark_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status ON benchmark_runs(status);
  CREATE INDEX IF NOT EXISTS idx_benchmark_samples_run_id ON benchmark_samples(run_id, created_at ASC);
`);

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

ensureColumn('jobs', 'lora_id', 'lora_id TEXT');
ensureColumn('jobs', 'lora_name', 'lora_name TEXT');
ensureColumn('jobs', 'lora_scale', 'lora_scale REAL');
ensureColumn('benchmark_runs', 'model', 'model TEXT');

export interface JobRow {
  id: string;
  status: string;
  mode: string;
  prompt: string;
  width: number;
  height: number;
  seed: number | null;
  model: string;
  lora_id: string | null;
  lora_name: string | null;
  lora_scale: number | null;
  steps: number | null;
  guidance: number | null;
  input_paths: string | null;
  output_path: string | null;
  thumb_path: string | null;
  duration_ms: number | null;
  iris_stderr: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface BenchmarkRunRow {
  id: string;
  model: string | null;
  status: string;
  total_cases: number;
  completed_cases: number;
  current_case_label: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface BenchmarkSampleRow {
  id: string;
  run_id: string;
  mode: string;
  label: string;
  width: number;
  height: number;
  input_count: number;
  duration_ms: number;
  created_at: string;
}

interface JobStatements {
  insertJob: Database.Statement<[string, string, string, number, number, string, string | null, string | null, number | null, number | null, number | null, string | null]>;
  getJob: Database.Statement<[string], JobRow>;
  listJobs: Database.Statement<[number, number], JobRow>;
  listRecoverableJobs: Database.Statement<[], JobRow>;
  listRecentCompletedTimingSamples: Database.Statement<[number], {
    mode: string;
    model: string;
    width: number;
    height: number;
    lora_id: string | null;
    lora_scale: number | null;
    steps: number | null;
    guidance: number | null;
    input_paths: string | null;
    duration_ms: number;
  }>;
  listRecentCompletedTimingSamplesByModel: Database.Statement<[string, number], {
    mode: string;
    model: string;
    width: number;
    height: number;
    lora_id: string | null;
    lora_scale: number | null;
    steps: number | null;
    guidance: number | null;
    input_paths: string | null;
    duration_ms: number;
  }>;
  countJobs: Database.Statement<[], { count: number }>;
  deleteJob: Database.Statement<[string]>;
  updateJobStatus: Database.Statement<[string, string]>;
  updateJobResult: Database.Statement<[string, number | null, string | null, string | null, number | null, string | null, string | null, string]>;
  insertBenchmarkRun: Database.Statement<[string, string, number, string | null]>;
  getBenchmarkRun: Database.Statement<[string], BenchmarkRunRow>;
  getRunningBenchmarkRun: Database.Statement<[], BenchmarkRunRow>;
  getLatestBenchmarkRun: Database.Statement<[], BenchmarkRunRow>;
  getLatestFinishedBenchmarkRun: Database.Statement<[], BenchmarkRunRow>;
  getLatestFinishedBenchmarkRunWithSamples: Database.Statement<[], BenchmarkRunRow>;
  getLatestFinishedBenchmarkRunByModel: Database.Statement<[string], BenchmarkRunRow>;
  getLatestFinishedBenchmarkRunWithSamplesByModel: Database.Statement<[string], BenchmarkRunRow>;
  getLatestCompletedBenchmarkRun: Database.Statement<[], BenchmarkRunRow>;
  listBenchmarkSamplesByRun: Database.Statement<[string], BenchmarkSampleRow>;
  listLatestBenchmarkTimingSamples: Database.Statement<[string, number], {
    mode: string;
    width: number;
    height: number;
    input_count: number;
    duration_ms: number;
  }>;
  insertBenchmarkSample: Database.Statement<[string, string, string, string, number, number, number, number]>;
  updateBenchmarkRunProgress: Database.Statement<[number, string | null, string]>;
  finishBenchmarkRun: Database.Statement<[string]>;
  failBenchmarkRun: Database.Statement<[string, string, string]>;
  failInterruptedBenchmarkRuns: Database.Statement<[string]>;
}

export const queries: JobStatements = {
  insertJob: db.prepare<[string, string, string, number, number, string, string | null, string | null, number | null, number | null, number | null, string | null]>(
    `INSERT INTO jobs (id, mode, prompt, width, height, model, lora_id, lora_name, lora_scale, steps, guidance, input_paths)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),

  getJob: db.prepare<[string], JobRow>(
    `SELECT * FROM jobs WHERE id = ?`
  ),

  listJobs: db.prepare<[number, number], JobRow>(
    `SELECT *
     FROM jobs
     ORDER BY
       CASE
         WHEN status IN ('running', 'saving') THEN 0
         WHEN status = 'queued' THEN 1
         ELSE 2
       END ASC,
       CASE WHEN status IN ('running', 'saving') THEN updated_at END DESC,
       CASE WHEN status = 'queued' THEN created_at END ASC,
       CASE WHEN status NOT IN ('running', 'saving', 'queued') THEN created_at END DESC
     LIMIT ? OFFSET ?`
  ),

  listRecoverableJobs: db.prepare<[], JobRow>(
    `SELECT * FROM jobs
     WHERE status IN ('queued', 'running', 'saving')
     ORDER BY created_at ASC`
  ),

  listRecentCompletedTimingSamples: db.prepare<[number], {
    mode: string;
    model: string;
    width: number;
    height: number;
    lora_id: string | null;
    lora_scale: number | null;
    steps: number | null;
    guidance: number | null;
    input_paths: string | null;
    duration_ms: number;
  }>(
    `SELECT mode, model, width, height, lora_id, lora_scale, steps, guidance, input_paths, duration_ms
     FROM jobs
     WHERE status = 'done'
       AND duration_ms IS NOT NULL
       AND width > 0
       AND height > 0
     ORDER BY updated_at DESC
     LIMIT ?`
  ),

  listRecentCompletedTimingSamplesByModel: db.prepare<[string, number], {
    mode: string;
    model: string;
    width: number;
    height: number;
    lora_id: string | null;
    lora_scale: number | null;
    steps: number | null;
    guidance: number | null;
    input_paths: string | null;
    duration_ms: number;
  }>(
    `SELECT mode, model, width, height, lora_id, lora_scale, steps, guidance, input_paths, duration_ms
     FROM jobs
     WHERE status = 'done'
       AND duration_ms IS NOT NULL
       AND width > 0
       AND height > 0
       AND model = ?
     ORDER BY updated_at DESC
     LIMIT ?`
  ),

  countJobs: db.prepare<[], { count: number }>(
    `SELECT COUNT(*) as count FROM jobs`
  ),

  deleteJob: db.prepare<[string]>(
    `DELETE FROM jobs WHERE id = ?`
  ),

  updateJobStatus: db.prepare<[string, string]>(
    `UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ),

  updateJobResult: db.prepare<[string, number | null, string | null, string | null, number | null, string | null, string | null, string]>(
    `UPDATE jobs SET
       status = ?,
       seed = ?,
       output_path = ?,
       thumb_path = ?,
       duration_ms = ?,
       iris_stderr = ?,
       metadata = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ),

  insertBenchmarkRun: db.prepare<[string, string, number, string | null]>(
    `INSERT INTO benchmark_runs (id, model, total_cases, current_case_label)
     VALUES (?, ?, ?, ?)`
  ),

  getBenchmarkRun: db.prepare<[string], BenchmarkRunRow>(
    `SELECT * FROM benchmark_runs WHERE id = ?`
  ),

  getRunningBenchmarkRun: db.prepare<[], BenchmarkRunRow>(
    `SELECT * FROM benchmark_runs
     WHERE status = 'running'
     ORDER BY started_at DESC
     LIMIT 1`
  ),

  getLatestBenchmarkRun: db.prepare<[], BenchmarkRunRow>(
    `SELECT * FROM benchmark_runs
     ORDER BY started_at DESC
     LIMIT 1`
  ),

  getLatestFinishedBenchmarkRun: db.prepare<[], BenchmarkRunRow>(
    `SELECT * FROM benchmark_runs
     WHERE status != 'running'
     ORDER BY COALESCE(finished_at, started_at) DESC, started_at DESC
     LIMIT 1`
  ),

  getLatestFinishedBenchmarkRunWithSamples: db.prepare<[], BenchmarkRunRow>(
    `SELECT r.*
     FROM benchmark_runs r
     WHERE r.status != 'running'
       AND EXISTS (
         SELECT 1
         FROM benchmark_samples s
         WHERE s.run_id = r.id
       )
     ORDER BY COALESCE(r.finished_at, r.started_at) DESC, r.started_at DESC
     LIMIT 1`
  ),

  getLatestFinishedBenchmarkRunByModel: db.prepare<[string], BenchmarkRunRow>(
    `SELECT *
     FROM benchmark_runs
     WHERE status != 'running'
       AND model = ?
     ORDER BY COALESCE(finished_at, started_at) DESC, started_at DESC
     LIMIT 1`
  ),

  getLatestFinishedBenchmarkRunWithSamplesByModel: db.prepare<[string], BenchmarkRunRow>(
    `SELECT r.*
     FROM benchmark_runs r
     WHERE r.status != 'running'
       AND r.model = ?
       AND EXISTS (
         SELECT 1
         FROM benchmark_samples s
         WHERE s.run_id = r.id
       )
     ORDER BY COALESCE(r.finished_at, r.started_at) DESC, r.started_at DESC
     LIMIT 1`
  ),

  getLatestCompletedBenchmarkRun: db.prepare<[], BenchmarkRunRow>(
    `SELECT * FROM benchmark_runs
     WHERE status = 'done'
     ORDER BY finished_at DESC, started_at DESC
     LIMIT 1`
  ),

  listBenchmarkSamplesByRun: db.prepare<[string], BenchmarkSampleRow>(
    `SELECT * FROM benchmark_samples
     WHERE run_id = ?
     ORDER BY created_at ASC`
  ),

  listLatestBenchmarkTimingSamples: db.prepare<[string, number], {
    mode: string;
    width: number;
    height: number;
    input_count: number;
    duration_ms: number;
  }>(
    `WITH ranked_samples AS (
       SELECT
         s.mode,
         s.width,
         s.height,
         s.input_count,
         s.duration_ms,
         ROW_NUMBER() OVER (
           PARTITION BY s.mode, s.width, s.height, s.input_count
           ORDER BY COALESCE(r.finished_at, r.started_at) DESC, s.created_at DESC
         ) AS sample_rank
       FROM benchmark_samples s
       JOIN benchmark_runs r ON r.id = s.run_id
       WHERE r.status IN ('done', 'cancelled')
         AND r.model = ?
     )
     SELECT mode, width, height, input_count, duration_ms
     FROM ranked_samples
     WHERE sample_rank = 1
     ORDER BY mode ASC, width * height ASC, height ASC
     LIMIT ?`
  ),

  insertBenchmarkSample: db.prepare<[string, string, string, string, number, number, number, number]>(
    `INSERT INTO benchmark_samples (id, run_id, mode, label, width, height, input_count, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),

  updateBenchmarkRunProgress: db.prepare<[number, string | null, string]>(
    `UPDATE benchmark_runs
     SET completed_cases = ?,
         current_case_label = ?
     WHERE id = ?`
  ),

  finishBenchmarkRun: db.prepare<[string]>(
    `UPDATE benchmark_runs
     SET status = 'done',
         completed_cases = total_cases,
         current_case_label = NULL,
         finished_at = datetime('now')
     WHERE id = ?`
  ),

  failBenchmarkRun: db.prepare<[string, string, string]>(
    `UPDATE benchmark_runs
     SET status = ?,
         error = ?,
         current_case_label = NULL,
         finished_at = datetime('now')
     WHERE id = ?`
  ),

  failInterruptedBenchmarkRuns: db.prepare<[string]>(
    `UPDATE benchmark_runs
     SET status = 'failed',
         error = ?,
         current_case_label = NULL,
         finished_at = datetime('now')
     WHERE status = 'running'`
  ),
};

export { db };
