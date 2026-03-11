function formatClockDuration(durationMs: number | null, rounding: 'ceil' | 'floor') {
  if (durationMs == null) {
    return null;
  }

  const totalSeconds = Math.max(0, rounding === 'ceil' ? Math.ceil(durationMs / 1000) : Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingMinutes = minutes % 60;
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${remainingMinutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatRemainingTime(remainingMs: number | null) {
  return formatClockDuration(remainingMs, 'ceil');
}

export function formatElapsedTime(elapsedMs: number | null) {
  return formatClockDuration(elapsedMs, 'floor');
}
