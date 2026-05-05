export function mimeTypeToExtension(mimeType: string): string {
  if (mimeType.includes('mp4')) {
    return mimeType.startsWith('video/') ? 'mp4' : 'm4a';
  }

  if (mimeType.includes('quicktime')) {
    return 'mov';
  }

  if (mimeType.includes('ogg')) {
    return 'ogg';
  }

  if (mimeType.includes('wav')) {
    return 'wav';
  }

  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
    return 'mp3';
  }

  return 'webm';
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
