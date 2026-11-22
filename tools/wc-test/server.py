"""Replays t1.aac like the station: on connect ~31 s burst, then real time. Shared live clock.
usage: server.py PORT RATE OUTDIR"""
import sys, time, json, os, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]); RATE = float(sys.argv[2]); OUT = sys.argv[3]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = open(os.path.join(HERE, '..', 'real', 't1.aac'), 'rb').read()
BURST = 31 * RATE
T0 = time.time()
START = BURST + 123          # first connection starts mid-frame at byte 123 (exercises resync)
st = {'stall_until': 0, 'drop': 0, 'conns': []}

def pos(t): return START + (t - T0) * RATE

class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def log_message(self, *a): pass
    def hdr(self, code, ctype):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
    def do_POST(self):
        n = int(self.headers['Content-Length']); body = self.rfile.read(n)
        u = urlparse(self.path)
        open(os.path.join(OUT, os.path.basename(u.path)), 'ab' if 'append=1' in u.query else 'wb').write(body)
        self.hdr(200, 'text/plain'); self.wfile.write(b'ok')
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == '/stream':
            now = time.time(); start = int(max(0, pos(now) - BURST)); sent = start
            st['conns'].append({'t': now, 'start': start}); gen = st['drop']
            self.hdr(200, 'audio/aac')
            try:
                while sent < len(DATA) and gen == st['drop']:
                    now = time.time()
                    if now >= st['stall_until']:
                        tgt = int(min(pos(now), len(DATA)))
                        if tgt > sent:
                            self.wfile.write(DATA[sent:tgt]); self.wfile.flush(); sent = tgt
                    time.sleep(0.02)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if u.path == '/ctl':
            if 'stall' in q: st['stall_until'] = time.time() + float(q['stall'][0])
            if 'drop' in q: st['drop'] += 1
            self.hdr(200, 'text/plain'); self.wfile.write(b'ok'); return
        if u.path == '/info':
            self.hdr(200, 'application/json')
            self.wfile.write(json.dumps({'T0': T0, 'START': START, 'RATE': RATE, 'conns': st['conns']}).encode()); return
        f = os.path.join(HERE, '..', '..', 'wc-player.js') if u.path == '/wc-player.js' else os.path.join(HERE, os.path.basename(u.path) or 'test.html')
        if not os.path.exists(f): self.hdr(404, 'text/plain'); return
        self.hdr(200, 'application/javascript' if f.endswith('.js') else 'text/html')
        self.wfile.write(open(f, 'rb').read())

ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
