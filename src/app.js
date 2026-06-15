const TARGET_NAME = 'image'
const NEUTRAL_COLOR = '#E5E5E5'
const SUCCESS_COLOR = '#6FCF7C'
const ANIM_LOCK_MS = 450
const ANIM_SCAN_MS = 800
const ANIM_PULSE_MS = 350
const LOST_DEBOUNCE_MS = 400

// --- state ---
let state = 'searching' // 'searching' | 'locking' | 'scanning' | 'confirmed'
let currentCorners = null
let trackedObj = null       // unscaled THREE.Object3D — position/quaternion only
let targetLocalCorners = null
let lostTimer = null
let lockAnimId = null
let scanAnimId = null

// --- DOM refs (set in setupOverlay) ---
let bTL, bTR, bBR, bBL, scanLine, statusText

// ── geometry helpers ─────────────────────────────────────────────────────────

function getReticleCorners() {
  const size = Math.min(window.innerWidth, window.innerHeight) * 0.45
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2
  return {
    tl: { x: cx - size / 2, y: cy - size / 2 },
    tr: { x: cx + size / 2, y: cy - size / 2 },
    br: { x: cx + size / 2, y: cy + size / 2 },
    bl: { x: cx - size / 2, y: cy + size / 2 },
  }
}

function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function lerpCorners(from, to, t) {
  return {
    tl: lerpPt(from.tl, to.tl, t),
    tr: lerpPt(from.tr, to.tr, t),
    br: lerpPt(from.br, to.br, t),
    bl: lerpPt(from.bl, to.bl, t),
  }
}

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function projectCorner(localVec3, obj3D, camera, canvasRect) {
  const world = localVec3.clone().applyMatrix4(obj3D.matrixWorld)
  world.project(camera)
  return {
    x: (world.x + 1) / 2 * canvasRect.width + canvasRect.left,
    y: (1 - world.y) / 2 * canvasRect.height + canvasRect.top,
  }
}

function computeProjectedCorners(sceneEl) {
  if (!trackedObj || !targetLocalCorners) return null
  const rect = sceneEl.canvas.getBoundingClientRect()
  const cam = sceneEl.camera
  return {
    tl: projectCorner(targetLocalCorners.tl, trackedObj, cam, rect),
    tr: projectCorner(targetLocalCorners.tr, trackedObj, cam, rect),
    br: projectCorner(targetLocalCorners.br, trackedObj, cam, rect),
    bl: projectCorner(targetLocalCorners.bl, trackedObj, cam, rect),
  }
}

// ── SVG bracket drawing ───────────────────────────────────────────────────────

function bracketPath(corner, neighborA, neighborB, lenFrac = 0.22) {
  const a = lerpPt(corner, neighborA, lenFrac)
  const b = lerpPt(corner, neighborB, lenFrac)
  return `M ${a.x} ${a.y} L ${corner.x} ${corner.y} L ${b.x} ${b.y}`
}

function renderBrackets(corners) {
  bTL.setAttribute('d', bracketPath(corners.tl, corners.tr, corners.bl))
  bTR.setAttribute('d', bracketPath(corners.tr, corners.br, corners.tl))
  bBR.setAttribute('d', bracketPath(corners.br, corners.bl, corners.tr))
  bBL.setAttribute('d', bracketPath(corners.bl, corners.tl, corners.br))
}

function setBracketColor(color) {
  ;[bTL, bTR, bBR, bBL].forEach(el => (el.style.stroke = color))
}

function setSvgBreathing(on) {
  document.getElementById('scan-svg').classList.toggle('breathing', on)
}

// ── audio ─────────────────────────────────────────────────────────────────────

function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.1)
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
    osc.start()
    osc.stop(ctx.currentTime + 0.4)
  } catch (e) {}
}

// ── state transitions ─────────────────────────────────────────────────────────

function enterSearching() {
  if (lockAnimId) { cancelAnimationFrame(lockAnimId); lockAnimId = null }
  if (scanAnimId) { cancelAnimationFrame(scanAnimId); scanAnimId = null }
  state = 'searching'
  setBracketColor(NEUTRAL_COLOR)
  setSvgBreathing(true)
  scanLine.style.display = 'none'
  statusText.textContent = `Looking for ${TARGET_NAME}`
  currentCorners = getReticleCorners()
  renderBrackets(currentCorners)
}

function onFound(detail, sceneEl) {
  if (state === 'confirmed') return
  if (lostTimer) { clearTimeout(lostTimer); lostTimer = null }

  trackedObj.position.copy(detail.position)
  trackedObj.quaternion.copy(detail.rotation)
  trackedObj.updateMatrixWorld(true)

  const w = detail.scaledWidth * detail.scale, h = detail.scaledHeight * detail.scale
  targetLocalCorners = {
    tl: new THREE.Vector3(-w / 2,  h / 2, 0),
    tr: new THREE.Vector3( w / 2,  h / 2, 0),
    br: new THREE.Vector3( w / 2, -h / 2, 0),
    bl: new THREE.Vector3(-w / 2, -h / 2, 0),
  }

  const projected = computeProjectedCorners(sceneEl)
  if (!projected) return

  if (navigator.vibrate) navigator.vibrate(10)
  playChime()

  setSvgBreathing(false)
  setBracketColor(SUCCESS_COLOR)
  state = 'locking'

  const from = currentCorners || getReticleCorners()
  animateLock(from, projected, () => {
    currentCorners = projected
    runScanLine(projected, () => {
      pulseBrackets(projected)
    })
  })
}

function animateLock(from, to, onComplete) {
  const start = performance.now()
  if (lockAnimId) cancelAnimationFrame(lockAnimId)
  function step(now) {
    const t = Math.min((now - start) / ANIM_LOCK_MS, 1)
    currentCorners = lerpCorners(from, to, easeOutBack(t))
    renderBrackets(currentCorners)
    if (t < 1) {
      lockAnimId = requestAnimationFrame(step)
    } else {
      lockAnimId = null
      onComplete()
    }
  }
  lockAnimId = requestAnimationFrame(step)
}

function runScanLine(lockedCorners, onComplete) {
  state = 'scanning'
  scanLine.style.display = ''
  const start = performance.now()
  if (scanAnimId) cancelAnimationFrame(scanAnimId)
  function step(now) {
    const t = Math.min((now - start) / ANIM_SCAN_MS, 1)
    const left = lerpPt(lockedCorners.tl, lockedCorners.bl, t)
    const right = lerpPt(lockedCorners.tr, lockedCorners.br, t)
    scanLine.setAttribute('x1', left.x)
    scanLine.setAttribute('y1', left.y)
    scanLine.setAttribute('x2', right.x)
    scanLine.setAttribute('y2', right.y)
    if (t < 1) {
      scanAnimId = requestAnimationFrame(step)
    } else {
      scanAnimId = null
      scanLine.style.display = 'none'
      onComplete()
    }
  }
  scanAnimId = requestAnimationFrame(step)
}

function pulseBrackets(lockedCorners) {
  statusText.innerHTML = `Found &#10003; ${TARGET_NAME}`
  const cx = (lockedCorners.tl.x + lockedCorners.tr.x + lockedCorners.br.x + lockedCorners.bl.x) / 4
  const cy = (lockedCorners.tl.y + lockedCorners.tr.y + lockedCorners.br.y + lockedCorners.bl.y) / 4
  const start = performance.now()
  function step(now) {
    const t = Math.min((now - start) / ANIM_PULSE_MS, 1)
    const s = 1 + 0.06 * Math.sin(t * Math.PI)
    renderBrackets({
      tl: { x: cx + (lockedCorners.tl.x - cx) * s, y: cy + (lockedCorners.tl.y - cy) * s },
      tr: { x: cx + (lockedCorners.tr.x - cx) * s, y: cy + (lockedCorners.tr.y - cy) * s },
      br: { x: cx + (lockedCorners.br.x - cx) * s, y: cy + (lockedCorners.br.y - cy) * s },
      bl: { x: cx + (lockedCorners.bl.x - cx) * s, y: cy + (lockedCorners.bl.y - cy) * s },
    })
    if (t < 1) {
      requestAnimationFrame(step)
    } else {
      state = 'confirmed'
      renderBrackets(lockedCorners)
    }
  }
  requestAnimationFrame(step)
}

// ── scene wiring ──────────────────────────────────────────────────────────────

function setupOverlay(sceneEl) {
  bTL = document.getElementById('bracket-tl')
  bTR = document.getElementById('bracket-tr')
  bBR = document.getElementById('bracket-br')
  bBL = document.getElementById('bracket-bl')
  scanLine = document.getElementById('scan-line')
  statusText = document.getElementById('scan-status-text')

  // Unscaled Object3D for corner projection — added to scene so matrixWorld updates each frame
  trackedObj = new THREE.Object3D()
  sceneEl.object3D.add(trackedObj)

  sceneEl.addEventListener('xrimagefound', ({ detail }) => {
    console.log('[scan] xrimagefound', detail) // first-time sanity check
    onFound(detail, sceneEl)
  })

  sceneEl.addEventListener('xrimageupdated', ({ detail }) => {
    if (state === 'confirmed') return
    trackedObj.position.copy(detail.position)
    trackedObj.quaternion.copy(detail.rotation)
    trackedObj.updateMatrixWorld(true)
  })

  sceneEl.addEventListener('xrimagelost', () => {
    if (state === 'confirmed') return
    if (lostTimer) clearTimeout(lostTimer)
    lostTimer = setTimeout(() => {
      lostTimer = null
      if (state !== 'confirmed') enterSearching()
    }, LOST_DEBOUNCE_MS)
  })

  window.addEventListener('resize', () => {
    if (state === 'searching') {
      currentCorners = getReticleCorners()
      renderBrackets(currentCorners)
    }
  })

  enterSearching()
}

// ── boot ──────────────────────────────────────────────────────────────────────

const onxrloaded = () => {
  XR8.XrController.configure({
    imageTargetData: [require('../image-targets/image.json')],
  })
}
window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded)

document.addEventListener('DOMContentLoaded', () => {
  const sceneEl = document.querySelector('a-scene')
  if (sceneEl.hasLoaded) {
    setupOverlay(sceneEl)
  } else {
    sceneEl.addEventListener('loaded', () => setupOverlay(sceneEl))
  }
})
