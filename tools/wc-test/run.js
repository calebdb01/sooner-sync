// usage: node run.js SCENARIO PORT   (scenario: smoke | main | r48 | stall)
const { chromium } = require('playwright');
const http = require('http');
const [scen, port] = [process.argv[2], +process.argv[3]];
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ctl = (q) => new Promise(r => http.get(`${base}/ctl?${q}`, res => { res.resume(); res.on('end', r); }));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const pg = await b.newPage();
  pg.on('console', m => log('[page]', m.text()));
  pg.on('pageerror', e => log('[pageerror]', e.message));
  await pg.goto(`${base}/test.html`);
  const ev = (f, a) => pg.evaluate(f, a);
  const st = () => ev(() => ({ d: T.p.getDelay(), s: T.last && T.last.status, msg: T.last && T.last.message, ...T.p.stats() }));
  const opts = scen === 'r48' ? { _sampleRate: 48000 } : (scen === 'stall' ? { delay: 2.5 } : { delay: 5 });
  const t0 = Date.now();
  await ev((o) => T.run(o), opts);
  let s;
  for (;;) { s = await st(); if (s.s === 'playing' || Date.now() - t0 > 20000) break; await sleep(100); }
  log('time to playing', (Date.now() - t0) / 1000, 's', JSON.stringify(s));

  // sample delay for `sec` seconds, return min/max/mean
  async function watch(sec, label, every = 500) {
    const ds = [], Ls = []; let last;
    for (let i = 0; i < sec * 1000 / every; i++) { last = await st(); if (last.s === 'playing') { ds.push(last.d); Ls.push(last.liveOffset); } await sleep(every); }
    const mn = Math.min(...ds), mx = Math.max(...ds);
    log(label, `n=${ds.length} delay min=${mn.toFixed(4)} max=${mx.toFixed(4)} spread=${(mx - mn).toFixed(4)} liveOffset L drift=${(Math.max(...Ls) - Math.min(...Ls)).toFixed(4)}`,
      `status=${last.s} underruns=${last.underruns} decodeErrors=${last.decodeErrors} dropped=${last.droppedMessages} queue=${last.queueSeconds.toFixed(2)} gaps=${last.timestampGaps} resync=${last.resyncBytes} reconnects=${last.reconnects} mode=${last.decoderMode} sr=${last.sampleRate} outLat=${last.outputLatency} err=${last.lastError}`);
    return { mn, mx, last };
  }
  async function capture(sec, name) {
    await ev(() => { T.taps = []; T.rec = true; });
    await sleep(sec * 1000);
    await ev(() => { T.rec = false; });
    log('uploaded', name, await ev((n) => T.upload(n), name), 'chunks');
  }

  if (scen === 'smoke') { await watch(+(process.env.SECS || 10), 'smoke'); }
  if (scen === 'main' || scen === 'r48') {
    await ev(() => { T.taps = []; T.rec = true; });
    const a = await watch(scen === 'main' ? 60 : 30, 'normal play');
    await ev(() => { T.rec = false; }); log('uploaded normal', await ev(() => T.upload('normal_' + window.__ctx.sampleRate)));
    await ev(() => T.p.pause()); await sleep(5000); await ev(() => T.p.resume());
    await sleep(1500);
    const b2 = await watch(5, 'after pause 5s');
    log('pause delta', ((b2.mn + b2.mx) / 2 - (a.mn + a.mx) / 2).toFixed(4));
    const tS = Date.now(); await ev(() => T.p.setDelay(20));
    for (;;) { s = await st(); if (s.s === 'playing') break; await sleep(50); }
    log('setDelay(20) audible after', (Date.now() - tS) / 1000, 's');
    await sleep(1000);
    await capture(5, 'd20_' + (scen === 'main' ? 44100 : 48000));
    await watch(4, 'delay 20');
    if (scen === 'main') {
      s = await st(); const want = Math.ceil(s.secondsBuffered + 8);
      const tW = Date.now(); await ev((w) => T.p.setDelay(w), want);
      let sawWaiting = false;
      for (;;) { s = await st(); if (s.s === 'waiting') sawWaiting = true; if (s.s === 'playing') break; await sleep(100); }
      log(`setDelay(${want}) with ${'history'} -> waiting seen=${sawWaiting}, playing after ${(Date.now() - tW) / 1000}s`);
      await sleep(1000);
      await capture(5, 'dbig_44100');
      await watch(4, `delay ${want}`);
    }
  }
  if (scen === 'stall') {
    await ev(() => { T.taps = []; T.rec = true; });
    const a = await watch(10, 'before stall');
    await ctl('stall=3');
    await sleep(8000);
    const c = await watch(10, 'after stall');
    log('stall delay growth', ((c.mn + c.mx) / 2 - (a.mn + a.mx) / 2).toFixed(4), 'underruns', c.last.underruns);
    await ctl('drop=1'); log('dropped connection');
    await sleep(6000);
    const d = await watch(10, 'after reconnect');
    log('reconnect delay change', ((d.mn + d.mx) / 2 - (c.mn + c.mx) / 2).toFixed(4));
    await ev(() => { T.rec = false; }); log('uploaded', await ev(() => T.upload('stall_44100')));
  }
  log('states', JSON.stringify(await ev(() => T.states.filter((x, i, a) => i === 0 || a[i - 1][1] !== x[1]).map(x => [Math.round(x[0]), x[1]]))));
  await new Promise(r => http.get(`${base}/info`, res => { let d=''; res.on('data', c => d += c); res.on('end', () => { require('fs').writeFileSync(`out/info_${scen}.json`, d); r(); }); }));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
