# Iris Studio Agent Handoff

Verified against the current codebase on 2026-03-16.

This file is a durable handoff for AI coding agents working in `/Users/williamliu/Documents/GitHub/iris-studio`.
It documents the implemented architecture, current product behavior, user preferences, local-only constraints, and the custom LoRA path that extends `iris.c`.

## Product Summary

Iris Studio is a local-first image generation and editing app for Apple Silicon Macs.

- Frontend: Next.js App Router app in `apps/web`
- API: Fastify service in `services/api`
- Native inference: local `antirez/iris.c` checkout in `vendor/iris.c`
- Storage: local filesystem plus SQLite in `storage/`
- Primary workflow: web UI -> Fastify API -> single-job worker -> `iris` CLI

The app supports:

- text-to-image
- image-to-image with one reference
- multi-reference generation/editing with 2+ references
- local model management and downloads
- LoRA cataloging and one-LoRA-at-a-time runtime application
- live progress via SSE
- queueing, cancellation, restart, rerun, bulk download, and history
- per-model benchmarking and ETA estimation

## Hard Requirements

Keep these invariants unless the user explicitly changes the product direction:

- Native host execution only for inference. Do not Dockerize `iris.c` inference.
- Use a local checkout of `antirez/iris.c`.
- Build `iris.c` with `make mps`.
- Read the model path from `IRIS_MODEL_DIR`.
- Default model is `flux-klein-9b`.
- Models, LoRAs, outputs, uploads, thumbnails, and DB live inside the repo.
- Never commit generated images, model weights, vendored `vendor/iris.c`, or the local DB.
- Backend generation should continue wrapping the `iris` CLI instead of inventing a custom inference server.
- Width and height must be multiples of 16 and capped at 1792.
- Run one generation job at a time by default.
- Persist job metadata locally, including prompt, seed, size, model, timings, output path, and thumb path.
- Capture the seed from `iris` stderr if possible.

Behavioral defaults currently implemented:

- Distilled FLUX defaults are achieved by not forcing steps/guidance unless the user opens advanced controls and overrides them.
- Z-Image Turbo defaults are surfaced from the model catalog as 9 steps and 0 guidance.
- The worker does not invent extra inference flags beyond what the CLI already supports.

## Local-Only and Git Hygiene

Important repo hygiene details:

- `.gitignore` ignores `storage/`, `Models/*`, `Loras/*`, `.env`, `.env.local`, and `vendor/iris.c/`.
- `.gitignore` also ignores `AGENTS.md`, so changes here are local handoff improvements and will not show up in git status.
- `vendor/iris-lora.patch` is intentionally tracked and is the durable native LoRA customization.
- `Models/README.md` and `Loras/README.md` are tracked placeholders; actual weights/files are local-only.
- Do not push to GitHub automatically while making changes. Only push when the user explicitly asks for a push.

## Runtime Configuration

`services/api/src/config.ts` loads `.env` and `.env.local` from the repo root and resolves these paths:

- `IRIS_BIN` -> defaults to `vendor/iris.c/iris`
- `IRIS_MODEL_DIR` -> defaults to `Models`
- `IRIS_LORA_DIR` -> defaults to `Loras`
- `IRIS_OUTPUT_DIR` -> defaults to `Outputs`
- `IRIS_UPLOAD_DIR` -> defaults to `storage/uploads`
- `IRIS_THUMB_DIR` -> defaults to `storage/thumbs`
- `IRIS_DB_PATH` -> defaults to `storage/app.db`

Other fixed config:

- API host: `127.0.0.1`
- API port: `8787`
- default model id: `flux-klein-9b`
- max dimension: `1792`
- thumbnail size: `256`

## Monorepo Layout

| Path | Purpose |
|------|---------|
| `apps/web` | Next.js UI |
| `services/api` | Fastify API, worker, DB, model/LoRA logic |
| `vendor/iris.c` | Local `antirez/iris.c` checkout, usually gitignored |
| `vendor/iris-lora.patch` | Native LoRA support patch applied onto `iris.c` |
| `Models/` | Local model folders |
| `Loras/` | Local `.safetensors` LoRA files and override metadata |
| `Outputs/` | Generated images |
| `storage/uploads` | Uploaded reference images |
| `storage/thumbs` | WebP thumbnails |
| `storage/app.db` | SQLite database |
| `docs/readme-assets` | README screenshots and preview assets |

## Architecture Overview

### Backend startup

`services/api/src/index.ts`:

- ensures output/upload/thumb directories exist
- enables CORS and multipart upload support
- serves three static mounts:
  - `/api/images/outputs/`
  - `/api/images/thumbs/`
  - `/api/images/uploads/`
- registers route groups for jobs, benchmark, models, LoRAs, and uploads
- restores queued jobs and interrupted benchmark state on boot

### Frontend shell

`apps/web/src/app/layout.tsx` and `apps/web/src/components/app-header.tsx`:

- always run in dark mode
- expose top-level routes:
  - `/` Studio
  - `/models`
  - `/loras`
  - `/settings`
  - `/help`
- wrap the frontend in `SettingsProvider`, which persists app-level UI preferences in `localStorage` under `iris-app-settings`

## Current Frontend UX

### Studio page

`apps/web/src/app/page.tsx` composes a three-pane layout:

- left: `SettingsRail`
- center: `Canvas`
- right: `HistoryPanel`

Both side panes are resizable by pointer drag.

### Settings rail

`apps/web/src/components/settings-rail.tsx` currently implements:

- mode switcher for `txt2img`, `img2img`, and `multi-ref`
- installed-model picker only
- LoRA picker filtered by compatible model and `runtimeReady`
- LoRA strength slider from `0` to `2` in `0.05` steps
- prompt textarea plus random example generator
- optional batch prompt upload from `.txt` files, capped at `200` prompts
- seed input
- advanced controls section for steps, guidance, iterations, and seed mode
- reference image uploads
- image edit output scaling based on the first reference image
- live ETA estimate via `/api/jobs/estimate`

Persisted browser state:

- selected mode is stored in `localStorage` under `iris-selected-mode`
- selected model is stored in `localStorage` under `iris-selected-model`
- the full Studio draft is also stored in `localStorage` under `iris-studio-draft`
- the persisted Studio draft includes prompt text, LoRA selection, size settings, seed, advanced controls, reference image metadata, scale percentage, and batch prompt state
- Studio draft persistence itself is user-configurable from `/settings`; disabling it removes `iris-studio-draft`

Important behavior:

- image/multi modes auto-fit output size within the same reference-budget formula used by the backend
- only installed models are selectable for generation
- only `runtimeReady` LoRAs are selectable in Studio
- batch prompts and iteration count expand into multiple `POST /api/jobs` calls on the client
- `Cmd+Enter` or `Ctrl+Enter` triggers generation
- the selected-model guidance card can be hidden from `/settings`
- the advanced section default-open state is also controlled from `/settings`

### Canvas

`apps/web/src/components/canvas.tsx`:

- subscribes to a selected job via SSE
- shows live phase/progress/ETA UI while generating
- displays the final output image when done
- surfaces failure/cancel states with restart guidance
- keeps the last prompt visible below the image
- respects user settings for showing ETA, elapsed time, seed, queue position, phase checklist, and prompt footer
- only shows the step checklist for the actively running job, not queued jobs

### History panel

`apps/web/src/components/history-panel.tsx` supports:

- paginated history, with page size configurable from `/settings`
- job selection and detail view
- stop active or queued jobs
- restart failed/cancelled jobs
- rerun completed jobs at `1024 x 1024`
- load any job back into the editor (`To Editor`)
- single or bulk delete of terminal jobs only
- single direct download or bulk zip download
- left/right/up/down arrow keyboard navigation across history
- respects user settings for delete confirmations, stop confirmations, compact history cards, ETA visibility, elapsed visibility, seed visibility, and queue-position visibility

### Settings page

`apps/web/src/app/settings/page.tsx` provides app-level UX controls for:

- delete confirmations for finished images and cancelled jobs
- stop confirmation prompts
- whether new jobs auto-select into the canvas
- whether the Studio draft persists across navigation
- whether advanced controls default open
- whether the model guidance card is shown
- whether ETA, elapsed time, seeds, queue positions, phase checklist, and prompt footer are shown
- compact history cards
- history page size
- default left/right pane widths

### Models page

`apps/web/src/app/models/page.tsx` includes:

- supported model catalog
- install state and missing-component warnings
- download progress, logs, speed, and ETA
- gated-model token input
- per-model benchmark controls and sample results
- memory guidance per model

### LoRAs page

`apps/web/src/app/loras/page.tsx` includes:

- drag-and-drop or file-picker upload for `.safetensors`
- library view of inspected LoRAs
- runtime-ready vs catalog-only state
- manual format override
- manual model override
- local delete
- explanation of current limitations and detection behavior

### Help page

`apps/web/src/app/help/page.tsx` is not an LLM integration.
It is a local keyword-matching FAQ/chat helper with canned answers.

## API Route Map

### Health and static assets

- `GET /api/health`
- `GET /api/images/outputs/:file`
- `GET /api/images/thumbs/:file`
- `GET /api/images/uploads/:file`

### Jobs

Implemented in `services/api/src/routes/jobs.ts`:

- `POST /api/jobs`
- `POST /api/jobs/estimate`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `DELETE /api/jobs/:id`
- `POST /api/jobs/download`
- `POST /api/jobs/:id/cancel`
- `GET /api/jobs/:id/events`

### Models

Implemented in `services/api/src/routes/models.ts`:

- `GET /api/models`
- `POST /api/models/download`
- `POST /api/models/:id/cancel`

### LoRAs

Implemented in `services/api/src/routes/loras.ts`:

- `GET /api/loras`
- `POST /api/loras/upload`
- `DELETE /api/loras/:id`
- `PATCH /api/loras/:id`

### Reference uploads

Implemented in `services/api/src/routes/uploads.ts`:

- `POST /api/uploads`

### Benchmarking

Implemented in `services/api/src/routes/benchmark.ts`:

- `GET /api/benchmark`
- `POST /api/benchmark/run`
- `POST /api/benchmark/cancel`

## Database and Persistence

`services/api/src/db.ts` owns SQLite setup via `better-sqlite3`.

### `jobs` table

Current persisted columns:

- `id`
- `status`
- `mode`
- `prompt`
- `width`
- `height`
- `seed`
- `model`
- `lora_id`
- `lora_name`
- `lora_scale`
- `steps`
- `guidance`
- `input_paths`
- `output_path`
- `thumb_path`
- `duration_ms`
- `iris_stderr`
- `metadata`
- `created_at`
- `updated_at`

### `benchmark_runs` table

- `id`
- `model`
- `status`
- `total_cases`
- `completed_cases`
- `current_case_label`
- `error`
- `started_at`
- `finished_at`

### `benchmark_samples` table

- `id`
- `run_id`
- `mode`
- `label`
- `width`
- `height`
- `input_count`
- `duration_ms`
- `created_at`

Migration style today:

- lightweight `ALTER TABLE` checks are done in code via `ensureColumn`
- there is no external migration framework

## Job Lifecycle and Worker Behavior

`services/api/src/worker.ts` is the core generation worker.

### Queue model

- one active job max
- FIFO in-memory queue
- `restoreQueuedJobs()` requeues jobs that were `queued`, `running`, or `saving` during an API restart
- any partially saved output or thumb for recoverable jobs is cleaned up on restore

### Generation flow

For each job:

1. mark DB status `running`
2. build CLI args from the job row
3. spawn `IRIS_BIN`
4. parse stderr for progress
5. on success, generate a WebP thumbnail via `sharp`
6. parse seed and metadata from stderr
7. persist final DB state
8. emit SSE/listener events

### Cancellation

- queued jobs are removed from the queue and marked `cancelled`
- active jobs receive `SIGTERM`
- if still alive after 3 seconds, the worker escalates to `SIGKILL`
- cancelled jobs lose any partially written output/thumb artifacts

### Seed and metadata capture

Current implementation parses stderr for:

- `Seed:`
- `Steps:`
- `Guidance:`
- `Model:`
- `LoRA:`
- `LoRA scale:`
- `Scheduler:`
- `Total time:`
- `Generation time:`

If stderr does not contain these lines, metadata stays partial or null.
There is not yet a PNG metadata fallback in the current code.

## Request Validation and Size Rules

`services/api/src/schemas.ts` uses Zod.

- width and height are clamped to `config.maxDimension`
- width and height must be integers, at least `64`, and multiples of `16`
- job modes are `txt2img`, `img2img`, `multi-ref`
- model ids are a strict enum of supported ids
- `loraScale` is limited to `0..2`
- `steps` is limited to `1..100`
- `guidance` is limited to `0..30`
- `inputPaths` is capped at `16`

Mode validation:

- `img2img` requires at least 1 input image
- `multi-ref` requires at least 2 input images

## Reference Budget and Image Editing Size Fitting

Both frontend and backend implement the same reference-budget math:

- constant text sequence budget of `512`
- FLUX 9B head count assumption of `32`
- max attention bytes of `4 GiB`

The server-side implementation lives in `services/api/src/routes/jobs.ts`.
The client-side mirror lives in `apps/web/src/components/settings-rail.tsx`.

This is important:

- image edit jobs may be silently downscaled from the requested size
- text-to-image keeps the requested size
- image and multi-reference jobs are size-fit against both max dimension and attention budget

## Progress, SSE, and ETA Estimation

### Progress parsing

`services/api/src/iris-progress.ts` parses `iris` stderr into:

- current phase
- step and total steps
- percent
- substep count during denoising

It tracks phases like:

- initializing
- VAE loading
- text encoder loading
- prompt encoding
- transformer loading
- denoising
- decoding
- saving

### SSE

The app does not currently expose a global stream.
Instead each selected job uses `GET /api/jobs/:id/events`.

Events sent:

- `status`
- `progress`
- `done`

### ETA estimation

`services/api/src/routes/jobs.ts` contains a fairly rich local estimator:

- uses recent completed job timings
- prefers same-model samples when enough are available
- optionally mixes benchmark samples
- removes timing outliers
- blends nearest-neighbor and regression estimates
- projects active job completion based on live denoising progress
- returns per-job remaining time and queue-ahead time

This is much more advanced than the original AGENTS draft implied.

## Model Management

`services/api/src/models.ts` defines the supported catalog:

- `flux-klein-4b`
- `flux-klein-base-4b`
- `flux-klein-9b`
- `flux-klein-base-9b`
- `zimage-turbo-6b`

Each model record includes:

- label
- summary
- variant
- parameter size
- Hugging Face repo id and URL
- recommended steps
- recommended guidance
- license
- gated vs ungated
- expected install directory name

### Installation detection

The API considers a model installed only if the expected folder exists and contains required components like:

- `model_index.json`
- `transformer/config.json`
- transformer weights
- `text_encoder/config.json`
- text encoder weights
- tokenizer config and tokenizer data
- `vae/config.json`
- VAE weights

Result states:

- `missing`
- `partial`
- `installed`

### Download behavior

Model downloads use the Hugging Face CLI, not a JS SDK.

Flow:

1. ensure `Models/` exists
2. ensure `hf` CLI exists, installing `huggingface_hub[cli]` via `python3 -m pip --user` if necessary
3. run `hf download <repoId> --local-dir <installDir>`
4. parse stdout/stderr for percent, throughput, and ETA
5. verify the installed folder contents

Download constraints:

- only one model download at a time
- gated models require a token
- pause keeps partial files for resume
- stop removes the partial target directory

## Benchmarking

`services/api/src/benchmark.ts` runs local benchmark cases for one model at a time.

Current benchmark matrix:

- `txt2img`: `512`, `768`, `1024`
- `img2img`: `512`, `768`, `1024`

Important rules:

- benchmark requires an empty generation queue
- benchmark jobs do not persist output images
- benchmark results are stored in SQLite
- interrupted benchmark runs are marked failed on API restart

The benchmark route surface is used by the Models page to show per-model timing data and improve ETA quality.

## LoRA Support: App Layer

`services/api/src/loras.ts` is the LoRA catalog and compatibility layer.

### What the app does before runtime

For each file in `Loras/`:

- only inspects the safetensors header, not the full file
- caps header reads at `16 MiB`
- detects tensor dtype
- detects likely LoRA tensor keys
- extracts trigger phrases from metadata
- infers likely format
- infers base-model hints
- derives compatible app model ids
- determines `fileReady` and `runtimeReady`

Supported format labels:

- `fal-ai`
- `comfyui`
- `unknown`

Supported dtype buckets:

- `bf16`
- `f16`
- `f32`
- `other`
- `mixed`
- `unknown`

### Compatibility heuristics

The app recognizes:

- exact FLUX Klein tokens from metadata or filename
- broad FLUX family hints such as `flux dev` or `flux schnell`
- architecture fallback based on tensor key patterns like `double_blocks` and `single_blocks`

Manual overrides are persisted in:

- `Loras/.iris-lora-overrides.json`

Override fields:

- `format`
- `modelId`

### Runtime selection rules

The app only exposes a LoRA in Studio if all of these are true:

- file exists and is a `.safetensors` file
- tensor names look like a LoRA
- effective format is `fal-ai`
- dtype is supported (`bf16`, `f16`, or `f32`)
- compatible model ids are non-empty

Current runtime support surfaced by the API:

- one LoRA at a time
- one strength multiplier
- compatible FLUX-family targets only

The app intentionally catalogs more LoRAs than it allows to run.

## LoRA Support: Native `iris.c` Patch

`vendor/iris-lora.patch` is the native extension that makes runtime LoRA application possible.

### High-level patch behavior

The patch modifies upstream `iris.c` to add:

- `iris_set_lora(ctx, path, scale)` in `iris.h` / `iris.c`
- CLI flags:
  - `--lora PATH`
  - `--lora-scale N`
- LoRA-related logging in `main.c`
- native FLUX transformer weight patching in `iris_transformer_flux.c`

### What happens at runtime

When a LoRA is selected:

1. the app passes `--lora` and `--lora-scale` to the `iris` CLI
2. the patched CLI stores LoRA config on the `iris_ctx`
3. transformer loading switches to the non-mmap safetensors path for that run
4. the patch opens the LoRA safetensors file
5. it normalizes supported LoRA tensor keys and groups A/B pairs plus optional alpha
6. it builds a target map for writable FLUX transformer weights
7. it applies the LoRA delta directly into in-memory transformer weights
8. Metal weight caches are cleared so the updated weights take effect

### Important native details

The patch supports:

- one LoRA file at a time
- scale multiplier applied at load time
- floating-point LoRA tensors (`bf16`, `f16`, `f32`)
- `lora_A`/`lora_B` and `lora_down`/`lora_up` suffix patterns
- target aliases covering both diffusers-style names and `base_model.model.*` style names

The patch rejects:

- missing path
- mmap-backed transformer application for LoRA runs
- unsupported tensor key families
- non-floating-point LoRA tensors
- rank mismatches
- shape mismatches
- unsupported FLUX targets

### Practical consequence

The native patch is the reason LoRAs can actually run locally.
Without `vendor/iris-lora.patch`, the rest of the LoRA UI is only catalog/metadata plumbing.

Also note:

- the patch disables transformer mmap for LoRA runs, so LoRA jobs may use more memory than non-LoRA jobs
- the API layer does not currently expose multiple-LoRA composition

## How Jobs Use LoRAs End-to-End

End-to-end LoRA path today:

1. user uploads a `.safetensors` file on `/loras`
2. API inspects it and marks it runtime-ready or catalog-only
3. user selects a compatible installed model in Studio
4. Studio filters to `runtimeReady` LoRAs matching that model
5. `POST /api/jobs` stores `lora_id`, `lora_name`, and `lora_scale`
6. worker resolves the local file path and appends:
   - `--lora <path>`
   - `--lora-scale <scale>`
7. patched `iris` applies the adapter before generation
8. stderr metadata is parsed back into the saved job record

## Quickstart Script

`quickstart.sh` is the supported local bootstrap.

It currently:

- checks for macOS and warns if not Apple Silicon
- checks Xcode CLI tools
- checks Node and npm
- clones or reuses `vendor/iris.c`
- attempts `git pull --ff-only` for an existing checkout
- applies `vendor/iris-lora.patch` if not already applied
- builds with `make mps`
- creates repo-local `Models/`, `Loras/`, and `storage/` folders if needed
- writes `.env`
- installs npm dependencies
- starts the dev servers with `npm run dev`

Current quickstart philosophy:

- no interactive prompts
- no model download questions
- no path customization during bootstrap
- everything stays inside the repo folder where the script lives
- users are expected to download models later from the web UI or manually place them in `Models/`

The script is the clearest source of truth for how the patch is meant to be applied to upstream `iris.c`.

## Development Commands

Top-level `package.json`:

- `npm run dev`
- `npm run dev:api`
- `npm run dev:web`
- `npm run build`
- `npm run typecheck`
- `npm run lint`

Workspace specifics:

- API dev server: `tsx watch src/index.ts`
- Web dev server: `next dev --port 3000`

## Known Sharp Edges and Limitations

- `AGENTS.md` is gitignored, so documentation updates here are local-only.
- The generation queue is intentionally single-threaded.
- The job SSE stream is per-job, not a shared queue stream.
- Only one LoRA can be active per generation.
- The app catalogs some non-runnable LoRAs intentionally; runtime availability is narrower than catalog visibility.
- The UI currently blocks `comfyui`-classified LoRAs from runtime use even though the native patch handles some common tensor suffix variants.
- Seed capture is stderr-based only in current code; PNG metadata fallback is not implemented yet.
- `POST /api/uploads` does not do deep image validation; it writes uploaded files and trusts the browser-side flow.
- Bulk download depends on `/usr/bin/zip`, which is fine on macOS but is a platform assumption.
- The benchmark suite covers `txt2img` and single-reference `img2img`, not multi-reference jobs.
- The help page is a static keyword helper, not a true assistant.
- The frontend uses `useMemo` in a few places despite the broader preference to avoid it by default; follow existing local patterns when touching those areas.
- There is no automated test suite in the repo right now.

## Reality Check vs Earlier Draft

The original shorter AGENTS draft understated the current implementation.
As of this verification pass, the codebase already includes:

- model download/install state tracking
- LoRA upload, inspection, compatibility filtering, and overrides
- native LoRA application via a maintained `iris.c` patch
- queue recovery after API restart
- benchmark persistence and per-model results
- a real ETA estimator using benchmark and job history
- prompt-file batch queueing
- history bulk actions and zip export
- a local help page

If you are making changes, prefer documenting the actual implemented behavior here rather than the originally planned behavior.
