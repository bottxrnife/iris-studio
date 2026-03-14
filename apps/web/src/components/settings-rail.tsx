'use client';

import Link from 'next/link';
import { useState, useCallback, useRef, useMemo, useEffect, useDeferredValue, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Image, Images, ChevronDown, ChevronUp, Upload, X, Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { createJob, estimateJob, getBenchmarkStatus, getLoras, getModels, uploadFiles, getUploadUrl } from '@/lib/api';
import { formatRemainingTime } from '@/lib/format';
import { generateRandomPrompt } from '@/lib/prompt-generator';
import { SIZE_PRESETS, type EditorDraft, type Job, type JobMode, type CreateJobRequest, type EstimateJobResponse, type ModelId } from '@/lib/types';

const MIN_DIMENSION = 64;
const MAX_DIMENSION = 1792;
const DIMENSION_STEP = 16;
const DIMENSION_NORMALIZE_DELAY_MS = 450;
const MAX_BATCH_PROMPTS = 200;
const IRIS_REFERENCE_TEXT_SEQ = 512;
const FLUX_9B_REFERENCE_HEADS = 32;
const IRIS_REFERENCE_ATTENTION_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_SEQ = Math.floor(
  Math.sqrt(IRIS_REFERENCE_ATTENTION_MAX_BYTES / (FLUX_9B_REFERENCE_HEADS * Float32Array.BYTES_PER_ELEMENT))
);

function roundTo16(n: number): number {
  return Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, Math.round(n / DIMENSION_STEP) * DIMENSION_STEP));
}

function floorTo16(n: number): number {
  return Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, Math.floor(n / DIMENSION_STEP) * DIMENSION_STEP));
}

function capDimensionInput(value: string) {
  if (value === '') {
    return value;
  }

  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return String(Math.min(MAX_DIMENSION, parsed));
}

function normalizeDimensionInput(value: string) {
  if (value === '') {
    return value;
  }

  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return String(roundTo16(parsed));
}

function getMaxReferenceImageTokens(referenceCount: number) {
  const totalImageStreams = Math.max(2, referenceCount + 1);
  return Math.floor((MAX_REFERENCE_TOTAL_SEQ - IRIS_REFERENCE_TEXT_SEQ) / totalImageStreams);
}

interface ImageEditBaseSize {
  width: number;
  height: number;
  wasModelCapped: boolean;
  wasAttentionCapped: boolean;
}

function fitReferenceSizeWithinBounds(width: number, height: number, referenceCount: number): ImageEditBaseSize {
  const longestEdge = Math.max(width, height);
  const maxDimensionScale = longestEdge > MAX_DIMENSION ? MAX_DIMENSION / longestEdge : 1;
  let resolvedWidth = floorTo16(width * maxDimensionScale);
  let resolvedHeight = floorTo16(height * maxDimensionScale);
  const wasModelCapped = maxDimensionScale < 1;

  const maxTokens = getMaxReferenceImageTokens(referenceCount);
  const currentTokens = (resolvedWidth / DIMENSION_STEP) * (resolvedHeight / DIMENSION_STEP);
  const attentionScale = currentTokens > maxTokens
    ? Math.sqrt(maxTokens / currentTokens)
    : 1;

  if (attentionScale < 1) {
    resolvedWidth = floorTo16(resolvedWidth * attentionScale);
    resolvedHeight = floorTo16(resolvedHeight * attentionScale);
  }

  return {
    width: resolvedWidth,
    height: resolvedHeight,
    wasModelCapped,
    wasAttentionCapped: attentionScale < 1,
  };
}

interface RefImageInfo {
  filename: string;
  width: number;
  height: number;
}

interface SettingsRailProps {
  draft: EditorDraft | null;
  onJobCreated: (jobId: string) => void;
}

export function SettingsRail({ draft, onJobCreated }: SettingsRailProps) {
  const queryClient = useQueryClient();
  const lastEstimateRef = useRef<EstimateJobResponse | null>(null);

  const [mode, setMode] = useState<JobMode>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('iris-selected-mode');
      if (stored === 'txt2img' || stored === 'img2img' || stored === 'multi-ref') {
        return stored;
      }
    }
    return 'txt2img';
  });
  const [prompt, setPrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState<ModelId>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('iris-selected-model');
      if (stored === 'flux-klein-4b' || stored === 'flux-klein-base-4b' || stored === 'flux-klein-9b' || stored === 'flux-klein-base-9b' || stored === 'zimage-turbo-6b') {
        return stored;
      }
    }
    return 'flux-klein-9b';
  });
  const [selectedLoraId, setSelectedLoraId] = useState<string | null>(null);
  const [loraScale, setLoraScale] = useState(1);
  const [sizePreset, setSizePreset] = useState('Custom');
  const [customWidth, setCustomWidth] = useState('512');
  const [customHeight, setCustomHeight] = useState('512');
  const [seed, setSeed] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [steps, setSteps] = useState('');
  const [guidance, setGuidance] = useState('');
  const [iterations, setIterations] = useState('1');
  const [seedMode, setSeedMode] = useState<'same' | 'random'>('same');
  const [refImages, setRefImages] = useState<RefImageInfo[]>([]);
  const [scalePercent, setScalePercent] = useState(100);
  const [batchPrompts, setBatchPrompts] = useState<string[]>([]);
  const [batchPromptFileName, setBatchPromptFileName] = useState('');
  const [batchPromptError, setBatchPromptError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const batchPromptFileInputRef = useRef<HTMLInputElement>(null);
  const referenceCount = mode === 'txt2img' ? 0 : Math.max(1, refImages.length);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: getModels,
    refetchInterval: (query) => query.state.data?.activeDownloadModelId ? 1500 : 5000,
    staleTime: 1000,
  });
  const lorasQuery = useQuery({
    queryKey: ['loras'],
    queryFn: getLoras,
    staleTime: 1500,
  });

  const handleModeChange = useCallback((nextMode: JobMode) => {
    setMode(nextMode);
    if (nextMode === 'img2img') {
      setRefImages((prev) => prev.slice(0, 1));
    }
  }, []);

  const handlePresetChange = useCallback((label: string) => {
    setSizePreset(label);
    if (label !== 'Custom') {
      const preset = SIZE_PRESETS.find((p) => p.label === label);
      if (preset) {
        setCustomWidth(String(preset.width));
        setCustomHeight(String(preset.height));
      }
    }
  }, []);

  const primaryRef = refImages.length > 0 ? refImages[0] : null;
  const fittedPrimaryRefSize = useMemo(() => {
    if (!primaryRef) return null;
    return fitReferenceSizeWithinBounds(primaryRef.width, primaryRef.height, referenceCount);
  }, [primaryRef, referenceCount]);

  const scaledSize = useMemo(() => {
    if (!fittedPrimaryRefSize) return null;
    const factor = scalePercent / 100;
    return {
      width: roundTo16(fittedPrimaryRefSize.width * factor),
      height: roundTo16(fittedPrimaryRefSize.height * factor),
    };
  }, [fittedPrimaryRefSize, scalePercent]);

  const availableModels = useMemo(
    () => (modelsQuery.data?.models ?? []).filter((model) => model.installed),
    [modelsQuery.data?.models]
  );
  const hasInstalledModel = availableModels.length > 0;
  const selectedModelInfo = modelsQuery.data?.models.find((model) => model.id === selectedModel) ?? null;
  const compatibleLoras = useMemo(
    () => (lorasQuery.data?.loras ?? []).filter((lora) => lora.compatibleModelIds.includes(selectedModel)),
    [lorasQuery.data?.loras, selectedModel]
  );
  const selectableLoras = useMemo(
    () => compatibleLoras.filter((lora) => lora.runtimeReady),
    [compatibleLoras]
  );
  const selectedLora = useMemo(
    () => (selectedLoraId
      ? lorasQuery.data?.loras.find((lora) => lora.id === selectedLoraId) ?? null
      : null),
    [lorasQuery.data?.loras, selectedLoraId]
  );

  useEffect(() => {
    if (!/^\d+$/.test(customWidth)) {
      return;
    }

    const normalized = normalizeDimensionInput(customWidth);
    if (normalized === customWidth) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCustomWidth((current) => (current === customWidth ? normalized : current));
    }, DIMENSION_NORMALIZE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [customWidth]);

  useEffect(() => {
    if (!/^\d+$/.test(customHeight)) {
      return;
    }

    const normalized = normalizeDimensionInput(customHeight);
    if (normalized === customHeight) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCustomHeight((current) => (current === customHeight ? normalized : current));
    }, DIMENSION_NORMALIZE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [customHeight]);

  useEffect(() => {
    localStorage.setItem('iris-selected-model', selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    localStorage.setItem('iris-selected-mode', mode);
  }, [mode]);

  useEffect(() => {
    if (!hasInstalledModel) {
      return;
    }

    if (availableModels.some((model) => model.id === selectedModel)) {
      return;
    }

    setSelectedModel(availableModels[0]!.id);
  }, [availableModels, hasInstalledModel, selectedModel]);

  useEffect(() => {
    if (!selectedLoraId || !lorasQuery.data) {
      return;
    }

    const lora = lorasQuery.data.loras.find((entry) => entry.id === selectedLoraId);
    if (!lora || !lora.compatibleModelIds.includes(selectedModel) || !lora.runtimeReady) {
      setSelectedLoraId(null);
      setLoraScale(1);
    }
  }, [lorasQuery.data, selectedLoraId, selectedModel]);

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => uploadFiles(files),
  });

  const benchmarkQuery = useQuery({
    queryKey: ['benchmark-status'],
    queryFn: getBenchmarkStatus,
    refetchInterval: 1000,
    staleTime: 1000,
  });

  const createMutation = useMutation({
    mutationFn: async (requests: CreateJobRequest[]) => {
      const createdJobs: Job[] = [];

      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index]!;
        const nextSeed = seedMode === 'same'
          ? request.seed
          : (request.seed != null ? request.seed + index : undefined);

        try {
          const job = await createJob({
            ...request,
            ...(nextSeed != null ? { seed: nextSeed } : {}),
          });
          createdJobs.push(job);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Queue request failed';
          if (createdJobs.length > 0) {
            throw new Error(
              `Queued ${createdJobs.length} ${createdJobs.length === 1 ? 'job' : 'jobs'} before failure: ${message}`
            );
          }
          throw error;
        }
      }

      return createdJobs;
    },
    onSuccess: (jobs) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      const firstJob = jobs[0];
      if (firstJob) {
        onJobCreated(firstJob.id);
      }
    },
  });

  const handleGenerate = useCallback(() => {
    const promptList = batchPrompts.length > 0 ? batchPrompts : [prompt.trim()].filter(Boolean);
    if (promptList.length === 0) return;

    let width: number;
    let height: number;

    if (mode === 'txt2img') {
      width = roundTo16(parseInt(customWidth, 10) || 512);
      height = roundTo16(parseInt(customHeight, 10) || 512);
    } else if (scaledSize) {
      width = scaledSize.width;
      height = scaledSize.height;
    } else {
      width = 512;
      height = 512;
    }

    const baseRequest: CreateJobRequest = {
      mode,
      model: selectedModel,
      prompt: promptList[0]!,
      width,
      height,
    };

    const parsedSeed = parseInt(seed, 10);
    const parsedSteps = parseInt(steps, 10);
    const parsedGuidance = parseFloat(guidance);

    if (Number.isFinite(parsedSeed)) baseRequest.seed = parsedSeed;
    if (showAdvanced && Number.isFinite(parsedSteps) && parsedSteps > 0) baseRequest.steps = parsedSteps;
    if (showAdvanced && Number.isFinite(parsedGuidance) && parsedGuidance >= 0) baseRequest.guidance = parsedGuidance;
    if (selectedLoraId) {
      baseRequest.loraId = selectedLoraId;
      baseRequest.loraScale = loraScale;
    }
    if (mode === 'img2img' && refImages.length > 0) {
      baseRequest.inputPaths = [refImages[0].filename];
    }
    if (mode === 'multi-ref' && refImages.length > 0) {
      baseRequest.inputPaths = refImages.map((r) => r.filename);
    }

    const quantity = batchPrompts.length > 0
      ? 1
      : Math.max(1, parseInt(iterations, 10) || 1);
    const requests = promptList.flatMap((batchPrompt) => Array.from({ length: quantity }, () => ({
      ...baseRequest,
      prompt: batchPrompt,
    })));

    createMutation.mutate(requests);
  }, [batchPrompts, prompt, mode, selectedModel, selectedLoraId, loraScale, customWidth, customHeight, scaledSize, seed, iterations, showAdvanced, steps, guidance, refImages, createMutation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleGenerate();
      }
    },
    [handleGenerate]
  );

  const readImageDimensions = useCallback((file: File): Promise<{ width: number; height: number }> => {
    return new Promise((resolve) => {
      const img = new window.Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => {
        resolve({ width: 512, height: 512 });
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(file);
    });
  }, []);

  const readUploadedImageDimensions = useCallback((filename: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve) => {
      const img = new window.Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        resolve({ width: 512, height: 512 });
      };
      img.src = getUploadUrl(filename);
    });
  }, []);

  const handleBatchPromptFileUpload = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const content = await file.text();
      const parsedPrompts = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (parsedPrompts.length === 0) {
        setBatchPromptError('The uploaded text file did not contain any prompts.');
        setBatchPrompts([]);
        setBatchPromptFileName('');
        return;
      }

      if (parsedPrompts.length > MAX_BATCH_PROMPTS) {
        setBatchPromptError(`Batch prompt files are limited to ${MAX_BATCH_PROMPTS} prompts.`);
        setBatchPrompts([]);
        setBatchPromptFileName('');
        return;
      }

      setBatchPromptError(null);
      setBatchPrompts(parsedPrompts);
      setBatchPromptFileName(file.name);
    } catch {
      setBatchPromptError('Could not read the uploaded prompt file.');
      setBatchPrompts([]);
      setBatchPromptFileName('');
    } finally {
      if (batchPromptFileInputRef.current) {
        batchPromptFileInputRef.current.value = '';
      }
    }
  }, []);

  useEffect(() => {
    if (!draft) {
      return;
    }

    const matchingPreset = SIZE_PRESETS.find((preset) => (
      preset.width === draft.width && preset.height === draft.height
    ));

    setMode(draft.mode);
    setPrompt(draft.prompt);
    setSelectedModel(draft.model);
    setSelectedLoraId(draft.loraId);
    setLoraScale(draft.loraScale ?? 1);
    setSizePreset(matchingPreset?.label ?? 'Custom');
    setCustomWidth(String(draft.width));
    setCustomHeight(String(draft.height));
    setSeed(draft.seed != null ? String(draft.seed) : '');
    setIterations('1');
    setSeedMode('same');
    setSteps(draft.steps != null ? String(draft.steps) : '');
    setGuidance(draft.guidance != null ? String(draft.guidance) : '');
    setShowAdvanced(draft.steps != null || draft.guidance != null);
    setBatchPrompts([]);
    setBatchPromptFileName('');
    setBatchPromptError(null);

    if (!draft.inputPaths || draft.inputPaths.length === 0 || draft.mode === 'txt2img') {
      setRefImages([]);
      setScalePercent(100);
      return;
    }

    let cancelled = false;

    void Promise.all(
      draft.inputPaths.map(async (filename) => ({
        filename,
        ...(await readUploadedImageDimensions(filename)),
      }))
    ).then((loadedRefs) => {
      if (cancelled) {
        return;
      }

      const nextRefs = draft.mode === 'img2img'
        ? loadedRefs.slice(0, 1)
        : loadedRefs;

      setRefImages(nextRefs);

      const primaryRef = nextRefs[0];
      if (!primaryRef) {
        setScalePercent(100);
        return;
      }

      const fittedPrimaryRefSize = fitReferenceSizeWithinBounds(primaryRef.width, primaryRef.height, Math.max(1, nextRefs.length));
      const widthScale = (draft.width / fittedPrimaryRefSize.width) * 100;
      const heightScale = (draft.height / fittedPrimaryRefSize.height) * 100;
      const inferredScale = Math.round((((widthScale + heightScale) / 2) / 5)) * 5;
      setScalePercent(Math.max(10, Math.min(100, inferredScale || 100)));
    });

    return () => {
      cancelled = true;
    };
  }, [draft, readUploadedImageDimensions]);

  useEffect(() => {
    if (!selectedModelInfo) {
      return;
    }

    if (!steps) {
      setSteps(String(selectedModelInfo.recommendedSteps));
    }

    if (selectedModelInfo.recommendedGuidance != null && !guidance) {
      setGuidance(String(selectedModelInfo.recommendedGuidance));
    }
  }, [guidance, selectedModelInfo, steps]);

  const handleFileUpload = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const fileList = Array.from(e.target.files ?? []);
      if (fileList.length === 0) return;

      const dimensions = await Promise.all(fileList.map(readImageDimensions));

      uploadMutation.mutate(fileList, {
        onSuccess: (filenames) => {
          const newRefs: RefImageInfo[] = filenames.map((filename, i) => ({
            filename,
            width: dimensions[i].width,
            height: dimensions[i].height,
          }));
          setRefImages((prev) => (
            mode === 'img2img'
              ? newRefs.slice(0, 1)
              : [...prev, ...newRefs]
          ));
          setScalePercent(100);
        },
      });

      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [mode, uploadMutation, readImageDimensions]
  );

  const removeFile = useCallback((index: number) => {
    setRefImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const randomExample = useCallback(() => {
    setPrompt(generateRandomPrompt(mode));
  }, [mode]);

  const hasRequiredReferences =
    mode === 'txt2img' ||
    (mode === 'img2img' && refImages.length >= 1) ||
    (mode === 'multi-ref' && refImages.length >= 2);
  const hasPromptInput = batchPrompts.length > 0 || !!prompt.trim();
  const isBenchmarkActive = benchmarkQuery.data?.currentRun?.status === 'running';
  const isLoading = createMutation.isPending || uploadMutation.isPending;
  const hasSelectedLora = !!selectedLora;
  const canGenerate = hasPromptInput && hasRequiredReferences && hasInstalledModel;
  const queueTotal = batchPrompts.length > 0
    ? batchPrompts.length
    : Math.max(1, parseInt(iterations, 10) || 1);
  const baseSeed = seed ? parseInt(seed, 10) : null;
  const resolvedSize = useMemo(() => {
    if (mode === 'txt2img') {
      return {
        width: roundTo16(parseInt(customWidth, 10) || 512),
        height: roundTo16(parseInt(customHeight, 10) || 512),
      };
    }

    if (!scaledSize) {
      return null;
    }

    return scaledSize;
  }, [customHeight, customWidth, mode, scaledSize]);
  const estimateInputCount = mode === 'txt2img' ? 0 : refImages.length;
  const canEstimate =
    hasInstalledModel &&
    resolvedSize != null &&
    (mode === 'txt2img' ||
      (mode === 'img2img' && refImages.length >= 1) ||
      (mode === 'multi-ref' && refImages.length >= 2));
  const estimateRequest = useMemo(() => {
    if (!canEstimate || !resolvedSize) {
      return null;
    }

    const parsedSteps = parseInt(steps, 10);
    const parsedGuidance = parseFloat(guidance);

    return {
      mode,
      model: selectedModel,
      width: resolvedSize.width,
      height: resolvedSize.height,
      inputCount: estimateInputCount,
      quantity: queueTotal,
      ...(showAdvanced && Number.isFinite(parsedSteps) && parsedSteps > 0 ? { steps: parsedSteps } : {}),
      ...(showAdvanced && Number.isFinite(parsedGuidance) && parsedGuidance >= 0 ? { guidance: parsedGuidance } : {}),
    };
  }, [canEstimate, estimateInputCount, mode, selectedModel, queueTotal, resolvedSize, showAdvanced, steps, guidance]);
  const deferredEstimateRequest = useDeferredValue(estimateRequest);
  const estimateQuery = useQuery({
    queryKey: ['job-estimate', deferredEstimateRequest],
    queryFn: () => estimateJob(deferredEstimateRequest!),
    enabled: deferredEstimateRequest != null,
    refetchInterval: 5000,
    staleTime: 2000,
  });

  useEffect(() => {
    if (estimateQuery.data) {
      lastEstimateRef.current = estimateQuery.data;
    }
  }, [estimateQuery.data]);

  useEffect(() => {
    if (!canEstimate) {
      lastEstimateRef.current = null;
    }
  }, [canEstimate]);

  const estimateData = estimateQuery.data ?? lastEstimateRef.current;
  const estimatedGeneration = formatRemainingTime(estimateData?.estimatedGenerationMs ?? null);
  const estimatedTotal = formatRemainingTime(estimateData?.estimatedTotalMs ?? null);
  const showTotalEstimate = !!estimateData && (queueTotal > 1 || estimateData.queueAheadCount > 0);
  const estimateUnavailable =
    canEstimate &&
    !estimateQuery.isLoading &&
    !estimateQuery.isError &&
    estimateData?.estimatedGenerationMs == null;
  const showEstimateMessage = estimateUnavailable || (estimateQuery.isError && !estimateData);
  const buttonLabel = createMutation.isPending
    ? (queueTotal === 1 ? 'Generating...' : `Queueing ${queueTotal} images...`)
    : batchPrompts.length > 0
      ? `Generate ${queueTotal} prompts`
      : (queueTotal === 1 ? 'Generate' : `Generate ${queueTotal} images`);

  return (
    <div className="w-full border-r border-border bg-card flex flex-col h-full min-h-0">
      {/* Mode selector - fixed outside scroll area */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-3">
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground uppercase tracking-wider">Mode</Label>
          <div className="grid grid-cols-3 gap-1">
            <Button
              variant={mode === 'txt2img' ? 'default' : 'secondary'}
              size="sm"
              className="text-xs"
              onClick={() => handleModeChange('txt2img')}
            >
              <Sparkles className="h-3 w-3 mr-1" />
              Text
            </Button>
            <Button
              variant={mode === 'img2img' ? 'default' : 'secondary'}
              size="sm"
              className="text-xs"
              onClick={() => handleModeChange('img2img')}
            >
              <Image className="h-3 w-3 mr-1" />
              Image
            </Button>
            <Button
              variant={mode === 'multi-ref' ? 'default' : 'secondary'}
              size="sm"
              className="text-xs"
              onClick={() => handleModeChange('multi-ref')}
            >
              <Images className="h-3 w-3 mr-1" />
              Multi
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" onKeyDown={handleKeyDown}>
        <div className="p-4 pb-6 space-y-4">

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Model</Label>
            {hasInstalledModel ? (
              <>
                <Select value={selectedModel} onValueChange={(value) => setSelectedModel(value as ModelId)}>
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(modelsQuery.data?.models ?? []).map((modelOption) => (
                      <SelectItem
                        key={modelOption.id}
                        value={modelOption.id}
                        disabled={!modelOption.installed}
                      >
                        {modelOption.label}{modelOption.installed ? '' : ' · install first'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedModelInfo && (
                  <div className="rounded-lg border border-border/70 bg-background/50 p-3 text-xs text-muted-foreground">
                    <p className="text-foreground">{selectedModelInfo.summary}</p>
                    <p className="mt-1">
                      Recommended defaults: {selectedModelInfo.recommendedSteps} steps
                      {selectedModelInfo.recommendedGuidance != null ? ` · guidance ${selectedModelInfo.recommendedGuidance}` : ' · CFG'}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-background/50 p-3 text-sm text-muted-foreground">
                <p>No model installed yet.</p>
                <Link href="/models" className="mt-2 inline-flex items-center gap-1 text-primary hover:text-primary/80">
                  Download a model
                </Link>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">LoRAs</Label>
            {selectableLoras.length > 0 ? (
              <div className="space-y-2">
                <Select
                  value={selectedLoraId ?? '__none__'}
                  onValueChange={(value) => setSelectedLoraId(value === '__none__' ? null : value)}
                >
                  <SelectTrigger className="text-sm">
                    <SelectValue placeholder="No LoRA selected" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {selectableLoras.map((lora) => (
                      <SelectItem key={lora.id} value={lora.id}>
                        <span className="truncate">{lora.filename}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedLora && (
                  <div className="rounded-lg border border-border/70 bg-background/50 p-3">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>Strength</span>
                      <span className="font-mono text-foreground">{loraScale.toFixed(2)}</span>
                    </div>
                    <Slider
                      className="mt-3"
                      value={[loraScale]}
                      min={0}
                      max={2}
                      step={0.05}
                      onValueChange={(value) => setLoraScale(value[0] ?? 1)}
                    />
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      0.0 = no effect, 1.0 = default, 2.0 = maximum
                    </p>
                  </div>
                )}
              </div>
            ) : compatibleLoras.length > 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-background/50 p-3 text-xs text-muted-foreground">
                Compatible LoRAs found but none are ready for use with this model.
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-background/50 p-3 text-xs text-muted-foreground">
                No compatible LoRAs for this model. <Link href="/loras" className="text-primary hover:text-primary/80">Upload one</Link> to get started.
              </div>
            )}
          </div>

          {/* Prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Prompt</Label>
              <div className="flex items-center gap-2">
                <input
                  ref={batchPromptFileInputRef}
                  type="file"
                  accept=".txt,text/plain"
                  onChange={handleBatchPromptFileUpload}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => batchPromptFileInputRef.current?.click()}
                >
                  <Upload className="mr-1 h-3 w-3" />
                  Prompt File
                </Button>
                <button
                  onClick={randomExample}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  title="Random example"
                  disabled={batchPrompts.length > 0}
                >
                  <Shuffle className="h-3 w-3" />
                </button>
              </div>
            </div>
            <Textarea
              placeholder="Describe the image you want to create..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={batchPrompts.length > 0}
              rows={4}
              className="resize-none text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {batchPrompts.length > 0
                ? `Using ${batchPrompts.length} prompts from ${batchPromptFileName || 'the uploaded file'}. Clear it to use the text box again.`
                : mode === 'txt2img'
                ? 'Describe what you want to see, e.g. "a cat sitting on a cloud at sunset".'
                : 'Describe the result you want. Your reference image provides visual context.'}
            </p>
            {batchPromptFileName && (
              <div className="flex items-center gap-2 rounded border border-border/60 bg-secondary/30 px-2 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-foreground">{batchPromptFileName}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {batchPrompts.length} queued prompt{batchPrompts.length === 1 ? '' : 's'}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0"
                  onClick={() => {
                    setBatchPrompts([]);
                    setBatchPromptFileName('');
                    setBatchPromptError(null);
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
            {batchPromptError && (
              <p className="text-xs text-destructive">{batchPromptError}</p>
            )}
          </div>

          {/* Reference images for img2img / multi-ref */}
          {(mode === 'img2img' || mode === 'multi-ref') && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                Reference {mode === 'multi-ref' ? 'Images' : 'Image'}
              </Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple={mode === 'multi-ref'}
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                size="sm"
                className="w-full text-xs"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadMutation.isPending}
              >
                <Upload className="h-3 w-3 mr-1" />
                {uploadMutation.isPending ? 'Uploading...' : 'Upload'}
              </Button>
              {refImages.length > 0 && (
                <div className="space-y-1">
                  {refImages.map((ref, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground bg-secondary rounded px-2 py-1">
                      <button
                        type="button"
                        onClick={() => setPreviewImage(getUploadUrl(ref.filename))}
                        className="shrink-0 rounded transition-opacity hover:opacity-80"
                        title="Click to preview"
                      >
                        <img
                          src={getUploadUrl(ref.filename)}
                          alt=""
                          className="w-8 h-8 rounded object-cover"
                        />
                      </button>
                      <div className="flex-1 min-w-0">
                        <span className="block truncate text-foreground/80" title={ref.filename}>{ref.filename}</span>
                        <span className="text-[10px]">{ref.width}×{ref.height}</span>
                      </div>
                      <button onClick={() => removeFile(i)} className="shrink-0 hover:text-foreground">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Size controls — mode-dependent */}
          {mode === 'txt2img' ? (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Size</Label>
              <Select value={sizePreset} onValueChange={handlePresetChange}>
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Custom">Custom</SelectItem>
                  {SIZE_PRESETS.map((p) => (
                    <SelectItem key={p.label} value={p.label}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Width</Label>
                  <Input
                    type="number"
                    min={MIN_DIMENSION}
                    max={MAX_DIMENSION}
                    step={DIMENSION_STEP}
                    placeholder="512"
                    value={customWidth}
                    onChange={(e) => {
                      setCustomWidth(capDimensionInput(e.target.value));
                      setSizePreset('Custom');
                    }}
                    onBlur={() => setCustomWidth((current) => normalizeDimensionInput(current))}
                    className="text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Height</Label>
                  <Input
                    type="number"
                    min={MIN_DIMENSION}
                    max={MAX_DIMENSION}
                    step={DIMENSION_STEP}
                    placeholder="512"
                    value={customHeight}
                    onChange={(e) => {
                      setCustomHeight(capDimensionInput(e.target.value));
                      setSizePreset('Custom');
                    }}
                    onBlur={() => setCustomHeight((current) => normalizeDimensionInput(current))}
                    className="text-sm"
                  />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Dimensions snap to multiples of 16, max 1792 per side.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Output Scale</Label>
              {primaryRef ? (
                <>
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[scalePercent]}
                      onValueChange={([v]) => setScalePercent(v)}
                      min={10}
                      max={100}
                      step={5}
                      className="flex-1"
                    />
                    <span className="text-sm font-mono tabular-nums w-12 text-right">{scalePercent}%</span>
                  </div>
                  {scaledSize && (
                    <p className="text-xs text-muted-foreground">
                      Output: {scaledSize.width} × {scaledSize.height}
                      <span className="text-[10px] ml-1">
                        {fittedPrimaryRefSize?.wasAttentionCapped
                          ? `(fit from ${primaryRef.width}×${primaryRef.height} to preserve reference detail)`
                          : fittedPrimaryRefSize?.wasModelCapped
                            ? `(fit from ${primaryRef.width}×${primaryRef.height})`
                            : `(from ${primaryRef.width}×${primaryRef.height})`}
                      </span>
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {mode === 'img2img'
                    ? 'Upload one reference image to drive the edit.'
                    : 'Upload at least two reference images to blend context.'}
                </p>
              )}
            </div>
          )}

          {/* Seed */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Seed</Label>
            <Input
              type="number"
              placeholder="Random"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              className="text-sm"
            />
          </div>

          {/* Advanced settings */}
          <div className="space-y-2">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
            >
              {showAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              Advanced Settings
            </button>
            {showAdvanced && (
              <div className="space-y-3 pl-2 border-l border-border">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Steps</Label>
                  <Input
                    type="number"
                    placeholder="Auto (4 for distilled)"
                    value={steps}
                    onChange={(e) => setSteps(e.target.value)}
                    className="text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Guidance</Label>
                  <Input
                    type="number"
                    step="0.1"
                    placeholder="Auto"
                    value={guidance}
                    onChange={(e) => setGuidance(e.target.value)}
                    className="text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Iterations</Label>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    placeholder="1"
                    value={iterations}
                    onChange={(e) => setIterations(e.target.value)}
                    className="text-sm"
                    disabled={batchPrompts.length > 0}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {batchPrompts.length > 0
                      ? 'Iterations are driven by the uploaded prompt file.'
                      : 'Number of images to generate with these settings.'}
                  </p>
                </div>
                {parseInt(iterations, 10) >= 2 && batchPrompts.length === 0 && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Seed behavior</Label>
                    <div className="grid grid-cols-2 gap-1">
                      <Button
                        type="button"
                        variant={seedMode === 'same' ? 'default' : 'secondary'}
                        size="sm"
                        className="text-xs"
                        onClick={() => setSeedMode('same')}
                      >
                        Same seed
                      </Button>
                      <Button
                        type="button"
                        variant={seedMode === 'random' ? 'default' : 'secondary'}
                        size="sm"
                        className="text-xs"
                        onClick={() => setSeedMode('random')}
                      >
                        Varied seeds
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {seedMode === 'same'
                        ? 'All iterations will use the same seed for identical results.'
                        : baseSeed != null
                          ? `Seeds will increment: ${baseSeed}, ${baseSeed + 1}, ${baseSeed + 2}...`
                          : 'Each iteration will use a different random seed.'}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-card p-4 space-y-3">
        {canEstimate && (
          <div className={`rounded-md border border-border bg-secondary/30 p-3 ${showTotalEstimate || showEstimateMessage ? 'space-y-2' : ''}`}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Estimated time</span>
              <span className="font-mono tabular-nums text-foreground">
                {estimatedGeneration ?? '--:--'}
              </span>
            </div>
            {showTotalEstimate && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Total with queue</span>
                <span className="font-mono tabular-nums text-foreground">
                  {estimatedTotal ?? '--:--'}
                </span>
              </div>
            )}
            {estimateUnavailable && (
              <p className="text-[10px] text-muted-foreground">
                Time estimates improve after you run a few generations.
              </p>
            )}
            {estimateQuery.isError && !estimateData && (
              <p className="text-[10px] text-muted-foreground">
                Unable to estimate right now.
              </p>
            )}
          </div>
        )}
        {createMutation.isError && (
          <p className="text-xs text-destructive">
            {createMutation.error.message}
          </p>
        )}
        <Button
          className="w-full"
          onClick={handleGenerate}
          disabled={isLoading || !canGenerate || isBenchmarkActive}
        >
          {buttonLabel}
          <span className="ml-2 text-xs text-primary-foreground/60">⌘↵</span>
        </Button>
        {isBenchmarkActive && (
          <p className="text-xs text-muted-foreground">
            A benchmark is running. Generation will resume when it finishes.
          </p>
        )}
        {!hasInstalledModel && (
          <p className="text-xs text-muted-foreground">
            You need to install a model first. Go to the <Link href="/models" className="text-primary hover:text-primary/80">Models</Link> page to download one.
          </p>
        )}
        {hasSelectedLora && (
          <p className="text-xs text-muted-foreground">
            Using LoRA: {selectedLora?.filename} (strength {loraScale.toFixed(2)})
          </p>
        )}
        {!hasRequiredReferences && (
          <p className="mt-2 text-xs text-muted-foreground">
            {mode === 'img2img'
              ? 'Upload a reference image above to use Image mode.'
              : 'Upload at least 2 reference images above to use Multi mode.'}
          </p>
        )}
      </div>

      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-h-[85vh] max-w-[85vw]">
            <img
              src={previewImage}
              alt="Reference preview"
              className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
            />
            <button
              type="button"
              onClick={() => setPreviewImage(null)}
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-card border border-border text-foreground shadow-lg hover:bg-secondary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
