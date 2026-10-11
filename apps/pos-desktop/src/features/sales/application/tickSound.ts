/**
 * tickSound — the terminal's audible feedback, synthesised rather than sampled.
 *
 * LAYER: application. It reaches for NO file, NO network, and NO native bridge —
 * which is the point, and also why it lives here rather than in the UI that
 * triggers it. A sound that only a component can play is a sound the next
 * component re-implements; a sound that is a PORT is one a component reports
 * intent through.
 *
 * ── WHY THERE IS NO AUDIO FILE ANYWHERE IN THIS REPO ────────────────────────
 *
 * Two independent reasons, and both would be enough on their own.
 *
 * 1. THE CSP. `tauri.conf.json` sets `csp: "default-src 'self'"`, enforced by
 *    the webview at runtime — not by a linter and not by a build step. A
 *    `<audio src="beep.mp3">` pointing anywhere other than the bundle's own
 *    output is blocked, and the failure mode is nasty and quiet: the build
 *    succeeds, the bundle is produced, and the till is silent.
 *
 * 2. THE OFFLINE-FIRST PROMISE. SKILL.md §2.2 requires the terminal to complete
 *    a sale with no network. A feedback sound that depends on a fetched asset is
 *    a sale-path feature that fails the moment the branch's connection does —
 *    and a POS in a café is offline more often than it is online.
 *
 * So the tone is GENERATED: an oscillator, a gain envelope, and a stop. Nothing
 * is loaded, which means nothing can fail to load. The bundle cost is zero.
 *
 * ── WHY IT IS NOT IN `domain/` ──────────────────────────────────────────────
 *
 * `layers.test.ts` scans every `domain/*.ts` for `@tauri-apps`, `fetch(`,
 * `escpos` and `serialport`, and asserts an explicit import allowlist. A sound is
 * none of those things — it is presentation feedback with no bearing on whether
 * a ฿45.50 basket is correct — so putting it in the domain would make the money
 * layer depend on whether the machine has an audio device.
 *
 * @see ./offlineOrders.ts — the sibling port, and the same reasoning
 */

// ─────────────────────────────────────────────────────────────────────────────
// The sounds
//
// ── WHY THESE FOUR AND NOT ONE ─────────────────────────────────────────────
//
// A single click sound on every control is the fastest way to make a POS
// unpleasant: the till is used for eight hours, and a sound on every keystroke
// in a search box becomes an irritation by lunchtime. Sound is therefore spent
// only where it carries INFORMATION the screen does not already show plainly —
//
//   add     a line landed in the basket. The cashier is looking at the TILE, so
//           this confirms the tap registered without their eyes leaving the menu.
//   remove  a line went away. Distinct from `add` so the two are tellable apart
//           in peripheral hearing, because undoing a removal is common.
//   success money committed. Two rising notes, not one: this is the only sound
//           in the app that means something irreversible happened, and it should
//           not be mistakable for a tap.
//   error   something was refused. Low and falling, which is the near-universal
//           convention for "no" and is distinguishable from `success` by ear
//           alone, without looking.
//
// What is deliberately NOT here: menu changes, typing, and navigation. Those are
// visible, frequent, and would be noise.
// ─────────────────────────────────────────────────────────────────────────────

export type TickSound = 'add' | 'remove' | 'success' | 'error';

interface ToneSpec {
  /** Hz. `null` = silence for this step's duration — used to leave a gap. */
  readonly hz: number | null;
  /** Seconds. */
  readonly seconds: number;
  /** Peak gain, 0–1. Kept low: this plays next to a conversation, all day. */
  readonly peak: number;
}

const TONES: Readonly<Record<TickSound, readonly ToneSpec[]>> = Object.freeze({
  // One short blip. High enough to cut through kitchen noise, short enough not
  // to linger over the next tap.
  add: Object.freeze([Object.freeze({ hz: 880, seconds: 0.05, peak: 0.06 })]),

  // The same pitch family as `add`, one step DOWN. A related-but-distinct tone
  // rather than an unrelated one: the two events are inverses, and the ear
  // notices the inversion faster than it notices two unrelated pitches.
  remove: Object.freeze([Object.freeze({ hz: 587, seconds: 0.05, peak: 0.05 })]),

  // A rising third. The interval is the message: something moved UP, and it
  // completed. Two notes rather than one so it cannot be confused with a tap
  // even at the same volume.
  success: Object.freeze([
    Object.freeze({ hz: 784, seconds: 0.08, peak: 0.07 }),
    Object.freeze({ hz: 1046, seconds: 0.12, peak: 0.07 }),
  ]),

  // Falling, and lower than everything else. Deliberately unpleasant: this is
  // the one that should make a cashier look up from what they were doing.
  error: Object.freeze([Object.freeze({ hz: 330, seconds: 0.18, peak: 0.08 })]),
});

// ─────────────────────────────────────────────────────────────────────────────
// The audio graph
//
// Held at module scope, not per call.
//
// Constructing an `AudioContext` is EXPENSIVE and, on some platforms, only
// permitted after a user gesture. Building one per tap would mean re-paying that
// cost on every press and would fail the first time a tap arrived faster than
// the platform's grace window. One lazily-created context, reused, is both
// faster and the only shape that reliably satisfies the gesture requirement.
// ─────────────────────────────────────────────────────────────────────────────

let context: AudioContext | null = null;

/**
 * The context, created on FIRST USE and reused thereafter.
 *
 * LAZY, not eager, and the reason is the autoplay policy: browsers refuse to
 * start an `AudioContext` before a user gesture, and creating one at module
 * load leaves it in a permanently `suspended` state that a later resume has to
 * fix. Creating it inside the first tap means the gesture has already happened.
 *
 * Never throws. A till with no audio device, a muted system, or a headless test
 * runner must still take money — so a failure to build the graph is remembered
 * as "no sound" and the sale proceeds silently. Sound is feedback, never a
 * precondition for a transaction.
 */
function audioContext(): AudioContext | null {
  if (context !== null) {
    return context;
  }

  try {
    const Ctor: typeof AudioContext | undefined =
      typeof AudioContext === 'undefined' ? undefined : AudioContext;

    if (Ctor === undefined) {
      return null;
    }

    context = new Ctor();
    return context;
  } catch {
    // No output device, or the platform refused. Silent, and not an error.
    return null;
  }
}

/**
 * Play one tone at `offsetMs` into the sequence.
 *
 * The gain envelope is what stops this being a CLICK: an oscillator switched on
 * and off instantly produces a waveform with a near-vertical edge, which is
 * broadband and reads as a hard tick or, at low volume, as a crack. Ramping the
 * gain from 0 and back to 0 over the tone's duration gives it an attack and a
 * release, which is what an actual percussive sound has and what the ear reads
 * as a pleasant "tok" rather than a glitch.
 */
function playTone(ctx: AudioContext, tone: ToneSpec, startAt: number): void {
  if (tone.hz === null) {
    return;
  }

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.value = tone.hz;

  // 5ms in, the rest out. Long enough to avoid the click, short enough that the
  // perceived length still matches `tone.seconds`.
  const attack = 0.005;
  const peakAt = startAt + attack;
  const endAt = startAt + tone.seconds;

  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(tone.peak, peakAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

  oscillator.connect(gain);
  gain.connect(ctx.destination);

  oscillator.start(startAt);
  oscillator.stop(endAt);
}

/**
 * Play a feedback sound.
 *
 * Total and silent by design: it returns normally whether the tone played, the
 * device is missing, or the context is suspended. A sound that can THROW would
 * put an `AudioContext` failure between a cashier and a completed sale, and the
 * sale is the part that matters.
 *
 * @param sound - Which of the four sounds to play.
 */
export function playTick(sound: TickSound): void {
  const ctx = audioContext();
  if (ctx === null) {
    return;
  }

  try {
    // Autoplay policy: a context created before any gesture starts `suspended`,
    // and scheduling on a suspended context silently plays nothing. Resuming is
    // what turns a silent context into an audible one, and it is only allowed
    // from inside a gesture — which is where every call to this function comes
    // from. If the resume is refused, the catch below swallows it.
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    // `currentTime + 0.01` rather than `currentTime`: a tone scheduled at exactly
    // "now" can begin before the graph has processed the scheduling, and gets
    // truncated. The 10ms lead is inaudible and removes the race.
    let cursor = ctx.currentTime + 0.01;
    for (const tone of TONES[sound]) {
      playTone(ctx, tone, cursor);
      cursor += tone.seconds;
    }
  } catch {
    // A rejected resume, a context closed underneath us, a device unplugged
    // mid-shift. None of it is worth interrupting a sale over.
  }
}

/**
 * The sound catalog, exposed for tests and for a future settings screen.
 *
 * Returned as a frozen copy rather than the live table: a caller that mutated
 * `TONES` would change what every terminal plays, and `Object.freeze` on the
 * inner objects alone does not stop a `push` onto the array.
 */
export function availableTickSounds(): readonly TickSound[] {
  return Object.freeze(['add', 'remove', 'success', 'error']);
}

/**
 * Reset the cached context. FOR TESTS ONLY.
 *
 * Exists so a test can assert the "no audio device" path — the one where
 * `audioContext()` returns `null` — without that assertion leaking into every
 * later test in the same process, where the real context would already exist.
 */
export function __resetTickSoundForTests(): void {
  context = null;
}