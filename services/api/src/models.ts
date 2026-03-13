import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { config } from './config.js';

export type ModelId =
  | 'flux-klein-4b'
  | 'flux-klein-base-4b'
  | 'flux-klein-9b'
  | 'flux-klein-base-9b';

export type ModelLicense = 'apache-2.0' | 'flux-non-commercial';
export type LocalModelSource = 'directory';
export type ModelDownloadStatus = 'idle' | 'preparing' | 'downloading' | 'installing' | 'stopping' | 'done' | 'failed' | 'cancelled' | 'paused';
export type ModelInstallStatus = 'missing' | 'partial' | 'installed';
export type CancelMode = 'pause' | 'stop';

export interface SupportedModel {
  id: ModelId;
  label: string;
  summary: string;
  variant: 'distilled' | 'base';
  parameterSize: '4B' | '9B';
  repoId: string;
  huggingFaceUrl: string;
  recommendedSteps: number;
  recommendedGuidance: number | null;
  license: ModelLicense;
  gated: boolean;
  installDirName: string;
}

export interface ModelDownloadSnapshot {
  status: ModelDownloadStatus;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  error: string | null;
  progressPercent: number | null;
  speedMBps: number | null;
  etaSeconds: number | null;
  logLines: string[];
}

export interface ModelCatalogItem extends SupportedModel {
  installStatus: ModelInstallStatus;
  installed: boolean;
  localPath: string | null;
  localSource: LocalModelSource | null;
  missingComponents: string[];
  download: ModelDownloadSnapshot;
}

interface MutableDownloadState extends ModelDownloadSnapshot {
  process: ChildProcessByStdio<null, Readable, Readable> | null;
  tempDir: string | null;
  cancelRequested: boolean;
  cancelMode: CancelMode | null;
  lastProgressBytes: number | null;
  lastProgressAt: number | null;
}

const MODELS_README_PATH = path.join(config.irisModelDir, 'README.md');
const downloadStates = new Map<ModelId, MutableDownloadState>();
let activeDownloadModelId: ModelId | null = null;

export const SUPPORTED_MODELS: SupportedModel[] = [
  {
    id: 'flux-klein-4b',
    label: 'FLUX.2 [klein] 4B Distilled',
    summary: '4 steps, guidance 1.0, fastest setup and iteration.',
    variant: 'distilled',
    parameterSize: '4B',
    repoId: 'black-forest-labs/FLUX.2-klein-4B',
    huggingFaceUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B',
    recommendedSteps: 4,
    recommendedGuidance: 1,
    license: 'apache-2.0',
    gated: false,
    installDirName: 'flux-klein-4b-distilled',
  },
  {
    id: 'flux-klein-base-4b',
    label: 'FLUX.2 [klein] 4B Base',
    summary: 'CFG workflow with broader variety. Use 50 steps for max quality.',
    variant: 'base',
    parameterSize: '4B',
    repoId: 'black-forest-labs/FLUX.2-klein-base-4B',
    huggingFaceUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4B',
    recommendedSteps: 50,
    recommendedGuidance: null,
    license: 'apache-2.0',
    gated: false,
    installDirName: 'flux-klein-4b-base',
  },
  {
    id: 'flux-klein-9b',
    label: 'FLUX.2 [klein] 9B Distilled',
    summary: '4 steps with higher quality than 4B. Non-commercial license.',
    variant: 'distilled',
    parameterSize: '9B',
    repoId: 'black-forest-labs/FLUX.2-klein-9B',
    huggingFaceUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-9B',
    recommendedSteps: 4,
    recommendedGuidance: 1,
    license: 'flux-non-commercial',
    gated: true,
    installDirName: 'flux-klein-9b-distilled',
  },
  {
    id: 'flux-klein-base-9b',
    label: 'FLUX.2 [klein] 9B Base',
    summary: 'CFG workflow with the highest quality ceiling. Non-commercial license.',
    variant: 'base',
    parameterSize: '9B',
    repoId: 'black-forest-labs/FLUX.2-klein-base-9B',
    huggingFaceUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9B',
    recommendedSteps: 50,
    recommendedGuidance: null,
    license: 'flux-non-commercial',
    gated: true,
    installDirName: 'flux-klein-9b-base',
  },
] as const;

const supportedModelIds = new Set<ModelId>(SUPPORTED_MODELS.map((model) => model.id));

function getDefaultDownloadState(): MutableDownloadState {
  return {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    message: null,
    error: null,
    progressPercent: null,
    speedMBps: null,
    etaSeconds: null,
    logLines: [],
    process: null,
    tempDir: null,
    cancelRequested: false,
    cancelMode: null,
    lastProgressBytes: null,
    lastProgressAt: null,
  };
}

function getMutableDownloadState(modelId: ModelId) {
  const existing = downloadStates.get(modelId);
  if (existing) {
    return existing;
  }

  const next = getDefaultDownloadState();
  downloadStates.set(modelId, next);
  return next;
}

function toDownloadSnapshot(state: MutableDownloadState): ModelDownloadSnapshot {
  return {
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    message: state.message,
    error: state.error,
    progressPercent: state.progressPercent,
    speedMBps: state.speedMBps,
    etaSeconds: state.etaSeconds,
    logLines: state.logLines,
  };
}

function updateDownloadState(modelId: ModelId, patch: Partial<MutableDownloadState>) {
  const state = getMutableDownloadState(modelId);
  Object.assign(state, patch);
}

function serializeNow() {
  return new Date().toISOString();
}

export function ensureModelsRoot() {
  fs.mkdirSync(config.irisModelDir, { recursive: true });
  if (!fs.existsSync(MODELS_README_PATH)) {
    fs.writeFileSync(
      MODELS_README_PATH,
      [
        '# Models Folder',
        '',
        'Place supported FLUX model files or directories here.',
      ].join('\n')
    );
  }
}

function isNonEmptyDirectory(targetPath: string) {
  try {
    return fs.statSync(targetPath).isDirectory() && fs.readdirSync(targetPath).length > 0;
  } catch {
    return false;
  }
}

interface RequiredComponent {
  label: string;
  paths: string[];
}

const REQUIRED_MODEL_COMPONENTS: RequiredComponent[] = [
  { label: 'model index', paths: ['model_index.json'] },
  { label: 'transformer config', paths: ['transformer/config.json'] },
  {
    label: 'transformer weights',
    paths: [
      'transformer/diffusion_pytorch_model.safetensors',
      'transformer/diffusion_pytorch_model.safetensors.index.json',
    ],
  },
  { label: 'text encoder config', paths: ['text_encoder/config.json'] },
  {
    label: 'text encoder weights',
    paths: [
      'text_encoder/model.safetensors',
      'text_encoder/model.safetensors.index.json',
    ],
  },
  { label: 'tokenizer config', paths: ['tokenizer/tokenizer_config.json'] },
  { label: 'tokenizer data', paths: ['tokenizer/tokenizer.json'] },
  { label: 'VAE config', paths: ['vae/config.json'] },
  { label: 'VAE weights', paths: ['vae/diffusion_pytorch_model.safetensors'] },
];

function inspectModelFolder(targetPath: string) {
  const missingComponents = REQUIRED_MODEL_COMPONENTS
    .filter((component) => !component.paths.some((relativePath) => fs.existsSync(path.join(targetPath, relativePath))))
    .map((component) => component.label);

  return {
    installStatus: missingComponents.length === 0 ? 'installed' as const : 'partial' as const,
    missingComponents,
  };
}

function resolveInstalledModel(model: SupportedModel) {
  const installDirPath = path.join(config.irisModelDir, model.installDirName);
  if (!isNonEmptyDirectory(installDirPath)) {
    return {
      installStatus: 'missing' as const,
      installed: false,
      localPath: null,
      localSource: null,
      missingComponents: [],
    };
  }

  const inspection = inspectModelFolder(installDirPath);
  return {
    installStatus: inspection.installStatus,
    installed: inspection.installStatus === 'installed',
    localPath: installDirPath,
    localSource: 'directory' as const,
    missingComponents: inspection.missingComponents,
  };
}

export function getSupportedModel(modelId: string) {
  return SUPPORTED_MODELS.find((model) => model.id === modelId) ?? null;
}

export function isSupportedModelId(modelId: string): modelId is ModelId {
  return supportedModelIds.has(modelId as ModelId);
}

export function listModels(): ModelCatalogItem[] {
  ensureModelsRoot();

  return SUPPORTED_MODELS.map((model) => ({
    ...model,
    ...resolveInstalledModel(model),
    download: toDownloadSnapshot(getMutableDownloadState(model.id)),
  }));
}

export function getInstalledModelPath(modelId: string) {
  const model = getSupportedModel(modelId);
  if (!model) {
    return null;
  }

  const resolved = resolveInstalledModel(model);
  return resolved.installed ? resolved.localPath : null;
}

export function getActiveDownloadModelId() {
  return activeDownloadModelId;
}

function splitLines(buffer: string) {
  const normalized = buffer.replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  const remainder = parts.pop() ?? '';
  return {
    lines: parts.map((line) => line.trim()).filter(Boolean),
    remainder,
  };
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function appendDownloadLog(modelId: ModelId, line: string) {
  const nextLine = stripAnsi(line).trim();
  if (!nextLine) {
    return;
  }

  const state = getMutableDownloadState(modelId);
  const nextLines = state.logLines[state.logLines.length - 1] === nextLine
    ? state.logLines
    : [...state.logLines.slice(-23), nextLine];

  updateDownloadState(modelId, {
    logLines: nextLines,
  });
}

function normalizeByteUnit(unit: string) {
  const normalized = unit.toUpperCase().replace(/\s+/g, '');
  if (!normalized) {
    return null;
  }

  if (normalized === 'B') {
    return 'B';
  }

  if (normalized === 'K' || normalized === 'KB') {
    return 'KB';
  }

  if (normalized === 'KI' || normalized === 'KIB') {
    return 'KIB';
  }

  if (normalized === 'M' || normalized === 'MB') {
    return 'MB';
  }

  if (normalized === 'MI' || normalized === 'MIB') {
    return 'MIB';
  }

  if (normalized === 'G' || normalized === 'GB') {
    return 'GB';
  }

  if (normalized === 'GI' || normalized === 'GIB') {
    return 'GIB';
  }

  if (normalized === 'T' || normalized === 'TB') {
    return 'TB';
  }

  if (normalized === 'TI' || normalized === 'TIB') {
    return 'TIB';
  }

  return null;
}

function toMegabytesPerSecond(value: number, unit: string) {
  const normalized = normalizeByteUnit(unit);
  switch (normalized) {
    case 'KB':
    case 'KIB':
      return value / 1024;
    case 'MB':
    case 'MIB':
      return value;
    case 'GB':
    case 'GIB':
      return value * 1024;
    case 'TB':
    case 'TIB':
      return value * 1024 * 1024;
    case 'B':
      return value / (1024 * 1024);
    default:
      return null;
  }
}

function toBytes(value: number, unit: string) {
  const normalized = normalizeByteUnit(unit);
  switch (normalized) {
    case 'B':
      return value;
    case 'KB':
      return value * 1000;
    case 'KIB':
      return value * 1024;
    case 'MB':
      return value * 1000 * 1000;
    case 'MIB':
      return value * 1024 * 1024;
    case 'GB':
      return value * 1000 * 1000 * 1000;
    case 'GIB':
      return value * 1024 * 1024 * 1024;
    case 'TB':
      return value * 1000 * 1000 * 1000 * 1000;
    case 'TIB':
      return value * 1024 * 1024 * 1024 * 1024;
    default:
      return null;
  }
}

function parseEtaSeconds(rawValue: string) {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  const colonParts = value.split(':').map((part) => Number(part));
  if (colonParts.every((part) => Number.isFinite(part))) {
    if (colonParts.length === 3) {
      return colonParts[0] * 3600 + colonParts[1] * 60 + colonParts[2];
    }
    if (colonParts.length === 2) {
      return colonParts[0] * 60 + colonParts[1];
    }
    if (colonParts.length === 1) {
      return colonParts[0];
    }
  }

  let totalSeconds = 0;
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)];
  if (matches.length > 0) {
    for (const match of matches) {
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (!Number.isFinite(amount)) {
        return null;
      }
      switch (unit) {
        case 'd':
          totalSeconds += amount * 86400;
          break;
        case 'h':
          totalSeconds += amount * 3600;
          break;
        case 'm':
          totalSeconds += amount * 60;
          break;
        case 's':
          totalSeconds += amount;
          break;
        default:
          return null;
      }
    }
    return Math.round(totalSeconds);
  }

  return null;
}

function extractProgressMetrics(modelId: ModelId, line: string): Partial<ModelDownloadSnapshot> {
  const next: Partial<ModelDownloadSnapshot> = {};

  const percentMatch = line.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (percentMatch) {
    next.progressPercent = clampPercent(Number(percentMatch[1]));
  }

  const speedMatch = line.match(/(\d+(?:\.\d+)?)\s*([KMGT](?:I?B)?|B)\/s/i);
  if (speedMatch) {
    const speedMBps = toMegabytesPerSecond(Number(speedMatch[1]), speedMatch[2]);
    if (speedMBps != null) {
      next.speedMBps = speedMBps;
    }
  }

  const etaMatch =
    line.match(/<\s*([0-9:.]+)(?=[,\]])/) ??
    line.match(/ETA[:\s]+([0-9:.]+(?:\s*[dhms])*)/i) ??
    line.match(/remaining[:\s]+([0-9:.]+(?:\s*[dhms])*)/i);

  if (etaMatch) {
    const etaSeconds = parseEtaSeconds(etaMatch[1]);
    if (etaSeconds != null) {
      next.etaSeconds = etaSeconds;
    }
  }

  const transferMatch = line.match(/(\d+(?:\.\d+)?)\s*([KMGT](?:I?B)?|B)\s*\/\s*(\d+(?:\.\d+)?)\s*([KMGT](?:I?B)?|B)/i);
  if (transferMatch) {
    const transferredBytes = toBytes(Number(transferMatch[1]), transferMatch[2]);
    const totalBytes = toBytes(Number(transferMatch[3]), transferMatch[4]);
    if (transferredBytes != null && totalBytes != null && totalBytes > 0) {
      if (next.progressPercent == null) {
        next.progressPercent = clampPercent((transferredBytes / totalBytes) * 100);
      }

      const state = getMutableDownloadState(modelId);
      const now = Date.now();
      let sampledSpeedMBps = next.speedMBps ?? null;

      if (
        state.lastProgressBytes != null &&
        state.lastProgressAt != null &&
        transferredBytes >= state.lastProgressBytes &&
        now > state.lastProgressAt
      ) {
        const deltaBytes = transferredBytes - state.lastProgressBytes;
        const deltaSeconds = (now - state.lastProgressAt) / 1000;
        if (deltaBytes > 0 && deltaSeconds > 0.2) {
          sampledSpeedMBps = deltaBytes / deltaSeconds / (1024 * 1024);
        }
      }

      state.lastProgressBytes = transferredBytes;
      state.lastProgressAt = now;

      if (sampledSpeedMBps != null && Number.isFinite(sampledSpeedMBps) && sampledSpeedMBps > 0) {
        next.speedMBps = sampledSpeedMBps;
        if (next.etaSeconds == null) {
          next.etaSeconds = Math.max(0, Math.round((totalBytes - transferredBytes) / (sampledSpeedMBps * 1024 * 1024)));
        }
      }
    }
  }

  return next;
}

function attachProcessLogging(modelId: ModelId, proc: ChildProcessByStdio<null, Readable, Readable>) {
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const handleChunk = (key: 'stdout' | 'stderr', chunk: Buffer) => {
    const text = chunk.toString();
    const combined = key === 'stdout' ? stdoutBuffer + text : stderrBuffer + text;
    const { lines, remainder } = splitLines(combined);
    if (key === 'stdout') {
      stdoutBuffer = remainder;
    } else {
      stderrBuffer = remainder;
    }

    for (const line of lines) {
      appendDownloadLog(modelId, line);
    }

    const latestLine = lines[lines.length - 1];
    if (latestLine) {
      updateDownloadState(modelId, {
        message: latestLine,
        ...extractProgressMetrics(modelId, latestLine),
      });
    }
  };

  proc.stdout.on('data', (chunk: Buffer) => handleChunk('stdout', chunk));
  proc.stderr.on('data', (chunk: Buffer) => handleChunk('stderr', chunk));
  proc.on('close', () => {
    const remainingLines = [stdoutBuffer, stderrBuffer]
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of remainingLines) {
      appendDownloadLog(modelId, line);
      updateDownloadState(modelId, {
        message: line,
        ...extractProgressMetrics(modelId, line),
      });
    }
  });
}

function resolveUserBaseBin() {
  const userBase = execFileSync('python3', ['-c', 'import site; print(site.USER_BASE)'], {
    encoding: 'utf8',
  }).trim();
  return path.join(userBase, 'bin');
}

function resolveExecutable(command: string, extraPaths: string[] = []) {
  const candidatePaths = [...extraPaths, ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const directory of candidatePaths) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

async function runCommand(modelId: ModelId, command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    updateDownloadState(modelId, { process: proc });
    attachProcessLogging(modelId, proc);

    proc.on('close', (code) => {
      updateDownloadState(modelId, { process: null });
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} exited with code ${code ?? 1}`));
    });

    proc.on('error', (error) => {
      updateDownloadState(modelId, { process: null });
      reject(error);
    });
  });
}

async function ensureHfCli(modelId: ModelId) {
  const userBin = resolveUserBaseBin();
  const existing = resolveExecutable('hf', [userBin]);
  if (existing) {
    return existing;
  }

  updateDownloadState(modelId, {
    status: 'preparing',
    message: 'Installing Hugging Face CLI...',
    progressPercent: null,
    speedMBps: null,
    etaSeconds: null,
    lastProgressBytes: null,
    lastProgressAt: null,
  });

  await runCommand(
    modelId,
    'python3',
    ['-m', 'pip', 'install', '--user', '--upgrade', 'huggingface_hub[cli]'],
    {
      ...process.env,
      PATH: `${userBin}${path.delimiter}${process.env.PATH ?? ''}`,
    }
  );

  const installed = resolveExecutable('hf', [userBin]);
  if (!installed) {
    throw new Error('The Hugging Face CLI was installed but could not be found on PATH.');
  }

  return installed;
}

async function runModelDownload(model: SupportedModel, token?: string) {
  const state = getMutableDownloadState(model.id);
  const targetDir = path.join(config.irisModelDir, model.installDirName);
  const existing = resolveInstalledModel(model);
  const isRepair = existing.installStatus === 'partial';

  try {
    ensureModelsRoot();

    if (existing.installed) {
      throw new Error('Model is already installed.');
    }

    const hfPath = await ensureHfCli(model.id);
    state.cancelRequested = false;
    updateDownloadState(model.id, {
      status: 'downloading',
      message: isRepair ? `Downloading missing files for ${model.label}...` : `Downloading ${model.label}...`,
      progressPercent: null,
      speedMBps: null,
      etaSeconds: null,
      lastProgressBytes: null,
      lastProgressAt: null,
    });

    fs.mkdirSync(targetDir, { recursive: true });

    await runCommand(
      model.id,
      hfPath,
      ['download', model.repoId, '--local-dir', targetDir],
      {
        ...process.env,
        PATH: `${path.dirname(hfPath)}${path.delimiter}${process.env.PATH ?? ''}`,
        ...(token ? { HF_TOKEN: token } : {}),
      }
    );

    if (state.cancelRequested) {
      throw new Error('Download cancelled');
    }

    updateDownloadState(model.id, {
      status: 'installing',
      message: isRepair ? `Verifying ${model.label} files...` : `Finalizing ${model.label}...`,
      speedMBps: null,
      etaSeconds: null,
      lastProgressBytes: null,
      lastProgressAt: null,
    });

    const resolved = resolveInstalledModel(model);
    if (!resolved.installed) {
      throw new Error(
        resolved.installStatus === 'partial'
          ? `Download completed, but files are still missing: ${resolved.missingComponents.join(', ')}`
          : 'Download completed, but the model folder is still incomplete.'
      );
    }

    updateDownloadState(model.id, {
      status: 'done',
      finishedAt: serializeNow(),
      message: 'Ready to use',
      error: null,
      progressPercent: 100,
      speedMBps: null,
      etaSeconds: 0,
      lastProgressBytes: null,
      lastProgressAt: null,
    });
  } catch (error) {
    const wasCancelled = state.cancelRequested;
    const mode = state.cancelMode;
    const message = error instanceof Error ? error.message : 'Model download failed';

    if (wasCancelled && mode === 'stop') {
      try {
        if (fs.existsSync(targetDir)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
      } catch (rmErr) {
        console.error(`[models] failed to remove ${targetDir}:`, rmErr);
      }
      updateDownloadState(model.id, getDefaultDownloadState());
    } else if (wasCancelled && mode === 'pause') {
      updateDownloadState(model.id, {
        status: 'paused',
        finishedAt: serializeNow(),
        error: null,
        message: 'Download paused. Click Resume to continue.',
        speedMBps: null,
        etaSeconds: null,
        lastProgressBytes: null,
        lastProgressAt: null,
      });
    } else if (wasCancelled) {
      updateDownloadState(model.id, {
        status: 'cancelled',
        finishedAt: serializeNow(),
        error: null,
        message: 'Download cancelled',
        speedMBps: null,
        etaSeconds: null,
        lastProgressBytes: null,
        lastProgressAt: null,
      });
    } else {
      updateDownloadState(model.id, {
        status: 'failed',
        finishedAt: serializeNow(),
        error: message,
        message: null,
        speedMBps: null,
        etaSeconds: null,
        lastProgressBytes: null,
        lastProgressAt: null,
      });
    }
  } finally {
    state.process = null;
    state.tempDir = null;
    state.cancelMode = null;
    activeDownloadModelId = null;
  }
}

export function startModelDownload(modelId: ModelId, token?: string) {
  const model = getSupportedModel(modelId);
  if (!model) {
    throw new Error('Unsupported model');
  }

  if (activeDownloadModelId && activeDownloadModelId !== modelId) {
    throw new Error('Another model download is already running. Download one model at a time.');
  }

  if (model.gated && !token) {
    throw new Error(`A Hugging Face access token is required for ${model.label}. Accept the terms on ${model.huggingFaceUrl} first.`);
  }

  const state = getMutableDownloadState(modelId);
  if (state.status === 'downloading' || state.status === 'preparing' || state.status === 'installing' || state.status === 'stopping') {
    throw new Error('This model is already downloading.');
  }

  activeDownloadModelId = modelId;
  updateDownloadState(modelId, {
    status: 'preparing',
    startedAt: serializeNow(),
    finishedAt: null,
    message: 'Preparing download...',
    error: null,
    progressPercent: null,
    speedMBps: null,
    etaSeconds: null,
    logLines: [],
    cancelRequested: false,
    cancelMode: null,
    lastProgressBytes: null,
    lastProgressAt: null,
  });

  void runModelDownload(model, token);

  return toDownloadSnapshot(getMutableDownloadState(modelId));
}

export function cancelModelDownload(modelId: ModelId, mode: CancelMode = 'pause') {
  if (activeDownloadModelId !== modelId) {
    return false;
  }

  const state = getMutableDownloadState(modelId);
  state.cancelRequested = true;
  state.cancelMode = mode;
  updateDownloadState(modelId, {
    status: 'stopping',
    message: mode === 'stop' ? 'Stopping and cleaning up...' : 'Pausing download...',
    speedMBps: null,
    etaSeconds: null,
    lastProgressBytes: null,
    lastProgressAt: null,
  });

  if (state.process && state.process.exitCode == null && state.process.signalCode == null) {
    state.process.kill('SIGINT');
    setTimeout(() => {
      if (state.process && state.process.exitCode == null && state.process.signalCode == null) {
        state.process.kill('SIGTERM');
      }
    }, 3000).unref();
    setTimeout(() => {
      if (state.process && state.process.exitCode == null && state.process.signalCode == null) {
        state.process.kill('SIGKILL');
      }
    }, 6000).unref();
  }

  return true;
}
