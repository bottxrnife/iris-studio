import type { ModelId } from './types';

const MODEL_LABELS: Record<ModelId, string> = {
  'flux-klein-4b': 'FLUX.2 [klein] 4B Distilled',
  'flux-klein-base-4b': 'FLUX.2 [klein] 4B Base',
  'flux-klein-9b': 'FLUX.2 [klein] 9B Distilled',
  'flux-klein-base-9b': 'FLUX.2 [klein] 9B Base',
  'zimage-turbo-6b': 'Z-Image Turbo 6B',
};

export function getModelDisplayLabel(modelId: ModelId) {
  return MODEL_LABELS[modelId] ?? modelId;
}
