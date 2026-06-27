export const VIDEO_QUEUE = 'video-processing';
export const VIDEO_PROCESS_JOB = 'process';

export const VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
} as const;
