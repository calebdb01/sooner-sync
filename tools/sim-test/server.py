"""Serves the repository for the iOS simulator and saves page reports.
usage: python3 -I server.py PORT OUTDIR
GET  /<file>        -> file from the repository root
POST /report        -> body (one JSON line) appended to OUTDIR/report.jsonl
POST /tap?append=1  -> raw bytes appended to OUTDIR/<name> (output capture)
/stream and /ctl    -> optional replay of tools/real/t1.aac (same clock rules as tools/wc-test/server.py)
"""
import sys, os, time, json
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]); OUT = sys.argv[2]
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
CAP = os.path.join(ROOT, 'tools', 'real', 't1.aac')
RATE = 12000.0   # measured from t1.aac: 11687 ADTS frames in 271.4 s
DATA = open(CAP, 'rb').read() if os.path.exists(CAP) else b''
BURST = 31 * RATE
T0 = time.time(); START = BURST + 123
conns = []
TYPES = {'.js': 'application/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml'}

def pos(t): return START + (t - T0) * RATE

class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def log_message(self, *a): pass
    def hdr(self, code, ctype):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); body = self.rfile.read(n)
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == '/report':
            with open(os.path.join(OUT, 'report.jsonl'), 'ab') as f: f.write(body.rstrip(b'\n') + b'\n')
        elif u.path == '/tap':
            name = os.path.basename(q.get('name', ['tap.bin'])[0])
            open(os.path.join(OUT, name), 'ab' if q.get('append') == ['1'] else 'wb').write(body)
        self.hdr(200, 'text/plain'); self.wfile.write(b'ok')
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/stream' and DATA:
            now = time.time(); sent = int(max(0, pos(now) - BURST)); conns.append({'t': now, 'start': sent})
            self.hdr(200, 'audio/aac')
            try:
                while sent < len(DATA):
                    tgt = int(min(pos(time.time()), len(DATA)))
                    if tgt > sent: self.wfile.write(DATA[sent:tgt]); self.wfile.flush(); sent = tgt
                    time.sleep(0.02)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if u.path == '/info':
            self.hdr(200, 'application/json'); self.wfile.write(json.dumps({'T0': T0, 'START': START, 'RATE': RATE, 'conns': conns}).encode()); return
        f = os.path.normpath(os.path.join(ROOT, u.path.lstrip('/') or 'index.html'))
        if not f.startswith(ROOT) or not os.path.isfile(f): self.hdr(404, 'text/plain'); return
        self.hdr(200, TYPES.get(os.path.splitext(f)[1], 'application/octet-stream'))
        self.wfile.write(open(f, 'rb').read())

ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
