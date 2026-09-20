"""Generate oracle specs: (a) real WASM encoder+decoder over our PCM, (b) real WASM decoder over wacore packets.
usage: gen_specs.py <prefix>   (expects <prefix>-in.raw and <prefix>-pkt/NNN.bin)"""
import json, sys, os, glob

WR = os.environ.get("WR", "/tmp/mlow-onset/wr")  # a clone of whatsapp-rust at the Cargo.toml rev, with tools/oracle-cli built
prefix = sys.argv[1]
base = json.load(open(f"{WR}/tools/oracle-core/specs/mlow_110frames.json"))
steps = base["steps"]
open_i = next(i for i, st in enumerate(steps) if st["op"] == "call_table" and st["func"] == "opus_open")
header = steps[: open_i + 2]  # through assert_reg rc

raw = f"{prefix}-in.raw"
nbytes = os.path.getsize(raw)
nframes = nbytes // 1920
pkts = sorted(glob.glob(f"{prefix}-pkt/*.bin"))
assert len(pkts) == nframes, (len(pkts), nframes)

def u32(v):
    return v.to_bytes(4, "little").hex()

# (a) real encoder + real decoder
enc = list(header)
enc += [
    {"op": "malloc", "as": "synth", "len": nbytes},
    {"op": "write_file", "ptr": "$synth", "file": raw},
    {"op": "malloc", "as": "obuf", "len": 1024},
    {"op": "fill", "ptr": "$obuf", "len": 1024, "byte": 0},
    {"op": "malloc", "as": "pout", "len": 1920},
    {"op": "fill", "ptr": "$pout", "len": 1920, "byte": 0},
]
for k in range(nframes):
    enc += [
        {"op": "add", "reg": "$synth", "by": k * 1920, "as": f"pk{k}"},
        {"op": "malloc", "as": f"in{k}", "len": 32},
        {"op": "fill", "ptr": f"$in{k}", "len": 32, "byte": 0},
        {"op": "store", "ptr": f"$in{k}", "at": 8, "reg": f"$pk{k}"},
        {"op": "write", "ptr": f"$in{k}", "at": 16, "hex": "80070000"},
        {"op": "malloc", "as": f"of{k}", "len": 64},
        {"op": "fill", "ptr": f"$of{k}", "len": 64, "byte": 0},
        {"op": "store", "ptr": f"$of{k}", "at": 8, "reg": "$obuf"},
        {"op": "write", "ptr": f"$of{k}", "at": 16, "hex": "00040000"},
        {"op": "call_table", "func": "opus_encode", "args": ["$codec", f"$in{k}", 400, f"$of{k}"], "results": [f"erc{k}"]},
        {"op": "read_u32", "ptr": f"$of{k}", "at": 16, "as": f"pl{k}"},
        {"op": "read", "ptr": "$obuf", "len": f"$pl{k}", "out": f"wa_p{k:03}.bin"},
        {"op": "malloc", "as": f"df{k}", "len": 64},
        {"op": "fill", "ptr": f"$df{k}", "len": 64, "byte": 0},
        {"op": "malloc", "as": f"of2{k}", "len": 64},
        {"op": "fill", "ptr": f"$of2{k}", "len": 64, "byte": 0},
        {"op": "store", "ptr": f"$df{k}", "at": 8, "reg": "$obuf"},
        {"op": "store", "ptr": f"$df{k}", "at": 16, "reg": f"$pl{k}"},
        {"op": "store", "ptr": f"$of2{k}", "at": 8, "reg": "$pout"},
        {"op": "write", "ptr": f"$of2{k}", "at": 16, "hex": "80070000"},
        {"op": "call_table", "func": "opus_decode", "args": ["$codec", f"$df{k}", 1920, f"$of2{k}"], "results": [f"drc{k}"]},
        {"op": "read", "ptr": "$pout", "len": 1920, "out": f"wa_d{k:03}.raw"},
    ]
spec_a = {k: v for k, v in base.items() if k != "steps"}
spec_a["comment"] = ["Real WASM encoder+decoder over our idle-noise -> speech PCM (mlow-onset investigation)."]
spec_a["steps"] = enc
json.dump(spec_a, open(f"{prefix}-enc.json", "w"))

# (b) real decoder over wacore packets
dec = list(header)
dec += [
    {"op": "malloc", "as": "pbuf", "len": 1024},
    {"op": "fill", "ptr": "$pbuf", "len": 1024, "byte": 0},
    {"op": "malloc", "as": "pout", "len": 1920},
    {"op": "fill", "ptr": "$pout", "len": 1920, "byte": 0},
]
for k, pf in enumerate(pkts):
    b = open(pf, "rb").read()
    dec += [
        {"op": "write", "ptr": "$pbuf", "at": 0, "hex": b.hex()},
        {"op": "malloc", "as": f"df{k}", "len": 64},
        {"op": "fill", "ptr": f"$df{k}", "len": 64, "byte": 0},
        {"op": "malloc", "as": f"of2{k}", "len": 64},
        {"op": "fill", "ptr": f"$of2{k}", "len": 64, "byte": 0},
        {"op": "store", "ptr": f"$df{k}", "at": 8, "reg": "$pbuf"},
        {"op": "write", "ptr": f"$df{k}", "at": 16, "hex": u32(len(b))},
        {"op": "store", "ptr": f"$of2{k}", "at": 8, "reg": "$pout"},
        {"op": "write", "ptr": f"$of2{k}", "at": 16, "hex": "80070000"},
        {"op": "call_table", "func": "opus_decode", "args": ["$codec", f"$df{k}", 1920, f"$of2{k}"], "results": [f"drc{k}"]},
        {"op": "read", "ptr": "$pout", "len": 1920, "out": f"rs_d{k:03}.raw"},
    ]
spec_b = {k: v for k, v in base.items() if k != "steps"}
spec_b["comment"] = ["Real WASM decoder over wacore-encoded packets (mlow-onset investigation)."]
spec_b["steps"] = dec
json.dump(spec_b, open(f"{prefix}-dec.json", "w"))
print(f"{nframes} frames; wrote {prefix}-enc.json and {prefix}-dec.json")
