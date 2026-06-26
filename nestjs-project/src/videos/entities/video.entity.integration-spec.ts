import { DataSource, Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { Video, VideoStatus } from './video.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video], {
      synchronize: false,
    });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);

    const user = await userRepository.save(
      userRepository.create({
        email: `owner-${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    channel = await channelRepository.save(
      channelRepository.create({
        name: 'owner',
        nickname: `owner_${Date.now()}`,
        user_id: user.id,
      }),
    );
  });

  function buildVideo(overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      url_id: 'abc12345XYZ',
      channel_id: channel.id,
      title: 'My video',
      storage_key: 'videos/x/original.mp4',
      ...overrides,
    });
  }

  it('defaults status to draft', async () => {
    const saved = await videoRepository.save(buildVideo());
    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('enforces the unique url_id constraint', async () => {
    await videoRepository.save(buildVideo({ url_id: 'dupUrlId0001' }));
    await expect(
      videoRepository.save(
        buildVideo({ url_id: 'dupUrlId0001', storage_key: 'videos/y/o.mp4' }),
      ),
    ).rejects.toThrow();
  });

  it('persists each VideoStatus value', async () => {
    for (const status of Object.values(VideoStatus)) {
      const saved = await videoRepository.save(
        buildVideo({ url_id: `s_${status}`.padEnd(11, '0'), status }),
      );
      const found = await videoRepository.findOneByOrFail({ id: saved.id });
      expect(found.status).toBe(status);
      await videoRepository.delete(saved.id);
    }
  });

  it('round-trips jsonb metadata and bigint size_bytes', async () => {
    const saved = await videoRepository.save(
      buildVideo({
        metadata: {
          codec: 'h264',
          width: 1920,
          height: 1080,
          bitRate: 4500000,
        },
        size_bytes: 9_000_000_000,
        duration_seconds: 120,
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual({
      codec: 'h264',
      width: 1920,
      height: 1080,
      bitRate: 4500000,
    });
    expect(found.size_bytes).toBe(9_000_000_000);
    expect(typeof found.size_bytes).toBe('number');
    expect(found.duration_seconds).toBe(120);
  });

  it('loads the owning channel via the relation', async () => {
    const saved = await videoRepository.save(buildVideo());
    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });
    expect(found.channel.id).toBe(channel.id);
  });

  it('allows nullable processing columns to be null', async () => {
    const saved = await videoRepository.save(buildVideo());
    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.thumbnail_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.error_reason).toBeNull();
    expect(found.upload_id).toBeNull();
  });
});
