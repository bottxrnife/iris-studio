import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

export async function uploadRoutes(app: FastifyInstance) {
  // Upload reference image(s)
  app.post('/api/uploads', async (req, reply) => {
    const parts = req.parts();
    const uploaded: string[] = [];

    for await (const part of parts) {
      if (part.type === 'file') {
        const ext = path.extname(part.filename || '.png') || '.png';
        const filename = `${randomUUID()}${ext}`;
        const destPath = path.join(config.uploadDir, filename);

        fs.mkdirSync(config.uploadDir, { recursive: true });
        await pipeline(part.file, fs.createWriteStream(destPath));

        uploaded.push(filename);
      }
    }

    if (uploaded.length === 0) {
      return reply.status(400).send({ error: 'No files uploaded' });
    }

    return reply.send({ files: uploaded });
  });
}
