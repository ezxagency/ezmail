/* ============================================================
   POMODORO / FOCUS MODE
   The left rail's second personality. All state is local to this
   browser (localStorage) - it is a personal focus tool, not shift
   data, so it never touches Firestore.
   ============================================================ */
const POMO_LS = "ez-pomo-v1";
const POMO_ROUNDS = 4;
// label + the little swatch the dropdown shows; the veil styles live in CSS
const POMO_THEMES = {
  autumn:    { label: "Autumn Ember",    swatch: "linear-gradient(140deg,#5b2c0e,#b06a1c 58%,#2e1608)" },
  golden:    { label: "Golden Hour",     swatch: "linear-gradient(160deg,#3a1c40,#b05038 55%,#ffab40)" },
  sakura:    { label: "Sakura Dusk",     swatch: "linear-gradient(150deg,#2a1028,#8a3c70 55%,#f48fb1)" },
  forest:    { label: "Cozy Forest",     swatch: "linear-gradient(140deg,#0d2818,#1f5e38 58%,#0a1a10)" },
  ocean:     { label: "Ocean Depths",    swatch: "linear-gradient(165deg,#40becb,#0a3a50 55%,#031a2a)" },
  aurora:    { label: "Aurora Borealis", swatch: "linear-gradient(140deg,#04101c,#40eba6 45%,#5e8cff 75%,#040c16)" },
  space:     { label: "Deep Space",      swatch: "linear-gradient(140deg,#0b1030,#3d2a80 55%,#060814)" },
  rainnight: { label: "Midnight Rain",   swatch: "linear-gradient(160deg,#0a0e22,#28347c 60%,#0a0e1c)" },
  snow:      { label: "First Snow",      swatch: "linear-gradient(160deg,#141a24,#4a5c78 60%,#c8dcf0)" },
  nordic:    { label: "Nordic Fjord",    swatch: "linear-gradient(160deg,#0e161e,#2c4454 60%,#8cbed2)" },
  noir:      { label: "Velvet Noir",     swatch: "linear-gradient(150deg,#0a0710,#2c1c44 60%,#060409)" },
  dark:      { label: "Minimal Dark",    swatch: "linear-gradient(140deg,#101217,#262a33)" }
};
// every track is synthesized live in Web Audio - no files, no network
const POMO_TRACKS = {
  none:     { label: "None",             sub: "Silence, just the chime" },
  rain:     { label: "Autumn Rain",      sub: "Steady rainfall, soft droplets" },
  storm:    { label: "Rolling Thunder",  sub: "Heavy rain, distant rumbles" },
  fire:     { label: "Cozy Fireplace",   sub: "Crackling logs, deep warmth" },
  ocean:    { label: "Ocean Waves",      sub: "Slow swells, drifting foam" },
  forest:   { label: "Forest Morning",   sub: "Breeze, leaves, far-off birds" },
  wind:     { label: "Gentle Wind",      sub: "Two currents wandering" },
  crickets: { label: "Night Crickets",   sub: "A warm evening field" },
  lofi:     { label: "Lo-fi Beats",      sub: "72 bpm, dusty chords" },
  drone:    { label: "Deep Space Drone", sub: "Slow harmonic drift" },
  brown:    { label: "Brown Noise",      sub: "Pure low focus wash" }
};
const POMO_LIMITS = { focusMin: [1, 90], shortMin: [1, 30], longMin: [5, 45] };

/* The timer is PERSONAL: state is keyed by the signed-in uid, so two people
   sharing a browser each get their own running session, theme and sound.
   Loaded on sign-in (pomoLoadFor), saved + torn down on sign-out. */
const pomoDefaults = () => ({
  on: false, theme: "autumn",
  focusMin: 25, shortMin: 5, longMin: 20,
  autoBreak: true, autoFocus: false,
  track: "rain", vol: 0.6, muted: false, chime: true,
  phase: "focus", round: 1, running: false, endAt: null, remainMs: 25 * 60000
});
let PM = pomoDefaults();
let pomoUid = null;   // whose state PM currently is; null = nobody signed in

const pomoKey = () => POMO_LS + ":" + pomoUid;
const pomoSave = () => {
  if (!pomoUid) return;   // signed out: nothing to attribute the state to
  try { localStorage.setItem(pomoKey(), JSON.stringify(PM)); } catch (e) {}
};
const pomoTotalMs = (phase = PM.phase) =>
  (phase === "focus" ? PM.focusMin : phase === "short" ? PM.shortMin : PM.longMin) * 60000;
const pomoRemainMs = () => (PM.running && PM.endAt) ? Math.max(0, PM.endAt - Date.now()) : PM.remainMs;
const POMO_PHASE_LABEL = { focus: "Focus", short: "Short break", long: "Long break" };
const pomoMMSS = ms => { const s = Math.max(0, Math.round(ms / 1000)); return pad(Math.floor(s / 60)) + ":" + pad(s % 60); };

function pomoArcPath(p){
  if (p <= 0.002) return "";
  const theta = Math.min(p, 0.9999) * 360, rad = (theta * Math.PI) / 180;
  const x = (100 + 95.5 * Math.sin(rad)).toFixed(2);
  const y = (100 - 95.5 * Math.cos(rad)).toFixed(2);
  return `M100,4.5 A95.5,95.5 0 ${theta > 180 ? 1 : 0} 1 ${x},${y}`;
}

/* ---------- audio engine: everything is synthesized with Web Audio, so
   the app stays a static bundle with no media files to host or fetch.
   Ambient runs only while the timer runs; the chime is one-shot. ---------- */
let pomoAC = null, pomoMaster = null, pomoAmbient = null;
function pomoCtx(){
  pomoAC = pomoAC || new (window.AudioContext || window.webkitAudioContext)();
  if (pomoAC.state === "suspended") pomoAC.resume();
  if (!pomoMaster){
    // master -> gentle compressor -> out: the compressor glues the layered
    // voices and catches event peaks (thunder, pops) before they spike
    pomoMaster = pomoAC.createGain();
    const comp = pomoAC.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 24; comp.ratio.value = 3;
    comp.attack.value = 0.01; comp.release.value = 0.4;
    pomoMaster.connect(comp); comp.connect(pomoAC.destination);
  }
  pomoMaster.gain.value = PM.muted ? 0 : PM.vol;
  return pomoAC;
}
let pomoNoiseBuf = null, pomoBrownBuf = null;
function pomoNoise(ctx){
  if (!pomoNoiseBuf){
    pomoNoiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = pomoNoiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return pomoNoiseBuf;
}
// true brown noise (integrated white), far smoother down low than
// lowpassed white - the difference is very audible on the focus washes
function pomoBrown(ctx){
  if (!pomoBrownBuf){
    pomoBrownBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = pomoBrownBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++){
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return pomoBrownBuf;
}

function pomoAmbientStop(){
  if (!pomoAmbient) return;
  try { pomoAmbient.stop(); } catch (e) {}
  pomoAmbient = null;
}

/* Build one soundscape. Every voice is placed in stereo, modulated by slow
   LFOs so nothing loops audibly, and coloured events (thunder, crackles,
   birds, droplets) arrive on randomized clocks. `force` lets the settings
   sheet audition a track for a few seconds while the timer is paused. */
function pomoAmbientStart(force){
  pomoAmbientStop();
  if (PM.track === "none" || PM.muted || (!PM.running && !force)) return;
  const ctx = pomoCtx();
  const bus = ctx.createGain(); bus.connect(pomoMaster);
  const stops = [], timers = [];
  const R = (a, b) => a + Math.random() * (b - a);

  const pan = (node, p) => {
    if (!ctx.createStereoPanner){ node.connect(bus); return null; }
    const sp = ctx.createStereoPanner(); sp.pan.value = p;
    node.connect(sp); sp.connect(bus); return sp;
  };
  const noiseVoice = (vol, type, freq, q, at, buf) => {
    const src = ctx.createBufferSource(); src.buffer = buf || pomoNoise(ctx); src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); pan(g, at || 0);
    src.start();
    stops.push(() => { try { src.stop(); } catch (e) {} });
    return { src, f, g };
  };
  const lfo = (target, base, depth, hz) => {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.value = hz; og.gain.value = depth;
    target.value = base; o.connect(og); og.connect(target); o.start();
    stops.push(() => { try { o.stop(); } catch (e) {} });
  };
  const burst = (vol, freq, dur, at, type) => {
    const src = ctx.createBufferSource(); src.buffer = pomoNoise(ctx);
    const f = ctx.createBiquadFilter(); f.type = type || "highpass"; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(f); f.connect(g); pan(g, at || 0);
    src.start(); src.stop(ctx.currentTime + dur + 0.05);
  };
  // a pitched one-shot: sine glide with an envelope (droplets, birds, kicks)
  const blip = (f0, f1, dur, vol, at, type) => {
    const o = ctx.createOscillator(); o.type = type || "sine";
    const g = ctx.createGain();
    o.frequency.setValueAtTime(f0, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), ctx.currentTime + dur);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + Math.min(0.02, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); pan(g, at || 0);
    o.start(); o.stop(ctx.currentTime + dur + 0.05);
  };
  const every = (minMs, maxMs, fn) => {
    const go = () => { fn(); timers.push(setTimeout(go, R(minMs, maxMs))); };
    timers.push(setTimeout(go, R(minMs, maxMs)));
  };

  const t = PM.track;
  if (t === "rain"){
    const body = noiseVoice(0.38, "lowpass", 1150, 0, -0.12);
    lfo(body.g.gain, 0.38, 0.07, 0.13);
    noiseVoice(0.09, "highpass", 4800, 0, 0.22);
    every(2200, 7000, () => blip(R(900, 1400), R(320, 480), 0.14, 0.035, R(-0.5, 0.5)));
  } else if (t === "storm"){
    const body = noiseVoice(0.48, "lowpass", 900, 0, -0.1);
    lfo(body.g.gain, 0.48, 0.09, 0.1);
    noiseVoice(0.08, "highpass", 4200, 0, 0.25);
    every(12000, 32000, () => {
      // a thunder roll: slow-attack brown rumble that dies over seconds
      const src = ctx.createBufferSource(); src.buffer = pomoBrown(ctx);
      const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 140;
      const g = ctx.createGain();
      const now = ctx.currentTime, dur = R(2.4, 4);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(R(0.22, 0.34), now + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      src.connect(f); f.connect(g); pan(g, R(-0.6, 0.6));
      src.start(); src.stop(now + dur + 0.1);
    });
  } else if (t === "fire"){
    const rumble = noiseVoice(0.42, "lowpass", 240, 0, 0, pomoBrown(ctx));
    lfo(rumble.g.gain, 0.42, 0.09, 0.28);
    every(80, 420, () => burst(R(0.12, 0.3), R(1900, 5400), R(0.025, 0.08), R(-0.35, 0.35)));
    every(3000, 9000, () => blip(110, 60, 0.18, 0.1, R(-0.2, 0.2)));   // a log settling
  } else if (t === "ocean"){
    const swell = noiseVoice(0.05, "lowpass", 620, 0, -0.1);
    // two incommensurate LFOs make the set of waves never quite repeat
    lfo(swell.g.gain, 0.3, 0.22, 0.055);
    lfo(swell.f.frequency, 620, 160, 0.085);
    const foam = noiseVoice(0.05, "highpass", 2600, 0, 0.3);
    lfo(foam.g.gain, 0.09, 0.06, 0.055);
  } else if (t === "forest"){
    const w = noiseVoice(0.3, "bandpass", 360, 0.8, -0.15);
    lfo(w.f.frequency, 360, 130, 0.05);
    lfo(w.g.gain, 0.3, 0.1, 0.09);
    noiseVoice(0.05, "highpass", 4200, 0, 0.2);
    every(2500, 8000, () => {
      const n = 2 + Math.floor(Math.random() * 3), at = R(-0.6, 0.6), f0 = R(2600, 4200);
      for (let i = 0; i < n; i++)
        timers.push(setTimeout(() => blip(f0 * R(0.95, 1.1), f0 * R(0.6, 0.8), 0.11, 0.04, at), i * R(130, 200)));
    });
  } else if (t === "wind"){
    const a = noiseVoice(0.34, "bandpass", 330, 0.9, -0.3);
    lfo(a.f.frequency, 330, 150, 0.06);
    lfo(a.g.gain, 0.34, 0.12, 0.1);
    const b = noiseVoice(0.26, "bandpass", 520, 0.9, 0.3);
    lfo(b.f.frequency, 520, 200, 0.043);
    lfo(b.g.gain, 0.26, 0.1, 0.076);
    noiseVoice(0.05, "highpass", 3800, 0, 0);
  } else if (t === "crickets"){
    noiseVoice(0.06, "lowpass", 260, 0, 0, pomoBrown(ctx));
    // each cricket: a carrier with a fast tremolo, gated open in short bursts
    const cricket = (freq, rate, at, minMs, maxMs) => {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq;
      const trem = ctx.createGain(); lfo(trem.gain, 0.5, 0.5, rate);
      const gate = ctx.createGain(); gate.gain.value = 0.0001;
      o.connect(trem); trem.connect(gate); pan(gate, at);
      o.start();
      stops.push(() => { try { o.stop(); } catch (e) {} });
      every(minMs, maxMs, () => {
        const now = ctx.currentTime;
        gate.gain.setValueAtTime(0.0001, now);
        gate.gain.exponentialRampToValueAtTime(0.045, now + 0.03);
        gate.gain.setValueAtTime(0.045, now + 0.3);
        gate.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
      });
    };
    cricket(4300, 27, -0.4, 800, 1300);
    cricket(4650, 31, 0.45, 1000, 1700);
  } else if (t === "lofi"){
    // four dusty chords, a heartbeat kick, swung hats, vinyl dust
    const CH = [
      [174.6, 261.6, 349.2, 440.0],   // Fmaj7
      [220.0, 261.6, 329.6, 392.0],   // Am7
      [146.8, 220.0, 293.7, 349.2],   // Dm7
      [196.0, 233.1, 293.7, 392.0]    // Gm7
    ];
    const filt = ctx.createBiquadFilter(); filt.type = "lowpass"; filt.frequency.value = 780;
    lfo(filt.frequency, 780, 120, 0.05);
    const padBus = ctx.createGain(); padBus.gain.value = 1;
    filt.connect(padBus); pan(padBus, -0.08);
    const oscs = CH[0].map(fr => {
      const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = fr;
      o.detune.value = R(-8, 8);
      const g = ctx.createGain(); g.gain.value = 0.045;
      o.connect(g); g.connect(filt); o.start();
      stops.push(() => { try { o.stop(); } catch (e) {} });
      return o;
    });
    let bar = 0;
    timers.push(setInterval(() => {
      bar = (bar + 1) % CH.length;
      oscs.forEach((o, i) => o.frequency.setTargetAtTime(CH[bar][i], ctx.currentTime, 0.5));
    }, 6667)); // two bars at 72 bpm
    const BEAT = 60000 / 72;
    timers.push(setInterval(() => blip(120, 44, 0.2, 0.1, 0), BEAT));
    timers.push(setTimeout(() =>
      timers.push(setInterval(() => burst(0.028, 7000, 0.03, 0.25), BEAT)), BEAT / 2 + 40)); // swung hat
    every(300, 1500, () => burst(R(0.03, 0.06), 5200, 0.02, R(-0.3, 0.3)));
  } else if (t === "drone"){
    [[55, 0.06], [110.4, 0.05], [164.6, 0.035], [220.5, 0.025]].forEach(([fr, vol], i) => {
      const o = ctx.createOscillator(); o.type = i < 2 ? "sine" : "triangle";
      o.frequency.value = fr; o.detune.value = R(-4, 4);
      const f = ctx.createBiquadFilter(); f.type = "lowpass";
      lfo(f.frequency, 800, 420, 0.02);
      const g = ctx.createGain(); g.gain.value = vol;
      lfo(g.gain, vol, vol * 0.35, R(0.02, 0.05));
      o.connect(f); f.connect(g); pan(g, i % 2 ? 0.25 : -0.25);
      o.start();
      stops.push(() => { try { o.stop(); } catch (e) {} });
    });
    const shimmer = ctx.createOscillator(); shimmer.type = "sine"; shimmer.frequency.value = 1318.5;
    const sg = ctx.createGain(); lfo(sg.gain, 0.012, 0.01, 0.03);
    shimmer.connect(sg); pan(sg, 0.1); shimmer.start();
    stops.push(() => { try { shimmer.stop(); } catch (e) {} });
  } else if (t === "brown"){
    noiseVoice(0.5, "lowpass", 900, 0, 0, pomoBrown(ctx));
  }

  pomoAmbient = { stop(){
    stops.forEach(fn => fn());
    timers.forEach(tm => { clearTimeout(tm); clearInterval(tm); });
    try { bus.disconnect(); } catch (e) {}
  } };
}

// audition a track from the settings sheet without starting the timer:
// it plays for a few seconds, then bows out unless the timer is running
let pomoPreviewTimer = null;
function pomoPreview(){
  clearTimeout(pomoPreviewTimer);
  pomoAmbientStart(true);
  pomoPreviewTimer = setTimeout(() => { if (!PM.running) pomoAmbientStop(); }, 6000);
}

function pomoChime(){
  if (!PM.chime) return;
  try {
    const ctx = pomoCtx();
    [[880, 0], [1174.7, 0.18]].forEach(([fr, at]) => {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = fr;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 1.1);
      o.connect(g); g.connect(pomoMaster);
      o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 1.2);
    });
  } catch (e) { console.error(e); }
}
function pomoApplyVolume(){ if (pomoMaster) pomoMaster.gain.value = PM.muted ? 0 : PM.vol; }

/* ---------- engine ---------- */
function pomoSetMode(on){
  PM.on = on;
  $("appScreen").classList.toggle("pomo-on", on);
  $("modeClocks").classList.toggle("is-on", !on);
  $("modeFocus").classList.toggle("is-on", on);
  $("modeClocks").setAttribute("aria-selected", String(!on));
  $("modeFocus").setAttribute("aria-selected", String(on));
  pomoApplyTheme(on ? PM.theme : null);
  if (!on){ if (PM.running) pomoPause(); pomoAmbientStop(); }
  pomoRender();
  pomoSave();
}

// swap through transparent so a theme-to-theme change is also a fade
function pomoApplyTheme(theme){
  const app = $("appScreen");
  if (!theme){ delete app.dataset.ptheme; return; }
  if (app.dataset.ptheme === theme) return;
  if (!app.dataset.ptheme){ app.dataset.ptheme = theme; return; }
  const veil = app.querySelector(".theme-veil");
  veil.style.opacity = "0";
  setTimeout(() => { app.dataset.ptheme = theme; veil.style.opacity = ""; }, 200);
}

function pomoStart(){
  PM.running = true;
  PM.endAt = Date.now() + pomoRemainMs();
  pomoCtx();               // unlock audio inside the user gesture
  pomoAmbientStart();
  pomoRender(); pomoSave();
}
function pomoPause(){
  PM.remainMs = pomoRemainMs();
  PM.running = false; PM.endAt = null;
  pomoAmbientStop();
  pomoRender(); pomoSave();
}
function pomoResetPhase(){
  PM.remainMs = pomoTotalMs();
  if (PM.running) PM.endAt = Date.now() + PM.remainMs;
  pomoRender(); pomoSave();
}

/* One session ended (naturally or skipped). Standard rules: focus 1-3 earn a
   short break, focus 4 earns the long one; a finished break starts the next
   focus round; the long break wraps the set back to round 1. */
function pomoAdvance(natural){
  const wasRunning = PM.running;
  let auto = false;
  if (PM.phase === "focus"){
    PM.phase = PM.round >= POMO_ROUNDS ? "long" : "short";
    auto = PM.autoBreak;
  } else {
    PM.round = PM.phase === "long" ? 1 : Math.min(POMO_ROUNDS, PM.round + 1);
    PM.phase = "focus";
    auto = PM.autoFocus;
  }
  PM.remainMs = pomoTotalMs();
  PM.running = wasRunning && auto;
  PM.endAt = PM.running ? Date.now() + PM.remainMs : null;
  if (natural){
    pomoChime();
    toast(PM.phase === "focus"
      ? "Break over — round " + PM.round + " of " + POMO_ROUNDS
      : (PM.phase === "long" ? "Set complete — long break earned" : "Focus done — take " + PM.shortMin + " minutes"));
  }
  if (PM.running) pomoAmbientStart(); else pomoAmbientStop();
  pomoRender(); pomoSave();
}

function pomoTick(){
  if (!PM.on) return;
  if (PM.running && pomoRemainMs() <= 0){ pomoAdvance(true); return; }
  if (PM.running) pomoRenderTime();
}

function pomoRenderTime(){
  const remain = pomoRemainMs(), total = pomoTotalMs();
  $("pomoTime").textContent = pomoMMSS(remain);
  $("pomoArc").setAttribute("d", pomoArcPath(1 - remain / total));
}

function pomoRender(){
  const pomo = $("pomo");
  if (!pomo) return;
  pomo.classList.toggle("is-focus", PM.phase === "focus");
  pomo.classList.toggle("is-break", PM.phase !== "focus");
  $("pomoPhase").textContent = POMO_PHASE_LABEL[PM.phase];
  $("pomoRound").textContent = PM.phase === "long"
    ? "Long break · set complete"
    : "Round " + PM.round + " of " + POMO_ROUNDS;
  const done = PM.phase === "focus" ? PM.round - 1 : PM.round;
  $("pomoDots").innerHTML = Array.from({ length: POMO_ROUNDS }, (_, i) =>
    `<span class="pomo-dot${i < done ? " is-done" : (i === done && PM.phase === "focus" ? " is-now" : "")}"></span>`).join("");
  $("pomoPlay").textContent = PM.running ? "Pause"
    : (pomoRemainMs() < pomoTotalMs() ? "Resume" : "Start");
  $("pomoSoundOnIco").classList.toggle("hidden", PM.muted || PM.track === "none");
  $("pomoSoundOffIco").classList.toggle("hidden", !(PM.muted || PM.track === "none"));
  pomoRenderTime();
}

/* ---------- settings sheet ---------- */
function pomoClamp(key, v){
  const lim = POMO_LIMITS[key];
  return Math.max(lim[0], Math.min(lim[1], Math.round(v) || lim[0]));
}
/* One dropdown, af-* skinned: trigger shows the current pick (with a theme
   swatch when given), the panel lists every option and marks the active one.
   Only one panel opens at a time within the sheet. */
function pomoDropdownMarkup(id, items, currentKey){
  const cur = items[currentKey] || Object.values(items)[0];
  return `
    <div class="pdrop" id="${id}">
      <button type="button" class="af-trigger" aria-expanded="false" aria-haspopup="listbox">
        ${cur.swatch ? `<span class="pdrop-swatch" data-role="swatch" style="background:${cur.swatch}"></span>` : ""}
        <span class="af-value">${esc(cur.label)}</span>
        <svg class="af-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="af-panel" role="listbox" hidden>
        ${Object.entries(items).map(([k, it]) => `
          <button type="button" class="af-opt${k === currentKey ? " is-on" : ""}" data-v="${k}" role="option" aria-selected="${String(k === currentKey)}">
            <span class="af-check" aria-hidden="true">${k === currentKey ? AF_TICK : ""}</span>
            ${it.swatch ? `<span class="pdrop-swatch" style="background:${it.swatch}"></span>` : ""}
            <span class="af-opt-main">${esc(it.label)}${it.sub ? `<span class="af-opt-sub">${esc(it.sub)}</span>` : ""}</span>
          </button>`).join("")}
      </div>
    </div>`;
}
function pomoWireDropdown(id, items, onPick){
  const box = $(id), trig = box.querySelector(".af-trigger"), panel = box.querySelector(".af-panel");
  const close = () => { panel.hidden = true; trig.setAttribute("aria-expanded", "false"); };
  trig.onclick = () => {
    const opening = panel.hidden;
    // close any sibling dropdown first - one open panel at a time
    document.querySelectorAll(".pdrop .af-panel").forEach(p => { p.hidden = true; });
    document.querySelectorAll(".pdrop .af-trigger").forEach(x => x.setAttribute("aria-expanded", "false"));
    if (opening){ panel.hidden = false; trig.setAttribute("aria-expanded", "true"); }
  };
  panel.querySelectorAll("[data-v]").forEach(b => b.onclick = () => {
    const k = b.dataset.v, it = items[k];
    panel.querySelectorAll("[data-v]").forEach(x => {
      const on = x === b;
      x.classList.toggle("is-on", on);
      x.setAttribute("aria-selected", String(on));
      x.querySelector(".af-check").innerHTML = on ? AF_TICK : "";
    });
    trig.querySelector(".af-value").textContent = it.label;
    const sw = trig.querySelector("[data-role=swatch]");
    if (sw && it.swatch) sw.style.background = it.swatch;
    close();
    onPick(k);
  });
}

function openPomoSettings(){
  const sw = (id, label, sub, on) => `
    <div class="prow">
      <span class="prow-label">${label}<span class="prow-sub">${sub}</span></span>
      <button type="button" class="pswitch" id="${id}" role="switch" aria-pressed="${String(on)}" aria-label="${label}"></button>
    </div>`;
  openSheet(`
    <h2>Focus settings</h2>
    <p class="hint">Tune the timer, the scenery and the sound. Everything here sticks on this device.</p>

    <label class="fld"><span>Theme</span></label>
    ${pomoDropdownMarkup("pThemeDrop", POMO_THEMES, PM.theme)}

    <label class="fld"><span>Ambient sound</span></label>
    ${pomoDropdownMarkup("pTrackDrop", POMO_TRACKS, PM.track)}
    <div class="pvol">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>
      <input type="range" id="pVol" min="0" max="100" value="${Math.round(PM.vol * 100)}" aria-label="Volume">
    </div>
    ${sw("pChime", "Completion chime", "A soft bell when a session ends", PM.chime)}

    <label class="fld" style="margin-top:10px"><span>Session lengths (minutes)</span></label>
    <div class="pnum-grid">
      <label class="fld"><span>Focus</span><input type="number" id="pFocus" min="1" max="90" value="${PM.focusMin}"></label>
      <label class="fld"><span>Short</span><input type="number" id="pShort" min="1" max="30" value="${PM.shortMin}"></label>
      <label class="fld"><span>Long</span><input type="number" id="pLong" min="5" max="45" value="${PM.longMin}"></label>
    </div>
    ${sw("pAutoBreak", "Auto-start breaks", "Roll into the break when focus ends", PM.autoBreak)}
    ${sw("pAutoFocus", "Auto-start focus", "Roll into focus when a break ends", PM.autoFocus)}

    <button class="btn btn-go" id="pDone">Done</button>
  `, () => {
    pomoWireDropdown("pThemeDrop", POMO_THEMES, k => {
      PM.theme = k;
      if (PM.on) pomoApplyTheme(k);
      pomoSave();
    });
    pomoWireDropdown("pTrackDrop", POMO_TRACKS, k => {
      PM.track = k;
      if (PM.running) pomoAmbientStart();
      else if (k !== "none" && !PM.muted) pomoPreview();  // audition it briefly
      else pomoAmbientStop();
      pomoRender(); pomoSave();
    });
    // a changed length applies to the current session immediately unless it
    // is mid-run - a running session keeps the deal it started with
    const num = (id, key) => {
      $(id).onchange = () => {
        PM[key] = pomoClamp(key, Number($(id).value));
        $(id).value = PM[key];
        if (!PM.running) PM.remainMs = pomoTotalMs();
        pomoRender(); pomoSave();
      };
    };
    num("pFocus", "focusMin"); num("pShort", "shortMin"); num("pLong", "longMin");
    const wireSwitch = (id, key, after) => {
      $(id).onclick = () => {
        PM[key] = !PM[key];
        $(id).setAttribute("aria-pressed", String(PM[key]));
        if (after) after();
        pomoSave();
      };
    };
    wireSwitch("pAutoBreak", "autoBreak");
    wireSwitch("pAutoFocus", "autoFocus");
    wireSwitch("pChime", "chime", () => { if (PM.chime) pomoChime(); });
    $("pVol").oninput = () => { PM.vol = Number($("pVol").value) / 100; pomoApplyVolume(); pomoSave(); };
    $("pDone").onclick = () => { if (!PM.running) pomoAmbientStop(); closeSheet(); };
  });
}

/* Bring one account's saved state in and make it live. Called on sign-in. */
function pomoLoadFor(uid){
  pomoUid = uid;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(pomoKey()) || "null");
    if (!saved){
      // one-time migration: state saved before it was per-account belongs
      // to whoever signs in first; after that the shared key is gone
      const legacy = JSON.parse(localStorage.getItem(POMO_LS) || "null");
      if (legacy){ saved = legacy; localStorage.removeItem(POMO_LS); }
    }
  } catch (e) { saved = null; }
  PM = Object.assign(pomoDefaults(), saved || {});
  // saved prefs may predate the current theme/track catalogs
  if (!POMO_THEMES[PM.theme]) PM.theme = "autumn";
  if (!POMO_TRACKS[PM.track]) PM.track = "rain";
  // a session that was running when they left: settle it honestly
  if (PM.running && PM.endAt && PM.endAt <= Date.now()){
    PM.running = false; PM.remainMs = 0;
    pomoAdvance(false);
    PM.running = false; PM.endAt = null;
    pomoSave();
  } else if (!PM.running){
    PM.endAt = null;
    PM.remainMs = Math.min(PM.remainMs, pomoTotalMs()) || pomoTotalMs();
  }
  pomoSetMode(PM.on);
}

/* Park the current account's state and clear the deck. Called on sign-out.
   Order matters: save with the real uid first, THEN reset to defaults so the
   login screen (and the next person) starts from a neutral timer. */
function pomoUnload(){
  if (pomoUid) pomoSave();
  clearTimeout(pomoPreviewTimer);
  pomoAmbientStop();
  pomoUid = null;
  PM = pomoDefaults();
  pomoSetMode(false);
}

/* ---------- boot ---------- */
(function pomoInit(){
  const pomo = $("pomo");
  if (!pomo) return;
  pomo.removeAttribute("hidden");   // CSS classes own visibility from here on
  $("modeClocks").onclick = () => pomoSetMode(false);
  $("modeFocus").onclick = () => pomoSetMode(true);
  $("pomoPlay").onclick = () => PM.running ? pomoPause() : pomoStart();
  $("pomoReset").onclick = pomoResetPhase;
  $("pomoSkip").onclick = () => pomoAdvance(false);
  $("pomoGear").onclick = openPomoSettings;
  $("pomoSound").onclick = () => {
    PM.muted = !PM.muted;
    pomoApplyVolume();
    if (!PM.muted && PM.running) pomoAmbientStart();
    if (PM.muted) pomoAmbientStop();
    pomoRender(); pomoSave();
  };
  pomoSetMode(false);   // neutral until someone signs in and loads their own
})();
