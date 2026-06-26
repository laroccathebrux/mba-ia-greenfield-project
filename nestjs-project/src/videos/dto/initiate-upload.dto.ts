import { IsInt, IsPositive, IsString, MaxLength } from 'class-validator';

export class InitiateUploadDto {
  /**
   * Video title (max 200 characters).
   */
  @IsString()
  @MaxLength(200)
  title: string;

  /**
   * Original file name, used to derive the extension and download name.
   */
  @IsString()
  @MaxLength(255)
  filename: string;

  /**
   * MIME type of the uploaded file (e.g. `video/mp4`).
   */
  @IsString()
  @MaxLength(255)
  contentType: string;

  /**
   * Total size of the file in bytes (must not exceed the configured maximum).
   */
  @IsInt()
  @IsPositive()
  sizeBytes: number;
}
