export type SupportedAudioContainer = 'wav' | 'webm' | 'ogg' | 'mp4';

export interface DetectedAudioContainer {
  container: SupportedAudioContainer;
  mediaType: string;
  extension: string;
}

/** Byte signatures, not caller-supplied MIME labels. Codec verification happens while decoding. */
export function detectAudioContainer(bytes: Uint8Array): DetectedAudioContainer | null {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    return { container: 'wav', mediaType: 'audio/wav', extension: 'wav' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { container: 'webm', mediaType: 'audio/webm', extension: 'webm' };
  }
  if (bytes.length >= 4 && ascii(0, 4) === 'OggS') {
    return { container: 'ogg', mediaType: 'audio/ogg', extension: 'ogg' };
  }
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp') {
    return { container: 'mp4', mediaType: 'audio/mp4', extension: 'm4a' };
  }
  return null;
}

export function isPcmWave(bytes: Uint8Array): boolean {
  if (detectAudioContainer(bytes)?.container !== 'wav') return false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    if (id === 'fmt ' && offset + 10 <= bytes.length) {
      return (bytes[offset + 8] | (bytes[offset + 9] << 8)) === 1;
    }
    if (size < 0) return false;
    offset += 8 + size + (size % 2);
  }
  return false;
}
