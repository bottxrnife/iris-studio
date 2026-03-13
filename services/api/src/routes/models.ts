import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  cancelModelDownload,
  ensureModelsRoot,
  getActiveDownloadModelId,
  isSupportedModelId,
  listModels,
  startModelDownload,
  type CancelMode,
} from '../models.js';

const downloadModelSchema = z.object({
  modelId: z.string().min(1),
  token: z.string().trim().min(1).optional(),
});

const cancelModelSchema = z.object({
  mode: z.enum(['pause', 'stop']).default('pause'),
});

export async function modelRoutes(app: FastifyInstance) {
  ensureModelsRoot();

  app.get('/api/models', async () => {
    const models = listModels();
    return {
      modelsDir: config.irisModelDir,
      activeDownloadModelId: getActiveDownloadModelId(),
      hasAnyInstalled: models.some((model) => model.installed),
      models,
    };
  });

  app.post('/api/models/download', async (req, reply) => {
    const parsed = downloadModelSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { modelId, token } = parsed.data;
    if (!isSupportedModelId(modelId)) {
      return reply.status(400).send({ error: 'Unsupported model' });
    }

    try {
      const download = startModelDownload(modelId, token);
      return reply.status(202).send({ modelId, download });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Model download could not be started';
      return reply.status(409).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/models/:id/cancel', async (req, reply) => {
    if (!isSupportedModelId(req.params.id)) {
      return reply.status(400).send({ error: 'Unsupported model' });
    }

    const parsed = cancelModelSchema.safeParse(req.body ?? {});
    const mode: CancelMode = parsed.success ? parsed.data.mode : 'pause';

    const cancelled = cancelModelDownload(req.params.id, mode);
    if (!cancelled) {
      return reply.status(409).send({ error: 'That model is not currently downloading' });
    }

    return reply.send({ ok: true });
  });
}
