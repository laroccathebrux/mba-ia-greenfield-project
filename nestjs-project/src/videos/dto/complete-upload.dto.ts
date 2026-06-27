import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /**
   * Part number (1-based), matching the presigned UploadPart URL used.
   */
  @IsInt()
  @Min(1)
  partNumber: number;

  /**
   * ETag returned by storage when the part was uploaded.
   */
  @IsString()
  @IsNotEmpty()
  eTag: string;
}

export class CompleteUploadDto {
  /**
   * The uploaded parts, in any order (sorted server-side by part number).
   */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
