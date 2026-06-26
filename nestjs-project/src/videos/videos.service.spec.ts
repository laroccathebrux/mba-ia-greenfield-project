import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import {
  InvalidVideoStateException,
  UploadTooLargeException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const config = {
  maxUploadBytes: 10 * 1024 * 1024 * 1024,
  partSizeBytes: 100 * 1024 * 1024,
  presignExpirySeconds: 3600,
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    url_id: 'urlid123456',
    channel_id: 'channel-1',
    title: 'My video',
    status: VideoStatus.DRAFT,
    original_filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 1000,
    storage_key: 'videos/video-1/original.mp4',
    upload_id: 'upload-1',
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

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let channelsService: jest.Mocked<Pick<ChannelsService, 'findByUserId'>>;
  let storageService: jest.Mocked<
    Pick<
      StorageService,
      | 'buildOriginalKey'
      | 'createMultipartUpload'
      | 'getPresignedUploadPartUrl'
      | 'completeMultipartUpload'
      | 'getPresignedGetUrl'
    >
  >;
  let queue: jest.Mocked<Pick<Queue, 'add'>>;

  beforeEach(() => {
    videoRepository = {
      create: jest.fn((v: Partial<Video>) => v as Video),
      save: jest.fn((v: Video) => Promise.resolve(v)),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Video>>;

    channelsService = { findByUserId: jest.fn() };

    storageService = {
      buildOriginalKey: jest.fn(
        (id: string, ext: string) => `videos/${id}/original${ext}`,
      ),
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      getPresignedUploadPartUrl: jest.fn(
        (_k: string, _u: string, n: number) =>
          Promise.resolve(`https://minio/part/${n}`),
      ),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      getPresignedGetUrl: jest.fn().mockResolvedValue('https://minio/get'),
    };

    queue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new VideosService(
      videoRepository,
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
      queue as unknown as Queue,
      config,
    );
  });

  describe('initiateUpload', () => {
    it('throws UploadTooLargeException when sizeBytes exceeds the max', async () => {
      await expect(
        service.initiateUpload('user-1', {
          title: 't',
          filename: 'big.mp4',
          contentType: 'video/mp4',
          sizeBytes: config.maxUploadBytes + 1,
        }),
      ).rejects.toThrow(UploadTooLargeException);
      expect(channelsService.findByUserId).not.toHaveBeenCalled();
    });

    it('throws VideoAccessDeniedException when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);
      await expect(
        service.initiateUpload('user-1', {
          title: 't',
          filename: 'a.mp4',
          contentType: 'video/mp4',
          sizeBytes: 1000,
        }),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('pre-registers a draft, creates a multipart upload, and returns ids', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' } as never);

      const result = await service.initiateUpload('user-1', {
        title: 'My video',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 2048,
      });

      expect(storageService.createMultipartUpload).toHaveBeenCalled();
      expect(videoRepository.save).toHaveBeenCalled();
      const saved = videoRepository.save.mock.calls[0][0];
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.channel_id).toBe('channel-1');
      expect(saved.url_id).toHaveLength(11);
      expect(result.uploadId).toBe('upload-1');
      expect(result.partSize).toBe(config.partSizeBytes);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('presignParts', () => {
    it('returns one presigned URL per requested part for an owned draft', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' } as never);

      const parts = await service.presignParts('user-1', 'video-1', {
        totalParts: 3,
      });

      expect(parts).toHaveLength(3);
      expect(parts[0]).toEqual({ partNumber: 1, url: 'https://minio/part/1' });
    });

    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);
      await expect(
        service.presignParts('user-1', 'missing', { totalParts: 1 }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoAccessDeniedException for a non-owner', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      channelsService.findByUserId.mockResolvedValue({ id: 'other' } as never);
      await expect(
        service.presignParts('user-1', 'video-1', { totalParts: 1 }),
      ).rejects.toThrow(VideoAccessDeniedException);
    });

    it('throws InvalidVideoStateException when not a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' } as never);
      await expect(
        service.presignParts('user-1', 'video-1', { totalParts: 1 }),
      ).rejects.toThrow(InvalidVideoStateException);
    });
  });

  describe('completeUpload', () => {
    it('completes the multipart upload, sets processing, and enqueues a job', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo());
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' } as never);

      const result = await service.completeUpload('user-1', 'video-1', {
        parts: [{ partNumber: 1, eTag: 'etag-1' }],
      });

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
        [{ partNumber: 1, eTag: 'etag-1' }],
      );
      const saved = videoRepository.save.mock.calls[0][0];
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.upload_id).toBeNull();
      expect(queue.add).toHaveBeenCalledWith(
        'process',
        { videoId: 'video-1' },
        expect.objectContaining({ attempts: 3 }),
      );
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });
  });

  describe('read access', () => {
    it('findByUrlId throws VideoNotFoundException when absent', async () => {
      videoRepository.findOne.mockResolvedValue(null);
      await expect(service.findByUrlId('nope')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('getStreamUrl throws VideoNotReadyException unless ready', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );
      await expect(service.getStreamUrl('urlid123456')).rejects.toThrow(
        VideoNotReadyException,
      );
    });

    it('getStreamUrl returns a presigned URL for a ready video', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );
      await expect(service.getStreamUrl('urlid123456')).resolves.toBe(
        'https://minio/get',
      );
    });

    it('getDownloadUrl passes the original filename', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY, original_filename: 'movie.mp4' }),
      );
      await service.getDownloadUrl('urlid123456');
      expect(storageService.getPresignedGetUrl).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        { downloadFilename: 'movie.mp4' },
      );
    });
  });
});
