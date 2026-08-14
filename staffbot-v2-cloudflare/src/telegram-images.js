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

function imageTypeFromBytes(bytes) {
  const view = new Uint8Array(bytes);
  if (view.length >= 8
    && view[0] === 0x89
    && view[1] === 0x50
    && view[2] === 0x4e
    && view[3] === 0x47
    && view[4] === 0x0d
    && view[5] === 0x0a
    && view[6] === 0x1a
    && view[7] === 0x0a) {
    return { extension: 'png', mime_type: 'image/png' };
  }
  if (view.length >= 3
    && view[0] === 0xff
    && view[1] === 0xd8
    && view[2] === 0xff) {
    return { extension: 'jpg', mime_type: 'image/jpeg' };
  }
  if (view.length >= 12
    && view[0] === 0x52
    && view[1] === 0x49
    && view[2] === 0x46
    && view[3] === 0x46
    && view[8] === 0x57
    && view[9] === 0x45
    && view[10] === 0x42
    && view[11] === 0x50) {
    return { extension: 'webp', mime_type: 'image/webp' };
  }
  return null;
}

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
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > maxBytes) {
    throw new RangeError('telegram image is too large');
  }
  const declaredExtension = IMAGE_EXTENSIONS.get(mimeType);
  const imageType = declaredExtension
    ? { extension: declaredExtension, mime_type: mimeType }
    : imageTypeFromBytes(bytes);
  if (!imageType) {
    throw new TypeError('telegram upload must be an image');
  }

  return {
    bytes,
    extension: imageType.extension,
    file_name: telegramFile.file_path.split('/').at(-1) || null,
    mime_type: imageType.mime_type,
    size_bytes: bytes.byteLength,
    telegram_file_id: selectedPhoto.file_id
  };
}
