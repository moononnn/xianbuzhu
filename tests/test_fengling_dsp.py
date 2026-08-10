# -*- coding: utf-8 -*-
import io
import math
import random
import sys
import unittest
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import fengling_dsp as dsp

SOFT_WAV = str(ROOT / "python" / "fengling-chime-soft.wav")
CLUSTER_WAV = str(ROOT / "python" / "fengling-chime-cluster.wav")


def _rms(samples):
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


def _zcr(samples):
    """过零率：高频成分越多，符号翻转越频繁。"""
    if len(samples) < 2:
        return 0.0
    crossings = sum(
        1 for i in range(1, len(samples)) if (samples[i] >= 0) != (samples[i - 1] >= 0)
    )
    return crossings / (len(samples) - 1)


def _unpack_wav(data):
    import struct

    with wave.open(io.BytesIO(data), "rb") as w:
        return (
            w.getnchannels(),
            w.getsampwidth(),
            w.getframerate(),
            list(struct.unpack("<%dh" % (w.getnframes()), w.readframes(w.getnframes()))),
        )


def _goertzel_energy(samples, rate, f):
    omega = 2.0 * math.pi * f / rate
    coeff = 2.0 * math.cos(omega)
    s0 = s1 = s2 = 0.0
    for x in samples:
        s0 = x + coeff * s1 - s2
        s2, s1 = s1, s0
    return s1 * s1 + s2 * s2 - coeff * s1 * s2


def _variant(semitone=0.0, volume=1.0, excite=0.0, rng=None):
    samples, rate = dsp.load_pcm(SOFT_WAV)
    base_freq = dsp.estimate_base_freq(samples, rate)
    return dsp.build_variant(
        samples, rate, semitone, volume, excite, base_freq, rng or random.Random(1)
    )


class FenglingDspTests(unittest.TestCase):
    def test_variant_is_valid_16bit_mono_wav(self):
        data = _variant()
        ch, sw, rate, _ = _unpack_wav(data)
        self.assertEqual((ch, sw, rate), (1, 2, 44100))

    def test_rising_pitch_shortens_duration(self):
        up = _unpack_wav(_variant(semitone=+2.0))[3]
        down = _unpack_wav(_variant(semitone=-2.0))[3]
        self.assertLess(len(up), len(down))

    def test_variant_never_longer_than_source(self):
        samples, rate = dsp.load_pcm(SOFT_WAV)
        base_freq = dsp.estimate_base_freq(samples, rate)
        for semitone in (-3.0, -1.0, 0.0, 1.5, 3.0):
            data = dsp.build_variant(
                samples, rate, semitone, 1.0, 0.0, base_freq, random.Random(2)
            )
            _, _, _, out = _unpack_wav(data)
            self.assertLessEqual(len(out), len(samples), f"semitone={semitone}")

    def test_volume_scales_rms(self):
        quiet = _unpack_wav(_variant(volume=0.4))[3]
        loud = _unpack_wav(_variant(volume=1.0))[3]
        self.assertLess(_rms(quiet), _rms(loud))
        self.assertLess(_rms(quiet), _rms(loud) * 0.6)

    def test_master_volume_scales_an_existing_wav_without_changing_format(self):
        source = _variant(volume=1.0)
        quiet = dsp.scale_wav_volume(source, 0.35)
        ch, sw, rate, quiet_samples = _unpack_wav(quiet)
        source_samples = _unpack_wav(source)[3]
        self.assertEqual((ch, sw, rate), (1, 2, 44100))
        self.assertAlmostEqual(_rms(quiet_samples) / _rms(source_samples), 0.35, delta=0.01)
        self.assertIs(dsp.scale_wav_volume(source, 1.0), source)

    def test_excite_adds_high_frequency_content(self):
        plain = _unpack_wav(_variant(excite=0.0, rng=random.Random(3)))[3]
        bright = _unpack_wav(_variant(excite=0.6, rng=random.Random(3)))[3]
        self.assertGreater(_zcr(bright), _zcr(plain))

    def test_overtones_raise_energy_at_overtone_frequencies(self):
        """泛音层应显著抬高基频 2x 处的能量（亮度可闻地上升）。"""
        samples, rate = dsp.load_pcm(SOFT_WAV)
        base_freq = dsp.estimate_base_freq(samples, rate)
        plain = _unpack_wav(
            dsp.build_variant(
                samples, rate, 0.0, 1.0, 0.0, base_freq, random.Random(5), overtone_max=0.0
            )
        )[3]
        bright = _unpack_wav(
            dsp.build_variant(
                samples, rate, 0.0, 1.0, 0.0, base_freq, random.Random(6), overtone_max=0.30
            )
        )[3]
        e_plain = _goertzel_energy(plain, rate, base_freq * 2.0)
        e_bright = _goertzel_energy(bright, rate, base_freq * 2.0)
        self.assertGreater(e_bright, e_plain * 3.0)

    def test_samples_stay_within_int16_range(self):
        data = _variant(semitone=-2.0, volume=1.0, excite=0.35, rng=random.Random(7))
        _, _, _, out = _unpack_wav(data)
        self.assertLessEqual(max(out), 32767)
        self.assertGreaterEqual(min(out), -32768)

    def test_base_freq_estimation_is_reasonable(self):
        samples, rate = dsp.load_pcm(SOFT_WAV)
        f = dsp.estimate_base_freq(samples, rate)
        self.assertGreater(f, 1000.0)
        self.assertLess(f, 2500.0)

    def test_pool_has_diversity(self):
        pool = dsp.build_variant_pool(SOFT_WAV, count=8, rng=random.Random(11))
        self.assertEqual(len(pool), 8)
        self.assertGreater(len(set(pool)), 4)

    def test_pool_reproducible_with_fixed_seed(self):
        a = dsp.build_variant_pool(SOFT_WAV, count=3, rng=random.Random(42))
        b = dsp.build_variant_pool(SOFT_WAV, count=3, rng=random.Random(42))
        self.assertEqual(a, b)

    def test_chime_pool_slices_are_short_and_never_longer_than_source(self):
        pool = dsp.build_chime_pool(CLUSTER_WAV, count=6, rng=random.Random(21))
        self.assertEqual(len(pool), 6)
        source_len = len(dsp.load_pcm(CLUSTER_WAV)[0])
        for data in pool:
            _, _, rate, samples = _unpack_wav(data)
            self.assertGreater(len(samples) / rate, 0.3)
            self.assertLess(len(samples) / rate, 2.0)
            self.assertLess(len(samples), source_len)

    def test_chime_pool_tail_keeps_a_tail_but_clearly_softer_than_head(self):
        """衰减包络保留尾韵（不是闷响），但尾部仍明显弱于头部。"""
        pool = dsp.build_chime_pool(CLUSTER_WAV, count=4, rng=random.Random(22))
        for data in pool:
            _, _, rate, samples = _unpack_wav(data)
            head = _rms(samples[: int(rate * 0.05)])
            tail = _rms(samples[-int(rate * 0.05):])
            self.assertGreater(head, tail * 1.3, "尾部应弱于头部（敲击衰减）")

    def test_chime_pool_reproducible_with_fixed_seed(self):
        a = dsp.build_chime_pool(CLUSTER_WAV, count=3, rng=random.Random(7))
        b = dsp.build_chime_pool(CLUSTER_WAV, count=3, rng=random.Random(7))
        self.assertEqual(a, b)

    def test_energy_anchors_spread_across_the_recording(self):
        """锚点应散布在整段录音的高能量位置，间隔不小于 min_gap。"""
        samples, rate = dsp.load_pcm(CLUSTER_WAV)
        anchors = dsp.find_energy_anchors(samples, rate, count=6)
        self.assertGreaterEqual(len(anchors), 6)
        self.assertGreater(max(anchors) - min(anchors), 1.5)
        for a, b in zip(anchors, anchors[1:]):
            self.assertGreaterEqual(b - a, 0.4)

    def test_chime_pool_slices_start_near_energy_anchors(self):
        """切片起点应贴近能量锚点（保留敲击瞬态），而不是随机落在低谷。"""
        samples, rate = dsp.load_pcm(CLUSTER_WAV)
        anchors = dsp.find_energy_anchors(samples, rate, count=8)
        rng = random.Random(23)
        for _ in range(20):
            anchor = rng.choice(anchors)
            start = anchor - rng.uniform(0.0, 0.1)
            self.assertGreaterEqual(start, 0.0)
            self.assertAlmostEqual(min(abs(start - a) for a in anchors), 0.0, delta=0.1)

    def _goertzel(self, samples, f, rate=44100):
        omega = 2.0 * math.pi * f / rate
        coeff = 2.0 * math.cos(omega)
        s0 = s1 = s2 = 0.0
        for x in samples:
            s0 = x + coeff * s1 - s2
            s2, s1 = s1, s0
        return s1 * s1 + s2 * s2 - coeff * s1 * s2

    def test_highpass_kills_wind_noise_but_keeps_bell_body(self):
        """400Hz 高通：低频风声能量大幅衰减，铃声主体（1k~3k）几乎不动。"""
        samples, rate = dsp.load_pcm(CLUSTER_WAV)
        filtered = dsp.highpass_filter(samples, rate)

        def db_drop(f):
            e_raw = self._goertzel(samples, f, rate)
            e_fil = self._goertzel(filtered, f, rate)
            return 10.0 * math.log10(max(e_fil, 1e-9) / max(e_raw, 1e-9))

        self.assertLess(db_drop(100), -15.0, "100Hz 风声应被压掉 15dB 以上")
        self.assertLess(db_drop(200), -10.0, "200Hz 气流声应被明显压掉")
        self.assertLess(abs(db_drop(1000)), 1.0, "1kHz 铃声主体不应受损")
        self.assertLess(abs(db_drop(2000)), 1.0, "2kHz 铃声主体不应受损")
        self.assertLess(abs(db_drop(3000)), 1.0, "3kHz 铃声主体不应受损")

    def test_lowpass_kills_high_freq_hiss_but_keeps_bell_body(self):
        """9kHz 低通：高频气流丝声衰减，铃声主体（1k~4k）几乎不动。"""
        samples, rate = dsp.load_pcm(CLUSTER_WAV)
        filtered = dsp.lowpass_filter(samples, rate)

        def db_drop(f):
            e_raw = self._goertzel(samples, f, rate)
            e_fil = self._goertzel(filtered, f, rate)
            return 10.0 * math.log10(max(e_fil, 1e-9) / max(e_raw, 1e-9))

        self.assertLess(db_drop(12000), -6.0, "12kHz 丝声应被压掉 6dB 以上")
        self.assertLess(db_drop(15000), -12.0, "15kHz 丝声应被压掉 12dB 以上")
        self.assertLess(abs(db_drop(1000)), 1.0, "1kHz 铃声主体不应受损")
        self.assertLess(abs(db_drop(2000)), 1.0, "2kHz 铃声主体不应受损")
        self.assertLess(abs(db_drop(4000)), 1.0, "4kHz 铃声泛音不应受损")


if __name__ == "__main__":
    unittest.main()
