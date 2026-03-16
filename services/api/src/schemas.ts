import { z } from 'zod';
import { config } from './config.js';

function multipleOf16(label: string) {
  return z.preprocess(
    (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return value;
      }

      return Math.min(value, config.maxDimension);
    },
    z
      .number()
      .int()
      .min(64, `${label} must be at least 64`)
      .refine((n) => n % 16 === 0, `${label} must be a multiple of 16`)
  );
}

export const createJobSchema = z.object({
  mode: z.enum(['txt2img', 'img2img', 'multi-ref']).default('txt2img'),
  prompt: z.string().min(1, 'Prompt is required').max(4096),
  model: z.enum(['flux-klein-4b', 'flux-klein-base-4b', 'flux-klein-9b', 'flux-klein-base-9b', 'zimage-turbo-6b']).optional(),
  loraId: z.string().min(1).max(255).optional(),
  loraScale: z.number().min(0).max(2).optional(),
  width: multipleOf16('width').default(512),
  height: multipleOf16('height').default(512),
  seed: z.number().int().optional(),
  steps: z.number().int().min(1).max(100).optional(),
  guidance: z.number().min(0).max(30).optional(),
  inputPaths: z.array(z.string()).max(16).optional(),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;

export const estimateJobSchema = z.object({
  mode: z.enum(['txt2img', 'img2img', 'multi-ref']).default('txt2img'),
  model: z.enum(['flux-klein-4b', 'flux-klein-base-4b', 'flux-klein-9b', 'flux-klein-base-9b', 'zimage-turbo-6b']).optional(),
  width: multipleOf16('width').default(512),
  height: multipleOf16('height').default(512),
  hasLora: z.boolean().default(false),
  loraScale: z.number().min(0).max(2).optional(),
  steps: z.number().int().min(1).max(100).optional(),
  guidance: z.number().min(0).max(30).optional(),
  inputCount: z.number().int().min(0).max(16).default(0),
  quantity: z.number().int().min(1).max(200).default(1),
});

export type EstimateJobInput = z.infer<typeof estimateJobSchema>;

export const listJobsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const downloadJobsSchema = z.object({
  jobIds: z.array(z.string().uuid()).min(1).max(50),
});
