// useAudioRecorder.ts
//
// Thin MediaRecorder wrapper - one recording "take" per start/stop cycle,
// returning a Blob. Deliberately generic (doesn't know about the two-take
// protocol itself) - AudioRecording.tsx calls start/stop twice, once per
// take, and owns which take is which. Requesting a fresh getUserMedia
// stream per take (rather than holding one open across both takes) keeps
// this hook simple and matches how a user would naturally record two
// separate clips with pauses to review each in between.

import { useRef, useState } from 'react';

export interface UseAudioRecorderResult {
  isRecording: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<Blob>;
}

export function useAudioRecorder(): UseAudioRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  async function start(): Promise<void> {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    }
  }

  function stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        reject(new Error('not currently recording'));
        return;
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;
        setIsRecording(false);
        resolve(blob);
      };
      recorder.stop();
    });
  }

  return { isRecording, error, start, stop };
}
