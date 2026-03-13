'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FolderOpen, ScanSearch, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { deleteLora, getLoras, updateLoraSettings, uploadLoras } from '@/lib/api';
import type { LoraFormat, ModelId } from '@/lib/types';

const BLANK_SELECT_VALUE = '__blank__';
const MODEL_OPTIONS: Array<{ id: ModelId; label: string }> = [
  { id: 'flux-klein-4b', label: 'FLUX.2 [klein] 4B Distilled' },
  { id: 'flux-klein-base-4b', label: 'FLUX.2 [klein] 4B Base' },
  { id: 'flux-klein-9b', label: 'FLUX.2 [klein] 9B Distilled' },
  { id: 'flux-klein-base-9b', label: 'FLUX.2 [klein] 9B Base' },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = -1;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export default function LorasPage() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const lorasQuery = useQuery({
    queryKey: ['loras'],
    queryFn: getLoras,
    staleTime: 1500,
  });

  const uploadMutation = useMutation({
    mutationFn: uploadLoras,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['loras'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteLora,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['loras'] });
    },
  });

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      (f) => f.name.toLowerCase().endsWith('.safetensors')
    );
    if (droppedFiles.length > 0) {
      uploadMutation.mutate(droppedFiles);
    }
  }, [uploadMutation]);

  const updateMutation = useMutation({
    mutationFn: ({ id, format, modelId }: { id: string; format: Exclude<LoraFormat, 'unknown'> | null; modelId: ModelId | null }) =>
      updateLoraSettings(id, { format, modelId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['loras'] });
    },
  });

  const loras = lorasQuery.data?.loras ?? [];
  const runtimeSupport = lorasQuery.data?.runtimeSupport;
  const readyCount = loras.filter((lora) => lora.runtimeReady).length;

  return (
    <main className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-6 overflow-y-auto px-4 py-6">
      <section className="rounded-2xl border border-border bg-card/80 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Loras</p>
            <h1 className="text-2xl font-semibold text-foreground">Manage your LoRAs</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              LoRAs are small style or subject add-ons for your models. Upload
              <code className="mx-1 rounded bg-secondary px-1 py-0.5">.safetensors</code> files here or drop them into the
              <code className="ml-1 rounded bg-secondary px-1 py-0.5">Loras/</code> folder. The app will automatically detect their format and compatibility.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-background/60 px-4 py-3 text-sm text-muted-foreground">
            <p>{loras.length} LoRA{loras.length === 1 ? '' : 's'} found</p>
            <p>{readyCount} ready to use in Studio</p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <div
          className={`relative rounded-2xl border bg-card/80 p-5 transition-colors ${isDragOver ? 'border-primary bg-primary/5' : 'border-border'}`}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
        >
          {isDragOver && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/10 backdrop-blur-sm">
              <div className="rounded-xl border-2 border-dashed border-primary/40 px-8 py-6 text-center">
                <Upload className="mx-auto h-8 w-8 text-primary" />
                <p className="mt-2 text-sm font-medium text-primary">Drop .safetensors files here</p>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">LoRA library</h2>
              <p className="text-sm text-muted-foreground">Compatible LoRAs will appear as selectable options in the Studio when you generate images.</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".safetensors"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length === 0) {
                    return;
                  }

                  uploadMutation.mutate(files);
                  event.currentTarget.value = '';
                }}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadMutation.isPending}
              >
                <Upload className="mr-2 h-4 w-4" />
                {uploadMutation.isPending ? 'Uploading...' : 'Upload LoRAs'}
              </Button>
            </div>
          </div>

          {uploadMutation.isError && (
            <p className="mt-4 text-sm text-destructive">
              {uploadMutation.error instanceof Error ? uploadMutation.error.message : 'Upload failed'}
            </p>
          )}

          {updateMutation.isError && (
            <p className="mt-4 text-sm text-destructive">
              {updateMutation.error instanceof Error ? updateMutation.error.message : 'Could not update LoRA settings'}
            </p>
          )}

          {lorasQuery.isError && (
            <p className="mt-4 text-sm text-destructive">
              {lorasQuery.error instanceof Error ? lorasQuery.error.message : 'Could not load LoRAs'}
            </p>
          )}

          {loras.length === 0 && !lorasQuery.isLoading && (
            <div className="mt-5 rounded-xl border border-dashed border-border bg-background/60 p-6 text-sm text-muted-foreground">
              No LoRAs found yet. Upload a `.safetensors` file here or place one directly in the `Loras/` folder.
            </div>
          )}

          <div className="mt-5 grid gap-4 xl:grid-cols-2">
            {loras.map((lora) => (
              <article key={lora.id} className="rounded-2xl border border-border bg-background/70 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold text-foreground" title={lora.filename}>
                      {lora.filename}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatBytes(lora.sizeBytes)} · {lora.tensorCount} tensors · {lora.tensorDtype.toUpperCase()}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      const confirmed = window.confirm(`Delete ${lora.filename} from the local Loras folder?`);
                      if (confirmed) {
                        deleteMutation.mutate(lora.id);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                    {lora.format === 'fal-ai' ? 'fal.ai' : lora.format === 'comfyui' ? 'ComfyUI / Kohya' : 'Unknown format'}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                    {lora.formatConfidence}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 ${lora.runtimeReady ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-200'}`}>
                    {lora.runtimeReady ? 'Runtime-ready' : 'Catalog only'}
                  </span>
                </div>

                <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Manual format</p>
                      <Select
                        value={lora.manualFormat ?? BLANK_SELECT_VALUE}
                        onValueChange={(value) => {
                          updateMutation.mutate({
                            id: lora.id,
                            format: value === BLANK_SELECT_VALUE ? null : value as Exclude<LoraFormat, 'unknown'>,
                            modelId: lora.manualModelId,
                          });
                        }}
                      >
                        <SelectTrigger className="text-sm">
                          <SelectValue placeholder="Blank" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={BLANK_SELECT_VALUE}>Blank</SelectItem>
                          <SelectItem value="fal-ai">fal.ai</SelectItem>
                          <SelectItem value="comfyui">ComfyUI / Kohya</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Manual model</p>
                      <Select
                        value={lora.manualModelId ?? BLANK_SELECT_VALUE}
                        onValueChange={(value) => {
                          updateMutation.mutate({
                            id: lora.id,
                            format: lora.manualFormat,
                            modelId: value === BLANK_SELECT_VALUE ? null : value as ModelId,
                          });
                        }}
                      >
                        <SelectTrigger className="text-sm">
                          <SelectValue placeholder="Blank" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={BLANK_SELECT_VALUE}>Blank</SelectItem>
                          {MODEL_OPTIONS.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {model.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Leave both selectors blank to rely on automatic detection only.
                  </p>
                  <p>
                    <span className="text-foreground">Base model:</span>{' '}
                    {lora.detectedBaseModelId ?? lora.baseModelHint ?? 'Not detected'}
                  </p>
                  <p>
                    <span className="text-foreground">Compatible app models:</span>{' '}
                    {lora.compatibleModelIds.length > 0 ? lora.compatibleModelIds.join(', ') : 'None matched'}
                  </p>
                  {lora.triggerPhrases.length > 0 && (
                    <p>
                      <span className="text-foreground">Trigger phrases:</span>{' '}
                      {lora.triggerPhrases.join(', ')}
                    </p>
                  )}
                </div>

                <div className="mt-4 rounded-xl border border-border/70 bg-card/60 p-3 text-sm">
                  <p className="font-medium text-foreground">Runtime status</p>
                  <p className="mt-1 text-muted-foreground">{lora.runtimeReadyReason}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{lora.fileReadyReason}</p>
                </div>

                {lora.issues.length > 0 && (
                  <div className="mt-4 rounded-xl border border-border/70 bg-card/60 p-3 text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">Inspection notes</p>
                    <ul className="mt-2 space-y-1">
                      {lora.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            ))}
          </div>
        </div>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <AlertTriangle className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Current limitations</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {runtimeSupport?.reason ?? 'LoRA runtime support is currently unavailable.'}
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              You can use one LoRA at a time during image generation. Only compatible fal.ai-style LoRAs are selectable in Studio.
            </p>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <FolderOpen className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Manual install</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              You can also copy LoRA files directly into the folder below. Refresh this page to detect new files.
            </p>
            <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
              {lorasQuery.data?.lorasDir ?? 'Loras/'}
            </p>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <ScanSearch className="h-4 w-4" />
              <h2 className="text-lg font-semibold">How detection works</h2>
            </div>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              <li>The app reads each file&apos;s header to identify its format without loading the full weights.</li>
              <li>It checks for metadata like base-model hints and trigger phrases.</li>
              <li>If auto-detection is uncertain, you can manually set the format and target model using the dropdowns on each card.</li>
            </ul>
          </section>
        </aside>
      </section>
    </main>
  );
}
