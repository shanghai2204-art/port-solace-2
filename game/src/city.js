// Port Solace — procedural city generation + spatial queries.
//
// The city is a regular avenue grid. Between the road+sidewalk bands sit
// rectangular blocks; each block is filled from its district's building
// style (a lattice of lots, one building per lot, some lots skipped). One
// block in Garden Row is left empty as the park. Everything is derived
// from the seed through one RNG stream, consumed in a fixed order, so
// generateCity(seed) is fully deterministic.
//
// Data produced:
//   city.buildings   [{x, y, w, h, style, color, district}]  (AABBs)
//   city.blocks      [{x, y, w, h, district, park}]
//   city.park        {x, y, w, h, trees: [{x, y, r}]} or null
//   city.parkedCars  [car] in the shared car shape, driver null, parked
//   city.pedSpawns   [{x, y, district}] along sidewalk centrelines
//   city.carSpawns   [{x, y, angle}] on lanes at the city rim
//   city.landmarks   {cafe, hq, hospital, chopShop, impound} -> {x, y}
//   city.avenues     {xs: [...], ys: [...]} avenue centerlines

import {
  WORLD, AVENUE_SPACING, AVENUE_OFF_X, AVENUE_OFF_Y,
  ROAD_HALF, SIDEWALK_W, BLOCK_INSET, LANE_OFFSET, LANE_OFFSET_OUTER,
  DISTRICTS, BUILDING_STYLES, COLORS, PARKED_CLASS_WEIGHTS,
} from './config.js';
import { createRng } from './random.js';

// ------------------------------------------------------------- geometry ---
export function avenueCenterlines() {
  const xs = [];
  for (let x = AVENUE_OFF_X; x < WORLD.W; x += AVENUE_SPACING) xs.push(x);
  const ys = [];
  for (let y = AVENUE_OFF_Y; y < WORLD.H; y += AVENUE_SPACING) ys.push(y);
  return { xs, ys };
}

const AVENUES = avenueCenterlines();

// Which district's rectangle contains the point (first match wins; the
// rectangles tile the world, so there is always one).
export function districtAt(x, y) {
  for (const d of DISTRICTS) {
    if (x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) return d;
  }
  return DISTRICTS[DISTRICTS.length - 1];
}

function nearAvenue(v, lines) {
  for (const c of lines) {
    if (Math.abs(v - c) <= ROAD_HALF) return true;
  }
  return false;
}

function nearAvenueBand(v, lines, half) {
  for (const c of lines) {
    if (Math.abs(v - c) <= half) return true;
  }
  return false;
}

export function isRoad(x, y) {
  if (x < 0 || y < 0 || x >= WORLD.W || y >= WORLD.H) return false;
  return nearAvenue(x, AVENUES.xs) || nearAvenue(y, AVENUES.ys);
}

export function isSidewalk(x, y) {
  if (x < 0 || y < 0 || x >= WORLD.W || y >= WORLD.H) return false;
  if (isRoad(x, y)) return false;
  const band = ROAD_HALF + SIDEWALK_W;
  return nearAvenueBand(x, AVENUES.xs, band) || nearAvenueBand(y, AVENUES.ys, band);
}

// ----------------------------------------------------------- generation ---
// Split one axis into block segments: the gaps between successive
// road+sidewalk bands, including the rim margins at both ends.
function blockSegments(lines, extent) {
  const segs = [];
  let start = 0;
  for (const c of lines) {
    segs.push({ from: start, to: c - BLOCK_INSET });
    start = c + BLOCK_INSET;
  }
  segs.push({ from: start, to: extent });
  return segs.filter((s) => s.to - s.from >= 40);
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

function makeParkedCar(rng, x, y, angle) {
  return {
    x, y, angle,
    speed: 0, vx: 0, vy: 0,
    cls: weightedClass(rng),
    color: rng.pick(COLORS.cars),
    damage: 0,
    driver: null,
    parked: true,
  };
}

export function generateCity(seed) {
  const rng = createRng(seed);
  const { xs, ys } = AVENUES;

  // Blocks ---------------------------------------------------------------
  const xSegs = blockSegments(xs, WORLD.W);
  const ySegs = blockSegments(ys, WORLD.H);
  const blocks = [];
  for (const ys2 of ySegs) {
    for (const xs2 of xSegs) {
      const b = {
        x: xs2.from, y: ys2.from,
        w: xs2.to - xs2.from, h: ys2.to - ys2.from,
        district: null, park: false,
      };
      b.district = districtAt(b.x + b.w / 2, b.y + b.h / 2).id;
      blocks.push(b);
    }
  }

  // The park: the Garden Row block whose centre is closest to the
  // district centre.
  const garden = DISTRICTS.find((d) => d.id === 'gardenrow');
  const gcx = garden.x + garden.w / 2;
  const gcy = garden.y + garden.h / 2;
  let parkBlock = null;
  let parkDist = Infinity;
  for (const b of blocks) {
    if (b.district !== 'gardenrow') continue;
    const dx = b.x + b.w / 2 - gcx;
    const dy = b.y + b.h / 2 - gcy;
    const dd = dx * dx + dy * dy;
    if (dd < parkDist) {
      parkDist = dd;
      parkBlock = b;
    }
  }
  let park = null;
  if (parkBlock) {
    parkBlock.park = true;
    const trees = [];
    const treeCount = 14;
    for (let i = 0; i < treeCount; i++) {
      trees.push({
        x: parkBlock.x + rng.range(16, parkBlock.w - 16),
        y: parkBlock.y + rng.range(16, parkBlock.h - 16),
        r: rng.range(9, 15),
      });
    }
    park = { x: parkBlock.x, y: parkBlock.y, w: parkBlock.w, h: parkBlock.h, trees };
  }

  // Buildings --------------------------------------------------------------
  const buildings = [];
  for (const b of blocks) {
    if (b.park) continue;
    const styleName = DISTRICTS.find((d) => d.id === b.district).buildingStyle;
    const style = BUILDING_STYLES[styleName];
    const cellW = b.w / style.cols;
    const cellH = b.h / style.rows;
    for (let row = 0; row < style.rows; row++) {
      for (let col = 0; col < style.cols; col++) {
        if (rng.chance(style.skip)) continue;
        const jx = rng.range(0, Math.min(6, style.margin));
        const jy = rng.range(0, Math.min(6, style.margin));
        const bw = cellW - style.margin * 2 + jx;
        const bh = cellH - style.margin * 2 + jy;
        if (bw < 14 || bh < 14) continue;
        buildings.push({
          x: b.x + col * cellW + style.margin,
          y: b.y + row * cellH + style.margin,
          w: bw, h: bh,
          style: styleName,
          color: rng.pick(style.colors),
          district: b.district,
        });
      }
    }
  }

  // Parked cars ------------------------------------------------------------
  // Along both curbs of every avenue segment between crossings, set back
  // from the intersections so corners stay clear.
  const parkedCars = [];
  const curbOff = ROAD_HALF - 9;
  const clear = ROAD_HALF + 26;
  const placeRow = (fixed, from, to, horizontal, center) => {
    for (let t = from + clear; t < to - clear; t += 62) {
      const px = horizontal ? t + rng.range(-8, 8) : fixed;
      const py = horizontal ? fixed : t + rng.range(-8, 8);
      const d = districtAt(px, py);
      if (!rng.chance(d.parkedDensity * 0.55)) continue;
      // Parked cars face along the road; on the far curb they face back.
      const angle = horizontal
        ? (fixed > center ? Math.PI : 0)
        : (fixed > center ? Math.PI / 2 : -Math.PI / 2);
      parkedCars.push(makeParkedCar(rng, px, py, angle));
    }
  };
  for (const c of xs) {
    for (let i = 0; i <= ys.length; i++) {
      const from = i === 0 ? 0 : ys[i - 1];
      const to = i === ys.length ? WORLD.H : ys[i];
      placeRow(c - curbOff, from, to, false, c);
      placeRow(c + curbOff, from, to, false, c);
    }
  }
  for (const c of ys) {
    for (let i = 0; i <= xs.length; i++) {
      const from = i === 0 ? 0 : xs[i - 1];
      const to = i === xs.length ? WORLD.W : xs[i];
      placeRow(c - curbOff, from, to, true, c);
      placeRow(c + curbOff, from, to, true, c);
    }
  }

  // Pedestrian spawn points --------------------------------------------------
  // Rings around each block on the sidewalk centreline (the block edge is
  // the outside of the sidewalk, so the ring sits SIDEWALK_W/2 outside it).
  const pedSpawns = [];
  const ringOff = SIDEWALK_W / 2;
  const addPed = (x, y, district) => {
    // Rim blocks have no road beyond the world edge, so ring points that
    // fall outside the world are dropped.
    if (x < 2 || y < 2 || x >= WORLD.W - 2 || y >= WORLD.H - 2) return;
    pedSpawns.push({ x, y, district });
  };
  for (const b of blocks) {
    const rx = b.x - ringOff;
    const ry = b.y - ringOff;
    const rw = b.w + SIDEWALK_W;
    const rh = b.h + SIDEWALK_W;
    const step = 84;
    for (let t = 20; t < rw - 10; t += step) {
      addPed(rx + t, ry, b.district);
      addPed(rx + t, ry + rh, b.district);
    }
    for (let t = 20; t < rh - 10; t += step) {
      addPed(rx, ry + t, b.district);
      addPed(rx + rw, ry + t, b.district);
    }
  }

  // Traffic spawn points -----------------------------------------------------
  // Both lane offsets, both directions, at each end of every avenue.
  const carSpawns = [];
  for (const c of xs) {
    for (const off of [LANE_OFFSET, LANE_OFFSET_OUTER]) {
      carSpawns.push({ x: c + off, y: 30, angle: Math.PI / 2 });
      carSpawns.push({ x: c - off, y: WORLD.H - 30, angle: -Math.PI / 2 });
      carSpawns.push({ x: c + off, y: WORLD.H - 30, angle: -Math.PI / 2 });
      carSpawns.push({ x: c - off, y: 30, angle: Math.PI / 2 });
    }
  }
  for (const c of ys) {
    for (const off of [LANE_OFFSET, LANE_OFFSET_OUTER]) {
      carSpawns.push({ x: 30, y: c - off, angle: 0 });
      carSpawns.push({ x: WORLD.W - 30, y: c + off, angle: Math.PI });
      carSpawns.push({ x: WORLD.W - 30, y: c - off, angle: Math.PI });
      carSpawns.push({ x: 30, y: c + off, angle: 0 });
    }
  }

  // Landmarks ------------------------------------------------------------------
  // A sidewalk point on the top edge of the block nearest each district's
  // centre — good enough for mission markers and spawn logic to anchor to.
  const landmarkFor = (districtId) => {
    const d = DISTRICTS.find((dd) => dd.id === districtId);
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    let best = null;
    let bd = Infinity;
    for (const b of blocks) {
      if (b.district !== districtId || b.park) continue;
      const dx = b.x + b.w / 2 - cx;
      const dy = b.y + b.h / 2 - cy;
      const dd2 = dx * dx + dy * dy;
      if (dd2 < bd) {
        bd = dd2;
        best = b;
      }
    }
    if (!best) return { x: cx, y: cy };
    return { x: best.x + best.w / 2, y: best.y - SIDEWALK_W / 2 };
  };
  const landmarks = {
    cafe: landmarkFor('oldtown'),
    hq: landmarkFor('downtown'),
    hospital: landmarkFor('flats'),
    chopShop: landmarkFor('harbor'),
    impound: landmarkFor('airstrip'),
  };

  const city = {
    seed,
    w: WORLD.W,
    h: WORLD.H,
    avenues: { xs, ys },
    blocks,
    buildings,
    park,
    parkedCars,
    pedSpawns,
    carSpawns,
    landmarks,
  };

  // Bound convenience forms of the query helpers.
  city.districtAt = (x, y) => districtAt(x, y);
  city.isRoad = (x, y) => isRoad(x, y);
  city.isSidewalk = (x, y) => isSidewalk(x, y);
  city.collide = (x, y, r) => collide(city, x, y, r);
  city.spawnPoints = () => ({
    peds: pedSpawns,
    cars: carSpawns,
    player: landmarks.cafe,
    landmarks,
  });

  return city;
}

// -------------------------------------------------------------- queries ---
// Push a circle out of every building AABB it overlaps and clamp it to
// the world. Returns a fresh {x, y}; the inputs are not mutated.
export function collide(city, x, y, r) {
  let px = Math.max(r, Math.min(WORLD.W - r, x));
  let py = Math.max(r, Math.min(WORLD.H - r, y));
  for (const b of city.buildings) {
    if (px + r < b.x || px - r > b.x + b.w || py + r < b.y || py - r > b.y + b.h) {
      continue;
    }
    const cx = Math.max(b.x, Math.min(px, b.x + b.w));
    const cy = Math.max(b.y, Math.min(py, b.y + b.h));
    let dx = px - cx;
    let dy = py - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      if (d < r) {
        px = cx + (dx / d) * r;
        py = cy + (dy / d) * r;
      }
    } else {
      // Centre is inside the box: leave by the nearest face.
      const left = px - b.x;
      const right = b.x + b.w - px;
      const top = py - b.y;
      const bottom = b.y + b.h - py;
      const m = Math.min(left, right, top, bottom);
      if (m === left) px = b.x - r;
      else if (m === right) px = b.x + b.w + r;
      else if (m === top) py = b.y - r;
      else py = b.y + b.h + r;
    }
  }
  return { x: px, y: py };
}
