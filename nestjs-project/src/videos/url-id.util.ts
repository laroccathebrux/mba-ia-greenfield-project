import { randomBytes } from 'node:crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const URL_ID_LENGTH = 11;

/**
 * Generates an 11-character URL-safe base62 identifier from cryptographically
 * secure random bytes (phase-03-videos/TD-06). ~65 bits of entropy; combined
 * with the UNIQUE `url_id` column + regenerate-on-collision, conflicts are
 * impossible. No external dependency (CommonJS-safe, unlike nanoid@5/ESM).
 */
export function generateUrlId(): string {
  const bytes = randomBytes(URL_ID_LENGTH);
  let id = '';
  for (let i = 0; i < URL_ID_LENGTH; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}
