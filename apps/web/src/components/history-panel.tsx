'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Clock, Download, Copy, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { listJobs, getJob, createJob, cancelJob, deleteJob, downloadJobsZip, getThumbUrl, getOutputImageUrl } from '@/lib/api';
import { formatLiveElapsedTime, formatLiveRemainingTime, useEtaNow } from '@/lib/eta';
import { getModelDisplayLabel } from '@/lib/model-labels';
import type { Job, JobProgress, JobStatus } from '@/lib/types';

interface HistoryPanelProps {
  activeJobId: string | null;
  liveStatus: JobStatus | null;
  progress: JobProgress | null;
  onLoadJobToEditor: (job: Job) => void;
  onSelectJob: (jobId: string | null) => void;
}

const HISTORY_PAGE_SIZE = 20;

function isTerminalJobStatus(status: JobStatus) {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

function isActiveJobStatus(status: JobStatus) {
  return status === 'queued' || status === 'running' || status === 'saving';
}

function triggerDirectDownload(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  const segments = filename.split('/');
  link.download = segments[segments.length - 1] ?? filename;
  document.body.append(link);
  link.click();
  link.remove();
}

export function HistoryPanel({ activeJobId, liveStatus, progress, onLoadJobToEditor, onSelectJob }: HistoryPanelProps) {
  const queryClient = useQueryClient();
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [page, setPage] = useState(0);

  const { data, dataUpdatedAt, isLoading, isError, error } = useQuery({
    queryKey: ['jobs', page],
    queryFn: () => listJobs(HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE),
    refetchInterval: activeJobId ? 1000 : 5000,
    placeholderData: (previousData) => previousData,
  });
  const selectedJobQuery = useQuery({
    queryKey: ['job', activeJobId],
    queryFn: () => getJob(activeJobId!),
    enabled: activeJobId != null,
    refetchInterval: activeJobId ? 1000 : false,
  });

  const jobs = data?.jobs ?? [];
  const totalJobs = data?.total ?? 0;
  const totalPages = data
    ? Math.max(1, Math.ceil(totalJobs / HISTORY_PAGE_SIZE))
    : page + 1;
  const deletableJobs = useMemo(() => jobs.filter((job) => isTerminalJobStatus(job.status)), [jobs]);
  const deletableJobIds = useMemo(() => deletableJobs.map((job) => job.id), [deletableJobs]);
  const downloadableJobIds = useMemo(
    () => jobs
      .filter((job) => job.status === 'done' && job.outputPath)
      .map((job) => job.id),
    [jobs]
  );

  useEffect(() => {
    setSelectedJobIds((current) => {
      const filtered = current.filter((id) => deletableJobIds.includes(id));
      return filtered.length === current.length ? current : filtered;
    });
  }, [deletableJobIds]);

  useEffect(() => {
    if (data && page >= totalPages) {
      setPage(totalPages - 1);
    }
  }, [data, page, totalPages]);

  const rerunMutation = useMutation({
    mutationFn: ({ job, forceSize }: { job: Job; forceSize?: number }) =>
      createJob({
        mode: job.mode,
        prompt: job.prompt,
        model: job.model,
        ...(job.loraId ? { loraId: job.loraId, loraScale: job.loraScale ?? 1 } : {}),
        width: forceSize ?? job.width,
        height: forceSize ?? job.height,
        seed: job.seed ?? undefined,
        steps: job.steps ?? undefined,
        guidance: job.guidance ?? undefined,
        inputPaths: job.inputPaths ?? undefined,
      }),
    onSuccess: (newJob) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      onSelectJob(newJob.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (jobId: string) => deleteJob(jobId),
    onSuccess: (_, jobId) => {
      queryClient.removeQueries({ queryKey: ['job', jobId], exact: true });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setSelectedJobIds((current) => current.filter((id) => id !== jobId));

      if (activeJobId === jobId) {
        const nextJob = jobs.find((job) => job.id !== jobId);
        onSelectJob(nextJob?.id ?? null);
      }
    },
  });

  const stopMutation = useMutation({
    mutationFn: (jobId: string) => cancelJob(jobId),
    onSuccess: (job) => {
      queryClient.setQueryData(['job', job.id], job);
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (jobIds: string[]) => {
      const results = await Promise.allSettled(jobIds.map((jobId) => deleteJob(jobId)));
      const failedCount = results.filter((result) => result.status === 'rejected').length;

      if (failedCount > 0) {
        throw new Error(
          failedCount === 1
            ? 'One selected job could not be deleted'
            : `${failedCount} selected jobs could not be deleted`
        );
      }

      return jobIds;
    },
    onSuccess: (jobIds) => {
      for (const jobId of jobIds) {
        queryClient.removeQueries({ queryKey: ['job', jobId], exact: true });
      }
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setSelectedJobIds((current) => current.filter((id) => !jobIds.includes(id)));

      if (activeJobId && jobIds.includes(activeJobId)) {
        const nextJob = jobs.find((job) => !jobIds.includes(job.id));
        onSelectJob(nextJob?.id ?? null);
      }
    },
  });

  const bulkDownloadMutation = useMutation({
    mutationFn: (jobIds: string[]) => downloadJobsZip(jobIds),
  });

  const selectedJobFromPage = jobs.find((j) => j.id === activeJobId);
  const selectedJob = selectedJobFromPage ?? selectedJobQuery.data;
  const selectedJobUpdatedAt = selectedJobFromPage ? dataUpdatedAt : selectedJobQuery.dataUpdatedAt;
  const selectedStatus = selectedJob?.id === activeJobId && liveStatus
    ? liveStatus
    : selectedJob?.status;
  const selectedProgress = selectedJob?.id === activeJobId
    ? (progress ?? selectedJob?.progress ?? null)
    : (selectedJob?.progress ?? null);
  const selectedIsLoading = !!selectedStatus && selectedStatus !== 'done' && selectedStatus !== 'failed' && selectedStatus !== 'cancelled';
  const displayPercent = selectedProgress?.percent ?? 0;
  const deleteError = deleteMutation.isError ? deleteMutation.error.message : null;
  const bulkDeleteError = bulkDeleteMutation.isError ? bulkDeleteMutation.error.message : null;
  const bulkDownloadError = bulkDownloadMutation.isError ? bulkDownloadMutation.error.message : null;
  const stopError = stopMutation.isError ? stopMutation.error.message : null;
  const deleteButtonLabel = deleteMutation.isPending ? 'Deleting...' : 'Delete';
  const stopButtonLabel = stopMutation.isPending ? 'Stopping...' : 'Stop';
  const bulkDownloadButtonLabel = bulkDownloadMutation.isPending ? 'Zipping...' : 'Download';
  const canDeleteSelected = !!selectedJob && !!selectedStatus && isTerminalJobStatus(selectedStatus);
  const canStopSelected = !!selectedJob && !!selectedStatus && isActiveJobStatus(selectedStatus);
  const selectedCount = selectedJobIds.length;
  const selectedDownloadableJobIds = selectedJobIds.filter((jobId) => downloadableJobIds.includes(jobId));
  const selectedDownloadableCount = selectedDownloadableJobIds.length;
  const allDeletableSelected = deletableJobIds.length > 0 && selectedCount === deletableJobIds.length;
  const shouldTickClock = jobs.some((job) => isActiveJobStatus(job.status) || job.estimatedRemainingMs != null)
    || !!selectedJob && (isActiveJobStatus(selectedJob.status) || selectedJob.estimatedRemainingMs != null);
  const now = useEtaNow(shouldTickClock);
  const selectedEta = formatLiveRemainingTime(selectedJob?.estimatedRemainingMs ?? null, selectedJobUpdatedAt, now);
  const selectedElapsed = selectedJob && selectedStatus && isActiveJobStatus(selectedStatus)
    ? formatLiveElapsedTime(selectedJob.createdAt, now)
    : null;

  const selectedActions = useMemo(() => {
    if (!selectedJob || !selectedStatus) return [];

    if (selectedStatus === 'failed' || selectedStatus === 'cancelled') {
      return [
        {
          key: 'restart',
          label: 'Restart',
          icon: RotateCcw,
          onClick: () => rerunMutation.mutate({ job: selectedJob }),
          disabled: rerunMutation.isPending,
          title: 'Restart this generation with the same settings',
        },
        {
          key: 'edit',
          label: 'To Editor',
          icon: Copy,
          onClick: () => onLoadJobToEditor(selectedJob),
          disabled: false,
          title: 'Load settings into the editor to adjust before regenerating',
        },
      ];
    }

    if (selectedStatus !== 'done') return [];

    return [
      {
        key: 'rerun-1024',
        label: '1024',
        icon: RefreshCw,
        onClick: () => rerunMutation.mutate({ job: selectedJob, forceSize: 1024 }),
        disabled: rerunMutation.isPending,
        title: 'Rerun at 1024×1024 with same seed',
      },
      {
        key: 'edit',
        label: 'To Editor',
        icon: Copy,
        onClick: () => onLoadJobToEditor(selectedJob),
        disabled: false,
        title: 'Load this job into the left editor',
      },
    ];
  }, [onLoadJobToEditor, rerunMutation, selectedJob, selectedStatus]);

  function handleDeleteSelected() {
    if (!selectedJob || !canDeleteSelected) return;

    if (selectedStatus === 'done') {
      const confirmed = window.confirm('Delete this generated image and remove it from history?');
      if (!confirmed) return;
    }

    deleteMutation.mutate(selectedJob.id);
  }

  function handleStopSelected() {
    if (!selectedJob || !canStopSelected) return;

    const confirmed = window.confirm(
      selectedStatus === 'queued'
        ? 'Stop this queued job and mark it as cancelled?'
        : 'Stop this active generation?'
    );
    if (!confirmed) return;

    stopMutation.mutate(selectedJob.id);
  }

  function toggleJobSelection(jobId: string) {
    setSelectedJobIds((current) => (
      current.includes(jobId)
        ? current.filter((id) => id !== jobId)
        : [...current, jobId]
    ));
  }

  function handleJobClick(jobId: string) {
    onSelectJob(jobId === activeJobId ? null : jobId);
  }

  function toggleSelectAllJobs() {
    setSelectedJobIds(allDeletableSelected ? [] : deletableJobIds);
  }

  function handleBulkDelete() {
    if (selectedJobIds.length === 0) return;

    const confirmed = window.confirm(
      selectedJobIds.length === 1
        ? 'Delete the selected job from history?'
        : `Delete ${selectedJobIds.length} selected jobs from history?`
    );
    if (!confirmed) return;

    bulkDeleteMutation.mutate(selectedJobIds);
  }

  function handleBulkDownload() {
    if (selectedDownloadableJobIds.length === 0) return;

    if (selectedJobIds.length === 1 && selectedDownloadableJobIds.length === 1) {
      const singleJob = jobs.find((job) => job.id === selectedDownloadableJobIds[0]);
      if (singleJob?.outputPath) {
        triggerDirectDownload(getOutputImageUrl(singleJob.outputPath), singleJob.outputPath);
        return;
      }
    }

    bulkDownloadMutation.mutate(selectedDownloadableJobIds);
  }

  const paginationRef = useRef<HTMLDivElement>(null);
  const [paginationWidth, setPaginationWidth] = useState(0);

  useEffect(() => {
    const el = paginationRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setPaginationWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visiblePages = useMemo(() => {
    if (totalPages <= 1) return [0];

    const BUTTON_WIDTH = 36;
    const GAP = 4;
    const ARROW_SPACE = (BUTTON_WIDTH + GAP) * 2;
    const available = Math.max(0, paginationWidth - ARROW_SPACE);
    const maxSlots = Math.max(3, Math.floor(available / (BUTTON_WIDTH + GAP)));

    if (totalPages <= maxSlots) {
      return Array.from({ length: totalPages }, (_, i) => i);
    }

    const slots: (number | 'ellipsis-start' | 'ellipsis-end')[] = [];
    const sideCount = Math.floor((maxSlots - 3) / 2);

    slots.push(0);

    let startPage = Math.max(1, page - sideCount);
    let endPage = Math.min(totalPages - 2, page + sideCount);

    if (startPage <= 1) {
      endPage = Math.min(totalPages - 2, maxSlots - 2);
      startPage = 1;
    }
    if (endPage >= totalPages - 2) {
      startPage = Math.max(1, totalPages - maxSlots + 1);
      endPage = totalPages - 2;
    }

    if (startPage > 1) slots.push('ellipsis-start');
    for (let i = startPage; i <= endPage; i++) slots.push(i);
    if (endPage < totalPages - 2) slots.push('ellipsis-end');

    slots.push(totalPages - 1);

    return slots;
  }, [totalPages, page, paginationWidth]);

  useEffect(() => {
    async function handleArrowNavigation(event: KeyboardEvent) {
      if (!activeJobId) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
      ) {
        return;
      }

      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }

      const currentIndex = jobs.findIndex((job) => job.id === activeJobId);
      if (currentIndex === -1) {
        return;
      }

      event.preventDefault();

      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const nextIndex = currentIndex + direction;
      if (nextIndex >= 0 && nextIndex < jobs.length) {
        onSelectJob(jobs[nextIndex]!.id);
        return;
      }

      const nextPage = page + direction;
      if (nextPage < 0 || nextPage >= totalPages) {
        return;
      }

      try {
        const nextPageData = await queryClient.fetchQuery({
          queryKey: ['jobs', nextPage],
          queryFn: () => listJobs(HISTORY_PAGE_SIZE, nextPage * HISTORY_PAGE_SIZE),
        });

        if (nextPageData.jobs.length === 0) {
          return;
        }

        setPage(nextPage);
        const boundaryJob = direction > 0
          ? nextPageData.jobs[0]
          : nextPageData.jobs[nextPageData.jobs.length - 1];
        onSelectJob(boundaryJob?.id ?? null);
      } catch {
        // Ignore key navigation failures and leave the current selection in place.
      }
    }

    window.addEventListener('keydown', handleArrowNavigation);
    return () => {
      window.removeEventListener('keydown', handleArrowNavigation);
    };
  }, [activeJobId, jobs, onSelectJob, page, queryClient, totalPages]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden border-l border-border bg-card">
      {/* Detail panel for selected job */}
      {selectedJob && (
        <div className="shrink-0 border-b border-border p-4 space-y-3">
          <h3 className="text-xs text-muted-foreground uppercase tracking-wider">Details</h3>

          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <span className={selectedStatus === 'done' ? 'text-green-400' : selectedStatus === 'failed' ? 'text-destructive' : selectedStatus === 'cancelled' ? 'text-muted-foreground' : 'text-foreground'}>
                {selectedStatus}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Size</span>
              <span>{selectedJob.width} × {selectedJob.height}</span>
            </div>
            {selectedJob.seed != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Seed</span>
                <span className="font-mono">{selectedJob.seed}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Model</span>
              <span>{getModelDisplayLabel(selectedJob.model)}</span>
            </div>
            {selectedJob.loraName && (
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">LoRA</span>
                <span className="truncate text-right" title={selectedJob.loraName}>
                  {selectedJob.loraName}
                  {selectedJob.loraScale != null ? ` (${selectedJob.loraScale.toFixed(2)})` : ''}
                </span>
              </div>
            )}
            {selectedElapsed && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Elapsed</span>
                <span>{selectedElapsed}</span>
              </div>
            )}
            {selectedJob.durationMs != null && !selectedElapsed && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Duration</span>
                <span>{(selectedJob.durationMs / 1000).toFixed(1)}s</span>
              </div>
            )}
            {selectedJob.queuePosition != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Queue</span>
                <span>#{selectedJob.queuePosition}</span>
              </div>
            )}
            {selectedEta && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">ETA</span>
                <span>{selectedEta}</span>
              </div>
            )}
            {selectedJob.mode !== 'txt2img' && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mode</span>
                <span>{selectedJob.mode}</span>
              </div>
            )}
          </div>

          {selectedIsLoading && (
            <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {selectedProgress
                    ? selectedProgress.phase
                    : selectedStatus === 'queued'
                      ? 'Queued'
                      : 'Preparing generation'}
                </span>
                <span className="font-mono tabular-nums text-foreground/80">
                  {displayPercent}%
                </span>
              </div>
              <Progress
                value={displayPercent}
                indeterminate={!selectedProgress}
                className="h-1.5"
                indicatorClassName={!selectedProgress ? 'bg-primary/80' : undefined}
              />
              {selectedProgress?.totalSteps ? (
                <p className="text-[11px] text-muted-foreground">
                  Step {selectedProgress.step} of {selectedProgress.totalSteps}
                  {selectedProgress.phase === 'Denoising' && selectedProgress.substep != null && selectedProgress.totalSubsteps != null && selectedProgress.totalSubsteps > 0
                    ? ` · ${selectedProgress.substep}/${selectedProgress.totalSubsteps} blocks`
                    : ''}
                </p>
              ) : null}
              {selectedEta && (
                <p className="text-[11px] text-muted-foreground">
                  ETA {selectedEta}
                </p>
              )}
              {selectedElapsed && (
                <p className="text-[11px] text-muted-foreground">
                  Elapsed {selectedElapsed}
                </p>
              )}
            </div>
          )}

          {/* Actions */}
          {stopError && (
            <p className="text-xs text-destructive">{stopError}</p>
          )}

          {bulkDeleteError && (
            <p className="text-xs text-destructive">{bulkDeleteError}</p>
          )}

          {bulkDownloadError && (
            <p className="text-xs text-destructive">{bulkDownloadError}</p>
          )}

          {deleteError && (
            <p className="text-xs text-destructive">{deleteError}</p>
          )}

          {(selectedActions.length > 0 || canDeleteSelected || canStopSelected) && (
            <div className="flex flex-wrap gap-1.5">
              {canStopSelected && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="text-xs flex-1"
                  onClick={handleStopSelected}
                  disabled={stopMutation.isPending || deleteMutation.isPending || bulkDeleteMutation.isPending || bulkDownloadMutation.isPending}
                  title="Stop this job"
                >
                  <Square className="h-3 w-3 mr-1" />
                  {stopButtonLabel}
                </Button>
              )}
              {selectedActions.map((action) => (
                <Button
                  key={action.key}
                  variant="secondary"
                  size="sm"
                  className="text-xs flex-1"
                  onClick={action.onClick}
                  disabled={action.disabled || deleteMutation.isPending || stopMutation.isPending || bulkDeleteMutation.isPending || bulkDownloadMutation.isPending}
                  title={action.title}
                >
                  <action.icon className="h-3 w-3 mr-1" />
                  {action.label}
                </Button>
              ))}
              {selectedStatus === 'done' && selectedJob?.outputPath && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="text-xs"
                  asChild
                >
                  <a
                    href={getOutputImageUrl(selectedJob.outputPath)}
                    download
                    title="Download"
                  >
                    <Download className="h-3 w-3" />
                  </a>
                </Button>
              )}
              {canDeleteSelected && (
                <Button
                  variant="destructive"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={handleDeleteSelected}
                  disabled={deleteMutation.isPending || stopMutation.isPending || bulkDeleteMutation.isPending || bulkDownloadMutation.isPending}
                  title={selectedStatus === 'done' ? 'Delete image' : selectedStatus === 'cancelled' ? 'Delete stopped job' : 'Delete failed job'}
                  aria-label={selectedStatus === 'done' ? 'Delete image' : selectedStatus === 'cancelled' ? 'Delete stopped job' : 'Delete failed job'}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="shrink-0 border-b border-border bg-card px-4 py-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground">
            <Clock className="h-3 w-3" />
            History
          </h3>
          {selectedCount > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {selectedCount} selected
            </span>
          )}
        </div>
        {deletableJobIds.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={toggleSelectAllJobs}
              disabled={bulkDeleteMutation.isPending || bulkDownloadMutation.isPending}
            >
              {allDeletableSelected ? 'Clear all' : 'Select all'}
            </Button>
            {selectedCount > 0 && (
              <>
                {selectedDownloadableCount > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={handleBulkDownload}
                    disabled={bulkDownloadMutation.isPending || bulkDeleteMutation.isPending || deleteMutation.isPending || stopMutation.isPending}
                  >
                    <Download className="mr-1 h-3 w-3" />
                    {bulkDownloadButtonLabel}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={handleBulkDelete}
                  disabled={bulkDeleteMutation.isPending || bulkDownloadMutation.isPending || deleteMutation.isPending || stopMutation.isPending}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  {bulkDeleteMutation.isPending ? 'Deleting...' : 'Delete'}
                </Button>
              </>
            )}
          </div>
        )}
        {selectedCount > 0 && bulkDownloadError && (
          <p className="mt-2 text-xs text-destructive">{bulkDownloadError}</p>
        )}
        {selectedCount > 0 && bulkDeleteError && (
          <p className="mt-2 text-xs text-destructive">{bulkDeleteError}</p>
        )}
      </div>

      {/* History list */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">

        {isLoading && (
          <div className="p-4 text-xs text-muted-foreground">Loading...</div>
        )}

        {isError && !isLoading && jobs.length === 0 && (
          <div className="p-4 space-y-2">
            <p className="text-xs text-destructive">
              {error.message}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => queryClient.invalidateQueries({ queryKey: ['jobs'] })}
            >
              Retry
            </Button>
          </div>
        )}

        {jobs.length === 0 && !isLoading && !isError && (
          <div className="p-4 text-xs text-muted-foreground">
            Your generated images will appear here.
          </div>
        )}

        <div className="space-y-1 px-2 pb-4">
          {jobs.map((job) => {
            const rowEta = formatLiveRemainingTime(job.estimatedRemainingMs, dataUpdatedAt, now);
            const rowElapsed = isActiveJobStatus(job.status)
              ? formatLiveElapsedTime(job.createdAt, now)
              : null;

            return (
              <div
                key={job.id}
                className={`w-full text-left rounded-lg p-2 transition-colors ${
                  job.id === activeJobId
                    ? 'bg-accent'
                    : 'hover:bg-accent/50'
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="pt-4">
                    {isTerminalJobStatus(job.status) ? (
                      <input
                        type="checkbox"
                        checked={selectedJobIds.includes(job.id)}
                        onChange={() => toggleJobSelection(job.id)}
                        className="h-3.5 w-3.5 rounded border-border bg-background accent-[hsl(var(--primary))]"
                        aria-label={`Select ${job.prompt}`}
                      />
                    ) : (
                      <div className="h-3.5 w-3.5 rounded border border-border/60 bg-secondary/50" />
                    )}
                  </div>

                  <button
                    onClick={() => handleJobClick(job.id)}
                    className="flex min-w-0 flex-1 gap-2 text-left"
                  >
                    {/* Thumbnail */}
                    {job.thumbPath && job.status === 'done' ? (
                      <img
                        src={getThumbUrl(job.thumbPath)}
                        alt=""
                        className="w-12 h-12 rounded object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded bg-secondary shrink-0 flex items-center justify-center">
                        <span className="text-xs text-muted-foreground">
                          {job.status === 'failed' ? '!' : job.status === 'cancelled' ? '■' : job.status === 'done' ? '?' : '...'}
                        </span>
                      </div>
                    )}

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-xs" title={job.prompt}>
                        {job.prompt}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        {job.queuePosition != null && (
                          <span className="text-[10px] text-foreground/80">
                            Queue #{job.queuePosition}
                          </span>
                        )}
                        {rowEta && (
                          <span className="text-[10px] text-muted-foreground">
                            ETA {rowEta}
                          </span>
                        )}
                        {rowElapsed && (
                          <span className="text-[10px] text-muted-foreground">
                            Elapsed {rowElapsed}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {job.width}×{job.height}
                        </span>
                        {job.seed != null && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            #{job.seed}
                          </span>
                        )}
                        {job.durationMs != null && !rowElapsed && (
                          <span className="text-[10px] text-muted-foreground">
                            {(job.durationMs / 1000).toFixed(1)}s
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

      </div>

      {totalPages > 1 && (
        <div ref={paginationRef} className="shrink-0 overflow-hidden border-t border-border bg-card/95 px-3 py-2.5 backdrop-blur">
          <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground mb-2">
            <span className="truncate">
              {totalJobs} image{totalJobs === 1 ? '' : 's'}
            </span>
            <span className="shrink-0 tabular-nums">
              {page + 1} / {totalPages}
            </span>
          </div>
          <div className="flex items-center justify-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              type="button"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {visiblePages.map((slot, i) =>
              typeof slot === 'string' ? (
                <span key={slot} className="px-1 text-[11px] text-muted-foreground/50 select-none">
                  …
                </span>
              ) : (
                <Button
                  key={slot}
                  variant={page === slot ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 min-w-8 shrink-0 rounded-md px-2 text-[11px] tabular-nums"
                  type="button"
                  onClick={() => setPage(slot)}
                >
                  {slot + 1}
                </Button>
              )
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
              disabled={page >= totalPages - 1}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
