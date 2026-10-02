// Getting picked files ready to upload (EX-4): size limits and HEIC → JPEG.

import { MAX_BYTES, UploadFile, WARN_BYTES, evidencePath, kindOf } from './evidence';

export interface Prepared {
  uploads: UploadFile[];
  warnings: string[];
  /** Files that can't be uploaded at all (too big, wrong type). */
  rejected: string[];
}

export function checkFile(file: { name: string; type: string; size: number }): 'ok' | 'large' | 'too-large' | 'unsupported' {
  if (kindOf(file.type, file.name) === 'other') return 'unsupported';
  if (file.size > MAX_BYTES) return 'too-large';
  if (file.size > WARN_BYTES) return 'large';
  return 'ok';
}

/** iPhone photos arrive as HEIC, which GitHub can't show. Convert where the browser can decode it. */
async function heicToJpeg(file: File): Promise<File | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    return blob ? new File([blob], file.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' }) : null;
  } catch {
    return null;
  }
}

export async function prepareFiles(files: File[], issue: number, platform: string, at: Date): Promise<Prepared> {
  const uploads: UploadFile[] = [];
  const warnings: string[] = [];
  const rejected: string[] = [];
  for (const original of files) {
    let file = original;
    if (/\.heic$/i.test(file.name) || file.type === 'image/heic') {
      const jpeg = await heicToJpeg(file);
      if (jpeg) file = jpeg;
      else warnings.push(`${file.name} is HEIC and this browser can't convert it, so it may not preview on GitHub.`);
    }
    const check = checkFile(file);
    if (check === 'unsupported') {
      rejected.push(`${file.name}: only images and videos can be attached.`);
      continue;
    }
    if (check === 'too-large') {
      rejected.push(`${file.name} is over 100 MB, GitHub's limit. Trim or compress it first.`);
      continue;
    }
    if (check === 'large') warnings.push(`${file.name} is over 25 MB; consider compressing it.`);
    uploads.push({
      path: evidencePath(issue, platform, uploads.length, file.name, at),
      name: file.name,
      type: file.type || 'application/octet-stream',
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return { uploads, warnings, rejected };
}
