# -*- coding: utf-8 -*-
"""
风铃声音变奏（纯标准库，零额外依赖）
======================================
把单个 wav 样本转成一个「每次都不一样」的变奏池：

- 音高抖动：重采样 ±2 半音，像每一次敲击的力度和位置都略有不同
- 音量抖动：0.75~0.98 随机，轻重不一
- 并联激励：混入一小部分差分信号，增强中高频泛音的存在感
- 合成泛音层：在录音自带的非谐波泛音位置（约 1.5x/2.0x/2.7x 基频）叠加
  短衰减正弦，每次响的亮暗随机——有的响亮、有的响闷，像真实风铃
  不同位置被敲到的差别
- 尾部淡出：20ms 线性淡出，避免截断咔哒声

格式约束：输入必须是 44100Hz / 16bit / 单声道 wav（现有风铃资源满足）。
"""

import io
import math
import random
import struct
import wave

PCM_RATE = 44100
PCM_WIDTH = 2
PCM_CHANNELS = 1

DEFAULT_PITCH_RANGE = (-2.0, 2.0)   # 半音
DEFAULT_VOLUME_RANGE = (0.75, 0.98)
DEFAULT_EXCITE_RANGE = (0.12, 0.25)  # 差分信号混入比例（降半，避免提亮素材自带高频气流丝声）
OVERTONE_RATIOS = (1.5, 2.0, 2.7)    # 非谐波泛音位置（相对基频），与录音自带泛音列对齐
DEFAULT_OVERTONE_MAX = 0.12          # 单个泛音相对峰值幅度的最大强度


def load_pcm(path):
    """读取 wav，返回 (int16 采样列表, 采样率)。"""
    with wave.open(path, "rb") as w:
        if w.getnchannels() != PCM_CHANNELS or w.getsampwidth() != PCM_WIDTH:
            raise ValueError("风铃 wav 必须是 16bit 单声道")
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    return list(struct.unpack("<%dh" % (len(frames) // PCM_WIDTH), frames)), rate


def pack_wav(samples, rate=PCM_RATE):
    """把 int 采样列表打包成完整 wav bytes。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(PCM_CHANNELS)
        w.setsampwidth(PCM_WIDTH)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % len(samples), *samples))
    return buf.getvalue()


def scale_wav_volume(data, volume):
    """按主音量缩放完整 wav bytes，返回可供 winsound 内存播放的新 wav。"""
    volume = max(0.0, min(float(volume), 1.0))
    if volume >= 1.0:
        return data
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getnchannels() != PCM_CHANNELS or w.getsampwidth() != PCM_WIDTH:
            raise ValueError("风铃 wav 必须是 16bit 单声道")
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    samples = struct.unpack("<%dh" % (len(frames) // PCM_WIDTH), frames)
    scaled = [int(round(sample * volume)) for sample in samples]
    return pack_wav(scaled, rate)


def _hann(n):
    return [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) for i in range(n)]


def estimate_base_freq(samples, rate, fmin=600.0, fmax=5000.0, coarse=80):
    """估计主频：过零率定心 + 加窗 Goertzel 扫描 + 抛物线插值 + 谐波回溯。

    粗扫网格必须贴着主峰，否则窄主峰会落在网格缝隙里被漏掉；
    回溯保证找到的是基频而不是它的 2x/1.5x 泛音。
    """
    seg = samples[: max(int(rate * 0.12), 64)]
    n = len(seg)
    win = _hann(n)
    seg_w = [seg[i] * win[i] for i in range(n)]

    def goertzel(f):
        omega = 2.0 * math.pi * f / rate
        coeff = 2.0 * math.cos(omega)
        s0 = s1 = s2 = 0.0
        for x in seg_w:
            s0 = x + coeff * s1 - s2
            s2, s1 = s1, s0
        return s1 * s1 + s2 * s2 - coeff * s1 * s2

    crossings = sum(1 for i in range(1, n) if (seg[i] >= 0) != (seg[i - 1] >= 0))
    zcr_freq = crossings * rate / (2.0 * n)
    center = max(fmin, min(fmax, zcr_freq))
    lo = max(fmin, center * 0.5)
    hi = min(fmax, center * 1.6)

    best_k, best_e = 0, -1.0
    for k in range(coarse):
        f = lo * (hi / lo) ** (k / (coarse - 1))
        e = goertzel(f)
        if e > best_e:
            best_e, best_k = e, k

    # 对数轴抛物线插值，把峰位定到网格之间。
    ratio = (hi / lo) ** (1.0 / (coarse - 1))
    if 0 < best_k < coarse - 1:
        e0 = goertzel(lo * ratio ** (best_k - 1))
        e2 = goertzel(lo * ratio ** (best_k + 1))
        denom = e0 - 2.0 * best_e + e2
        if abs(denom) > 1e-12:
            k_peak = best_k + 0.5 * (e0 - e2) / denom
            best_f = lo * ratio ** max(0.0, k_peak)
        else:
            best_f = lo * ratio ** best_k
    else:
        best_f = lo * ratio ** best_k

    # 谐波回溯：如果低倍频处能量仍然可观，说明刚才踩到的是泛音。
    for div in (2.0, 1.5, 2.7):
        cand = best_f / div
        if cand >= fmin and goertzel(cand) >= best_e * 0.35:
            best_f = cand
    return best_f


def _resample_linear(samples, ratio):
    """线性插值重采样。ratio>1 音高升高（时长变短），<1 音高降低。"""
    n = len(samples)
    out_len = min(int(n / ratio), n)
    out = [0.0] * out_len
    for i in range(out_len):
        pos = i * ratio
        j = int(pos)
        frac = pos - j
        j2 = j + 1 if j + 1 < n else j
        out[i] = samples[j] * (1.0 - frac) + samples[j2] * frac
    return out


def _add_overtones(out, rate, base_freq, strengths, decay, peak, rng):
    """叠加短衰减的合成泛音；strengths 为相对峰值幅度的强度列表。"""
    n = len(out)
    for ratio_f, strength in zip(OVERTONE_RATIOS, strengths):
        if strength <= 0.0:
            continue
        amp = strength * peak
        omega = 2.0 * math.pi * base_freq * ratio_f / rate
        phase = rng.uniform(0.0, 2.0 * math.pi)
        env_decay = 1.0 / (decay * rate)
        for i in range(n):
            out[i] += amp * math.exp(-i * env_decay) * math.sin(omega * i + phase)


def build_variant(samples, rate, semitone, volume, excite, base_freq, rng, overtone_max=DEFAULT_OVERTONE_MAX):
    """生成一个变体，返回完整 wav bytes。rng 必须是 random.Random 实例。"""
    ratio = 2.0 ** (semitone / 12.0)
    out = _resample_linear(samples, ratio)
    n = len(out)

    # 合成泛音层：每次随机亮暗，至少保留一个泛音有点存在感。
    peak = max(abs(s) for s in samples) or 1.0
    strengths = [rng.uniform(0.0, overtone_max) for _ in OVERTONE_RATIOS]
    if max(strengths) < overtone_max * 0.5:
        strengths[rng.randrange(len(strengths))] = rng.uniform(
            overtone_max * 0.5, overtone_max
        )
    decay = rng.uniform(0.12, 0.28)
    _add_overtones(out, rate, base_freq * ratio, strengths, decay, peak, rng)

    # 并联激励提亮中高频泛音；同时乘音量并做尾部淡出。
    fade = max(int(rate * 0.02), 1)
    prev = 0.0
    for i in range(n):
        x = out[i]
        v = x + excite * (x - prev)
        prev = x
        if i >= n - fade:
            v *= (n - i) / fade
        out[i] = v * volume

    clipped = [max(-32768, min(32767, int(round(v)))) for v in out]
    return pack_wav(clipped, rate)


def build_variant_pool(
    path,
    count=8,
    pitch_range=DEFAULT_PITCH_RANGE,
    volume_range=DEFAULT_VOLUME_RANGE,
    excite_range=DEFAULT_EXCITE_RANGE,
    overtone_max=DEFAULT_OVERTONE_MAX,
    rng=None,
):
    """为单个 wav 生成一个变奏池。rng 可传入固定种子的 random.Random 便于测试。"""
    samples, rate = load_pcm(path)
    base_freq = estimate_base_freq(samples, rate)
    rng = rng or random.Random()
    pool = []
    for _ in range(count):
        semitone = rng.uniform(*pitch_range)
        volume = rng.uniform(*volume_range)
        excite = rng.uniform(*excite_range)
        pool.append(
            build_variant(
                samples, rate, semitone, volume, excite, base_freq, rng, overtone_max
            )
        )
    return pool


def highpass_filter(samples, rate, cutoff=400.0, q=0.7071):
    """二阶 Butterworth 高通：滤掉录音里低频气流声/风声，保留清脆铃声。

    多铃实录常有持续的环境风声（能量集中在 100~300Hz，比铃声主体低 3 个
    数量级以上）。风铃音高在 1k~2.5k，400Hz 截止不会伤铃声；
    双线性变换系数来自 RBJ Audio EQ Cookbook 的 highpass。
    """
    w0 = 2.0 * math.pi * cutoff / rate
    alpha = math.sin(w0) / (2.0 * q)
    cosw0 = math.cos(w0)
    b0 = (1.0 + cosw0) / 2.0
    b1 = -(1.0 + cosw0)
    b2 = (1.0 + cosw0) / 2.0
    a0 = 1.0 + alpha
    a1 = -2.0 * cosw0
    a2 = 1.0 - alpha
    b0 /= a0
    b1 /= a0
    b2 /= a0
    a1 /= a0
    a2 /= a0
    x1 = x2 = y1 = y2 = 0.0
    out = [0] * len(samples)
    for i, x in enumerate(samples):
        y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, float(x)
        y2, y1 = y1, y
        out[i] = int(round(y))
    return out


def lowpass_filter(samples, rate, cutoff=9000.0, q=0.7071):
    """二阶 Butterworth 低通：滤掉 9kHz 以上的高频气流丝声，铃声泛音不受损。

    风铃基频 1~2.5k、合成泛音最高约 2.7x（6.75k），9k 以上基本只剩
    录音自带的高频气流噪声；低通把它们切掉，声音更干净。
    系数来自 RBJ Audio EQ Cookbook 的 lowpass。
    """
    w0 = 2.0 * math.pi * cutoff / rate
    alpha = math.sin(w0) / (2.0 * q)
    cosw0 = math.cos(w0)
    b0 = (1.0 - cosw0) / 2.0
    b1 = 1.0 - cosw0
    b2 = (1.0 - cosw0) / 2.0
    a0 = 1.0 + alpha
    a1 = -2.0 * cosw0
    a2 = 1.0 - alpha
    b0 /= a0
    b1 /= a0
    b2 /= a0
    a1 /= a0
    a2 /= a0
    x1 = x2 = y1 = y2 = 0.0
    out = [0] * len(samples)
    for i, x in enumerate(samples):
        y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, float(x)
        y2, y1 = y1, y
        out[i] = int(round(y))
    return out


def apply_decay(samples, rate, tau, attack=0.003):
    """给采样序列加敲击包络：短起音 + 指数衰减，把任意片段塑成一声短促的响。

    - attack: 头部从 0 线性升到 1（几毫秒），消除切片的起始咔哒
    - tau: 指数衰减时间常数，越小尾音收得越快
    返回 float 列表，交给 build_variant 继续做音高/音量/泛音变奏。
    """
    n = len(samples)
    out = [0.0] * n
    attack_n = max(int(attack * rate), 1)
    decay_factor = math.exp(-1.0 / (tau * rate))
    env = 1.0
    for i in range(n):
        if i < attack_n:
            env = i / attack_n
        out[i] = samples[i] * env
        if i >= attack_n:
            env *= decay_factor
    return out


def find_energy_anchors(samples, rate, count=8, win=0.12, min_gap=0.4):
    """扫描能量包络，返回 count 个高能量时刻（秒），彼此至少间隔 min_gap。

    长录音里有能量起伏，切在低谷里出来的是闷响；
    锚定高能量段再切，每一声都饱满。
    """
    n = len(samples)
    win_n = int(win * rate)
    energies = []
    for i in range(0, n - win_n, win_n):
        seg = samples[i:i + win_n]
        e = sum(x * x for x in seg) / win_n
        energies.append((e, i / rate))
    energies.sort(reverse=True)
    anchors = []
    for e, t in energies:
        if all(abs(t - a) >= min_gap for a in anchors):
            anchors.append(t)
        if len(anchors) >= count:
            break
    return sorted(anchors)


def build_chime_pool(
    path,
    count=12,
    slice_min=0.95,
    slice_max=1.5,
    pitch_range=DEFAULT_PITCH_RANGE,
    volume_range=(0.85, 1.0),
    excite_range=DEFAULT_EXCITE_RANGE,
    decay_range=(0.7, 1.15),
    overtone_max=DEFAULT_OVERTONE_MAX,
    rng=None,
):
    """从长录音里切出多个敲击变体，供风铃碰撞时随机取用。

    长录音（如多铃实录）整段播放是"一段录音放完"，与视觉脱节。
    这里先把整段录音过 400Hz 高通滤掉低频风声、再过 9kHz 低通滤掉高频气流丝声，
    再锚定录音里的高能量段，随机截取 0.95~1.5 秒片段
    （保留录音自带的多铃泛音质感与清晰音高），
    加指数衰减包络塑成一次敲击（tau 0.7~1.15s，余韵绵长不掐断），
    再做音高/音量/泛音变奏——每次碰撞都是一声完整的"叮——"，
    且每次都不完全一样。
    """
    samples, rate = load_pcm(path)
    samples = highpass_filter(samples, rate)
    samples = lowpass_filter(samples, rate)
    total = len(samples) / rate
    rng = rng or random.Random()
    anchors = find_energy_anchors(samples, rate, count=max(4, min(count, 10)))
    if not anchors:
        anchors = [rng.uniform(0.1, total - slice_max - 0.1)]
    pool = []
    for _ in range(count):
        anchor = rng.choice(anchors)
        # 从峰值前一点点开始切，保留敲击瞬态
        start = anchor - rng.uniform(0.0, 0.1)
        start = max(0.0, min(start, total - slice_max))
        duration = rng.uniform(slice_min, slice_max)
        i0 = int(start * rate)
        i1 = min(i0 + int(duration * rate), len(samples))
        seg = apply_decay(samples[i0:i1], rate, rng.uniform(*decay_range))
        base_freq = estimate_base_freq(seg, rate)
        semitone = rng.uniform(*pitch_range)
        volume = rng.uniform(*volume_range)
        excite = rng.uniform(*excite_range)
        pool.append(
            build_variant(
                seg, rate, semitone, volume, excite, base_freq, rng, overtone_max
            )
        )
    return pool
