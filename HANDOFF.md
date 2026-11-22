# Sooner Sync: handoff brief for a session on the owner's Mac

This brief is for a Claude Code session that runs **on the Mac** (it needs Xcode and the iOS Simulator). If you are a cloud session and cannot run `xcrun simctl`, say so and stop: the simulator test is the reason for this handoff.

## Owner and rules
- The owner is not a developer. Keep messages short, plain and factual. Never invent results: say "I do not know" when you do not. Verify crucial details.
- Never do anything that can damage the computer. Never delete things from the Trash. Ask before installing software.
- Copy that the owner will pass to other people must be in ASD-STE100 simplified English.
- Do not ask the owner for passwords. Do not open the microphone in the page (see findings).

## Setup
1. Work in `~/Documents/sooner-sync`, a clone of `https://github.com/calebdb01/sooner-sync`.
2. Use branch `claude/wonderful-gates-ii1mic` (draft PR #5). It has `index.html` (current live page, to be replaced), `wc-player.js` (new audio engine), `stations.js` (station search), `tools/wc-test/` (engine test harness; `server.py` expects a capture at `tools/real/t1.aac`; make one with `curl -m 240 -o tools/real/t1.aac <stream url>` and do not commit it). Another session may have pushed a new page to this branch; fetch first and build on what is there.
3. The site is served from `main`. The owner opens it on an iPhone (iOS 27.2.1, Safari). How it is hosted is not confirmed; check the repository Pages settings before you promise a URL.
4. Boot an iPhone simulator with the newest iOS runtime (`xcrun simctl`), open pages with `xcrun simctl openurl booted <url>`, take screenshots with `xcrun simctl io booted screenshot`, and use Safari Web Inspector for console output. Serve the repository with a local HTTP server; the simulator can reach `http://localhost:<port>`. Sound needs a tap: ask the owner to tap in the simulator and say what they hear. Make the page POST a diagnostic report to your local server so you get facts without relying on listening.

## The product
A static page that plays a live sports radio stream with an adjustable delay (0 to about 280 s), so the radio call lines up with a TV broadcast that runs behind the radio. Main use: Oklahoma Sooners football. The owner also wants other college football and other sports, by picking a station.

Verified stream: `https://das-edge60-sa48-futuri-chi03.cdnstream.com/11317_96k.aac`. ADTS AAC-LC, 44100 Hz stereo, about 97 kbps, 7-byte headers, one raw block per frame, CORS allowed (echoes Origin). On connect it sends about 31 s of audio as a burst, then real time. The newest audio is at the end of what was received.

## What failed on the real iPhone (all sounded fine in headless Chromium)
1. `createMediaElementSource(audio)` to DelayNode: no effect. WebKit bugs 266922 and 180696 confirm that no samples reach the graph from streams.
2. `decodeAudioData` on 0.5 s ADTS chunks, scheduled back to back: "choppy".
3. ADTS repackaged to fMP4 on ManagedMediaSource with playbackRate steering: "terrible".
4. Same without steering, with a second silent AudioContext for analysis, and microphone-based auto sync: "glitchy", and sync did not work.

Every version opened the microphone for auto sync.

## Research findings (WebKit bugzilla, WebKit source, MDN compat data; none tested on a device)
- Microphone capture on iOS switches the audio session to PlayAndRecord. Bug 326286 (iOS 27): output crackles with echo cancellation on; with it off the output moves to the earpiece at low volume; "audio session state persists after the mic is released". Bug 311451 (iOS 26.4): degraded output while the mic is on. Treat the microphone as a probable cause of the bad audio. **Do not use the microphone.**
- WebCodecs `AudioDecoder` is on iOS Safari from version 26. WebKit's Cocoa decoder strips a 7-byte ADTS header itself when a chunk starts with a sync word, so send exactly one ADTS frame per EncodedAudioChunk with no `description`. An AudioSpecificConfig `description` is a weak point before the Safari 27 branch. `wc-player.js` tries raw+description first, then ADTS; test both orders in the simulator and prefer ADTS-first on Safari if that is what works.
- A Web-Audio-only page gets the Ambient session, which the ring/silent switch mutes. `navigator.audioSession.type = 'playback'` (iOS 16.4+) overrides this. `wc-player.js` sets it; verify.
- AudioContext can go to "interrupted" and stay muted after focus loss; recover with `suspend()` then `resume()` on `visibilitychange`.
- For iPhones older than iOS 26, the ranked fallback is a WASM AAC decoder (`@wasm-audio-decoders/aac` 0.0.1, based on faad2; licence status unclear because faad2 is GPL) in a Worker, feeding the same AudioWorklet. Build it only if the owner needs older phones.
- ManagedMediaSource: no documented cause for the glitches was found. Low priority.

## Competitor findings
- SportSyncRadio is a hardware radio: manual delay only, half-second steps, up to 60 s. Its instructions: match a referee's whistle or a clear play over one or two plays.
- Homestream (homestream.app, native app) syncs by pointing the phone camera at the TV scoreboard and reading the game clock, then offers a manual nudge. No product was found that syncs by listening with the microphone. (From search summaries, not from pages that were opened.)
- Learfield "Sync My Game": pause the audio, resume when the TV catches up; if the audio is behind, pause the TV with the DVR.

## Engine status (`wc-player.js`, global `SoonerWC`)
API: `supported()`, `create({url,onState})`, `start()` (call inside the tap, before any await), `stop()`, `pause()`, `resume()`, `setDelay(s)`, `getDelay()`, `setMuted(b)`, `stats()`.

Design: one continuous AudioDecoder into an AudioWorklet ring buffer (Blob-URL module), 300 s of compressed history, live edge L = max(mediaReceived - now), waits for the connect burst to end, minimum delay 2.5 s, reconnect that splices onto history.

Measured in headless Chromium against a replay of the real capture: output identical to an ffmpeg decode of the same frames over 60 s; 0 decode errors, 0 underruns; `getDelay()` constant within 0.009 s over 60 s; pause 5 s gives +5.0 s; `setDelay(20)` gives 20.000; 48 kHz context path correct; 3 s network stall gives one underrun, the delay grows, nothing is skipped.

Not verified on WebKit: that AudioDecoder accepts the stream in either mode, AudioData copy formats, Blob-URL `addModule`, `getOutputTimestamp`, the 44100 Hz context request, audioSession behaviour, fetch streaming in the background.

## `stations.js` status (global `SoonerStations`)
`search()` (Radio Browser directory, server fallback), `probe(url)` (run-time CORS and AAC/MP3 check with plain-English reasons), `favorites()`, `builtin` (the verified station above), `fromUrl()`.

Coverage is limited: of 10 well-known US sports stations, 4 had a usable directory entry, and The Franchise is not in the directory (it stays built in). 118 US "sports" entries fit the basic filters; CORS on each stream is known only at probe time. Rights blackouts cannot be detected.

## Your job, in order
1. Simulator baseline: load a minimal test page with `wc-player.js` against the real stream in the iOS simulator. Record `stats()` and console errors. Fix what WebKit rejects. Get clean, continuous playback with a stable delay, pause/resume and `setDelay`. The simulator uses the Mac's audio hardware: clean there is strong evidence, not proof, for a real iPhone.
2. Build (or finish) the new `index.html` around `SoonerWC`: no media element, no microphone, no second AudioContext. One Play button; a large delay readout; Pause / Resume as the main sync method ("Tap Pause when the radio calls the snap. Tap Resume when the TV shows that snap."); Sooner / Later nudges (0.25 s per tap, repeat on hold) and a larger step (5 s); Start over (back to live); a note "If the radio is behind the TV, pause the TV". One instruction on screen at a time. Phone width first.
3. Add a small "Copy report" button that puts `stats()`, the user agent and recent state changes on the clipboard, so the owner can paste real device facts.
4. Station picker with `SoonerStations`: built-in station first, search, favorites, paste-a-link, and a probe before play with the plain-English reason on failure. Be honest in the text about limits.
5. Only after 1 to 4 work in the simulator: consider automatic sync. Do not guess. The only proven approach found is reading the on-screen game clock with the camera (Homestream), which also needs the game clock on the radio side; that is an open problem. Propose a plan to the owner before building it.
6. Run `tools/wc-test` in Chromium again after your changes. Merge to `main` only when the simulator result is clean, and tell the owner exactly what was and was not verified.
