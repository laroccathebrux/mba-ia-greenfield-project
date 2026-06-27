import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration, real MinIO)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        StorageModule,
      ],
    }).compile();
    await moduleRef.init(); // triggers onModuleInit → ensureBucket
    service = moduleRef.get(StorageService);
  });

  it('ensureBucket is idempotent', async () => {
    await expect(service.ensureBucket()).resolves.not.toThrow();
    await expect(service.ensureBucket()).resolves.not.toThrow();
  });

  it('round-trips a multipart upload and serves Range (206) on presigned GET', async () => {
    const key = `test/${randomUUID()}.bin`;
    const body = Buffer.from('the quick brown fox jumps over the lazy dog');

    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const partUrl = await service.getPresignedUploadPartUrl(key, uploadId, 1);

    const putRes = await fetch(partUrl, { method: 'PUT', body });
    expect(putRes.status).toBe(200);
    const eTag = putRes.headers.get('etag');
    expect(eTag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag: eTag! },
    ]);

    // Streaming: a Range request to the presigned GET URL returns 206.
    const getUrl = await service.getPresignedGetUrl(key);
    const rangeRes = await fetch(getUrl, { headers: { Range: 'bytes=0-8' } });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toContain('bytes 0-8/');
    expect(await rangeRes.text()).toBe('the quick');
  });

  it('download presigned URL forces Content-Disposition: attachment', async () => {
    const key = `test/${randomUUID()}.bin`;
    await service.putObject(key, Buffer.from('payload'), 'text/plain');

    const url = await service.getPresignedGetUrl(key, {
      downloadFilename: 'my video.mp4',
    });
    expect(url).toContain('response-content-disposition');

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('putObject + getObjectToFile round-trips bytes', async () => {
    const key = `test/${randomUUID()}.jpg`;
    const original = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await service.putObject(key, original, 'image/jpeg');

    const dest = join(tmpdir(), `${randomUUID()}.jpg`);
    try {
      await service.getObjectToFile(key, dest);
      const downloaded = await readFile(dest);
      expect(downloaded.equals(original)).toBe(true);
    } finally {
      await rm(dest, { force: true });
    }
  });

  it('builds namespaced storage keys', () => {
    const videoId = '11111111-1111-1111-1111-111111111111';
    expect(service.buildOriginalKey(videoId, '.mp4')).toBe(
      `videos/${videoId}/original.mp4`,
    );
    expect(service.buildThumbnailKey(videoId)).toBe(
      `thumbnails/${videoId}.jpg`,
    );
  });
});
