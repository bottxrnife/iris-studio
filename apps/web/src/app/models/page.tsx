'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, ExternalLink, FolderOpen, Gauge, Loader2, Pause, ShieldAlert, Square, Trash2, CheckCircle2, X } from 'lucide-react';
import { cancelModelDownload, downloadModel, getBenchmarkStatus, getModels, startBenchmark, stopBenchmark } from '@/lib/api';
import { formatRemainingTime } from '@/lib/format';
import type { BenchmarkRun, ModelId } from '@/lib/types';
import { Progress } from '@/components/ui/progress';

function formatDownloadSpeed(speedMBps: number | null) {
  if (speedMBps == null || !Number.isFinite(speedMBps) || speedMBps <= 0) {
    return null;
  }

  if (speedMBps >= 100) {
    return `${speedMBps.toFixed(0)} MB/s`;
  }

  if (speedMBps >= 10) {
    return `${speedMBps.toFixed(1)} MB/s`;
  }

  return `${speedMBps.toFixed(2)} MB/s`;
}

function formatEta(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

const CURRENT_BENCHMARK_LABELS = ['512 x 512', '768 x 768', '1024 x 1024'] as const;
const CURRENT_BENCHMARK_LABEL_SET = new Set<string>(CURRENT_BENCHMARK_LABELS);
const CURRENT_BENCHMARK_LABEL_ORDER = new Map<string, number>(CURRENT_BENCHMARK_LABELS.map((label, index) => [label, index]));

function getCurrentBenchmarkSamples(
  run: BenchmarkRun | null,
  mode: Extract<BenchmarkRun['samples'][number]['mode'], 'txt2img' | 'img2img'>
) {
  if (!run) {
    return [];
  }

  return run.samples
    .filter((sample) => sample.mode === mode && CURRENT_BENCHMARK_LABEL_SET.has(sample.label))
    .sort((left, right) => {
      const leftOrder = CURRENT_BENCHMARK_LABEL_ORDER.get(left.label) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = CURRENT_BENCHMARK_LABEL_ORDER.get(right.label) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
}

function formatBenchmarkTimestamp(run: BenchmarkRun) {
  const value = run.finishedAt ?? run.startedAt;
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const MEMORY_REQUIREMENTS: Record<ModelId, { minimum: string; recommended: string }> = {
  'flux-klein-4b': { minimum: '16 GB', recommended: '24 GB' },
  'flux-klein-base-4b': { minimum: '16 GB', recommended: '24 GB' },
  'flux-klein-9b': { minimum: '24 GB', recommended: '36 GB' },
  'flux-klein-base-9b': { minimum: '24 GB', recommended: '48 GB' },
  'zimage-turbo-6b': { minimum: '16 GB', recommended: '24 GB' },
};

export default function ModelsPage() {
  const queryClient = useQueryClient();
  const [tokenByModel, setTokenByModel] = useState<Record<string, string>>({});
  const [openBenchmarkModelId, setOpenBenchmarkModelId] = useState<ModelId | null>(null);
  const [confirmStopModelId, setConfirmStopModelId] = useState<ModelId | null>(null);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: getModels,
    refetchInterval: (query) => query.state.data?.activeDownloadModelId ? 600 : false,
  });

  const benchmarkQuery = useQuery({
    queryKey: ['benchmark-status'],
    queryFn: getBenchmarkStatus,
    refetchInterval: 1000,
    staleTime: 1000,
  });

  const downloadMutation = useMutation({
    mutationFn: ({ modelId, token }: { modelId: ModelId; token?: string }) => downloadModel(modelId, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: ({ modelId, mode }: { modelId: ModelId; mode: 'pause' | 'stop' }) =>
      cancelModelDownload(modelId, mode),
    onSuccess: () => {
      setConfirmStopModelId(null);
      queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const benchmarkMutation = useMutation({
    mutationFn: (modelId: ModelId) => startBenchmark(modelId),
    onSuccess: (_data, modelId) => {
      setOpenBenchmarkModelId(modelId);
      queryClient.invalidateQueries({ queryKey: ['benchmark-status'] });
    },
  });

  const stopBenchmarkMutation = useMutation({
    mutationFn: stopBenchmark,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['benchmark-status'] });
    },
  });

  const models = modelsQuery.data?.models ?? [];
  const activeDownloadModelId = modelsQuery.data?.activeDownloadModelId ?? null;
  const installedCount = useMemo(() => models.filter((model) => model.installed).length, [models]);
  const currentBenchmarkRun = benchmarkQuery.data?.currentRun ?? null;

  return (
    <main className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-6 overflow-y-auto px-4 py-6">
      <section className="rounded-2xl border border-border bg-card/80 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Models</p>
            <h1 className="text-2xl font-semibold text-foreground">Manage your AI models</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Download and manage FLUX image generation models. You need at least one installed model to start generating images.
              Models are stored in your project&apos;s <code className="rounded bg-secondary px-1 py-0.5">Models/</code> folder.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-background/60 px-4 py-3 text-sm text-muted-foreground">
            <p>{installedCount} installed</p>
            <p className="font-mono text-xs text-foreground/80">{modelsQuery.data?.modelsDir ?? 'Models/'}</p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-2xl border border-border bg-card/80 p-5">
          <div>
            <h2 className="text-lg font-semibold">Available models</h2>
            <p className="text-sm text-muted-foreground">Pick a model that fits your needs. Smaller models are faster, larger ones produce higher quality. Distilled variants generate in fewer steps.</p>
          </div>

          <div className="mt-5 grid items-start gap-4 xl:grid-cols-2">
            {models.map((model) => {
              const isActive = activeDownloadModelId === model.id;
              const isBenchmarkMenuOpen = openBenchmarkModelId === model.id;
              const token = tokenByModel[model.id] ?? '';
              const trimmedToken = token.trim();
              const requiresToken = model.gated && model.installStatus !== 'installed';
              const missingRequiredToken = requiresToken && trimmedToken.length === 0;
              const isDownloadInProgress =
                model.download.status === 'preparing' ||
                model.download.status === 'downloading' ||
                model.download.status === 'installing' ||
                model.download.status === 'stopping';
              const canDownload = !model.installed && !isActive && !missingRequiredToken;
              const isPartial = model.installStatus === 'partial';
              const shouldShowPartialWarning = isPartial && !isDownloadInProgress;
              const shouldShowFolderDetails = !model.installed && !isDownloadInProgress;
              const formattedSpeed = formatDownloadSpeed(model.download.speedMBps);
              const formattedEta = formatEta(model.download.etaSeconds);
              const shouldShowSpeed = formattedSpeed != null;
              const shouldShowEta = formattedSpeed != null && formattedEta != null;
              const downloadLogLines = model.download.logLines.length > 0
                ? model.download.logLines.slice(-12)
                : [
                    model.download.error ??
                    model.download.message ??
                    'Waiting for download output...',
                  ];
              const downloadTone = model.download.status === 'failed'
                ? {
                    dot: 'bg-red-400 shadow-[0_0_12px_rgba(248,113,113,0.8)]',
                    terminalBorder: 'border-red-500/20',
                    terminalHeaderBorder: 'border-red-500/20',
                    terminalText: 'text-red-200',
                    terminalAccent: 'text-red-300/80',
                    terminalMeta: 'text-red-300/60',
                  }
                : model.download.status === 'cancelled' || model.download.status === 'stopping'
                  ? {
                      dot: 'bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.8)]',
                      terminalBorder: 'border-amber-500/20',
                      terminalHeaderBorder: 'border-amber-500/20',
                      terminalText: 'text-amber-200',
                      terminalAccent: 'text-amber-300/80',
                      terminalMeta: 'text-amber-300/60',
                    }
                  : model.download.status === 'paused'
                    ? {
                        dot: 'bg-blue-400 shadow-[0_0_12px_rgba(96,165,250,0.8)]',
                        terminalBorder: 'border-blue-500/20',
                        terminalHeaderBorder: 'border-blue-500/20',
                        terminalText: 'text-blue-200',
                        terminalAccent: 'text-blue-300/80',
                        terminalMeta: 'text-blue-300/60',
                      }
                    : {
                        dot: 'bg-emerald-400 shadow-[0_0_12px_rgba(74,222,128,0.8)]',
                        terminalBorder: 'border-emerald-500/20',
                        terminalHeaderBorder: 'border-emerald-500/20',
                        terminalText: 'text-emerald-200',
                        terminalAccent: 'text-emerald-300/80',
                        terminalMeta: 'text-emerald-300/60',
                      };
              const currentBenchmarkForModel = currentBenchmarkRun?.model === model.id ? currentBenchmarkRun : null;
              const latestBenchmarkRunForModel = benchmarkQuery.data?.latestRunsByModel?.[model.id] ?? null;
              const latestUsableBenchmarkRunForModel = benchmarkQuery.data?.latestUsableRunsByModel?.[model.id] ?? null;
              const benchmarkReportRun = latestBenchmarkRunForModel?.status === 'cancelled'
                ? latestBenchmarkRunForModel
                : latestUsableBenchmarkRunForModel;
              const latestTxtBenchmarkSamples = getCurrentBenchmarkSamples(latestUsableBenchmarkRunForModel, 'txt2img');
              const latestImgBenchmarkSamples = getCurrentBenchmarkSamples(latestUsableBenchmarkRunForModel, 'img2img');
              const benchmarkCurrentProgress = currentBenchmarkForModel?.currentProgress ?? null;
              const benchmarkOverallPercent = currentBenchmarkForModel
                ? Math.min(
                    100,
                    Math.round(
                      ((currentBenchmarkForModel.completedCases + (benchmarkCurrentProgress?.percent ?? 0) / 100) / currentBenchmarkForModel.totalCases) * 100
                    )
                  )
                : 0;
              const benchmarkCurrentPercent = benchmarkCurrentProgress?.percent ?? null;
              const showLatestBenchmarkSamples =
                !!latestUsableBenchmarkRunForModel &&
                latestUsableBenchmarkRunForModel.samples.length > 0 &&
                latestUsableBenchmarkRunForModel.status !== 'failed';
              const benchmarkIsRunningOnOtherModel =
                currentBenchmarkRun?.status === 'running' &&
                currentBenchmarkRun.model != null &&
                currentBenchmarkRun.model !== model.id;
              const benchmarkButtonLabel = currentBenchmarkForModel?.status === 'running'
                ? `${currentBenchmarkForModel.completedCases}/${currentBenchmarkForModel.totalCases}`
                : 'Benchmark';
              const canOpenBenchmark = model.installed;
              const isPaused = model.download.status === 'paused';
              const actionLabel = model.installed
                ? 'Installed'
                : isActive
                  ? model.download.status === 'stopping'
                    ? 'Stopping...'
                    : 'Downloading...'
                  : missingRequiredToken
                    ? 'Input Access Token'
                    : isPaused
                      ? 'Resume'
                      : isPartial
                        ? 'Download Missing Files'
                        : 'Download';

              return (
                <article key={model.id} className="overflow-hidden rounded-2xl border border-border bg-background/70 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-foreground">{model.label}</h3>
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{model.parameterSize}</span>
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{model.variant}</span>
                        {model.installed && (
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">Installed</span>
                        )}
                        {shouldShowPartialWarning && (
                          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] text-red-300">Missing files</span>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">{model.summary}</p>
                    </div>
                    <a
                      href={model.huggingFaceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Model page
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>

                  <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                    <div className="rounded-xl border border-border/70 bg-card/60 p-3">
                      <p className="text-[11px] uppercase tracking-[0.18em]">Defaults</p>
                      <p className="mt-2 text-sm text-foreground">
                        {model.recommendedSteps} steps
                        {model.recommendedGuidance != null ? ` · guidance ${model.recommendedGuidance}` : ' · CFG'}
                      </p>
                    </div>
                    <div className="rounded-xl border border-border/70 bg-card/60 p-3">
                      <p className="text-[11px] uppercase tracking-[0.18em]">Unified memory</p>
                      <p className="mt-2 text-sm text-foreground">
                        {MEMORY_REQUIREMENTS[model.id].minimum} min
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {MEMORY_REQUIREMENTS[model.id].recommended} recommended
                      </p>
                    </div>
                    <div className="rounded-xl border border-border/70 bg-card/60 p-3">
                      <p className="text-[11px] uppercase tracking-[0.18em]">License</p>
                      <p className="mt-2 text-sm text-foreground">
                        {model.license === 'apache-2.0' ? 'Apache 2.0' : 'Non-commercial'}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4">
                    <button
                      type="button"
                      disabled={!canOpenBenchmark}
                      onClick={() => setOpenBenchmarkModelId((current) => current === model.id ? null : model.id)}
                      className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-secondary px-3 text-sm text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Gauge className="h-4 w-4" />
                      {benchmarkButtonLabel}
                    </button>
                  </div>

                  {model.gated && !model.installed && (
                    <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">
                      <div className="flex items-start gap-2">
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          <p className="font-medium">Access token required</p>
                          <p className="mt-1 text-amber-100/80">
                            This model requires you to accept the license on its Hugging Face page first, then paste your access token below.
                          </p>
                        </div>
                      </div>
                      <input
                        type="password"
                        placeholder="Hugging Face access token"
                        value={token}
                        onChange={(event) => {
                          setTokenByModel((current) => ({ ...current, [model.id]: event.target.value }));
                        }}
                        className="mt-3 flex h-10 w-full rounded-md border border-amber-500/30 bg-black/20 px-3 py-2 text-sm text-foreground placeholder:text-amber-100/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400"
                      />
                    </div>
                  )}

                  {!model.gated && (
                    <p className="mt-4 text-xs text-muted-foreground">
                      This model can be downloaded freely without an access token.
                    </p>
                  )}

                  {shouldShowPartialWarning && (
                    <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-100">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          <p className="font-medium">Some files are missing</p>
                          <p className="mt-1 text-red-100/80">
                            The model folder exists but is incomplete. Missing: {model.missingComponents.join(', ')}. Click &quot;Download Missing Files&quot; below to fix this.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="mt-4 rounded-xl border border-border/70 bg-card/60 p-3 text-sm">
                    {model.installed ? (
                      <div className="flex items-start gap-2 text-emerald-200">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          <p className="font-medium text-foreground">Installed and ready to use</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            You can select this model in the Studio to generate images.
                          </p>
                          {model.localPath && <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{model.localPath}</p>}
                        </div>
                      </div>
                    ) : shouldShowFolderDetails ? (
                      <div className="space-y-2">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Model folder</p>
                        <p className="text-sm text-muted-foreground">
                          Not installed yet. Click Download below to get it automatically, or manually place model files in
                          <code className="ml-1 rounded bg-secondary px-1 py-0.5">Models/{model.installDirName}/</code>.
                        </p>
                        {model.localPath && (
                          <p className="break-all font-mono text-[11px] text-muted-foreground">
                            Current folder: {model.localPath}
                          </p>
                        )}
                        {isPartial && (
                          <p className="text-xs text-red-300">
                            This folder exists, but Iris still cannot run it until the missing parts above are added.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Model folder</p>
                        <p className="text-sm text-muted-foreground">
                          Downloading directly into <code className="rounded bg-secondary px-1 py-0.5">{model.installDirName}/</code>.
                        </p>
                      </div>
                    )}
                  </div>

                  {(model.download.status === 'downloading' ||
                    model.download.status === 'preparing' ||
                    model.download.status === 'installing' ||
                    model.download.status === 'stopping' ||
                    model.download.status === 'failed' ||
                    model.download.status === 'cancelled' ||
                    model.download.status === 'paused') && (
                    <div className="mt-4 rounded-xl border border-border/70 bg-card/60 p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <div className={`h-2.5 w-2.5 rounded-full ${downloadTone.dot}`} />
                          <p className="font-medium capitalize text-foreground">
                            {model.download.status === 'paused' ? 'Paused' : model.download.status}
                          </p>
                        </div>
                        {model.download.progressPercent != null && (
                          <p className="font-mono text-xs font-medium tabular-nums text-foreground">
                            {Math.round(model.download.progressPercent)}%
                          </p>
                        )}
                      </div>
                      <Progress
                        value={model.download.progressPercent}
                        indeterminate={
                          model.download.status === 'preparing' ||
                          model.download.status === 'installing' ||
                          model.download.status === 'stopping' ||
                          (model.download.status === 'downloading' && model.download.progressPercent == null)
                        }
                        className="mt-3 h-2.5"
                      />
                      <div className={`mt-3 grid gap-2 ${shouldShowSpeed || shouldShowEta ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-1'}`}>
                        <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Progress</p>
                          <p className="mt-1 font-mono text-sm tabular-nums text-foreground">
                            {model.download.progressPercent != null ? `${Math.round(model.download.progressPercent)}%` : 'Waiting for progress'}
                          </p>
                        </div>
                        {shouldShowSpeed && (
                          <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Speed</p>
                            <p className="mt-1 font-mono text-sm tabular-nums text-foreground">
                              {formattedSpeed}
                            </p>
                          </div>
                        )}
                        {shouldShowEta && (
                          <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">ETA</p>
                            <p className="mt-1 font-mono text-sm tabular-nums text-foreground">
                              {formattedEta}
                            </p>
                          </div>
                        )}
                      </div>
                      <div className={`mt-3 overflow-hidden rounded-lg border bg-black/90 ${downloadTone.terminalBorder}`}>
                        <div className={`flex items-center justify-between border-b px-3 py-2 ${downloadTone.terminalHeaderBorder}`}>
                          <p className={`font-mono text-[10px] uppercase tracking-[0.24em] ${downloadTone.terminalAccent}`}>Download Log</p>
                          <p className={`font-mono text-[10px] ${downloadTone.terminalMeta}`}>live</p>
                        </div>
                        <div className={`max-h-40 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5 ${downloadTone.terminalText}`}>
                          {downloadLogLines.map((line, index) => (
                            <p key={`${model.id}-download-log-${index}`} className="whitespace-pre-wrap break-all">
                              {line}
                            </p>
                          ))}
                        </div>
                      </div>
                      {model.download.error && <p className="mt-2 text-destructive">{model.download.error}</p>}
                    </div>
                  )}

                  {isBenchmarkMenuOpen && model.installed && (
                    <div className="mt-4 rounded-xl border border-border/70 bg-card/60 p-4 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-foreground">Benchmark {model.label}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Measures generation speed at different sizes so time estimates are accurate for this model.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setOpenBenchmarkModelId(null)}
                          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                          aria-label="Close benchmark panel"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => benchmarkMutation.mutate(model.id)}
                          disabled={
                            benchmarkMutation.isPending ||
                            benchmarkIsRunningOnOtherModel ||
                            currentBenchmarkForModel?.status === 'running'
                          }
                          className="inline-flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Gauge className="h-4 w-4" />
                          {currentBenchmarkForModel?.status === 'running'
                            ? `Benchmarking ${currentBenchmarkForModel.completedCases}/${currentBenchmarkForModel.totalCases}`
                            : latestBenchmarkRunForModel
                              ? 'Run benchmark again'
                              : 'Run benchmark'}
                        </button>
                        {currentBenchmarkForModel?.status === 'running' && (
                          <button
                            type="button"
                            onClick={() => stopBenchmarkMutation.mutate()}
                            disabled={stopBenchmarkMutation.isPending}
                            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-50 enabled:text-foreground enabled:hover:bg-secondary/80"
                          >
                            <Square className="h-4 w-4" />
                            {stopBenchmarkMutation.isPending ? 'Stopping...' : 'Stop'}
                          </button>
                        )}
                      </div>

                      {benchmarkIsRunningOnOtherModel && (
                        <p className="mt-3 text-xs text-muted-foreground">
                          Another benchmark is already running for a different model. Wait for it to finish before starting this one.
                        </p>
                      )}

                      {currentBenchmarkForModel?.status === 'running' && (
                        <div className="mt-4 space-y-3 rounded-lg border border-border/70 bg-background/50 p-3">
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                              <span>Overall benchmark</span>
                              <span>{currentBenchmarkForModel.completedCases} / {currentBenchmarkForModel.totalCases}</span>
                            </div>
                            <Progress value={benchmarkOverallPercent} />
                          </div>

                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                              <span>{currentBenchmarkForModel.currentCaseLabel ?? 'Preparing benchmark...'}</span>
                              <span>{benchmarkCurrentPercent != null ? `${Math.round(benchmarkCurrentPercent)}%` : 'Starting...'}</span>
                            </div>
                            <Progress
                              value={benchmarkCurrentPercent ?? 0}
                              indeterminate={benchmarkCurrentPercent == null}
                            />
                            <p className="text-[11px] text-foreground">
                              {benchmarkCurrentProgress
                                ? `${benchmarkCurrentProgress.phase}${benchmarkCurrentProgress.totalSteps > 0 ? ` · step ${benchmarkCurrentProgress.step}/${benchmarkCurrentProgress.totalSteps}` : ''}`
                                : 'Waiting for iris progress output...'}
                            </p>
                          </div>
                        </div>
                      )}

                      {benchmarkQuery.isError && (
                        <p className="mt-3 text-[11px] text-destructive">
                          {benchmarkQuery.error instanceof Error ? benchmarkQuery.error.message : 'Failed to load benchmark status'}
                        </p>
                      )}
                      {benchmarkMutation.isError && benchmarkMutation.variables === model.id && (
                        <p className="mt-3 text-[11px] text-destructive">
                          {benchmarkMutation.error instanceof Error ? benchmarkMutation.error.message : 'Failed to start benchmark'}
                        </p>
                      )}
                      {stopBenchmarkMutation.isError && currentBenchmarkForModel && (
                        <p className="mt-3 text-[11px] text-destructive">
                          {stopBenchmarkMutation.error instanceof Error ? stopBenchmarkMutation.error.message : 'Failed to stop benchmark'}
                        </p>
                      )}
                      {showLatestBenchmarkSamples && benchmarkReportRun && (
                        <div className="mt-4 space-y-3">
                          <p className="text-[10px] text-muted-foreground">
                            {latestBenchmarkRunForModel?.status === 'cancelled'
                              ? `Last benchmark stopped early ${formatBenchmarkTimestamp(benchmarkReportRun)}. Completed cases are still kept for ETA calibration.`
                              : `Last completed ${formatBenchmarkTimestamp(benchmarkReportRun)}.`}
                          </p>
                          <BenchmarkSampleGroup title="Text to Image" samples={latestTxtBenchmarkSamples} />
                          <BenchmarkSampleGroup title="Image to Image" samples={latestImgBenchmarkSamples} />
                        </div>
                      )}
                      {latestBenchmarkRunForModel?.status === 'failed' && latestBenchmarkRunForModel.error && (
                        <p className="mt-3 text-[11px] text-destructive">
                          Last benchmark failed: {latestBenchmarkRunForModel.error}
                        </p>
                      )}
                      {latestBenchmarkRunForModel?.status === 'cancelled' && latestBenchmarkRunForModel.samples.length === 0 && (
                        <p className="mt-3 text-[11px] text-muted-foreground">
                          Benchmark was stopped before any cases finished.
                        </p>
                      )}
                      {!currentBenchmarkForModel && !latestBenchmarkRunForModel && (
                        <p className="mt-3 text-[11px] text-muted-foreground">
                          No benchmark has been run for this model yet.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!canDownload || downloadMutation.isPending}
                      onClick={() => downloadMutation.mutate({ modelId: model.id, token: trimmedToken || undefined })}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isActive ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      {actionLabel}
                    </button>
                    {isActive && model.download.status !== 'stopping' && (
                      <>
                        <button
                          type="button"
                          onClick={() => cancelMutation.mutate({ modelId: model.id, mode: 'pause' })}
                          disabled={cancelMutation.isPending}
                          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-50"
                          title="Pause download — files are kept so you can resume later"
                        >
                          <Pause className="h-4 w-4" />
                          Pause
                        </button>
                        {confirmStopModelId === model.id ? (
                          <div className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                            <span className="text-sm text-destructive">Delete partial files?</span>
                            <button
                              type="button"
                              onClick={() => cancelMutation.mutate({ modelId: model.id, mode: 'stop' })}
                              disabled={cancelMutation.isPending}
                              className="rounded px-2 py-0.5 text-sm font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
                            >
                              Yes, stop
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmStopModelId(null)}
                              className="rounded px-2 py-0.5 text-sm text-muted-foreground hover:bg-secondary"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmStopModelId(model.id)}
                            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
                            title="Stop and delete all downloaded files for this model"
                          >
                            <Trash2 className="h-4 w-4" />
                            Stop
                          </button>
                        )}
                      </>
                    )}
                    {isActive && model.download.status === 'stopping' && (
                      <span className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground opacity-60">
                        <Square className="h-4 w-4" />
                        Stopping...
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <h2 className="text-lg font-semibold">Getting started</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              You can start the app before downloading any models. Come back here when you&apos;re ready to install one.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              <li>Download at least one model to start generating images.</li>
              <li>4B Distilled is the fastest option for quick experimentation.</li>
              <li>9B Distilled is a good balance of speed and quality.</li>
              <li>Base variants offer more creative range but take longer per image.</li>
            </ul>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <FolderOpen className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Manual install</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              You can also copy model files directly into the folder below. Refresh this page afterwards to detect them.
            </p>
            <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
              {modelsQuery.data?.modelsDir ?? 'Models/'}
            </p>
          </section>
        </aside>
      </section>
    </main>
  );
}

function BenchmarkSampleGroup({
  title,
  samples,
}: {
  title: string;
  samples: BenchmarkRun['samples'];
}) {
  if (samples.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-foreground">{title}</span>
        <span className="text-muted-foreground">{samples.length} cases</span>
      </div>
      <div className="space-y-1 rounded border border-border/50 bg-background/40 p-2">
        {samples.map((sample) => (
          <div key={sample.id} className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">{sample.label}</span>
            <span className="font-mono tabular-nums text-foreground">
              {formatRemainingTime(sample.durationMs) ?? `${(sample.durationMs / 1000).toFixed(1)}s`}
            </span>
          </div>
        ))}
        {samples.length < CURRENT_BENCHMARK_LABELS.length && (
          <p className="text-[10px] text-muted-foreground">
            Run benchmark again to fill the current preset set.
          </p>
        )}
      </div>
    </div>
  );
}
