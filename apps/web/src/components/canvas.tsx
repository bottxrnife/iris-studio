'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, ImageOff } from 'lucide-react';
import { getJob, getOutputImageUrl } from '@/lib/api';
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
  running: 'Generating...',
  saving: 'Saving...',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

export function Canvas({ activeJobId, liveStatus, progress }: CanvasProps) {
  const { data: job, dataUpdatedAt } = useQuery({
    queryKey: ['job', activeJobId],
    queryFn: () => getJob(activeJobId!),
    enabled: !!activeJobId,
    refetchInterval: activeJobId ? 1000 : false,
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
    ? `${effectiveProgress.phase}${effectiveProgress.totalSteps > 0 ? ` (step ${effectiveProgress.step}/${effectiveProgress.totalSteps})` : ''}`
    : STATUS_LABELS[currentStatus as JobStatus] ?? currentStatus;

  if (!activeJobId) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-card border border-border flex items-center justify-center mx-auto">
            <ImageOff className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">No image yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Write a prompt and press ⌘↵ to generate
            </p>
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
              <div className="w-full max-w-xs space-y-2 text-center">
                <p className="text-sm text-foreground font-medium">
                  {effectiveProgress.phase}
                </p>
                <p className="text-3xl font-semibold tabular-nums text-foreground">
                  {displayPercent}%
                </p>
                <Progress value={effectiveProgress.percent} className="h-2" />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {effectiveProgress.totalSteps > 0
                      ? `Step ${effectiveProgress.step} of ${effectiveProgress.totalSteps}`
                      : effectiveProgress.phase}
                  </span>
                  <span className="font-mono tabular-nums">{effectiveProgress.percent}%</span>
                </div>
                {etaLabel && (
                  <p className="text-xs text-muted-foreground">
                    ETA {etaLabel}
                  </p>
                )}
                {elapsedLabel && (
                  <p className="text-xs text-muted-foreground">
                    Elapsed {elapsedLabel}
                  </p>
                )}
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
                {etaLabel && (
                  <p className="text-xs text-muted-foreground">
                    ETA {etaLabel}
                  </p>
                )}
                {elapsedLabel && (
                  <p className="text-xs text-muted-foreground">
                    Elapsed {elapsedLabel}
                  </p>
                )}
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
              {job?.metadata && (
                <p className="text-xs text-muted-foreground max-w-md">
                  {JSON.stringify(job.metadata)}
                </p>
              )}
            </div>
          </div>
        )}

        {currentStatus === 'cancelled' && (
          <div className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden">
            <div className="text-center space-y-2">
              <p className="text-sm text-muted-foreground">Generation stopped</p>
              <p className="text-xs text-muted-foreground/70">
                You can delete it from history or rerun it later.
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
