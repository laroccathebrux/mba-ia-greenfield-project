import { IsInt, Max, Min } from 'class-validator';

export class PresignPartsDto {
  /**
   * Number of multipart parts to presign (URLs are returned for parts 1..N).
   * S3 allows at most 10,000 parts per upload.
   */
  @IsInt()
  @Min(1)
  @Max(10000)
  totalParts: number;
}
