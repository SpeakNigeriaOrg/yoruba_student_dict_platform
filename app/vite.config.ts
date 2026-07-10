import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node', // the audio-segmentation core is pure PCM math, no DOM/AudioContext needed to test it
  },
});
