// Port Solace — pedestrians.
//
// createPeds(world) seeds world.peds from the city's spawn points
// (rings on the sidewalk centrelines around every block), thinned by
// each district's pedDensity. stepPeds(world, dt) simulates the peds
// near the player:
//   * stroll — walk the ring from spawn point to spawn point, so a
//     strolling ped stays on the sidewalks by construction;
//   * flee — run directly away from a crash/gunshot event or a fast
//     car for ~2.4s;
//   * down — knocked over by a moving car (raises a 'hitped' event),
//     gets back up after a few seconds and strolls off.
//
// ped = { x, y, angle, speed, state: 'stroll'|'flee'|'down', color,
//         timer } plus internal fields (pace, tx/ty stroll target,
//         fleeX/fleeY threat point).

import { WORLD, DISTRICTS } from './config.js';
import { createRng } from './random.js';

const ACTIVE_DIST = 1300;   // peds beyond this from the player sleep
const FLEE_TIME = 2.4;
const DOWN_TIME = 7;
const PED_RADIUS = 6;

const PED_COLORS = [
  '#b0563a', '#3a6ab0', '#4d8a4d', '#b09a3a', '#7a4a8a', '#8a8f98',
  '#c0c4cc', '#93502e', '#2e7d7d', '#a3336e', '#5b6ab0', '#6a8a4b',
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function rngFor(world) {
  if (!world.rng) {
    world.rng = createRng(((world.city.seed >>> 0) * 2654435761) >>> 0);
  }
  return world.rng;
}

export function makePed(rng, x, y, district) {
  return {
    x, y,
    angle: rng.range(0, Math.PI * 2),
    speed: 0,
    state: 'stroll',
    color: rng.pick(PED_COLORS),
    timer: 0,
    pace: rng.range(48, 84),
    tx: null,
    ty: null,
    fleeX: 0,
    fleeY: 0,
    noHitT: 0,
    district: district || null,
  };
}

export function createPeds(world) {
  const rng = rngFor(world);
  world.peds = [];
  for (const s of world.city.spawnPoints().peds) {
    const d = DISTRICTS.find((dd) => dd.id === s.district);
    const density = d ? d.pedDensity : 0.5;
    if (!rng.chance(0.3 + 0.7 * density)) continue;
    world.peds.push(makePed(rng, s.x, s.y, s.district));
  }
  return world.peds;
}

// True when the straight walk from the ped to (tx, ty) stays on
// sidewalk the whole way. Ring points across a street are only ~88px
// apart — as close as neighbours along the same ring — so distance
// alone cannot keep peds off the road; the path has to be checked.
function pathOnSidewalk(world, ped, tx, ty) {
  const dx = tx - ped.x;
  const dy = ty - ped.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.floor(dist / 12));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!world.city.isSidewalk(ped.x + dx * t, ped.y + dy * t)) return false;
  }
  return world.city.isSidewalk(tx, ty);
}

// Pick the next stroll target: the nearest sampled spawn point whose
// whole path stays on the sidewalks (in practice a ring neighbour).
// A ped who is off the sidewalk (knocked there, or fled there) instead
// walks straight back to the nearest spawn point, path check waived.
function pickStrollTarget(world, ped, rng) {
  const spawns = world.city.pedSpawns;
  const offSidewalk = !world.city.isSidewalk(ped.x, ped.y);
  let best = null;
  let bestScore = Infinity;
  for (let k = 0; k < 24; k++) {
    const s = spawns[Math.floor(rng.next() * spawns.length)];
    const dx = s.x - ped.x;
    const dy = s.y - ped.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 25 * 25 || d2 > 260 * 260 || d2 >= bestScore) continue;
    if (!offSidewalk && d2 > 200 * 200) continue;
    if (!offSidewalk && !pathOnSidewalk(world, ped, s.x, s.y)) continue;
    bestScore = d2;
    best = s;
  }
  if (best) {
    ped.tx = best.x;
    ped.ty = best.y;
    return;
  }
  // Fallback: a random nearby point that is itself sidewalk, with a
  // clear path when the ped is on the sidewalk to begin with.
  for (let k = 0; k < 6; k++) {
    const nx = ped.x + rng.range(-120, 120);
    const ny = ped.y + rng.range(-120, 120);
    if (!world.city.isSidewalk(nx, ny)) continue;
    if (!offSidewalk && !pathOnSidewalk(world, ped, nx, ny)) continue;
    ped.tx = nx;
    ped.ty = ny;
    return;
  }
  ped.tx = null;
  ped.ty = null;
}

function movePed(world, ped, dx, dy, dist, speed, dt) {
  if (dist < 1e-4) {
    ped.speed = 0;
    return;
  }
  ped.angle = Math.atan2(dy, dx);
  const step = Math.min(dist, speed * dt);
  const nx = ped.x + (dx / dist) * step;
  const ny = ped.y + (dy / dist) * step;
  const res = world.city.collide(nx, ny, PED_RADIUS);
  ped.x = res.x;
  ped.y = res.y;
  ped.speed = speed;
}

export function stepPeds(world, dt) {
  const rng = rngFor(world);
  const centre = world.player || { x: WORLD.W / 2, y: WORLD.H / 2 };

  // Threats this frame: crash/gunshot events + genuinely fast cars.
  const threats = [];
  for (const e of world.events) {
    if (e.type === 'crash' || e.type === 'shot' || e.type === 'gunshot') {
      threats.push(e);
    }
  }
  const fastCars = [];
  const movingCars = [];
  for (const car of world.cars) {
    // A parked, driverless car cannot run anyone over — and it may
    // carry stale velocity from a pair-resolution shove, since
    // nothing ever steps its physics. Exclude it by state, not speed.
    if (car.parked && !car.driver) continue;
    const v = Math.hypot(car.vx, car.vy);
    if (v > 45) movingCars.push({ car, v });
    if (v > 150) fastCars.push(car);
  }

  for (const ped of world.peds) {
    const cdx = ped.x - centre.x;
    const cdy = ped.y - centre.y;
    if (cdx * cdx + cdy * cdy > ACTIVE_DIST * ACTIVE_DIST) continue;
    ped.noHitT = Math.max(0, (ped.noHitT || 0) - dt);

    // Knockdown: any moving car whose centre gets close. Skipped
    // briefly after a ped gets up, so a victim scrambling back to
    // the sidewalk is not farmed by the next car in the queue.
    if (ped.state !== 'down' && ped.noHitT <= 0) {
      let hit = null;
      for (const mc of movingCars) {
        const dx = ped.x - mc.car.x;
        if (dx > 26 || dx < -26) continue;
        const dy = ped.y - mc.car.y;
        if (dy > 26 || dy < -26) continue;
        if (dx * dx + dy * dy < 21 * 21) {
          hit = mc;
          break;
        }
      }
      if (hit) {
        ped.state = 'down';
        ped.timer = DOWN_TIME;
        ped.speed = 0;
        ped.x += hit.car.vx * 0.06;
        ped.y += hit.car.vy * 0.06;
        const res = world.city.collide(ped.x, ped.y, PED_RADIUS);
        ped.x = res.x;
        ped.y = res.y;
        world.events.push({
          type: 'hitped', x: ped.x, y: ped.y,
          severity: clamp(Math.round(hit.v / 28), 1, 10),
          byPlayer: hit.car.driver === 'player',
        });
        continue;
      }
    }

    // Flee triggers ---------------------------------------------------
    if (ped.state !== 'down') {
      let threat = null;
      let threatD2 = 120 * 120;
      for (const t of threats) {
        const dx = ped.x - t.x;
        const dy = ped.y - t.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < threatD2) {
          threatD2 = d2;
          threat = t;
        }
      }
      for (const car of fastCars) {
        const dx = ped.x - car.x;
        const dy = ped.y - car.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 95 * 95 || d2 >= threatD2) continue;
        // A car cruising past in its lane is not a threat: only flee
        // one that is actually closing on the ped, or already off
        // the road near them.
        const dist = Math.sqrt(d2) || 1;
        const closing = -(car.vx * dx + car.vy * dy) / dist;
        if (closing > 110 || !world.city.isRoad(car.x, car.y)) {
          threatD2 = d2;
          threat = car;
        }
      }
      if (threat) {
        ped.state = 'flee';
        ped.timer = FLEE_TIME;
        ped.fleeX = threat.x;
        ped.fleeY = threat.y;
      }
    }

    // State behaviour ---------------------------------------------------
    if (ped.state === 'down') {
      ped.timer -= dt;
      ped.speed = 0;
      if (ped.timer <= 0) {
        ped.state = 'stroll';
        ped.tx = null;
        ped.ty = null;
        ped.noHitT = 1.5;
      }
    } else if (ped.state === 'flee') {
      ped.timer -= dt;
      if (ped.timer <= 0) {
        ped.state = 'stroll';
        ped.tx = null;
        ped.ty = null;
        ped.speed = 0;
      } else {
        // Run from the threat — but a ped on the sidewalk veers to
        // stay on it when they can, instead of bolting across traffic
        // or into a block. If no veer keeps them on the pavement
        // they cower in place rather than run into the road.
        let ang = Math.atan2(ped.y - ped.fleeY, ped.x - ped.fleeX);
        let cower = false;
        if (world.city.isSidewalk(ped.x, ped.y)) {
          let found = false;
          for (const off of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
            const a = ang + off;
            if (world.city.isSidewalk(ped.x + Math.cos(a) * 30, ped.y + Math.sin(a) * 30)) {
              ang = a;
              found = true;
              break;
            }
          }
          cower = !found;
        }
        if (cower) ped.speed = 0;
        else movePed(world, ped, Math.cos(ang), Math.sin(ang), 1, 205, dt);
      }
    } else {
      // stroll
      if (ped.tx === null) pickStrollTarget(world, ped, rng);
      if (ped.tx === null) {
        ped.speed = 0;
        continue;
      }
      const dx = ped.tx - ped.x;
      const dy = ped.ty - ped.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 6) {
        ped.tx = null;
        ped.ty = null;
        ped.speed = 0;
        continue;
      }
      movePed(world, ped, dx, dy, dist, ped.pace, dt);
    }
  }
}
