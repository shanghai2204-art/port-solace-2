// Port Solace — the player (Rook).
//
// createPlayer(world) spawns the player on foot at Mara's cafe in
// Old Town. stepPlayer(world, input, dt) runs one step:
//
//   input is the object produced by input.js (or an adapter with the
//   same shape):
//     walkAxis()  -> { x, y }        on-foot movement intent
//     driveAxis() -> { steer, throttle }
//     takePressed(code) -> bool      one-shot key presses ('KeyF')
//     isDown(code) -> bool           optional; Shift = sprint,
//                                    Space = handbrake while driving
//     aim / mouseWorld / mouse       optional { x, y } in WORLD
//                                    coordinates: the point the
//                                    on-foot player faces. Without
//                                    one, he faces his movement.
//
// On foot: walk/sprint with building collision, F near a car gets
// in. Getting into an AI-driven car is a jacking: a 'theft' event is
// raised and the driver is ejected as a fleeing pedestrian. While
// driving, input feeds stepCar() and the player rides the car; F at
// low speed gets out beside it.

import { PLAYER, CAR_CLASSES } from './config.js';
import { createRng } from './random.js';
import { stepCar } from './drive.js';
import { makePed } from './peds.js';

const ENTER_DIST = 48;
const EXIT_MAX_SPEED = 80;

function rngFor(world) {
  if (!world.rng) {
    world.rng = createRng(((world.city.seed >>> 0) * 2654435761) >>> 0);
  }
  return world.rng;
}

function isDown(input, code) {
  return typeof input.isDown === 'function' ? input.isDown(code) : false;
}

function aimPoint(input) {
  return input.aim || input.mouseWorld || input.mouse || null;
}

export function createPlayer(world) {
  const spawn = world.city.spawnPoints().player; // Mara's cafe
  const player = {
    x: spawn.x,
    y: spawn.y,
    angle: Math.PI / 2, // facing the cafe (south, into the block)
    health: PLAYER.health,
    cash: PLAYER.startCash,
    car: null,
    wanted: 0,
  };
  world.player = player;
  return player;
}

function findEnterableCar(world, player) {
  let best = null;
  let bestD2 = ENTER_DIST * ENTER_DIST;
  for (const car of world.cars) {
    const spec = CAR_CLASSES[car.cls] || CAR_CLASSES.sedan;
    if (car.damage >= spec.health) continue; // a wreck is no use
    const dx = car.x - player.x;
    const dy = car.y - player.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = car;
    }
  }
  return best;
}

function enterCar(world, player, car) {
  if (car.driver === 'ai') {
    // Jacking: the driver bails out and runs.
    world.events.push({
      type: 'theft', x: car.x, y: car.y, severity: 2, byPlayer: true,
    });
    if (!world.peds) world.peds = [];
    const rng = rngFor(world);
    const side = car.angle - Math.PI / 2;
    const ped = makePed(
      rng,
      car.x + Math.cos(side) * 16,
      car.y + Math.sin(side) * 16,
      null,
    );
    ped.state = 'flee';
    ped.timer = 2.4;
    ped.fleeX = player.x;
    ped.fleeY = player.y;
    const res = world.city.collide(ped.x, ped.y, 6);
    ped.x = res.x;
    ped.y = res.y;
    world.peds.push(ped);
  }
  car.driver = 'player';
  car.parked = false;
  player.car = car;
  player.x = car.x;
  player.y = car.y;
  player.angle = car.angle;
}

function exitCar(world, player) {
  const car = player.car;
  const spec = CAR_CLASSES[car.cls] || CAR_CLASSES.sedan;
  const side = car.angle - Math.PI / 2; // step out on the left
  const off = spec.h / 2 + PLAYER.radius + 4;
  const nx = car.x + Math.cos(side) * off;
  const ny = car.y + Math.sin(side) * off;
  const res = world.city.collide(nx, ny, PLAYER.radius);
  player.x = res.x;
  player.y = res.y;
  player.angle = car.angle;
  player.car = null;
  car.driver = null;
  car.parked = true;
}

export function stepPlayer(world, input, dt) {
  const player = world.player;
  if (!player) return;

  // Driving ---------------------------------------------------------
  if (player.car) {
    const car = player.car;
    if (input.takePressed('KeyF') && Math.abs(car.speed) <= EXIT_MAX_SPEED) {
      exitCar(world, player);
      return;
    }
    const drive = input.driveAxis();
    stepCar(world, car, {
      throttle: drive.throttle,
      steer: drive.steer,
      handbrake: isDown(input, 'Space'),
    }, dt);
    player.x = car.x;
    player.y = car.y;
    player.angle = car.angle;
    return;
  }

  // On foot: get into a car ------------------------------------------
  if (input.takePressed('KeyF')) {
    const car = findEnterableCar(world, player);
    if (car) {
      enterCar(world, player, car);
      return;
    }
  }

  // On foot: move ------------------------------------------------------
  const axis = input.walkAxis();
  const sprint = isDown(input, 'ShiftLeft') || isDown(input, 'ShiftRight');
  const speed = sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
  const len = Math.hypot(axis.x, axis.y);
  if (len > 0) {
    const nx = player.x + (axis.x / len) * speed * dt;
    const ny = player.y + (axis.y / len) * speed * dt;
    const res = world.city.collide(nx, ny, PLAYER.radius);
    player.x = res.x;
    player.y = res.y;
    if (!aimPoint(input)) {
      player.angle = Math.atan2(axis.y, axis.x);
    }
  }
  const aim = aimPoint(input);
  if (aim) {
    const dx = aim.x - player.x;
    const dy = aim.y - player.y;
    if (dx * dx + dy * dy > 4 * 4) {
      player.angle = Math.atan2(dy, dx);
    }
  }
}
