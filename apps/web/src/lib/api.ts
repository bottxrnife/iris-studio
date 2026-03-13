import type {
  BenchmarkRun,
  BenchmarkStatusResponse,
  Job,
  JobListResponse,
  CreateJobRequest,
  EstimateJobRequest,
  EstimateJobResponse,
  JobStatusEvent,
  JobStreamEvent,
  JobProgress,
  ModelsResponse,
  LorasResponse,
  LoraInfo,
  LoraFormat,
} from './types';

const DEFAULT_SERVER_API_ORIGIN = 'http://127.0.0.1:8787';

function getApiBase() {
  const explicitOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;

  if (typeof window === 'undefined') {
    return `${explicitOrigin ?? DEFAULT_SERVER_API_ORIGIN}/api`;
  }

  return explicitOrigin ? `${explicitOrigin}/api` : '/api';
}

function getDirectApiBase() {
  const explicitOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;
  if (explicitOrigin) {
    return `${explicitOrigin}/api`;
  }
  if (typeof window !== 'undefined') {
    // Bypass Next.js proxy for large file uploads to prevent connection drops
    return `${window.location.protocol}//${window.location.hostname}:8787/api`;
  }
  return `${DEFAULT_SERVER_API_ORIGIN}/api`;
}

async function handleJsonError(res: Response, fallbackMessage: string) {
  const err = await res.json().catch(() => ({ error: fallbackMessage }));
  throw new Error(err.error ?? `HTTP ${res.status}`);
}

function toFetchError(error: unknown, fallbackMessage: string) {
  if (error instanceof Error) {
    if (error.name === 'TypeError') {
      return new Error(`${fallbackMessage}. The app could not reach the local API.`);
    }

    return error;
  }

  return new Error(fallbackMessage);
}

export async function getBenchmarkStatus(): Promise<BenchmarkStatusResponse> {
  try {
    const res = await fetch(`${getApiBase()}/benchmark`);
    if (!res.ok) {
      await handleJsonError(res, 'Failed to load benchmark status');
    }
    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to load benchmark status');
  }
}

export async function getModels(): Promise<ModelsResponse> {
  try {
    const res = await fetch(`${getApiBase()}/models`);
    if (!res.ok) {
      await handleJsonError(res, 'Failed to load models');
    }
    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to load models');
  }
}

export async function getLoras(): Promise<LorasResponse> {
  try {
    const res = await fetch(`${getApiBase()}/loras`);
    if (!res.ok) {
      await handleJsonError(res, 'Failed to load LoRAs');
    }
    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to load LoRAs');
  }
}

export async function downloadModel(modelId: string, token?: string): Promise<void> {
  try {
    const res = await fetch(`${getApiBase()}/models/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId,
        ...(token ? { token } : {}),
      }),
    });

    if (!res.ok) {
      await handleJsonError(res, 'Model download failed');
    }
  } catch (error) {
    throw toFetchError(error, 'Failed to start model download');
  }
}

export async function cancelModelDownload(modelId: string, mode: 'pause' | 'stop' = 'pause'): Promise<void> {
  try {
    const res = await fetch(`${getApiBase()}/models/${modelId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });

    if (!res.ok) {
      await handleJsonError(res, 'Could not cancel model download');
    }
  } catch (error) {
    throw toFetchError(error, 'Failed to cancel model download');
  }
}

export async function uploadLoras(files: File[]): Promise<LoraInfo[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('file', file);
  }

  try {
    const res = await fetch(`${getDirectApiBase()}/loras/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      await handleJsonError(res, 'LoRA upload failed');
    }
    const data = await res.json();
    return data.uploaded as LoraInfo[];
  } catch (error) {
    throw toFetchError(error, 'Failed to upload LoRA');
  }
}

export async function deleteLora(id: string): Promise<void> {
  try {
    const res = await fetch(`${getApiBase()}/loras/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      await handleJsonError(res, 'Delete failed');
    }
  } catch (error) {
    throw toFetchError(error, 'Failed to delete LoRA');
  }
}

export async function updateLoraSettings(
  id: string,
  data: { format: Exclude<LoraFormat, 'unknown'> | null; modelId: string | null }
): Promise<LoraInfo> {
  try {
    const res = await fetch(`${getApiBase()}/loras/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      await handleJsonError(res, 'Update failed');
    }
    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to update LoRA settings');
  }
}

export async function startBenchmark(model?: string): Promise<BenchmarkRun> {
  try {
    const res = await fetch(`${getApiBase()}/benchmark/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
    });

    if (!res.ok) {
      await handleJsonError(res, 'Benchmark request failed');
    }

    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to start benchmark');
  }
}

export async function stopBenchmark(): Promise<BenchmarkRun> {
  try {
    const res = await fetch(`${getApiBase()}/benchmark/cancel`, {
      method: 'POST',
    });

    if (!res.ok) {
      await handleJsonError(res, 'Benchmark stop failed');
    }

    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to stop benchmark');
  }
}

export async function createJob(data: CreateJobRequest): Promise<Job> {
  try {
    const res = await fetch(`${getApiBase()}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      await handleJsonError(res, 'Request failed');
    }

    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to queue job');
  }
}

export async function estimateJob(data: EstimateJobRequest): Promise<EstimateJobResponse> {
  try {
    const res = await fetch(`${getApiBase()}/jobs/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      await handleJsonError(res, 'Estimate request failed');
    }

    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to estimate generation time');
  }
}

export async function listJobs(limit = 20, offset = 0): Promise<JobListResponse> {
  try {
    const res = await fetch(`${getApiBase()}/jobs?limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      await handleJsonError(res, 'Failed to load history');
    }
    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to load history');
  }
}

export async function getJob(id: string): Promise<Job> {
  try {
    const res = await fetch(`${getApiBase()}/jobs/${id}`);
    if (!res.ok) {
      await handleJsonError(res, 'Failed to load job');
    }
    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to load job');
  }
}

export async function deleteJob(id: string): Promise<void> {
  try {
    const res = await fetch(`${getApiBase()}/jobs/${id}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      await handleJsonError(res, 'Delete failed');
    }
  } catch (error) {
    throw toFetchError(error, 'Failed to delete job');
  }
}

export async function downloadJobsZip(jobIds: string[]): Promise<void> {
  try {
    const res = await fetch(`${getApiBase()}/jobs/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobIds }),
    });

    if (!res.ok) {
      await handleJsonError(res, 'Download failed');
    }

    const blob = await res.blob();
    const contentDisposition = res.headers.get('Content-Disposition');
    const filenameMatch = contentDisposition?.match(/filename="([^"]+)"/i);
    const filename = filenameMatch?.[1] ?? 'iris-history.zip';
    const objectUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      window.URL.revokeObjectURL(objectUrl);
    }, 0);
  } catch (error) {
    throw toFetchError(error, 'Failed to download images');
  }
}

export async function cancelJob(id: string): Promise<Job> {
  try {
    const res = await fetch(`${getApiBase()}/jobs/${id}/cancel`, {
      method: 'POST',
    });

    if (!res.ok) {
      await handleJsonError(res, 'Stop failed');
    }

    return res.json();
  } catch (error) {
    throw toFetchError(error, 'Failed to stop job');
  }
}

export function subscribeToJob(
  id: string,
  onEvent: (event: JobStreamEvent) => void
): () => void {
  const es = new EventSource(`${getApiBase()}/jobs/${id}/events`);

  es.addEventListener('status', (e) => {
    onEvent({
      type: 'status',
      data: JSON.parse(e.data) as JobStatusEvent,
    });
  });

  es.addEventListener('progress', (e) => {
    onEvent({
      type: 'progress',
      data: JSON.parse(e.data) as JobProgress,
    });
  });

  es.addEventListener('done', (e) => {
    onEvent({
      type: 'done',
      data: JSON.parse(e.data) as Job,
    });
    es.close();
  });

  es.onerror = () => {
    es.close();
  };

  return () => es.close();
}

export async function uploadFiles(files: File[]): Promise<string[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('file', file);
  }
  try {
    const res = await fetch(`${getApiBase()}/uploads`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      await handleJsonError(res, 'Upload failed');
    }
    const data = await res.json();
    return data.files;
  } catch (error) {
    throw toFetchError(error, 'Failed to upload image');
  }
}

export function getOutputImageUrl(filename: string): string {
  return `/api/images/outputs/${filename}`;
}

export function getThumbUrl(filename: string): string {
  return `/api/images/thumbs/${filename}`;
}

export function getUploadUrl(filename: string): string {
  return `/api/images/uploads/${filename}`;
}
