// Port Solace — the renderer. Canvas 2D, one pass over the world
// from a camera that follows Rook (or his car), then the HUD in
// screen space: cash + health, wanted stars, the mission line with
// Mara's phone-style brief, and the minimap. The title / banner /
// busted-wasted / complete overlays are exported for main.js's
// state machine.
//
// Deterministic for a given world state: every flicker and puff is
// a function of world.time and entity positions — no Math.random.

import {
  WORLD, DISTRICTS, COLORS, ROAD_HALF, SIDEWALK_W, LANE_OFFSET,
  CAR_CLASSES,
} from './config.js';
import { currentObjective } from './missions.js';
import { loadSave } from './save.js';

export const VIEW_W = 1280;
export const VIEW_H = 800;

const MAP_W = 220;
const MAP_H = 165;
const FLASH_TTL = 0.12;
const GOLD = '#e8b93a';
const TEAL = '#2ee6c8';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp((n >> 16) + amt, 0, 255);
  const g = clamp(((n >> 8) & 0xff) + amt, 0, 255);
  const b = clamp((n & 0xff) + amt, 0, 255);
  return `rgb(${r},${g},${b})`;
}

// Rounded-rect path (no roundRect: older canvas, same result).
function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function focusOf(world) {
  const p = world.player;
  if (!p) return { x: WORLD.W / 2, y: WORLD.H / 2 };
  return p.car || p;
}

export function computeCamera(world) {
  const f = focusOf(world);
  return {
    x: clamp(f.x - VIEW_W / 2, 0, Math.max(0, WORLD.W - VIEW_W)),
    y: clamp(f.y - VIEW_H / 2, 0, Math.max(0, WORLD.H - VIEW_H)),
  };
}

function inView(x, y, cam, pad) {
  return x > cam.x - pad && x < cam.x + VIEW_W + pad
    && y > cam.y - pad && y < cam.y + VIEW_H + pad;
}

// ------------------------------------------------------------- the world ---
function drawGround(ctx, world, cam) {
  const city = world.city;
  for (const d of DISTRICTS) {
    ctx.fillStyle = d.ground;
    ctx.fillRect(d.x, d.y, d.w, d.h);
  }

  // The park: grass, a cross of paths, the trees.
  if (city.park) {
    const park = city.park;
    ctx.fillStyle = COLORS.parkGrass;
    ctx.fillRect(park.x, park.y, park.w, park.h);
    ctx.fillStyle = COLORS.parkPath;
    ctx.fillRect(park.x, park.y + park.h / 2 - 10, park.w, 20);
    ctx.fillRect(park.x + park.w / 2 - 10, park.y, 20, park.h);
    for (const tree of park.trees) {
      ctx.fillStyle = COLORS.tree;
      ctx.beginPath();
      ctx.arc(tree.x, tree.y, tree.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.treeLight;
      ctx.beginPath();
      ctx.arc(tree.x - tree.r * 0.25, tree.y - tree.r * 0.25, tree.r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Roads: sidewalk band, asphalt, intersection pads, markings.
  const band = ROAD_HALF + SIDEWALK_W;
  for (const x of city.avenues.xs) {
    if (x + band < cam.x || x - band > cam.x + VIEW_W) continue;
    ctx.fillStyle = COLORS.sidewalk;
    ctx.fillRect(x - band, 0, band * 2, WORLD.H);
    ctx.fillStyle = COLORS.asphalt;
    ctx.fillRect(x - ROAD_HALF, 0, ROAD_HALF * 2, WORLD.H);
  }
  for (const y of city.avenues.ys) {
    if (y + band < cam.y || y - band > cam.y + VIEW_H) continue;
    ctx.fillStyle = COLORS.sidewalk;
    ctx.fillRect(0, y - band, WORLD.W, band * 2);
    ctx.fillStyle = COLORS.asphalt;
    ctx.fillRect(0, y - ROAD_HALF, WORLD.W, ROAD_HALF * 2);
  }
  ctx.fillStyle = COLORS.asphaltCross;
  for (const x of city.avenues.xs) {
    for (const y of city.avenues.ys) {
      if (!inView(x, y, cam, ROAD_HALF + 4)) continue;
      ctx.fillRect(x - ROAD_HALF, y - ROAD_HALF, ROAD_HALF * 2, ROAD_HALF * 2);
    }
  }
  // Lane separators (soft) + dashed centre lines.
  ctx.fillStyle = COLORS.laneMarkWhite;
  ctx.globalAlpha = 0.16;
  for (const x of city.avenues.xs) {
    if (x + band < cam.x || x - band > cam.x + VIEW_W) continue;
    ctx.fillRect(x - LANE_OFFSET - 1, 0, 2, WORLD.H);
    ctx.fillRect(x + LANE_OFFSET - 1, 0, 2, WORLD.H);
  }
  for (const y of city.avenues.ys) {
    if (y + band < cam.y || y - band > cam.y + VIEW_H) continue;
    ctx.fillRect(0, y - LANE_OFFSET - 1, WORLD.W, 2);
    ctx.fillRect(0, y + LANE_OFFSET - 1, WORLD.W, 2);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.laneMark;
  const dashFrom = Math.floor(cam.y / 36) * 36;
  for (const x of city.avenues.xs) {
    if (x < cam.x - 4 || x > cam.x + VIEW_W + 4) continue;
    for (let y = dashFrom; y < cam.y + VIEW_H + 36; y += 36) {
      ctx.fillRect(x - 2, y, 4, 18);
    }
  }
  const dashFromX = Math.floor(cam.x / 36) * 36;
  for (const y of city.avenues.ys) {
    if (y < cam.y - 4 || y > cam.y + VIEW_H + 4) continue;
    for (let x = dashFromX; x < cam.x + VIEW_W + 36; x += 36) {
      ctx.fillRect(x, y - 2, 18, 4);
    }
  }

  // Buildings: shadow, body, inset roof.
  for (const b of city.buildings) {
    if (!inView(b.x + b.w / 2, b.y + b.h / 2, cam, Math.max(b.w, b.h))) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(b.x + 6, b.y + 8, b.w, b.h);
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = shade(b.color, 20);
    const inset = Math.min(9, b.w / 5, b.h / 5);
    ctx.fillRect(b.x + inset, b.y + inset, b.w - inset * 2, b.h - inset * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
}

function drawObjectiveMarker(ctx, world) {
  if (!world.missions) return;
  const obj = currentObjective(world.missions);
  const focus = focusOf(world);
  if (Math.hypot(obj.x - focus.x, obj.y - focus.y) < 40) return;
  const pulse = 0.5 + 0.5 * Math.sin(world.time * 4);
  // The light pillar: two stacked washes, brightest at the ground.
  ctx.fillStyle = 'rgba(232,185,58,0.05)';
  ctx.fillRect(obj.x - 9, obj.y - 190, 18, 190);
  ctx.fillStyle = 'rgba(232,185,58,0.09)';
  ctx.fillRect(obj.x - 4.5, obj.y - 190, 9, 190);
  ctx.strokeStyle = `rgba(232,185,58,${0.55 + pulse * 0.4})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(obj.x, obj.y, 24 + pulse * 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = GOLD;
  ctx.save();
  ctx.translate(obj.x, obj.y);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-5, -5, 10, 10);
  ctx.restore();
}

function drawCar(ctx, world, car) {
  const spec = CAR_CLASSES[car.cls] || CAR_CLASSES.sedan;
  const w = spec.w;
  const h = spec.h;
  const police = car.driver === 'police' || car.cls === 'cop';
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  rr(ctx, -w / 2 + 3, -h / 2 + 4, w, h, 5);
  ctx.fill();
  ctx.fillStyle = police ? '#dfe3e8' : car.color;
  rr(ctx, -w / 2, -h / 2, w, h, 5);
  ctx.fill();
  ctx.fillStyle = shade(police ? '#c9ced6' : car.color, 22);
  rr(ctx, -w * 0.16, -h / 2 + 2.5, w * 0.34, h - 5, 3);
  ctx.fill();
  ctx.fillStyle = 'rgba(14,18,26,0.88)';
  ctx.fillRect(w * 0.2, -h / 2 + 2.5, w * 0.1, h - 5);   // windshield
  ctx.fillRect(-w * 0.3, -h / 2 + 2.5, w * 0.08, h - 5); // rear glass
  if (police) {
    ctx.fillStyle = '#23262c';
    ctx.fillRect(-w * 0.05, -h / 2, w * 0.14, h);
    const phase = Math.floor(world.time * 3.5) % 2 === 0;
    ctx.fillStyle = phase ? '#ff3b30' : '#7a130e';
    ctx.fillRect(-3, -h / 2 + 1.5, 6, h / 2 - 1.5);
    ctx.fillStyle = phase ? '#3f7bff' : '#1c4fd6';
    ctx.fillRect(-3, 0, 6, h / 2 - 1.5);
  }
  ctx.restore();

  // The player's ride gets the teal ring too.
  if (world.player && world.player.car === car) {
    ctx.strokeStyle = TEAL;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(car.x, car.y, w * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Damage smoke: puffs whose rise is a function of time + position.
  if (car.damage > 55) {
    const sev = Math.min(1, (car.damage - 55) / 65);
    for (let i = 0; i < 3; i++) {
      const ph = (world.time * 0.7 + i * 0.37 + ((car.x * 13 + car.y * 7) % 10) / 14) % 1;
      ctx.fillStyle = `rgba(122,122,128,${(0.34 * (1 - ph) * (0.4 + sev * 0.6)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(car.x + Math.sin(i * 2.4) * 4, car.y - 10 - ph * 26, 4 + ph * 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawWorldView(ctx, world, cam, marker) {
  ctx.save();
  ctx.translate(-cam.x, -cam.y);
  drawGround(ctx, world, cam);
  if (marker) drawObjectiveMarker(ctx, world);

  for (const car of world.cars) {
    if (!inView(car.x, car.y, cam, 70)) continue;
    drawCar(ctx, world, car);
  }

  for (const ped of world.peds) {
    if (!inView(ped.x, ped.y, cam, 30)) continue;
    if (ped.state === 'down') {
      ctx.save();
      ctx.translate(ped.x, ped.y);
      ctx.rotate(ped.angle);
      ctx.fillStyle = shade(ped.color, -34);
      rr(ctx, -8, -3.5, 16, 7, 3);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = ped.color;
      ctx.beginPath();
      ctx.arc(ped.x, ped.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shade(ped.color, 34);
      ctx.beginPath();
      ctx.arc(
        ped.x + Math.cos(ped.angle) * 2, ped.y + Math.sin(ped.angle) * 2,
        2.2, 0, Math.PI * 2,
      );
      ctx.fill();
    }
  }

  // Rook himself, on foot.
  const player = world.player;
  if (player && !player.car) {
    ctx.strokeStyle = TEAL;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(player.x, player.y, 13 + Math.sin(world.time * 3) * 1.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#17b39b';
    ctx.beginPath();
    ctx.arc(player.x, player.y, 7.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(player.x, player.y);
    ctx.lineTo(
      player.x + Math.cos(player.angle) * 11,
      player.y + Math.sin(player.angle) * 11,
    );
    ctx.stroke();
  }

  // Muzzle flashes.
  for (const f of world.flashes) {
    const a = clamp(1 - f.t / FLASH_TTL, 0, 1);
    if (a <= 0) continue;
    ctx.strokeStyle = `rgba(255,214,120,${(a * 0.9).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(f.x1, f.y1);
    ctx.lineTo(f.x2, f.y2);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,240,200,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(f.x1, f.y1, 3.5 * a + 1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- the HUD ---
const briefSeen = new WeakMap();

function activeBriefDef(world) {
  const st = world.missions;
  if (!st || !st.active) return null;
  const id = st.active.def.id;
  let rec = briefSeen.get(world);
  if (!rec || rec.id !== id) {
    rec = { id, at: world.time };
    briefSeen.set(world, rec);
  }
  return world.time - rec.at < 6 ? st.active.def : null;
}

function star(ctx, cx, cy, r, filled) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  if (filled) ctx.fill();
  else ctx.stroke();
}

function fmtCash(n) {
  return '$' + String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtTime(s) {
  const total = Math.max(0, Math.ceil(s));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function drawMinimap(ctx, world, cam) {
  const mx = VIEW_W - MAP_W - 14;
  const my = VIEW_H - MAP_H - 14;
  const s = MAP_W / WORLD.W;
  ctx.save();
  rr(ctx, mx, my, MAP_W, MAP_H, 6);
  ctx.fillStyle = 'rgba(6,8,12,0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(mx, my, MAP_W, MAP_H);
  ctx.clip();

  if (world.city.park) {
    const park = world.city.park;
    ctx.fillStyle = COLORS.parkGrass;
    ctx.fillRect(mx + park.x * s, my + park.y * s, park.w * s, park.h * s);
  }
  ctx.strokeStyle = '#7d838c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of world.city.avenues.xs) {
    ctx.moveTo(mx + x * s, my);
    ctx.lineTo(mx + x * s, my + MAP_H);
  }
  for (const y of world.city.avenues.ys) {
    ctx.moveTo(mx, my + y * s);
    ctx.lineTo(mx + MAP_W, my + y * s);
  }
  ctx.stroke();

  ctx.fillStyle = 'rgba(198,203,210,0.5)';
  for (const b of world.city.buildings) {
    ctx.fillRect(mx + b.x * s, my + b.y * s, Math.max(1.5, b.w * s), Math.max(1.5, b.h * s));
  }

  // Police blips, alternating red/blue.
  let pi = 0;
  for (const car of world.cars) {
    if (car.driver !== 'police') continue;
    ctx.fillStyle = Math.floor(world.time * 3 + pi) % 2 === 0 ? '#ff5147' : '#4f8dff';
    ctx.fillRect(mx + car.x * s - 2, my + car.y * s - 2, 4, 4);
    pi++;
  }

  // The objective.
  if (world.missions) {
    const obj = currentObjective(world.missions);
    const focus = focusOf(world);
    if (Math.hypot(obj.x - focus.x, obj.y - focus.y) >= 40) {
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(mx + obj.x * s, my + obj.y * s, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(232,185,58,${(0.5 + 0.4 * Math.sin(world.time * 4)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(mx + obj.x * s, my + obj.y * s, 5.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // The camera's footprint, then Rook's arrow.
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.strokeRect(mx + cam.x * s, my + cam.y * s, VIEW_W * s, VIEW_H * s);
  const player = world.player;
  if (player) {
    ctx.save();
    ctx.translate(mx + player.x * s, my + player.y * s);
    ctx.rotate(player.angle);
    ctx.fillStyle = TEAL;
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, -4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawHUD(ctx, world, cam) {
  const player = world.player;
  if (!player) return;

  // Cash + health, top-left.
  rr(ctx, 14, 14, 200, 66, 8);
  ctx.fillStyle = 'rgba(8,10,14,0.62)';
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f2f4f6';
  ctx.font = '700 21px system-ui, sans-serif';
  ctx.fillText(fmtCash(player.cash), 26, 42);
  ctx.fillStyle = 'rgba(230,235,240,0.55)';
  ctx.font = '600 9px system-ui, sans-serif';
  ctx.fillText('C A S H', 27, 55);
  ctx.fillStyle = 'rgba(10,12,16,0.8)';
  ctx.fillRect(120, 28, 80, 10);
  const hp = clamp(player.health / 100, 0, 1);
  ctx.fillStyle = hp > 0.5 ? '#3fce6c' : hp > 0.25 ? '#e8b93a' : '#e5484d';
  ctx.fillRect(120, 28, 80 * hp, 10);
  const district = world.city.districtAt(player.x, player.y);
  ctx.fillStyle = 'rgba(230,235,240,0.75)';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillText(district ? district.name : '', 120, 55);

  // Wanted stars, top-right.
  const wanted = clamp(player.wanted || 0, 0, 5);
  for (let i = 0; i < 5; i++) {
    const cx = VIEW_W - 30 - (4 - i) * 32;
    if (i < wanted) {
      ctx.fillStyle = GOLD;
      star(ctx, cx, 32, 12, true);
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      star(ctx, cx, 32, 12, false);
    }
  }

  // Mission line, top-centre.
  if (world.missions) {
    const obj = currentObjective(world.missions);
    ctx.textAlign = 'center';
    ctx.fillStyle = GOLD;
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillText(obj.title.toUpperCase(), VIEW_W / 2, 30);
    ctx.fillStyle = '#f2f4f6';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText(obj.text, VIEW_W / 2, 54);
    if (obj.timeLeft !== undefined && obj.timeLeft !== null) {
      ctx.fillStyle = obj.timeLeft < 30 ? '#ff6b60' : '#f2f4f6';
      ctx.font = '700 15px system-ui, sans-serif';
      ctx.fillText(fmtTime(obj.timeLeft), VIEW_W / 2, 76);
    }

    // Mara's brief, phone-style, for the mission's first seconds.
    const def = activeBriefDef(world);
    if (def) {
      const bw = 520;
      const bh = 44 + def.brief.length * 19;
      const bx = VIEW_W / 2 - bw / 2;
      const by = 88;
      rr(ctx, bx, by, bw, bh, 12);
      ctx.fillStyle = 'rgba(10,16,24,0.88)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(46,230,200,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = TEAL;
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.fillText('M A R A   V O S S', bx + 18, by + 20);
      ctx.fillStyle = '#eef3f6';
      ctx.font = '14px system-ui, sans-serif';
      def.brief.forEach((line, i) => {
        ctx.fillText(line, bx + 18, by + 42 + i * 19);
      });
      ctx.textAlign = 'center';
    }
  }

  drawMinimap(ctx, world, cam);
}

// ------------------------------------------------------------------- draw ---
// input (optional) is the frame's view data: { aim: {x, y} in world
// coordinates, firing / mouseDown } — used for the on-foot aim line.
export function draw(ctx, world, input) {
  const cam = computeCamera(world);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  drawWorldView(ctx, world, cam, true);

  const player = world.player;
  if (player && !player.car && input && input.aim && (input.firing || input.mouseDown)) {
    ctx.strokeStyle = 'rgba(46,230,200,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(player.x - cam.x, player.y - cam.y);
    ctx.lineTo(input.aim.x - cam.x, input.aim.y - cam.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawHUD(ctx, world, cam);
}

// --------------------------------------------------------------- overlays ---
export function drawBanner(ctx, title, sub) {
  ctx.fillStyle = 'rgba(5,6,10,0.55)';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.fillStyle = GOLD;
  ctx.fillRect(VIEW_W / 2 - 150, VIEW_H / 2 - 58, 300, 3);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f5f7f9';
  ctx.font = '800 46px system-ui, sans-serif';
  ctx.fillText(title, VIEW_W / 2, VIEW_H / 2 + 6);
  if (sub) {
    ctx.fillStyle = 'rgba(238,242,246,0.85)';
    ctx.font = '400 19px system-ui, sans-serif';
    ctx.fillText(sub, VIEW_W / 2, VIEW_H / 2 + 42);
  }
  ctx.textAlign = 'left';
}

export function drawTitle(ctx, world) {
  const t = world.time;
  const cx = 1600 + Math.sin(t * 0.05) * 200;
  const cy = 620 + Math.cos(t * 0.037) * 130;
  const cam = {
    x: clamp(cx - VIEW_W / 2, 0, WORLD.W - VIEW_W),
    y: clamp(cy - VIEW_H / 2, 0, WORLD.H - VIEW_H),
  };
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  drawWorldView(ctx, world, cam, false);

  // Vignette washes.
  ctx.fillStyle = 'rgba(4,5,9,0.30)';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.fillStyle = 'rgba(4,5,9,0.45)';
  ctx.fillRect(0, 0, VIEW_W, 120);
  ctx.fillRect(0, VIEW_H - 170, VIEW_W, 170);

  ctx.textAlign = 'center';
  try { ctx.letterSpacing = '10px'; } catch { /* cosmetic only */ }
  ctx.fillStyle = '#f5f7f9';
  ctx.font = '800 84px system-ui, sans-serif';
  ctx.fillText('PORT SOLACE', VIEW_W / 2, 218);
  try { ctx.letterSpacing = '2px'; } catch { /* cosmetic only */ }
  ctx.fillStyle = GOLD;
  ctx.font = '600 21px system-ui, sans-serif';
  ctx.fillText('Every crew in the city wants one wheelman. Tonight, that\'s you.', VIEW_W / 2, 262);

  ctx.fillStyle = `rgba(245,247,249,${(0.6 + 0.4 * Math.sin(t * 2.4)).toFixed(3)})`;
  ctx.font = '700 19px system-ui, sans-serif';
  ctx.fillText(
    loadSave() ? 'Press any key to continue' : 'Press any key to start',
    VIEW_W / 2, VIEW_H - 118,
  );
  ctx.fillStyle = 'rgba(235,239,244,0.78)';
  ctx.font = '400 14px system-ui, sans-serif';
  ctx.fillText('WASD / arrows — walk and drive      F — enter / exit a car      E — take a job from Mara', VIEW_W / 2, VIEW_H - 84);
  ctx.fillText('Mouse — aim      Click — shoot (on foot)      Shift — sprint      Space — handbrake', VIEW_W / 2, VIEW_H - 60);
  ctx.fillText('P / Esc — pause      M — mute' + (loadSave() ? '      N — new game (erases the saved run)' : ''), VIEW_W / 2, VIEW_H - 36);
  try { ctx.letterSpacing = '0px'; } catch { /* cosmetic only */ }
  ctx.textAlign = 'left';
}

export function drawBustedWasted(ctx, world) {
  draw(ctx, world);
  const wasted = world.lastOutcome === 'wasted';
  ctx.fillStyle = wasted ? 'rgba(140,16,16,0.25)' : 'rgba(24,42,120,0.22)';
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.textAlign = 'center';
  try { ctx.letterSpacing = '14px'; } catch { /* cosmetic only */ }
  ctx.fillStyle = wasted ? '#ffb3ab' : '#dbe7ff';
  ctx.font = '800 76px system-ui, sans-serif';
  ctx.fillText(wasted ? 'WASTED' : 'BUSTED', VIEW_W / 2, VIEW_H / 2 + 10);
  try { ctx.letterSpacing = '0px'; } catch { /* cosmetic only */ }
  ctx.fillStyle = 'rgba(240,244,248,0.9)';
  ctx.font = '400 19px system-ui, sans-serif';
  ctx.fillText(
    wasted
      ? 'You wake up at the hospital — broke, but breathing.'
      : 'Fined 10% and released outside police HQ.',
    VIEW_W / 2, VIEW_H / 2 + 52,
  );
  ctx.textAlign = 'left';
}

export function drawComplete(ctx, world) {
  draw(ctx, world);
  const cash = world.player ? fmtCash(world.player.cash) : '$0';
  drawBanner(
    ctx,
    'PORT SOLACE IS YOURS',
    `All five of Mara's jobs are done · Final cash ${cash} · Free roam — the city keeps turning`,
  );
}
