# image-target-scan-overlay

A scan-and-lock UI overlay for 8th Wall + A-Frame image target experiences. When the camera finds the target image, corner brackets animate from a centered reticle onto the tracked quad, a scan line sweeps across it, and the experience confirms. No AR content required beyond that beat.

## How it works

Three visual states, driven by 8th Wall's image tracking events:

**Searching** — 4 corner brackets breathe gently at the center of the screen. Bottom bar shows "Looking for image" with a thumbnail of the target.

**Found / locking** — on `xrimagefound`, brackets animate from the reticle to wrap the tracked image (450ms ease-out-back, slight overshoot). Color shifts from grey to green. Fires `navigator.vibrate(10)` and a short Web Audio chime at the start.

**Confirmed** — a line sweeps across the tracked quad (800ms), then the status bar reads "Found ✓ image" and the brackets pulse once. Terminal state — `xrimagelost` is ignored from this point on.

The brackets are never destroyed and recreated between states — the same 4 SVG elements move, which is what makes the lock feel like a catch rather than a UI swap.

### Perspective-aware corners

Because the target can be viewed at an angle, the overlay tracks 4 independent corner points rather than an axis-aligned bounding box. Each frame, the corners of the tracked plane are projected from 3D world space to screen pixels via `Vector3.project(camera)`, so the bracket quad skews correctly at steep viewing angles.

A separate unscaled `THREE.Object3D` is used for corner tracking — `detail.scaledWidth` / `detail.scaledHeight` from 8th Wall already incorporate scale, so keeping the object at `scale(1,1,1)` avoids double-applying it.

## Project structure

```
src/
  app.js          — XR8 config + full overlay state machine
  index.html      — A-Frame scene + overlay markup + styles
  assets/
    image_thumbnail.png   — shown in the status bar while searching
    transparent.png       — hologram texture (original sticker content)
image-targets/
  image.json      — target metadata (PLANAR, auto-loaded)
  image_target.png
config/
  webpack.config.js
```

## Setup

Requires Node/npm. Install with [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org/en/download).

```bash
npm install
```

## Development

```bash
npm run serve
```

### Testing on mobile

AR camera access requires HTTPS. Use [ngrok](https://ngrok.com/) to tunnel to localhost — the dev server already allows `.ngrok-free.dev` hosts.

## Build

```bash
npm run build
```

Output goes to `dist/`. Host it anywhere.

## Customizing

**Target name** — change `TARGET_NAME` at the top of `src/app.js`. This controls the status bar text.

**Colors** — `NEUTRAL_COLOR` (searching brackets) and `SUCCESS_COLOR` (locked brackets + scan line) are constants at the top of `src/app.js`.

**Animation timing** — `ANIM_LOCK_MS` (bracket snap), `ANIM_SCAN_MS` (scan line), `ANIM_PULSE_MS` (final bracket pulse), `LOST_DEBOUNCE_MS` (delay before reverting to searching on lost).

**Target image** — replace `image-targets/image_target.png` and upload a new target in the [8th Wall Console](https://www.8thwall.com). Update `image-targets/image.json` and `src/assets/image_thumbnail.png` to match.

**Corner axes** — if the bracket quad is rotated relative to the actual target, the local plane axes don't match expectations. Console-log `detail` on the first `xrimagefound` and swap X/Y in the `targetLocalCorners` block in `src/app.js` if needed.
