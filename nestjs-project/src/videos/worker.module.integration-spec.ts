import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WorkerModule } from './worker.module';
import { VideoProcessor } from './processing/video.processor';
import { VideoProcessingService } from './processing/video-processing.service';
import { VIDEO_QUEUE } from './videos.constants';

describe('WorkerModule (integration boot)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();
  }, 30000);

  afterAll(async () => {
    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE));
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  it('boots headless and resolves the processor and processing service', () => {
    expect(moduleRef.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    expect(moduleRef.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
  });
});
