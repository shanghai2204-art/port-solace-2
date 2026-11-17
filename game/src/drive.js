// Port Solace — arcade car physics.
//
// stepCar(world, car, control, dt) advances one car under a driver
// control input { throttle: -1..1, steer: -1..1, handbrake: bool }.
// The model is deliberately arcade-y:
//   * `speed` is the signed forward speed along the car's heading;
//     steering authority grows with speed and flips in reverse.
//   * The real velocity (vx, vy) chases heading*speed with an
//     exponential blend — tight when gripping, loose under the
//     handbrake, which is what makes drifts slide.
//   * Buildings are resolved with city.collide() on a circle; a solid
//     hit costs damage, cuts velocity and raises a 'crash' event.
// resolveCarPairs(world) handles car-vs-car contact for the whole
// world with a spatial hash and a shrunk-OBB overlap test (circles
// would false-trigger on parked cars in the next lane over).

import { CAR_CLASSES } from './config.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function carSpec(car) {
  return CAR_CLASSES[car.cls] || CAR_CLASSES.sedan;
}

export function isWrecked(car) {
  return car.damage >= carSpec(car).health;
}

// ---------------------------------------------------------------- step ---
export function stepCar(world, car, control, dt) {
  const spec = carSpec(car);
  const wrecked = isWrecked(car);
  car.crashCd = Math.max(0, (car.crashCd || 0) - dt);

  // Longitudinal ------------------------------------------------------
  if (!wrecked) {
    if (control.throttle > 0) {
      car.speed += spec.accel * control.throttle * dt;
    } else if (control.throttle < 0) {
      if (car.speed > 12) {
        // Braking is stronger than acceleration.
        car.speed -= spec.accel * 1.7 * -control.throttle * dt;
      } else {
        // Rolling (nearly) still: throttle back means reverse.
        car.speed += spec.accel * 0.55 * control.throttle * dt;
      }
    }
  }
  // Drag always applies; parked-style friction only when coasting.
  car.speed -= car.speed * 0.35 * dt;
  if (control.throttle === 0) {
    const f = 90 * dt;
    car.speed = Math.abs(car.speed) <= f ? 0 : car.speed - Math.sign(car.speed) * f;
  }
  car.speed = clamp(car.speed, -spec.topSpeed * 0.32, spec.topSpeed);

  // Steering ------------------------------------------------------------
  const authority = Math.min(1, Math.abs(car.speed) / 90);
  let turn = control.steer * spec.grip * 0.5 * authority;
  if (car.speed < 0) turn = -turn; // reversing flips the wheel
  if (control.handbrake) turn *= 1.45;
  car.angle += turn * dt;

  // Velocity: chase heading*speed, loosely under the handbrake --------
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  const blend = 1 - Math.exp(-(control.handbrake ? 2.2 : 10) * dt);
  car.vx += (fx * car.speed - car.vx) * blend;
  car.vy += (fy * car.speed - car.vy) * blend;

  // Integrate + building collision --------------------------------------
  let nx = car.x + car.vx * dt;
  let ny = car.y + car.vy * dt;
  const r = spec.h / 2 + 3;
  const res = world.city.collide(nx, ny, r); // also clamps to the world
  const pushed = Math.hypot(res.x - nx, res.y - ny);
  if (pushed > 0.6) {
    const impact = Math.hypot(car.vx, car.vy);
    if (impact > 55 && car.crashCd <= 0) {
      const severity = clamp(Math.round((impact - 40) / 16), 1, 14);
      car.damage = Math.min(spec.health * 1.6, car.damage + severity);
      world.events.push({
        type: 'crash', x: res.x, y: res.y, severity,
        byPlayer: car.driver === 'player',
      });
      car.crashCd = 0.3;
    }
    // Scrape along the wall: keep a third of the velocity.
    car.vx *= 0.35;
    car.vy *= 0.35;
    car.speed *= 0.35;
    nx = res.x;
    ny = res.y;
  }
  car.x = nx;
  car.y = ny;
}

// ---------------------------------------------------------- car vs car ---
function frameOverlap(self, other, dx, dy) {
  // Is `other`'s centre inside `self`'s shrunk OBB? dx/dy point from
  // self to other. The shrink keeps next-lane traffic and curb-parked
  // cars (centres ~12px apart laterally) from counting as contact.
  const ss = carSpec(self);
  const os = carSpec(other);
  const cos = Math.cos(self.angle);
  const sin = Math.sin(self.angle);
  const lon = dx * cos + dy * sin;
  const lat = -dx * sin + dy * cos;
  return (
    Math.abs(lon) < ((ss.w + os.w) / 2) * 0.82 &&
    Math.abs(lat) < ((ss.h + os.h) / 2) * 0.6
  );
}

function resolvePair(world, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > 70 * 70) return;
  if (!frameOverlap(a, b, dx, dy) || !frameOverlap(b, a, -dx, -dy)) return;

  const dist = Math.sqrt(d2) || 0.001;
  const nx = dx / dist;
  const ny = dy / dist;

  // Push apart along the centre line; parked cars barely budge.
  const ma = a.parked ? 5 : 1;
  const mb = b.parked ? 5 : 1;
  const pen = Math.min(10, dist * 0.35 + 1.5);
  a.x -= nx * pen * (mb / (ma + mb));
  a.y -= ny * pen * (mb / (ma + mb));
  b.x += nx * pen * (ma / (ma + mb));
  b.y += ny * pen * (ma / (ma + mb));

  // Velocity: kill the closing component, keep a little bounce.
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const closing = -(rvx * nx + rvy * ny); // > 0 when approaching
  if (closing > 0) {
    // Remove the approach speed along the centre line (no bounce;
    // the positional push above does the separating). Split by mass
    // share so a parked car hardly recoils.
    const delta = closing;
    a.vx -= nx * delta * (mb / (ma + mb));
    a.vy -= ny * delta * (mb / (ma + mb));
    b.vx += nx * delta * (ma / (ma + mb));
    b.vy += ny * delta * (ma / (ma + mb));

    if (closing > 55 && (a.crashCd || 0) <= 0 && (b.crashCd || 0) <= 0) {
      const severity = clamp(Math.round((closing - 50) / 14), 1, 14);
      const sa = carSpec(a);
      const sb = carSpec(b);
      a.damage = Math.min(sa.health * 1.6, a.damage + severity);
      b.damage = Math.min(sb.health * 1.6, b.damage + severity);
      world.events.push({
        type: 'crash',
        x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, severity,
        byPlayer: a.driver === 'player' || b.driver === 'player',
      });
      a.crashCd = 0.3;
      b.crashCd = 0.3;
    }
  }

  // Keep each car's scalar speed consistent with its new velocity.
  // A parked, driverless car is a static obstacle: it may be nudged
  // positionally, but it must not keep phantom velocity afterwards —
  // nothing steps its physics to decay it.
  for (const c of [a, b]) {
    c.speed = c.vx * Math.cos(c.angle) + c.vy * Math.sin(c.angle);
    if (c.parked && !c.driver) {
      c.vx = 0;
      c.vy = 0;
      c.speed = 0;
    }
  }
}

export function resolveCarPairs(world) {
  const cars = world.cars;
  if (!cars || cars.length < 2) return;
  const CELL = 96;
  const grid = new Map();
  for (let i = 0; i < cars.length; i++) {
    const key = Math.floor(cars[i].x / CELL) + ':' + Math.floor(cars[i].y / CELL);
    let arr = grid.get(key);
    if (!arr) {
      arr = [];
      grid.set(key, arr);
    }
    arr.push(i);
  }
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    const cx = Math.floor(a.x / CELL);
    const cy = Math.floor(a.y / CELL);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const arr = grid.get(gx + ':' + gy);
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          resolvePair(world, a, cars[j]);
        }
      }
    }
  }
}
