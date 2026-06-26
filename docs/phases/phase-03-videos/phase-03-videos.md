---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-26T18:41:02-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T19:22:11-03:00"
  docs/phases/phase-03-videos/context.md: "2026-06-26T19:19:15-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-26T19:21:55-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-06-26T18:46:06-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver large-file (up to 10GB) video upload without holding the API, backed by object storage (MinIO/S3), a background processing queue (BullMQ/Redis), and a dedicated FFmpeg worker that extracts duration/metadata and generates a thumbnail. Each video gets a unique URL and is served via streaming (HTTP Range / 206) and download, with a status lifecycle (`draft → processing → ready → error`) reflected in the database. This establishes the video persistence and processing foundation for Phases 04–07.

All decisions referenced as `phase-03-videos/TD-NN` live in `docs/decisions/technical-decisions-phase-03-videos.md`; inherited decisions as `phase-0X-.../TD-NN`.

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose Infrastructure (MinIO, Redis, Worker, FFmpeg)

**Description:** Install Phase 03 dependencies; add `storage`, `queue`, and `video` config namespaces (`registerAs` pattern from Phase 01); extend the Joi env schema; add MinIO, Redis, and the video `worker` services to Docker Compose; and install FFmpeg in the shared image. This is the infrastructure foundation the rest of the phase builds on (per `phase-03-videos/TD-01`, `TD-02`, `TD-04`, `TD-05`).

**Technical actions:**

- Install production deps in `nestjs-project`: `bullmq@^5.x`, `@nestjs/bullmq@^11.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `fluent-ffmpeg@^2.1.x`. Install dev dep `@types/fluent-ffmpeg@^2.1.x`. (Exact pins in `library-refs.md`.)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, default `'http://minio:9000'`), `STORAGE_REGION` (string, default `'us-east-1'`), `STORAGE_ACCESS_KEY` (string, required), `STORAGE_SECRET_KEY` (string, required), `STORAGE_BUCKET` (string, default `'streamtube-videos'`), `STORAGE_FORCE_PATH_STYLE` (boolean, default `true`).
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`).
- Create `src/config/video.config.ts` — `registerAs('video', ...)` reading `VIDEO_MAX_UPLOAD_BYTES` (number, default `10737418240` = 10 GB), `VIDEO_PART_SIZE_BYTES` (number, default `104857600` = 100 MB), `VIDEO_PRESIGN_EXPIRY_SECONDS` (number, default `3600`). (Bounds per `phase-03-videos/TD-03` Revisions.)
- Update `src/config/env.validation.ts` — add all new vars to the Joi schema (`STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` required; others with defaults).
- Update `.env.example` with all new vars and Compose-compatible defaults (`STORAGE_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis`, credentials, bucket).
- Update `nestjs-project/Dockerfile.dev` — `apt install -y ffmpeg` (shared image; both API and worker run from it per `phase-03-videos/TD-04`/`TD-05`).
- Add to `nestjs-project/compose.yaml`:
  - `minio` (image `minio/minio`, `command: server /data --console-address ":9001"`, env `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, ports 9000/9001, healthcheck on `/minio/health/ready`, named volume `minio-data`).
  - `redis` (image `redis:7`, healthcheck `redis-cli ping`).
  - `worker` (same `build` as `nestjs-api`, `command` running the worker bootstrap `npm run start:worker`, `depends_on` db+redis+minio healthy, same `.env`, same volume mount).
  - `nestjs-api` gains `depends_on` redis (healthy) + minio (healthy).
- Add npm scripts: `"start:worker": "ts-node --compiler-options '{\"module\":\"CommonJS\"}' -r tsconfig-paths/register src/main.worker.ts"` (mirrors the existing `seed` script's ts-node invocation).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| _(none — infrastructure/config; exercised by the app boot and downstream SIs)_ | | Existing suite (`GET /` 200) still green; app boots with new config namespaces |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `db`, `mailpit`, `minio`, `redis`, `nestjs-api`, and `worker`, all reaching a healthy/running state.
- The app boots with the new config namespaces; starting without `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` fails at bootstrap with a Joi validation error.
- `docker compose exec nestjs-api ffmpeg -version` and `ffprobe -version` succeed (binaries present in the image).
- MinIO console reachable; Redis answers `PING`; existing E2E (`GET /` → 200) still passes.

---

### SI-03.2 — Video Entity and Migration

**Description:** Create the `Video` entity (`videos` table) linked many-to-one to `Channel`, with the status enum, storage keys, unique URL id, and metadata columns. Generate the migration. (Data Model per Technical Specifications; status enum per `phase-03-videos/TD-08`; URL id per `TD-06`.)

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns: `id` (uuid PK), `url_id` (varchar(16), unique — the public URL id), `channel_id` (uuid FK → channels), `title` (varchar(200)), `status` (enum `video_status` = `draft|processing|ready|error`, default `draft`), `original_filename` (varchar, nullable), `content_type` (varchar, nullable), `size_bytes` (bigint, nullable), `storage_key` (varchar — key of the original object), `upload_id` (varchar, nullable — S3 multipart uploadId, cleared after complete), `thumbnail_key` (varchar, nullable), `duration_seconds` (int, nullable), `metadata` (jsonb, nullable — `{ codec, width, height, bitRate }`), `error_reason` (text, nullable), `created_at` (`@CreateDateColumn`), `updated_at` (`@UpdateDateColumn`). Define `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`. Add `@Index` on `url_id` (unique) and `channel_id`.
- Generate migration: `npm run migration:generate -- src/database/migrations/CreateVideos`; review SQL for the enum type, columns, unique `url_id`, FK, and indexes.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `url_id` constraint; `status` enum values + default `draft`; FK to channel; `metadata` jsonb round-trips; `size_bytes` bigint; nullable columns |
| `src/database/migrations.integration-spec.ts` (extend) | Integration | `runMigrations` now applies the `CreateVideos` migration and `videos` table + `video_status` enum exist; `undoLastMigration` removes them |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the `video_status` enum, the unique `url_id` index, the `channel_id` FK, and `channel_id` index.
- Inserting two videos with the same `url_id` fails with a unique constraint violation.
- A newly inserted video defaults to `status = 'draft'`.
- A video row references an existing channel; deleting paths respect the FK.

---

### SI-03.3 — Video Domain Exceptions

**Description:** Add the Phase 03 domain exceptions (extending the existing `DomainException`), rendered by the existing `DomainExceptionFilter` as `{ statusCode, error, message }` (inherited `phase-02-auth/TD-07`). (Error Catalog per Technical Specifications.)

**Technical actions:**

- In `src/common/exceptions/domain.exception.ts`, add subclasses: `VideoNotFoundException` (404, `VIDEO_NOT_FOUND`), `VideoAccessDeniedException` (403, `VIDEO_ACCESS_DENIED`), `VideoNotReadyException` (409, `VIDEO_NOT_READY`), `InvalidVideoStateException` (409, `INVALID_VIDEO_STATE`), `UploadTooLargeException` (413, `UPLOAD_TOO_LARGE`).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/common/filters/domain-exception.filter.spec.ts` (extend) | Unit | Each new exception maps to the correct `{ statusCode, error, message }` shape |

**Dependencies:** None (can run alongside SI-03.2)

**Acceptance criteria:**

- A service throwing `VideoNotFoundException` yields `{ statusCode: 404, error: 'VIDEO_NOT_FOUND', message: ... }`.
- `UploadTooLargeException` yields `413 UPLOAD_TOO_LARGE`; `VideoNotReadyException` yields `409 VIDEO_NOT_READY`.

---

### SI-03.4 — Storage Module and Service (S3/MinIO)

**Description:** Create `StorageModule`/`StorageService` wrapping the AWS SDK v3 `S3Client` configured for MinIO (path-style, custom endpoint), exposing multipart upload, presigned URL generation, object put/get, and idempotent bucket bootstrap. (Per `phase-03-videos/TD-02`, `TD-03`, `TD-07`.)

**Technical actions:**

- Create `src/storage/storage.service.ts` — `StorageService` constructing an `S3Client` from `storageConfig` (`endpoint`, `forcePathStyle`, `region`, `credentials`). Implement `onModuleInit()` → `ensureBucket()` (`HeadBucketCommand`; on NotFound `CreateBucketCommand`). Methods:
  - `createMultipartUpload(key, contentType): Promise<string>` (returns `uploadId`).
  - `getPresignedUploadPartUrl(key, uploadId, partNumber): Promise<string>` (presign `UploadPartCommand`, expiry from `videoConfig`).
  - `completeMultipartUpload(key, uploadId, parts): Promise<void>`.
  - `abortMultipartUpload(key, uploadId): Promise<void>`.
  - `getPresignedGetUrl(key, opts?: { downloadFilename?: string }): Promise<string>` (presign `GetObjectCommand`; set `ResponseContentDisposition` when `downloadFilename` given).
  - `putObject(key, body, contentType): Promise<void>` (thumbnail upload).
  - `getObjectToFile(key, destPath): Promise<void>` (stream `GetObjectCommand` body to disk for the worker).
  - `buildOriginalKey(videoId, ext)` / `buildThumbnailKey(videoId)` helpers.
- Create `src/storage/storage.module.ts` — provides + exports `StorageService`; imports `ConfigModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO (Compose): `ensureBucket` is idempotent; full multipart round-trip (`createMultipartUpload` → presigned `UploadPartCommand` PUT via `fetch` → `completeMultipartUpload`) stores an object; presigned GET serves the object and honors a `Range` request with `206`; `putObject` + `getObjectToFile` round-trip; download presign carries `Content-Disposition: attachment` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- On startup the `streamtube-videos` bucket exists (created if absent), and re-running `ensureBucket` is a no-op.
- A small object uploaded through the presigned multipart flow (single last part) is retrievable; a `Range: bytes=0-N` request to the presigned GET URL returns `206 Partial Content` with `Content-Range`.
- The download presigned URL includes `response-content-disposition=attachment`.
- `getObjectToFile` writes the original bytes to a local path (used by the worker).

---

### SI-03.5 — Unique URL Id Generator

**Description:** Implement the dependency-free unique URL id generator (`phase-03-videos/TD-06`): 11-char base62 from `node:crypto`, with collision resolved by the unique column + regenerate-on-retry in the service.

**Technical actions:**

- Create `src/videos/url-id.util.ts` — export `generateUrlId(): string` producing an 11-char `[0-9A-Za-z]` id from `crypto.randomBytes` (rejection-free mapping via `randomBytes` → base62 over the alphabet).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/url-id.util.spec.ts` | Unit | Output length is 11; charset is `[0-9A-Za-z]` only; high-volume generation (10k) yields no duplicates (collision-negligible); successive calls differ |

**Dependencies:** None

**Acceptance criteria:**

- `generateUrlId()` returns an 11-character URL-safe base62 string.
- Across 10,000 generations there are no collisions.

---

### SI-03.6 — Upload Flow: Initiate, Presigned Parts, Complete (+ Queue Producer)

**Description:** Implement the videos module, service, and controller for the three-step presigned multipart upload: initiate (pre-register `draft` + create multipart upload), request presigned part URLs, and complete (finish multipart, flip to `processing`, enqueue the processing job). Wire the BullMQ producer. (Per `phase-03-videos/TD-03`, `TD-01`, `TD-08`; ownership via the user's channel.)

**Technical actions:**

- Add `findByUserId(userId: string): Promise<Channel | null>` to `src/channels/channels.service.ts` (resolve the authenticated user's channel for ownership).
- Create DTOs in `src/videos/dto/`:
  - `initiate-upload.dto.ts` — `InitiateUploadDto`: `@IsString() @MaxLength(200) title`; `@IsString() @MaxLength(255) filename`; `@IsString() contentType`; `@IsInt() @IsPositive() sizeBytes`.
  - `presign-parts.dto.ts` — `PresignPartsDto`: `@IsInt() @Min(1) totalParts` (or an array of part numbers).
  - `complete-upload.dto.ts` — `CompleteUploadDto`: `@IsArray() parts: { partNumber: number; eTag: string }[]` (validated nested with `@ValidateNested`/`@Type`).
- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>`, `ChannelsService`, `StorageService`, `@InjectQueue('video-processing') Queue`, and `videoConfig`. Methods:
  - `initiateUpload(userId, dto)`: resolve channel; if `dto.sizeBytes > videoConfig.maxUploadBytes` throw `UploadTooLargeException`; generate `url_id` (retry on unique violation); build `storage_key`; `storage.createMultipartUpload`; persist `Video` (`status='draft'`, `upload_id`, `size_bytes`, `content_type`, `original_filename`, `title`); return `{ id, urlId, uploadId: storageKey-bound, key, partSize, totalPartsHint }`.
  - `presignParts(userId, videoId, dto)`: load video + assert owner (`VideoAccessDeniedException`) + assert `status='draft'` (`InvalidVideoStateException`); return presigned URLs `[{ partNumber, url }]` for the requested parts.
  - `completeUpload(userId, videoId, dto)`: load + owner + `status='draft'`; `storage.completeMultipartUpload`; set `status='processing'`, clear `upload_id`; `queue.add('process', { videoId }, { attempts, backoff })`; return the updated video.
  - `findOwnedDraft(...)` helper for the owner/state guard.
- Create `src/videos/videos.controller.ts` — `@ApiTags('videos') @Controller('videos')`:
  - `@Post()` initiate (auth; `@CurrentUser()`), 201 `{ id, urlId, uploadId, key, partSize }`.
  - `@Post(':id/parts')` presign parts (auth+owner), 200 `[{ partNumber, url }]`.
  - `@Post(':id/complete')` complete (auth+owner), 200 video summary.
- Create `src/videos/videos.module.ts` — imports `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `BullModule.registerQueue({ name: 'video-processing' })`; providers `VideosService`; controllers `VideosController`; export `VideosService` + `TypeOrmModule`.
- Wire `BullModule.forRootAsync` (connection from `queueConfig`) in `AppModule` (or a small `QueueModule`); register `VideosModule` in `AppModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | initiate rejects oversize (`UploadTooLargeException`); generates url id; persists draft; presign/complete enforce owner + draft state; complete enqueues a job (mocked queue) |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + MinIO: initiate persists a `draft` row + creates a multipart upload; presign returns working URLs; complete (with a real small part PUT) flips to `processing` and the row reflects it |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` 401 without token, 201 with token (draft created); 413 on oversize; `POST /videos/:id/parts` returns presigned URLs (owner only → 403 for non-owner); real `fetch` PUT of a small part then `POST /videos/:id/complete` → 200 + `status='processing'`; a job is enqueued to Redis |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos` (authenticated) pre-registers a `draft` video tied to the caller's channel and returns its `id`, unique `urlId`, the storage key, and the part size; without a token → 401.
- `POST /videos` with `sizeBytes` > 10 GB → 413 `UPLOAD_TOO_LARGE`; no video row created.
- `POST /videos/:id/parts` returns presigned `UploadPart` URLs; a non-owner → 403 `VIDEO_ACCESS_DENIED`.
- Uploading a part directly to the presigned URL stores bytes in MinIO without passing through the API; `POST /videos/:id/complete` finalizes the object, sets `status='processing'`, and enqueues a `video-processing` job.
- Completing a non-`draft` video → 409 `INVALID_VIDEO_STATE`.

---

### SI-03.7 — Streaming, Download, and Video Lookup Endpoints

**Description:** Implement the public read endpoints: stream and download (302 redirect to a short-lived presigned GET URL; storage serves Range/206 and attachment respectively), plus a metadata lookup by `url_id`. Only `ready` videos are streamable/downloadable. (Per `phase-03-videos/TD-07`, `TD-08`.)

**Technical actions:**

- Add to `VideosService`:
  - `findByUrlId(urlId): Promise<Video>` (throw `VideoNotFoundException` if absent).
  - `getStreamUrl(urlId)`: load; if `status !== 'ready'` throw `VideoNotReadyException`; return `storage.getPresignedGetUrl(storage_key)`.
  - `getDownloadUrl(urlId)`: same guard; return `storage.getPresignedGetUrl(storage_key, { downloadFilename: original_filename ?? '${urlId}.mp4' })`.
  - `getPublicView(urlId)`: return `{ urlId, title, status, durationSeconds, metadata, thumbnailUrl }` (thumbnail presigned GET when `thumbnail_key` set).
- Add to `VideosController` (all `@Public()`):
  - `@Get(':urlId')` metadata view, 200.
  - `@Get(':urlId/stream')` → `@Redirect()`/302 to presigned stream URL.
  - `@Get(':urlId/download')` → 302 to presigned download URL.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` (extend) | Unit | stream/download throw `VideoNotReadyException` unless `ready`; `findByUrlId` throws `VideoNotFoundException`; download URL carries the filename |
| `src/videos/videos.service.integration-spec.ts` (extend) | Integration | Against MinIO: a `ready` video with a stored object yields a presigned URL that returns `206` on a `Range` request; download URL → `Content-Disposition: attachment` |
| `test/videos.e2e-spec.ts` (extend) | E2E | Seed a `ready` video + put a real small object; `GET /videos/:urlId/stream` → 302 with presigned `Location`; `fetch(Location, { Range })` → 206; `GET /videos/:urlId/download` → 302 (attachment); stream of a non-`ready` video → 409; unknown `urlId` → 404; `GET /videos/:urlId` returns status/metadata |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `GET /videos/:urlId/stream` on a `ready` video returns `302` with a presigned `Location`; fetching that URL with a `Range` header returns `206 Partial Content` (streaming without full download), served by storage.
- `GET /videos/:urlId/download` returns `302` to a presigned URL whose response forces `Content-Disposition: attachment`.
- Stream/download of a non-`ready` (e.g., `processing`) video → 409 `VIDEO_NOT_READY`; unknown `urlId` → 404 `VIDEO_NOT_FOUND`.
- `GET /videos/:urlId` returns the video's public metadata including `status` and (when ready) `durationSeconds` and a thumbnail URL.

---

### SI-03.8 — Video Worker: FFmpeg Processing (Metadata, Thumbnail, Status)

**Description:** Implement the dedicated worker (`phase-03-videos/TD-04`): a headless Nest application context consuming the `video-processing` queue, whose processor downloads the original from storage, extracts duration/metadata via ffprobe, generates a thumbnail frame, uploads it, and transitions the video to `ready` — or to `error` (with reason) after BullMQ exhausts retries (`phase-03-videos/TD-05`, `TD-08`). (Events/Messages per Technical Specifications.)

**Technical actions:**

- Create `src/videos/processing/video-processing.service.ts` — `VideoProcessingService` injecting `Repository<Video>` and `StorageService`. `process(videoId)`: load video; download original via `storage.getObjectToFile` to a temp dir; `ffmpeg.ffprobe` → `duration_seconds` + `metadata` (`codec`, `width`, `height`, `bitRate`); generate one thumbnail frame via `fluent-ffmpeg` `.screenshots({ timestamps:['50%'], size, folder, filename })`; `storage.putObject(thumbnailKey, ...)`; update video (`status='ready'`, `duration_seconds`, `metadata`, `thumbnail_key`); clean temp files. Idempotent on `videoId` (safe to re-run).
- Create `src/videos/processing/video.processor.ts` — `@Processor('video-processing')` `VideoProcessor extends WorkerHost`; `process(job)` delegates to `VideoProcessingService.process(job.data.videoId)`; `@OnWorkerEvent('failed')` → when `job.attemptsMade >= job.opts.attempts`, set `status='error'` + `error_reason` (final-failure handling).
- Create `src/videos/worker.module.ts` — `WorkerModule` importing `ConfigModule.forRoot` (global, validation schema), `TypeOrmModule.forRootAsync` (same factory as `AppModule`, `autoLoadEntities`), `TypeOrmModule.forFeature([Video])`, `StorageModule`, `BullModule.forRootAsync` (connection) + `BullModule.registerQueue({ name: 'video-processing' })`; providers `VideoProcessingService`, `VideoProcessor`.
- Create `src/main.worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` (no HTTP); enable shutdown hooks; log readiness; keep the process alive (the BullMQ worker holds it open).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video-processing.service.spec.ts` | Unit | `process` orchestrates download → ffprobe → thumbnail → put → status update (collaborators mocked); failure surfaces (throws) so BullMQ retries |
| `src/videos/processing/video-processing.service.integration-spec.ts` | Integration | Real MinIO + DB: generate a ~2s sample video via FFmpeg (`testsrc`), upload it, run `process`; assert `status='ready'`, `duration_seconds≈2`, `metadata` populated, and the thumbnail object exists in storage |
| `src/videos/worker.module.spec.ts` | Unit | `WorkerModule` compiles with the processor, queue, storage, and DB wiring |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**

- A `video-processing` job for an uploaded video causes the worker to set `status='ready'`, populate `duration_seconds` and `metadata`, and store a thumbnail object at `thumbnails/{videoId}.jpg`.
- ffprobe duration matches the source (±1s for the sample); the thumbnail is a valid JPEG frame.
- A processing failure (e.g., unreadable object) is retried per BullMQ `attempts`/`backoff`; after the final attempt the video is set to `status='error'` with a non-null `error_reason`.
- The worker runs as a separate container/process with no HTTP server.

---

### SI-03.9 — App Integration, CLAUDE.md Videos Section, and Definition of Done

**Description:** Register the videos/queue wiring in `AppModule`, update the backend `CLAUDE.md` with the videos section (module, endpoints, queue/worker, storage), and close the Definition of Done (full suite green, `tsc --noEmit` clean, lint clean).

**Technical actions:**

- Ensure `AppModule` imports `VideosModule` and the BullMQ root connection; confirm `StorageService` bucket bootstrap runs for the API too.
- Update `nestjs-project/CLAUDE.md` — add a "Videos (Phase 03)" section: the `videos` module and endpoints, the `storage` service (MinIO/S3, buckets/keys, presigned upload/stream/download), the `video-processing` queue (BullMQ/Redis) and the worker (`start:worker`, FFmpeg), the new Compose services, env vars, and the status lifecycle. Document the in-container presigned-URL host caveat (`minio:9000`) and the production public-endpoint swap.
- Run the full DoD: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` (exit 0), `npm run lint`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| _(full suite)_ | All | Entire unit+integration+e2e suite green; tsc 0; lint clean |

**Dependencies:** SI-03.7, SI-03.8

**Acceptance criteria:**

- `docker compose exec nestjs-api npm test -- --runInBand` and `npm run test:e2e` are fully green.
- `npx tsc --noEmit` exits 0; `npm run lint` passes.
- `nestjs-project/CLAUDE.md` documents the videos module, endpoints, queue/worker, and storage consistently with the implemented code (no references to nonexistent files/behaviors).

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| url_id | varchar(16) | unique, not null | Public URL id (11-char base62, `TD-06`) |
| channel_id | uuid | FK → channels.id, not null | Owning channel (`TD` inherited: user 1:1 channel) |
| title | varchar(200) | not null | Provided at initiate |
| status | enum `video_status` | not null, default `draft` | `draft \| processing \| ready \| error` (`TD-08`) |
| original_filename | varchar(255) | nullable | For download filename |
| content_type | varchar | nullable | MIME of the original |
| size_bytes | bigint | nullable | Declared at initiate; ≤ 10 GB (`TD-03`) |
| storage_key | varchar | not null | `videos/{id}/original{ext}` |
| upload_id | varchar | nullable | S3 multipart uploadId; cleared after complete |
| thumbnail_key | varchar | nullable | `thumbnails/{id}.jpg`; set by worker |
| duration_seconds | int | nullable | Set by worker (ffprobe) |
| metadata | jsonb | nullable | `{ codec, width, height, bitRate }` (worker) |
| error_reason | text | nullable | Set on terminal processing failure |
| created_at | timestamp | not null, auto | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, `channel_id`)
**Indexes:** `(url_id)` — unique, `(channel_id)`

---

### API Contracts

#### POST /videos (SI-03.6) — initiate upload

**Auth:** Bearer access token (owner = caller's channel).
**Request body:** `title` (string, ≤200), `filename` (string, ≤255), `contentType` (string), `sizeBytes` (int > 0, ≤ `10737418240`).
**Response 201:** `{ id: uuid, urlId: string, uploadId: string, key: string, partSize: number }`.
**Errors:** 401 (no/invalid token); 413 `UPLOAD_TOO_LARGE` (`sizeBytes` > 10 GB); 400 validation.

#### POST /videos/:id/parts (SI-03.6) — presign part URLs

**Auth:** Bearer; must own the video; video must be `draft`.
**Request body:** `totalParts` (int ≥1) — presign URLs for parts `1..totalParts`.
**Response 200:** `[{ partNumber: number, url: string }]`.
**Errors:** 401; 403 `VIDEO_ACCESS_DENIED`; 404 `VIDEO_NOT_FOUND`; 409 `INVALID_VIDEO_STATE`.

#### POST /videos/:id/complete (SI-03.6) — complete upload + enqueue

**Auth:** Bearer; owner; video `draft`.
**Request body:** `parts: [{ partNumber: int, eTag: string }]` (ordered).
**Response 200:** `{ id, urlId, status: 'processing' }`.
**Errors:** 401; 403 `VIDEO_ACCESS_DENIED`; 404 `VIDEO_NOT_FOUND`; 409 `INVALID_VIDEO_STATE`.

#### GET /videos/:urlId (SI-03.7) — public metadata

**Auth:** Public.
**Response 200:** `{ urlId, title, status, durationSeconds: number|null, metadata: object|null, thumbnailUrl: string|null }`.
**Errors:** 404 `VIDEO_NOT_FOUND`.

#### GET /videos/:urlId/stream (SI-03.7) — streaming

**Auth:** Public; video must be `ready`.
**Response 302:** `Location` = presigned GET URL (storage serves `Range`/`206`).
**Errors:** 404 `VIDEO_NOT_FOUND`; 409 `VIDEO_NOT_READY`.

#### GET /videos/:urlId/download (SI-03.7) — download

**Auth:** Public; video must be `ready`.
**Response 302:** `Location` = presigned GET URL with `response-content-disposition=attachment; filename=...`.
**Errors:** 404 `VIDEO_NOT_FOUND`; 409 `VIDEO_NOT_READY`.

> The presigned URL host is the storage endpoint (`minio:9000` inside the Docker network — reachable by in-container tests and the worker). In production, `STORAGE_ENDPOINT` (or a dedicated public endpoint) points at the public storage/CDN host.

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner-only | Notes |
|----------|--------|---------------|-----------|-------|
| POST /videos | | ✓ | n/a | Video tied to caller's channel |
| POST /videos/:id/parts | | ✓ | ✓ | Owner + `draft` |
| POST /videos/:id/complete | | ✓ | ✓ | Owner + `draft`; enqueues job |
| GET /videos/:urlId | ✓ | | | Public metadata/status |
| GET /videos/:urlId/stream | ✓ | | | `ready` only |
| GET /videos/:urlId/download | ✓ | | | `ready` only |

Ownership: the JWT `sub` resolves to the user's channel (1:1); a video is owned when `video.channel_id === user's channel id`. Mismatch → `403 VIDEO_ACCESS_DENIED`.

---

### Error Catalog

**Error response format** (inherited `phase-02-auth/TD-07`): `{ statusCode, error, message }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Lookup by id/url_id with no match |
| VIDEO_ACCESS_DENIED | 403 | You do not own this video | Owner-only action by a non-owner |
| VIDEO_NOT_READY | 409 | Video is not ready | Stream/download before `status='ready'` |
| INVALID_VIDEO_STATE | 409 | Invalid video state for this operation | parts/complete on a non-`draft` video |
| UPLOAD_TOO_LARGE | 413 | Upload exceeds the maximum allowed size | initiate with `sizeBytes` > 10 GB |

---

### Events/Messages

#### video-processing.process

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` (per `phase-03-videos/TD-01`, `TD-03`) — enqueues to the `video-processing` BullMQ queue after `CompleteMultipartUpload`.
**Consumer:** `VideoProcessor` (`WorkerHost`) in the dedicated worker container (per `phase-03-videos/TD-04`).
**Trigger:** A multipart upload is completed and the video transitions `draft → processing`.
**Job options:** `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` (per `phase-03-videos/TD-08`).
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`); the consumer is idempotent on `videoId` — re-processing an already-`ready` video is safe. On final-attempt failure the consumer sets `status='error'` + `error_reason`.

---

## Dependency Map

```
SI-03.1 (deps, config, compose infra, ffmpeg) — no deps
├── SI-03.2 (Video entity + migration)
├── SI-03.4 (StorageModule/StorageService)
└── (SI-03.3 video exceptions — no deps; can run in parallel)

SI-03.5 (url-id util) — no deps

SI-03.2 + SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.6 (upload: initiate/parts/complete + queue producer)
    ├── SI-03.7 (streaming/download/lookup)
    └── SI-03.8 (worker: ffmpeg processing)   [also needs SI-03.4]

SI-03.7 + SI-03.8
└── SI-03.9 (app integration, CLAUDE.md, DoD)
```

Linearized order: SI-03.1 → SI-03.3, SI-03.5 (parallel) → SI-03.2, SI-03.4 (parallel) → SI-03.6 → SI-03.7, SI-03.8 (parallel) → SI-03.9.

## Deliverables

- [ ] Object storage (MinIO/S3) integration: bucket bootstrap, multipart upload, presigned URLs (`StorageService`)
- [ ] BullMQ/Redis processing queue + dedicated FFmpeg worker container (`start:worker`, separate Nest context)
- [ ] Upload of up to 10GB without passing bytes through the API (presigned multipart, direct client→storage)
- [ ] Pre-registration of the video as `draft` at upload initiation
- [ ] Automatic processing after upload: duration + metadata extraction (ffprobe)
- [ ] Automatic thumbnail generation from a video frame (fluent-ffmpeg)
- [ ] Unique per-video URL (`url_id`, base62, unique constraint)
- [ ] Streaming via presigned GET (storage serves Range / `206 Partial Content`)
- [ ] Download via presigned GET (`Content-Disposition: attachment`)
- [ ] Status lifecycle `draft → processing → ready → error` reflected in the DB; terminal `error` + reason on failure
- [ ] `Video` entity + migration (`videos` table, `video_status` enum, FK to channel)
- [ ] Domain exceptions for videos rendered by the existing exception filter
- [ ] MinIO, Redis, and worker services in `docker compose` alongside the backend
- [ ] `nestjs-project/CLAUDE.md` updated with the videos/queue/worker/storage section
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type check passes (`npx tsc --noEmit` exits 0)
- [ ] Lint passes (`npm run lint`)
