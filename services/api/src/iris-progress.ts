const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export interface ProgressData {
  step: number;
  totalSteps: number;
  percent: number;
  phase: string;
  substep: number;
  totalSubsteps: number;
}

export interface ProgressState {
  totalSteps: number;
  currentStep: number;
  currentPhase: string;
  substepCount: number;
  estimatedTotalSubsteps: number;
  phaseTimingsMs: Map<string, number>;
  denoisingStartedAt: number | null;
  lastPhaseStartedAt: number | null;
}

const PHASE_WEIGHT_BEFORE_DENOISING = 0.15;
const PHASE_WEIGHT_DENOISING = 0.75;
const PHASE_WEIGHT_AFTER_DENOISING = 0.10;

export function createInitialProgressState(): ProgressState {
  return {
    totalSteps: 0,
    currentStep: 0,
    currentPhase: 'Initializing',
    substepCount: 0,
    estimatedTotalSubsteps: 0,
    phaseTimingsMs: new Map(),
    denoisingStartedAt: null,
    lastPhaseStartedAt: null,
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

  if (remainder) {
    const cleanRemainder = stripAnsi(remainder);
    currentState = parsePartialLine(cleanRemainder, currentState, onProgress);
  }

  return { remainder, state: currentState };
}

function parsePartialLine(
  partial: string,
  state: ProgressState,
  onProgress: (progress: ProgressData) => void
): ProgressState {
  if (!partial || state.currentStep <= 0) {
    return state;
  }

  const stepMatch = partial.match(/Step\s+(\d+)\/(\d+)\s*(.*)/i);
  if (stepMatch) {
    const trailingChars = (stepMatch[3] ?? '').replace(/[^dDsSfF]/g, '');
    if (trailingChars.length > state.substepCount) {
      const nextState = { ...state, substepCount: trailingChars.length };
      emitDenoisingProgress(nextState, onProgress);
      return nextState;
    }
    return state;
  }

  if (state.currentPhase !== 'Denoising') {
    return state;
  }

  const substepChars = partial.replace(/[^dDsSfF]/g, '');
  if (substepChars.length > state.substepCount) {
    const nextState = { ...state, substepCount: substepChars.length };
    emitDenoisingProgress(nextState, onProgress);
    return nextState;
  }

  return state;
}

export function parseProgressLine(
  line: string,
  state: ProgressState,
  onProgress: (progress: ProgressData) => void
): ProgressState {
  if (!line) {
    return state;
  }

  const now = Date.now();

  const phaseStartMatch = line.match(/^([A-Z][a-z ]+)\.\.\.$/);
  if (phaseStartMatch) {
    const phase = phaseStartMatch[1].trim();
    const nextState = {
      ...state,
      currentPhase: phase,
      lastPhaseStartedAt: now,
    };

    const pct = getPreDenoisingPercent(phase);
    onProgress({
      step: nextState.currentStep,
      totalSteps: nextState.totalSteps,
      percent: pct,
      phase,
      substep: 0,
      totalSubsteps: 0,
    });
    return nextState;
  }

  const phaseDoneMatch = line.match(/^([A-Z][a-z ]+)\.\.\.?\s+done\s+\((\d+(?:\.\d+)?)s\)/);
  if (phaseDoneMatch) {
    const phase = phaseDoneMatch[1].trim();
    const elapsedSec = parseFloat(phaseDoneMatch[2]);
    const nextState = { ...state };
    nextState.phaseTimingsMs = new Map(state.phaseTimingsMs);
    nextState.phaseTimingsMs.set(phase.toLowerCase(), Math.round(elapsedSec * 1000));
    nextState.lastPhaseStartedAt = null;
    return nextState;
  }

  if (/^Denoising\s+\(/i.test(line)) {
    const nextState = {
      ...state,
      currentPhase: 'Denoising',
      denoisingStartedAt: now,
      substepCount: 0,
    };
    onProgress({
      step: 0,
      totalSteps: nextState.totalSteps,
      percent: Math.round(PHASE_WEIGHT_BEFORE_DENOISING * 100),
      phase: 'Denoising',
      substep: 0,
      totalSubsteps: 0,
    });
    return nextState;
  }

  const stepMatch = line.match(/Step\s+(\d+)\/(\d+)\s*(.*)/i);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    const total = parseInt(stepMatch[2], 10);
    const trailingChars = (stepMatch[3] ?? '').replace(/[^dDsSfF]/g, '');

    let estSubstepsPerStep = state.estimatedTotalSubsteps;
    if (step > 1 && state.currentStep === step - 1 && state.substepCount > 0) {
      estSubstepsPerStep = state.substepCount;
    }

    const nextState: ProgressState = {
      ...state,
      totalSteps: total,
      currentStep: step,
      currentPhase: 'Denoising',
      substepCount: trailingChars.length,
      estimatedTotalSubsteps: estSubstepsPerStep,
    };

    if (!state.denoisingStartedAt) {
      nextState.denoisingStartedAt = Date.now();
    }

    emitDenoisingProgress(nextState, onProgress);
    return nextState;
  }

  if (state.currentPhase === 'Denoising' && state.currentStep > 0) {
    const substepChars = line.replace(/[^dDsSfF]/g, '');
    if (substepChars.length > 0) {
      const nextState = {
        ...state,
        substepCount: state.substepCount + substepChars.length,
      };
      emitDenoisingProgress(nextState, onProgress);
      return nextState;
    }
  }

  const postDenoisingMatch = line.match(/^(Decoding image|Saving)/i);
  if (postDenoisingMatch) {
    const phase = postDenoisingMatch[1];
    const pct = phase.toLowerCase().startsWith('decoding') ? 92 : 97;
    const nextState = {
      ...state,
      currentPhase: phase,
      lastPhaseStartedAt: now,
    };
    onProgress({
      step: nextState.currentStep,
      totalSteps: nextState.totalSteps,
      percent: pct,
      phase,
      substep: 0,
      totalSubsteps: 0,
    });
    return nextState;
  }

  return state;
}

const PRE_DENOISING_PHASES: Array<{ test: (lower: string) => boolean; percent: number; label: string }> = [
  { test: (l) => l.includes('vae') && l.includes('load'), percent: 2, label: 'Loading VAE' },
  { test: (l) => l.includes('vae'), percent: 3, label: 'VAE' },
  { test: (l) => (l.includes('text') && l.includes('load')) || l.includes('loading text encoder'), percent: 5, label: 'Loading text encoders' },
  { test: (l) => l.includes('clip') || l.includes('tokeniz'), percent: 6, label: 'Tokenizing' },
  { test: (l) => l.includes('encod') && (l.includes('prompt') || l.includes('text')), percent: 8, label: 'Encoding prompt' },
  { test: (l) => l.includes('encod'), percent: 7, label: 'Encoding' },
  { test: (l) => l.includes('transformer') && l.includes('load'), percent: 11, label: 'Loading transformer' },
  { test: (l) => l.includes('transformer'), percent: 12, label: 'Preparing transformer' },
  { test: (l) => l.includes('load') || l.includes('init'), percent: 4, label: 'Initializing' },
  { test: (l) => l.includes('prepar') || l.includes('setup'), percent: 10, label: 'Preparing' },
];

function getPreDenoisingPercent(phase: string): number {
  const lower = phase.toLowerCase();
  for (const entry of PRE_DENOISING_PHASES) {
    if (entry.test(lower)) return entry.percent;
  }
  return 5;
}

function emitDenoisingProgress(state: ProgressState, onProgress: (progress: ProgressData) => void) {
  const { currentStep, totalSteps, substepCount, estimatedTotalSubsteps } = state;
  if (totalSteps <= 0 || currentStep <= 0) return;

  const estSubs = estimatedTotalSubsteps > 0 ? estimatedTotalSubsteps : 50;
  const substepFraction = Math.min(1, substepCount / estSubs);
  const stepProgress = ((currentStep - 1) + substepFraction) / totalSteps;
  const percent = Math.round(
    (PHASE_WEIGHT_BEFORE_DENOISING + stepProgress * PHASE_WEIGHT_DENOISING) * 100
  );

  onProgress({
    step: currentStep,
    totalSteps,
    percent: Math.min(90, percent),
    phase: 'Denoising',
    substep: substepCount,
    totalSubsteps: estSubs,
  });
}

export function stripAnsi(value: string) {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}
