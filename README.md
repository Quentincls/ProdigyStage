# PRODIGY STAGE

Previz, timeline and scene editor for the "Prodigy 12" show (Brussels, Place
De Brouckère). The software listens to the Art-Net a ChamSys console sends to
the rig, shows the room in real-time 3D, lets a team without a lighting
designer draw their own scenes on the show's timeline, and — once commissioned
on site — plays those scenes on the real fixtures as a man-in-the-middle.

## Where it stands (2026-07-27)

- [x] **Phase 0** — foundation: monorepo, patch.json checked against the official lighting documentation, fake-show
- [x] **Phase 1** — Art-Net listening (UDP 6454), DMX monitor, double-click package v0
- [x] **Phase 2** — 3D previz (32 instanced Tamboras, bloom, 60 fps, camera views 1/2/3)
- [x] **Phase 3** — Placement mode (3D picking + fields, saves patch.json), resilience, package v1
- [x] **Phase 4** — Art-Net timecode, timeline (ruler / playhead / markers → show.json), run recorder and replay
- [x] UX/UI pass (hover/focus/transitions, reduced-motion, fixed dock layout) — package v2
- [x] **Phase 5** — scene editor: deterministic shared effect engine in `/core`
      (solid/gradient/wave/chase/sparkle), scenes and tracks in show.json,
      editing panel (group + effect + ≤4 controls + fades), looping preview,
      scrub, presets. Visible in the previz only.
- [x] **Phase 5.5** — simplicity pass: Watch/Edit modes, Tools menu (monitor,
      placement, runs), direct manipulation on the timeline (drag to move,
      edges to trim, click to scrub), single-look editor with Advanced folded
      away, status written as sentences.
- [x] **Deep UX pass** — magnetic no-overlap rule (no multi-track), undo/redo
      with Ctrl+Z, mini-map and Fit, scene blocks tinted with their look's
      colour, trim handles, now playing, duplicate, Space/Escape shortcuts.
- [x] **Validated against the real console feed** (venue recording, 2026-07-27):
      universes confirmed, Tambora "Standard RGB" 61-channel mode identified
      (fixture-wide RGBW on 1–4, 16-bit dimmer on 7–8, motorised tilt on 9–10).
      The previz follows colour, intensity and movement.
- [x] **Phase 6** — Art-Net man-in-the-middle output: passthrough measured at
      ~0.2 ms, scene substitution with a 0.5 s crossfade (the `/core` engine
      runs server-side too), blackout, 250 ms watchdog, press-and-hold to arm.
      **Built and tested off site — commissioning at the venue is next.**
- [x] **UX/UI passes (evening of 2026-07-27)** — previz framed on the rig with
      haze sheets and halos, transport controls (pause / local playback /
      LIVE), 31 built-in looks, a real hierarchy in the scene panel, Watch
      turned into a control-room monitor (timecode, progress, what is playing
      and what comes next), sections turned into the show's table of contents
      (movable, resizable, click to travel there), previz honest about the
      rig's real resolution, and a commissioning guide for the client.

**An install without `data/output.json` sends NOTHING and cannot send**: no
target means nothing leaves the machine. That is the state the client receives.

## Next steps

1. **Commission Phase 6, in a rehearsal on site only**, with the lighting
   operator: reroute the console to the computer, put the rig's address in
   `data/output.json`, then walk through `spectator` → check the room is
   identical → `armed` on a test scene → blackout → kill the console. Nothing
   is irreversible: `off` hands control straight back.
2. **Previz finishing touches**: tilt direction and zero to calibrate on site
   (`tiltInvert` in the patch), strobe flashes, CTO. A recording of the real
   timecoded show to confirm what the pixel zone does during the performance.
3. **Phase 7** — production comfort: headless multi-station, universes 5–8,
   volumetric beams, shadow mode.

## Phase 6 test bench (no rig, no console)

```
npm test    # core engine + output (safety, passthrough, merge, watchdog)
```

End to end locally: write `data/output.json` with
`{"targets":["127.0.0.1"],"port":6455}` (a port that is NOT ours), run a UDP
sink on 6455, use `npm run fake-show` as the console, then drive `/api/output`
(`spectator` → `armed` → `blackout`). Verified this way: nothing is sent while
`off`, byte-exact passthrough, the scene substituted exactly on its timecode,
the console taking back over at the end, blackout holding with the console
killed, and the watchdog cutting output within 250 ms.

## Requirements

- Node.js ≥ 20 (tested with Node 26)

## Commands

```
npm install            # installs core + server + ui (workspaces)
npm run dev            # server (watch, web on 4480) + Vite UI on http://localhost:3019
npm run fake-show      # Art-Net test generator -> 127.0.0.1:6454, universes 1-4 + 25 fps timecode
npm run replay -- data/recordings/run-XXX.artrec  # replays a recorded run
npm run generate-patch # regenerates data/patch.json from scripts/generate-patch.mjs
npm test               # /core engine self-test + Phase 6 output self-test
npm run build          # builds core + server (tsc) + UI (vite)
npm run package        # produces dist-package/LumenStage-Previz-v3.zip (Windows + Mac)
```

## Architecture

```
ChamSys console ──Art-Net UDP 6454──> /server (Node TS)
                                        │  4x512 DMX state + stats
                                        ├──WebSocket :4480 (~40 fps)──> /ui previz
                                        └──Art-Net out (Phase 6, off by default)──> rig

npm run fake-show emulates the console on 127.0.0.1 so the app can be developed
without MagicQ. Packaged, the server also serves the built UI on
http://localhost:4480.
```

- `/core` — shared deterministic effect engine, an npm workspace consumed by
  both the browser previz and the server output. Pure TS, zero dependencies.
- `/server` — Art-Net reception (hand-rolled ArtDMX parser), state, WebSocket
  bridge, and `output.ts`: the one and only module that transmits to the rig.
- `/ui` — 3D previz, timeline, scene editor, DMX monitor.
- `/data/patch.json` — the whole rig as data, hot-reloadable. Generated from
  the official patch list (checked against the lighting PDF, pp. 28–29).
- `/scripts` — patch generator, double-click launchers, packaging.
- `/docs` — conventions and architecture
  ([docs/architecture.md](docs/architecture.md), in French), plus the client
  guide shipped inside the zip (`docs/client/README.html`, in English).

## Roadmap

Phases 0→7 from the master brief: 0 foundation · 1 listening + monitor +
package v0 · 2 3D previz · 3 polish + placement · 4 timecode + timeline ·
5 scene editor · 6 Art-Net output (man-in-the-middle) · 7 production comfort.
