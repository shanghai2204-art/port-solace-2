// Port Solace — WebAudio synth. No audio assets: the engine hum, the
// two-tone siren, gunshots, crashes, horns and chimes are all built
// from oscillators and one noise buffer, created lazily on the first
// user gesture (unlockAudio(), wired up in main.js). M toggles mute.
//
// stepAudio(world) runs once per sim step: it tracks the player's car
// for the engine note, the nearest police unit for the siren, plays
// one-shots for fresh world.events (each event object sounds exactly
// once, tracked in a WeakSet), and stings once per busted/wasted
// outcome. Everything is defensive: with no AudioContext (headless,
// old browser, blocked autoplay) every function is a silent no-op,
// and a failure mid-step can never break the game.

import { CAR_CLASSES } from './config.js';

let ctx = null;
let master = null;
let engineNodes = null; // { o1, o2, gain, filter }
let sirenNodes = null;  // { osc, gain }
let noiseBuf = null;
let started = false;
let muted = false;
let playedOutcome = null;

const seenEvents = new WeakSet();

function audioCtor() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

export function unlockAudio() {
  if (started) {
    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch { /* ignore */ }
    }
    return;
  }
  const AC = audioCtor();
  if (!AC) return;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);

    // Engine: a saw + a sub-square through a lowpass, gain by load.
    const eGain = ctx.createGain();
    eGain.gain.value = 0;
    const eFilter = ctx.createBiquadFilter();
    eFilter.type = 'lowpass';
    eFilter.frequency.value = 420;
    eFilter.Q.value = 2;
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = 55;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = 28;
    const o2Gain = ctx.createGain();
    o2Gain.gain.value = 0.5;
    o1.connect(eFilter);
    o2.connect(o2Gain);
    o2Gain.connect(eFilter);
    eFilter.connect(eGain);
    eGain.connect(master);
    o1.start();
    o2.start();
    engineNodes = { o1, o2, gain: eGain, filter: eFilter };

    // Siren: a triangle whose pitch a square LFO swings ±125 Hz —
    // the classic two-tone warble. Gain follows the nearest unit.
    const sGain = ctx.createGain();
    sGain.gain.value = 0;
    const sOsc = ctx.createOscillator();
    sOsc.type = 'triangle';
    sOsc.frequency.value = 825;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 0.7;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 125;
    lfo.connect(lfoGain);
    lfoGain.connect(sOsc.frequency);
    sOsc.connect(sGain);
    sGain.connect(master);
    sOsc.start();
    lfo.start();
    sirenNodes = { osc: sOsc, gain: sGain };

    // One shared noise buffer (deterministic LCG fill — the game
    // code never touches Math.random).
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    let s = 22222;
    for (let i = 0; i < data.length; i++) {
      s = (Math.imul(s, 1103515245) + 12345) | 0;
      data[i] = ((s >>> 9) / 4194304) - 1;
    }

    started = true;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyM') toggleMute();
    });
  } catch {
    ctx = null;
    master = null;
    engineNodes = null;
    sirenNodes = null;
  }
}

export function toggleMute() {
  muted = !muted;
  if (ctx && master) {
    master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
  }
  return muted;
}

export function isMuted() {
  return muted;
}

// ------------------------------------------------------------ one-shots ---
function noiseHit(dur, filterType, freq, q, gain) {
  if (!ctx || !noiseBuf) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(t);
  src.stop(t + dur + 0.03);
}

function tone(freq, freqEnd, type, dur, gain, delay) {
  if (!ctx) return;
  const t = ctx.currentTime + (delay || 0);
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function soundForEvent(e) {
  switch (e.type) {
    case 'shot':
      noiseHit(0.09, 'bandpass', 1600, 0.9, 0.11);
      tone(210, 55, 'triangle', 0.06, 0.05, 0);
      break;
    case 'crash': {
      const sev = Math.max(1, Math.min(14, e.severity || 1));
      noiseHit(0.28, 'lowpass', 320, 0.6, Math.min(0.22, 0.05 + sev * 0.013));
      tone(110, 38, 'sine', 0.25, 0.12, 0);
      break;
    }
    case 'honk':
      tone(349, 0, 'square', 0.09, 0.022, 0);
      tone(349, 0, 'square', 0.08, 0.018, 0.16);
      break;
    case 'missionDone':
      tone(659, 0, 'sine', 0.12, 0.07, 0);
      tone(880, 0, 'sine', 0.2, 0.07, 0.11);
      break;
    case 'missionFailed':
      tone(392, 0, 'sine', 0.14, 0.06, 0);
      tone(311, 0, 'sine', 0.24, 0.06, 0.13);
      break;
    default:
      break;
  }
}

function sting(kind) {
  if (kind === 'busted') {
    tone(196, 0, 'sawtooth', 0.16, 0.05, 0);
    tone(147, 0, 'sawtooth', 0.16, 0.05, 0.15);
    tone(98, 0, 'sawtooth', 0.36, 0.055, 0.3);
    noiseHit(0.4, 'lowpass', 500, 0.5, 0.045);
  } else {
    // wasted: a low wash, like waking up under hospital lights
    tone(65, 40, 'sine', 0.7, 0.14, 0);
    noiseHit(0.6, 'lowpass', 240, 0.5, 0.07);
  }
}

// ----------------------------------------------------------------- step ---
export function stepAudio(world) {
  if (!started || !ctx || !world) return;
  try {
    const t = ctx.currentTime;
    const player = world.player;

    if (engineNodes) {
      let gain = 0;
      let freq = 55;
      let filt = 420;
      if (player && player.car) {
        const spec = CAR_CLASSES[player.car.cls] || CAR_CLASSES.sedan;
        const load = Math.min(1, Math.abs(player.car.speed) / spec.topSpeed);
        gain = 0.026 + load * 0.032;
        freq = 52 + load * 105;
        filt = 380 + load * 640;
      }
      engineNodes.gain.gain.setTargetAtTime(gain, t, 0.09);
      engineNodes.o1.frequency.setTargetAtTime(freq, t, 0.09);
      engineNodes.o2.frequency.setTargetAtTime(freq * 0.5 + 1, t, 0.09);
      engineNodes.filter.frequency.setTargetAtTime(filt, t, 0.12);
    }

    if (sirenNodes) {
      let gain = 0;
      if (player && (player.wanted || 0) > 0) {
        let nearest = Infinity;
        for (const car of world.cars || []) {
          if (car.driver !== 'police') continue;
          const d = Math.hypot(car.x - player.x, car.y - player.y);
          if (d < nearest) nearest = d;
        }
        if (nearest < Infinity) {
          gain = Math.max(0, 1 - nearest / 950) * 0.035;
        }
      }
      sirenNodes.gain.gain.setTargetAtTime(gain, t, 0.15);
    }

    for (const e of world.events || []) {
      if (seenEvents.has(e)) continue;
      seenEvents.add(e);
      soundForEvent(e);
    }

    const outcome = world.lastOutcome || null;
    if (outcome && outcome !== playedOutcome) {
      playedOutcome = outcome;
      sting(outcome);
    }
    if (!outcome) playedOutcome = null;
  } catch {
    // Audio must never break the game.
  }
}
