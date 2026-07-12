// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAudioRecorder } from './useAudioRecorder.js';

class FakeMediaRecorder {
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream) {}
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(['chunk-a']) });
    this.ondataavailable?.({ data: new Blob(['chunk-b']) });
    this.onstop?.();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useAudioRecorder', () => {
  it('starts recording, requesting a microphone stream', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [] });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);

    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await result.current.start();
    });

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    await waitFor(() => expect(result.current.isRecording).toBe(true));
  });

  it('stops recording and resolves a Blob built from every ondataavailable chunk', async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) },
      configurable: true,
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);

    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await result.current.start();
    });

    let blob: Blob | undefined;
    await act(async () => {
      blob = await result.current.stop();
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.size).toBeGreaterThan(0);
    expect(stopTrack).toHaveBeenCalled(); // the mic stream is released once stopped
    expect(result.current.isRecording).toBe(false);
  });

  it('sets an error and rejects when getUserMedia is denied', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('mic denied')) },
      configurable: true,
    });

    const { result } = renderHook(() => useAudioRecorder());
    let caught: unknown;
    // Catches inside the act() callback (rather than letting act() itself
    // reject) so React still flushes the setError state update that
    // happens right before the rethrow - act() abandoning mid-flush on a
    // rejected callback is what left `error` unset when this was written
    // the other way.
    await act(async () => {
      try {
        await result.current.start();
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('mic denied');
    await waitFor(() => expect(result.current.error).toBe('mic denied'));
    expect(result.current.isRecording).toBe(false);
  });

  it('rejects stop() when called with no active recording', async () => {
    const { result } = renderHook(() => useAudioRecorder());
    await expect(result.current.stop()).rejects.toThrow('not currently recording');
  });
});
