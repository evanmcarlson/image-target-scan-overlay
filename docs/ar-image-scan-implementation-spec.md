# AR image target scan effect — implementation spec

## What it is

A full-screen overlay (SVG, positioned on top of the 8th Wall camera canvas) that takes the user through three visual states:

1. **Searching** — a centered "reticle" of 4 corner brackets, gently breathing, with a bottom bar reading "Looking for [target name]" plus a small thumbnail of the target image.
2. **Found / locking** — the moment `xrimagefound` fires, the same 4 brackets animate (ease-out-back, ~450ms, slight overshoot) from the centered reticle into a quad that wraps the actual tracked image, with a color shift from neutral to a "success" color. This is the core "magic" beat — pair it with a short haptic tick and audio chime fired at the start of this animation.
3. **Scanning → confirmed** — once locked, a line sweeps across the tracked quad (~800ms), then the bottom bar updates to "Found — [target name]" with a checkmark, and the brackets do a single pulse (scale 1 → 1.06 → 1, ~350ms).

Brackets are never destroyed/recreated between states — the same 4 elements move, which is what makes the lock feel like a "catch" rather than a UI swap.

The key technical difference from a typical 2D bounding-box overlay: because the image target can be viewed at an angle, its on-screen shape is a skewed quadrilateral, not an axis-aligned rectangle. Everything below is built around tracking 4 independent corner points rather than a single x/y/w/h rect.

## 1. Overlay markup

Add this as a sibling of `<a-scene>` (not inside it), so it sits above the camera canvas:

```html
<div id="scan-overlay" style="position:fixed; inset:0; pointer-events:none; z-index:1000;">
  <svg id="scan-svg" style="width:100%; height:100%;">
    <path id="bracket-tl" class="scan-bracket"/>
    <path id="bracket-tr" class="scan-bracket"/>
    <path id="bracket-br" class="scan-bracket"/>
    <path id="bracket-bl" class="scan-bracket"/>
    <line id="scan-line" style="display:none;"/>
  </svg>
  <div id="scan-status-bar">
    <div id="scan-thumb"><img id="scan-thumb-img"/></div>
    <div>
      <div id="scan-status-text">Looking for ...</div>
    </div>
  </div>
</div>
```

```css
.scan-bracket { fill:none; stroke-width:3; stroke-linecap:round; stroke:#E5E5E5; transition: stroke 0.15s; }
#scan-line { stroke:#6FCF7C; stroke-width:4; stroke-linecap:round; }
#scan-status-bar { position:absolute; left:0; right:0; bottom:0; height:90px; display:flex; align-items:center; gap:12px; padding:0 20px; background:rgba(0,0,0,0.55); }
#scan-thumb { width:32px; height:32px; border-radius:6px; overflow:hidden; border:2px solid transparent; transition: border-color 0.3s; }
#scan-thumb img { width:100%; height:100%; object-fit:cover; }
#scan-status-text { color:#F1EFE8; font-size:15px; font-weight:500; }
.breathing { animation: breathe 1.8s ease-in-out infinite; }
@keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.035); } }
```

## 2. Reticle (searching state)

Define the reticle as 4 fixed screen-space points, centered on the viewport, sized relative to viewport (e.g. 45% of the shorter dimension):

```js
function getReticleCorners() {
  const size = Math.min(window.innerWidth, window.innerHeight) * 0.45;
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  return {
    tl: { x: cx - size/2, y: cy - size/2 },
    tr: { x: cx + size/2, y: cy - size/2 },
    br: { x: cx + size/2, y: cy + size/2 },
    bl: { x: cx - size/2, y: cy + size/2 },
  };
}
```

## 3. Tracking the image target's screen-space corners

Wire this into whatever your sample project already does on `xrimagefound`/`xrimageupdated` — it likely already does something close to the 8th Wall reference pattern:

```js
this.el.sceneEl.addEventListener('xrimagefound', ({detail}) => {
  trackedObject.position.copy(detail.position)
  trackedObject.quaternion.copy(detail.rotation)
  // do NOT also apply detail.scale to trackedObject — see note below
})
```

**Important**: `detail.scaledWidth` and `detail.scaledHeight` are already real-world (scaled) dimensions. If you set `trackedObject.scale.set(detail.scale, ...)` (as the 8th Wall reference snippet does) AND use `scaledWidth`/`scaledHeight` for corner offsets, you'll double-apply scale. Either:
- use a **separate, unscaled** Object3D for corner tracking (position/quaternion from `detail`, scale left at 1), or
- if you reuse the scaled object, divide the corner offsets by `detail.scale`.

Compute the 4 local corner offsets once per `xrimagefound`/`xrimageupdated`:

```js
function setTargetCorners(detail) {
  const w = detail.scaledWidth, h = detail.scaledHeight
  targetLocalCorners = {
    tl: new THREE.Vector3(-w/2,  h/2, 0),
    tr: new THREE.Vector3( w/2,  h/2, 0),
    br: new THREE.Vector3( w/2, -h/2, 0),
    bl: new THREE.Vector3(-w/2, -h/2, 0),
  }
}
```

(This assumes the standard plane convention — width along local X, height along local Y, facing +Z. If your tracked entity's plane is oriented differently, swap axes accordingly — log `detail` once on first `xrimagefound` and sanity-check against what you see on screen.)

Each frame (in a `tick()` on a component attached to `<a-scene>`, so it's synced with 8th Wall's render loop), project the 4 corners to screen pixels:

```js
const camera = sceneEl.camera
const canvasRect = sceneEl.canvas.getBoundingClientRect()

function projectCorner(localVec3, trackedObject3D) {
  const world = localVec3.clone().applyMatrix4(trackedObject3D.matrixWorld)
  world.project(camera) // -> NDC, range -1..1
  return {
    x: (world.x + 1) / 2 * canvasRect.width + canvasRect.left,
    y: (1 - world.y) / 2 * canvasRect.height + canvasRect.top,
  }
}
```

Smooth the result with a lerp toward the new projection each frame to kill jitter from `xrimageupdated`:

```js
function lerpPoint(current, target, f = 0.25) {
  return { x: current.x + (target.x - current.x) * f, y: current.y + (target.y - current.y) * f }
}
```

## 4. Drawing perspective-aware brackets

Given any 4 corner points (`tl`, `tr`, `br`, `bl` — works for both the reticle and the projected target quad), draw an L-bracket at each corner pointing along its two adjacent edges:

```js
function bracketPath(corner, neighborA, neighborB, lenFrac = 0.22) {
  const a = { x: corner.x + (neighborA.x - corner.x) * lenFrac, y: corner.y + (neighborA.y - corner.y) * lenFrac }
  const b = { x: corner.x + (neighborB.x - corner.x) * lenFrac, y: corner.y + (neighborB.y - corner.y) * lenFrac }
  return `M ${a.x} ${a.y} L ${corner.x} ${corner.y} L ${b.x} ${b.y}`
}

function renderBrackets(corners) {
  document.getElementById('bracket-tl').setAttribute('d', bracketPath(corners.tl, corners.tr, corners.bl))
  document.getElementById('bracket-tr').setAttribute('d', bracketPath(corners.tr, corners.br, corners.tl))
  document.getElementById('bracket-br').setAttribute('d', bracketPath(corners.br, corners.bl, corners.tr))
  document.getElementById('bracket-bl').setAttribute('d', bracketPath(corners.bl, corners.tl, corners.br))
}
```

Since this works on any 4-point quad, the lock-on animation is just: animate each of the 4 corner points from `getReticleCorners()` to the projected target corners over ~450ms with an ease-out-back curve, calling `renderBrackets()` each frame with the interpolated points. (Reuse the `lerp`/`easeOutBack`/`animateRect`-style helpers from the earlier demo, generalized from a rect to 4 independent points.)

## 5. Scan-line sweep (perspective-aware)

Interpolate along the left edge (`tl`→`bl`) and right edge (`tr`→`br`) at parameter `t`, draw a line between the two resulting points, and animate `t` from 0→1:

```js
function scanLineEndpoints(corners, t) {
  return {
    left: lerpPoint(corners.tl, corners.bl, t, 1), // f=1 means full lerp at given t
    right: lerpPoint(corners.tr, corners.br, t, 1),
  }
}
```

(rewrite `lerpPoint` to accept `t` directly as the interpolation factor here, separate from the smoothing lerp in step 3 — same math, different use)

## 6. State machine & event wiring

| Trigger | Action |
|---|---|
| Default / "scanning" state (no target currently tracked) | Show reticle at `getReticleCorners()`, add `.breathing` class, brackets stroke = neutral (`#E5E5E5`), status text = "Looking for [target name]" + thumbnail |
| `xrimagefound` | Remove `.breathing`, set brackets stroke = success color (`#6FCF7C`) immediately, fire haptic (`navigator.vibrate(10)`) + audio chime, then animate corners reticle → projected target over 450ms (ease-out-back) |
| on lock animation complete | Run scan-line sweep (~800ms), then hide scan line, set status text = "Found — [target name]" with checkmark icon, pulse brackets once (`.pulse-once`, 350ms) |
| `xrimageupdated` (while locked/confirmed) | Recompute projected corners, apply smoothing lerp (step 3), call `renderBrackets()` — no state change |
| `xrimagelost` | Start a ~400ms debounce timer. If `xrimagefound`/`xrimageupdated` fires before it elapses, cancel the timer. Otherwise, animate corners back to `getReticleCorners()`, restore `.breathing` and neutral color, reset status text |

Since this experience ends at "confirmed" (no further AR content), once confirmed you can choose to either keep tracking via `xrimageupdated` (brackets stay glued to the object as the user moves) or freeze the overlay in its confirmed position as a final state — whichever reads better in testing. If you freeze it, you probably still want `xrimagelost` to revert (in case they were never actually pointed at it and it was a momentary false-positive), but only before the scan/confirm sequence completes — once confirmed fires, treat it as terminal and ignore further `xrimagelost`.

## 7. Things to verify against your sample project

- Confirm `sceneEl.canvas` and `sceneEl.camera` resolve to the right elements (A-Frame sets both on the scene element once initialized).
- Console-log the first `xrimagefound` `detail` object to confirm `scaledWidth`/`scaledHeight` map to horizontal/vertical as expected, and that your tracked plane's local axes match the corner-offset assumptions in step 3.
- Test the lock animation at a steep viewing angle — this is where the perspective-aware brackets (vs. a simple axis-aligned box) should visibly pay off.
