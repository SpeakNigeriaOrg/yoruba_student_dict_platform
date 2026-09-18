# Replaces diffusers.utils.export_utils.encode_video, which this package
# used at first - it works, but it is not a compression POLICY, it is
# whatever libx264/AAC do with zero options set (add_stream("libx264",
# rate=fps) and add_stream("aac", rate=...), no crf/tune/bitrate anywhere
# in that function - see its source). Measured on a real accepted clip
# (bench_minimax_bounce.mp4, MiniMax H3, 512x512, 5s, genuine motion, this
# session): that default path produced 236kb/s video + 127kb/s stereo AAC
# audio at whatever quality libx264/AAC's own internal defaults land on -
# audio alone was ~35% of the file for what is simple ambient/SFX content,
# not dialogue or music.
#
# This module picks real numbers instead, tested against that same clip:
#
#   ffmpeg -i bench_minimax_bounce.mp4 -c:v libx264 -crf N -tune animation
#     -preset slow -pix_fmt yuv420p -c:a aac -b:a 48k -ac 1 out.mp4
#
#   crf=23 -> 181KB   crf=28 -> 118KB   crf=32 -> 90KB   crf=36 -> 75KB
#   (original, no policy: 241KB)
#
# crf=28 and crf=32 were both visually clean on this clip (flat colour,
# bold outlines, no banding or blocking at either, checked frame-by-frame)
# - unsurprising for content deliberately designed to compress well (see
# styles.py's own review_rubric on why busy/noisy motion is rejected at
# review time, not just a nice-to-have). CRF_VIDEO settles on 30, the
# midpoint of the two clean values, rather than either tested extreme -
# margin for words with more visual complexity than a red ball or a
# lizard, which this one clip can't speak to. `tune=animation` is x264's
# own preset for flat-colour/clean-edge content - built for exactly this
# style, not a generic choice. `preset=slow` costs real CPU-encode time
# for better compression at the same CRF, which is free to spend here:
# encoding one clip takes low single-digit seconds against ~500s of GPU
# generation time for the same clip.
#
# Audio: MiniMax-H3 always generates it whether requested or not (jointly
# denoised in the same packed sequence as the video - see generate.py) and
# it is kept, not discarded (an earlier version of this code dropped it on
# the assumption the game would only ever play these muted - reverted:
# the video branch of the game has never been deployed, so there was no
# real basis for treating "always muted" as settled). AAC_BITRATE=48k
# mono is deliberately much lower than AAC's own default (measured 127k
# stereo on the same clip) - simple ambient/SFX audio, not dialogue or
# music, doesn't need stereo separation or a music-grade bitrate, and the
# 48k/mono choice was the one actually tested above, not assumed.
import av

CRF_VIDEO = 30
X264_PRESET = "slow"
X264_TUNE = "animation"
AAC_BITRATE = 48_000
AUDIO_CHANNELS = 1  # mono - see module docstring


def encode_video(video, fps: int, output_path: str, audio=None, audio_sample_rate: int | None = None) -> None:
    """Same call shape as diffusers.utils.export_utils.encode_video (video
    frames uint8 [0,255] or a normalized-[0,1] array, `audio` a
    `(channels, num_samples)` waveform) - drop-in replacement, not a
    different interface, so this can be swapped back if the policy above
    ever needs revisiting."""
    import numpy as np
    import torch

    if isinstance(video, list):
        video = np.stack([np.array(f) for f in video], axis=0)
    if isinstance(video, np.ndarray):
        is_normalized = np.logical_and(np.zeros_like(video) <= video, video <= np.ones_like(video)).all()
        if is_normalized:
            video = (video * 255).round().astype("uint8")
        video = torch.from_numpy(video)

    _, height, width, _ = video.shape

    container = av.open(output_path, mode="w")
    stream = container.add_stream("libx264", rate=int(fps))
    stream.width = width
    stream.height = height
    stream.pix_fmt = "yuv420p"
    stream.options = {"crf": str(CRF_VIDEO), "preset": X264_PRESET, "tune": X264_TUNE}

    audio_stream = None
    if audio is not None:
        if audio_sample_rate is None:
            raise ValueError("audio_sample_rate is required when audio is provided")
        audio_stream = container.add_stream("aac", rate=audio_sample_rate)
        audio_stream.codec_context.sample_rate = audio_sample_rate
        audio_stream.codec_context.layout = "mono" if AUDIO_CHANNELS == 1 else "stereo"
        audio_stream.codec_context.bit_rate = AAC_BITRATE

    for frame_array in video.cpu().numpy():
        frame = av.VideoFrame.from_ndarray(frame_array, format="rgb24")
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)

    if audio is not None:
        if audio.ndim == 1:
            audio = audio[None, :]
        if AUDIO_CHANNELS == 1 and audio.shape[0] > 1:
            # Downmix rather than just taking one channel - MiniMax-H3's
            # audio is generated stereo; averaging keeps both channels'
            # content instead of silently dropping one of them.
            audio = audio.mean(dim=0, keepdim=True)
        samples = torch.clip(audio, -1.0, 1.0)
        samples = (samples * 32767.0).to(torch.int16).cpu().numpy()
        resampler = av.audio.resampler.AudioResampler(
            format=audio_stream.codec_context.format or "fltp",
            layout=audio_stream.codec_context.layout or "mono",
            rate=audio_sample_rate,
        )
        audio_frame = av.AudioFrame.from_ndarray(samples, format="s16", layout="mono" if AUDIO_CHANNELS == 1 else "stereo")
        audio_frame.sample_rate = audio_sample_rate
        for resampled in resampler.resample(audio_frame):
            for packet in audio_stream.encode(resampled):
                container.mux(packet)
        for packet in audio_stream.encode():
            container.mux(packet)

    container.close()
