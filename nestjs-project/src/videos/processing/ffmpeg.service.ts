import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import type { VideoMetadata } from '../entities/video.entity';

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

@Injectable()
export class FfmpegService {
  /**
   * Extracts duration and basic video-stream metadata via ffprobe.
   */
  async probe(inputPath: string): Promise<ProbeResult> {
    const data = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) =>
        err
          ? reject(err instanceof Error ? err : new Error(String(err)))
          : resolve(metadata),
      );
    });

    const videoStream = data.streams.find((s) => s.codec_type === 'video');
    const bitRate = videoStream?.bit_rate;

    return {
      durationSeconds: Math.round(data.format.duration ?? 0),
      metadata: {
        codec: videoStream?.codec_name,
        width: videoStream?.width,
        height: videoStream?.height,
        bitRate:
          bitRate !== undefined && bitRate !== 'N/A'
            ? Number(bitRate)
            : undefined,
      },
    };
  }

  /**
   * Captures a single frame (midpoint) as a JPEG thumbnail and returns its bytes.
   */
  async generateThumbnail(inputPath: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'thumb-'));
    const outputPath = join(dir, 'thumb.jpg');
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .on('end', () => resolve())
          .on('error', reject)
          .screenshots({
            timestamps: ['50%'],
            filename: 'thumb.jpg',
            folder: dir,
            size: '640x?',
          });
      });
      return await readFile(outputPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
