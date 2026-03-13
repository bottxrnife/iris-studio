import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSupportedModel, type ModelId } from './models.js';

export type LoraFormat = 'fal-ai' | 'comfyui' | 'unknown';
export type LoraFormatConfidence = 'metadata' | 'heuristic' | 'manual' | 'unknown';
export type LoraTensorDtype = 'bf16' | 'f16' | 'f32' | 'other' | 'mixed' | 'unknown';

export interface LoraOverride {
  format: Exclude<LoraFormat, 'unknown'> | null;
  modelId: ModelId | null;
}

export interface LoraInfo {
  id: string;
  filename: string;
  localPath: string;
  sizeBytes: number;
  manualFormat: Exclude<LoraFormat, 'unknown'> | null;
  manualModelId: ModelId | null;
  format: LoraFormat;
  formatConfidence: LoraFormatConfidence;
  tensorDtype: LoraTensorDtype;
  tensorCount: number;
  triggerPhrases: string[];
  baseModelHint: string | null;
  detectedBaseModelId: ModelId | null;
  compatibleModelIds: ModelId[];
  fileReady: boolean;
  fileReadyReason: string;
  runtimeReady: boolean;
  runtimeReadyReason: string;
  issues: string[];
}

interface SafetensorsTensorEntry {
  dtype?: string;
  shape?: number[];
  data_offsets?: [number, number];
}

interface SafetensorsHeader {
  __metadata__?: Record<string, unknown>;
  [key: string]: SafetensorsTensorEntry | Record<string, unknown> | undefined;
}

const LORAS_README_PATH = path.join(config.irisLoraDir, 'README.md');
const LORA_OVERRIDES_PATH = path.join(config.irisLoraDir, '.iris-lora-overrides.json');
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const RUNTIME_READY_REASON = 'Ready for native local FLUX generation.';
const RUNTIME_BLOCK_REASON = 'This LoRA is cataloged, but it is not ready for native local FLUX generation.';

const SUPPORTED_MODEL_PATTERNS: Array<{ id: ModelId; tokens: string[] }> = [
  { id: 'flux-klein-base-9b', tokens: ['flux', 'klein', 'base', '9b'] },
  { id: 'flux-klein-9b', tokens: ['flux', 'klein', '9b'] },
  { id: 'flux-klein-base-4b', tokens: ['flux', 'klein', 'base', '4b'] },
  { id: 'flux-klein-4b', tokens: ['flux', 'klein', '4b'] },
];

interface SerializedLoraOverrides {
  version: 1;
  overrides: Record<string, LoraOverride>;
}

function isRuntimeSupportedTensorDtype(dtype: LoraTensorDtype) {
  return dtype === 'bf16' || dtype === 'f16' || dtype === 'f32';
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeMetadataValue(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 0 ? serialized : null;
  } catch {
    return null;
  }
}

function readSafetensorsHeader(filePath: string): SafetensorsHeader {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');

  try {
    const lengthBuffer = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, lengthBuffer, 0, 8, 0);
    if (bytesRead !== 8) {
      throw new Error('Invalid safetensors header');
    }

    const headerLengthBigInt = lengthBuffer.readBigUInt64LE(0);
    if (headerLengthBigInt > BigInt(MAX_HEADER_BYTES)) {
      throw new Error('Safetensors metadata header is too large');
    }

    const headerLength = Number(headerLengthBigInt);
    if (headerLength <= 0 || headerLength > stat.size - 8) {
      throw new Error('Safetensors metadata header length is invalid');
    }

    const headerBuffer = Buffer.alloc(headerLength);
    const headerBytesRead = fs.readSync(fd, headerBuffer, 0, headerLength, 8);
    if (headerBytesRead !== headerLength) {
      throw new Error('Could not read safetensors metadata header');
    }

    return JSON.parse(headerBuffer.toString('utf8')) as SafetensorsHeader;
  } finally {
    fs.closeSync(fd);
  }
}

function detectTensorDtype(dtypes: string[]) {
  const normalized = Array.from(new Set(dtypes.map((dtype) => dtype.toLowerCase())));
  if (normalized.length === 0) {
    return 'unknown' as const;
  }

  if (normalized.length > 1) {
    return 'mixed' as const;
  }

  switch (normalized[0]) {
    case 'bf16':
      return 'bf16' as const;
    case 'f16':
    case 'float16':
      return 'f16' as const;
    case 'f32':
    case 'float32':
      return 'f32' as const;
    default:
      return 'other' as const;
  }
}

function looksLikeLoraTensorKey(key: string) {
  const normalized = key.toLowerCase();
  return normalized.includes('lora')
    || normalized.includes('adapter')
    || normalized.endsWith('lora_a.weight')
    || normalized.endsWith('lora_b.weight')
    || normalized.endsWith('lora_up.weight')
    || normalized.endsWith('lora_down.weight');
}

function extractTriggerPhrases(metadata: Record<string, unknown>) {
  const triggerKeys = ['trigger_word', 'trigger_words', 'activation_text', 'instance_prompt', 'recommended_tags'];
  const results = new Set<string>();

  for (const key of triggerKeys) {
    const value = metadata[key];
    if (typeof value === 'string') {
      for (const part of value.split(/[,|\n]/)) {
        const trimmed = part.trim();
        if (trimmed) {
          results.add(trimmed);
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          results.add(item.trim());
        }
      }
    }
  }

  return Array.from(results).slice(0, 12);
}

function detectFormat(
  metadata: Record<string, unknown>,
  tensorKeys: string[],
  tensorDtype: LoraTensorDtype,
  filename: string
): { format: LoraFormat; confidence: LoraFormatConfidence } {
  const metadataKeys = Object.keys(metadata).map((key) => key.toLowerCase());
  const metadataValues = Object.values(metadata)
    .map((value) => normalizeMetadataValue(value)?.toLowerCase() ?? '')
    .filter(Boolean);
  const normalizedFilename = filename.toLowerCase();

  if (metadataKeys.some((key) => key.startsWith('ss_'))) {
    return { format: 'comfyui', confidence: 'metadata' };
  }

  if (
    metadataKeys.some((key) => key.includes('fal'))
    || metadataValues.some((value) => value.includes('fal.ai') || value.includes('fal-ai'))
    || normalizedFilename.includes('fal')
  ) {
    return { format: 'fal-ai', confidence: 'metadata' };
  }

    if (isRuntimeSupportedTensorDtype(tensorDtype) && tensorKeys.some((key) => looksLikeLoraTensorKey(key))) {
      return { format: 'fal-ai', confidence: 'heuristic' };
    }

  return { format: 'unknown', confidence: 'unknown' };
}

function detectBaseModelId(metadata: Record<string, unknown>, filename: string) {
  const candidateValues = [
    metadata.ss_base_model_version,
    metadata.ss_sd_model_name,
    metadata.base_model,
    metadata.base,
    metadata.trained_on_model,
    metadata.source_model,
    metadata.source_model_name,
    metadata.model,
    metadata.model_name,
    filename,
  ];

  const normalizedCandidates = candidateValues
    .map((value) => normalizeMetadataValue(value))
    .filter((value): value is string => value != null);

  for (const rawValue of normalizedCandidates) {
    const searchValue = normalizeSearchText(rawValue);
    for (const pattern of SUPPORTED_MODEL_PATTERNS) {
      if (pattern.tokens.every((token) => searchValue.includes(token))) {
        return {
          baseModelHint: rawValue,
          detectedBaseModelId: pattern.id,
          compatibleModelIds: [pattern.id],
        };
      }
    }
  }

  const firstHint = normalizedCandidates[0] ?? null;
  return {
    baseModelHint: firstHint,
    detectedBaseModelId: null,
    compatibleModelIds: [],
  };
}

function inspectLoraFile(filePath: string): LoraInfo {
  return inspectLoraFileWithOverride(filePath, null);
}

function loadLoraOverrides(): Record<string, LoraOverride> {
  ensureLorasRoot();

  try {
    const raw = fs.readFileSync(LORA_OVERRIDES_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SerializedLoraOverrides>;
    if (parsed.version !== 1 || typeof parsed.overrides !== 'object' || parsed.overrides == null) {
      return {};
    }

    const result: Record<string, LoraOverride> = {};
    for (const [id, entry] of Object.entries(parsed.overrides)) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const format = entry.format === 'fal-ai' || entry.format === 'comfyui' ? entry.format : null;
      const modelId = SUPPORTED_MODEL_PATTERNS.some((pattern) => pattern.id === entry.modelId) ? entry.modelId : null;
      if (!format && !modelId) {
        continue;
      }

      result[path.basename(id)] = { format, modelId };
    }

    return result;
  } catch {
    return {};
  }
}

function saveLoraOverrides(overrides: Record<string, LoraOverride>) {
  ensureLorasRoot();

  const normalizedOverrides = Object.fromEntries(
    Object.entries(overrides)
      .filter(([, entry]) => entry.format != null || entry.modelId != null)
      .map(([id, entry]) => [
        path.basename(id),
        {
          format: entry.format,
          modelId: entry.modelId,
        } satisfies LoraOverride,
      ])
  );

  const payload: SerializedLoraOverrides = {
    version: 1,
    overrides: normalizedOverrides,
  };

  fs.writeFileSync(LORA_OVERRIDES_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function inspectLoraFileWithOverride(filePath: string, override: LoraOverride | null): LoraInfo {
  const filename = path.basename(filePath);
  const stat = fs.statSync(filePath);
  const issues: string[] = [];
  const manualFormat = override?.format ?? null;
  const manualModelId = override?.modelId ?? null;

  if (!stat.isFile()) {
    return {
      id: filename,
      filename,
      localPath: filePath,
      sizeBytes: 0,
      manualFormat,
      manualModelId,
      format: 'unknown',
      formatConfidence: 'unknown',
      tensorDtype: 'unknown',
      tensorCount: 0,
      triggerPhrases: [],
      baseModelHint: null,
      detectedBaseModelId: null,
      compatibleModelIds: [],
      fileReady: false,
      fileReadyReason: 'Only .safetensors files are supported.',
      runtimeReady: false,
      runtimeReadyReason: RUNTIME_BLOCK_REASON,
      issues: ['Not a regular file'],
    };
  }

  if (path.extname(filename).toLowerCase() !== '.safetensors') {
    return {
      id: filename,
      filename,
      localPath: filePath,
      sizeBytes: stat.size,
      manualFormat,
      manualModelId,
      format: 'unknown',
      formatConfidence: 'unknown',
      tensorDtype: 'unknown',
      tensorCount: 0,
      triggerPhrases: [],
      baseModelHint: null,
      detectedBaseModelId: null,
      compatibleModelIds: [],
      fileReady: false,
      fileReadyReason: 'Only .safetensors LoRAs are recognized.',
      runtimeReady: false,
      runtimeReadyReason: RUNTIME_BLOCK_REASON,
      issues: ['File extension is not .safetensors'],
    };
  }

  try {
    const header = readSafetensorsHeader(filePath);
    const metadata = header.__metadata__ ?? {};
    const tensorEntries = Object.entries(header)
      .filter(([key]) => key !== '__metadata__')
      .map(([key, value]) => ({
        key,
        value: (value ?? {}) as SafetensorsTensorEntry,
      }));

    const tensorDtype = detectTensorDtype(
      tensorEntries
        .map((entry) => entry.value.dtype)
        .filter((dtype): dtype is string => typeof dtype === 'string')
    );
    const tensorKeys = tensorEntries.map((entry) => entry.key);
    const loraLike = tensorKeys.some((key) => looksLikeLoraTensorKey(key));

    if (!loraLike) {
      issues.push('The tensor names do not look like a LoRA adapter.');
    }

    const { format, confidence } = detectFormat(metadata, tensorKeys, tensorDtype, filename);
    const autoDetection = detectBaseModelId(metadata, filename);
    const effectiveFormat = manualFormat ?? format;
    const effectiveFormatConfidence = manualFormat ? 'manual' as const : confidence;
    const effectiveCompatibleModelIds = manualModelId
      ? [manualModelId]
      : autoDetection.compatibleModelIds;
    const effectiveBaseModelHint = manualModelId
      ? getSupportedModel(manualModelId)?.label ?? manualModelId
      : autoDetection.baseModelHint;
    const triggerPhrases = extractTriggerPhrases(metadata);

    let fileReady = true;
    let fileReadyReason = 'Compatible LoRA file detected.';

    if (!loraLike) {
      fileReady = false;
      fileReadyReason = 'The file does not look like a LoRA adapter.';
    } else if (effectiveFormat !== 'fal-ai') {
      fileReady = false;
      fileReadyReason = effectiveFormat === 'comfyui'
        ? 'ComfyUI-style LoRAs are cataloged, but the app currently targets fal.ai-style FLUX LoRAs.'
        : 'The LoRA format could not be identified as fal.ai-compatible.';
    } else if (!isRuntimeSupportedTensorDtype(tensorDtype)) {
      fileReady = false;
      fileReadyReason = 'This LoRA does not use a supported floating-point tensor format.';
    } else if (effectiveCompatibleModelIds.length === 0) {
      fileReady = false;
      fileReadyReason = 'The trained base model could not be matched to an installed Iris model family.';
    }

    if (format === 'unknown') {
      issues.push('Format could not be identified from metadata.');
    }
    if (!isRuntimeSupportedTensorDtype(tensorDtype)) {
      issues.push(`Primary tensor dtype detected as ${tensorDtype}.`);
    }
    if (!autoDetection.baseModelHint) {
      issues.push('Base model metadata was not found.');
    }

    const runtimeReady = fileReady;
    const runtimeReadyReason = runtimeReady ? RUNTIME_READY_REASON : fileReadyReason;

    return {
      id: filename,
      filename,
      localPath: filePath,
      sizeBytes: stat.size,
      manualFormat,
      manualModelId,
      format: effectiveFormat,
      formatConfidence: effectiveFormatConfidence,
      tensorDtype,
      tensorCount: tensorEntries.length,
      triggerPhrases,
      baseModelHint: effectiveBaseModelHint,
      detectedBaseModelId: autoDetection.detectedBaseModelId,
      compatibleModelIds: effectiveCompatibleModelIds,
      fileReady,
      fileReadyReason,
      runtimeReady,
      runtimeReadyReason,
      issues,
    };
  } catch (error) {
    return {
      id: filename,
      filename,
      localPath: filePath,
      sizeBytes: stat.size,
      manualFormat,
      manualModelId,
      format: 'unknown',
      formatConfidence: 'unknown',
      tensorDtype: 'unknown',
      tensorCount: 0,
      triggerPhrases: [],
      baseModelHint: null,
      detectedBaseModelId: null,
      compatibleModelIds: [],
      fileReady: false,
      fileReadyReason: 'The file could not be read as safetensors metadata.',
      runtimeReady: false,
      runtimeReadyReason: RUNTIME_BLOCK_REASON,
      issues: [error instanceof Error ? error.message : 'Could not read safetensors header'],
    };
  }
}

export function ensureLorasRoot() {
  fs.mkdirSync(config.irisLoraDir, { recursive: true });
  if (!fs.existsSync(LORAS_README_PATH)) {
    fs.writeFileSync(
      LORAS_README_PATH,
      [
        '# Loras Folder',
        '',
        'Place `.safetensors` LoRA files here.',
        '',
        'Iris Studio scans this folder and inspects safetensors metadata to classify format and model compatibility.',
      ].join('\n')
    );
  }
}

export function listLoras(): LoraInfo[] {
  ensureLorasRoot();
  const overrides = loadLoraOverrides();

  return fs.readdirSync(config.irisLoraDir)
    .filter((entry) => entry !== 'README.md' && entry !== path.basename(LORA_OVERRIDES_PATH) && !entry.startsWith('.'))
    .map((entry) => path.join(config.irisLoraDir, entry))
    .filter((entryPath) => {
      try {
        return fs.statSync(entryPath).isFile();
      } catch {
        return false;
      }
    })
    .map((entryPath) => inspectLoraFileWithOverride(entryPath, overrides[path.basename(entryPath)] ?? null))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

export function getLoraById(id: string) {
  return listLoras().find((lora) => lora.id === id) ?? null;
}

function sanitizeFilename(filename: string) {
  const parsed = path.parse(filename);
  const safeName = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'lora';
  const safeExt = (parsed.ext || '.safetensors').toLowerCase();
  return `${safeName}${safeExt}`;
}

export function resolveUploadTargetPath(filename: string) {
  ensureLorasRoot();

  const sanitized = sanitizeFilename(path.basename(filename));
  const parsed = path.parse(sanitized);

  let candidate = path.join(config.irisLoraDir, sanitized);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(config.irisLoraDir, `${parsed.name}-${suffix}${parsed.ext || '.safetensors'}`);
    suffix += 1;
  }

  return candidate;
}

export function deleteLora(id: string) {
  ensureLorasRoot();
  const targetPath = path.join(config.irisLoraDir, path.basename(id));

  try {
    if (!fs.statSync(targetPath).isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  fs.rmSync(targetPath, { force: true });
  const overrides = loadLoraOverrides();
  delete overrides[path.basename(id)];
  saveLoraOverrides(overrides);
  return true;
}

export function setLoraOverride(id: string, override: LoraOverride) {
  ensureLorasRoot();
  const fileId = path.basename(id);
  const targetPath = path.join(config.irisLoraDir, fileId);

  try {
    if (!fs.statSync(targetPath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const overrides = loadLoraOverrides();
  overrides[fileId] = {
    format: override.format ?? null,
    modelId: override.modelId ?? null,
  };
  saveLoraOverrides(overrides);
  return getLoraById(fileId);
}

export function getLoraRuntimeSupport() {
  return {
    canApplyDuringGeneration: true,
    reason: 'One fal.ai-style FLUX LoRA can be applied during generation.',
  };
}
