// Port Solace — boot, the frame loop, and the state machine.
//
// The sim runs on a fixed 120 Hz accumulator (dt clamped, a step
// cap per frame so a hiccup can't spiral); rendering happens once
// per animation frame. States:
//   title    — the demo world drives itself behind the title card;
//              any key/click starts (N = new game, erasing the save)
//   play     — the game itself
//   pause    — Esc / P, sim frozen
//   over     — busted/wasted card for ~2.6s (respawnPlayer has
//              already been applied inside the step that set the
//              outcome), then back to play
//   complete — shown once when the fifth job lands, then free roam
//
// Screenshot scenes: ?shot=title|chase|harbor|complete&seed=N
// stages a deterministic scene, fast-forwards ~2.5s of sim, sets
// window.__shotReady = true and keeps the scene alive on screen.
// window.__world always points at the live world, for debugging.

import {
  attachInput, endFrame, isDown, takePressed, takeMousePressed,
  mouse, walkAxis, driveAxis,
} from './input.js';
import { createWorld, stepWorld } from './world.js';
import {
  draw, drawTitle, drawBanner, drawBustedWasted, drawComplete, computeCamera,
} from './render.js';
import { unlockAudio, toggleMute } from './audio.js';
import { clearSave } from './save.js';

const STEP = 1 / 120;
const MAX_STEPS = 16;
const OVER_SECONDS = 2.6;

const ZERO_INPUT = {
  walkAxis: () => ({ x: 0, y: 0 }),
  driveAxis: () => ({ steer: 0, throttle: 0 }),
  takePressed: () => false,
  isDown: () => false,
  aim: null,
  mouse: { x: 0, y: 0, down: false },
  mouseDown: false,
  firing: false,
};

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
attachInput(canvas);

const params = new URLSearchParams(window.location.search);
const seedParam = Number.parseInt(params.get('seed') || '', 10);
const SEED = Number.isFinite(seedParam) ? seedParam : 1337;
const SHOT = params.get('shot');

let world = createWorld(SEED);
window.__world = world;

let state = 'title';
let completeShown = false;
let overT = 0;
let overKind = null;

// The frame's sim input: input.js's held/latched state, with the
// mouse converted from canvas space to world space via the camera.
function buildInput() {
  const cam = computeCamera(world);
  const aim = { x: mouse.x + cam.x, y: mouse.y + cam.y };
  return {
    walkAxis,
    driveAxis,
    takePressed,
    isDown,
    aim,
    mouse: { x: aim.x, y: aim.y, down: mouse.down },
    mouseDown: mouse.down,
    firing: mouse.down,
  };
}

function viewOf() {
  const cam = computeCamera(world);
  return {
    aim: { x: mouse.x + cam.x, y: mouse.y + cam.y },
    firing: mouse.down,
    mouseDown: mouse.down,
  };
}

function setWorld(next) {
  world = next;
  window.__world = world;
}

function startGame(fresh) {
  if (fresh) clearSave();
  setWorld(createWorld(SEED));
  world.demo = false;
  completeShown = world.missions.done.length >= world.missions.defs.length;
  overKind = null;
  state = 'play';
}

// First gesture wakes the audio; any key is also the title's start.
let anyKeyCode = null;
window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (anyKeyCode === null) anyKeyCode = e.code;
});
window.addEventListener('pointerdown', () => unlockAudio());

// ------------------------------------------------------------ shot scenes ---
function findCarNear(pred, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const car of world.cars) {
    if (!pred(car)) continue;
    const d = Math.hypot(car.x - x, car.y - y);
    if (d < bestD) {
      bestD = d;
      best = car;
    }
  }
  return best;
}

function putPlayerInCar(car, x, y, angle, speed) {
  car.x = x;
  car.y = y;
  car.angle = angle;
  car.speed = speed;
  car.vx = Math.cos(angle) * speed;
  car.vy = Math.sin(angle) * speed;
  car.driver = 'player';
  car.parked = false;
  world.player.car = car;
  world.player.x = x;
  world.player.y = y;
  world.player.angle = angle;
}

function stageShot(name) {
  setWorld(createWorld(SEED));
  const player = world.player;
  if (name === 'title') {
    world.demo = true;
  } else if (name === 'chase') {
    const sports = findCarNear((c) => c.cls === 'sports', 1600, 600);
    if (sports) putPlayerInCar(sports, 1180, 897, 0, 210);
    world.heat = 250; // three stars
    // Two cruisers already on his tail (the force's own units spawn
    // in during the fast-forward and join from the minimap edge).
    for (const [dx, dy, ang] of [[-140, -22, 0.14], [-250, 26, -0.1]]) {
      world.cars.push({
        x: 1180 + dx, y: 897 + dy, angle: ang,
        speed: 200, vx: Math.cos(ang) * 200, vy: Math.sin(ang) * 200,
        cls: 'cop', color: '#dfe3e8', damage: 0, driver: 'police', parked: false,
      });
    }
    world.demo = true;
  } else if (name === 'harbor') {
    // M1, already picked up: the harbor warehouse is the last step.
    const st = world.missions;
    st.active = { def: st.defs[0], stepIndex: 1, cpIndex: 0, timeLeft: null };
    const lm = world.city.landmarks.chopShop;
    const res = world.city.collide(lm.x - 135, lm.y + 48, 10);
    player.x = res.x;
    player.y = res.y;
    player.angle = Math.atan2(lm.y - player.y, lm.x - player.x);
    // A sedan waiting on the nearest road point, keys in.
    const sedan = findCarNear((c) => c.cls === 'sedan', player.x, player.y);
    if (sedan) {
      let placed = false;
      for (let r = 30; r <= 220 && !placed; r += 14) {
        for (let a = 0; a < Math.PI * 2 && !placed; a += Math.PI / 10) {
          const px = player.x + Math.cos(a) * r;
          const py = player.y + Math.sin(a) * r;
          if (world.city.isRoad(px, py)) {
            sedan.x = px;
            sedan.y = py;
            sedan.angle = a;
            sedan.parked = true;
            sedan.driver = null;
            placed = true;
          }
        }
      }
    }
    world.demo = false;
  } else if (name === 'complete') {
    world.missions.done = world.missions.defs.map((d) => d.id);
    player.cash = 3300; // 200 stake + all five payouts
    const sedan = findCarNear((c) => c.cls === 'sedan', 1600, 600);
    if (sedan) putPlayerInCar(sedan, 1500, 577, 0, 150);
    world.demo = true;
  }
  // Fast-forward ~2.5s so the scene is alive, not posed.
  const steps = Math.round(2.5 / STEP);
  for (let i = 0; i < steps; i++) stepWorld(world, ZERO_INPUT, STEP);
  window.__shotReady = true;
}

// ---------------------------------------------------------------- the loop ---
let last = null;
let acc = 0;

function frame(ts) {
  if (last === null) last = ts;
  const frameDt = Math.min((ts - last) / 1000, 0.1);
  last = ts;

  if (takePressed('KeyM')) toggleMute();

  if (SHOT) {
    acc += frameDt;
    let n = 0;
    while (acc >= STEP && n < MAX_STEPS) {
      stepWorld(world, ZERO_INPUT, STEP);
      acc -= STEP;
      n++;
    }
    if (n === MAX_STEPS) acc = 0;
    if (SHOT === 'title') drawTitle(ctx, world);
    else if (SHOT === 'complete') {
      draw(ctx, world, viewOf());
      drawBanner(ctx, 'Mission complete', 'Solace Burning · +$1,200');
    } else {
      draw(ctx, world, viewOf());
    }
    endFrame();
    requestAnimationFrame(frame);
    return;
  }

  if (state === 'title') {
    world.demo = true;
    acc += frameDt;
    let n = 0;
    const input = buildInput();
    while (acc >= STEP && n < MAX_STEPS) {
      stepWorld(world, input, STEP);
      acc -= STEP;
      n++;
    }
    if (n === MAX_STEPS) acc = 0;
    drawTitle(ctx, world);
    if (anyKeyCode !== null || takeMousePressed()) {
      startGame(anyKeyCode === 'KeyN');
    }
  } else if (state === 'play') {
    acc += frameDt;
    let n = 0;
    const input = buildInput();
    while (acc >= STEP && n < MAX_STEPS) {
      stepWorld(world, input, STEP);
      acc -= STEP;
      n++;
    }
    if (n === MAX_STEPS) acc = 0;
    draw(ctx, world, viewOf());
    if (world.lastOutcome) {
      overKind = world.lastOutcome;
      world.lastOutcome = null;
      overT = 0;
      state = 'over';
    } else if (!completeShown
        && world.missions.done.length >= world.missions.defs.length) {
      completeShown = true;
      state = 'complete';
    } else if (takePressed('Escape') || takePressed('KeyP')) {
      state = 'pause';
    }
  } else if (state === 'pause') {
    draw(ctx, world, viewOf());
    drawBanner(ctx, 'PAUSED', 'Esc or P to resume');
    if (takePressed('Escape') || takePressed('KeyP')) state = 'play';
  } else if (state === 'over') {
    acc += frameDt;
    let n = 0;
    while (acc >= STEP && n < MAX_STEPS) {
      stepWorld(world, ZERO_INPUT, STEP);
      acc -= STEP;
      n++;
    }
    if (n === MAX_STEPS) acc = 0;
    world.lastOutcome = overKind; // the card reads the kind from here
    drawBustedWasted(ctx, world);
    world.lastOutcome = null;
    overT += frameDt;
    if (overT >= OVER_SECONDS) state = 'play';
  } else if (state === 'complete') {
    drawComplete(ctx, world);
    if (anyKeyCode !== null || takeMousePressed()) state = 'play';
  }

  anyKeyCode = null;
  endFrame();
  requestAnimationFrame(frame);
}

if (SHOT) stageShot(SHOT);
requestAnimationFrame(frame);
