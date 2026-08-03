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
/* Real music now: the team's own lofi library, transcoded to small AAC
   (~80kbps) files in assets/pomo/ so the repo stays light. They are plain
   static files on the CDN - Firestore never stores or serves a byte of
   audio. Only the chime is still synthesized. */
const POMO_TRACK_DIR = "assets/pomo/";
const POMO_TRACKS = {
  none:          { label: "None",              sub: "Silence, just the chime" },
  coffeeshop:    { label: "Coffee Shop",       sub: "Alex Morgan · warm lofi",          file: "coffee-shop.m4a" },
  chillvlog:     { label: "Chill Vlog",        sub: "Alex Morgan · easy beats",         file: "chill-vlog.m4a" },
  midnightclub:  { label: "Midnight Club",     sub: "Alex Morgan · late-night lofi",    file: "midnight-club.m4a" },
  lofihiphop:    { label: "Lofi Hiphop",       sub: "Apalon Beats · head-nod loop",     file: "lofi-hiphop.m4a" },
  chill:         { label: "Chill",             sub: "Atlas Audio · soft and slow",      file: "chill.m4a" },
  beachsunset:   { label: "Beach Sunset",      sub: "Clavier · empty beach lofi",       file: "beach-sunset.m4a" },
  calmstudy:     { label: "Calm Study",        sub: "FASSounds · peaceful chill hop",   file: "calm-study.m4a" },
  sakura:        { label: "Sakura",            sub: "Florews · gentle bloom",           file: "sakura.m4a" },
  softmetal:     { label: "Soft Metal",        sub: "Gabriele Romano · mellow riffs",   file: "soft-metal.m4a" },
  mystery:       { label: "Mystery Unfold",    sub: "Geoff Harvey · slow wonder",       file: "mystery-unfold.m4a" },
  thunder:       { label: "Thunder",           sub: "John Britton · storm mood",        file: "thunder.m4a" },
  lostinthought: { label: "Lost in Thought",   sub: "Melodigne · drifting keys",        file: "lost-in-thought.m4a" },
  easter:        { label: "Easter",            sub: "PrettyJohn · bright calm",         file: "easter.m4a" },
  mysticforest:  { label: "Mysterious Forest", sub: "SoulProd · moody lofi",            file: "mysterious-forest.m4a" },
  gildedsilence: { label: "Gilded Silence",    sub: "Turning Pages · zen lofi",         file: "gilded-silence.m4a" }
};
// one track loops forever, or the whole library plays in random order -
// applied live if a track is already running when the pick changes
const POMO_PLAYMODES = {
  repeat:  { label: "Repeat",  sub: "Loop this track" },
  shuffle: { label: "Shuffle", sub: "Cycle the whole library" }
};
const POMO_LIMITS = { focusMin: [1, 90], shortMin: [1, 30], longMin: [5, 45] };
// the main control's two faces
const POMO_PLAY_ICO = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6l11-6.8z"/></svg>';
const POMO_PAUSE_ICO = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.2" y="5" width="4.2" height="14" rx="1.3"/><rect x="13.6" y="5" width="4.2" height="14" rx="1.3"/></svg>';

/* The timer is PERSONAL: state is keyed by the signed-in uid, so two people
   sharing a browser each get their own running session, theme and sound.
   Loaded on sign-in (pomoLoadFor), saved + torn down on sign-out. */
const pomoDefaults = () => ({
  on: false, theme: "autumn",
  focusMin: 25, shortMin: 5, longMin: 20,
  autoBreak: true, autoFocus: true,
  track: "coffeeshop", playMode: "repeat", vol: 0.6, muted: false, chime: true,
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

/* ---------- audio: one looping <audio> element for the music, Web Audio
   only for the chime. Ambient runs only while the timer runs; switching
   tracks swaps the src; the element is reused so the browser caches. ---------- */
let pomoAC = null;
function pomoCtx(){
  pomoAC = pomoAC || new (window.AudioContext || window.webkitAudioContext)();
  if (pomoAC.state === "suspended") pomoAC.resume();
  return pomoAC;
}

let pomoEl = null;   // the one player, lazily created inside a user gesture
function pomoAmbientStop(){
  if (pomoEl) pomoEl.pause();
}

/* Start (or restart) the current track. `force` lets the settings sheet
   audition a pick for a few seconds while the timer is paused. Autoplay
   is fine here because every call chains from a user gesture. */
function pomoAmbientStart(force){
  pomoAmbientStop();
  if (PM.track === "none" || PM.muted || (!PM.running && !force)) return;
  const t = POMO_TRACKS[PM.track];
  if (!t || !t.file) return;
  if (!pomoEl){
    pomoEl = new Audio();
    pomoEl.preload = "auto";
  }
  pomoEl.loop = PM.playMode !== "shuffle";
  pomoEl.onended = PM.playMode === "shuffle" ? pomoShuffleNext : null;
  // keep the element's buffer when the track hasn't changed - resume, not refetch
  if (!pomoEl.src || !pomoEl.src.endsWith("/" + t.file)) pomoEl.src = POMO_TRACK_DIR + t.file;
  pomoEl.volume = PM.muted ? 0 : PM.vol;
  pomoEl.play().catch(e => console.error(e));
}

// shuffle's "next": a different track than the one that just ended, picked
// at random from the whole library - "none" never lands here on its own
function pomoShuffleNext(){
  const pool = Object.keys(POMO_TRACKS).filter(k => k !== "none" && k !== PM.track);
  PM.track = pool.length ? pool[Math.floor(Math.random() * pool.length)] : PM.track;
  pomoSave();
  pomoAmbientStart();
}

// audition a track from the settings sheet without starting the timer:
// it plays for a few seconds, then bows out unless the timer is running
let pomoPreviewTimer = null;
function pomoPreview(){
  clearTimeout(pomoPreviewTimer);
  pomoAmbientStart(true);
  // stop after a few seconds unless this IS the live focus track now - a
  // running break has its own synthesized pad, so PM.running alone isn't
  // enough to tell a genuine live session from an audition playing over it
  pomoPreviewTimer = setTimeout(() => { if (!(PM.running && PM.phase === "focus")) pomoAmbientStop(); }, 6000);
}

function pomoChime(){
  if (!PM.chime) return;
  try {
    const ctx = pomoCtx();
    // the alarm bypasses the ambient mute on purpose: muting the soundscape
    // shouldn't silence the session boundary. Its own toggle is PM.chime.
    const bell = ctx.createGain();
    bell.gain.value = Math.max(PM.vol, 0.3);
    bell.connect(ctx.destination);
    [[880, 0], [1174.7, 0.18]].forEach(([fr, at]) => {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = fr;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 1.1);
      o.connect(g); g.connect(bell);
      o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 1.2);
    });
  } catch (e) { console.error(e); }
}
function pomoApplyVolume(){
  if (pomoEl) pomoEl.volume = PM.muted ? 0 : PM.vol;
  pomoBreakApplyVolume();
}

/* ---------- break ambience: a small generative pad, synthesized live so a
   break always SOUNDS different from whatever real track focus was playing.
   No file, nothing cached - it exists only while the break does. ---------- */
let pomoBreakNodes = null;   // { stops:[fn], timers:[id], master }
function pomoBreakStop(){
  if (!pomoBreakNodes) return;
  pomoBreakNodes.timers.forEach(id => clearTimeout(id));
  pomoBreakNodes.stops.forEach(fn => fn());
  try { pomoBreakNodes.master.disconnect(); } catch (e) {}
  pomoBreakNodes = null;
}
function pomoBreakApplyVolume(){
  if (pomoBreakNodes) pomoBreakNodes.master.gain.value = (PM.muted ? 0 : PM.vol) * 0.5;
}
function pomoBreakStart(){
  pomoBreakStop();
  if (PM.muted) return;
  const ctx = pomoCtx();
  const R = (a, b) => a + Math.random() * (b - a);
  const master = ctx.createGain();
  master.gain.value = (PM.muted ? 0 : PM.vol) * 0.5;
  master.connect(ctx.destination);
  const stops = [], timers = [];

  // a soft breathing pad - a major7 chord, filtered and slowly drifting
  const filt = ctx.createBiquadFilter();
  filt.type = "lowpass"; filt.frequency.value = 900;
  filt.connect(master);
  [261.6, 329.6, 392.0, 493.9].forEach(fr => {   // C E G B
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = fr;
    o.detune.value = R(-5, 5);
    const g = ctx.createGain(); g.gain.value = 0.055;
    o.connect(g); g.connect(filt); o.start();
    stops.push(() => { try { o.stop(); } catch (e) {} });
  });
  const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
  lfo.frequency.value = 0.045; lfoGain.gain.value = 260;
  lfo.connect(lfoGain); lfoGain.connect(filt.frequency);
  lfo.start();
  stops.push(() => { try { lfo.stop(); } catch (e) {} });

  // wind-chime blips wandering a pentatonic scale, unhurried
  const notes = [523.3, 587.3, 659.3, 784.0, 880.0];   // C D E G A
  const chime = () => {
    const f = notes[Math.floor(Math.random() * notes.length)] * (Math.random() < 0.5 ? 1 : 2);
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.09, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
    o.connect(g); g.connect(master);
    o.start(now); o.stop(now + 2.3);
    timers.push(setTimeout(chime, R(2600, 5200)));
  };
  timers.push(setTimeout(chime, R(600, 1800)));
  pomoBreakNodes = { stops, timers, master };
}

/* Dispatch to whichever sound belongs to the current phase - the real
   library on focus, the synthesized pad on a break - and tear the other
   one down so they never overlap. */
function pomoSoundStart(){
  if (PM.phase === "focus"){ pomoBreakStop(); pomoAmbientStart(); }
  else { pomoAmbientStop(); pomoBreakStart(); }
}
function pomoSoundStop(){
  pomoAmbientStop();
  pomoBreakStop();
}

/* ---------- engine ---------- */
/* The switch changes the VIEW, not the session: a running countdown (and
   its ambient sound) carries on behind the clocks and the tab shows a live
   dot, so flipping back lands on the exact remaining time. Only sign-out
   ends a session. */
// the three-way tab (Clocks/Focus/Personal) visuals live in setAppMode
// (js/personal.js) - this owns only what the timer itself needs: whether
// it's on screen, the theme veil, and whether lingering sound stops.
// `on` is true for BOTH Focus and Personal: the full timer (music,
// themes, settings, alarm - the same DOM) rides along into Personal
// mode, so working a personal task gets every pomo feature for free.
function pomoSetMode(on){
  PM.on = on;
  $("appScreen").classList.toggle("pomo-on", on);
  pomoApplyTheme(on ? PM.theme : null);
  if (!on && !PM.running) pomoSoundStop();   // leftover previews etc.
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
  pomoSoundStart();
  pomoRender(); pomoSave();
}
function pomoPause(){
  PM.remainMs = pomoRemainMs();
  PM.running = false; PM.endAt = null;
  pomoSoundStop();
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
    // banked before anything below mutates PM - remaining-time math needs
    // the phase/endAt exactly as they still stand from the round that just ended
    pomoLogFocusSession(pomoTotalMs("focus") - pomoRemainMs(), natural);
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
  if (PM.running) pomoSoundStart(); else pomoSoundStop();
  pomoRender(); pomoSave();
}

/* ---------- Focus mode's own card: today's tally + streak ----------
   A separate localStorage log from PM (which is just live timer state) -
   this is the running history the card reads from. Keyed by uid like
   everything else Pomodoro touches, never Firestore. */
const POMO_LOG_LS = "ez-pomo-log-v1";
const pomoLogKey = () => POMO_LOG_LS + ":" + pomoUid;
const pomoDayKey = (d = new Date()) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
function pomoLoadLog(){
  try { return JSON.parse(localStorage.getItem(pomoLogKey()) || "{}"); } catch (e) { return {}; }
}
function pomoSaveLog(log){
  if (!pomoUid) return;
  try { localStorage.setItem(pomoLogKey(), JSON.stringify(log)); } catch (e) {}
}
/* Called whenever a focus round ends, natural or skipped. Skipping early
   still banks the minutes actually spent - only the "pomos" count requires
   the round to have run all the way out to earn its tick. */
function pomoLogFocusSession(ms, completed){
  if (!pomoUid || ms < 1000) return;
  const log = pomoLoadLog();
  const k = pomoDayKey();
  const day = log[k] || { pomos: 0, focusMs: 0 };
  day.focusMs += ms;
  if (completed) day.pomos += 1;
  log[k] = day;
  pomoSaveLog(log);
  pomoRenderFocusCard();
}
/* Consecutive days with any focus time, walking back from today. A day
   with nothing logged YET (today, before the first round of the day
   finishes) doesn't break a streak earned on prior days - it just hasn't
   extended it yet. */
function pomoStreak(log){
  const d = new Date();
  let streak = (log[pomoDayKey(d)] || {}).focusMs > 0 ? 1 : 0;
  d.setDate(d.getDate() - 1);
  while ((log[pomoDayKey(d)] || {}).focusMs > 0){
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}
function pomoHumanMin(ms){
  const mins = Math.round(ms / 60000);
  return mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h " + (mins % 60) + "m";
}
function pomoRenderFocusCard(){
  const body = $("fcBody"), empty = $("fcEmpty");
  if (!body || !pomoUid) return;
  const log = pomoLoadLog();
  const hasAny = Object.keys(log).length > 0;
  body.classList.toggle("hidden", !hasAny);
  empty.classList.toggle("hidden", hasAny);
  if (!hasAny) return;
  const today = log[pomoDayKey()] || { pomos: 0, focusMs: 0 };
  const streak = pomoStreak(log);
  $("fcPomos").textContent = today.pomos;
  $("fcTime").textContent = pomoHumanMin(today.focusMs);
  $("fcStreakNum").textContent = streak + (streak === 1 ? " day" : " days");
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    return (log[pomoDayKey(d)] || {}).focusMs / 60000 || 0;
  });
  $("fcSpark").innerHTML = sparklineSvg(days, "Focus minutes over the last 7 days");
}

function pomoTick(){
  // boundaries fire no matter which view is up - the alarm and the
  // work/short/long branching don't care what you're looking at
  if (PM.running && pomoRemainMs() <= 0){ pomoAdvance(true); return; }
  pomoBreakCountdownTick();
  if (PM.on && PM.running) pomoRenderTime();
}

/* The last five seconds of a break count down in short tones - not the
   two-minute alarm-clock ring focus gets (that's a heads-up), this is a
   beat-by-beat "back to work" cue right as the break runs out. tick() is
   already a real 1-second interval, so remainSec lands on each whole
   second at most once; pomoLastBeepSec guards the odd case where a tick
   fires early/late and would otherwise land on the same second twice. */
let pomoLastBeepSec = null;
function pomoBreakCountdownTick(){
  if (!(PM.running && PM.phase !== "focus")){ pomoLastBeepSec = null; return; }
  const remainSec = Math.round(pomoRemainMs() / 1000);
  if (remainSec < 1 || remainSec > 5 || remainSec === pomoLastBeepSec) return;
  pomoLastBeepSec = remainSec;
  pomoCountdownTone(remainSec);
}
function pomoCountdownTone(n){
  if (!PM.chime) return;
  try {
    const ctx = pomoCtx();
    const o = ctx.createOscillator(); o.type = "sine";
    o.frequency.value = n === 1 ? 1046.5 : 784;   // the final beep steps up, like "go"
    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(PM.vol, 0.3), now + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    o.connect(g); g.connect(ctx.destination);
    o.start(now); o.stop(now + 0.18);
  } catch (e) { console.error(e); }
}

function pomoRenderTime(){
  const remain = pomoRemainMs(), total = pomoTotalMs();
  $("pomoTime").textContent = pomoMMSS(remain);
  $("pomoArc").setAttribute("d", pomoArcPath(1 - remain / total));
  // last two minutes of a focus round: the ring turns into an alarm clock
  // ringing, so the break never arrives as a surprise
  const soon = PM.phase === "focus" && PM.running && remain > 0 && remain <= 120000;
  $("pomo").classList.toggle("is-alarm-soon", soon);
  $("pomoPhase").textContent = soon ? "Break soon" : POMO_PHASE_LABEL[PM.phase];
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
  // icons, not words: ▶ starts or resumes, ‖ pauses - the standard toggle
  const play = $("pomoPlay");
  play.innerHTML = PM.running ? POMO_PAUSE_ICO : POMO_PLAY_ICO;
  const playLabel = PM.running ? "Pause" : (pomoRemainMs() < pomoTotalMs() ? "Resume" : "Start");
  play.setAttribute("aria-label", playLabel);
  play.title = playLabel;
  $("pomoSoundOnIco").classList.toggle("hidden", PM.muted || PM.track === "none");
  $("pomoSoundOffIco").classList.toggle("hidden", !(PM.muted || PM.track === "none"));
  // the Focus tab wears a live dot while a session runs behind the clocks
  $("modeFocus").classList.toggle("is-live", PM.running);
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
// close every settings dropdown - Esc ladder and outside clicks both land here
function pomoDropCloseAll(){
  document.querySelectorAll(".pdrop .af-panel").forEach(pn => { pn.hidden = true; });
  document.querySelectorAll(".pdrop .af-trigger").forEach(t => t.setAttribute("aria-expanded", "false"));
}
document.addEventListener("click", e => {
  if (!e.target.closest(".pdrop") && document.querySelector(".pdrop .af-panel:not([hidden])")) pomoDropCloseAll();
});

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
    <p class="hint" style="margin:-10px 0 14px;font-size:12px">Breaks get their own sound automatically — this picks focus's.</p>
    <label class="fld"><span>Playback</span></label>
    ${pomoDropdownMarkup("pPlayDrop", POMO_PLAYMODES, PM.playMode)}
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
      // a break is playing its own synthesized pad right now - a focus pick
      // just gets saved for when the next focus round starts
      if (PM.running && PM.phase === "focus") pomoAmbientStart();
      else if (k !== "none" && !PM.muted) pomoPreview();  // audition it briefly
      else pomoAmbientStop();
      pomoRender(); pomoSave();
    });
    pomoWireDropdown("pPlayDrop", POMO_PLAYMODES, k => {
      PM.playMode = k;
      if (pomoEl){
        pomoEl.loop = k !== "shuffle";
        pomoEl.onended = k === "shuffle" ? pomoShuffleNext : null;
      }
      pomoSave();
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
  // saved picks from the synthesized era (rain, fire, …) land on real music
  if (!POMO_TRACKS[PM.track]) PM.track = "coffeeshop";
  if (!POMO_PLAYMODES[PM.playMode]) PM.playMode = "repeat";
  // a session that was running when they left: settle it honestly
  if (PM.running && PM.endAt && PM.endAt <= Date.now()){
    PM.running = false; PM.remainMs = 0;
    pomoAdvance(false);
    PM.running = false; PM.endAt = null;
    pomoSave();
  } else if (!PM.running){
    PM.endAt = null;
    PM.remainMs = Math.min(PM.remainMs, pomoTotalMs()) || pomoTotalMs();
  } else {
    // still mid-session across the reload: the countdown itself carries on
    // fine (it's just Date.now() math), but the audio doesn't - a fresh
    // page load means a fresh AudioContext and a fresh <audio> element,
    // neither of which is playing anything until told to. pomoSoundStart()
    // may still get blocked by the browser's autoplay policy if this page
    // load hasn't had a user gesture yet ("keep me signed in" can restore
    // a session with none) - pomoArmAutoplayFallback below catches that.
    pomoSoundStart();
  }
  setAppMode(PM.on ? "focus" : "clocks");
}

/* Park the current account's state and clear the deck. Called on sign-out.
   Signing out ENDS the focus session: the parked state keeps every
   preference (mode, theme, sound, durations) but the countdown itself is
   reset, so signing back in always starts a fresh round 1. A plain reload
   never passes through here, which is why a refresh still resumes.
   Order matters: save with the real uid first, THEN reset to defaults so
   the login screen (and the next person) sees a neutral timer. */
function pomoUnload(){
  if (pomoUid){
    PM.running = false; PM.endAt = null;
    PM.phase = "focus"; PM.round = 1;
    PM.remainMs = PM.focusMin * 60000;
    pomoSave();
  }
  clearTimeout(pomoPreviewTimer);
  pomoSoundStop();
  pomoUid = null;
  PM = pomoDefaults();
  setAppMode("clocks");
}

/* A reload with "keep me signed in" can restore a running session before
   this page has had any user gesture at all, which is exactly when a
   browser's autoplay policy blocks pomoSoundStart()'s play()/resume()
   calls (silently - they just never make sound).
   Two things that look reasonable both break this in practice:
   - A ONE-SHOT listener races pomoLoadFor(): the page's first click often
     lands before Firebase's onAuthStateChanged has even resolved (still
     signing in), which fires and un-arms the fallback on a gesture that
     happened before there was anything running to unlock - leaving no
     second chance once the session actually starts. So this stays armed
     for the whole page lifetime instead of removing itself after one hit;
     each check is cheap and a no-op once sound is actually flowing.
   - A bubble-phase document listener can be beaten by any handler that
     calls stopPropagation() on the way up (this app has a few, e.g. the
     Team page's card headers) - it would just never see the click. Capture
     phase on document fires first, before anything downstream can stop it.
   - Capture phase created a NEW bug, though: it runs before the click's own
     handler does, so clicking Pause raced against this - it would resume
     the (blocked, silent) audio a beat before pomoPause() stopped it again,
     producing an audible blip right as the timer paused. Deferring the
     actual check to the next tick (setTimeout 0) lets the click's own
     handler run to completion first - by the time this checks PM.running,
     Pause has already set it false and the check correctly no-ops. This
     stays well inside the same user-activation window browsers grant a
     click, so play()/resume() calls made from it still count. */
function pomoArmAutoplayFallback(){
  const tryResume = () => {
    if (!PM.running) return;
    pomoCtx();
    if (PM.phase === "focus"){ if (!pomoEl || pomoEl.paused) pomoAmbientStart(); }
    else if (!pomoBreakNodes) pomoBreakStart();
  };
  const armed = () => setTimeout(tryResume, 0);
  document.addEventListener("pointerdown", armed, true);
  document.addEventListener("click", armed, true);
  document.addEventListener("keydown", armed, true);
}

/* ---------- boot ---------- */
(function pomoInit(){
  const pomo = $("pomo");
  if (!pomo) return;
  pomo.removeAttribute("hidden");   // CSS classes own visibility from here on
  pomoArmAutoplayFallback();
  $("modeClocks").onclick = () => setAppMode("clocks");
  $("modeFocus").onclick = () => setAppMode("focus");
  $("pomoPlay").onclick = () => PM.running ? pomoPause() : pomoStart();
  $("pomoReset").onclick = pomoResetPhase;
  $("pomoSkip").onclick = () => pomoAdvance(false);
  $("pomoGear").onclick = openPomoSettings;
  $("pomoSound").onclick = () => {
    PM.muted = !PM.muted;
    pomoApplyVolume();
    if (!PM.muted && PM.running) pomoSoundStart();
    if (PM.muted) pomoSoundStop();
    pomoRender(); pomoSave();
  };
  setAppMode("clocks");   // neutral until someone signs in and loads their own
})();
