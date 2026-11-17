// Port Solace — the law: heat, wanted stars, pursuit, busts.
//
// stepPolice(world, dt) runs the whole system once per step:
//
//   * Crime is charged from world.events, and ONLY for acts the
//     player caused: an event counts when its byPlayer flag is set
//     (drive.js / peds.js / player.js / combat.js all stamp it).
//     Ambient AI traffic flattens its own pedestrians all day long;
//     none of that is the player's fault, so a passive player holds
//     heat 0 forever. Charged events are stamped _counted so they
//     can never be charged twice, even if the events array is not
//     cleared between steps.
//   * world.heat runs 0..500; stars = ceil(heat / 100), capped at 5,
//     mirrored onto player.wanted. world.heatFloor is a floor the
//     missions can hold heat at (an escort under pressure): decay
//     never takes heat below it.
//   * Heat decays at 4/s while no unit is within 420px of the
//     player, 0.8/s while one is — breaking away is what cools you.
//   * Units are cop-class cars with driver 'police', driven through
//     drive.js stepCar() with a pursuit control that steers for an
//     interception point ahead of the player. The force aims for
//     stars + 1 units (max 7), spawning on roads 800–1000px out.
//   * Bust: a player crawling (< 25 px/s) for a continuous 2.5s
//     with a unit within 90px is busted (world.busted). A player
//     whose health hits 0 is wasted (world.wasted). Missions and
//     respawnPlayer() deal with the consequences.

import { CAR_CLASSES } from './config.js';
import { createRng } from './random.js';
import { stepCar, isWrecked } from './drive.js';

export const HEAT_MAX = 500;
const HEAT_BY_TYPE = { theft: 60, hitped: 90, shot: 50, peddown: 90 };
const HEAT_PER_CRASH_SEVERITY = 8;
const DECAY_CLEAR = 4;      // heat/s with no unit near
const DECAY_WATCHED = 0.8;  // heat/s with a unit within SIGHT_DIST
const SIGHT_DIST = 420;
const MAX_UNITS = 7;
const SPAWN_MIN = 800;
const SPAWN_MAX = 1000;
const DESPAWN_DIST = 1500;
const SPAWN_CD = 0.7;
const BUST_DIST = 90;
const BUST_SPEED = 25;
const BUST_TIME = 2.5;
const COP_COLOR = '#dfe3e8';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function rngFor(world) {
  if (!world.rng) {
    world.rng = createRng(((world.city.seed >>> 0) * 2654435761) >>> 0);
  }
  return world.rng;
}

// Per-world police state, kept off the shared world shape.
const STATES = new WeakMap();

function stateFor(world) {
  let st = STATES.get(world);
  if (!st) {
    st = {
      units: [],      // cop cars currently on the force (refs into world.cars)
      spawnCd: 0,
      bustT: 0,       // continuous seconds the bust conditions have held
      lastPX: null,   // player position last step (speed estimate)
      lastPY: null,
      velX: 0,        // smoothed player velocity estimate
      velY: 0,
    };
    STATES.set(world, st);
  }
  if (world.heat === undefined) world.heat = 0;
  if (world.heatFloor === undefined) world.heatFloor = 0;
  return st;
}

export function starsForHeat(heat) {
  if (heat <= 0) return 0;
  return Math.min(5, Math.ceil(heat / 100));
}

// ------------------------------------------------------------- crime ---
function playerCaused(world, e) {
  if (e.byPlayer === true) return true;
  // Defensive fallback: a crash event with no flag at all counts only
  // when it happened right on top of the car the player is driving.
  // (drive.js stamps every crash it raises, so this should not fire.)
  if (e.type === 'crash' && e.byPlayer === undefined) {
    const car = world.player && world.player.car;
    if (!car) return false;
    const dx = e.x - car.x;
    const dy = e.y - car.y;
    return dx * dx + dy * dy < 60 * 60;
  }
  return false;
}

function consumeEvents(world) {
  for (const e of world.events) {
    if (e._counted) continue;
    e._counted = true;
    if (!playerCaused(world, e)) continue;
    if (e.type === 'crash') {
      world.heat += HEAT_PER_CRASH_SEVERITY * (e.severity || 1);
    } else if (HEAT_BY_TYPE[e.type]) {
      world.heat += HEAT_BY_TYPE[e.type];
    }
  }
  world.heat = clamp(world.heat, 0, HEAT_MAX);
}

// ------------------------------------------------------------- units ---
function findSpawnPoint(world, rng) {
  const p = world.player;
  const W = world.city.w;
  const H = world.city.h;
  for (let i = 0; i < 28; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(SPAWN_MIN, SPAWN_MAX);
    const x = p.x + Math.cos(a) * d;
    const y = p.y + Math.sin(a) * d;
    if (x < 24 || y < 24 || x > W - 24 || y > H - 24) continue;
    if (world.city.isRoad(x, y)) return { x, y };
  }
  // Fallback: an avenue crossing in the spawn ring.
  const crossings = [];
  for (const ax of world.city.avenues.xs) {
    for (const ay of world.city.avenues.ys) {
      const dx = ax - p.x;
      const dy = ay - p.y;
      const d = Math.hypot(dx, dy);
      if (d > SPAWN_MIN - 80 && d < SPAWN_MAX + 220) crossings.push({ x: ax, y: ay });
    }
  }
  if (crossings.length) {
    const c = crossings[Math.floor(rng.next() * crossings.length)];
    return { x: c.x, y: c.y };
  }
  // Last resort: the farthest traffic spawn point.
  let best = null;
  let bestD = -1;
  for (const s of world.city.carSpawns) {
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d > bestD) {
      bestD = d;
      best = s;
    }
  }
  return best ? { x: best.x, y: best.y } : { x: p.x, y: p.y };
}

function spawnUnit(world, rng) {
  const spot = findSpawnPoint(world, rng);
  const car = {
    x: spot.x,
    y: spot.y,
    angle: Math.atan2(world.player.y - spot.y, world.player.x - spot.x),
    speed: 0, vx: 0, vy: 0,
    cls: 'cop',
    color: COP_COLOR,
    damage: 0,
    driver: 'police',
    parked: false,
    leaveT: 0,
  };
  world.cars.push(car);
  return car;
}

function removeUnit(world, st, car) {
  const ci = world.cars.indexOf(car);
  if (ci >= 0) world.cars.splice(ci, 1);
  const ui = st.units.indexOf(car);
  if (ui >= 0) st.units.splice(ui, 1);
}

// Steer one unit for where the player is heading, not where he is.
function pursuitControl(world, st, car, dt) {
  const p = world.player;
  const dist = Math.hypot(p.x - car.x, p.y - car.y);
  const spec = CAR_CLASSES.cop;
  const lead = clamp(dist / spec.topSpeed, 0, 0.9);
  const tx = p.x + st.velX * lead;
  const ty = p.y + st.velY * lead;
  const diff = wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.angle);
  const steer = clamp(diff * 2.1, -1, 1);
  let throttle = clamp(Math.cos(diff) * 1.5, -0.7, 1);
  if (dist < 46) throttle = Math.min(throttle, 0.25); // don't orbit a stopped man
  return { throttle, steer, handbrake: false };
}

// ---------------------------------------------------------------- step ---
export function stepPolice(world, dt) {
  const st = stateFor(world);
  const player = world.player;
  if (!player) return;
  const rng = rngFor(world);

  // Player velocity estimate (drives interception + the bust check).
  if (st.lastPX === null || dt <= 0) {
    st.velX = 0;
    st.velY = 0;
  } else {
    const ivx = (player.x - st.lastPX) / dt;
    const ivy = (player.y - st.lastPY) / dt;
    const blend = 0.5;
    st.velX += (ivx - st.velX) * blend;
    st.velY += (ivy - st.velY) * blend;
  }
  st.lastPX = player.x;
  st.lastPY = player.y;
  const playerSpeed = Math.hypot(st.velX, st.velY);

  consumeEvents(world);

  // Nearest live unit (bust + decay both look at it).
  let nearest = Infinity;
  for (const u of st.units) {
    const d = Math.hypot(u.x - player.x, u.y - player.y);
    if (d < nearest) nearest = d;
  }

  // Decay, then the missions' floor, then stars.
  const floor = clamp(world.heatFloor || 0, 0, HEAT_MAX);
  const rate = nearest <= SIGHT_DIST ? DECAY_WATCHED : DECAY_CLEAR;
  world.heat = clamp(world.heat - rate * dt, 0, HEAT_MAX);
  if (world.heat < floor) world.heat = floor;
  const stars = starsForHeat(world.heat);
  player.wanted = stars;

  // Force strength ---------------------------------------------------
  // Prune units that were wrecked or removed from the world.
  for (let i = st.units.length - 1; i >= 0; i--) {
    const u = st.units[i];
    if (!world.cars.includes(u) || isWrecked(u)) st.units.splice(i, 1);
  }
  const target = stars > 0 ? Math.min(stars + 1, MAX_UNITS) : 0;
  st.spawnCd = Math.max(0, st.spawnCd - dt);
  if (st.units.length < target && st.spawnCd <= 0) {
    st.units.push(spawnUnit(world, rng));
    st.spawnCd = SPAWN_CD;
  }
  // Trim the excess: far units peel off at once; close ones get a
  // few seconds to fall behind before they are stood down.
  if (st.units.length > target) {
    let farthest = null;
    let farthestD = -1;
    for (const u of st.units) {
      const d = Math.hypot(u.x - player.x, u.y - player.y);
      if (d > farthestD) {
        farthestD = d;
        farthest = u;
      }
      u.leaveT = (u.leaveT || 0) + dt;
    }
    if (farthest && (farthestD > DESPAWN_DIST || farthest.leaveT > 5)) {
      removeUnit(world, st, farthest);
    }
  } else {
    for (const u of st.units) u.leaveT = 0;
  }

  // Pursuit ------------------------------------------------------------
  for (const u of st.units) {
    stepCar(world, u, pursuitControl(world, st, u, dt), dt);
  }

  // Bust / wasted --------------------------------------------------------
  if (stars > 0 && playerSpeed < BUST_SPEED && nearest <= BUST_DIST) {
    st.bustT += dt;
    if (st.bustT >= BUST_TIME) world.busted = true;
  } else {
    st.bustT = 0;
  }
  if (player.health <= 0) world.wasted = true;
}
