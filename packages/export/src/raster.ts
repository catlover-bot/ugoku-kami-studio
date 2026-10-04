import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ImageSource } from '@ugoku/core';

/** Header dimensions supplement the byte binding for synchronous SVG exports. */
function dimensions(bytes: Uint8Array, mime: ImageSource['mimeType']): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      offset += length;
    }
  }
  if (mime === 'image/webp' && bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === 'VP8X') return { width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) };
    if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (kind === 'VP8L' && bytes[20] === 47) return { width: 1 + bytes[21]! + ((bytes[22]! & 63) << 8), height: 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 15) << 10) };
  }
  throw new Error('背景画像の種類と内容を確認できません。画像を選び直してください');
}

export function validateBackgroundRaster(dataUrl: string | undefined, source: ImageSource): asserts dataUrl is string {
  if (!dataUrl) throw new Error('この設計の背景画像がありません。背景画像を含むプロジェクトを読み込んでください');
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 7_000_000) throw new Error('背景画像は5MB以下のPNG/JPEG/WebPにしてください');
  if (!dataUrl.startsWith(`data:${source.mimeType};base64,`)) throw new Error('背景画像の種類と設計が一致しません');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(dataUrl.split(',')[1]!), character => character.charCodeAt(0)); }
  catch { throw new Error('背景画像の埋め込みデータが不正です'); }
  if (bytes.length > 5 * 1024 * 1024) throw new Error('背景画像は5MB以下にしてください');
  if (bytesToHex(sha256(bytes)) !== source.id) throw new Error('背景画像と設計の画像ハッシュが一致しません');
  const size = dimensions(bytes, source.mimeType);
  if (size.width !== source.widthPx || size.height !== source.heightPx) throw new Error('背景画像の画素寸法と設計が一致しません');
}
