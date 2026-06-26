import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideosService } from './videos.service';
import type {
  InitiateUploadResult,
  PresignedPart,
  PublicVideoView,
  VideoSummary,
} from './videos.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft on the caller’s channel, starts a multipart upload, and returns the upload id, storage key, and part size.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        urlId: { type: 'string' },
        uploadId: { type: 'string' },
        key: { type: 'string' },
        partSize: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Upload exceeds the maximum allowed size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get presigned upload-part URLs',
    description:
      'Returns presigned URLs for the requested multipart parts. The client PUTs each part directly to storage (bytes never pass through the API).',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      type: 'array',
      items: {
        properties: {
          partNumber: { type: 'number' },
          url: { type: 'string' },
        },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a draft (uploadable) state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PresignPartsDto,
  ): Promise<PresignedPart[]> {
    return this.videosService.presignParts(user.sub, id, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload, transitions the video to processing, and enqueues the background processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        urlId: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in a draft (uploadable) state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoSummary> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Public()
  @Get(':urlId')
  @ApiOperation({
    summary: 'Get public video metadata',
    description:
      'Returns the public metadata of a video by its unique URL id (title, status, duration, thumbnail).',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        urlId: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        durationSeconds: { type: 'number', nullable: true },
        metadata: { type: 'object', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getOne(@Param('urlId') urlId: string): Promise<PublicVideoView> {
    return this.videosService.getPublicView(urlId);
  }

  @Public()
  @Get(':urlId/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a short-lived presigned URL; the storage backend serves HTTP Range requests (206 Partial Content) so playback starts without a full download. Only ready videos are streamable.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the presigned stream URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('urlId') urlId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamUrl(urlId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Get(':urlId/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects (302) to a short-lived presigned URL that forces a file download (Content-Disposition: attachment). Only ready videos are downloadable.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('urlId') urlId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadUrl(urlId);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
