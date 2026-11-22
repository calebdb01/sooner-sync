/* stations.js - station picker helpers for Sooner Sync.
 * Plain script, no dependencies. Exposes window.SoonerStations.
 * Outbound requests: the Radio Browser directory search and the stream probe. Nothing else.
 * Every request is a "simple" CORS GET: no custom headers (Icecast servers fail preflights),
 * no cookies, no referrer. Network failures come back as values, never as exceptions. */
(function (root) {
  'use strict';

  // ---------- Station objects ----------
  function station(o) {
    return { id: o.id, name: o.name || 'Unnamed station', url: o.url, codec: o.codec || '',
      bitrate: o.bitrate || 0, state: o.state || '', country: o.country || '',
      homepage: o.homepage || '', source: o.source, note: o.note || '' };
  }

  var builtin = [station({ id: 'krxo', name: '107.7 The Franchise (Oklahoma City)',
    url: 'https://das-edge60-sa48-futuri-chi03.cdnstream.com/11317_96k.aac', codec: 'AAC',
    bitrate: 96, state: 'Oklahoma', country: 'US', homepage: '', source: 'builtin', note: 'Oklahoma Sooners flagship' })];

  function fromUrl(url) {
    var u;
    try { u = new URL(String(url).trim()); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    var ext = (u.pathname.match(/\.(\w+)$/) || [])[1] || '';
    return station({ id: 'custom:' + u.href, name: u.hostname, url: u.href, source: 'custom',
      codec: /^aac$/i.test(ext) ? 'AAC' : /^mp3$/i.test(ext) ? 'MP3' : '' });
  }

  // ---------- Small fetch helper: timeout, never throws ----------
  var BASE_OPTS = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' };

  function get(url, timeoutMs, extra) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs);
    var opts = Object.assign({}, BASE_OPTS, extra || {}, ctl ? { signal: ctl.signal } : {});
    return fetch(url, opts).then(
      function (res) { return { res: res, ctl: ctl, timer: timer }; },
      function (err) { clearTimeout(timer); return { error: err, timedOut: !!(ctl && ctl.signal.aborted) }; });
  }

  // ---------- Directory search (Radio Browser) ----------
  // The API docs say: get the server list, randomise it, retry the next server on failure.
  // Browsers cannot do reverse DNS, so we ask all.api.radio-browser.info/json/servers and
  // merge in known names in case that call fails. A browser cannot set User-Agent, so none is sent.
  var KNOWN = ['de1', 'de2', 'fi1'].map(function (h) { return 'https://' + h + '.api.radio-browser.info'; });
  var serverCache = null, goodServer = null;

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function servers() {
    if (serverCache) return Promise.resolve(serverCache);
    return get('https://all.api.radio-browser.info/json/servers', 4000).then(function (r) {
      if (r.error || !r.res.ok) return [];
      clearTimeout(r.timer);
      return r.res.json().then(function (list) {
        return list.map(function (s) { return 'https://' + s.name; });
      }, function () { return []; });
    }).then(function (found) {
      var all = shuffle(found.concat(KNOWN).filter(function (s, i, a) { return a.indexOf(s) === i; }));
      if (found.length) serverCache = all; // only cache a list the network actually confirmed
      return all;
    });
  }

  function apiGet(path) {
    return servers().then(function (list) {
      if (goodServer) list = [goodServer].concat(list.filter(function (s) { return s !== goodServer; }));
      var i = 0;
      function next() {
        if (i >= list.length) return null;
        var base = list[i++];
        return get(base + path, 6000).then(function (r) {
          if (r.error || !r.res.ok) return next();
          return r.res.json().then(function (data) { clearTimeout(r.timer); goodServer = base; return data; }, next);
        });
      }
      return next();
    });
  }

  var PLAYABLE_CODECS = /^(MP3|AAC|AAC\+|UNKNOWN|)$/i;

  // Usable here = direct https stream, not HLS, passing the directory's own online check,
  // in a codec the audio engine can parse. CORS cannot be known in advance; probe() tests it.
  function usable(s) {
    var u = String(s.url_resolved || '');
    return /^https:\/\//i.test(u) && !s.hls && s.lastcheckok === 1 && !/\.m3u8(\?|$)/i.test(u) &&
      PLAYABLE_CODECS.test(String(s.codec || '').trim());
  }

  function relevance(name, q) {
    name = name.toLowerCase(); q = q.toLowerCase();
    if (name === q) return 4;
    if (name.indexOf(q) === 0) return 3;
    if (new RegExp('(^|[^a-z0-9])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])').test(name)) return 2;
    return name.indexOf(q) >= 0 ? 1 : 0;
  }

  function search(query, opts) {
    var q = String(query || '').trim();
    var limit = (opts && opts.limit) || 25;
    if (!q) return Promise.resolve([]);
    var path = '/json/stations/search?hidebroken=true&order=clickcount&reverse=true&limit=200&name=' + encodeURIComponent(q);
    return apiGet(path).then(function (rows) {
      if (!Array.isArray(rows)) return [];
      var seen = {};
      return rows.filter(usable).filter(function (s) {
        var key = s.url_resolved.replace(/\/+$/, '');
        if (seen[key]) return false;
        return (seen[key] = true);
      }).map(function (s) { s._rel = relevance(s.name.trim(), q); return s; }).sort(function (a, b) {
        return (b._rel - a._rel) || ((b.votes || 0) - (a.votes || 0)) || ((b.clickcount || 0) - (a.clickcount || 0));
      }).slice(0, limit).map(function (s) {
        return station({ id: s.stationuuid, name: s.name.trim(), url: s.url_resolved, codec: s.codec,
          bitrate: s.bitrate, state: s.state, country: s.countrycode || s.country, homepage: s.homepage,
          source: 'directory' });
      });
    }, function () { return []; });
  }

  // ---------- Frame detection (strict: two consecutive valid headers) ----------
  var ADTS_RATES = 13; // sample-rate indexes 0..12 are valid
  function adtsAt(b, i) {
    if (i + 7 > b.length || b[i] !== 0xFF || (b[i + 1] & 0xF6) !== 0xF0) return 0; // sync 0xFFF, layer 00
    var sr = (b[i + 2] >> 2) & 0x0F;
    if (sr >= ADTS_RATES) return 0;
    var len = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
    return len >= 8 ? { len: len, sr: sr } : 0;
  }

  var MP3_KBPS = { v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
  var MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  function mp3At(b, i) {
    if (i + 4 > b.length || b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) return 0;
    var ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
    var bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return 0; // Layer III only
    var rate = MP3_RATES[ver][sri], kbps = (ver === 3 ? MP3_KBPS.v1 : MP3_KBPS.v2)[bri];
    var len = Math.floor((ver === 3 ? 144000 : 72000) * kbps / rate) + pad;
    return { len: len, ver: ver, sri: sri };
  }

  function detect(b) {
    var start = 0;
    // Skip an ID3v2 tag ("ID3", size as 4 syncsafe bytes) so its body is not scanned.
    if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)
      start = 10 + ((b[6] & 0x7F) << 21 | (b[7] & 0x7F) << 14 | (b[8] & 0x7F) << 7 | (b[9] & 0x7F));
    for (var i = start; i + 8 < b.length; i++) {
      if (b[i] !== 0xFF) continue;
      var a = adtsAt(b, i), n;
      if (a && (n = adtsAt(b, i + a.len)) && n.sr === a.sr) return 'aac';
      var m = mp3At(b, i);
      if (m && (n = mp3At(b, i + m.len)) && n.ver === m.ver && n.sri === m.sri) return 'mp3';
    }
    return null;
  }

  // ---------- probe(url) ----------
  var MSG = {
    cors: 'This station does not allow web players.',
    silent: 'The station did not answer.',
    hls: 'This station uses a stream type this page cannot delay.',
    unknown: 'This station uses a stream type this page cannot delay.',
    http: 'This station only streams over plain http, which a secure page cannot use.',
    bad: 'That does not look like a web address.',
    playlist: 'That link is a playlist with no stream inside it this page can use.'
  };
  var MAX = 65536;
  function fail(reason) { return { ok: false, kind: null, reason: reason }; }
  var isPlaylistType = /mpegurl|scpls|x-pls/i;

  function probe(url, opts, depth) {
    var timeoutMs = (opts && opts.timeoutMs) || 8000;
    var u;
    try { u = new URL(String(url)); } catch (e) { return Promise.resolve(fail(MSG.bad)); }
    var securePage = typeof location === 'undefined' || location.protocol === 'https:';
    if (u.protocol === 'http:' && securePage) return Promise.resolve(fail(MSG.http));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return Promise.resolve(fail(MSG.bad));
    if (/\.m3u8$/i.test(u.pathname)) return Promise.resolve(fail(MSG.hls));
    var listByName = /\.(m3u|pls)$/i.test(u.pathname);

    return get(u.href, timeoutMs).then(function (r) {
      if (r.error) {
        if (r.timedOut) return fail(MSG.silent);
        // A CORS refusal and a dead host look the same to fetch(). An opaque no-cors request
        // tells them apart: it succeeds if the server answered at all.
        return get(u.href, Math.min(timeoutMs, 5000), { mode: 'no-cors' }).then(function (o) {
          if (o.error) return fail(MSG.silent);
          clearTimeout(o.timer); if (o.ctl) o.ctl.abort();
          return fail(MSG.cors);
        });
      }
      var res = r.res, ctype = res.headers.get('content-type') || '';
      var done = function (v) { clearTimeout(r.timer); if (r.ctl) r.ctl.abort(); return v; };
      if (!res.ok) return done(fail('The station returned an error (HTTP ' + res.status + ').'));
      if (/vnd\.apple\.mpegurl/i.test(ctype)) return done(fail(MSG.hls));
      if (!res.body || !res.body.getReader) return done(fail(MSG.unknown));
      var reader = res.body.getReader(), buf = new Uint8Array(MAX), got = 0;

      function finish() {
        try { reader.cancel(); } catch (e) { /* ignore */ }
        done(null);
        var head = new TextDecoder().decode(buf.subarray(0, Math.min(got, 4096)));
        var listy = listByName || isPlaylistType.test(ctype) || /^\s*(#EXTM3U|\[playlist\])/i.test(head);
        if (listy) {
          if (/#EXT-X-/i.test(head)) return fail(MSG.hls); // HLS media playlist
          var inner = head.match(/https?:\/\/[^\s"'<>]+/i);
          if (!inner || depth) return fail(MSG.playlist);
          return probe(inner[0], opts, 1); // follow one level only
        }
        var kind = detect(buf.subarray(0, got));
        if (kind) return { ok: true, kind: kind, reason: '' };
        return fail(got ? MSG.unknown : MSG.silent);
      }

      function pump() {
        return reader.read().then(function (c) {
          if (c.done) return finish();
          var take = Math.min(c.value.length, MAX - got);
          buf.set(c.value.subarray(0, take), got); got += take;
          // Stop early once audio frames are certain (saves seconds on a slow live stream).
          if (got >= MAX || (got > 4096 && !listByName && detect(buf.subarray(0, got)))) return finish();
          return pump();
        }, finish); // aborted by timeout or dropped: judge what arrived
      }
      return pump();
    }).catch(function () { return fail(MSG.silent); });
  }

  // ---------- Favorites (localStorage, best effort) ----------
  var KEY = 'soonerSync.favorites';
  function favorites() {
    try { var v = JSON.parse(root.localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function write(list) { try { root.localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* ignore */ } }
  function saveFavorite(s) {
    if (!s || !s.id || !s.url) return;
    write(favorites().filter(function (f) { return f.id !== s.id; }).concat([station(s)]));
  }
  function removeFavorite(id) { write(favorites().filter(function (f) { return f.id !== id; })); }

  root.SoonerStations = { search: search, probe: function (url, opts) { return probe(url, opts, 0); },
    favorites: favorites, saveFavorite: saveFavorite, removeFavorite: removeFavorite,
    builtin: builtin, fromUrl: fromUrl, _detect: detect };
})(typeof window !== 'undefined' ? window : globalThis);
