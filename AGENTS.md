# Project Overview

We are building a local-first image generation and editing studio around iris.c on macOS Apple Silicon.
This file is a durable handoff for AI coding agents. It documents what the project is, how it works, what has been implemented, user preferences, and known sharp edges.

## Hard requirements

- Native host execution only for inference. Do not Dockerize iris.c inference.
- Use a local checkout of `antirez/iris.c`.
- Build iris.c with `make mps`.
- Read the model path from `IRIS_MODEL_DIR`.
- Default model is `flux-klein-9b`.
- The app must support text-to-image, image-to-image, and multi-reference generation/editing.
- The backend should initially wrap the iris CLI. Do not invent unsupported inference parameters.
- Width and height must be multiples of 16 and capped at 1792.
- For FLUX distilled defaults, use auto steps, auto guidance, default schedule, and mmap.
- For Z-Image Turbo defaults, use 9 steps and 0 guidance.
- Run one generation job at a time by default.
- Persist job metadata: prompt, seed, size, model, timings, output path, and thumbnail path.
- Capture the seed from iris stderr and/or PNG metadata.
- Models, outputs, uploads, thumbnails, DB live inside the repo, not in home directory.
- Never commit generated images, model weights, or local DB files.

## Monorepo Layout

| Path | Purpose |
|------|---------|
| `apps/web` | Next.js frontend |
| `services/api` | Fastify API service |
| `vendor/iris.c` | Vendored native inference backend |
| `vendor/iris-lora.patch` | Custom LoRA implementation patch for iris.c |
| `Models/` | Model folders (flux-klein, zimage-turbo, etc.) |
| `Loras/` | LoRA .safetensors files |
| `storage/outputs` | Generated images |
| `storage/uploads` | Uploaded reference images |
| `storage/thumbs` | Thumbnails |
| `storage/app.db` | SQLite database |
| `docs/readme-assets` | README preview imagery |

## Stack

- Frontend: Next.js App Router, React 19, TypeScript, Tailwind, shadcn/ui, TanStack React Query, lucide-react.
- API: Fastify, TypeScript, Zod, better-sqlite3, sharp, dotenv.
- Native: Vendored `antirez/iris.c`, patched with `vendor/iris-lora.patch`, built with `make mps`.
- Storage: local filesystem + SQLite.
- Progress: SSE with granular job phases parsing iris.c stdout.

## Data Flow: Frontend → API → Worker → Iris CLI

1. **Frontend** (`apps/web`): User configures generation in settings rail. Calls `POST /api/jobs`.
2. **API** (`services/api/src/routes/jobs.ts`): Validates request. Inserts job into SQLite, calls `enqueueJob(id)`.
3. **Worker** (`services/api/src/worker.ts`): Single-threaded queue. Processes one job at a time.
   - Spawns `iris` CLI with correct args.
   - Parses stdout/stderr via `iris-progress.ts`.
   - Emits events: `queued` → `running` → `progress` (granular) → `saving` → `done` | `failed` | `cancelled`.
4. **SSE**: Frontend subscribes to `GET /api/jobs/stream` for live updates.

## LoRA Support

- **Patching**: iris.c does not natively support LoRAs. We maintain a custom implementation in `vendor/iris-lora.patch`.
- **Application**: The `quickstart.sh` script applies this patch to the `antirez/iris.c` checkout before building.
- **Compatibility**: Supports `fal-ai` style FLUX LoRAs (rank-matched tensors).
- **Z-Image**: LoRAs are **experimentally supported** on Z-Image Turbo. Use FLUX-compatible LoRAs with caution as architectures differ.

## UX rules

- Dark theme by default.
- Layout: left settings rail, center canvas, right history/metadata panel.
- Advanced controls stay collapsed by default.
- Surface seed, model, size, and a "rerun at 1024" action.
- Preserve a friendly creative-tool feel, but keep controls readable and professional.
- Avoid modal-heavy UX. Prefer inline drawers and side panels.
- Always keep the last prompt visible near the active image.
- Practical UI over abstract correctness. Clean interfaces, low clutter.
- No placeholder UI values that look fake.

## Prompt UX rules

- Encourage descriptive output prompts, not imperative editing commands.
- Add prompt examples beside text fields.
- Preserve prompt, seed, and size so jobs are reproducible.

## Quality bar

- Strict TypeScript.
- No `any` unless isolated and justified.
- Validate all API inputs.
- Prefer small composable components.
- Add keyboard shortcuts for generate, edit, rerun, and compare.
