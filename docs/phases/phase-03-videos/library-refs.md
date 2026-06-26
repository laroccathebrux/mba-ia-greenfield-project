---
libs:
  "bullmq":
    version: "5.79.1"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-06-26T19:21:11-03:00"
  "@nestjs/bullmq":
    version: "11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-06-26T19:21:11-03:00"
  "@aws-sdk/client-s3":
    version: "3.1075.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-26T19:21:11-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1075.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-26T19:21:11-03:00"
  "fluent-ffmpeg":
    version: "2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-06-26T19:21:11-03:00"
  "@types/fluent-ffmpeg":
    version: "2.1.28"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-06-26T19:21:11-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T19:17:45-03:00"
---

# Library References — phase-03-videos

Cached Context7 excerpts for libraries decided in this phase. Versions are the exact resolvable versions in the `nestjs-project/` stack (Node 25, NestJS 11). Refreshed by `/plan-resolve` when a new library is decided or the cache is missing.

`ioredis` is a transitive dependency of `bullmq` (the Redis client) — not declared directly. The Redis broker itself runs as a Compose service (`redis:7`), not an npm package.

---

## bullmq

**Version line:** `5.79.1` (peer-compatible with `@nestjs/bullmq@11`; Node ≥ 20). Backs `phase-03-videos/TD-01`.
**Decided in:** `phase-03-videos/TD-01` (Option A — BullMQ + Redis), `phase-03-videos/TD-04` (worker), `phase-03-videos/TD-08` (retry/backoff).
**Context7 ID:** `/taskforcesh/bullmq`.

### Connection & job options (defaultJobOptions with retry/backoff)

```typescript
// Queue-level defaults used when enqueuing the processing job (TD-08 resilience)
const defaultJobOptions = {
  attempts: 3,                                   // total tries before the job is "failed"
  backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s
  removeOnComplete: 100,                          // keep last 100 completed for inspection
  removeOnFail: 500,
};
```

A job is delivered at-least-once; the consumer must be **idempotent on `videoId`** (re-running ffprobe/thumbnail for an already-`ready` video is a no-op or safe overwrite).

---

## @nestjs/bullmq

**Version line:** `11.0.4` (aligns with `@nestjs/core@^11`). Backs `phase-03-videos/TD-01` and `TD-04`.
**Decided in:** `phase-03-videos/TD-01`, `phase-03-videos/TD-04`.
**Context7 ID:** `/nestjs/bull`.

### Root connection + queue registration (producer side, API)

```typescript
// queue.module-ish wiring — connection from queueConfig (registerAs, per phase-01 convention)
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.redisHost, port: cfg.redisPort }, // host = 'redis' (Compose service name)
  }),
});
BullModule.registerQueue({ name: 'video-processing' });
```

```typescript
// Producer: inject the queue and add a job after CompleteMultipartUpload (TD-03 step 3)
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

await this.queue.add('process', { videoId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
});
```

### Consumer: `@Processor` + `WorkerHost` (worker container, TD-04)

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // 1) load video, 2) download original from storage, 3) ffprobe metadata/duration,
    // 4) generate thumbnail, 5) upload thumbnail, 6) set status = 'ready'
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // on final attempt, the videos service marks status = 'error' + error_reason
  }
}
```

The worker process boots via `NestFactory.createApplicationContext(WorkerModule)` (no HTTP) — `@nestjs/bullmq` instantiates the BullMQ `Worker` from the registered `@Processor` when the module initializes. `WorkerHost.process` is the single entry point per job.

---

## @aws-sdk/client-s3

**Version line:** `3.1075.0` (AWS SDK v3, modular). Backs `phase-03-videos/TD-02`, `TD-03`.
**Decided in:** `phase-03-videos/TD-02` (storage access), `TD-03` (multipart upload).
**Context7 ID:** `/aws/aws-sdk-js-v3`.

### S3Client for MinIO (path-style + custom endpoint)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: cfg.endpoint,        // 'http://minio:9000' (Compose service name)
  forcePathStyle: true,          // REQUIRED for MinIO (path-style addressing)
  region: cfg.region,            // 'us-east-1' (any; MinIO ignores)
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

### Multipart upload (initiate / parts / complete) — TD-03

```typescript
import {
  CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

// 1) initiate (POST /videos)
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
  Bucket, Key: `videos/${videoId}/original${ext}`, ContentType,
}));

// 2) presign each UploadPart URL (POST /videos/:id/parts) — client PUTs bytes directly
const url = await getSignedUrl(s3, new UploadPartCommand({
  Bucket, Key, UploadId, PartNumber,
}), { expiresIn: 3600 });

// 3) complete (POST /videos/:id/complete) with the ordered {PartNumber, ETag} list
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: parts /* [{ ETag, PartNumber }] */ },
}));
```

### Thumbnail upload + worker download

```typescript
import { PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

// worker downloads original: GetObjectCommand → body is a Node Readable stream (pipe to temp file)
// worker uploads thumbnail: PutObjectCommand({ Bucket, Key: `thumbnails/${videoId}.jpg`, Body, ContentType: 'image/jpeg' })
// startup: HeadBucketCommand → on NotFound, CreateBucketCommand (idempotent bucket bootstrap)
```

---

## @aws-sdk/s3-request-presigner

**Version line:** `3.1075.0` (pairs with `@aws-sdk/client-s3@3.1075.0`). Backs `phase-03-videos/TD-03`, `TD-07`.
**Decided in:** `phase-03-videos/TD-03` (presigned part URLs), `phase-03-videos/TD-07` (presigned GET for stream/download).
**Context7 ID:** `/aws/aws-sdk-js-v3`.

### Presigned GET for streaming & download (TD-07)

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

// streaming: plain presigned GET — storage serves Range / 206 Partial Content natively
const streamUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });

// download: override Content-Disposition so the browser saves the file
const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: `attachment; filename="${safeName}"`,
}), { expiresIn: 3600 });
```

`response-content-disposition` / `response-content-type` are only honored on **signed** requests — hence presigned URLs, not public objects.

---

## fluent-ffmpeg

**Version line:** `2.1.3` (+ `@types/fluent-ffmpeg@2.1.28` dev). Wraps the system `ffmpeg`/`ffprobe` binaries (installed via apt in the worker image). Backs `phase-03-videos/TD-05`.
**Decided in:** `phase-03-videos/TD-05` (metadata + thumbnail).
**Context7 ID:** `/fluent-ffmpeg/node-fluent-ffmpeg`.

### ffprobe — duration & metadata

```typescript
import ffmpeg from 'fluent-ffmpeg';

const metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) =>
  ffmpeg.ffprobe(localPath, (err, data) => (err ? reject(err) : resolve(data))),
);
const durationSeconds = Math.round(metadata.format.duration ?? 0);
const video = metadata.streams.find((s) => s.codec_type === 'video');
// video?.codec_name, video?.width, video?.height, video?.bit_rate
```

### Thumbnail — single frame at a timestamp

```typescript
await new Promise<void>((resolve, reject) =>
  ffmpeg(localPath)
    .on('end', () => resolve())
    .on('error', reject)
    .screenshots({
      timestamps: ['50%'],          // one frame at the midpoint
      filename: `${videoId}.jpg`,
      folder: tmpDir,
      size: '640x?',                // keep aspect ratio
    }),
);
```

### Binary paths (when not on PATH)

```typescript
// Optional — only if the binaries are not on PATH inside the worker image
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');
```

The worker Dockerfile runs `apt-get install -y ffmpeg`, putting both binaries on `PATH`; the explicit `set*Path` calls are then unnecessary.
