// Port Solace — keyboard + mouse state.
// Poll-based: the sim reads held keys every step, and one-shot actions use
// takePressed(), which consumes a latched "went down this frame" flag.
// main.js calls endFrame() once per rendered frame to clear the latches.

const held = new Set();     // KeyboardEvent.code values currently down
const latched = new Set();  // codes that went down since the last endFrame

export const mouse = {
  x: 0,          // canvas-space px
  y: 0,
  down: false,   // left button held
  pressed: false // left button went down since the last endFrame
};

let attached = false;

export function attachInput(canvas) {
  if (attached || typeof window === 'undefined') return;
  attached = true;

  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
    if (!e.repeat) latched.add(e.code);
    held.add(e.code);
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => {
    held.clear();
    latched.clear();
    mouse.down = false;
  });

  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
    mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
  };
  canvas.addEventListener('mousemove', toCanvas);
  canvas.addEventListener('mousedown', (e) => {
    toCanvas(e);
    if (e.button === 0) {
      if (!mouse.down) mouse.pressed = true;
      mouse.down = true;
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouse.down = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Is this KeyboardEvent.code currently held down?
export function isDown(code) {
  return held.has(code);
}

// True once per physical press; consumes the latch.
export function takePressed(code) {
  if (!latched.has(code)) return false;
  latched.delete(code);
  return true;
}

// True once per left mouse click; consumes the latch.
export function takeMousePressed() {
  if (!mouse.pressed) return false;
  mouse.pressed = false;
  return true;
}

function axis(negCodes, posCodes) {
  let v = 0;
  if (negCodes.some((c) => held.has(c))) v -= 1;
  if (posCodes.some((c) => held.has(c))) v += 1;
  return v;
}

// On-foot movement intent: {x, y} each in -1..1 (not normalised; the
// player module normalises so diagonals are not faster).
export function walkAxis() {
  return {
    x: axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
    y: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
  };
}

// Driving intent: steer -1 (left) .. +1 (right), throttle -1 (reverse /
// brake) .. +1 (accelerate).
export function driveAxis() {
  return {
    steer: axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
    throttle: axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']),
  };
}

// Clear per-frame latches. Call once at the end of each rendered frame.
export function endFrame() {
  latched.clear();
  mouse.pressed = false;
}
