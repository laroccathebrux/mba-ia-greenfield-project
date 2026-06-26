import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import {
  InvalidVideoStateException,
  UploadTooLargeException,
  VideoAccessDeniedException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import videoConfig from '../config/video.config';
import { Video, VideoStatus } from './entities/video.entity';
import { generateUrlId } from './url-id.util';
import {
  VIDEO_JOB_OPTIONS,
  VIDEO_PROCESS_JOB,
  VIDEO_QUEUE,
} from './videos.constants';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { PresignPartsDto } from './dto/presign-parts.dto';
import type { CompleteUploadDto } from './dto/complete-upload.dto';

const PG_UNIQUE_VIOLATION = '23505';
const URL_ID_COLUMN = 'url_id';
const MAX_URL_ID_RETRIES = 5;

function isUrlIdConflict(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(URL_ID_COLUMN)
  );
}

export interface InitiateUploadResult {
  id: string;
  urlId: string;
  uploadId: string;
  key: string;
  partSize: number;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface VideoSummary {
  id: string;
  urlId: string;
  status: VideoStatus;
}

export interface PublicVideoView {
  urlId: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  metadata: Video['metadata'];
  thumbnailUrl: string | null;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_QUEUE) private readonly queue: Queue,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    if (dto.sizeBytes > this.config.maxUploadBytes) {
      throw new UploadTooLargeException();
    }

    const channel = await this.getOwnedChannel(userId);

    const id = randomUUID();
    const storageKey = this.storageService.buildOriginalKey(
      id,
      extname(dto.filename),
    );
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    const video = await this.saveWithUniqueUrlId((urlId) =>
      this.videoRepository.create({
        id,
        url_id: urlId,
        channel_id: channel.id,
        title: dto.title,
        status: VideoStatus.DRAFT,
        original_filename: dto.filename,
        content_type: dto.contentType,
        size_bytes: dto.sizeBytes,
        storage_key: storageKey,
        upload_id: uploadId,
      }),
    );

    return {
      id: video.id,
      urlId: video.url_id,
      uploadId,
      key: storageKey,
      partSize: this.config.partSizeBytes,
    };
  }

  async presignParts(
    userId: string,
    videoId: string,
    dto: PresignPartsDto,
  ): Promise<PresignedPart[]> {
    const video = await this.loadOwnedDraft(userId, videoId);
    const parts: PresignedPart[] = [];
    for (let partNumber = 1; partNumber <= dto.totalParts; partNumber++) {
      const url = await this.storageService.getPresignedUploadPartUrl(
        video.storage_key,
        video.upload_id!,
        partNumber,
      );
      parts.push({ partNumber, url });
    }
    return parts;
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<VideoSummary> {
    const video = await this.loadOwnedDraft(userId, videoId);

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id!,
      dto.parts,
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    const saved = await this.videoRepository.save(video);

    await this.queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: saved.id },
      VIDEO_JOB_OPTIONS,
    );

    return { id: saved.id, urlId: saved.url_id, status: saved.status };
  }

  async findByUrlId(urlId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { url_id: urlId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async getStreamUrl(urlId: string): Promise<string> {
    const video = await this.requireReady(urlId);
    return this.storageService.getPresignedGetUrl(video.storage_key);
  }

  async getDownloadUrl(urlId: string): Promise<string> {
    const video = await this.requireReady(urlId);
    return this.storageService.getPresignedGetUrl(video.storage_key, {
      downloadFilename: video.original_filename ?? `${video.url_id}.mp4`,
    });
  }

  async getPublicView(urlId: string): Promise<PublicVideoView> {
    const video = await this.findByUrlId(urlId);
    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.getPresignedGetUrl(video.thumbnail_key)
      : null;
    return {
      urlId: video.url_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl,
    };
  }

  private async requireReady(urlId: string): Promise<Video> {
    const video = await this.findByUrlId(urlId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async getOwnedChannel(userId: string) {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoAccessDeniedException();
    }
    return channel;
  }

  private async loadOwnedDraft(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    const channel = await this.getOwnedChannel(userId);
    if (video.channel_id !== channel.id) {
      throw new VideoAccessDeniedException();
    }
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidVideoStateException();
    }
    return video;
  }

  private async saveWithUniqueUrlId(
    build: (urlId: string) => Video,
  ): Promise<Video> {
    for (let attempt = 0; attempt < MAX_URL_ID_RETRIES; attempt++) {
      try {
        return await this.videoRepository.save(build(generateUrlId()));
      } catch (err) {
        if (isUrlIdConflict(err) && attempt < MAX_URL_ID_RETRIES - 1) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('Could not generate a unique url_id after max retries');
  }
}
