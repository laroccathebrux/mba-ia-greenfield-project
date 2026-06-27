import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './videos/worker.module';

/**
 * Entry point for the dedicated video worker container (phase-03-videos/TD-04).
 * Boots a headless Nest application context (no HTTP server); the BullMQ worker
 * registered by `WorkerModule` consumes the `video-processing` queue and keeps
 * the process alive via its open Redis connection.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log(
    'Video worker started — consuming the "video-processing" queue',
    'Worker',
  );
}

void bootstrap();
