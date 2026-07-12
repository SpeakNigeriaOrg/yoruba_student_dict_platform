import { describe, expect, it } from 'vitest';
import { encodeWavFromPCM, sliceAndEncodeWav } from './encodeWav.js';

async function readHeaderFields(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const decoder = new TextDecoder('ascii');
  return {
    riff: decoder.decode(new Uint8Array(buffer, 0, 4)),
    wave: decoder.decode(new Uint8Array(buffer, 8, 4)),
    fmtTag: decoder.decode(new Uint8Array(buffer, 12, 4)),
    audioFormat: view.getUint16(20, true),
    numChannels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataTag: decoder.decode(new Uint8Array(buffer, 36, 4)),
    dataSize: view.getUint32(40, true),
    view,
  };
}

describe('encodeWavFromPCM', () => {
  it('writes a valid mono 16-bit PCM WAV header', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWavFromPCM(samples, 16000);

    const header = await readHeaderFields(blob);
    expect(header.riff).toBe('RIFF');
    expect(header.wave).toBe('WAVE');
    expect(header.fmtTag).toBe('fmt ');
    expect(header.audioFormat).toBe(1);
    expect(header.numChannels).toBe(1);
    expect(header.sampleRate).toBe(16000);
    expect(header.bitsPerSample).toBe(16);
    expect(header.dataTag).toBe('data');
    expect(header.dataSize).toBe(samples.length * 2);
    expect(blob.size).toBe(44 + samples.length * 2);
  });

  it('round-trips sample values through 16-bit quantization within tolerance', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWavFromPCM(samples, 8000);
    const { view } = await readHeaderFields(blob);

    const decoded = samples.map((_, i) => view.getInt16(44 + i * 2, true) / 0x8000);
    for (let i = 0; i < samples.length; i++) {
      expect(decoded[i]).toBeCloseTo(samples[i], 3);
    }
  });

  it('clamps out-of-range samples instead of wrapping', async () => {
    const samples = new Float32Array([1.5, -1.5]);
    const blob = encodeWavFromPCM(samples, 8000);
    const { view } = await readHeaderFields(blob);

    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});

describe('sliceAndEncodeWav', () => {
  it('encodes only the requested time range', async () => {
    // 1 sample per millisecond at this rate, for an easy-to-reason-about slice.
    const sampleRate = 1000;
    const samples = new Float32Array(10);
    for (let i = 0; i < samples.length; i++) samples[i] = i / 10;

    const blob = sliceAndEncodeWav(samples, sampleRate, 0.002, 0.005);
    const header = await readHeaderFields(blob);

    // [0.002s, 0.005s) at 1000Hz = samples [2, 5) = 3 samples.
    expect(header.dataSize).toBe(3 * 2);
    expect(header.view.getInt16(44, true) / 0x8000).toBeCloseTo(samples[2], 3);
  });

  it('clamps a slice range that runs past the end of the buffer', async () => {
    const sampleRate = 1000;
    const samples = new Float32Array(5).fill(0.5);

    const blob = sliceAndEncodeWav(samples, sampleRate, 0.001, 10);
    const header = await readHeaderFields(blob);

    expect(header.dataSize).toBe(4 * 2); // samples [1, 5)
  });
});
