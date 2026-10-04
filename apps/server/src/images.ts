import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError } from './errors.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 12_000_000;
const ImageRequest = z.object({ dataUrl: z.string().max(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 50) }).strict();

function actualFormat(bytes: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Decode then re-encode to discard metadata and any trailing/polyglot payload. No URLs or SVG accepted. */
export async function validateImage(body: unknown) {
  const parsed = ImageRequest.safeParse(body);
  if (!parsed.success) throw new AppError('invalid_image', '画像データは5MB以内のPNG・JPEG・WebPを指定してください。');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(parsed.data.dataUrl);
  if (!match) throw new AppError('invalid_image', 'PNG・JPEG・WebPの画像ファイルだけを読み込めます。');
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 12 || bytes.toString('base64') !== match[2]) throw new AppError('invalid_image', '画像のサイズまたはデータが不正です。');
  const format = actualFormat(bytes);
  if (!format || format !== match[1]) throw new AppError('invalid_image', '画像形式と実際の内容が一致しません。');
  try {
    const decoder = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning', animated: true });
    const metadata = await decoder.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || metadata.width * metadata.height > MAX_IMAGE_PIXELS || (metadata.pages || 1) !== 1) {
      throw new Error('Invalid dimensions or animated image');
    }
    const { data, info } = await decoder.rotate().png().toBuffer({ resolveWithObject: true });
    if (data.length > MAX_IMAGE_BYTES) throw new AppError('image_too_large', '展開した画像が5MBを超えます。解像度を下げてください。', 413);
    return { image: {
      id: createHash('sha256').update(data).digest('hex'),
      widthPx: info.width,
      heightPx: info.height,
      mimeType: 'image/png' as const,
      dataUrl: `data:image/png;base64,${data.toString('base64')}`,
    } };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('invalid_image', '画像を展開できません。静止画で1200万画素以下のPNG・JPEG・WebPを指定してください。');
  }
}
