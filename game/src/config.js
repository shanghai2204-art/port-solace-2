// Port Solace — shared tuning constants.
// Every other module reads its numbers from here so the city, the cars and
// the player all agree on scale: 1 unit = 1 pixel, angles in radians,
// speeds in px/second, times in seconds.

// ---------------------------------------------------------------- world ---
export const WORLD = { W: 3200, H: 2400 };

// Avenues form a regular grid. Centerlines sit half a spacing in from the
// west/north edges so the city rim is one half-block wide on every side.
export const AVENUE_SPACING = 320;
export const AVENUE_OFF_X = 160;
export const AVENUE_OFF_Y = 240;

// Road cross-section, measured out from an avenue centerline.
export const ROAD_HALF = 38;          // asphalt spans ±38 (4 lanes of ~19)
export const SIDEWALK_W = 12;         // sidewalk band beyond the asphalt
export const BLOCK_INSET = ROAD_HALF + SIDEWALK_W; // buildings start here
export const LANE_OFFSET = 17;        // inner lane centre from centerline
export const LANE_OFFSET_OUTER = 31;  // outer lane centre from centerline

// -------------------------------------------------------------- palette ---
export const COLORS = {
  bg: '#07080a',
  asphalt: '#2e3138',
  asphaltCross: '#33373f',   // intersection pads read a touch lighter
  curb: '#565b63',
  sidewalk: '#7d838c',
  laneMark: '#d8b93a',
  laneMarkWhite: '#cfd3d8',
  parkGrass: '#39512f',
  parkPath: '#8a7a5c',
  tree: '#2c4423',
  treeLight: '#476b35',
  // Parked / traffic car paint, muted city tones with a few loud ones.
  cars: [
    '#c0c4cc', '#8a8f98', '#3f6fb5', '#a33327', '#2e7d4f', '#d9a441',
    '#5b3a8e', '#22252b', '#e3e6ea', '#7a4a21', '#4a7d8c', '#93502e',
  ],
};

// ------------------------------------------------------------ districts ---
// Six districts in a 3x2 arrangement. Bounds are half-open rectangles in
// world pixels. Densities are 0..1 multipliers used by the spawners;
// policePresence is the baseline share of enforcement attention.
export const DISTRICTS = [
  {
    id: 'oldtown', name: 'Old Town',
    x: 0, y: 0, w: 1067, h: 1200,
    ground: '#555049', buildingStyle: 'shop',
    pedDensity: 0.9, trafficDensity: 0.6, parkedDensity: 0.7, policePresence: 0.4,
  },
  {
    id: 'downtown', name: 'Downtown',
    x: 1067, y: 0, w: 1067, h: 1200,
    ground: '#43464d', buildingStyle: 'tower',
    pedDensity: 1.0, trafficDensity: 0.9, parkedDensity: 0.8, policePresence: 0.8,
  },
  {
    id: 'flats', name: 'The Flats',
    x: 2134, y: 0, w: 1066, h: 1200,
    ground: '#4e4a45', buildingStyle: 'apartment',
    pedDensity: 0.7, trafficDensity: 0.55, parkedDensity: 0.75, policePresence: 0.45,
  },
  {
    id: 'harbor', name: 'Harbor',
    x: 0, y: 1200, w: 1067, h: 1200,
    ground: '#4c4a44', buildingStyle: 'warehouse',
    pedDensity: 0.35, trafficDensity: 0.4, parkedDensity: 0.5, policePresence: 0.3,
  },
  {
    id: 'gardenrow', name: 'Garden Row',
    x: 1067, y: 1200, w: 1067, h: 1200,
    ground: '#3f5238', buildingStyle: 'house',
    pedDensity: 0.55, trafficDensity: 0.35, parkedDensity: 0.6, policePresence: 0.35,
  },
  {
    id: 'airstrip', name: 'Airstrip Flats',
    x: 2134, y: 1200, w: 1066, h: 1200,
    ground: '#5a5a55', buildingStyle: 'hangar',
    pedDensity: 0.2, trafficDensity: 0.3, parkedDensity: 0.35, policePresence: 0.5,
  },
];

// How each district's blocks are filled: a cols x rows lattice of lots per
// block, each lot mostly filled by one building with a margin gap.
// colors are roof tones the renderer can pick from.
export const BUILDING_STYLES = {
  warehouse: {
    cols: 2, rows: 1, margin: 14, skip: 0.15,
    colors: ['#6b5a49', '#756552', '#5d5648', '#71685a'],
  },
  shop: {
    cols: 3, rows: 2, margin: 10, skip: 0.1,
    colors: ['#8a6d4b', '#97543a', '#4b6a8a', '#6a8a4b', '#8a4b6d'],
  },
  tower: {
    cols: 2, rows: 2, margin: 16, skip: 0.05,
    colors: ['#4a5568', '#5a6a84', '#3d4756', '#6a7688'],
  },
  apartment: {
    cols: 2, rows: 2, margin: 12, skip: 0.1,
    colors: ['#7a5c48', '#8a6a52', '#66584a', '#75604e'],
  },
  house: {
    cols: 3, rows: 3, margin: 9, skip: 0.15,
    colors: ['#9a8a76', '#a89478', '#8a9a76', '#b09a80', '#769a8a'],
  },
  hangar: {
    cols: 2, rows: 1, margin: 18, skip: 0.1,
    colors: ['#7d838c', '#6e747c', '#8b9096'],
  },
};

// --------------------------------------------------------------- player ---
export const PLAYER = {
  radius: 10,
  walkSpeed: 150,
  sprintSpeed: 235,
  health: 100,
  startCash: 200,
};

// ----------------------------------------------------------------- cars ---
// accel px/s^2, topSpeed px/s, grip = steering responsiveness (higher
// bites harder), health = damage points before the car is wrecked.
// w/h are the collision/draw footprint in px (length along heading).
export const CAR_CLASSES = {
  compact: { accel: 240, topSpeed: 300, grip: 4.2, health: 70, w: 34, h: 16 },
  sedan:   { accel: 260, topSpeed: 340, grip: 4.0, health: 90, w: 38, h: 17 },
  sports:  { accel: 360, topSpeed: 460, grip: 5.2, health: 80, w: 38, h: 16 },
  truck:   { accel: 180, topSpeed: 260, grip: 3.2, health: 140, w: 48, h: 20 },
  cop:     { accel: 330, topSpeed: 430, grip: 4.8, health: 110, w: 38, h: 17 },
};

// Relative odds when a parked / ambient car is rolled.
export const PARKED_CLASS_WEIGHTS = {
  compact: 34, sedan: 34, sports: 10, truck: 22,
};
