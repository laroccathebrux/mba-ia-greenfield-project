import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { ChannelsService } from '../src/channels/channels.service';
import { StorageService } from '../src/storage/storage.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_QUEUE } from '../src/videos/videos.constants';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let channelsService: ChannelsService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    channelsService = moduleFixture.get(ChannelsService);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function login(
    email: string,
    password = 'password123',
  ): Promise<{ accessToken: string; channelId: string }> {
    const authService = app.get(AuthService);

    const mailService = (authService as any).mailService;
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await channelsService.findByUserId(user.id);
    return { accessToken: res.body.access_token, channelId: channel!.id };
  }

  async function seedReadyVideo(
    channelId: string,
    urlId: string,
    bytes: Buffer,
  ): Promise<void> {
    const repo = dataSource.getRepository(Video);
    const id = randomUUID();
    const key = storage.buildOriginalKey(id, '.bin');
    await storage.putObject(key, bytes, 'application/octet-stream');
    await repo.save(
      repo.create({
        id,
        url_id: urlId,
        channel_id: channelId,
        title: 'Ready video',
        status: VideoStatus.READY,
        original_filename: 'ready.bin',
        storage_key: key,
        duration_seconds: 5,
      }),
    );
  }

  describe('POST /videos (initiate)', () => {
    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          title: 't',
          filename: 'a.mp4',
          contentType: 'video/mp4',
          sizeBytes: 1000,
        })
        .expect(401);
    });

    it('returns 201 and pre-registers a draft with a token', async () => {
      const { accessToken } = await login('uploader@example.com');
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My clip',
          filename: 'clip.mp4',
          contentType: 'video/mp4',
          sizeBytes: 5_000_000,
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.urlId).toHaveLength(11);
      expect(res.body.uploadId).toBeDefined();
      expect(res.body.partSize).toBeGreaterThan(0);

      const meta = await request(app.getHttpServer())
        .get(`/videos/${res.body.urlId}`)
        .expect(200);
      expect(meta.body.status).toBe('draft');
    });

    it('returns 413 when sizeBytes exceeds the maximum', async () => {
      const { accessToken } = await login('toobig@example.com');
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'huge',
          filename: 'huge.mp4',
          contentType: 'video/mp4',
          sizeBytes: 10 * 1024 * 1024 * 1024 + 1,
        })
        .expect(413);
      expect(res.body.error).toBe('UPLOAD_TOO_LARGE');
    });
  });

  describe('upload flow (parts + complete)', () => {
    it('uploads a part directly to storage and completes, enqueuing processing', async () => {
      const { accessToken } = await login('flow@example.com');
      const init = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Flow',
          filename: 'flow.bin',
          contentType: 'application/octet-stream',
          sizeBytes: 12,
        })
        .expect(201);

      const partsRes = await request(app.getHttpServer())
        .post(`/videos/${init.body.id}/parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ totalParts: 1 })
        .expect(200);
      expect(partsRes.body).toHaveLength(1);

      const putRes = await fetch(partsRes.body[0].url, {
        method: 'PUT',
        body: Buffer.from('hello world!'),
      });
      expect(putRes.status).toBe(200);
      const eTag = putRes.headers.get('etag')!;

      const completeRes = await request(app.getHttpServer())
        .post(`/videos/${init.body.id}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, eTag }] })
        .expect(200);
      expect(completeRes.body.status).toBe('processing');

      // A processing job was enqueued (no worker consumes during e2e).
      expect(await queue.getWaitingCount()).toBeGreaterThanOrEqual(1);
    });

    it('returns 403 when a non-owner requests presigned parts', async () => {
      const owner = await login('owner-a@example.com');
      const init = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'A',
          filename: 'a.bin',
          contentType: 'application/octet-stream',
          sizeBytes: 10,
        })
        .expect(201);

      const intruder = await login('intruder@example.com');
      const res = await request(app.getHttpServer())
        .post(`/videos/${init.body.id}/parts`)
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .send({ totalParts: 1 })
        .expect(403);
      expect(res.body.error).toBe('VIDEO_ACCESS_DENIED');
    });
  });

  describe('streaming and download', () => {
    it('streams a ready video (302 → presigned URL serving 206)', async () => {
      const { channelId } = await login('viewer@example.com');
      await seedReadyVideo(
        channelId,
        'streamUrlId0',
        Buffer.from('0123456789abcdef'),
      );

      const res = await request(app.getHttpServer())
        .get('/videos/streamUrlId0/stream')
        .expect(302);
      const location = res.headers.location;
      expect(location).toBeTruthy();

      const ranged = await fetch(location, { headers: { Range: 'bytes=0-3' } });
      expect(ranged.status).toBe(206);
      expect(await ranged.text()).toBe('0123');
    });

    it('downloads a ready video (302 → attachment presigned URL)', async () => {
      const { channelId } = await login('dl@example.com');
      await seedReadyVideo(channelId, 'downloadId00', Buffer.from('payload'));

      const res = await request(app.getHttpServer())
        .get('/videos/downloadId00/download')
        .expect(302);
      const dl = await fetch(res.headers.location);
      expect(dl.headers.get('content-disposition')).toContain('attachment');
    });

    it('returns 409 streaming a non-ready video', async () => {
      const { channelId } = await login('notready@example.com');
      const repo = dataSource.getRepository(Video);
      await repo.save(
        repo.create({
          id: randomUUID(),
          url_id: 'notReadyId00',
          channel_id: channelId,
          title: 'Processing',
          status: VideoStatus.PROCESSING,
          storage_key: 'videos/x/original.bin',
        }),
      );
      const res = await request(app.getHttpServer())
        .get('/videos/notReadyId00/stream')
        .expect(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });

    it('returns 404 for an unknown urlId', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/doesNotExist/stream')
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
