"""把 TTS 返回的流式 WAV 转成体积可控的标准 WAV，并生成 voice-data.js。

处理流程：解析 RIFF -> 立体声合单声道 -> 40kHz 重采样到 16kHz -> 裁首尾静音 -> 峰值归一 -> 写标准 WAV -> base64 内嵌。

用法：
    python tools/make_voice_data.py            # 生成 voice-data.js
    python tools/make_voice_data.py --report   # 只打印每条语音的体积与时长
"""

import array
import base64
import contextlib
import os
import struct
import sys
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = os.path.join(ROOT, "local")
SRC_DIR = os.path.join(ROOT, "tools", "voice-src")

TARGET_RATE = 16000
SILENCE = 0.006          # 低于这个幅值视为静音（约 -44 dBFS）
PAD_MS = 60              # 裁切后左右各留一点余量，避免咬字被切

# 语音键 -> (源文件, 说明)
# 源文件是 TTS 原始输出（40kHz 立体声流式 WAV），*-cn.wav 是中文旧版，留作回退
VOICES = {
    "win": ("win.wav", "胜利：Beautiful! Golden watermelon!"),
    "lose": ("lose.wav", "失败：So close! One more try."),
}


def parse_riff(path):
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:4] != b"RIFF":
        raise ValueError("不是 RIFF/WAVE 文件: %s" % path)

    pos = 12
    fmt_chunk = None
    data_off, data_len = None, None
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        body = pos + 8
        if cid == b"fmt ":
            fmt_chunk = raw[body:body + size]
        elif cid == b"data":
            data_off = body
            # 流式 WAV 常把长度写成 0x3FFFFFFF，需要按实际文件长度兜底
            if size == 0 or size > len(raw) - body:
                data_len = len(raw) - body
            else:
                data_len = size
            break
        pos = body + size + (size & 1)

    if fmt_chunk is None or data_off is None:
        raise ValueError("缺少 fmt 或 data 块: %s" % path)

    tag, channels, rate, _, _, bits = struct.unpack("<HHIIHH", fmt_chunk[:16])
    return raw[data_off:data_off + data_len], channels, rate, bits


def to_mono(pcm, channels, bits):
    if bits != 16:
        raise ValueError("只处理 16bit PCM，当前 %d" % bits)
    samples = array.array("h")
    samples.frombytes(pcm[:len(pcm) - (len(pcm) % (2 * channels))])
    if channels == 1:
        return list(samples)
    out = []
    for i in range(0, len(samples), channels):
        out.append(int(sum(samples[i:i + channels]) / channels))
    return out


def resample(samples, src_rate, dst_rate):
    if src_rate == dst_rate:
        return samples
    ratio = src_rate / float(dst_rate)
    n_out = int(len(samples) / ratio)
    tail = len(samples) - 1
    out = [0] * n_out
    for i in range(n_out):
        p = i * ratio
        a = int(p)
        if a >= tail:
            out[i] = samples[tail]
            continue
        frac = p - a
        out[i] = int(samples[a] * (1.0 - frac) + samples[a + 1] * frac)
    return out


def trim_silence(samples, rate):
    peak = max(1, max(abs(v) for v in samples))
    thr = int(SILENCE * peak)
    start = 0
    while start < len(samples) and abs(samples[start]) < thr:
        start += 1
    end = len(samples) - 1
    while end > start and abs(samples[end]) < thr:
        end -= 1
    pad = int(rate * PAD_MS / 1000.0)
    return samples[max(0, start - pad):min(len(samples), end + pad)]


def normalize(samples, target_peak=0.89):
    peak = max(1, max(abs(v) for v in samples))
    scale = (target_peak * 32767.0) / peak
    return [int(max(-32768, min(32767, v * scale))) for v in samples]


def write_wav(dst, samples, rate):
    samples = normalize(samples)
    data = array.array("h", samples)
    buf = __import__("io").BytesIO()
    with contextlib.closing(wave.open(buf, "wb")) as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(data.tobytes())
    with open(dst, "wb") as f:
        f.write(buf.getvalue())
    return len(buf.getvalue())


def main():
    report_only = "--report" in sys.argv
    entries = []
    for key, (src_name, note) in VOICES.items():
        src = os.path.join(SRC_DIR, src_name)
        if not os.path.exists(src):
            print("跳过（缺文件）: %s" % src)
            continue

        pcm, channels, rate, bits = parse_riff(src)
        mono = to_mono(pcm, channels, bits)
        mono = resample(mono, rate, TARGET_RATE)
        mono = trim_silence(mono, TARGET_RATE)

        dst = os.path.join(SRC_DIR, "trimmed-%s.wav" % key)
        size = write_wav(dst, mono, TARGET_RATE)
        dur = len(mono) / float(TARGET_RATE)

        with open(dst, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")

        entries.append((key, b64))
        print("%-5s %7d B  时长 %.2fs  base64 %d B  （%s）" % (key, size, dur, len(b64), note))

    if report_only or not entries:
        return

    out_path = os.path.join(LOCAL, "js", "voice-data.js")
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* 人声播报：由 TTS 生成后重采样为 16kHz 单声道 WAV，base64 内嵌。 */\n")
        f.write("var VOICE_DATA = {\n")
        for key, b64 in entries:
            f.write('  "%s": "data:audio/wav;base64,%s",\n' % (key, b64))
        f.write("};\n")

    print("写入 %s（%d B）" % (out_path, os.path.getsize(out_path)))


if __name__ == "__main__":
    main()
