import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { config } from '../config.js';
import {
  deleteLora,
  ensureLorasRoot,
  getLoraRuntimeSupport,
  listLoras,
  resolveUploadTargetPath,
  setLoraOverride,
} from '../loras.js';
import { isSupportedModelId } from '../models.js';

const updateLoraOverrideSchema = z.object({
  format: z.enum(['fal-ai', 'comfyui']).nullable().optional(),
  modelId: z.enum(['flux-klein-4b', 'flux-klein-base-4b', 'flux-klein-9b', 'flux-klein-base-9b']).nullable().optional(),
});

export async function loraRoutes(app: FastifyInstance) {
  ensureLorasRoot();

  app.get('/api/loras', async () => {
    return {
      lorasDir: config.irisLoraDir,
      runtimeSupport: getLoraRuntimeSupport(),
      loras: listLoras(),
    };
  });

  app.post('/api/loras/upload', async (req, reply) => {
    const parts = req.parts();
    const uploadedIds: string[] = [];

    for await (const part of parts) {
      if (part.type !== 'file') {
        continue;
      }

      const originalFilename = part.filename ?? 'lora.safetensors';
      if (!originalFilename.toLowerCase().endsWith('.safetensors')) {
        return reply.status(400).send({ error: 'Only .safetensors LoRA files can be uploaded.' });
      }

      const targetPath = resolveUploadTargetPath(originalFilename);
      await pipeline(part.file, fs.createWriteStream(targetPath));
      uploadedIds.push(path.basename(targetPath));
    }

    if (uploadedIds.length === 0) {
      return reply.status(400).send({ error: 'No LoRA files were uploaded.' });
    }

    const loras = listLoras().filter((lora) => uploadedIds.includes(lora.id));
    return reply.status(201).send({ uploaded: loras });
  });

  app.delete<{ Params: { id: string } }>('/api/loras/:id', async (req, reply) => {
    const removed = deleteLora(req.params.id);
    if (!removed) {
      return reply.status(404).send({ error: 'LoRA not found' });
    }

    return reply.status(204).send();
  });

  app.patch<{ Params: { id: string } }>('/api/loras/:id', async (req, reply) => {
    const parsed = updateLoraOverrideSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const format = parsed.data.format ?? null;
    const modelId = parsed.data.modelId ?? null;
    if (modelId && !isSupportedModelId(modelId)) {
      return reply.status(400).send({ error: 'Unsupported model' });
    }

    const updated = setLoraOverride(req.params.id, { format, modelId });
    if (!updated) {
      return reply.status(404).send({ error: 'LoRA not found' });
    }

    return reply.send(updated);
  });
}
