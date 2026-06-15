const TARGET_NAME = 'image'
const NEUTRAL_COLOR = '#E5E5E5'
const SUCCESS_COLOR = '#6FCF7C'
const ANIM_LOCK_MS = 450
const LOST_DEBOUNCE_MS = 400

// --- state ---
let state = 'searching' // 'searching' | 'locking' | 'tracking' | 'unlocking'
let currentCorners = null
let trackedObj = null
let targetLocalCorners = null
let lostTimer = null
let animId = null

// --- DOM refs (set in setupOverlay) ---
let bTL, bTR, bBR, bBL, statusText

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

function easeInQuad(t) { return t * t }

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

function cancelAnim() {
  if (animId) { cancelAnimationFrame(animId); animId = null }
}

function enterSearching() {
  state = 'searching'
  setBracketColor(NEUTRAL_COLOR)
  setSvgBreathing(true)
  statusText.textContent = `Looking for ${TARGET_NAME}`
  currentCorners = getReticleCorners()
  renderBrackets(currentCorners)
}

function onFound(detail, sceneEl) {
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

  cancelAnim()
  setSvgBreathing(false)
  setBracketColor(SUCCESS_COLOR)
  state = 'locking'

  const from = currentCorners || getReticleCorners()
  animate(from, projected, easeOutBack, () => {
    state = 'tracking'
    statusText.innerHTML = `Found &#10003; ${TARGET_NAME}`
  })
}

function onLost() {
  cancelAnim()
  setBracketColor(NEUTRAL_COLOR)
  state = 'unlocking'

  animate(currentCorners, getReticleCorners(), easeInQuad, () => {
    enterSearching()
  })
}

function animate(from, to, easeFn, onComplete) {
  const start = performance.now()
  function step(now) {
    const t = Math.min((now - start) / ANIM_LOCK_MS, 1)
    currentCorners = lerpCorners(from, to, easeFn(t))
    renderBrackets(currentCorners)
    if (t < 1) {
      animId = requestAnimationFrame(step)
    } else {
      animId = null
      onComplete()
    }
  }
  animId = requestAnimationFrame(step)
}

// ── scene wiring ──────────────────────────────────────────────────────────────

function setupOverlay(sceneEl) {
  bTL = document.getElementById('bracket-tl')
  bTR = document.getElementById('bracket-tr')
  bBR = document.getElementById('bracket-br')
  bBL = document.getElementById('bracket-bl')
  statusText = document.getElementById('scan-status-text')

  trackedObj = new THREE.Object3D()
  sceneEl.object3D.add(trackedObj)

  sceneEl.addEventListener('xrimagefound', ({ detail }) => {
    console.log('[scan] xrimagefound', detail)
    onFound(detail, sceneEl)
  })

  sceneEl.addEventListener('xrimageupdated', ({ detail }) => {
    trackedObj.position.copy(detail.position)
    trackedObj.quaternion.copy(detail.rotation)
    trackedObj.updateMatrixWorld(true)
    if (state === 'tracking') {
      const w = detail.scaledWidth * detail.scale, h = detail.scaledHeight * detail.scale
      targetLocalCorners = {
        tl: new THREE.Vector3(-w / 2,  h / 2, 0),
        tr: new THREE.Vector3( w / 2,  h / 2, 0),
        br: new THREE.Vector3( w / 2, -h / 2, 0),
        bl: new THREE.Vector3(-w / 2, -h / 2, 0),
      }
      const projected = computeProjectedCorners(sceneEl)
      if (projected) { currentCorners = projected; renderBrackets(currentCorners) }
    }
  })

  sceneEl.addEventListener('xrimagelost', () => {
    if (lostTimer) clearTimeout(lostTimer)
    lostTimer = setTimeout(() => {
      lostTimer = null
      onLost()
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
