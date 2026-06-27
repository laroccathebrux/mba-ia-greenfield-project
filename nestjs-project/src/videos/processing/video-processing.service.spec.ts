import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    url_id: 'urlid123456',
    channel_id: 'channel-1',
    title: 'My video',
    status: VideoStatus.PROCESSING,
    original_filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 1000,
    storage_key: 'videos/video-1/original.mp4',
    upload_id: null,
    thumbnail_key: null,
    duration_seconds: null,
    metadata: null,
    error_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as never,
    ...overrides,
  };
}

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let repo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let storage: jest.Mocked<
    Pick<StorageService, 'getObjectToFile' | 'buildThumbnailKey' | 'putObject'>
  >;
  let ffmpeg: jest.Mocked<Pick<FfmpegService, 'probe' | 'generateThumbnail'>>;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      save: jest.fn((v: Video) => Promise.resolve(v)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = {
      getObjectToFile: jest.fn().mockResolvedValue(undefined),
      buildThumbnailKey: jest.fn((id: string) => `thumbnails/${id}.jpg`),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    ffmpeg = {
      probe: jest.fn().mockResolvedValue({
        durationSeconds: 42,
        metadata: { codec: 'h264', width: 1920, height: 1080, bitRate: 1000 },
      }),
      generateThumbnail: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
    };
    service = new VideoProcessingService(
      repo as unknown as Repository<Video>,
      storage as unknown as StorageService,
      ffmpeg as unknown as FfmpegService,
    );
  });

  it('processes a video to ready with duration, metadata, and thumbnail', async () => {
    repo.findOne.mockResolvedValue(makeVideo());

    await service.process('video-1');

    expect(storage.getObjectToFile).toHaveBeenCalled();
    expect(ffmpeg.probe).toHaveBeenCalled();
    expect(storage.putObject).toHaveBeenCalledWith(
      'thumbnails/video-1.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    const saved = repo.save.mock.calls[0][0];
    expect(saved.status).toBe(VideoStatus.READY);
    expect(saved.duration_seconds).toBe(42);
    expect(saved.metadata).toEqual({
      codec: 'h264',
      width: 1920,
      height: 1080,
      bitRate: 1000,
    });
    expect(saved.thumbnail_key).toBe('thumbnails/video-1.jpg');
  });

  it('is idempotent — skips a video that is already ready', async () => {
    repo.findOne.mockResolvedValue(makeVideo({ status: VideoStatus.READY }));

    await service.process('video-1');

    expect(storage.getObjectToFile).not.toHaveBeenCalled();
    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('throws when the video does not exist (so the queue retries)', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.process('missing')).rejects.toThrow(/not found/);
  });

  it('markError sets the video to error with a reason', async () => {
    await service.markError('video-1', 'ffprobe blew up');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'video-1' },
      { status: VideoStatus.ERROR, error_reason: 'ffprobe blew up' },
    );
  });
});
