import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { config } from './config.js';
import { jobRoutes } from './routes/jobs.js';
import { benchmarkRoutes } from './routes/benchmark.js';
import { modelRoutes } from './routes/models.js';
import { loraRoutes } from './routes/loras.js';
import { uploadRoutes } from './routes/uploads.js';
import { restoreQueuedJobs } from './worker.js';
import { restoreBenchmarkRuns } from './benchmark.js';

// Ensure storage directories exist before registering static file plugins.
// On a fresh clone these directories are gitignored and won't exist yet.
fs.mkdirSync(config.outputDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.thumbDir, { recursive: true });

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
});

await app.register(multipart, {
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // Allow local LoRA uploads as streamed safetensors files.
    files: 32,
  },
});

// Serve output images
await app.register(fastifyStatic, {
  root: config.outputDir,
  prefix: '/api/images/outputs/',
  decorateReply: false,
});

// Serve thumbnails
await app.register(fastifyStatic, {
  root: config.thumbDir,
  prefix: '/api/images/thumbs/',
  decorateReply: false,
});

// Serve uploaded images
await app.register(fastifyStatic, {
  root: config.uploadDir,
  prefix: '/api/images/uploads/',
  decorateReply: false,
});

await app.register(jobRoutes);
await app.register(benchmarkRoutes);
await app.register(modelRoutes);
await app.register(loraRoutes);
await app.register(uploadRoutes);

restoreQueuedJobs();
restoreBenchmarkRuns();

app.get('/api/health', async () => {
  return { status: 'ok', model: config.defaultModel };
});

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`[iris-api] listening on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
