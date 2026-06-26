import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { FfmpegService } from './ffmpeg.service';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {}

  /**
   * Processes a video: download original → ffprobe (duration/metadata) →
   * thumbnail → upload thumbnail → mark ready. Idempotent on videoId.
   */
  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new Error(`Video ${videoId} not found`);
    }
    if (video.status === VideoStatus.READY) {
      return; // already processed — safe to re-run
    }

    const workDir = await mkdtemp(join(tmpdir(), 'video-proc-'));
    try {
      const inputPath = join(
        workDir,
        `input${extname(video.storage_key) || '.bin'}`,
      );
      await this.storageService.getObjectToFile(video.storage_key, inputPath);

      const { durationSeconds, metadata } =
        await this.ffmpegService.probe(inputPath);

      const thumbnailKey = this.storageService.buildThumbnailKey(video.id);
      const thumbnail = await this.ffmpegService.generateThumbnail(inputPath);
      await this.storageService.putObject(
        thumbnailKey,
        thumbnail,
        'image/jpeg',
      );

      video.duration_seconds = durationSeconds;
      video.metadata = metadata;
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.READY;
      video.error_reason = null;
      await this.videoRepository.save(video);
      this.logger.log(`Video ${video.id} processed (${durationSeconds}s)`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Marks a video as failed after the queue exhausts its retries.
   */
  async markError(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      { status: VideoStatus.ERROR, error_reason: reason },
    );
  }
}
