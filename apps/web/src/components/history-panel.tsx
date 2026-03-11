'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Download, Copy, Maximize2, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { listJobs, getJob, createJob, cancelJob, deleteJob, downloadJobsZip, getThumbUrl, getOutputImageUrl } from '@/lib/api';
import { formatLiveElapsedTime, formatLiveRemainingTime, useEtaNow } from '@/lib/eta';
import type { Job, JobProgress, JobStatus } from '@/lib/types';

interface HistoryPanelProps {
  activeJobId: string | null;
  liveStatus: JobStatus | null;
  progress: JobProgress | null;
  onLoadJobToEditor: (job: Job) => void;
  onSelectJob: (jobId: string | null) => void;
}

const HISTORY_PAGE_SIZE = 20;
const MAX_VISIBLE_PAGE_BUTTONS = 7;

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
    mutationFn: (job: Job) =>
      createJob({
        mode: job.mode,
        prompt: job.prompt,
        width: 1024,
        height: 1024,
        seed: job.seed ?? undefined,
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

    if (selectedStatus === 'failed') {
      return [
        {
          key: 'edit',
          label: 'To Editor',
          icon: Copy,
          onClick: () => onLoadJobToEditor(selectedJob),
          disabled: false,
          title: 'Load this failed job into the left editor',
        },
      ];
    }

    if (selectedStatus !== 'done') return [];

    return [
      {
        key: 'rerun-1024',
        label: '1024',
        icon: Maximize2,
        onClick: () => rerunMutation.mutate(selectedJob),
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

    const confirmed = window.confirm(
      selectedStatus === 'done'
        ? 'Delete this generated image and remove it from history?'
        : selectedStatus === 'cancelled'
          ? 'Delete this stopped job from history?'
          : 'Delete this failed generation from history?'
    );
    if (!confirmed) return;

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

  const visiblePageButtons = useMemo(() => {
    if (totalPages <= MAX_VISIBLE_PAGE_BUTTONS) {
      return Array.from({ length: totalPages }, (_, index) => index);
    }

    const halfWindow = Math.floor(MAX_VISIBLE_PAGE_BUTTONS / 2);
    let start = Math.max(0, page - halfWindow);
    let end = Math.min(totalPages - 1, start + MAX_VISIBLE_PAGE_BUTTONS - 1);

    if (end - start + 1 < MAX_VISIBLE_PAGE_BUTTONS) {
      start = Math.max(0, end - MAX_VISIBLE_PAGE_BUTTONS + 1);
    }

    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }, [page, totalPages]);

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
    <div className="flex h-full w-full min-w-0 flex-col overflow-x-hidden border-l border-border bg-card">
      {/* Detail panel for selected job */}
      {selectedJob && (
        <div className="p-4 border-b border-border space-y-3">
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
              <span>{selectedJob.model}</span>
            </div>
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

      {/* History list */}
      <div className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto">
        <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-4 py-3 backdrop-blur">
          <div className="flex items-center justify-between">
            <h3 className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1">
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
                      <Download className="h-3 w-3 mr-1" />
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
                    <Trash2 className="h-3 w-3 mr-1" />
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
            No generations yet. Create your first image!
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
                    onClick={() => onSelectJob(job.id)}
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

        {totalPages > 1 && (
          <div className="border-t border-border px-4 py-3">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>
                Page {page + 1} of {totalPages}
              </span>
              <span>
                {totalJobs} image{totalJobs === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                type="button"
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={page === 0}
              >
                Prev
              </Button>
              {visiblePageButtons[0] !== 0 && (
                <>
                  <Button
                    variant={page === 0 ? 'default' : 'secondary'}
                    size="sm"
                    className="h-7 min-w-7 px-2 text-[11px]"
                    type="button"
                    onClick={() => setPage(0)}
                  >
                    1
                  </Button>
                  {visiblePageButtons[0] > 1 && (
                    <span className="px-1 text-[11px] text-muted-foreground">...</span>
                  )}
                </>
              )}
              {visiblePageButtons.map((pageIndex) => (
                <Button
                  key={pageIndex}
                  variant={page === pageIndex ? 'default' : 'secondary'}
                  size="sm"
                  className="h-7 min-w-7 px-2 text-[11px]"
                  type="button"
                  onClick={() => setPage(pageIndex)}
                >
                  {pageIndex + 1}
                </Button>
              ))}
              {visiblePageButtons[visiblePageButtons.length - 1] !== totalPages - 1 && (
                <>
                  {visiblePageButtons[visiblePageButtons.length - 1] < totalPages - 2 && (
                    <span className="px-1 text-[11px] text-muted-foreground">...</span>
                  )}
                  <Button
                    variant={page === totalPages - 1 ? 'default' : 'secondary'}
                    size="sm"
                    className="h-7 min-w-7 px-2 text-[11px]"
                    type="button"
                    onClick={() => setPage(totalPages - 1)}
                  >
                    {totalPages}
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                type="button"
                onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
                disabled={page >= totalPages - 1}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
