'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SettingsRail } from '@/components/settings-rail';
import { Canvas } from '@/components/canvas';
import { HistoryPanel } from '@/components/history-panel';
import { useAppSettings } from '@/components/settings-provider';
import { subscribeToJob } from '@/lib/api';
import type { EditorDraft, Job, JobProgress, JobStatus } from '@/lib/types';

const MIN_LEFT_PANE = 280;
const MAX_LEFT_PANE = 520;
const MIN_RIGHT_PANE = 280;
const MAX_RIGHT_PANE = 520;
const MIN_CENTER_PANE = 420;

type DragSide = 'left' | 'right';

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default function Home() {
  const queryClient = useQueryClient();
  const { settings, setSetting } = useAppSettings();
  const containerRef = useRef<HTMLElement>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<JobStatus | null>(null);
  const [liveProgress, setLiveProgress] = useState<JobProgress | null>(null);
  const [editorDraft, setEditorDraft] = useState<EditorDraft | null>(null);
  const [leftPaneWidth, setLeftPaneWidth] = useState(settings.leftPaneWidth);
  const [rightPaneWidth, setRightPaneWidth] = useState(settings.rightPaneWidth);
  const [draggingSide, setDraggingSide] = useState<DragSide | null>(null);
  const leftPaneWidthRef = useRef(leftPaneWidth);
  const rightPaneWidthRef = useRef(rightPaneWidth);

  const handleJobCreated = useCallback((jobId: string) => {
    if (settings.autoSelectNewJobs) {
      setActiveJobId(jobId);
    }
  }, [settings.autoSelectNewJobs]);

  const handleSelectJob = useCallback((jobId: string | null) => {
    setActiveJobId(jobId);
  }, []);

  const handleLoadJobToEditor = useCallback((job: Job) => {
    setEditorDraft({
      mode: job.mode,
      prompt: job.prompt,
      model: job.model,
      loraId: job.loraId,
      loraScale: job.loraScale,
      width: job.width,
      height: job.height,
      seed: job.seed,
      steps: job.steps,
      guidance: job.guidance,
      inputPaths: job.inputPaths,
    });
  }, []);

  useEffect(() => {
    leftPaneWidthRef.current = leftPaneWidth;
  }, [leftPaneWidth]);

  useEffect(() => {
    if (settings.leftPaneWidth !== leftPaneWidth) {
      setLeftPaneWidth(settings.leftPaneWidth);
    }
  }, [leftPaneWidth, settings.leftPaneWidth]);

  useEffect(() => {
    rightPaneWidthRef.current = rightPaneWidth;
  }, [rightPaneWidth]);

  useEffect(() => {
    if (settings.rightPaneWidth !== rightPaneWidth) {
      setRightPaneWidth(settings.rightPaneWidth);
    }
  }, [rightPaneWidth, settings.rightPaneWidth]);

  useEffect(() => {
    if (settings.leftPaneWidth !== leftPaneWidth) {
      setSetting('leftPaneWidth', leftPaneWidth);
    }
  }, [leftPaneWidth, setSetting, settings.leftPaneWidth]);

  useEffect(() => {
    if (settings.rightPaneWidth !== rightPaneWidth) {
      setSetting('rightPaneWidth', rightPaneWidth);
    }
  }, [rightPaneWidth, setSetting, settings.rightPaneWidth]);

  useEffect(() => {
    if (!activeJobId) {
      setLiveStatus(null);
      setLiveProgress(null);
      return;
    }

    setLiveStatus(null);
    setLiveProgress(null);

    return subscribeToJob(activeJobId, (event) => {
      if (event.type === 'status') {
        setLiveStatus(event.data.status);
        if (event.data.status === 'failed' || event.data.status === 'cancelled') {
          setLiveProgress(null);
        }

        queryClient.setQueryData<Job | undefined>(['job', activeJobId], (currentJob) =>
          currentJob ? { ...currentJob, status: event.data.status } : currentJob
        );

        if (
          event.data.status === 'running' ||
          event.data.status === 'saving' ||
          event.data.status === 'failed' ||
          event.data.status === 'cancelled'
        ) {
          queryClient.invalidateQueries({ queryKey: ['jobs'] });
        }
      }

      if (event.type === 'progress') {
        setLiveProgress(event.data);
      }

      if (event.type === 'done') {
        setLiveStatus(event.data.status);
        setLiveProgress(null);
        queryClient.setQueryData(['job', activeJobId], event.data);
        queryClient.invalidateQueries({ queryKey: ['jobs'] });
      }
    });
  }, [activeJobId, queryClient]);

  useEffect(() => {
    if (!draggingSide) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      if (draggingSide === 'left') {
        const maxLeft = Math.min(MAX_LEFT_PANE, rect.width - rightPaneWidthRef.current - MIN_CENTER_PANE);
        setLeftPaneWidth(clamp(event.clientX - rect.left, MIN_LEFT_PANE, maxLeft));
      } else {
        const maxRight = Math.min(MAX_RIGHT_PANE, rect.width - leftPaneWidthRef.current - MIN_CENTER_PANE);
        setRightPaneWidth(clamp(rect.right - event.clientX, MIN_RIGHT_PANE, maxRight));
      }
    };

    const handlePointerUp = () => {
      setDraggingSide(null);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [draggingSide]);

  return (
    <main ref={containerRef} className="flex h-full min-h-0 overflow-hidden">
      <div
        className="h-full shrink-0"
        style={{ width: leftPaneWidth }}
      >
        <SettingsRail
          draft={editorDraft}
          onJobCreated={handleJobCreated}
        />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize settings panel"
        className="h-full w-2 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/40"
        onPointerDown={() => setDraggingSide('left')}
      />
      <div className="min-w-0 flex-1 h-full min-h-0">
        <Canvas
          activeJobId={activeJobId}
          liveStatus={liveStatus}
          progress={liveProgress}
        />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize history panel"
        className="h-full w-2 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/40"
        onPointerDown={() => setDraggingSide('right')}
      />
      <div
        className="h-full shrink-0"
        style={{ width: rightPaneWidth }}
      >
        <HistoryPanel
          activeJobId={activeJobId}
          liveStatus={liveStatus}
          progress={liveProgress}
          onLoadJobToEditor={handleLoadJobToEditor}
          onSelectJob={handleSelectJob}
        />
      </div>
    </main>
  );
}
