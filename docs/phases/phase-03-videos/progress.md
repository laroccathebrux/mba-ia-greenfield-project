# phase-03-videos — Progress

**Status:** in progress
**SIs:** 4/9 completed

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose Infrastructure
- **Status:** completed
- **Tests:** no tests (infrastructure/config) — baseline suite remains green; infra verified up
- **Observations:** Installed bullmq@5.79.1, @nestjs/bullmq@11.0.4, @aws-sdk/client-s3@3.1075.0, @aws-sdk/s3-request-presigner@3.1075.0, fluent-ffmpeg@2.1.3 (+ @types dev). Added storage/queue/video config namespaces + Joi vars + .env(.example). FFmpeg 5.1.9 installed in the shared image (Dockerfile.dev). Compose: added minio (healthy), redis (healthy), and worker services; api/worker depend on them. `start:worker` npm script (ts-node) added. Local git-ignored compose.override.yaml clears host port publishes (5432/3000/8025/6379/9000/9001) to avoid clashes with other containers on this machine — committed compose.yaml keeps standard published ports. Fixed MAIL_FROM quoting in .env.example.

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** 6/6 passing (video.entity.integration-spec.ts) + migrations.integration-spec.ts extended (2/2)
- **Observations:** `videos` table + `videos_status_enum`; unique `url_id`, FK to channel, `channel_id` index. bigint `size_bytes` via number transformer; `metadata` jsonb. Dropped the redundant double unique index on `url_id` (kept the UNIQUE constraint). Migration `1782513228444-CreateVideos`. Hardened the migrations test to also `DROP TYPE IF EXISTS` the enum types in cleanup (DROP TABLE leaves the enum behind → CREATE TYPE collision) — fixes a latent fragility. Updated `cleanAllTables` to delete `videos` first (FK order).

### SI-03.3 — Video Domain Exceptions
- **Status:** completed
- **Tests:** 11/11 passing (domain-exception.filter.spec.ts — 5 new video exceptions)
- **Observations:** VideoNotFound (404), VideoAccessDenied (403), VideoNotReady (409), InvalidVideoState (409), UploadTooLarge (413) extending DomainException; rendered by the existing filter.

### SI-03.4 — Storage Module and Service (S3/MinIO)
- **Status:** pending

### SI-03.5 — Unique URL Id Generator
- **Status:** completed
- **Tests:** 4/4 passing (url-id.util.spec.ts)
- **Observations:** `generateUrlId()` — 11-char base62 from `node:crypto`; 10k generations, zero collisions. No dependency (CommonJS-safe).

### SI-03.6 — Upload Flow: Initiate, Presigned Parts, Complete (+ Queue Producer)
- **Status:** pending

### SI-03.7 — Streaming, Download, and Video Lookup Endpoints
- **Status:** pending

### SI-03.8 — Video Worker: FFmpeg Processing
- **Status:** pending

### SI-03.9 — App Integration, CLAUDE.md Videos Section, and Definition of Done
- **Status:** pending
