'use client';

import { useEffect, useState } from 'react';
import { formatElapsedTime, formatRemainingTime } from './format';

export function getLiveRemainingMs(remainingMs: number | null, snapshotAtMs: number, nowMs: number) {
  if (remainingMs == null) {
    return null;
  }

  const elapsedMs = snapshotAtMs > 0 ? Math.max(0, nowMs - snapshotAtMs) : 0;
  return Math.max(0, remainingMs - elapsedMs);
}

export function formatLiveRemainingTime(remainingMs: number | null, snapshotAtMs: number, nowMs: number) {
  return formatRemainingTime(getLiveRemainingMs(remainingMs, snapshotAtMs, nowMs));
}

export function getLiveElapsedMs(createdAt: string | null | undefined, nowMs: number) {
  if (!createdAt) {
    return null;
  }

  const normalizedCreatedAt = normalizeUtcTimestamp(createdAt);
  const createdAtMs = Date.parse(normalizedCreatedAt);
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }

  return Math.max(0, nowMs - createdAtMs);
}

export function formatLiveElapsedTime(createdAt: string | null | undefined, nowMs: number) {
  return formatElapsedTime(getLiveElapsedMs(createdAt, nowMs));
}

function normalizeUtcTimestamp(value: string) {
  const withTimeSeparator = value.includes('T') ? value : value.replace(' ', 'T');
  return withTimeSeparator.endsWith('Z') ? withTimeSeparator : `${withTimeSeparator}Z`;
}

export function useEtaNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }

    setNow(Date.now());
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled]);

  return now;
}
