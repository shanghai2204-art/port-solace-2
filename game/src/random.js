// Port Solace — seeded RNG (mulberry32).
// The whole city is generated from one seed, so generation must never touch
// Math.random: use a createRng() instance and pass it around.

export function createRng(seed) {
  let a = seed >>> 0;

  // Next float in [0, 1).
  function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Float in [min, max).
  function range(min, max) {
    return min + next() * (max - min);
  }

  // Integer in [min, max], both ends inclusive.
  function int(min, max) {
    return min + Math.floor(next() * (max - min + 1));
  }

  // Random element of an array (undefined for an empty array).
  function pick(arr) {
    return arr[Math.floor(next() * arr.length)];
  }

  // True with probability p.
  function chance(p) {
    return next() < p;
  }

  // -1 or +1, coin flip.
  function sign() {
    return next() < 0.5 ? -1 : 1;
  }

  return { next, range, int, pick, chance, sign };
}
