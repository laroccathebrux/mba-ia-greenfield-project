---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-26T18:41:02-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T19:17:45-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-06-26T18:46:06-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-06-26T18:46:06-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-06-26T18:46:06-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, visibilidade pública/unlisted, fluxo de publicação, painel de gerenciamento, página do canal (Fase 04); player e página de visualização (Fase 05); interações sociais (Fase 06). A interface de vídeo (frontend) não faz parte desta fase.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo (tela de upload, player) fica diferida; o escopo desta fase é backend (API, worker, infraestrutura).

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto e Fase 02 — Cadastro, Login e Gerenciamento de Conta. Os vídeos pertencem a um canal (relação 1:1 usuário↔canal criada na Fase 02).

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | bullmq@^5.x, @nestjs/bullmq@^11.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Object Storage Access (SDK + bucket/key) | decided | A (AWS SDK v3, single bucket + prefixes) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Large-File (10GB) Upload Strategy | decided | A (presigned multipart, direct to storage) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Worker Deployment Model | decided | A (dedicated worker container, shared image) | @nestjs/bullmq@^11.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Metadata & Thumbnail Tool | decided | A (`fluent-ffmpeg` + system FFmpeg) | fluent-ffmpeg@^2.1.x, @types/fluent-ffmpeg@^2.1.x |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A (crypto base62 + unique column + retry) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Streaming & Download Delivery | decided | A (presigned GET redirect; storage Range/206) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Status Lifecycle & Failure Handling | decided | A (`draft|processing|ready|error` + retry) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — NestJS-canonical job queue with the richest out-of-the-box job semantics (retry/backoff, concurrency, failed-state handling) that the status lifecycle (TD-08) and worker (TD-04) depend on; Redis provides the distinct, real queue container the phase requires in Compose. Transactional-enqueue gap mitigated by enqueueing only after `processing` and an idempotent worker keyed on `videoId`.

**Libraries:** `bullmq@^5.x`, `@nestjs/bullmq@^11.x` (Redis runs as a Compose service; `ioredis` is transitive via `bullmq`)

### phase-03-videos/TD-02

**Recommendation:** Option A (AWS SDK v3) — Same code runs against MinIO (dev) and AWS S3 (prod) via `endpoint` + `forcePathStyle`; first-class presigning and multipart support required by TD-03 and TD-07. Single bucket `streamtube-videos` with `videos/{videoId}/original{ext}` and `thumbnails/{videoId}.jpg` keys; bucket created idempotently on startup.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Option A (presigned multipart, direct to storage) — Only option that keeps 10GB of bytes out of the API AND supports the full 10GB size with per-part retry; the initiate step naturally creates the `draft` pre-registration. Flow: initiate (`POST /videos`) → presigned part URLs (`POST /videos/:id/parts`) → complete (`POST /videos/:id/complete`, enqueues processing).

**Libraries:** — (uses TD-02 SDK)

### phase-03-videos/TD-04

**Recommendation:** Option A (dedicated worker container, shared image, separate Nest context) — Honors the target architecture (distinct worker container), isolates heavy FFmpeg work from the API, scales independently, reuses the codebase via a second command (`start:worker`) on the same image. The worker boots `NestFactory.createApplicationContext(WorkerModule)` — no HTTP server.

**Libraries:** `@nestjs/bullmq@^11.x`

### phase-03-videos/TD-05

**Recommendation:** Option A (`fluent-ffmpeg` + system FFmpeg via apt) — Declarative `ffprobe` (metadata/duration) + single-frame thumbnail API keeps the worker pipeline small; the apt-installed binary is the full, reliable FFmpeg. Light maintenance of the wrapper is acceptable; `child_process.spawn` remains a drop-in fallback.

**Libraries:** `fluent-ffmpeg@^2.1.x`, `@types/fluent-ffmpeg@^2.1.x` (dev)

### phase-03-videos/TD-06

**Recommendation:** Option A (crypto base62 + unique column + retry) — Matches the project's no-extra-dependency precedent (Phase 02 nickname used `node:crypto`), CommonJS-safe (avoids the `nanoid@5` ESM trap), and the UNIQUE-constraint-plus-retry pattern makes conflicts impossible while keeping URLs short. 11 base62 chars ≈ 65 bits of entropy.

**Libraries:** — (`node:crypto`, no dependency)

### phase-03-videos/TD-07

**Recommendation:** Option A (presigned GET redirect; storage serves Range/206) — Matches the architecture (frontend streams from storage directly), keeps read bytes off the API, and gets real `206 Partial Content` for free from MinIO/S3. `GET /videos/:urlId/stream` and `GET /videos/:urlId/download` respond `302` to a short-lived presigned URL (download adds `Content-Disposition: attachment`); only `ready` videos are served.

**Libraries:** — (uses TD-02 presigner)

### phase-03-videos/TD-08

**Recommendation:** Option A (status enum + BullMQ retry, `error` terminal with reason) — Models the required lifecycle in one column (`draft → processing → ready → error`), leans on BullMQ `attempts`+`backoff` for resilience, and records a terminal `error` state with `error_reason` for permanent failures. Streaming/download require `ready`.

**Libraries:** — (uses TD-01 retry semantics)

## Inherited Decisions Detail

### phase-02-auth/TD-06 (Request Validation Library)

**Recommendation:** Option A (class-validator + class-transformer) — DTO validation via the global `ValidationPipe`. Phase 03 reuses it for all video DTOs (initiate/complete/parts).

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07 (Error Response Standardization)

**Recommendation:** Option A (Custom Domain Exception Filter) — `{ statusCode, error, message }` with domain error codes. Phase 03 video errors extend `DomainException` and are rendered by the existing `DomainExceptionFilter`.

**Libraries:** —

### phase-02-auth/TD-02 (Auth Library Approach)

**Recommendation:** Custom guards with `@nestjs/jwt` only — global `JwtAuthGuard` (`APP_GUARD`) protects all endpoints by default; `@Public()` opts out. Phase 03 video write/own endpoints require authentication; public read (stream/download) uses `@Public()`.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-08 (Rate Limiting Strategy)

**Recommendation:** Option A (`@nestjs/throttler`) — Available in the stack; can be applied to upload-initiation endpoints if abuse protection is desired.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-01-configuracao-base/TD-03 (Config namespacing) & TD-01 (`@nestjs/config`)

**Recommendation:** Namespaced `registerAs` factories per domain in `src/config/`, injected via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`. Phase 03 adds `storage.config.ts` and `queue.config.ts` following this pattern; the same factory is importable as a plain function for the worker bootstrap and TypeORM CLI.

**Libraries:** `@nestjs/config@^4.x`, `joi@^17.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. New: `storage.config.ts`, `queue.config.ts`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. New video/storage/queue vars are added there. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (worker bootstrap, TypeORM CLI). _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema changes only via versioned migrations in `src/database/migrations/`. The new `Video` entity ships with a migration. _(from phase 01)_
- Entities: `@Entity('plural')`, `@PrimaryGeneratedColumn('uuid')`, snake_case columns, `@CreateDateColumn`/`@UpdateDateColumn`, `@Index` on filtered columns, `@ManyToOne` + `@JoinColumn({ name: 'xxx_id' })` for FKs. _(from phase 02)_
- Domain errors extend the abstract `DomainException` (`errorCode`, `httpStatus`) in `src/common/exceptions/`; rendered globally as `{ statusCode, error, message }` by `DomainExceptionFilter`. _(from phase 02)_
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) validates all DTOs (body and query). _(from phase 02)_
- Global `JwtAuthGuard` (`APP_GUARD`) protects every endpoint by default; `@Public()` opts out; `@CurrentUser()` extracts the JWT payload (`sub`, `email`). _(from phase 02)_
- A user owns exactly one channel (1:1, created at registration). Phase 03 videos belong to that channel; ownership is derived from the authenticated user → their channel. _(from phase 02)_
- Repository pattern (`@InjectRepository`); transactions via `DataSource.transaction`; tests at unit (`*.spec.ts`), integration (`*.integration-spec.ts`, real DB), and e2e (`*.e2e-spec.ts`, supertest) layers, run `--runInBand`. _(from phase 02)_
- Endpoints documented with `@nestjs/swagger` decorators (`@ApiTags`, `@ApiOperation`, `@ApiResponse`, `@ApiBearerAuth('access-token')`); error responses reference the shared `ApiErrorEnvelope`. Non-`.hbs`/runtime assets declared in `nest-cli.json`. _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities relevant to Phase 03._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Interface de vídeo (tela de upload, player) | deferred | `next-frontend/` video UI is explicitly out of scope for Phase 03 ("a interface de vídeo não faz parte do escopo desta fase"); this is a backend phase. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type. Phase 03 introduces the `Video` entity, video DTOs, the videos controller/service, the storage service, the queue producer, and the FFmpeg worker processor — each layer is exercised by unit, integration (real DB + real MinIO + real Redis from Compose — do not mock what Compose can run), and E2E (full HTTP cycle via supertest, including a real Range request against MinIO to assert `206`). Per-layer coverage by SI is recorded in `progress.md`. New infrastructure services (MinIO, Redis, worker) must be reachable from the test environment by Compose service name.
