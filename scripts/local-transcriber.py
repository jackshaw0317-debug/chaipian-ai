from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import types
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


HOST = "127.0.0.1"
PORT = int(os.environ.get("LOCAL_TRANSCRIBER_PORT", "4318"))
MAX_AUDIO_BYTES = 24 * 1024 * 1024
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_ROOT = PROJECT_ROOT / ".local-tools" / "whisper"
MODEL_ROOT = PROJECT_ROOT / ".local-tools" / "whisper-models"
WORK_ROOT = PROJECT_ROOT / "work" / "transcriptions"
AUDIO_DECODER = PROJECT_ROOT / "scripts" / "decode-audio.mjs"
MODEL_NAME = os.environ.get("LOCAL_WHISPER_MODEL", "base")
DEVICE = os.environ.get("LOCAL_WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("LOCAL_WHISPER_COMPUTE_TYPE", "int8")
NODE_EXECUTABLE = os.environ.get("NODE_EXECUTABLE", "node")
ALLOWED_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://jackshaw.top",
    "https://www.jackshaw.top",
    "https://chaipian-ai-studio.jackshaw0317.chatgpt.site",
}

sys.path.insert(0, str(PACKAGE_ROOT))

try:
    import av  # noqa: F401
except ImportError:
    for module_name in list(sys.modules):
        if module_name == "av" or module_name.startswith("av."):
            sys.modules.pop(module_name, None)
    sys.modules["av"] = types.ModuleType("av")

try:
    from faster_whisper import WhisperModel
    import numpy as np
except ImportError as error:
    raise SystemExit(
        "本地 Whisper 组件尚未安装。请重新运行启动脚本，或在 Codex 中完成初始化。"
    ) from error


model: WhisperModel | None = None
model_lock = threading.Lock()


def read_pcm_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wav_file:
        if wav_file.getsampwidth() != 2:
            raise RuntimeError("本地解码器返回了不支持的采样位深")
        channels = wav_file.getnchannels()
        sample_rate = wav_file.getframerate()
        if channels not in {1, 2} or sample_rate != 16000:
            raise RuntimeError("本地解码器返回了不支持的音频格式")
        samples = np.frombuffer(wav_file.readframes(wav_file.getnframes()), dtype=np.int16)
    if channels == 2:
        samples = samples.reshape(-1, 2).mean(axis=1)
    return samples.astype(np.float32) / 32768.0


def decode_audio_locally(source_path: Path, job_root: Path) -> np.ndarray:
    try:
        return read_pcm_wav(source_path)
    except (wave.Error, EOFError, RuntimeError):
        decoded_path = job_root / "decoded-16k-mono.wav"
        completed = subprocess.run(
            [NODE_EXECUTABLE, str(AUDIO_DECODER), str(source_path), str(decoded_path)],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=165,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
        if completed.returncode != 0 or not decoded_path.exists():
            detail = (completed.stderr or completed.stdout or "未知错误").strip()
            raise RuntimeError(f"本地音频解码失败：{detail[-600:]}")
        return read_pcm_wav(decoded_path)


def get_model() -> WhisperModel:
    global model
    with model_lock:
        if model is None:
            MODEL_ROOT.mkdir(parents=True, exist_ok=True)
            print(f"正在加载本地 Whisper 模型：{MODEL_NAME}", flush=True)
            model = WhisperModel(
                MODEL_NAME,
                device=DEVICE,
                compute_type=COMPUTE_TYPE,
                download_root=str(MODEL_ROOT),
            )
            print("本地 Whisper 模型已就绪。", flush=True)
        return model


class Handler(BaseHTTPRequestHandler):
    server_version = "ChaipianLocalWhisper/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[Whisper] {format_string % args}", flush=True)

    def browser_origin(self) -> str:
        return self.headers.get("Origin", "").strip()

    def browser_origin_allowed(self) -> bool:
        origin = self.browser_origin()
        return not origin or origin in ALLOWED_ORIGINS

    def send_browser_access_headers(self) -> None:
        origin = self.browser_origin()
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Chaipian-Client, X-Media-Filename, X-Whisper-Language",
        )
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header(
            "Vary", "Origin, Access-Control-Request-Private-Network"
        )

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_browser_access_headers()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        if not self.browser_origin_allowed():
            self.send_json(403, {"error": "当前网页没有访问本机助手的权限。"})
            return
        self.send_response(204)
        self.send_browser_access_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if not self.browser_origin_allowed():
            self.send_json(403, {"error": "当前网页没有访问本机助手的权限。"})
            return
        if self.path != "/health":
            self.send_json(404, {"error": "接口不存在"})
            return
        self.send_json(
            200,
            {
                "ok": True,
                "service": "chaipian-local-whisper",
                "model": MODEL_NAME,
                "loaded": model is not None,
                "device": DEVICE,
            },
        )

    def do_POST(self) -> None:
        if not self.browser_origin_allowed():
            self.send_json(403, {"error": "当前网页没有访问本机助手的权限。"})
            return
        if self.path != "/transcribe":
            self.send_json(404, {"error": "接口不存在"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            self.send_json(400, {"error": "没有收到音频内容"})
            return
        if length > MAX_AUDIO_BYTES:
            self.send_json(413, {"error": "音频超过 24 MB"})
            return

        raw_filename = unquote(self.headers.get("X-Media-Filename", "audio.webm"))
        safe_filename = Path(raw_filename).name or "audio.webm"
        language = self.headers.get("X-Whisper-Language", "auto").strip().lower()
        language_value = None if language in {"", "auto"} else language
        job_root = WORK_ROOT / str(uuid.uuid4())
        audio_path = job_root / safe_filename

        try:
            job_root.mkdir(parents=True, exist_ok=True)
            audio_path.write_bytes(self.rfile.read(length))
            decoded_audio = decode_audio_locally(audio_path, job_root)
            whisper = get_model()
            segments_generator, info = whisper.transcribe(
                decoded_audio,
                language=language_value,
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=True,
            )
            segments = [
                {
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": segment.text.strip(),
                }
                for segment in segments_generator
                if segment.text.strip()
            ]
            transcript = "".join(item["text"] for item in segments).strip()
            if not transcript:
                raise RuntimeError("没有识别到清晰的人声内容")
            self.send_json(
                200,
                {
                    "text": transcript,
                    "segments": segments,
                    "language": info.language,
                    "languageProbability": info.language_probability,
                    "model": MODEL_NAME,
                },
            )
        except Exception as error:
            self.send_json(500, {"error": f"本地 Whisper 转写失败：{error}"})
        finally:
            shutil.rmtree(job_root, ignore_errors=True)


if __name__ == "__main__":
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Local Whisper ready at http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
