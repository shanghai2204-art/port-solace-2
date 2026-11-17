// Port Solace — on-foot gunplay.
//
// stepCombat(world, input, dt): Rook's pistol. On foot only — there
// is no shooting from a car. While the trigger is held the pistol
// fires a hitscan shot every 140ms toward the aim point (range 460):
//
//   * the ray stops at the first thing it meets — a building face,
//     a pedestrian, or a car — whichever is nearest along the line;
//   * a ped who is hit goes down (a 'peddown' event, byPlayer);
//   * a car that is hit takes +8 damage;
//   * every shot, hit or miss, raises a 'shot' event (byPlayer) —
//     peds flee from the noise and the law charges heat for it —
//     and appends a muzzle-flash segment to world.flashes[] for
//     the renderer: { x1, y1, x2, y2, t } with t starting at 0.
//
// The input adapter follows player.js's convention: the aim point
// is input.aim / input.mouseWorld / input.mouse ({x, y} in world
// coordinates); the trigger is input.mouseDown, input.firing, or
// input.mouse.down (input.js's mouse object carries all three
// fields). With no aim point the shot follows the player's facing.

import { PLAYER, CAR_CLASSES } from './config.js';

const FIRE_INTERVAL = 0.14;
const RANGE = 460;
const PED_HIT_R = 9;      // a ped is a small target
const CAR_DAMAGE = 8;
const PED_DOWN_TIME = 7;  // matches peds.js DOWN_TIME

const STATES = new WeakMap();

function stateFor(world) {
  let st = STATES.get(world);
  if (!st) {
    st = { cd: 0 };
    STATES.set(world, st);
  }
  if (!world.flashes) world.flashes = [];
  return st;
}

function aimPoint(input) {
  return input.aim || input.mouseWorld || input.mouse || null;
}

function triggerHeld(input) {
  if (input.firing === true) return true;
  if (input.mouseDown === true) return true;
  if (input.mouse && input.mouse.down === true) return true;
  return false;
}

// Smallest t >= 0 at which the ray (ox, oy) + t*(dx, dy) enters the
// AABB, or Infinity when it misses / starts inside.
function rayAabb(ox, oy, dx, dy, b) {
  let tmin = 0;
  let tmax = Infinity;
  if (Math.abs(dx) < 1e-9) {
    if (ox < b.x || ox > b.x + b.w) return Infinity;
  } else {
    let t1 = (b.x - ox) / dx;
    let t2 = (b.x + b.w - ox) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < b.y || oy > b.y + b.h) return Infinity;
  } else {
    let t1 = (b.y - oy) / dy;
    let t2 = (b.y + b.h - oy) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  return tmax >= tmin ? tmin : Infinity;
}

// Distance along the ray to the circle around (cx, cy), or Infinity.
function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const lx = cx - ox;
  const ly = cy - oy;
  const tca = lx * dx + ly * dy;
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly - tca * tca;
  if (d2 > r * r) return Infinity;
  return tca - Math.sqrt(r * r - d2);
}

// Distance along the ray to a car's oriented box (its real footprint:
// length along its heading, width across it), or Infinity. A circle
// of radius w/2 would swallow shots passing a car's flank by a wide
// margin, so cars are tested as the boxes they are.
function rayCar(ox, oy, dx, dy, car) {
  const spec = CAR_CLASSES[car.cls] || CAR_CLASSES.sedan;
  const cos = Math.cos(-car.angle);
  const sin = Math.sin(-car.angle);
  const lx = ox - car.x;
  const ly = oy - car.y;
  const lox = lx * cos - ly * sin;
  const loy = lx * sin + ly * cos;
  const ldx = dx * cos - dy * sin;
  const ldy = dx * sin + dy * cos;
  return rayAabb(lox, loy, ldx, ldy, {
    x: -spec.w / 2, y: -spec.h / 2, w: spec.w, h: spec.h,
  });
}

function fire(world, ox, oy, ang) {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  let bestT = RANGE;
  let hitPed = null;
  let hitCar = null;

  for (const b of world.city.buildings) {
    const t = rayAabb(ox, oy, dx, dy, b);
    if (t < bestT) {
      bestT = t;
      hitPed = null;
      hitCar = null;
    }
  }
  for (const ped of world.peds || []) {
    if (ped.state === 'down') continue;
    const t = rayCircle(ox, oy, dx, dy, ped.x, ped.y, PED_HIT_R);
    if (t < bestT) {
      bestT = t;
      hitPed = ped;
      hitCar = null;
    }
  }
  for (const car of world.cars) {
    const t = rayCar(ox, oy, dx, dy, car);
    if (t < bestT) {
      bestT = t;
      hitCar = car;
      hitPed = null;
    }
  }

  const ex = ox + dx * bestT;
  const ey = oy + dy * bestT;
  world.flashes.push({ x1: ox, y1: oy, x2: ex, y2: ey, t: 0 });
  world.events.push({
    type: 'shot', x: ox, y: oy, severity: 1, byPlayer: true,
  });

  if (hitPed) {
    hitPed.state = 'down';
    hitPed.timer = PED_DOWN_TIME;
    hitPed.speed = 0;
    world.events.push({
      type: 'peddown', x: hitPed.x, y: hitPed.y, severity: 3, byPlayer: true,
    });
  } else if (hitCar) {
    const spec = CAR_CLASSES[hitCar.cls] || CAR_CLASSES.sedan;
    hitCar.damage = Math.min(spec.health * 1.6, hitCar.damage + CAR_DAMAGE);
  }
}

export function stepCombat(world, input, dt) {
  const st = stateFor(world);
  const player = world.player;
  if (!player) return;
  st.cd = Math.max(0, st.cd - dt);
  if (player.car) return;            // no shooting from a car
  if (player.health <= 0) return;
  if (!triggerHeld(input) || st.cd > 0) return;

  const aim = aimPoint(input);
  let ang = player.angle;
  if (aim) {
    const dx = aim.x - player.x;
    const dy = aim.y - player.y;
    if (dx * dx + dy * dy > 1) ang = Math.atan2(dy, dx);
  }
  const ox = player.x + Math.cos(ang) * (PLAYER.radius + 4);
  const oy = player.y + Math.sin(ang) * (PLAYER.radius + 4);
  fire(world, ox, oy, ang);
  st.cd = FIRE_INTERVAL;
}
