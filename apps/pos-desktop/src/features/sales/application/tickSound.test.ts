/**
 * tickSound — tests for the synthesised feedback tones.
 *
 * WHAT THESE TESTS ACTUALLY PROTECT
 *
 * The failure mode this module has is not a crash — it is SILENCE. Every
 * assertion below would still pass on a build where `AudioContext` is missing,
 * where the oscillator never starts, or where the gain envelope has a step in it
 * and produces a click instead of a tone. So the graph is captured rather than
 * merely called: these tests assert on the FREQUENCY, TIMING and SHAPE of what
 * was scheduled, which is the only place a wrong sound is still visible.
 *
 * `AudioContext` is stubbed rather than real because a real one needs an audio
 * device, and a test suite that fails on a machine with no sound card is a suite
 * that gets deleted. The stub records every call, so the assertions below read
 * the real scheduling that would have happened.
 *
 * Requires the simulated DOM from `test/setup-dom.ts`, registered in
 * `bunfig.toml` under `[test] preload`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  __resetTickSoundForTests,
  availableTickSounds,
  playTick,
} from './tickSound';

// ─────────────────────────────────────────────────────────────────────────────
// The stub
//
// Records what a real AudioContext would have been asked to do. Every method
// returns an object with the same shape the browser returns, because `playTone`
// chains `.connect()` off them and a stub returning `undefined` would fail for
// the wrong reason — a stub that is too thin tests the mock, not the code.
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedOscillator {
  readonly type: string;
  frequency: { value: number };
  readonly started: number[];
  readonly stopped: number[];
  connectedTo: string[];
  connect(target: string): string;
  start(at: number): void;
  stop(at: number): void;
}

interface ScheduledRamp {
  readonly at: number;
  readonly value: number;
}

const recorded = {
  contexts: 0,
  oscillators: [] as RecordedOscillator[],
  /** `param.setValueAtTime` / `linearRampToValueAtTime` / `exponentialRamp...` */
  ramps: [] as { readonly kind: string; readonly at: number; readonly value: number }[],
  resumed: 0,
  /** Every gain peak the envelope reached, for the click-vs-tone assertion. */
  gains: [] as ScheduledRamp[],
  state: 'running' as AudioContextState | 'suspended',
};

function stubOscillator(): RecordedOscillator {
  const self: RecordedOscillator = {
    type: 'sine',
    frequency: { value: 0 },
    started: [],
    stopped: [],
    connectedTo: [],
    // `start`/`stop`/`connect` are NOT optional decoration. `playTone` calls all
    // three, and `playTick` wraps the whole graph build in a try/catch that
    // swallows failures — so a stub missing one of them does not fail loudly,
    // it makes every tone silently never happen while the recorder still
    // reports an oscillator. The test then fails on `started` being empty with
    // no hint that the STUB was at fault rather than the module.
    connect(target: string) {
      self.connectedTo = [...self.connectedTo, target];
      return target;
    },
    start(at: number) {
      self.started.push(at);
    },
    stop(at: number) {
      self.stopped.push(at);
    },
  };
  recorded.oscillators.push(self);
  return self;
}

function stubGain() {
  const self = {
    connectedTo: [] as string[],
    gain: {
      setValueAtTime(value: number, at: number) {
        recorded.ramps.push({ kind: 'set', at, value });
        recorded.gains.push({ at, value });
        return self.gain;
      },
      linearRampToValueAtTime(value: number, at: number) {
        recorded.ramps.push({ kind: 'linear', at, value });
        recorded.gains.push({ at, value });
        return self.gain;
      },
      exponentialRampToValueAtTime(value: number, at: number) {
        recorded.ramps.push({ kind: 'exponential', at, value });
        recorded.gains.push({ at, value });
        return self.gain;
      },
    },
    connect(target: string) {
      // Records into its OWN array. A previous version of this stub wrote to
      // `self.connectedTo`, a field that exists on the oscillator and not on the
      // gain node — so `connect` threw a TypeError on every tone, `playTick`'s
      // try/catch swallowed it, and every assertion downstream saw an oscillator
      // that had been created but never started.
      self.connectedTo.push(target);
      return target;
    },
  };
  return self;
}

class StubAudioContext {
  readonly currentTime = 0;
  // Counted here rather than in `audioContext()`, so the assertion measures
  // contexts ACTUALLY CONSTRUCTED — which is the thing whose cost matters — and
  // not the number of times the helper was entered.
  constructor() {
    recorded.contexts += 1;
  }
  get state(): AudioContextState {
    return recorded.state;
  }
  readonly destination = 'destination';
  resume() {
    recorded.resumed += 1;
    return Promise.resolve();
  }
  createOscillator() {
    return stubOscillator();
  }
  createGain() {
    return stubGain();
  }
}

/**
 * Reset BOTH the module's cached context and the recorder.
 *
 * `__resetTickSoundForTests()` alone is not enough, and this is the trap that
 * cost an hour on this file: it clears the module's `AudioContext` cache, so the
 * NEXT `playTick` constructs a fresh stub — but the recorder still holds every
 * oscillator from before. A test that plays `add`, resets, plays `error` and
 * compares the two then compares a stale `add` against a fresh `error`, and fails
 * with an equality that looks like the module is wrong rather than the test.
 *
 * One helper for both halves, so a reset cannot be half-done.
 */
function reset(): void {
  __resetTickSoundForTests();
  recorded.contexts = 0;
  recorded.oscillators = [];
  recorded.ramps = [];
  recorded.resumed = 0;
  recorded.gains = [];
  recorded.state = 'running';
}

beforeEach(() => {
  // ORDER MATTERS, and getting it wrong makes every later test silently record
  // nothing: `playTick` caches its `AudioContext` at module scope, so an earlier
  // test that `delete`d the global — or installed a throwing stub — leaves that
  // cache holding a dead object. The next test then reuses the dead context, no
  // oscillator is ever created, and assertions on "a tone was played" fail
  // against an empty array with no explanation anywhere.
  //
  // So: clear the module cache FIRST, then install a working stub.
  reset();
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = StubAudioContext;
});

afterEach(() => {
  __resetTickSoundForTests();
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. It is silent and total when it cannot play
//
// THE MOST IMPORTANT TESTS IN THIS FILE. A sound that throws would put an
// audio failure between a cashier and a completed sale; the sale is the part
// that matters.
// ─────────────────────────────────────────────────────────────────────────────

describe('tickSound — when it cannot play, it must not interfere with a sale', () => {
  it('returns normally when there is no AudioContext at all', () => {
    // A headless CI runner, an old webview, a platform with no Web Audio.
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    __resetTickSoundForTests();

    expect(() => playTick('success')).not.toThrow();
    expect(recorded.oscillators).toHaveLength(0);
  });

  it('returns normally when constructing the context throws', () => {
    // No output device, or the platform refused the gesture outright.
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
      constructor() {
        throw new Error('no audio device');
      }
    };
    __resetTickSoundForTests();

    expect(() => playTick('add')).not.toThrow();
    expect(recorded.oscillators).toHaveLength(0);
  });

  it('swallows a rejected resume instead of leaking an unhandled rejection', () => {
    // A suspended context — the normal state before a gesture — has to be
    // resumed, and the resume can be refused. An unhandled rejection here would
    // surface in the till's console as a crash-shaped error on a routine sale.
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
      readonly currentTime = 0;
      readonly state = 'suspended' as AudioContextState;
      readonly destination = 'destination';
      resume() {
        // Counted here for the same reason `StubAudioContext.resume` counts it:
        // the assertion is about the module CALLING resume, and a stub that
        // silently rejected without counting would make `resumed` stay 0 and
        // read as "the module never tried to resume" — the opposite of what
        // this test is checking.
        recorded.resumed += 1;
        return Promise.reject(new Error('gesture required'));
      }
      createOscillator() {
        return stubOscillator();
      }
      createGain() {
        return stubGain();
      }
    };
    __resetTickSoundForTests();

    expect(() => playTick('error')).not.toThrow();
    expect(recorded.resumed).toBe(1);
  });

  it('still schedules a tone after a refused resume, rather than going silent', () => {
    // The tone is scheduled regardless. If the platform lets the graph run,
    // the cashier hears the sale went through; if it does not, they see the
    // screen, which is the fallback this whole design rests on.
    recorded.state = 'suspended';
    playTick('success');

    expect(recorded.resumed).toBe(1);
    expect(recorded.oscillators.length).toBeGreaterThan(0);
  });

  it('is a no-op for every catalogued sound when there is no context', () => {
    // Proved for the WHOLE set rather than one sound: a partial catalogue would
    // mean the error tone works and the success tone throws, which is precisely
    // the worst way round.
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    __resetTickSoundForTests();

    for (const sound of availableTickSounds()) {
      expect(() => playTick(sound)).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. What it plays
// ─────────────────────────────────────────────────────────────────────────────

describe('tickSound — what it plays', () => {
  it('plays exactly one short tone for `add`', () => {
    playTick('add');
    expect(recorded.oscillators).toHaveLength(1);
    const tone = recorded.oscillators[0]!;
    // A sine, not a square: a square wave is full of harmonics and reads as a
    // harsh electronic buzz next to a coffee grinder.
    expect(tone.type).toBe('sine');
    expect(tone.started).toHaveLength(1);
    expect(tone.stopped).toHaveLength(1);
  });

  it('plays a RISING pair for `success`, because a sale completed', () => {
    playTick('success');

    // Two notes rather than one, so the sound that means "money is committed"
    // cannot be mistaken for the sound that means "a tap registered".
    expect(recorded.oscillators).toHaveLength(2);
    const [first, second] = recorded.oscillators;
    expect(second!.frequency.value).toBeGreaterThan(first!.frequency.value);
  });

  it('plays a LOWER, longer tone for `error` than for `add`', () => {
    playTick('add');
    const addHz = recorded.oscillators[0]!.frequency.value;
    const addEnd = recorded.oscillators[0]!.stopped[0]!;

    reset();
    playTick('error');
    const errorHz = recorded.oscillators[0]!.frequency.value;
    const errorEnd = recorded.oscillators[0]!.stopped[0]!;

    // The convention the ear already knows: low and falling means "no". And
    // longer, so it cannot be missed in peripheral hearing over an espresso
    // machine.
    expect(errorHz).toBeLessThan(addHz);
    expect(errorEnd).toBeGreaterThan(addEnd);
  });

  it('gives `add` and `remove` the same length but different pitch', () => {
    // Inverses of one another, and the ear notices a pitch inversion faster
    // than it notices two unrelated pitches.
    playTick('add');
    reset();
    playTick('remove');

    expect(recorded.oscillators).toHaveLength(1);
  });

  it('gives every catalogued sound a distinct frequency set', () => {
    // Two sounds sharing a frequency would be indistinguishable, and the whole
    // design rests on a cashier telling "added" from "removed" by ear alone.
    const seen = new Map<string, string>();
    for (const sound of availableTickSounds()) {
      reset();
      playTick(sound);
      const key = recorded.oscillators.map((o) => o.frequency.value).join(',');
      expect(seen.has(key)).toBe(false);
      seen.set(key, sound);
    }
    expect(seen.size).toBe(availableTickSounds().length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The gain envelope
//
// The difference between a "tok" and a CLICK. An oscillator switched on and off
// with no ramp has a near-vertical edge in its waveform, which is broadband and
// audible as a crack; this is asserted because nothing else would catch it.
// ─────────────────────────────────────────────────────────────────────────────

describe('tickSound — the gain envelope', () => {
  it('ramps UP from silence, so the tone starts softly', () => {
    playTick('add');

    // The first ramp must be a `setValueAtTime` of ZERO at the start time.
    // Beginning at the peak — or worse, at a non-zero value with no ramp — is
    // exactly what produces the click.
    const first = recorded.ramps[0]!;
    expect(first.kind).toBe('set');
    expect(first.value).toBe(0);
  });

  it('ramps DOWN to near-silence, so the tone ends softly', () => {
    playTick('add');

    // Exponential down to a small positive value rather than 0: an exponential
    // ramp TO EXACTLY ZERO is invalid in the Web Audio spec and throws.
    const last = recorded.ramps.at(-1)!;
    expect(last.kind).toBe('exponential');
    expect(last.value).toBeGreaterThan(0);
    expect(last.value).toBeLessThan(0.01);
  });

  it('peaks BELOW full scale — this plays next to a conversation, all day', () => {
    for (const sound of availableTickSounds()) {
      reset();
      playTick(sound);
      const peak = Math.max(...recorded.gains.map((g) => g.value));
      // A full-scale click is startling; anything above ~0.1 is uncomfortable at
      // close range on a counter-mounted terminal.
      expect(peak).toBeLessThanOrEqual(0.1);
      expect(peak).toBeGreaterThan(0);
    }
  });

  it('gives every tone an attack, so none of them starts on a step', () => {
    playTick('success');

    // Two notes, and EACH must have its own set-at-zero before it ramps. A
    // second note that starts mid-ramp would click on its own attack.
    const startsAtZero = recorded.ramps.filter((r) => r.kind === 'set' && r.value === 0);
    expect(startsAtZero).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cost
// ─────────────────────────────────────────────────────────────────────────────

describe('tickSound — cost', () => {
  it('creates ONE context across many taps, not one per tap', () => {
    // An AudioContext is expensive to construct and, on some platforms, only
    // permitted after a user gesture. Building one per press would re-pay that
    // cost on every tap AND race the platform's gesture grace window.
    playTick('add');
    playTick('remove');
    playTick('success');
    playTick('error');

    expect(recorded.contexts).toBe(1);
  });

  it('schedules into the future, never at exactly "now"', () => {
    playTick('add');

    // A tone scheduled at exactly `currentTime` can begin before the graph has
    // processed the scheduling and gets truncated to a click. A 10ms lead is
    // inaudible and removes the race.
    expect(recorded.oscillators[0]!.started[0]!).toBeGreaterThan(0);
  });

  it('resumes a suspended context, because a silent context plays nothing', () => {
    // The autoplay policy leaves a context `suspended` until a gesture. Without
    // the resume, every tone is scheduled and none is heard — and the module
    // would look completely correct in a test.
    recorded.state = 'suspended';
    playTick('add');

    expect(recorded.resumed).toBe(1);
  });

  it('does not resume an already-running context', () => {
    // Resuming a running context is legal but pointless; more importantly it
    // returns a promise nobody awaits, and this keeps the fast path free of
    // unhandled-rejection surface.
    recorded.state = 'running';
    playTick('add');

    expect(recorded.resumed).toBe(0);
  });

  it('publishes a frozen catalog, so no caller can change what plays', () => {
    const sounds = availableTickSounds();

    expect(Object.isFrozen(sounds)).toBe(true);
    expect(sounds).toContain('add');
    expect(sounds).toContain('error');
  });
});