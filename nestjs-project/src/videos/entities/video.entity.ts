import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

export interface VideoMetadata {
  codec?: string;
  width?: number;
  height?: number;
  bitRate?: number;
}

// bigint columns are returned as strings by the pg driver; convert to number
// (10 GB = 10_737_418_240 < Number.MAX_SAFE_INTEGER, so no precision loss).
const bigintToNumber = {
  to: (value?: number | null): number | null | undefined => value,
  from: (value?: string | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16, unique: true })
  url_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  original_filename: string | null;

  @Column({ type: 'varchar', nullable: true })
  content_type: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintToNumber })
  size_bytes: number | null;

  @Column({ type: 'varchar' })
  storage_key: string;

  @Column({ type: 'varchar', nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'text', nullable: true })
  error_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
