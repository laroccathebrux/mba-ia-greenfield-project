import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { VIDEO_QUEUE } from '../videos.constants';
import { VideoProcessingService } from './video-processing.service';

interface ProcessJobData {
  videoId: string;
}

@Processor(VIDEO_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessJobData>): Promise<void> {
    await this.processing.process(job.data.videoId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessJobData>, err: Error): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return; // more retries remain
    }
    // Final failure — record the terminal error state. Background handler:
    // log on failure, never rethrow (would crash the worker).
    try {
      await this.processing.markError(job.data.videoId, err.message);
      this.logger.error(
        `Video ${job.data.videoId} failed permanently: ${err.message}`,
      );
    } catch (e) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as errored: ${
          (e as Error).message
        }`,
      );
    }
  }
}
