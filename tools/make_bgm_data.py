# -*- coding: utf-8 -*-
"""
把生成的 BGM 原始 WAV 压成可直接内嵌的小体积单声道 WAV，并写成 bgm-data.js。

做的事：
1. 解析 RIFF，跳过 AIGC 等附加块，只取 data
2. 立体声合单声道
3. 先做轻量抗锯齿平滑，再线性插值重采样到 16kHz
4. 首尾交叉淡化，消除循环接缝
5. 峰值归一
6. 写成标准 44 字节头的 WAV，base64 内嵌进 local/js/bgm-data.js

用法：
    python tools/make_bgm_data.py            # 生成 bgm-data.js
    python tools/make_bgm_data.py --report   # 只打印参数，不写文件
"""
import base64
import os
import struct
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "voice-src", "bgm-raw.wav")
OUT_JS = os.path.join(ROOT, "local", "js", "bgm-data.js")

TARGET_RATE = 16000          # 音乐用 16k：低频主导，体积可控
XFADE_SEC = 0.45             # 循环交叉淡化时长
PEAK = 0.86                  # 归一化目标峰值


def read_riff(path):
    """返回 (采样数据 float64 单声道, 原采样率)"""
    raw = open(path, "rb").read()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise SystemExit("不是 RIFF/WAVE 文件")

    fmt = None
    data = None
    pos = 12
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        body_at = pos + 8
        if cid == b"fmt ":
            tag, ch, rate, byte_rate, block_align, bits = struct.unpack(
                "<HHIIHH", raw[body_at:body_at + 16])
            fmt = dict(tag=tag, ch=ch, rate=rate, bits=bits)
        elif cid == b"data":
            # 流式 WAV 会把长度写成 0xFFFFFFFF 之类，按剩余字节兜底
            room = len(raw) - body_at
            real = size if size <= room and size > 0 else room
            data = raw[body_at:body_at + real]
            break
        pos = body_at + size + (size & 1)

    if fmt is None or data is None:
        raise SystemExit("没找到 fmt / data 块")
    if fmt["tag"] != 1 or fmt["bits"] != 16:
        raise SystemExit("只支持 16bit PCM，实际 tag=%s bits=%s" % (fmt["tag"], fmt["bits"]))

    samples = np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0
    ch = fmt["ch"]
    if ch > 1:
        usable = (len(samples) // ch) * ch
        samples = samples[:usable].reshape(-1, ch).mean(axis=1)
    return samples, fmt["rate"]


def resample(x, src_rate, dst_rate):
    """先加权平滑压掉高频，再线性插值。不依赖 scipy。"""
    if src_rate == dst_rate:
        return x.copy()
    if src_rate > dst_rate:
        # 4 点加权平滑 [1,2,2,1]/6，削掉重采样前的锯齿能量
        k = np.array([1.0, 2.0, 2.0, 1.0]) / 6.0
        x = np.convolve(x, k, mode="same")
    n_out = int(round(len(x) * dst_rate / float(src_rate)))
    t_out = np.arange(n_out) * (src_rate / float(dst_rate))
    return np.interp(t_out, np.arange(len(x)), x)


def seamless(x, rate, sec):
    """把末尾一段淡入叠到开头，再裁掉末尾，循环点就接得上"""
    n = len(x)
    k = int(rate * sec)
    if k <= 0 or k * 2 >= n:
        return x
    fade = np.linspace(0.0, 1.0, k)
    head = x[:k].copy()
    tail = x[n - k:].copy()
    x = x.copy()
    x[:k] = head * fade + tail * (1.0 - fade)
    return x[:n - k]


def write_wav(path, x, rate):
    pcm = np.clip(np.round(x * 32767.0), -32768, 32767).astype("<i2")
    data = pcm.tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(data))
    open(path, "wb").write(header + data)


def main():
    report_only = "--report" in sys.argv

    x, rate = read_riff(SRC)
    print("原始: %.2f 秒, %d Hz, 峰值 %.3f" % (len(x) / float(rate), rate, np.abs(x).max()))

    x = resample(x, rate, TARGET_RATE)
    print("重采样后: %.2f 秒, %d Hz" % (len(x) / float(TARGET_RATE), TARGET_RATE))

    x = seamless(x, TARGET_RATE, XFADE_SEC)
    print("无缝循环裁切后: %.2f 秒" % (len(x) / float(TARGET_RATE)))

    peak = np.abs(x).max()
    if peak > 1e-6:
        x = x * (PEAK / peak)
    print("归一后峰值: %.3f" % np.abs(x).max())

    tmp = os.path.join(ROOT, "tools", "voice-src", "bgm-16k.wav")
    write_wav(tmp, x, TARGET_RATE)
    size = os.path.getsize(tmp)
    print("中间文件: %s (%d 字节)" % (tmp, size))

    if report_only:
        print("--report 模式，不写 bgm-data.js")
        return

    b64 = base64.b64encode(open(tmp, "rb").read()).decode("ascii")
    js = (
        "/* 背景音乐：AI 生成，无第三方版权；%d Hz 单声道，首尾交叉淡化可无缝循环 */\n"
        "window.BGM_DATA = {\n"
        "  music: \"data:audio/wav;base64,%s\"\n"
        "};\n"
    ) % (TARGET_RATE, b64)
    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write(js)
    print("已写入 %s (%d 字节)" % (OUT_JS, os.path.getsize(OUT_JS)))


if __name__ == "__main__":
    main()
