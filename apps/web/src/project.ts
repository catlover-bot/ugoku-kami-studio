import { z } from 'zod';
import { parseDesignDocument, type DesignDocument } from '@ugoku/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 12_000_000;
export const MAX_RECORD_PHOTOS = 4;
export const MAX_PROJECT_BYTES = 45_000_000;
export const MAX_PHYSICAL_RECORDS = 100;
export const photoViewLabels = {unspecified: '未指定', front: '正面', back: '裏面', start: '始点', end: '終点'} as const;
export const STORAGE_KEY = 'ugoku-kami.project.v1';
const imageData = z.string().max(8_000_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
export const physicalRecordSchema = z.object({
  id: z.string().max(100), designId: z.string().max(100).default(''), designHash: z.string().max(150), revision: z.number().int().positive(),
  pattern: z.string().max(200), material: z.string().max(1000), printScale: z.string().max(100),
  measuredLine: z.string().max(100), modifications: z.string().max(3000), movement: z.string().max(3000),
  endpoints: z.string().max(2000).default(''), guideRetention: z.string().max(2000).default(''),
  glueFaces: z.string().max(2000).default(''),
  roundTrips: z.string().max(2000).default(''), viewObservations: z.string().max(2000).default(''),
  photoViews: z.array(z.enum(['unspecified', 'front', 'back', 'start', 'end'])).max(MAX_RECORD_PHOTOS).default([]),
  photos: z.array(imageData).max(MAX_RECORD_PHOTOS),
}).strict();
export type PhysicalRecord = z.infer<typeof physicalRecordSchema>;
export type Project = { document: DesignDocument; imageDataUrl: string; backgroundImageDataUrl?: string; records: PhysicalRecord[] };
export function imageContentId(dataUrl: string): string {
  return bytesToHex(sha256(Uint8Array.from(atob(dataUrl.split(',')[1]!), character => character.charCodeAt(0))));
}
const sharedProject = { format: z.literal('ugoku-kami-project'), document: z.unknown(), imageDataUrl: imageData, records: z.array(physicalRecordSchema).max(MAX_PHYSICAL_RECORDS) };
const projectSchema = z.discriminatedUnion('version', [
  z.object({ ...sharedProject, version: z.literal(1) }).strict(),
  z.object({ ...sharedProject, version: z.literal(2), backgroundImageDataUrl: imageData.optional() }).strict(),
]);

export function assertProjectByteLength(bytes: number): void {
  if (bytes > MAX_PROJECT_BYTES) throw new Error('プロジェクト全体は45MBまでです。写真の枚数を減らすか、小さい画像に選び直してください。');
}

function parseProjectPayload(value: unknown) {
  try { return projectSchema.parse(value); }
  catch (error) {
    if (error instanceof z.ZodError && error.issues.some(issue => issue.code === 'too_big' && issue.path.length === 1 && issue.path[0] === 'records')) {
      throw new Error(`実物記録は1作品につき${MAX_PHYSICAL_RECORDS}件までです。入力中の内容は別に控え、下書きを空欄にすると追加済みの作品を保存できます。`, { cause: error });
    }
    throw error;
  }
}

export function imageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  throw new Error('PNG・JPEG・WebP の画像を選んでください。SVGやHTMLは読み込めません。');
}

function checkRasterHeader(bytes: Uint8Array, mime: string) {
  if (mime !== 'image/png') return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_IMAGE_PIXELS) throw new Error('画像は1,200万画素以下、縦横それぞれ8,192px以下にしてください。');
}

export function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS || image.naturalWidth > 8192 || image.naturalHeight > 8192) reject(new Error('画像は1,200万画素以下、縦横それぞれ8,192px以下にしてください。'));
      else resolve(image);
    };
    image.onerror = () => reject(new Error('画像を開けませんでした。画像ファイルが壊れていないか確認してください。'));
    image.src = dataUrl;
  });
}

export async function readRaster(file: File): Promise<{dataUrl: string; widthPx: number; heightPx: number; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'}> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('画像は5MB以下にしてください。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = imageMime(bytes);
  checkRasterHeader(bytes, mimeType);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(`data:${mimeType};base64,${String(reader.result).split(',')[1]}`); reader.onerror = () => reject(new Error('画像を読み込めませんでした。')); reader.readAsDataURL(file);
  });
  const image = await decodeImage(dataUrl);
  return { dataUrl, widthPx: image.naturalWidth, heightPx: image.naturalHeight, mimeType };
}

export async function verifyDataImage(dataUrl: string) {
  imageData.parse(dataUrl);
  const base64 = dataUrl.split(',')[1]!;
  if (base64.length * 0.75 > MAX_IMAGE_BYTES + 2) throw new Error('画像は5MB以下にしてください。');
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const mime = imageMime(bytes);
  checkRasterHeader(bytes, mime);
  if (!dataUrl.startsWith(`data:${mime};base64,`)) throw new Error('画像の種類と内容が一致しません。');
  return decodeImage(dataUrl);
}

export async function parseProject(text: string): Promise<Project> {
  assertProjectByteLength(new TextEncoder().encode(text).byteLength);
  const parsed = parseProjectPayload(JSON.parse(text));
  const document = parseDesignDocument(parsed.document);
  const image = await verifyDataImage(parsed.imageDataUrl);
  if (!parsed.imageDataUrl.startsWith(`data:${document.input.image.mimeType};base64,`)) throw new Error('画像の種類と設計に保存された種類が一致しません。');
  if (image.naturalWidth !== document.input.image.widthPx || image.naturalHeight !== document.input.image.heightPx) throw new Error('保存された画像の寸法と設計が一致しません。');
  if (imageContentId(parsed.imageDataUrl) !== document.input.image.id) throw new Error('保存された画像の内容と設計ハッシュの識別情報が一致しません。');
  const backgroundImageDataUrl = parsed.version === 2 ? parsed.backgroundImageDataUrl : undefined;
  const repair = document.input.artworkRepair;
  if (repair?.mode === 'image') {
    if (!backgroundImageDataUrl) throw new Error('この設計の背景用画像がありません。元のファイルから読み込み直してください。');
    const background = await verifyDataImage(backgroundImageDataUrl);
    if (!backgroundImageDataUrl.startsWith(`data:${repair.image.mimeType};base64,`) || background.naturalWidth !== repair.image.widthPx || background.naturalHeight !== repair.image.heightPx || imageContentId(backgroundImageDataUrl) !== repair.image.id) throw new Error('背景用画像と設計に保存された情報が一致しません。');
  } else if (backgroundImageDataUrl) throw new Error('設計に使われていない背景用画像が含まれています。');
  for (const record of parsed.records) for (const photo of record.photos) await verifyDataImage(photo);
  return { document, imageDataUrl: parsed.imageDataUrl, ...(backgroundImageDataUrl ? { backgroundImageDataUrl } : {}), records: parsed.records };
}

export function serializeProject(project: Project): string {
  const parsed = parseProjectPayload({ format: 'ugoku-kami-project', version: 2, ...project });
  parseDesignDocument(parsed.document);
  const text = JSON.stringify(parsed);
  assertProjectByteLength(new TextEncoder().encode(text).byteLength);
  return text;
}

export function downloadFile(content: BlobPart, mime: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
