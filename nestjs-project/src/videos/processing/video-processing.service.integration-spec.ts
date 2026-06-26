import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DataSource, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { StorageService } from '../../storage/storage.service';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';

const execFileAsync = promisify(execFile);

async function makeSampleVideo(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'sample-'));
  const out = join(dir, 'sample.mp4');
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('VideoProcessingService (integration, real MinIO + DB + FFmpeg)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let storage: StorageService;
  let service: VideoProcessingService;
  let channelId: string;
  let sample: Buffer;

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
    service = new VideoProcessingService(
      videoRepository,
      storage,
      new FfmpegService(),
    );
    sample = await makeSampleVideo();
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await userRepository.save(
      userRepository.create({
        email: `proc-${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'proc',
        nickname: `proc_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  async function seedProcessing(bytes: Buffer): Promise<Video> {
    const id = randomUUID();
    const key = storage.buildOriginalKey(id, '.mp4');
    await storage.putObject(key, bytes, 'video/mp4');
    return videoRepository.save(
      videoRepository.create({
        id,
        url_id: randomUUID().slice(0, 11),
        channel_id: channelId,
        title: 'To process',
        status: VideoStatus.PROCESSING,
        original_filename: 'sample.mp4',
        storage_key: key,
      }),
    );
  }

  it('extracts duration/metadata, generates a thumbnail, and marks ready', async () => {
    const video = await seedProcessing(sample);

    await service.process(video.id);

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(row.duration_seconds).toBeLessThanOrEqual(3);
    expect(row.metadata?.width).toBe(320);
    expect(row.metadata?.height).toBe(240);
    expect(row.metadata?.codec).toBeTruthy();
    expect(row.thumbnail_key).toBe(`thumbnails/${video.id}.jpg`);

    // The thumbnail object really exists in storage and is non-empty.
    const dir = await mkdtemp(join(tmpdir(), 'thumb-check-'));
    const dest = join(dir, 'thumb.jpg');
    try {
      await storage.getObjectToFile(row.thumbnail_key!, dest);
      expect((await stat(dest)).size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('throws on an unprocessable object so the queue can retry, then markError sets error', async () => {
    const video = await seedProcessing(Buffer.from('this is not a video'));

    await expect(service.process(video.id)).rejects.toThrow();

    await service.markError(video.id, 'ffprobe failed');
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.ERROR);
    expect(row.error_reason).toBe('ffprobe failed');
  }, 30000);
});
