// Port Solace — ambient traffic.
//
// createTraffic(world) seeds world.cars with the city's parked cars
// plus a fleet of moving AI cars. stepTraffic(world, dt) drives every
// car whose driver is 'ai' (parked cars and the player's car are left
// alone; their physics belongs to drive.js / player.js).
//
// Lane discipline is right-hand traffic on the inner lane: a car
// follows the lane line offset LANE_OFFSET to the right of its avenue
// centreline. Each AI car carries a small route state in car.ai:
//   { axis: 'h'|'v', line, dirSign, decided, turn, cruise, blockT,
//     honkCd }
// 'line' is the centreline of the avenue it is on, 'decided' the
// crossing it has already rolled for, 'turn' an in-progress corner
// { tx, ty, axis, line, dirSign, fromLine }. Steering is pure pursuit
// toward a target point on the lane (or the corner exit while
// turning); intersections roll 62% straight / 19% right / 19% left.

import {
  LANE_OFFSET, COLORS, PARKED_CLASS_WEIGHTS,
} from './config.js';
import { createRng } from './random.js';
import { stepCar, isWrecked } from './drive.js';

const MOVING_TARGET = 46;
const DESPAWN_DIST = 1400;

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

function weightedClass(rng) {
  let total = 0;
  for (const k in PARKED_CLASS_WEIGHTS) total += PARKED_CLASS_WEIGHTS[k];
  let roll = rng.next() * total;
  for (const k in PARKED_CLASS_WEIGHTS) {
    roll -= PARKED_CLASS_WEIGHTS[k];
    if (roll <= 0) return k;
  }
  return 'sedan';
}

function nearestLine(lines, v) {
  let best = lines[0];
  for (const L of lines) {
    if (Math.abs(L - v) < Math.abs(best - v)) best = L;
  }
  return best;
}

// Build the route state for a car sitting at a spawn (angle is one of
// the four cardinal headings).
function aiFromHeading(world, car, rng) {
  const a = car.angle;
  let axis;
  let dirSign;
  let line;
  if (Math.abs(Math.cos(a)) > Math.abs(Math.sin(a))) {
    axis = 'h';
    dirSign = Math.cos(a) > 0 ? 1 : -1;
    line = nearestLine(world.city.avenues.ys, car.y);
  } else {
    axis = 'v';
    dirSign = Math.sin(a) > 0 ? 1 : -1;
    line = nearestLine(world.city.avenues.xs, car.x);
  }
  return {
    axis, dirSign, line,
    decided: null,
    turn: null,
    cruise: rng.range(140, 225),
    blockT: 0,
    honkCd: rng.range(0, 2),
  };
}

// The lane centre coordinate (the axis perpendicular to travel).
function laneCoord(ai) {
  return ai.axis === 'h'
    ? ai.line + ai.dirSign * LANE_OFFSET
    : ai.line - ai.dirSign * LANE_OFFSET;
}

function headingAngle(ai) {
  if (ai.axis === 'h') return ai.dirSign > 0 ? 0 : Math.PI;
  return ai.dirSign > 0 ? Math.PI / 2 : -Math.PI / 2;
}

// The point a spawn resolves to once the car is snapped into its
// inner lane (mirrors aiFromHeading + laneCoord, without the RNG).
function spawnLanePoint(world, spawn) {
  const cs = Math.cos(spawn.angle);
  const sn = Math.sin(spawn.angle);
  const ai = { axis: 'h', dirSign: 1, line: 0 };
  if (Math.abs(cs) >= Math.abs(sn)) {
    ai.axis = 'h';
    ai.dirSign = cs >= 0 ? 1 : -1;
    ai.line = nearestLine(world.city.avenues.ys, spawn.y);
  } else {
    ai.axis = 'v';
    ai.dirSign = sn >= 0 ? 1 : -1;
    ai.line = nearestLine(world.city.avenues.xs, spawn.x);
  }
  const lane = laneCoord(ai);
  return ai.axis === 'h' ? { x: spawn.x, y: lane } : { x: lane, y: spawn.y };
}

// Place a car at a spawn point, snapped laterally into the inner
// lane for its heading. Spawn points exist for both lane offsets;
// a car materialising in the outer lane would spend its first
// seconds sweeping diagonally across the curb lane (and the
// sidewalk's edge) while it converges — so start it in lane.
function placeAtSpawn(world, car, spawn) {
  car.x = spawn.x;
  car.y = spawn.y;
  car.angle = spawn.angle;
  car.ai = aiFromHeading(world, car, rngFor(world));
  const lane = laneCoord(car.ai);
  if (car.ai.axis === 'h') car.y = lane;
  else car.x = lane;
}

function makeMovingCar(world, rng, spawn) {
  const car = {
    x: spawn.x, y: spawn.y, angle: spawn.angle,
    speed: 0, vx: 0, vy: 0,
    cls: weightedClass(rng),
    color: rng.pick(COLORS.cars),
    damage: 0,
    driver: 'ai',
    parked: false,
  };
  placeAtSpawn(world, car, spawn);
  return car;
}

export function createTraffic(world) {
  const rng = rngFor(world);
  world.cars = world.city.parkedCars.slice();

  const spawns = world.city.carSpawns.slice();
  // Fisher-Yates with the world RNG so placement is deterministic.
  for (let i = spawns.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = spawns[i];
    spawns[i] = spawns[j];
    spawns[j] = t;
  }

  let placed = 0;
  const tryPlace = (spawn, respectDensity) => {
    if (placed >= MOVING_TARGET) return;
    const d = world.city.districtAt(spawn.x, spawn.y);
    if (respectDensity && !rng.chance(0.25 + 0.75 * d.trafficDensity)) return;
    const pt = spawnLanePoint(world, spawn);
    for (const c of world.cars) {
      const dx = c.x - pt.x;
      const dy = c.y - pt.y;
      if (dx * dx + dy * dy < 30 * 30) return; // too crowded here
    }
    world.cars.push(makeMovingCar(world, rng, spawn));
    placed++;
  };
  for (const s of spawns) tryPlace(s, true);
  for (const s of spawns) {
    if (placed >= MOVING_TARGET) break;
    tryPlace(s, false); // second pass ignores density to fill the fleet
  }
  return world.cars;
}

// (Re)spawn one AI car on a rim lane in the 700–1100px band around
// the player. Returns false when no spawn point qualifies.
function respawnCar(world, car, rng) {
  const p = world.player;
  if (!p) return false;
  const candidates = [];
  for (const s of world.city.carSpawns) {
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d >= 700 && d <= 1100) candidates.push(s);
  }
  if (!candidates.length) return false;
  const spawn = rng.pick(candidates);
  const d = world.city.districtAt(spawn.x, spawn.y);
  if (!rng.chance(0.2 + 0.8 * d.trafficDensity)) return false;
  placeAtSpawn(world, car, spawn);
  car.speed = 0;
  car.vx = 0;
  car.vy = 0;
  car.damage = 0;
  car.cls = weightedClass(rng);
  car.color = rng.pick(COLORS.cars);
  return true;
}

// Closest vehicle ahead in my lane corridor: { dist, speed } where
// speed is its velocity along my heading (0 for parked/crossing cars).
function scanAhead(world, car) {
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  let best = null;
  for (const other of world.cars) {
    if (other === car) continue;
    const dx = other.x - car.x;
    const dy = other.y - car.y;
    const lon = dx * fx + dy * fy;
    if (lon < 4 || lon > 105) continue;
    const lat = -dx * fy + dy * fx;
    if (Math.abs(lat) > 10.5) continue; // parked cars sit ~12px over
    if (!best || lon < best.dist) {
      best = { dist: lon, speed: other.vx * fx + other.vy * fy };
    }
  }
  return best;
}

function stepAiCar(world, car, dt, rng) {
  const ai = car.ai || (car.ai = aiFromHeading(world, car, rng));
  ai.honkCd = Math.max(0, ai.honkCd - dt);

  if (isWrecked(car)) {
    stepCar(world, car, { throttle: 0, steer: 0, handbrake: false }, dt);
    return;
  }

  const city = world.city;
  const along = ai.axis === 'h' ? car.x : car.y;
  const crossLines = ai.axis === 'h' ? city.avenues.xs : city.avenues.ys;

  // Intersection decisions -------------------------------------------
  let nextCross = null;
  if (!ai.turn) {
    for (const L of crossLines) {
      if ((L - along) * ai.dirSign > 8) {
        if (nextCross === null || Math.abs(L - along) < Math.abs(nextCross - along)) {
          nextCross = L;
        }
      }
    }
    // Forget a decision once we are well past its crossing.
    if (ai.decided !== null && (ai.decided - along) * ai.dirSign < -60) {
      ai.decided = null;
    }
    if (
      nextCross !== null &&
      ai.decided !== nextCross &&
      (nextCross - along) * ai.dirSign < 125
    ) {
      ai.decided = nextCross;
      // At the outermost crossing, going straight would leave the
      // grid entirely — always turn there.
      const headingOut =
        (ai.dirSign > 0 && nextCross === crossLines[crossLines.length - 1]) ||
        (ai.dirSign < 0 && nextCross === crossLines[0]);
      const roll = rng.next();
      if (headingOut || roll >= 0.62) {
        const right = headingOut ? rng.chance(0.5) : roll < 0.81;
        const cur = headingAngle(ai);
        const na = cur + (right ? Math.PI / 2 : -Math.PI / 2);
        const nAxis = Math.abs(Math.cos(na)) > Math.abs(Math.sin(na)) ? 'h' : 'v';
        const nDir = nAxis === 'h'
          ? (Math.cos(na) > 0 ? 1 : -1)
          : (Math.sin(na) > 0 ? 1 : -1);
        const probe = { axis: nAxis, dirSign: nDir, line: nextCross };
        const nLane = laneCoord(probe);
        // Corner exit: on the new lane, ~140px past the intersection.
        // A nearer exit point makes the arc turn earlier and hug the
        // intersection instead of swinging wide over the corner
        // sidewalk (and its pedestrians).
        const tx = nAxis === 'v' ? nLane : ai.line + nDir * 140;
        const ty = nAxis === 'v' ? ai.line + nDir * 140 : nLane;
        ai.turn = {
          tx, ty, axis: nAxis, line: nextCross, dirSign: nDir, fromLine: ai.line,
        };
      }
    }
  }

  // Safety net: no crossing ahead means we are heading out of the
  // grid (shoved past the last avenue) — U-turn back inside.
  if (!ai.turn && nextCross === null) {
    const nDir = -ai.dirSign;
    const nLane = laneCoord({ axis: ai.axis, dirSign: nDir, line: ai.line });
    ai.turn = {
      tx: ai.axis === 'h' ? car.x - ai.dirSign * 190 : nLane,
      ty: ai.axis === 'h' ? nLane : car.y - ai.dirSign * 190,
      axis: ai.axis, line: ai.line, dirSign: nDir, fromLine: ai.line,
    };
  }

  // Steering target ----------------------------------------------------
  let tx;
  let ty;
  if (ai.turn) {
    tx = ai.turn.tx;
    ty = ai.turn.ty;
    const dTurn = Math.hypot(tx - car.x, ty - car.y);
    const want = headingAngle(ai.turn);
    const laneNow = laneCoord(ai.turn);
    const latNow = ai.turn.axis === 'h' ? car.y - laneNow : car.x - laneNow;
    // Complete the turn only when the car is actually established
    // on the new lane — releasing it while it is still diagonal and
    // 40px wide of the lane sends it sweeping across the sidewalk
    // ring while it converges.
    const aligned = Math.abs(wrapAngle(car.angle - want)) < 0.25 && Math.abs(latNow) < 16;
    if (aligned || dTurn < 30) {
      ai.axis = ai.turn.axis;
      ai.line = ai.turn.line;
      ai.dirSign = ai.turn.dirSign;
      ai.decided = ai.turn.fromLine;
      ai.turn = null;
    }
  }
  if (!ai.turn) {
    const lane = laneCoord(ai);
    if (ai.axis === 'h') {
      tx = car.x + ai.dirSign * 150;
      ty = lane;
    } else {
      tx = lane;
      ty = car.y + ai.dirSign * 150;
    }
  }

  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  const desired = Math.atan2(ty - car.y, tx - car.x);
  const steer = clamp(wrapAngle(desired - car.angle) * 2.6, -1, 1);

  // Speed control --------------------------------------------------------
  let target = ai.cruise;
  if (ai.turn) target = Math.min(target, 130);
  // Intersection courtesy: approaching a crossing, yield to a car
  // that is already in the box or clearly closer to it. Without this
  // the crossing traffic T-bones constantly.
  if (!ai.turn && nextCross !== null) {
    const toCross = (nextCross - along) * ai.dirSign;
    if (toCross > 30 && toCross < 86) {
      const ix = ai.axis === 'h' ? nextCross : ai.line;
      const iy = ai.axis === 'h' ? ai.line : nextCross;
      const myD = Math.hypot(car.x - ix, car.y - iy);
      if (myD > 50) {
        for (const o of world.cars) {
          if (o === car || o.parked) continue;
          const od = Math.hypot(o.x - ix, o.y - iy);
          if (od < 46 || (od < myD - 4 && od < 95)) {
            target = 0;
            break;
          }
        }
      }
    }
  }
  const ahead = scanAhead(world, car);
  if (ahead) {
    target = Math.min(target, ahead.dist < 36 ? 0 : ahead.speed * 0.95);
  }
  // The player on foot is not in world.cars — check separately.
  const p = world.player;
  if (p && !p.car) {
    const dx = p.x - car.x;
    const dy = p.y - car.y;
    const lon = dx * fx + dy * fy;
    const lat = -dx * fy + dy * fx;
    if (lon > 0 && lon < 52 && Math.abs(lat) < 12) target = 0;
  }

  let throttle;
  if (car.speed < target - 6) throttle = 0.9;
  else if (car.speed > target + 10) throttle = target === 0 ? -1 : -0.4;
  else throttle = 0.12;

  // Honk when stuck behind something while wanting to move.
  if (target >= 60 && car.speed < 10) {
    ai.blockT += dt;
    if (ai.blockT > 0.7 && ai.honkCd <= 0) {
      world.events.push({ type: 'honk', x: car.x, y: car.y, severity: 1 });
      ai.honkCd = rng.range(1.6, 3.2);
      ai.blockT = 0;
    }
  } else {
    ai.blockT = 0;
  }

  stepCar(world, car, { throttle, steer, handbrake: false }, dt);
}

export function stepTraffic(world, dt) {
  const rng = rngFor(world);
  const p = world.player;
  for (const car of world.cars) {
    if (car.driver !== 'ai' || car.parked) continue;
    if (p) {
      const d = Math.hypot(car.x - p.x, car.y - p.y);
      if (d > DESPAWN_DIST || (isWrecked(car) && d > 600)) {
        if (respawnCar(world, car, rng)) continue;
        if (d > DESPAWN_DIST) continue; // no band spawn: leave it parked out there
      }
    }
    stepAiCar(world, car, dt, rng);
  }
}
