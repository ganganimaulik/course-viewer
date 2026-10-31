"""
Modal app that transcribes lecture audio for Course Viewer.

Runs Whisper large-v3-turbo (via faster-whisper) on a GPU. The Node server
(server.js) extracts a compressed audio track with ffmpeg and calls
Transcriber.transcribe() through the Modal JavaScript SDK.

Deploy (or redeploy after editing) with:
    modal deploy modal_transcriber.py
"""

import modal

APP_NAME = "course-viewer-transcriber"
MODEL_REPO = "dropbox-dash/faster-whisper-large-v3-turbo"
MODEL_DIR = "/model"


def download_model():
    # Bake the model weights into the image so containers start without downloading them
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_REPO, local_dir=MODEL_DIR)


image = (
    # ctranslate2 links against CUDA 12 (libcublas.so.12) and cuDNN 9.
    # PyAV 19 removed av.open(metadata_errors=...), which faster-whisper 1.2.1 still passes.
    modal.Image.from_registry("nvidia/cuda:12.9.1-cudnn-runtime-ubuntu24.04", add_python="3.12")
    .uv_pip_install("faster-whisper==1.2.1", "ctranslate2==4.8.4", "av==18.1.0", "huggingface_hub")
    .run_function(download_model)
)

app = modal.App(APP_NAME, image=image)


# GPU types are tried in order, so a capacity shortage on one type doesn't leave calls queued
@app.cls(gpu=["L4", "A10G", "T4"], cpu=4, memory=8192, timeout=60 * 60, scaledown_window=30, max_containers=5)
class Transcriber:
    @modal.enter()
    def load_model(self):
        from faster_whisper import BatchedInferencePipeline, WhisperModel

        model = WhisperModel(MODEL_DIR, device="cuda", compute_type="float16")
        self.pipeline = BatchedInferencePipeline(model=model)

    @modal.method()
    def transcribe(self, audio: bytes, language: str | None = None) -> dict:
        """Transcribe an encoded audio file (any format ffmpeg/PyAV can decode).

        Returns the detected language, the audio duration in seconds, and a list of
        sentence-level segments with start/end times in seconds.
        """
        import io

        segments, info = self.pipeline.transcribe(
            io.BytesIO(audio), language=language, batch_size=16, word_timestamps=True
        )

        # Batched segments span whole ~30s chunks; split them into sentences using word timings
        sentences = []
        for segment in segments:
            words = segment.words or []
            if not words:
                sentences.append((segment.start, segment.end, segment.text))
                continue
            current = []
            for word in words:
                current.append(word)
                if word.word.strip().endswith((".", "?", "!")) or word is words[-1]:
                    sentences.append((current[0].start, current[-1].end, "".join(w.word for w in current)))
                    current = []

        return {
            "language": info.language,
            "duration": info.duration,
            "segments": [
                {"start": round(start, 2), "end": round(end, 2), "text": text.strip()}
                for start, end, text in sentences
            ],
        }
