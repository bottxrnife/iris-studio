'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Loader2, ImageOff } from 'lucide-react';
import { getJob, getModels, getOutputImageUrl } from '@/lib/api';
import { Progress } from '@/components/ui/progress';
import { formatLiveElapsedTime, formatLiveRemainingTime, useEtaNow } from '@/lib/eta';
import type { JobProgress, JobStatus } from '@/lib/types';

interface CanvasProps {
  activeJobId: string | null;
  liveStatus: JobStatus | null;
  progress: JobProgress | null;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued...',
  running: 'Starting up...',
  saving: 'Saving...',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

const PHASE_ORDER = [
  'Initializing',
  'Loading VAE',
  'Loading text encoders',
  'Encoding prompt',
  'Loading transformer',
  'Denoising',
  'Decoding image',
  'Saving',
] as const;

function getPhaseIndex(phase: string): number {
  const lower = phase.toLowerCase();
  if (lower.includes('vae')) return 1;
  if (lower.includes('text') || lower.includes('qwen') || lower.includes('encoder')) return 2;
  if (lower.includes('encod')) return 3;
  if (lower.includes('transformer') || lower.includes('flux.2')) return 4;
  if (lower.includes('denois')) return 5;
  if (lower.includes('decod')) return 6;
  if (lower.includes('sav')) return 7;
  if (lower.includes('init') || lower.includes('load')) return 0;
  return -1;
}

export function Canvas({ activeJobId, liveStatus, progress }: CanvasProps) {
  const { data: job, dataUpdatedAt } = useQuery({
    queryKey: ['job', activeJobId],
    queryFn: () => getJob(activeJobId!),
    enabled: !!activeJobId,
    refetchInterval: activeJobId ? 1000 : false,
  });
  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: getModels,
    staleTime: 5000,
  });

  const currentStatus = liveStatus ?? job?.status;
  const isTerminal = currentStatus === 'done' || currentStatus === 'failed' || currentStatus === 'cancelled';
  const isLoading = !!currentStatus && !isTerminal;
  const effectiveProgress = progress ?? job?.progress ?? null;
  const displayPercent = effectiveProgress?.percent ?? 0;
  const now = useEtaNow(isLoading);
  const etaLabel = formatLiveRemainingTime(job?.estimatedRemainingMs ?? null, dataUpdatedAt, now);
  const elapsedLabel = isLoading ? formatLiveElapsedTime(job?.createdAt, now) : null;
  const progressLabel = effectiveProgress
    ? `${effectiveProgress.phase}${effectiveProgress.totalSteps > 0 ? ` · step ${effectiveProgress.step}/${effectiveProgress.totalSteps}` : ''}`
    : STATUS_LABELS[currentStatus as JobStatus] ?? currentStatus;

  if (!activeJobId) {
    const hasInstalledModel = modelsQuery.data?.hasAnyInstalled ?? false;

    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-card border border-border flex items-center justify-center mx-auto">
            <ImageOff className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Ready to create</p>
            {hasInstalledModel ? (
              <p className="text-xs text-muted-foreground/60 mt-1">
                Type a prompt in the left panel and press <kbd className="rounded bg-secondary px-1 py-0.5">Cmd+Enter</kbd> to generate your first image
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-muted-foreground/60">You need to install a model before you can generate images.</p>
                <Link href="/models" className="inline-flex items-center rounded-md border border-border px-3 py-2 text-xs text-foreground hover:bg-secondary">
                  Download a model
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background overflow-hidden">
      {/* Status bar */}
      {job && (
        <div className="px-4 py-2 border-b border-border flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          {isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
          <span>{progressLabel}</span>
          {isLoading && (
            <span className="font-mono tabular-nums">{displayPercent}%</span>
          )}
          {isLoading && job?.queuePosition != null && (
            <span>Queue #{job.queuePosition}</span>
          )}
          {job.seed != null && <span className="ml-auto">Seed: {job.seed}</span>}
          {job.loraName && (
            <span className="truncate max-w-[16rem]" title={job.loraName}>
              LoRA: {job.loraName}{job.loraScale != null ? ` (${job.loraScale.toFixed(2)})` : ''}
            </span>
          )}
          {isLoading && etaLabel && <span>ETA {etaLabel}</span>}
          {isLoading && elapsedLabel && <span>Elapsed {elapsedLabel}</span>}
          {!isLoading && job.durationMs != null && <span>{(job.durationMs / 1000).toFixed(1)}s</span>}
        </div>
      )}

      {/* Progress bar */}
      {isLoading && (
        <div className="px-4 py-3 shrink-0 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Generation progress</span>
            <span className="font-mono tabular-nums text-foreground/80">{displayPercent}%</span>
          </div>
          <Progress
            value={displayPercent}
            indeterminate={!effectiveProgress}
            className="h-1.5 bg-secondary/80"
            indicatorClassName={!effectiveProgress ? 'bg-primary/80' : undefined}
          />
        </div>
      )}

      {/* Image display */}
      <div className="flex min-h-0 flex-1 overflow-hidden p-4">
        {isLoading && (
          <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4 overflow-hidden">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            {effectiveProgress ? (
              <div className="w-full max-w-xs space-y-3 text-center">
                <p className="text-sm text-foreground font-medium">
                  {effectiveProgress.phase}
                </p>
                <p className="text-3xl font-semibold tabular-nums text-foreground">
                  {displayPercent}%
                </p>
                <Progress value={effectiveProgress.percent} className="h-2" />
                {effectiveProgress.totalSteps > 0 && effectiveProgress.phase === 'Denoising' ? (
                  <p className="text-xs text-muted-foreground">
                    Step {effectiveProgress.step} of {effectiveProgress.totalSteps}
                    {effectiveProgress.substep != null && effectiveProgress.totalSubsteps != null && effectiveProgress.totalSubsteps > 0 && (
                      <span className="ml-1 text-muted-foreground/60">
                        ({effectiveProgress.substep}/{effectiveProgress.totalSubsteps} blocks)
                      </span>
                    )}
                  </p>
                ) : null}
                {/* Phase step indicator */}
                <div className="flex flex-col items-start gap-1 text-[11px] mx-auto w-fit">
                  {PHASE_ORDER.map((label, i) => {
                    const currentIdx = getPhaseIndex(effectiveProgress.phase);
                    const isDone = i < currentIdx;
                    const isCurrent = i === currentIdx;
                    return (
                      <div key={label} className="flex items-center gap-2">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
                          isDone ? 'bg-green-400' : isCurrent ? 'bg-primary animate-pulse' : 'bg-muted-foreground/30'
                        }`} />
                        <span className={isDone ? 'text-muted-foreground/60 line-through' : isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground/40'}>
                          {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-center gap-4 text-xs text-muted-foreground">
                  {etaLabel && <span>ETA {etaLabel}</span>}
                  {elapsedLabel && <span>Elapsed {elapsedLabel}</span>}
                </div>
              </div>
            ) : (
              <div className="w-full max-w-xs space-y-3 text-center">
                <p className="text-sm text-muted-foreground">
                  {STATUS_LABELS[currentStatus as JobStatus]}
                </p>
                {job?.queuePosition != null && (
                  <p className="text-xs text-muted-foreground">
                    Queue position #{job.queuePosition}
                  </p>
                )}
                <p className="text-3xl font-semibold tabular-nums text-foreground/80">
                  0%
                </p>
                <Progress
                  indeterminate
                  className="h-2"
                  indicatorClassName="bg-primary/80"
                />
                <div className="flex justify-center gap-4 text-xs text-muted-foreground">
                  {etaLabel && <span>ETA {etaLabel}</span>}
                  {elapsedLabel && <span>Elapsed {elapsedLabel}</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {currentStatus === 'done' && job?.outputPath && (
          <div className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden">
            <img
              src={getOutputImageUrl(job.outputPath)}
              alt={job.prompt}
              className="block h-auto max-h-full w-auto max-w-full object-contain rounded-lg shadow-lg"
            />
          </div>
        )}

        {currentStatus === 'failed' && (
          <div className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden">
            <div className="text-center space-y-2">
              <p className="text-sm text-destructive">Generation failed</p>
              <p className="text-xs text-muted-foreground/70">
                Click <strong className="text-foreground">Restart</strong> in the history panel to try again, or <strong className="text-foreground">To Editor</strong> to adjust settings first.
              </p>
            </div>
          </div>
        )}

        {currentStatus === 'cancelled' && (
          <div className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden">
            <div className="text-center space-y-2">
              <p className="text-sm text-muted-foreground">Generation was stopped</p>
              <p className="text-xs text-muted-foreground/70">
                Click <strong className="text-foreground">Restart</strong> in the history panel to try again with the same settings.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Prompt display */}
      {job && (
        <div className="px-4 py-3 border-t border-border shrink-0">
          <p className="text-sm text-muted-foreground line-clamp-2">{job.prompt}</p>
        </div>
      )}
    </div>
  );
}
