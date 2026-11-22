# usage: analyze.py NAME INFO.json  -> compares worklet output capture with the ffmpeg reference
import sys, json, numpy as np
name, infof = sys.argv[1], sys.argv[2]
info = json.load(open(infof)); meta = json.load(open(f'out/{name}.json'))
import subprocess
raw = np.fromfile(f'out/{name}.bin', dtype=np.float32).reshape(-1, 2, 4096)
data = open('../real/t1.aac', 'rb').read()
offs = []; i = 0
while i + 7 <= len(data):
    offs.append(i); i += ((data[i+3] & 3) << 11) | (data[i+4] << 3) | (data[i+5] >> 5)
offs = np.array(offs + [len(data)])
SR = 44100; osr = meta['sr']; step = SR / osr; N = 4096
first_conn = info['conns'][0]['start']
j0 = int(np.searchsorted(offs, first_conn))          # first file frame fully inside the first connection
refs = {}
def refseg(media):          # ffmpeg decode starting at the module's pre-roll frame for this segment
    fs = int(np.floor(round(media * SR) / 1024)) - 10 + j0
    if fs not in refs:
        open('part.aac', 'wb').write(data[offs[fs]:])
        subprocess.run('ffmpeg -v quiet -y -i part.aac -f f32le -acodec pcm_f32le part.f32', shell=True, check=True)
        refs[fs] = np.fromfile('part.f32', dtype=np.float32).reshape(-1, 2)
    return fs, refs[fs]
def expected(media, pos, c):
    fs, ref = refseg(media)
    p = media * SR + pos + j0 * 1024 + c - fs * 1024 + np.arange(N) * step
    i0 = np.floor(p).astype(int); f = (p - i0)[:, None]
    return ref[i0] + (ref[i0 + 1] - ref[i0]) * f
steady = [k for k, (seg, pos, fr, media) in enumerate(meta['chunks']) if media is not None and pos > 2000]
k0 = steady[0]; seg, pos, fr, media = meta['chunks'][k0]
# find decoder alignment constant c by brute-force search of the best match (+-6000 samples)
best = None
for c in range(-6000, 6001):
    e = expected(media, pos, c)[:1024]
    err = np.abs(e - raw[k0].T[:1024]).max()
    if best is None or err < best[1]: best = (c, err)
c = best[0]
print(f'{name}: ctx rate {osr}, chunks {len(meta["chunks"])} steady {len(steady)}, alignment offset vs ffmpeg c={c} samples (err {best[1]:.2e})')
# per-chunk comparison at the offset predicted by the module's own media accounting
diffs = np.array([np.abs(expected(meta['chunks'][k][3], meta['chunks'][k][1], c) - raw[k].T).max() for k in steady])
bad_idx = [k for k, d in zip(steady, diffs) if d > 1e-3]; print("  mismatching chunk indices:", bad_idx[:20])
print(f'  max |diff| over {len(steady)} chunks ({len(steady)*N/osr:.1f} s): {diffs.max():.2e}; chunks with diff>1e-3: {(diffs>1e-3).sum()}; rms of output {np.sqrt((raw[steady]**2).mean()):.3f}')
# continuity: chunks must be back to back in context frames and in stream position within a segment
bad = 0
for a, b in zip(steady, steady[1:]):
    A, B = meta['chunks'][a], meta['chunks'][b]
    if A[0] == B[0] and B[2] - A[2] == N * (b - a) and abs((B[1] - A[1]) - N * step * (b - a)) > 1e-6: bad += 1
print(f'  position jumps between consecutive same-segment chunks: {bad}')
# ground-truth delay: station live position at render wall time minus the file sample actually heard (content based)
cl = np.array(meta['clock']); A = np.polyfit(cl[:, 0], cl[:, 1], 1)
tds = []
for k in steady:
    seg, pos, fr, media = meta['chunks'][k]
    wall = np.polyval(A, fr / osr) / 1000
    live_frames = np.searchsorted(offs, info['START'] + (wall - info['T0']) * info['RATE'], side='right') - 1
    heard = media * SR + pos + j0 * 1024 + c
    tds.append(live_frames * 1024 / SR - heard / SR)
tds = np.array(tds)
print(f'  true render delay (station clock, content-aligned): mean {tds.mean():.4f} min {tds.min():.4f} max {tds.max():.4f}')
