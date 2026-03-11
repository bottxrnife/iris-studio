import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { jobRoutes } from './routes/jobs.js';
import { benchmarkRoutes } from './routes/benchmark.js';
import { uploadRoutes } from './routes/uploads.js';
import { restoreQueuedJobs } from './worker.js';
import { restoreBenchmarkRuns } from './benchmark.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
});

await app.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 16,
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
