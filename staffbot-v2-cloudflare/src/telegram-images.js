import {
  downloadTelegramFile,
  getTelegramFile
} from './telegram-client.js';

const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export function largestTelegramPhoto(photo) {
  const photos = Array.isArray(photo) ? photo : [photo];
  return photos
    .filter((item) => item && item.file_id)
    .sort((left, right) =>
      Number(right.file_size || 0) - Number(left.file_size || 0)
      || Number(right.width || 0) * Number(right.height || 0)
        - Number(left.width || 0) * Number(left.height || 0)
    )[0] || null;
}

export async function downloadTelegramImage(
  env,
  photo,
  { maxBytes = DEFAULT_MAX_BYTES } = {}
) {
  const selectedPhoto = largestTelegramPhoto(photo);
  if (!selectedPhoto) throw new Error('telegram image is required');
  if (Number(selectedPhoto.file_size || 0) > maxBytes) {
    throw new RangeError('telegram image is too large');
  }

  const telegramFile = await getTelegramFile(
    env,
    selectedPhoto.file_id
  );
  const response = await downloadTelegramFile(
    env,
    telegramFile.file_path
  );
  if (!response.ok) throw new Error('telegram_file_download_failed');
  const mimeType = String(
    response.headers.get('content-type') || ''
  ).split(';')[0].trim().toLowerCase();
  const extension = IMAGE_EXTENSIONS.get(mimeType);
  if (!extension) {
    throw new TypeError('telegram upload must be an image');
  }
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > maxBytes) {
    throw new RangeError('telegram image is too large');
  }

  return {
    bytes,
    extension,
    file_name: telegramFile.file_path.split('/').at(-1) || null,
    mime_type: mimeType,
    size_bytes: bytes.byteLength,
    telegram_file_id: selectedPhoto.file_id
  };
}
