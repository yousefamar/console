"""Compare per-frame energy: input vs wacore-decoded vs WASM-decoded (of wacore packets) vs WASM enc->dec.
usage: analyse.py <prefix> <idle_frames> <outdir_dec> [outdir_enc]"""
import sys, glob, os, math, struct

prefix, idle = sys.argv[1], int(sys.argv[2])
dec_dir = sys.argv[3]
enc_dir = sys.argv[4] if len(sys.argv) > 4 else None
N = 960

def s16(b):
    return struct.unpack(f"<{len(b)//2}h", b)

def db(x):
    r = math.sqrt(sum(v * v for v in x) / len(x)) if x else 0
    return 20 * math.log10(r / 32767) if r > 0 else -120.0

inp = s16(open(f"{prefix}-in.raw", "rb").read())
rs_out = s16(open(f"{prefix}-out.wav", "rb").read()[44:])
frames = len(inp) // N

def load_dir(d, pat):
    out = []
    for k in range(frames):
        p = os.path.join(d, pat % k)
        out.append(s16(open(p, "rb").read()) if os.path.exists(p) else None)
    return out

wasm_dec = load_dir(dec_dir, "rs_d%03d.raw")
wasm_enc = load_dir(enc_dir, "wa_d%03d.raw") if enc_dir else [None] * frames
wa_pk = []
if enc_dir:
    for k in range(frames):
        p = os.path.join(enc_dir, "wa_p%03d.bin" % k)
        wa_pk.append(open(p, "rb").read() if os.path.exists(p) else b"")
rs_pk = [open(f"{prefix}-pkt/{k:03}.bin", "rb").read() for k in range(frames)]

print(f"onset frame {idle}. columns: in | wacore-dec | WASM-dec(wacore pkts) | WASM-enc->dec ; pkt sizes rs/wa + wa TOC")
print("frame  t(ms)     in   rsdec  wasmdec  wasmenc | rs_len rs_toc | wa_len wa_toc")
for k in range(max(0, idle - 4), min(frames, idle + 22)):
    i = inp[k * N:(k + 1) * N]
    r = rs_out[k * N:(k + 1) * N]
    w = wasm_dec[k]
    e = wasm_enc[k]
    wl = len(wa_pk[k]) if wa_pk else 0
    wt = f"0x{wa_pk[k][0]:02x}" if wa_pk and wa_pk[k] else "-"
    print(f"{k:5} {k*60:6} {db(i):7.1f} {db(r):7.1f} {db(w) if w else float('nan'):8.1f} {db(e) if e else float('nan'):8.1f} | {len(rs_pk[k]):6} 0x{rs_pk[k][0]:02x}   | {wl:6} {wt}")

# energy ratios over the first N ms of speech
def energy(x):
    return sum(float(v) * v for v in x)
onset = idle * N
for ms in (100, 200, 300, 500, 1000):
    n = ms * 16
    ei = energy(inp[onset:onset + n])
    def rat(seq):
        flat = []
        for k in range(idle, idle + math.ceil(n / N) + 1):
            if seq[k] is None:
                return float("nan")
            flat.extend(seq[k])
        return 10 * math.log10(energy(flat[:n]) / ei) if ei else float("nan")
    rs = 10 * math.log10(energy(rs_out[onset:onset + n]) / ei)
    print(f"first {ms:4} ms: wacore-dec {rs:+.2f} dB | WASM-dec(wacore pkts) {rat(wasm_dec):+.2f} dB | WASM enc->dec {rat(wasm_enc):+.2f} dB")

if wa_pk:
    tocs = {}
    for k in range(frames):
        t = wa_pk[k][0] if wa_pk[k] else None
        tocs[t] = tocs.get(t, 0) + 1
    print("WASM encoder TOC histogram:", {f'0x{t:02x}' if t is not None else None: c for t, c in tocs.items()})
    print("WASM encoder idle sizes:", sorted(set(len(p) for p in wa_pk[:idle])))
    print("WASM encoder TOC sequence around onset:", " ".join(f"{wa_pk[k][0]:02x}/{len(wa_pk[k])}" for k in range(max(0, idle - 3), min(frames, idle + 12))))
    print("WASM encoder TOC sequence at speech end:", " ".join(f"{wa_pk[k][0]:02x}/{len(wa_pk[k])}" for k in range(frames - 16, frames)))
