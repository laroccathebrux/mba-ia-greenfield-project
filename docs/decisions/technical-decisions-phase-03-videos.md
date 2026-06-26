---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-26
scope_description: "Backend foundation for video upload and processing: large-file (up to 10GB) upload without blocking the API, object storage organization, background processing queue, a dedicated FFmpeg worker, automatic metadata/duration extraction and thumbnail generation, unique per-video URL, streaming and download delivery, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (entity, endpoints, services), the object-storage integration, the processing queue producer, and the dedicated video worker. All Phase 03 capabilities are backend; this is a backend-only phase.
- `next-frontend/` — Frontend deferred: the video UI (upload screen, player) is out of scope for Phase 03 per the challenge statement ("a interface de vídeo não faz parte do escopo desta fase"). No open decision in this document.

The object storage backend itself is **not** an open decision — the project already targets S3-compatible storage (`docs/diagrams/software-arch.mermaid`: "Object Storage — S3 or MinIO"). Locally it runs as **MinIO** in Docker (same API as S3), swappable for AWS S3 in production. What is decided here is *how* to use it (TD-02: SDK, bucket/key layout, presigning). The genuinely open stack decision is the **message queue** (TD-01), which the architecture diagram leaves explicitly as "TBD".

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video processing (ffprobe metadata extraction + thumbnail generation) is CPU/IO heavy and must run asynchronously, decoupled from the upload request. The architecture diagram (`software-arch.mermaid`) reserves a "Message Queue (TBD)" container between the API (producer) and the Video Worker (consumer). This is the principal open stack decision of the phase: which broker/queue library backs the job queue. The current stack has PostgreSQL 17 and no Redis.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue. The API injects a `Queue` and calls `queue.add(jobName, payload, opts)`; the worker is a `@Processor` class extending `WorkerHost` whose `process(job)` runs the FFmpeg pipeline. Redis runs as a new Compose service.
- **Pros:** De-facto standard for Node/NestJS background jobs; first-class NestJS module (`@nestjs/bullmq` v11 aligns with NestJS 11). Built-in retries with exponential backoff, per-queue concurrency, delayed/repeatable jobs, dead-letter semantics via failed state, and queue events for observability. Redis is a clearly visible, dedicated queue container in Compose — exactly the "fila real subindo no Compose" the phase requires. Battle-tested for media-processing fan-out.
- **Cons:** Introduces Redis as new infrastructure (one more container + one more dependency surface). Jobs are not enqueued in the same transaction as the DB write (eventual consistency between "video row" and "job enqueued").

### Option B: pg-boss (PostgreSQL-backed queue)
- Job queue implemented on top of the existing PostgreSQL via `SKIP LOCKED`. No new broker; jobs live in Postgres tables.
- **Pros:** Reuses the database already in the stack — no Redis. Enqueue can share the DB transaction with the video row insert (transactional outbox-like consistency). Fewer moving parts operationally.
- **Cons:** No dedicated, separately-visible queue service in Compose (the "queue" is just Postgres) — weaker fit for the phase requirement that a queue infra subir no Compose as a distinct component. Smaller NestJS ecosystem (no official module; manual wiring). Heavy media throughput contends with the primary OLTP database for connections and IO. Worker concurrency/backoff semantics are less rich than BullMQ.

### Option C: RabbitMQ (`amqplib` / `@nestjs/microservices` RMQ transport)
- AMQP broker. API publishes to an exchange/queue; the worker is a microservice consumer.
- **Pros:** Robust, language-agnostic broker with mature routing, acks, and DLX (dead-letter exchanges). Clean producer/consumer separation; scales horizontally.
- **Cons:** Heaviest operational footprint of the three (broker + management). NestJS RMQ transport is request/reply-oriented (microservice messaging), a slightly awkward fit for fire-and-forget long-running jobs with retry/backoff — you end up re-implementing job semantics BullMQ gives for free. Overkill for a single-worker video pipeline at this stage.

**Recommendation:** **Option A (BullMQ + Redis)** — It is the NestJS-canonical job queue with the richest out-of-the-box job semantics (retry/backoff, concurrency, failed-state handling) that the status lifecycle (TD-08) and worker (TD-04) directly depend on, and Redis provides the distinct, real queue container the phase requires in Compose. The lack of transactional enqueue is mitigated by enqueueing only after the video reaches `processing` and by the worker being idempotent on `videoId`.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-02: Object Storage Access — SDK and Bucket/Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is fixed to S3-compatible (MinIO locally, S3 in prod). What must be decided is the client library, how the API/worker authenticate and address the bucket (MinIO needs path-style addressing and a custom endpoint), and the bucket/key organization for originals and thumbnails. This contract is cited across the storage service, the worker, the upload flow (TD-03), and the delivery flow (TD-07).

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Official modular AWS SDK. `S3Client` configured with `endpoint`, `forcePathStyle: true`, `region`, and static credentials points transparently at MinIO or real S3. Presigned URLs via `getSignedUrl`. Multipart commands (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`) are first-class.
- **Pros:** Same code runs against MinIO (dev) and AWS S3 (prod) — only env config changes, matching the "swap MinIO for S3 in production" intent. First-class presigning (required by TD-03/TD-07). Tree-shakeable, TypeScript-native, actively maintained. Industry standard.
- **Cons:** Verbose command/middleware API. Several sub-packages to install.

### Option B: MinIO JavaScript SDK (`minio`)
- MinIO's own client. Simpler high-level methods (`presignedPutObject`, `fPutObject`).
- **Pros:** Ergonomic API; MinIO-first.
- **Cons:** Couples the code to the MinIO client even though production targets AWS S3; presigned multipart ergonomics are weaker; smaller ecosystem than the AWS SDK. Diverges from the "S3-compatible, portable to S3" architecture intent.

**Bucket/key layout (decided):** single bucket `streamtube-videos`, keys namespaced by video id:
- original: `videos/{videoId}/original{ext}`
- thumbnail: `thumbnails/{videoId}.jpg`

Bucket is created idempotently on startup (`HeadBucket` → `CreateBucket` if absent). The per-video id prefix avoids cross-video key conflicts and keeps originals and thumbnails grouped/listable.

**Recommendation:** **Option A (AWS SDK v3)** — Portability between MinIO and AWS S3 with no code change, plus first-class presigning and multipart support that TD-03 and TD-07 require, outweigh the more verbose API.

**Decision:** A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, single bucket with `videos/` + `thumbnails/` prefixes, path-style endpoint)

---

## TD-03: Large-File (10GB) Upload Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB file must reach storage without the bytes flowing through (and blocking/buffering in) the NestJS API. Passing the whole file through the API is the explicitly-forbidden anti-pattern ("Passar o arquivo de 10GB pela API de forma que trave o sistema" = reprova). The strategy also defines when the draft video row is created.

**Options:**

### Option A: Presigned **multipart** upload, client → storage directly
- Flow: (1) `POST /videos` pre-registers the video as `draft` and calls `CreateMultipartUpload` on storage, returning `videoId`, `uploadId`, and the object key. (2) The client requests presigned `UploadPart` URLs (`POST /videos/:id/parts`) and `PUT`s each ~50–100MB chunk **directly to storage** — no bytes touch the API. (3) `POST /videos/:id/complete` sends the ordered `{partNumber, eTag}` list; the API calls `CompleteMultipartUpload`, flips status to `processing`, and enqueues the processing job.
- **Pros:** Zero video bytes through the API — only small JSON control messages. Native support for very large files (S3 multipart supports up to 5TB / 10,000 parts). Per-part retry; partial-failure resilience. The draft row exists from step 1, satisfying "pré-cadastro como rascunho". Works identically on MinIO and S3.
- **Cons:** Multi-step handshake (initiate → parts → complete) — more endpoints and client orchestration. Incomplete multipart uploads must be reaped (abort/lifecycle policy).

### Option B: Single presigned `PUT` (one URL for the whole object)
- `POST /videos` returns one presigned `PUT` URL; client uploads the entire file in one request directly to storage.
- **Pros:** Simplest handshake; still keeps bytes out of the API.
- **Cons:** A single `PUT` of 10GB is fragile — any network blip restarts the entire upload; S3 single-PUT max is 5GB, **below the 10GB requirement**. No per-part retry. Disqualified by the 10GB ceiling.

### Option C: tus resumable upload protocol (`tus-node-server`)
- Resumable upload protocol with a tus server endpoint.
- **Pros:** Best-in-class resumability/pause-resume UX.
- **Cons:** The tus server terminates the upload — bytes flow through the Node process unless paired with an S3 store add-on, adding a heavyweight dependency and a parallel storage path. Larger surface than the phase needs; multipart already gives chunked resilience without proxying bytes.

### Option D: Stream the multipart/form-data through the API to storage
- `POST /videos` receives the file via Busboy/streaming and pipes it to storage.
- **Pros:** Single endpoint; familiar.
- **Cons:** Bytes flow through the API process — exactly the forbidden anti-pattern; ties up an API worker for the entire (potentially hours-long) 10GB transfer. Rejected.

**Recommendation:** **Option A (presigned multipart, direct to storage)** — It is the only option that both keeps 10GB of bytes out of the API and supports the full 10GB size with per-part retry, while the initiate step naturally creates the `draft` pre-registration. The extra endpoints are a worthwhile cost for correctness.

**Decision:** A (presigned multipart upload; API issues presigned part URLs and orchestrates initiate/complete; bytes go client→storage directly)

---

## TD-04: Worker Deployment Model

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The architecture diagram models the Video Worker as a **separate container** from the API. We must decide how the BullMQ consumer (TD-01) is deployed and bootstrapped relative to the NestJS API process, and how it shares the codebase.

**Options:**

### Option A: Dedicated worker container, separate Nest bootstrap (shared image)
- A second entrypoint (`main.worker.ts`) boots a Nest **application context** (`NestFactory.createApplicationContext(WorkerModule)`) that registers only the BullMQ `@Processor` (FFmpeg pipeline), the storage service, and the videos repository — **no HTTP server**. The same Docker image runs the API (`start`) or the worker (`start:worker`) by command; a `worker` service is added to Compose.
- **Pros:** Matches the target architecture (distinct worker container). The heavy FFmpeg/CPU work runs in its own process/container, isolated from API request handling — the API never blocks on processing. Independently scalable (run N worker replicas). Code/entities/config reused from the same codebase and image (no duplication). The worker image installs the FFmpeg binary; the API image does not need it.
- **Cons:** A second bootstrap entrypoint and Compose service to maintain. Shared modules must be factored so the worker imports only what it needs.

### Option B: In-process `@Processor` inside the API
- The BullMQ worker runs inside the API process (same container) via a `@Processor` registered in a module imported by `AppModule`.
- **Pros:** Simplest — one process, no extra entrypoint or container.
- **Cons:** FFmpeg CPU load runs in the API process, degrading request latency and risking event-loop starvation/OOM on large files. Contradicts the architecture's separate-worker container and the phase's "worker real subindo no Compose" as a distinct unit. Cannot scale workers independently of the API.

### Option C: Cron/poll worker (no broker)
- A standalone process polls the DB for `processing` videos on an interval.
- **Pros:** No broker needed.
- **Cons:** Polling latency and DB churn; reimplements retry/locking/backoff that BullMQ provides; contradicts TD-01. Rejected.

**Recommendation:** **Option A (dedicated worker container, shared image, separate Nest context)** — It honors the target architecture, isolates heavy FFmpeg work from the API, scales independently, and reuses the codebase via a second command on the same image. The minor cost is one extra entrypoint + Compose service.

**Decision:** A (dedicated `worker` Compose service running a headless Nest application context that consumes the BullMQ queue)

---

## TD-05: Metadata Extraction & Thumbnail Generation Tool

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration and metadata (codec, resolution, bitrate) and capture a single frame as a thumbnail. The architecture labels the worker tech as "FFmpeg". The decision is how the Node worker invokes FFmpeg/ffprobe.

**Options:**

### Option A: `fluent-ffmpeg` wrapping the system FFmpeg/ffprobe binaries
- `fluent-ffmpeg` offers `ffmpeg.ffprobe(input, cb)` for metadata and a `.screenshots()` / single-frame API for the thumbnail. The worker image `apt install ffmpeg`, providing both `ffmpeg` and `ffprobe` binaries on `PATH`.
- **Pros:** Clean, declarative API for both probe and thumbnail; widely used standard for FFmpeg-in-Node. Reads metadata as structured JSON; thumbnail in a few lines. System binary is the full, real FFmpeg (no feature gaps). `@types/fluent-ffmpeg` provides typings.
- **Cons:** `fluent-ffmpeg` itself is lightly maintained (stable but infrequent releases). Requires the FFmpeg binary present in the worker image.

### Option B: Direct `child_process.spawn` of `ffprobe`/`ffmpeg`
- The worker spawns `ffprobe -print_format json -show_format -show_streams ...` and `ffmpeg -ss T -i in -frames:v 1 out.jpg`, parsing stdout itself.
- **Pros:** No library dependency at all (aligns with the project's minimal-dependency ethos). Full control over flags; nothing to outlive maintenance-wise.
- **Cons:** More boilerplate: manual arg construction, stream buffering, exit-code/error handling, and JSON parsing for ffprobe. Easier to get subtly wrong (e.g., escaping, timeouts).

### Option C: Bundled binary via `@ffmpeg-installer/ffmpeg` + `fluent-ffmpeg`
- Ship a prebuilt FFmpeg binary as an npm package instead of apt.
- **Pros:** No apt step; binary pinned via npm.
- **Cons:** Prebuilt binaries can lag, omit codecs, or mismatch the container architecture; larger node_modules. The apt binary is the more reliable, complete FFmpeg for a Linux worker.

**Recommendation:** **Option A (`fluent-ffmpeg` + system FFmpeg via apt)** — The declarative ffprobe + thumbnail API keeps the worker pipeline small and readable, and the apt-installed binary is the full, reliable FFmpeg. `fluent-ffmpeg`'s light maintenance is acceptable since it is a thin, stable wrapper over a binary we control; `child_process` remains a drop-in fallback if needed.

**Decision:** A (`fluent-ffmpeg` over the system `ffmpeg`/`ffprobe` binaries installed in the worker image)

---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, URL-safe, unique public identifier (the slug used in stream/download/watch routes), distinct from the internal UUID primary key and guaranteed never to collide. Cited across the entity (unique column), the controller routes (`/videos/:urlId/...`), and the lookup path.

**Options:**

### Option A: Dependency-free base62 id from `node:crypto` + unique column + retry
- Generate an 11-char `[0-9A-Za-z]` id from `crypto.randomBytes`, store in a `url_id` column with a UNIQUE constraint; on the (astronomically rare) unique-violation, regenerate and retry.
- **Pros:** No new dependency (consistent with the project's minimal-dep ethos — e.g., nickname generation in Phase 02 used `node:crypto`, not a lib). 11 base62 chars ≈ 65 bits of entropy → collision-negligible; the UNIQUE constraint + retry makes it provably conflict-free. CommonJS-safe (no ESM interop issues). Short and opaque (no enumeration of sequential ids).
- **Cons:** A few lines of hand-written generation/retry code instead of a one-liner.

### Option B: `nanoid`
- Popular URL-safe id generator.
- **Pros:** Canonical, ergonomic, well-tested.
- **Cons:** `nanoid@5` (current) is **ESM-only**, which breaks the project's CommonJS + ts-jest setup (import-interop failures in Jest); pinning the legacy `nanoid@3` to stay CJS adds a dependency solely to dodge ESM. Net: a dependency that fights the toolchain for what `node:crypto` already does.

### Option C: Expose the UUID primary key as the URL
- Use the existing `id` UUID in URLs.
- **Pros:** Zero new code/column.
- **Cons:** 36-char UUIDs are long and ugly in URLs; the requirement explicitly asks for a *short, unique* URL distinct from internal identifiers. Leaks the internal PK.

**Recommendation:** **Option A (crypto base62 + unique column + retry)** — Matches the project's no-extra-dependency precedent, is CommonJS-safe (avoids the `nanoid` ESM trap), and the UNIQUE-constraint-plus-retry pattern makes conflicts impossible while keeping URLs short.

**Decision:** A (11-char base62 id from `node:crypto`, stored in a UNIQUE `url_id` column, regenerate-on-violation)

---

## TD-07: Streaming & Download Delivery Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must stream (start before the full file is fetched, i.e., HTTP Range / `206 Partial Content`) and a download must be available. The architecture diagram draws the frontend streaming **directly from Object Storage** (`Rel(frontend, storage, "Streams", "HTTPS")`), not through the API. We must decide how bytes reach the client for reads.

**Options:**

### Option A: Presigned GET URL, client reads directly from storage (redirect)
- `GET /videos/:urlId/stream` and `GET /videos/:urlId/download` resolve the video (must be `ready`), generate a short-lived presigned `GetObject` URL, and respond `302` with the URL in `Location`. The client (or `<video>` element) then issues Range requests **directly to storage**, which natively serves `206 Partial Content`. The download URL adds `ResponseContentDisposition=attachment; filename=...`.
- **Pros:** Matches the target architecture exactly (frontend streams from storage directly). MinIO/S3 natively honor `Range` → real `206` streaming with zero proxy code. No video bytes flow through the API on reads either — it stays a thin control plane. Download vs. stream differ only by the presigned `Content-Disposition`. Short-lived URLs keep access controlled.
- **Cons:** Presigned URL host must be reachable by the client (in-container tests resolve `minio:9000`; a browser deployment configures a public storage endpoint). Two hops (redirect then fetch).

### Option B: API proxies Range requests to storage
- The API endpoint reads the client's `Range` header, fetches that byte range from storage, and pipes back `206` with `Content-Range`/`Accept-Ranges`.
- **Pros:** Single same-origin URL; no presigned-host concern; fully exercised by supertest within the API.
- **Cons:** Read bytes flow through the API (pipe, not buffer — but still consumes API bandwidth/sockets per viewer). Contradicts the architecture's direct-from-storage streaming. Reimplements Range handling that storage already does.

### Option C: Public bucket + direct public URLs
- Make the bucket public and hand out plain object URLs.
- **Pros:** Simplest; CDN-friendly.
- **Cons:** No access control — every object world-readable, including unlisted/draft videos. Unacceptable for a platform with visibility rules (future phases) and draft videos. Rejected.

**Recommendation:** **Option A (presigned GET redirect; storage serves Range/206)** — It is the only option that both matches the architecture (direct-from-storage streaming) and keeps read bytes off the API, while getting real `206 Partial Content` for free from MinIO/S3. End-to-end tests assert the `302` + presigned `Location`, then issue a `Range` request to that URL and assert `206` from MinIO — real streaming over real infra.

**Decision:** A (presigned `GetObject` URL via `302` redirect for both stream and download; storage serves Range/`206`; download sets `Content-Disposition: attachment`)

---

## TD-08: Video Status Lifecycle & Processing-Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload"

**Context:** A video moves through states as it is uploaded and processed, and the phase requires the lifecycle to be reflected in the database, including what happens on processing failure. This contract is cited by the entity (status column), the upload flow (TD-03), the worker (TD-04/05), and delivery (TD-07, which only serves `ready` videos).

**Options:**

### Option A: Single `status` enum `draft → processing → ready → error` + BullMQ retries
- PostgreSQL enum column. `draft` at initiate (TD-03 step 1), `processing` after `complete` enqueues the job, `ready` when the worker finishes (metadata + thumbnail persisted), `error` when the worker exhausts BullMQ retries (`attempts` with exponential `backoff`). A nullable `error_reason` records the failure cause. Streaming/download require `ready`.
- **Pros:** One column, one source of truth; maps 1:1 to the phase's stated lifecycle ("rascunho → processando → pronto/erro"). BullMQ `attempts`/`backoff` gives automatic retry; only after final failure does the row become `error` (with reason) — transient glitches self-heal, permanent failures are visible and queryable. Simple to test and reason about.
- **Cons:** A coarse single status doesn't separately model "uploading vs upload-complete" — acceptable, since draft already covers the pre-processing window.

### Option B: Boolean flags (`is_processed`, `has_error`, ...)
- Multiple booleans instead of an enum.
- **Pros:** No enum type/migration.
- **Cons:** Representable invalid combinations (processed + error?); no single ordered lifecycle; harder to query and to extend (publish states in Phase 04). Rejected.

### Option C: Separate `video_processing_jobs` status table
- Track processing state in its own table linked to the video.
- **Pros:** Full processing-attempt history/audit.
- **Cons:** Over-engineered for this phase — BullMQ already retains job/attempt history; a join table duplicates queue state and complicates the simple "is this video ready?" read. Rejected for now.

**Recommendation:** **Option A (single status enum + BullMQ retry, `error` terminal state with reason)** — It directly models the required lifecycle in one column, leans on BullMQ's retry/backoff for resilience, and records a terminal `error` state with a reason for permanent failures. Booleans and a job table are respectively too weak and too heavy.

**Decision:** A (`status` enum `draft|processing|ready|error`; worker retries via BullMQ `attempts`+`backoff`; on final failure set `status=error` + `error_reason`; only `ready` videos are streamable/downloadable)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A (BullMQ + Redis via `@nestjs/bullmq`) |
| TD-02 | Backend | Object Storage Access (SDK + bucket/key) | AWS SDK v3 | A (`@aws-sdk/client-s3` + `s3-request-presigner`, single bucket + prefixes) |
| TD-03 | Backend | Large-File (10GB) Upload Strategy | Presigned multipart, direct to storage | A (presigned multipart upload) |
| TD-04 | Backend | Worker Deployment Model | Dedicated worker container (shared image) | A (separate Nest app-context worker service) |
| TD-05 | Backend | Metadata & Thumbnail Tool | `fluent-ffmpeg` + system FFmpeg | A (`fluent-ffmpeg` over apt FFmpeg/ffprobe) |
| TD-06 | Backend | Unique Video URL Identifier | crypto base62 + unique column + retry | A (11-char base62 `url_id`, dependency-free) |
| TD-07 | Backend | Streaming & Download Delivery | Presigned GET redirect (storage Range/206) | A (`302` to presigned URL; storage serves `206`) |
| TD-08 | Backend | Status Lifecycle & Failure Handling | Status enum + BullMQ retry, `error` terminal | A (`draft|processing|ready|error` + `error_reason`) |
