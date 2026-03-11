const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export interface ProgressData {
  step: number;
  totalSteps: number;
  percent: number;
  phase: string;
}

export interface ProgressState {
  totalSteps: number;
  currentStep: number;
  currentPhase: string;
}

export function createInitialProgressState(): ProgressState {
  return {
    totalSteps: 0,
    currentStep: 0,
    currentPhase: 'Initializing',
  };
}

export function consumeProgressBuffer(
  buffer: string,
  state: ProgressState,
  onProgress: (progress: ProgressData) => void
): { remainder: string; state: ProgressState } {
  const parts = buffer.split(/[\r\n]+/);
  const remainder = parts.pop() ?? '';
  let currentState = state;

  for (const part of parts) {
    const line = stripAnsi(part).trim();
    if (!line) {
      continue;
    }

    currentState = parseProgressLine(line, currentState, onProgress);
  }

  return { remainder, state: currentState };
}

export function parseProgressLine(
  line: string,
  state: ProgressState,
  onProgress: (progress: ProgressData) => void
): ProgressState {
  if (!line) {
    return state;
  }

  const phasePatterns: Array<{ regex: RegExp; phase: string; pct: number }> = [
    { regex: /Loading VAE/i, phase: 'Loading VAE', pct: 5 },
    { regex: /Loading.*encoder/i, phase: 'Loading text encoder', pct: 15 },
    { regex: /Encoding text/i, phase: 'Encoding text', pct: 25 },
    { regex: /Loading.*transformer/i, phase: 'Loading transformer', pct: 35 },
    { regex: /Decoding image/i, phase: 'Decoding image', pct: 95 },
    { regex: /Saving/i, phase: 'Saving', pct: 98 },
  ];

  for (const { regex, phase, pct } of phasePatterns) {
    if (regex.test(line)) {
      const nextState = { ...state, currentPhase: phase };
      onProgress({
        step: nextState.currentStep,
        totalSteps: nextState.totalSteps,
        percent: pct,
        phase,
      });
      return nextState;
    }
  }

  const stepMatch = line.match(/Step\s+(\d+)\/(\d+)/i);
  if (!stepMatch) {
    return state;
  }

  const step = parseInt(stepMatch[1], 10);
  const total = parseInt(stepMatch[2], 10);
  const phase = 'Denoising';
  const percent = Math.round(40 + (step / total) * 50);
  const nextState = {
    totalSteps: total,
    currentStep: step,
    currentPhase: phase,
  };

  onProgress({
    step,
    totalSteps: total,
    percent,
    phase,
  });

  return nextState;
}

export function stripAnsi(value: string) {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}
