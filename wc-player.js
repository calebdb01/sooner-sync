/*
 * wc-player.js - live ADTS AAC radio with an adjustable delay behind the live edge.
 *
 * fetch() stream -> ADTS frame parser -> up to 300 s of compressed history
 *   -> one WebCodecs AudioDecoder (fed sequentially from the play position, throttled)
 *   -> AudioWorklet ring buffer (resamples if the context rate differs) -> speakers.
 *
 * Plain script, no dependencies. Exposes the global `SoonerWC`.
 * Timing: delay = liveMedia(now) - mediaBeingHeard, where liveMedia(t) = t + L,
 * L = max over time of (mediaSecondsReceived - t), and mediaBeingHeard comes from
 * the sample count the worklet reports as consumed (never from timers).
 * Test-only options: create({ _sampleRate: 48000 }) forces the AudioContext rate;
 * create({ _tap: fn }) makes the worklet post back every output block it plays.
 */
(function (global) {
  'use strict';

  var FRAME = 1024;           // PCM samples per AAC frame
  var HISTORY_S = 300;        // compressed history kept in memory
  var MIN_DELAY = 2.5;        // s: decoded lead (1.25 s) + network jitter margin + scheduling
  var LEAD_S = 1.25;          // decoded PCM kept ahead of the play position
  var PREROLL = 10;           // frames decoded and thrown away before a seek target
  var START_MARGIN = 0.35;    // s between a seek and its scheduled first audible sample
  var MAX_QUEUE = 24;         // max chunks waiting inside the decoder
  var MATCH = 12;             // frames compared to splice a reconnect onto the history
  var RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function nowS() { return performance.now() / 1000; }
  function errText(e) { return (e && (e.name ? e.name + ': ' : '') + (e.message || e)) || String(e); }

  // ---- AudioWorklet processor (serialised into a Blob URL, so this stays one file) ----
  function workletMain() {
    var SIZE = 1 << 17, MASK = SIZE - 1;   // ring of 131072 samples, ~3 s at 44.1 kHz
    class SoonerRing extends AudioWorkletProcessor {
      constructor(opts) {
        super();
        var o = opts.processorOptions;
        this.sr = o.streamRate;
        this.step = o.streamRate / sampleRate;   // input samples per output sample
        this.fade = Math.round(o.streamRate * 0.005);
        this.prefill = Math.round(o.streamRate * 0.25);
        this.L = new Float32Array(SIZE); this.R = new Float32Array(SIZE);
        this.w = 0; this.r = 0;                  // absolute write/read positions; r is fractional
        this.seg = 0; this.segStart = 0; this.startFrame = 0;
        this.playing = false; this.pauseGain = 0;
        this.flowing = false; this.since = 0;    // input samples since the last fade-in began
        this.underruns = 0; this.dropped = 0; this.fresh = false; this.lastOut = 0;
        this.tap = o.tap ? { l: new Float32Array(4096), r: new Float32Array(4096), n: 0, pos: 0, seg: 0 } : null;
        this.nextReport = 0;
        this.port.onmessage = (e) => this.onMsg(e.data);
      }
      onMsg(m) {
        if (m.t === 'pcm') {
          if (m.seg !== this.seg) return;        // block decoded before the latest seek
          var l = new Float32Array(m.l), r = new Float32Array(m.r), n = l.length;
          if (this.w + n - this.r > SIZE - 2) { this.dropped++; return; }
          for (var i = 0; i < n; i++) { var k = (this.w + i) & MASK; this.L[k] = l[i]; this.R[k] = r[i]; }
          this.w += n;
        } else if (m.t === 'seek') {
          var keep = 0;
          if (this.flowing && this.playing) {    // fade out the next 5 ms of old audio in place
            var base = Math.floor(this.r);
            keep = Math.min(this.fade, Math.max(0, this.w - base - 1));
            for (var j = 0; j < keep; j++) { var q = (base + j) & MASK, g = 1 - (j + 1) / keep; this.L[q] *= g; this.R[q] *= g; }
            this.w = base + keep;
          } else {
            this.w = Math.ceil(this.r);
          }
          this.seg = m.seg; this.segStart = this.w; this.startFrame = Math.round(m.at * sampleRate);
          this.flowing = keep > 0;               // the faded tail plays out, then the new segment waits for startFrame
          this.fresh = true;
        } else if (m.t === 'play') {
          this.playing = m.on;
          if (m.on) { this.since = this.pauseGain * this.fade; this.pauseGain = 1; }
        }
      }
      process(inputs, outputs) {
        var oL = outputs[0][0], oR = outputs[0][1] || outputs[0][0], n = oL.length;
        var tapPos = this.r - this.segStart, tapSeg = this.seg, r0 = this.r, lastJ = 0;
        for (var j = 0; j < n; j++) {
          var avail = this.w - this.r, inNew = this.r >= this.segStart;
          if (this.playing ? false : this.pauseGain <= 0) { oL[j] = oR[j] = 0; continue; }
          if (inNew && this.fresh) {             // new segment: start exactly at its scheduled frame
            if (currentFrame + j < this.startFrame || avail <= this.fade || !this.playing) { oL[j] = oR[j] = 0; this.flowing = false; continue; }
            this.fresh = false; this.flowing = true; this.since = 0;
          } else if (!this.flowing) {            // recovering from an underrun: wait for a small prefill
            if (!this.playing || avail < this.prefill) { oL[j] = oR[j] = 0; continue; }
            this.flowing = true; this.since = 0;
          }
          if (avail <= 1) {                      // ran dry: output silence, continue when audio arrives
            if (inNew) this.underruns++;
            this.flowing = false; oL[j] = oR[j] = 0; continue;
          }
          var i0 = Math.floor(this.r), f = this.r - i0, a = i0 & MASK, b = (i0 + 1) & MASK;
          var g = Math.min(1, this.since / this.fade) * Math.min(1, avail / this.fade) * this.pauseGain;
          oL[j] = (this.L[a] + (this.L[b] - this.L[a]) * f) * g;
          oR[j] = (this.R[a] + (this.R[b] - this.R[a]) * f) * g;
          this.r += this.step; this.since += this.step; lastJ = j;
          if (!this.playing) this.pauseGain = Math.max(0, this.pauseGain - this.step / this.fade);
        }
        if (this.r !== r0) this.lastOut = currentTime + (lastJ + 1) / sampleRate;   // end of the audio rendered so far
        if (this.tap) this.tapPush(oL, oR, tapPos, tapSeg);
        if (currentFrame >= this.nextReport) {
          this.nextReport = currentFrame + sampleRate / 5;
          this.port.postMessage({ t: 'stat', seg: this.seg, lastOut: this.lastOut,
            consumed: Math.max(0, this.r - this.segStart), fill: Math.max(0, this.w - Math.max(this.r, this.segStart)),
            flowing: this.flowing && this.playing, underruns: this.underruns, dropped: this.dropped });
        }
        return true;
      }
      tapPush(oL, oR, pos, seg) {                // debug: post back exactly what was output, silence included
        var t = this.tap;
        if (t.n === 0) { t.pos = pos; t.seg = seg; t.frame = currentFrame; }
        t.l.set(oL, t.n); t.r.set(oR, t.n); t.n += oL.length;
        if (t.n === t.l.length) {
          this.port.postMessage({ t: 'tap', seg: t.seg, pos: t.pos, frame: t.frame, l: t.l, r: t.r }, [t.l.buffer, t.r.buffer]);
          t.l = new Float32Array(4096); t.r = new Float32Array(4096); t.n = 0;
        }
      }
    }
    registerProcessor('sooner-ring', SoonerRing);
  }

  // ---- ADTS parsing ----
  function adtsHeader(d, i) {
    if (d[i] !== 0xFF || (d[i + 1] & 0xF6) !== 0xF0) return null;       // sync word + layer 0
    var sfi = (d[i + 2] >> 2) & 15, hdr = (d[i + 1] & 1) ? 7 : 9;
    var len = ((d[i + 3] & 3) << 11) | (d[i + 4] << 3) | (d[i + 5] >> 5);
    if (sfi > 12 || len <= hdr) return null;
    return { len: len, hdr: hdr, sfi: sfi, profile: (d[i + 2] >> 6) & 3, ch: ((d[i + 2] & 1) << 2) | (d[i + 3] >> 6) };
  }
  function sameStream(a, b) { return a.sfi === b.sfi && a.ch === b.ch && a.profile === b.profile; }
  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function supported() {
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      return typeof global.AudioDecoder === 'function' && typeof global.EncodedAudioChunk === 'function' &&
        !!AC && 'audioWorklet' in AC.prototype && typeof global.AudioWorkletNode === 'function' &&
        typeof global.fetch === 'function' && typeof global.ReadableStream === 'function' && 'body' in Response.prototype;
    } catch (e) { return false; }
  }

  function create(opts) {
    opts = opts || {};
    var onState = opts.onState || function () {};
    var s = {
      status: 'connecting', message: '', lastError: '', fatal: false, running: false, paused: false, muted: false,
      frames: [], first: 0, rate: 0, info: null, framesReceived: 0, resyncBytes: 0, reconnects: 0,
      L: -Infinity, anchorL: -Infinity, anchorT: 0, burstEnded: false, lastBytes: 0,
      splicing: false, pending: [],
      target: Math.max(MIN_DELAY, +opts.delay || MIN_DELAY), needSeek: true, corrections: 0,
      dec: null, modes: [], mode: '', verified: false, decodeErrors: 0, tsGaps: 0,
      seg: 0, segMedia: 0, feed: 0, feedStart: 0, expect: 0, skip: 0, fed: 0, outputs: 0, posted: 0, segPlayed: false,
      w: { seg: 0, consumed: 0, fill: 0, flowing: false, underruns: 0, dropped: 0, lastOut: 0 },
      delayEst: null
    };
    var ctx = null, node = null, gain = null, abort = null, timer = null, startPromise = null;
    var segMediaBySeg = {};

    function fail(e, fatal) {
      s.lastError = errText(e);
      if (fatal) { s.fatal = true; s.message = s.lastError; emit(); }
    }

    // ---- live edge & history ----
    function received() { return (s.first + s.frames.length) * FRAME / s.rate; }   // media s up to the newest frame
    function oldest() { return s.first * FRAME / s.rate; }
    function live() { return nowS() + s.L; }

    function addFrame(f) {
      s.frames.push(f); s.framesReceived++;
      var extra = s.frames.length - Math.ceil(HISTORY_S * s.rate / FRAME);
      if (extra > 100) { s.frames.splice(0, extra); s.first += extra; }
      var t = nowS(), cand = received() - t;
      if (cand > s.L) s.L = cand;
      if (s.L - s.anchorL > 0.2) { s.anchorL = s.L; s.anchorT = t; }
    }

    // A reconnect replays ~30 s we already hold: drop frames until the last MATCH stored frames recur.
    function onFrame(f) {
      if (!s.splicing) return addFrame(f);
      var p = s.pending, F = s.frames, k;
      p.push(f);
      for (k = 0; k < MATCH && k < F.length; k++) if (!equalBytes(p[p.length - 1 - k] || [], F[F.length - 1 - k])) break;
      if (k === Math.min(MATCH, F.length)) { s.splicing = false; s.pending = []; return; }
      if (p.length * FRAME / s.rate > 40) resetTimeline();            // no overlap: the gap was too long
    }
    function resetTimeline() {
      var p = s.pending;
      s.splicing = false; s.pending = []; s.frames = []; s.first = 0;
      s.L = s.anchorL = -Infinity; s.burstEnded = false;
      flush(); s.needSeek = true;
      p.forEach(addFrame);
    }

    function parse(buf) {
      var i = 0, n = buf.length;
      while (i + 9 <= n) {
        var h = adtsHeader(buf, i);
        if (!h) { i++; s.resyncBytes++; continue; }
        if (i + h.len + 9 > n) break;                                   // wait for the next header too
        var nx = adtsHeader(buf, i + h.len);
        if (!nx || !sameStream(h, nx)) { i++; s.resyncBytes++; continue; }
        if (!s.info) {
          s.info = h; s.rate = RATES[h.sfi];
        } else if (!sameStream(h, s.info)) { i++; s.resyncBytes++; continue; }
        onFrame(buf.slice(i, i + h.len));
        i += h.len;
      }
      return buf.subarray(i);
    }

    async function readLoop() {
      var backoff = 1;
      while (s.running) {
        try {
          abort = new AbortController();
          var res = await fetch(opts.url, { signal: abort.signal, cache: 'no-store' });
          if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
          var reader = res.body.getReader(), carry = new Uint8Array(0);
          s.splicing = s.frames.length > 0; s.pending = [];
          backoff = 1;
          for (;;) {
            var r = await reader.read();
            if (r.done || !s.running) break;
            s.lastBytes = nowS();
            var buf = new Uint8Array(carry.length + r.value.length);
            buf.set(carry); buf.set(r.value, carry.length);
            carry = parse(buf);
          }
          if (s.running) s.lastError = 'stream ended';
        } catch (e) {
          if (s.running) s.lastError = errText(e);
        }
        if (!s.running) return;
        s.reconnects++;
        await new Promise(function (ok) { setTimeout(ok, backoff * 1000); });
        backoff = Math.min(backoff * 2, 8);
      }
    }

    // ---- decoder ----
    function config(mode) {
      var h = s.info, aot = h.profile + 1;
      var c = { codec: 'mp4a.40.' + aot, sampleRate: s.rate, numberOfChannels: h.ch || 2 };
      if (mode === 'raw') c.description = new Uint8Array([(aot << 3) | (h.sfi >> 1), ((h.sfi & 1) << 7) | (h.ch << 3)]);
      return c;
    }
    async function pickModes() {
      for (var m of ['raw', 'adts']) {
        try { if ((await AudioDecoder.isConfigSupported(config(m))).supported) s.modes.push(m); } catch (e) { s.lastError = errText(e); }
      }
      if (!s.modes.length) throw new Error('AudioDecoder does not support this AAC stream');
      s.mode = s.modes[0];
    }
    function newDecoder() {
      try { if (s.dec && s.dec.state !== 'closed') s.dec.close(); } catch (e) { /* already closed */ }
      var d = new AudioDecoder({
        output: function (a) { if (d === s.dec) onOutput(a); else a.close(); },
        error: function (e) { if (d === s.dec) onDecodeError(e); }
      });
      s.dec = d;
    }
    function onDecodeError(e) {
      s.decodeErrors++; s.lastError = 'decoder: ' + errText(e);
      if (!s.verified) nextMode();
      if (s.fatal) return;
      newDecoder(); s.target = currentDelay(); flush(); s.needSeek = true;
    }
    function nextMode() {
      var i = s.modes.indexOf(s.mode) + 1;
      if (i >= s.modes.length) return fail(new Error('no decoder mode produced audio'), true);
      s.mode = s.modes[i];
    }

    function planes(a) {
      var n = a.numberOfFrames, ch = a.numberOfChannels, out = [], c;
      if (a.format === 'f32') {
        var x = new Float32Array(n * ch);
        a.copyTo(x, { planeIndex: 0 });
        for (c = 0; c < Math.min(ch, 2); c++) { var p = new Float32Array(n); for (var i = 0; i < n; i++) p[i] = x[i * ch + c]; out.push(p); }
      } else {
        for (c = 0; c < Math.min(ch, 2); c++) {
          var q = new Float32Array(n);
          a.copyTo(q, a.format === 'f32-planar' ? { planeIndex: c } : { planeIndex: c, format: 'f32-planar' });
          out.push(q);
        }
      }
      if (out.length === 1) out.push(out[0].slice());
      return out;
    }
    function onOutput(a) {
      try {
        var idx = Math.round(a.timestamp * s.rate / 1e6 / FRAME);
        if (idx < s.feedStart || idx >= s.feed) return;                // left over from before the last reset()
        s.outputs++;
        if (idx < s.expect || a.numberOfFrames === 0) return;         // pre-roll output
        if (idx !== s.expect) s.tsGaps++;
        var pl = planes(a), cut = 0;
        if (!s.segPlayed) {                                             // first kept block of this segment
          cut = idx === s.expect ? Math.min(s.skip, pl[0].length) : 0;
          if (idx !== s.expect) segMediaBySeg[s.seg] = s.segMedia = idx * FRAME / s.rate;
          s.segPlayed = true; s.verified = true;
        }
        s.expect = idx + 1;
        var l = pl[0].subarray(cut).slice(), r = pl[1].subarray(cut).slice();
        s.posted += l.length;
        node.port.postMessage({ t: 'pcm', seg: s.seg, l: l.buffer, r: r.buffer }, [l.buffer, r.buffer]);
      } catch (e) { fail(e); } finally { a.close(); }
      pump();
    }

    // Start a new worklet segment (silent until it receives audio).
    function flush(at) {
      s.seg++; s.segPlayed = false; s.posted = 0; s.fed = 0; s.outputs = 0;
      s.feed = s.feedStart = -1;                                        // rejects any output still in the decoder
      s.w.consumed = 0; s.w.fill = 0; s.w.flowing = false; s.delayEst = null;
      if (node) node.port.postMessage({ t: 'seek', seg: s.seg, at: at || 0 });
    }
    // Schedule the first audible sample at context time T so the delay is exact from the start.
    function seek(delay) {
      var T = ctx.currentTime + START_MARGIN * (1 + s.corrections);
      // media to render at T: T becomes audible at wall time now + (T - audibleCtxTime())
      var m = nowS() + (T - audibleCtxTime()) + s.L - delay;
      var samp = Math.round(m * s.rate), k = Math.floor(samp / FRAME);
      flush(T);
      s.segMedia = samp / s.rate; segMediaBySeg[s.seg] = s.segMedia;
      s.expect = k; s.skip = samp - k * FRAME; s.feed = s.feedStart = Math.max(s.first, k - PREROLL);
      try { s.dec.reset(); s.dec.configure(config(s.mode)); } catch (e) { newDecoder(); s.dec.configure(config(s.mode)); }
      s.needSeek = false;
      pump();
    }
    function maybeSeek() {
      if (!s.needSeek || !s.burstEnded || s.fatal || !s.dec || s.splicing) return;
      var d = Math.min(Math.max(s.target, MIN_DELAY), HISTORY_S - 10);
      var need = d + PREROLL * FRAME / s.rate + START_MARGIN * 2 + 0.2;
      var have = live() - oldest();
      if (have >= need) seek(d);
      else s.message = 'waiting for history: ' + have.toFixed(1) + ' of ' + need.toFixed(1) + ' s';
    }

    // Feed the decoder sequentially, keeping only ~LEAD_S of PCM ahead of the play position.
    function pump() {
      var d = s.dec;
      while (d && d.state === 'configured' && !s.needSeek) {
        if (s.feed < s.first) { s.target = currentDelay(); s.needSeek = true; flush(); return; }   // history overran a long pause
        if (s.feed >= s.first + s.frames.length) return;               // caught up with the network
        var inflight = Math.max(0, s.fed - s.outputs) * FRAME;
        if ((s.posted - s.w.consumed + inflight) / s.rate >= LEAD_S || d.decodeQueueSize >= MAX_QUEUE) return;
        if (!s.verified && s.fed >= 40) { nextMode(); if (s.fatal) return; flush(); s.needSeek = true; return maybeSeek(); }
        var f = s.frames[s.feed - s.first], data = s.mode === 'raw' ? f.subarray(adtsHeader(f, 0).hdr) : f;
        try {
          d.decode(new EncodedAudioChunk({ type: 'key', timestamp: s.feed * FRAME * 1e6 / s.rate, duration: FRAME * 1e6 / s.rate, data: data }));
        } catch (e) { return onDecodeError(e); }
        s.feed++; s.fed++;
      }
    }

    function onWorklet(m) {
      if (m.t === 'tap') { if (opts._tap) opts._tap({ seg: m.seg, pos: m.pos, frame: m.frame, media: segMediaBySeg[m.seg], l: m.l, r: m.r }); return; }
      if (m.seg !== s.seg) { s.w.underruns = m.underruns; s.w.dropped = m.dropped; return; }
      s.w = m;
      var raw = rawDelay();
      if (raw !== null) s.delayEst = s.delayEst === null || Math.abs(raw - s.delayEst) > 0.05 ? raw : s.delayEst + 0.3 * (raw - s.delayEst);
      pump();
    }
    // Context time of the sample reaching the speaker now. getOutputTimestamp() includes the output
    // latency and is not quantised like ctx.currentTime (which jumps once per audio callback).
    function audibleCtxTime() {
      try {
        var o = ctx.getOutputTimestamp && ctx.getOutputTimestamp();
        if (o && o.performanceTime > 0) return o.contextTime + nowS() - o.performanceTime / 1000;
      } catch (e) { /* fall through */ }
      return ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
    }
    function rawDelay() {
      if (!s.segPlayed || !ctx || s.w.consumed <= 0) return null;
      // consumed samples end at context time lastOut; that point is heard once the output latency has passed.
      // While flowing this extrapolates; while stopped (pause, underrun) the heard position stays put.
      var ahead = audibleCtxTime() - s.w.lastOut;
      var heard = s.segMedia + s.w.consumed / s.rate + (s.w.flowing ? ahead : Math.min(0, ahead));
      return live() - heard;
    }
    function currentDelay() { return s.delayEst !== null && !s.needSeek ? s.delayEst : s.target; }

    // ---- state / housekeeping (4 Hz) ----
    function tick() {
      try {
        var t = nowS();
        if (!s.burstEnded && s.frames.length && t - s.anchorT >= 1.2) s.burstEnded = true;
        if (s.running && s.lastBytes && t - s.lastBytes > 15 && abort) { s.lastBytes = t; abort.abort(); }   // silent stall
        if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && document.visibilityState === 'visible') resumeCtx();
        maybeSeek();
        // a scheduled start that slipped (decoder too slow) is corrected once or twice by re-seeking
        if (s.w.flowing && !s.paused && s.delayEst !== null && s.w.consumed / s.rate < 1.5 && Math.abs(s.delayEst - s.target) > 0.05 && s.corrections < 2) {
          s.corrections++; s.needSeek = true; maybeSeek();
        }
        pump();
      } catch (e) { fail(e); }
      emit();
    }
    function emit() {
      if (s.fatal) s.status = 'error';
      else if (s.paused) s.status = 'paused';
      else if (!s.burstEnded) { s.status = 'connecting'; s.message = s.splicing ? 'reconnecting' : 'receiving initial burst'; }
      else if (s.w.flowing && ctx && ctx.state === 'running') { s.status = 'playing'; s.message = 'decoder: ' + s.mode; }
      else {
        s.status = 'waiting';
        if (ctx && ctx.state !== 'running') s.message = 'audio ' + ctx.state + ': tap to resume';
        else if (!s.needSeek) s.message = s.segPlayed ? 'network stall, waiting for audio' : 'starting';
      }
      try {
        onState({ status: s.status, delay: getDelay(), bufferedSeconds: s.rate ? received() - oldest() : 0, minDelay: MIN_DELAY, message: s.message });
      } catch (e) { s.lastError = 'onState: ' + errText(e); }
    }

    function resumeCtx() {
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(function (e) { s.lastError = errText(e); });
    }
    function onVisible() { if (document.visibilityState === 'visible') resumeCtx(); }
    var GESTURES = ['pointerdown', 'touchend', 'click', 'keydown'];

    function start() {
      if (startPromise) return startPromise;
      // Synchronous part: must run inside the tap handler for iOS to allow audio.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* optional API */ }
      var AC = global.AudioContext || global.webkitAudioContext;
      try {
        try { ctx = new AC({ sampleRate: opts._sampleRate || 44100, latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
      } catch (e) { fail(e, true); return (startPromise = Promise.resolve()); }
      resumeCtx();
      try {                                                             // silent one-sample buffer: unlocks old iOS output
        var src = ctx.createBufferSource(); src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); src.connect(ctx.destination); src.start(0);
      } catch (e) { /* not needed elsewhere */ }
      s.running = true;
      GESTURES.forEach(function (g) { document.addEventListener(g, resumeCtx, { capture: true, passive: true }); });
      document.addEventListener('visibilitychange', onVisible);
      ctx.onstatechange = emit;
      timer = setInterval(tick, 250);
      readLoop();
      startPromise = (async function () {
        try {
          var code = '(' + workletMain.toString() + ')()';
          try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))); }
          catch (e) { await ctx.audioWorklet.addModule('data:application/javascript,' + encodeURIComponent(code)); }
          while (!s.info && s.running) await new Promise(function (ok) { setTimeout(ok, 50); });
          if (!s.running) return;
          node = new AudioWorkletNode(ctx, 'sooner-ring', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
            processorOptions: { streamRate: s.rate, tap: !!opts._tap } });
          node.port.onmessage = function (e) { try { onWorklet(e.data); } catch (err) { fail(err); } };
          gain = ctx.createGain(); gain.gain.value = s.muted ? 0 : 1;
          node.connect(gain).connect(ctx.destination);
          node.port.postMessage({ t: 'play', on: !s.paused });
          await pickModes();
          newDecoder();
          maybeSeek();
        } catch (e) { fail(e, true); }
      })();
      return startPromise;
    }

    function stop() {
      s.running = false;
      clearInterval(timer);
      try { if (abort) abort.abort(); } catch (e) { /* ignore */ }
      try { if (s.dec && s.dec.state !== 'closed') s.dec.close(); } catch (e) { /* ignore */ }
      try { if (node) node.disconnect(); if (ctx) ctx.close(); } catch (e) { /* ignore */ }
      GESTURES.forEach(function (g) { document.removeEventListener(g, resumeCtx, { capture: true }); });
      document.removeEventListener('visibilitychange', onVisible);
    }
    function pause() {
      if (s.paused) return;
      s.paused = true;
      if (node) node.port.postMessage({ t: 'play', on: false });
      emit();
    }
    function resume() {
      if (!s.paused) return;
      s.paused = false;
      resumeCtx();
      s.target = currentDelay();          // the paused time is now part of the delay
      if (node) node.port.postMessage({ t: 'play', on: true });
      pump();
      emit();
    }
    function setDelay(sec) {
      s.target = Math.min(Math.max(+sec || 0, MIN_DELAY), HISTORY_S - 10);
      s.corrections = 0;
      if (s.running && node) { flush(); s.needSeek = true; maybeSeek(); }
      emit();
    }
    function getDelay() { return currentDelay(); }
    function setMuted(b) {
      s.muted = !!b;
      if (gain) gain.gain.setTargetAtTime(s.muted ? 0 : 1, ctx.currentTime, 0.005);
    }
    function stats() {
      return {
        sampleRate: ctx ? ctx.sampleRate : 0, streamRate: s.rate, framesReceived: s.framesReceived,
        secondsBuffered: s.rate ? received() - oldest() : 0, decodeErrors: s.decodeErrors, underruns: s.w.underruns,
        queueSeconds: s.rate ? s.w.fill / s.rate : 0, droppedMessages: s.w.dropped, state: s.status, lastError: s.lastError,
        userAgent: navigator.userAgent, decoderMode: s.mode, contextState: ctx ? ctx.state : 'none',
        outputLatency: ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0, reconnects: s.reconnects,
        resyncBytes: s.resyncBytes, timestampGaps: s.tsGaps, liveOffset: s.L
      };
    }
    return { start: start, stop: stop, pause: pause, resume: resume, setDelay: setDelay, getDelay: getDelay, setMuted: setMuted, stats: stats };
  }

  global.SoonerWC = { supported: supported, create: create };
})(typeof window !== 'undefined' ? window : this);
