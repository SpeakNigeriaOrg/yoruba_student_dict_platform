import { describe, expect, it } from 'vitest';
import { detectAudioContainer, isPcmWave } from './audioContainer.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('audio container inspection', () => {
  it('recognizes supported containers by bytes', () => {
    expect(detectAudioContainer(bytes('RIFF0000WAVE'))?.container).toBe('wav');
    expect(detectAudioContainer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))?.container).toBe('webm');
    expect(detectAudioContainer(bytes('OggS'))?.container).toBe('ogg');
    expect(detectAudioContainer(bytes('0000ftypM4A '))?.container).toBe('mp4');
    expect(detectAudioContainer(bytes('not audio'))).toBeNull();
  });

  it('requires PCM format inside a delivery WAV', () => {
    const wav = new Uint8Array(36);
    wav.set(bytes('RIFF'), 0); wav.set(bytes('WAVE'), 8); wav.set(bytes('fmt '), 12);
    wav[16] = 16; wav[20] = 1;
    expect(isPcmWave(wav)).toBe(true);
    wav[20] = 3;
    expect(isPcmWave(wav)).toBe(false);
  });
});
