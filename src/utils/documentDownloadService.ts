import { Summon } from '../types';

export interface DownloadImageResult {
  success: boolean;
  fileName: string;
  isOriginal: boolean;
  error?: string;
}

/**
 * Clean and format a filename component safely
 */
export function sanitizeFileName(str: string): string {
  return str
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

/**
 * Extracts file extension and mime type from a data URL or filename
 */
export function getImageFormatInfo(url: string, fallbackFileName?: string): { ext: string; mimeType: string } {
  if (url.startsWith('data:image/png')) {
    return { ext: 'png', mimeType: 'image/png' };
  }
  if (url.startsWith('data:image/webp')) {
    return { ext: 'webp', mimeType: 'image/webp' };
  }
  if (url.startsWith('data:image/jpeg') || url.startsWith('data:image/jpg')) {
    return { ext: 'jpg', mimeType: 'image/jpeg' };
  }

  if (fallbackFileName) {
    const match = fallbackFileName.match(/\.([a-zA-Z0-9]+)$/);
    if (match) {
      const ext = match[1].toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return { ext, mimeType: mime };
    }
  }

  // Detect extension from URL path if present
  try {
    const pathname = new URL(url, window.location.href).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (match) {
      const ext = match[1].toLowerCase();
      if (['jpg', 'jpeg', 'png', 'webp', 'svg'].includes(ext)) {
        const normalizedExt = ext === 'jpeg' ? 'jpg' : ext;
        const mime = normalizedExt === 'png' ? 'image/png' : normalizedExt === 'webp' ? 'image/webp' : 'image/jpeg';
        return { ext: normalizedExt, mimeType: mime };
      }
    }
  } catch (_) {}

  return { ext: 'jpg', mimeType: 'image/jpeg' };
}

/**
 * Downloads the exact original photo or scanned document of a summon
 */
export async function downloadSummonImage(
  summon: Summon,
  options: {
    preferOriginal?: boolean;
    forceOriginal?: boolean;
    isViewingOriginal?: boolean;
  } = {}
): Promise<DownloadImageResult> {
  const { preferOriginal = true, forceOriginal = false, isViewingOriginal = false } = options;

  // Select target URL
  let targetUrl: string | undefined;
  let isOriginal = false;

  if (forceOriginal) {
    targetUrl = summon.originalImageUrl || summon.imageUrl;
    isOriginal = !!(summon.originalImageUrl || summon.imageUrl);
  } else if (isViewingOriginal) {
    targetUrl = summon.originalImageUrl || summon.imageUrl;
    isOriginal = !!summon.originalImageUrl;
  } else if (preferOriginal && summon.originalImageUrl) {
    targetUrl = summon.originalImageUrl;
    isOriginal = true;
  } else {
    targetUrl = summon.imageUrl || summon.originalImageUrl;
    isOriginal = !summon.imageUrl && !!summon.originalImageUrl;
  }

  if (!targetUrl) {
    throw new Error('No summons document image found for this docket.');
  }

  // Construct official, structured filename
  const cleanSummonNo = sanitizeFileName(summon.summonNumber || 'Summon');
  const cleanCaseNo = sanitizeFileName(summon.caseNumber || '');
  const formatInfo = getImageFormatInfo(targetUrl, summon.fileName);
  const suffix = isOriginal ? 'Original' : 'Scanned_Doc';

  let downloadFileName = `Summons_${cleanSummonNo}`;
  if (cleanCaseNo && cleanCaseNo !== cleanSummonNo) {
    downloadFileName += `_${cleanCaseNo}`;
  }
  downloadFileName += `_${suffix}.${formatInfo.ext}`;

  // If user uploaded a specific named image file and we are downloading original, keep name context
  if (isOriginal && summon.fileName && !summon.fileName.toLowerCase().endsWith('.pdf')) {
    const baseName = sanitizeFileName(summon.fileName.replace(/\.[^/.]+$/, ''));
    if (baseName && baseName.length > 2) {
      downloadFileName = `${baseName}_Original.${formatInfo.ext}`;
    }
  }

  let blobUrl = '';
  let shouldRevoke = false;

  try {
    if (targetUrl.startsWith('data:')) {
      // Base64 to direct binary Blob
      const [header, base64Data] = targetUrl.split(',');
      const matchMime = header.match(/:(.*?);/);
      const mime = matchMime ? matchMime[1] : formatInfo.mimeType;
      
      const byteCharacters = atob(base64Data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: mime });
      blobUrl = URL.createObjectURL(blob);
      shouldRevoke = true;
    } else if (targetUrl.startsWith('blob:')) {
      blobUrl = targetUrl;
    } else {
      // Remote Cloud / Server URL -> fetch as Blob to enforce explicit file download attribute
      try {
        const response = await fetch(targetUrl, { mode: 'cors' });
        if (!response.ok) throw new Error(`HTTP fetch failed with status ${response.status}`);
        const blob = await response.blob();
        blobUrl = URL.createObjectURL(blob);
        shouldRevoke = true;
      } catch (fetchErr) {
        console.warn('[DownloadService] Direct fetch CORS fallback, attempting download trigger:', fetchErr);
        blobUrl = targetUrl;
      }
    }

    // Trigger anchor download
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = downloadFileName;
    link.style.display = 'none';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (shouldRevoke) {
      setTimeout(() => {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch (_) {}
      }, 45000);
    }

    return {
      success: true,
      fileName: downloadFileName,
      isOriginal,
    };
  } catch (err: any) {
    if (shouldRevoke && blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch (_) {}
    }
    throw new Error(err.message || 'Failed to download original document image.');
  }
}
