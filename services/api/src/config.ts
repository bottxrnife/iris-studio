import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadDotenv({ path: path.resolve(__dirname, '../../../.env') });
loadDotenv({ path: path.resolve(__dirname, '../../../.env.local') });

const ROOT = path.resolve(__dirname, '../../..');

export const config = {
  port: parseInt(process.env.PORT ?? '8787', 10),
  host: process.env.HOST ?? '127.0.0.1',

  irisBin: process.env.IRIS_BIN ?? path.join(ROOT, 'vendor/iris.c/iris'),
  irisModelDir: process.env.IRIS_MODEL_DIR ?? path.join(ROOT, 'Models'),
  irisLoraDir: process.env.IRIS_LORA_DIR ?? path.join(ROOT, 'Loras'),

  outputDir: process.env.IRIS_OUTPUT_DIR ?? path.join(ROOT, 'storage/outputs'),
  uploadDir: process.env.IRIS_UPLOAD_DIR ?? path.join(ROOT, 'storage/uploads'),
  thumbDir: process.env.IRIS_THUMB_DIR ?? path.join(ROOT, 'storage/thumbs'),
  dbPath: process.env.IRIS_DB_PATH ?? path.join(ROOT, 'storage/app.db'),

  defaultModel: 'flux-klein-9b',
  maxDimension: 1792,
  thumbSize: 256,
} as const;
