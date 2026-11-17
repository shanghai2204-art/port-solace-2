// Port Solace — Mara Voss's five jobs, as data + a state machine.
//
// createMissions(world) builds the story state and hangs it on
// world.missions. In free roam the player starts the next unplayed
// job by pressing E within 55px of Mara's cafe. stepMissions()
// advances the active job one step at a time: a step completes when
// the player reaches its target (radius 46) — in a car when the step
// says so. Completing the last step pays out to player.cash, raises
// a 'missionDone' event and sets world.dirtySave.
//
//   M1 First Run      $300   cafe pickup -> harbor warehouse drop
//   M2 Hot Metal      $450   steal a sports car -> the chop shop
//   M3 Clockwork      $500   five checkpoints, 150s on the clock
//   M4 Escort         $650   Mara: cafe -> Garden Row, heat held
//                            at 2 stars (heatFloor) for the ride
//   M5 Solace Burning $1200  downtown pickup, heat set to 4 stars,
//                            then lose the law completely
//
// Getting busted or wasted fails the active job. respawnPlayer()
// is the way back: busted costs a fine (10% of cash, min $50) and
// a walk from police HQ; wasted wakes up at the hospital.

import { PLAYER } from './config.js';

const START_DIST = 55;
const ARRIVE_DIST = 46;

// Step fields:
//   kind       'goto' | 'steal' | 'checkpoints' | 'escape'
//   at         landmark key for goto targets ('park' = the park centre)
//   points     landmark keys, for checkpoints
//   cls        for steal: completes while driving a car of this class
//   requireCls a goto that only completes in a car of this class
//   needCar    the goto only completes while the player is driving
//   setHeat    applied to world.heat when the step completes
//   heatFloor  held on world.heatFloor while this step is current
export const MISSIONS = [
  {
    id: 'm1', title: 'First Run', payout: 300,
    brief: [
      'Mara: Rook. You drive, you don\'t ask what\'s in the box.',
      'Mara: Cafe to the harbor warehouses. Clean run, clean money.',
    ],
    steps: [
      { kind: 'goto', at: 'cafe', text: 'Pick up the package outside the cafe' },
      { kind: 'goto', at: 'chopShop', needCar: true, text: 'Deliver the package to the harbor warehouse' },
    ],
  },
  {
    id: 'm2', title: 'Hot Metal', payout: 450,
    brief: [
      'Mara: A collector wants a sports car. No questions, no names.',
      'Mara: Lift one and bring it to the chop shop by the harbor.',
    ],
    steps: [
      { kind: 'steal', cls: 'sports', text: 'Steal a sports car' },
      { kind: 'goto', at: 'chopShop', needCar: true, requireCls: 'sports', text: 'Deliver the sports car to the chop shop' },
    ],
  },
  {
    id: 'm3', title: 'Clockwork', payout: 500, timeLimit: 150,
    brief: [
      'Mara: Five corners of this city, one clock.',
      'Mara: Hit them all before the time dies and the money is yours.',
    ],
    steps: [
      {
        kind: 'checkpoints', needCar: true,
        points: ['hq', 'impound', 'hospital', 'chopShop', 'cafe'],
        text: 'Hit every checkpoint before the clock runs out',
      },
    ],
  },
  {
    id: 'm4', title: 'Escort', payout: 650,
    brief: [
      'Mara: I need a ride to Garden Row, and I need it quiet.',
      'Mara: It will not be quiet. Drive anyway.',
    ],
    steps: [
      { kind: 'goto', at: 'cafe', needCar: true, text: 'Pick Mara up at the cafe' },
      { kind: 'goto', at: 'park', needCar: true, heatFloor: 200, text: 'Drive Mara to the Garden Row park' },
    ],
  },
  {
    id: 'm5', title: 'Solace Burning', payout: 1200,
    brief: [
      'Mara: Downtown. Now. Every badge in Port Solace is about',
      'Mara: to know your name. Pick it up — then disappear.',
    ],
    steps: [
      { kind: 'goto', at: 'hq', needCar: true, setHeat: 350, text: 'Pick up the package downtown' },
      { kind: 'escape', text: 'Lose the heat — all of it' },
    ],
  },
];

// -------------------------------------------------------------- state ---
export function createMissions(world) {
  const state = {
    world,
    defs: MISSIONS,
    active: null,   // { def, stepIndex, timeLeft, cpIndex }
    done: [],       // mission ids, in completion order
    lastFailed: null,
  };
  world.missions = state;
  return state;
}

function stateFor(world) {
  return world.missions || createMissions(world);
}

function nextDef(state) {
  for (const def of state.defs) {
    if (!state.done.includes(def.id)) return def;
  }
  return null;
}

// Resolve a landmark key (or 'park') to world coordinates.
function targetFor(world, key) {
  if (key === 'park') {
    const park = world.city.park;
    if (park) return { x: park.x + park.w / 2, y: park.y + park.h / 2 };
    return { x: 1600, y: 1800 };
  }
  return world.city.landmarks[key];
}

function currentStep(state) {
  if (!state.active) return null;
  return state.active.def.steps[state.active.stepIndex];
}

// ------------------------------------------------------------ endings ---
function endMission(world, state, completed) {
  const active = state.active;
  if (!active) return;
  if (completed) {
    state.done.push(active.def.id);
    world.player.cash += active.def.payout;
    world.events.push({
      type: 'missionDone',
      x: world.player.x, y: world.player.y,
      severity: 1, byPlayer: true,
    });
    world.dirtySave = true;
  } else {
    state.lastFailed = active.def.id;
    world.events.push({
      type: 'missionFailed',
      x: world.player.x, y: world.player.y,
      severity: 1, byPlayer: true,
    });
  }
  world.heatFloor = 0;
  state.active = null;
}

function failMission(world, state) {
  endMission(world, state, false);
}

// Advance to the next step, applying the effects the finished step
// and the incoming step carry. Returns true when the job is over.
function advance(world, state) {
  const active = state.active;
  const finished = active.def.steps[active.stepIndex];
  if (finished.setHeat !== undefined) world.heat = finished.setHeat;
  active.stepIndex += 1;
  active.cpIndex = 0;
  if (active.stepIndex >= active.def.steps.length) {
    endMission(world, state, true);
    return true;
  }
  const incoming = active.def.steps[active.stepIndex];
  if (incoming.heatFloor !== undefined) world.heatFloor = incoming.heatFloor;
  return false;
}

function startMission(world, state, def) {
  state.active = {
    def,
    stepIndex: 0,
    cpIndex: 0,
    timeLeft: def.timeLimit !== undefined ? def.timeLimit : null,
  };
  const first = def.steps[0];
  if (first.heatFloor !== undefined) world.heatFloor = first.heatFloor;
}

// ------------------------------------------------------------ stepping ---
function stepComplete(world, state, step) {
  const player = world.player;
  if (step.kind === 'steal') {
    return !!(player.car && player.car.cls === step.cls);
  }
  if (step.kind === 'escape') {
    return (player.wanted || 0) === 0;
  }
  if (step.kind === 'checkpoints') {
    if (step.needCar && !player.car) return false;
    const pt = targetFor(world, step.points[state.active.cpIndex]);
    const d = Math.hypot(player.x - pt.x, player.y - pt.y);
    if (d > ARRIVE_DIST) return false;
    // One checkpoint per call; the last one completes the step.
    if (state.active.cpIndex < step.points.length - 1) {
      state.active.cpIndex += 1;
      return false;
    }
    return true;
  }
  // goto
  if (step.needCar && !player.car) return false;
  if (step.requireCls && (!player.car || player.car.cls !== step.requireCls)) {
    return false;
  }
  const pt = targetFor(world, step.at);
  const d = Math.hypot(player.x - pt.x, player.y - pt.y);
  return d <= ARRIVE_DIST;
}

export function stepMissions(world, input, dt) {
  const state = stateFor(world);
  const player = world.player;
  if (!player) return;

  // Busted or wasted ends the run of the job, not the game.
  if (state.active && (world.busted || world.wasted)) {
    failMission(world, state);
    return;
  }

  if (!state.active) {
    const def = nextDef(state);
    if (!def) return;
    const cafe = world.city.landmarks.cafe;
    const d = Math.hypot(player.x - cafe.x, player.y - cafe.y);
    if (d <= START_DIST && input && typeof input.takePressed === 'function'
        && input.takePressed('KeyE')) {
      startMission(world, state, def);
    }
    return;
  }

  const active = state.active;
  if (active.timeLeft !== null) {
    active.timeLeft -= dt;
    if (active.timeLeft <= 0) {
      failMission(world, state);
      return;
    }
  }

  // At most one step completes per call, so a step's on-completion
  // effects (M5's heat, say) are never judged against stale state
  // in the same frame they land.
  const step = currentStep(state);
  if (step && stepComplete(world, state, step)) {
    advance(world, state);
  }
}

// ------------------------------------------------------------ the HUD ---
export function currentObjective(state) {
  const world = state.world;
  const cafe = world.city.landmarks.cafe;
  if (!state.active) {
    const def = nextDef(state);
    if (!def) {
      return {
        x: cafe.x, y: cafe.y,
        title: 'Port Solace',
        text: 'Every job is done. The city is yours.',
      };
    }
    return {
      x: cafe.x, y: cafe.y,
      title: def.title,
      text: 'Meet Mara at the cafe — press E',
    };
  }
  const active = state.active;
  const step = active.def.steps[active.stepIndex];
  let pt;
  let text = step.text;
  if (step.kind === 'escape') {
    pt = { x: world.player.x, y: world.player.y };
  } else if (step.kind === 'steal') {
    pt = { x: world.player.x, y: world.player.y };
  } else if (step.kind === 'checkpoints') {
    pt = targetFor(world, step.points[active.cpIndex]);
    text = `Checkpoint ${active.cpIndex + 1} of ${step.points.length} — ${step.text}`;
  } else {
    pt = targetFor(world, step.at);
  }
  const obj = { x: pt.x, y: pt.y, title: active.def.title, text };
  if (active.timeLeft !== null) obj.timeLeft = active.timeLeft;
  return obj;
}

// -------------------------------------------------------------- respawn ---
export function respawnPlayer(world, kind) {
  const player = world.player;
  if (!player) return;
  const state = stateFor(world);
  if (state.active) failMission(world, state);

  // Leave the car behind: it stays where it stopped, driverless.
  if (player.car) {
    player.car.driver = null;
    player.car.parked = true;
    player.car = null;
  }

  let spot;
  if (kind === 'busted') {
    const fine = Math.max(50, Math.floor(player.cash * 0.1));
    player.cash = Math.max(0, player.cash - fine);
    spot = world.city.landmarks.hq;
  } else {
    // 'wasted'
    player.health = PLAYER.health;
    spot = world.city.landmarks.hospital;
  }
  const res = world.city.collide(spot.x, spot.y, PLAYER.radius);
  player.x = res.x;
  player.y = res.y;
  player.wanted = 0;
  world.heat = 0;
  world.heatFloor = 0;
  world.busted = false;
  world.wasted = false;
}
