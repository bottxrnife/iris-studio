import type { JobMode } from './types';

const SUBJECTS = [
  'editorial portrait of a ceramicist',
  'brutalist hillside residence',
  'botanical reading room',
  'avant-garde fashion still life',
  'desert greenhouse interior',
  'storm-lit fishing village',
  'retro-futurist train lounge',
  'mountain spa courtyard',
  'atelier workbench with pigments',
  'monolithic coastal retreat',
];

const MATERIALS = [
  'travertine and smoked oak',
  'brushed aluminum and glass',
  'linen, plaster, and walnut',
  'weathered bronze and stone',
  'polished concrete and steel',
  'ceramic tile and pale cedar',
  'oxidized copper and slate',
];

const LIGHTING = [
  'soft diffused daylight',
  'golden-hour sidelight',
  'overcast cinematic light',
  'low sun with long shadows',
  'misty blue-hour glow',
  'gallery spot lighting',
  'warm skylight illumination',
];

const STYLE = [
  'editorial photography',
  'architectural digest style',
  'high-end product campaign',
  'quiet luxury visual language',
  'museum-grade still life',
  'film still realism',
  'travel magazine cover aesthetic',
];

const COMPOSITION = [
  'balanced composition',
  'layered depth',
  'negative space',
  'clean foreground framing',
  'wide-angle perspective',
  'medium-format framing',
  'symmetrical layout',
];

const DETAILS = [
  'natural texture fidelity',
  'subtle atmospheric haze',
  'refined color separation',
  'crisp material detail',
  'gentle tonal contrast',
  'delicate reflected light',
  'controlled highlight rolloff',
];

const IMAGE_TRANSFORMS = [
  'preserve the original silhouette while elevating the materials',
  'keep the composition anchored and reinterpret the palette',
  'retain the source structure while introducing richer light',
  'preserve the subject placement and refine the styling',
];

const MULTI_BLEND = [
  'blend the strongest architectural cues from each reference into one cohesive scene',
  'merge the color language and geometry from the references into a unified composition',
  'combine the references into a single polished campaign image with consistent light',
  'fuse the references into one believable environment with shared materials and mood',
];

function pick<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)]!;
}

function maybe<T>(items: readonly T[], chance = 0.6) {
  return Math.random() < chance ? pick(items) : null;
}

function joinParts(parts: Array<string | null>) {
  return parts.filter((part): part is string => !!part).join(', ');
}

export function generateRandomPrompt(mode: JobMode) {
  const core = pick(SUBJECTS);
  const material = pick(MATERIALS);
  const lighting = pick(LIGHTING);
  const style = pick(STYLE);
  const composition = pick(COMPOSITION);
  const detailA = pick(DETAILS);
  const detailB = maybe(DETAILS.filter((item) => item !== detailA), 0.55);

  if (mode === 'img2img') {
    return joinParts([
      core,
      pick(IMAGE_TRANSFORMS),
      material,
      lighting,
      style,
      composition,
      detailA,
      detailB,
    ]);
  }

  if (mode === 'multi-ref') {
    return joinParts([
      core,
      pick(MULTI_BLEND),
      material,
      lighting,
      style,
      composition,
      detailA,
      detailB,
    ]);
  }

  return joinParts([
    core,
    material,
    lighting,
    style,
    composition,
    detailA,
    detailB,
  ]);
}
