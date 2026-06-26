import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import {
  UploadTooLargeException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService (integration, real DB + MinIO)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let storage: StorageService;
  let queue: jest.Mocked<Pick<Queue, 'add'>>;
  let service: VideosService;
  let userId: string;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video], {
      synchronize: false,
    });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    storage = new StorageService(storageConfig(), videoConfig());
    await storage.ensureBucket();

    queue = { add: jest.fn().mockResolvedValue(undefined) };
    const channelsService = new ChannelsService(dataSource);
    service = new VideosService(
      videoRepository,
      channelsService,
      storage,
      queue as unknown as Queue,
      videoConfig(),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    queue.add.mockClear();
    const user = await userRepository.save(
      userRepository.create({
        email: `owner-${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    userId = user.id;
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'owner',
        nickname: `owner_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  it('initiate persists a draft and creates a multipart upload', async () => {
    const result = await service.initiateUpload(userId, {
      title: 'Holiday clip',
      filename: 'holiday.mp4',
      contentType: 'video/mp4',
      sizeBytes: 5_000_000,
    });

    expect(result.uploadId).toBeTruthy();
    expect(result.key).toMatch(/^videos\/.+\/original\.mp4$/);
    expect(result.urlId).toHaveLength(11);

    const row = await videoRepository.findOneByOrFail({ id: result.id });
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.channel_id).toBe(channelId);
    expect(row.upload_id).toBe(result.uploadId);
    expect(row.size_bytes).toBe(5_000_000);
  });

  it('rejects an oversized upload before touching storage', async () => {
    await expect(
      service.initiateUpload(userId, {
        title: 'huge',
        filename: 'huge.mp4',
        contentType: 'video/mp4',
        sizeBytes: videoConfig().maxUploadBytes + 1,
      }),
    ).rejects.toThrow(UploadTooLargeException);
    await expect(videoRepository.count()).resolves.toBe(0);
  });

  it('completes a real multipart upload and enqueues processing', async () => {
    const init = await service.initiateUpload(userId, {
      title: 'Real upload',
      filename: 'real.bin',
      contentType: 'application/octet-stream',
      sizeBytes: 12,
    });

    const [part] = await service.presignParts(userId, init.id, {
      totalParts: 1,
    });
    const putRes = await fetch(part.url, {
      method: 'PUT',
      body: Buffer.from('hello world!'),
    });
    expect(putRes.status).toBe(200);
    const eTag = putRes.headers.get('etag')!;

    const summary = await service.completeUpload(userId, init.id, {
      parts: [{ partNumber: 1, eTag }],
    });

    expect(summary.status).toBe(VideoStatus.PROCESSING);
    const row = await videoRepository.findOneByOrFail({ id: init.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.upload_id).toBeNull();
    expect(queue.add).toHaveBeenCalledWith(
      'process',
      { videoId: init.id },
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('streams a ready video (presigned URL serves 206) and offers download', async () => {
    const id = randomUUID();
    const key = storage.buildOriginalKey(id, '.bin');
    await storage.putObject(
      key,
      Buffer.from('0123456789abcdef'),
      'application/octet-stream',
    );
    await videoRepository.save(
      videoRepository.create({
        id,
        url_id: 'readyUrlId00',
        channel_id: channelId,
        title: 'Ready',
        status: VideoStatus.READY,
        original_filename: 'ready.bin',
        storage_key: key,
      }),
    );

    const streamUrl = await service.getStreamUrl('readyUrlId00');
    const rangeRes = await fetch(streamUrl, {
      headers: { Range: 'bytes=0-3' },
    });
    expect(rangeRes.status).toBe(206);
    expect(await rangeRes.text()).toBe('0123');

    const downloadUrl = await service.getDownloadUrl('readyUrlId00');
    const dlRes = await fetch(downloadUrl);
    expect(dlRes.headers.get('content-disposition')).toContain('attachment');
  });

  it('refuses to stream a video that is not ready', async () => {
    await videoRepository.save(
      videoRepository.create({
        id: randomUUID(),
        url_id: 'processing01',
        channel_id: channelId,
        title: 'Processing',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/x/original.bin',
      }),
    );
    await expect(service.getStreamUrl('processing01')).rejects.toThrow(
      VideoNotReadyException,
    );
  });
});
