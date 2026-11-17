// Port Solace — localStorage save.
//
// One key, one small object: { cash, missionsDone, playerPos }.
// saveGame() only writes when world.dirtySave is set (missions.js
// sets it when a job is completed) and clears the flag once the
// write lands, so the save point is "the story so far", never a
// mid-chase snapshot. Everything is guarded: with no localStorage
// (headless, private mode, quota errors) the game simply runs
// unsaved.

import { PLAYER } from './config.js';
import { MISSIONS } from './missions.js';

export const SAVE_KEY = 'port-solace-save-v1';

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function saveGame(world) {
  if (!world || !world.dirtySave) return false;
  const ls = storage();
  if (!ls || !world.player || !world.missions) return false;
  try {
    const data = {
      cash: world.player.cash,
      missionsDone: world.missions.done.slice(),
      playerPos: { x: Math.round(world.player.x), y: Math.round(world.player.y) },
    };
    ls.setItem(SAVE_KEY, JSON.stringify(data));
    world.dirtySave = false;
    return true;
  } catch {
    return false;
  }
}

export function loadSave() {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (typeof data.cash !== 'number' || !Number.isFinite(data.cash)) return null;
    if (!Array.isArray(data.missionsDone)) return null;
    const pos = data.playerPos;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

export function applySave(world, data) {
  if (!world || !data || !world.player || !world.missions) return false;
  world.player.cash = Math.max(0, Math.floor(data.cash));

  // Only ids the game actually knows, each at most once.
  const known = new Set(MISSIONS.map((m) => m.id));
  const done = [];
  for (const id of data.missionsDone) {
    if (known.has(id) && !done.includes(id)) done.push(id);
  }
  world.missions.done = done;

  // Drop Rook back where he was — on foot, clear of the buildings.
  if (!world.player.car && data.playerPos) {
    const res = world.city.collide(data.playerPos.x, data.playerPos.y, PLAYER.radius);
    world.player.x = res.x;
    world.player.y = res.y;
  }
  return true;
}

export function clearSave() {
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(SAVE_KEY);
  } catch {
    // Nothing to clear is not an error.
  }
}
