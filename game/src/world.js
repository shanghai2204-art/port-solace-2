// Port Solace — world assembly and the fixed-step simulation.
//
// createWorld(seed) builds the whole state the other modules share:
//   { city, cars, peds, player, missions, events, flashes, time,
//     heat, heatFloor, busted, wasted, lastOutcome, dirtySave,
//     demo, rng, seed }
// and applies a localStorage save when one exists.
//
// stepWorld(world, input, dt) advances one step in a fixed order —
// player, traffic, car pairs, peds, combat, police, missions, audio
// — then does housekeeping: it snapshots world.lastOutcome from the
// busted/wasted flags BEFORE the missions step (missions.js fails
// the active job on those flags but does not clear them), applies
// respawnPlayer() so the flags are consumed inside the step, trims
// the event log and decays muzzle flashes. When world.demo is set,
// the real input is ignored and demoDrive() flies the player
// instead (title backdrop and screenshot scenes).
//
// input is the adapter player.js / combat.js / missions.js expect:
// { walkAxis, driveAxis, takePressed, isDown, aim, mouse, ... } with
// aim/mouse in world coordinates (main.js builds it from input.js).

import { LANE_OFFSET } from './config.js';
import { createRng } from './random.js';
import { generateCity } from './city.js';
import { createPlayer, stepPlayer } from './player.js';
import { createTraffic, stepTraffic } from './traffic.js';
import { resolveCarPairs, isWrecked } from './drive.js';
import { createPeds, stepPeds } from './peds.js';
import { stepCombat } from './combat.js';
import { stepPolice } from './police.js';
import { createMissions, stepMissions, respawnPlayer } from './missions.js';
import { stepAudio } from './audio.js';
import { loadSave, applySave, saveGame } from './save.js';

const FLASH_TTL = 0.12; // seconds a muzzle flash lives (render.js agrees)
const EVENT_TTL = 3;    // stamped events older than this are dropped
const EVENT_CAP = 200;

export function createWorld(seed) {
  const city = generateCity(seed);
  const world = {
    seed,
    city,
    cars: [],
    peds: [],
    player: null,
    missions: null,
    events: [],
    flashes: [],
    time: 0,
    heat: 0,
    heatFloor: 0,
    busted: false,
    wasted: false,
    lastOutcome: null,
    dirtySave: false,
    demo: false,
    // One shared stream for every runtime system (the same seed the
    // per-module rngFor() fallbacks would derive, so behaviour is
    // identical whether a module runs through world.js or alone).
    rng: createRng(((seed >>> 0) * 2654435761) >>> 0),
  };
  createPlayer(world);
  createTraffic(world);
  createPeds(world);
  createMissions(world);
  const save = loadSave();
  if (save) applySave(world, save);
  return world;
}

export function stepWorld(world, input, dt) {
  world.time += dt;
  const simInput = world.demo ? demoDrive(world, dt) : input;

  stepPlayer(world, simInput, dt);
  stepTraffic(world, dt);
  resolveCarPairs(world);
  stepPeds(world, dt);
  stepCombat(world, simInput, dt);
  stepPolice(world, dt);

  // The outcome of the step, kept where main.js can react to it
  // after the flags themselves are consumed below.
  if (world.busted) world.lastOutcome = 'busted';
  else if (world.wasted) world.lastOutcome = 'wasted';

  stepMissions(world, simInput, dt);

  // Busted/wasted ends the run, not the game: missions.js has
  // already failed any active job; put Rook back on the street.
  if (world.busted) respawnPlayer(world, 'busted');
  else if (world.wasted) respawnPlayer(world, 'wasted');

  stepAudio(world);
  if (world.dirtySave) saveGame(world);

  // Housekeeping ---------------------------------------------------
  if (world.events.length) {
    const cutoff = world.time - EVENT_TTL;
    world.events = world.events.filter(
      (e) => typeof e.t !== 'number' || e.t >= cutoff,
    );
    if (world.events.length > EVENT_CAP) {
      world.events.splice(0, world.events.length - EVENT_CAP);
    }
  }
  if (world.flashes.length) {
    for (const f of world.flashes) f.t += dt;
    world.flashes = world.flashes.filter((f) => f.t <= FLASH_TTL);
  }
}

// ---------------------------------------------------------- demo driver ---
// A stand-in player for the title backdrop and the screenshot
// scenes. On foot it walks to the nearest usable car and gets in;
// driving, it follows its lane like traffic does (same right-hand
// inner lane, same 62/19/19 intersection roll, in miniature) with a
// reverse-out when it wedges. Returns the input adapter for the
// step; the brain lives on world._demoBrain between steps.

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function nearestLine(lines, v) {
  let best = lines[0];
  for (const L of lines) {
    if (Math.abs(L - v) < Math.abs(best - v)) best = L;
  }
  return best;
}

function routeFromHeading(world, car) {
  const a = car.angle;
  if (Math.abs(Math.cos(a)) > Math.abs(Math.sin(a))) {
    return {
      axis: 'h',
      dirSign: Math.cos(a) > 0 ? 1 : -1,
      line: nearestLine(world.city.avenues.ys, car.y),
      decided: null,
      turn: null,
    };
  }
  return {
    axis: 'v',
    dirSign: Math.sin(a) > 0 ? 1 : -1,
    line: nearestLine(world.city.avenues.xs, car.x),
    decided: null,
    turn: null,
  };
}

function routeLane(route) {
  return route.axis === 'h'
    ? route.line + route.dirSign * LANE_OFFSET
    : route.line - route.dirSign * LANE_OFFSET;
}

function routeHeading(route) {
  if (route.axis === 'h') return route.dirSign > 0 ? 0 : Math.PI;
  return route.dirSign > 0 ? Math.PI / 2 : -Math.PI / 2;
}

export function demoDrive(world, dt) {
  const brain = world._demoBrain
    || (world._demoBrain = { wantF: false, route: null, stuckT: 0, reverseT: 0 });
  const player = world.player;
  const input = {
    walkAxis: () => ({ x: 0, y: 0 }),
    driveAxis: () => ({ steer: 0, throttle: 0 }),
    takePressed: (code) => {
      if (code === 'KeyF' && brain.wantF) {
        brain.wantF = false;
        return true;
      }
      return false;
    },
    isDown: () => false,
    aim: null,
    mouse: { x: player ? player.x : 0, y: player ? player.y : 0, down: false },
    mouseDown: false,
    firing: false,
  };
  if (!player) return input;

  // On foot: find a car, walk to it, get in. -------------------------
  if (!player.car) {
    brain.route = null;
    brain.stuckT = 0;
    brain.reverseT = 0;
    let best = null;
    let bestD = Infinity;
    for (const car of world.cars) {
      if (isWrecked(car)) continue;
      const d = Math.hypot(car.x - player.x, car.y - player.y);
      if (d < bestD) {
        bestD = d;
        best = car;
      }
    }
    if (best) {
      const dx = best.x - player.x;
      const dy = best.y - player.y;
      const len = Math.hypot(dx, dy) || 1;
      input.walkAxis = () => ({ x: dx / len, y: dy / len });
      if (bestD < 42) brain.wantF = true; // stepPlayer's reach is 48
    }
    return input;
  }

  // Driving: follow the lane. -----------------------------------------
  const car = player.car;
  if (car.damage > 40) car.damage = 40; // the backdrop car never dies
  let route = brain.route;
  if (!route) route = brain.route = routeFromHeading(world, car);
  if (!route.turn && Math.abs(wrapAngle(car.angle - routeHeading(route))) > 1.25) {
    route = brain.route = routeFromHeading(world, car);
  }

  const along = route.axis === 'h' ? car.x : car.y;
  const crossLines = route.axis === 'h' ? world.city.avenues.xs : world.city.avenues.ys;

  if (!route.turn) {
    let nextCross = null;
    for (const L of crossLines) {
      if ((L - along) * route.dirSign > 8) {
        if (nextCross === null || Math.abs(L - along) < Math.abs(nextCross - along)) {
          nextCross = L;
        }
      }
    }
    if (route.decided !== null && (route.decided - along) * route.dirSign < -60) {
      route.decided = null;
    }
    if (nextCross !== null && route.decided !== nextCross
        && (nextCross - along) * route.dirSign < 125) {
      route.decided = nextCross;
      const headingOut =
        (route.dirSign > 0 && nextCross === crossLines[crossLines.length - 1])
        || (route.dirSign < 0 && nextCross === crossLines[0]);
      const roll = world.rng.next();
      if (headingOut || roll >= 0.62) {
        const right = headingOut ? world.rng.chance(0.5) : roll < 0.81;
        const na = routeHeading(route) + (right ? Math.PI / 2 : -Math.PI / 2);
        const nAxis = Math.abs(Math.cos(na)) > Math.abs(Math.sin(na)) ? 'h' : 'v';
        const nDir = nAxis === 'h'
          ? (Math.cos(na) > 0 ? 1 : -1)
          : (Math.sin(na) > 0 ? 1 : -1);
        const nLane = routeLane({ axis: nAxis, dirSign: nDir, line: nextCross });
        route.turn = {
          tx: nAxis === 'v' ? nLane : route.line + nDir * 140,
          ty: nAxis === 'v' ? route.line + nDir * 140 : nLane,
          axis: nAxis,
          line: nextCross,
          dirSign: nDir,
          fromLine: route.line,
        };
      }
    }
    if (nextCross === null) {
      // Heading off the grid (shoved past the last avenue): U-turn.
      const nDir = -route.dirSign;
      const nLane = routeLane({ axis: route.axis, dirSign: nDir, line: route.line });
      route.turn = {
        tx: route.axis === 'h' ? car.x - route.dirSign * 190 : nLane,
        ty: route.axis === 'h' ? nLane : car.y - route.dirSign * 190,
        axis: route.axis,
        line: route.line,
        dirSign: nDir,
        fromLine: route.line,
      };
    }
  }

  let tx;
  let ty;
  if (route.turn) {
    tx = route.turn.tx;
    ty = route.turn.ty;
    const dTurn = Math.hypot(tx - car.x, ty - car.y);
    const laneNow = routeLane(route.turn);
    const latNow = route.turn.axis === 'h' ? car.y - laneNow : car.x - laneNow;
    const aligned = Math.abs(wrapAngle(car.angle - routeHeading(route.turn))) < 0.25
      && Math.abs(latNow) < 16;
    if (aligned || dTurn < 30) {
      route.axis = route.turn.axis;
      route.line = route.turn.line;
      route.dirSign = route.turn.dirSign;
      route.decided = route.turn.fromLine;
      route.turn = null;
    }
  }
  if (!route.turn) {
    const lane = routeLane(route);
    if (route.axis === 'h') {
      tx = car.x + route.dirSign * 150;
      ty = lane;
    } else {
      tx = lane;
      ty = car.y + route.dirSign * 150;
    }
  }

  const steer = clamp(wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.angle) * 2.6, -1, 1);
  const cruise = route.turn ? 130 : 185;
  let throttle;
  if (car.speed < cruise - 6) throttle = 0.9;
  else if (car.speed > cruise + 10) throttle = -0.4;
  else throttle = 0.12;

  // Wedged against a building or a parked car: back out, re-route.
  if (Math.abs(car.speed) < 6 && throttle > 0) brain.stuckT += dt;
  else brain.stuckT = 0;
  if (brain.stuckT > 2.2) {
    brain.reverseT = 0.8;
    brain.stuckT = 0;
  }
  if (brain.reverseT > 0) {
    brain.reverseT -= dt;
    input.driveAxis = () => ({ steer: -steer, throttle: -1 });
    if (brain.reverseT <= 0) brain.route = null;
    return input;
  }

  input.driveAxis = () => ({ steer, throttle });
  return input;
}
