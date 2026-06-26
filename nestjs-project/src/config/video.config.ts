import { registerAs } from '@nestjs/config';

// 10 GB and 100 MB defaults per phase-03-videos/TD-03 (Revisions).
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const DEFAULT_PART_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export default registerAs('video', () => ({
  maxUploadBytes: parseInt(
    process.env.VIDEO_MAX_UPLOAD_BYTES || String(DEFAULT_MAX_UPLOAD_BYTES),
    10,
  ),
  partSizeBytes: parseInt(
    process.env.VIDEO_PART_SIZE_BYTES || String(DEFAULT_PART_SIZE_BYTES),
    10,
  ),
  presignExpirySeconds: parseInt(
    process.env.VIDEO_PRESIGN_EXPIRY_SECONDS || '3600',
    10,
  ),
}));
