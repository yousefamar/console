//! Codec loopback for the first-word cut-off investigation
//! (research/voice-cutoff-investigation.md): <idle_secs> of the sidecar's idle
//! signal, then <speech.wav> (16 kHz mono s16), through wacore's MLow encoder
//! and its byte-exact decoder. Prints per-frame RMS in/out around the onset,
//! encode times, and writes `<prefix>-in.wav|-out.wav|-in.raw` plus one packet
//! per frame in `<prefix>-pkt/NNN.bin` — the inputs `tools/mlow-oracle/gen_specs.py`
//! turns into specs for WhatsApp's shipped WASM decoder/encoder.
//!
//! usage: onset <speech.wav> <idle_secs> <idle_db|off|dtx> <out_prefix> [reset]
//!   idle_db = comfort-noise level (calls.rs IdleNoise); off = ±1 LSB dither;
//!   dtx = exact zeros, i.e. the engine's 1-byte SID fast path (no encode)
//!   reset = MlowEncoder::reset() at the onset (encoder-state hypothesis)

use std::fs;
use whatsapp_rust::wacore::voip::mlow::{MlowDecoder, MlowEncoder};

const N: usize = 960;

fn read_wav_s16(path: &str) -> Vec<i16> {
    let b = fs::read(path).expect("read wav");
    // find "data" chunk
    let mut i = 12;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let len = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        if id == b"data" {
            let d = &b[i + 8..(i + 8 + len).min(b.len())];
            return d
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect();
        }
        i += 8 + len + (len & 1);
    }
    panic!("no data chunk");
}

fn write_wav_s16(path: &str, pcm: &[i16]) {
    let mut out = Vec::with_capacity(44 + pcm.len() * 2);
    let data_len = (pcm.len() * 2) as u32;
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&16000u32.to_le_bytes());
    out.extend_from_slice(&32000u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    fs::write(path, out).expect("write wav");
}

fn db(rms: f32) -> f32 {
    if rms <= 0.0 {
        -120.0
    } else {
        20.0 * (rms / 32767.0).log10()
    }
}
fn rms(f: &[i16]) -> f32 {
    (f.iter().map(|&s| (s as f32) * (s as f32)).sum::<f32>() / f.len() as f32).sqrt()
}

// same generator as calls.rs IdleNoise
struct IdleNoise {
    x: u32,
    lp: f32,
    gain: f32,
}
impl IdleNoise {
    fn new(level_db: f32) -> Self {
        let gain = if level_db < -100.0 {
            0.0
        } else {
            32767.0 * 10f32.powf(level_db / 20.0) / (0.577 * 0.28)
        };
        Self {
            x: 0x9E37_79B9,
            lp: 0.0,
            gain,
        }
    }
    fn next_u32(&mut self) -> u32 {
        let mut x = self.x;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.x = x;
        x
    }
    fn next_sample(&mut self) -> i16 {
        let white = (self.next_u32() as f32 / u32::MAX as f32) * 2.0 - 1.0;
        if self.gain == 0.0 {
            return ((self.next_u32() % 3) as i16) - 1;
        }
        self.lp += 0.15 * (white - self.lp);
        (self.lp * self.gain).round().clamp(-2000.0, 2000.0) as i16
    }
    fn frame(&mut self) -> Vec<i16> {
        (0..N).map(|_| self.next_sample()).collect()
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let speech = read_wav_s16(&a[1]);
    let idle_secs: f32 = a[2].parse().unwrap();
    let dtx = a[3] == "dtx";
    let idle_db: f32 = if a[3] == "off" || dtx {
        -1000.0
    } else {
        a[3].parse().unwrap()
    };
    let prefix = &a[4];
    let reset_at_onset = a.get(5).map(|s| s == "reset").unwrap_or(false);

    let idle_frames = (idle_secs * 16000.0 / N as f32).round() as usize;
    let mut noise = IdleNoise::new(idle_db);
    let mut input: Vec<i16> = Vec::new();
    for _ in 0..idle_frames {
        input.extend(noise.frame());
    }
    let onset = input.len();
    input.extend_from_slice(&speech);
    // tail idle
    for _ in 0..8 {
        input.extend(noise.frame());
    }
    while input.len() % N != 0 {
        input.push(0);
    }

    let mut enc = MlowEncoder::new();
    let mut dec = MlowDecoder::new();
    let mut out: Vec<i16> = Vec::with_capacity(input.len());
    let mut buf = Vec::new();
    let mut sizes = Vec::new();
    let mut tocs = Vec::new();
    let mut enc_times: Vec<std::time::Duration> = Vec::new();
    let mut packets: Vec<Vec<u8>> = Vec::new();
    for (fi, frame) in input.chunks_exact(N).enumerate() {
        if reset_at_onset && fi == idle_frames {
            enc.reset();
        }
        let t0 = std::time::Instant::now();
        if dtx && fi < idle_frames {
            // the engine's mic-mute fast path: no encode, a cached 1-byte SID
            buf.clear();
            buf.push(0x90);
        } else {
            enc.encode_i16_into(frame, &mut buf).expect("encode");
        }
        let et = t0.elapsed();
        enc_times.push(et);
        sizes.push(buf.len());
        tocs.push(buf[0]);
        packets.push(buf.clone());
        let pcm = dec.decode(&buf);
        let rep = dec.take_frame_report();
        if rep.decoded != 3 && !(dtx && fi < idle_frames) {
            eprintln!("frame {fi}: report {rep:?}");
        }
        out.extend(
            pcm.iter()
                .map(|&s| (s * 32768.0).round().clamp(-32768.0, 32767.0) as i16),
        );
    }
    assert_eq!(out.len(), input.len());
    write_wav_s16(&format!("{prefix}-in.wav"), &input);
    write_wav_s16(&format!("{prefix}-out.wav"), &out);
    // raw s16le input + per-frame wacore packets, for the WASM oracle
    {
        let mut raw = Vec::with_capacity(input.len() * 2);
        for s in &input {
            raw.extend_from_slice(&s.to_le_bytes());
        }
        fs::write(format!("{prefix}-in.raw"), raw).unwrap();
        fs::create_dir_all(format!("{prefix}-pkt")).unwrap();
        for (i, p) in packets.iter().enumerate() {
            fs::write(format!("{prefix}-pkt/{i:03}.bin"), p).unwrap();
        }
    }

    println!(
        "idle {idle_frames} frames ({idle_secs}s) at {} dBFS; onset at frame {idle_frames}",
        a[3]
    );
    println!("frame   t(ms)   in dBFS  out dBFS   delta  bytes toc");
    let lo = idle_frames.saturating_sub(3);
    let hi = (idle_frames + 20).min(sizes.len());
    for fi in lo..hi {
        let i = &input[fi * N..(fi + 1) * N];
        let o = &out[fi * N..(fi + 1) * N];
        // also print 20ms sub-slices for the first 5 speech frames
        let (di, do_) = (db(rms(i)), db(rms(o)));
        println!(
            "{fi:5} {:7} {di:8.1} {do_:9.1} {:7.1} {:5} 0x{:02x}",
            fi * 60,
            do_ - di,
            sizes[fi],
            tocs[fi]
        );
        if fi >= idle_frames && fi < idle_frames + 6 {
            for k in 0..3 {
                let si = &i[k * 320..(k + 1) * 320];
                let so = &o[k * 320..(k + 1) * 320];
                println!(
                    "      +{:2}ms          {:8.1} {:9.1} {:7.1}",
                    k * 20,
                    db(rms(si)),
                    db(rms(so)),
                    db(rms(so)) - db(rms(si))
                );
            }
        }
    }
    // Delay-tolerant onset comparison: cumulative energy of the speech region, input vs output
    let speech_in = &input[onset..onset + speech.len()];
    let speech_out = &out[onset..onset + speech.len()];
    let tot_in: f64 = speech_in.iter().map(|&s| (s as f64).powi(2)).sum();
    let tot_out: f64 = speech_out.iter().map(|&s| (s as f64).powi(2)).sum();
    let idle_t: Vec<f64> = enc_times[..idle_frames]
        .iter()
        .map(|d| d.as_secs_f64() * 1000.0)
        .collect();
    let sp_t: Vec<f64> = enc_times
        [idle_frames..idle_frames + 50.min(enc_times.len() - idle_frames)]
        .iter()
        .map(|d| d.as_secs_f64() * 1000.0)
        .collect();
    let mx = |v: &Vec<f64>| v.iter().cloned().fold(0.0, f64::max);
    let mean = |v: &Vec<f64>| v.iter().sum::<f64>() / v.len() as f64;
    println!(
        "encode ms: idle mean {:.1} max {:.1} | speech mean {:.1} max {:.1}",
        mean(&idle_t),
        mx(&idle_t),
        mean(&sp_t),
        mx(&sp_t)
    );
    println!(
        "speech region energy out/in = {:.2} dB",
        10.0 * (tot_out / tot_in).log10()
    );
    for ms in [100usize, 200, 300, 400, 500, 800] {
        let n = ms * 16;
        let ei: f64 = speech_in[..n].iter().map(|&s| (s as f64).powi(2)).sum();
        let eo: f64 = speech_out[..n].iter().map(|&s| (s as f64).powi(2)).sum();
        println!(
            "first {ms:3} ms of speech: out/in = {:.2} dB",
            10.0 * (eo / ei).log10()
        );
    }
}
