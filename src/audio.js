// 用户提供的短音效；同类只保留一个声源，避免连点或持续受击叠成噪声。
const SOUNDS = {
  click: { file: 'click.wav', gain: .25, interval: .04 },
  dig: { file: 'dig.wav', gain: .45, interval: .12 },
  pickup: { file: 'pickup.wav', gain: .3, interval: .08 },
  install: { file: 'install.wav', gain: .45, interval: .08 },
  jump: { file: 'jump.wav', gain: .4, interval: .08 },
  synth: { file: 'synth.wav', gain: .4, interval: .12 },
  damage: { file: 'damage.wav', gain: .5, interval: .2 },
  warning: { file: 'warning.wav', gain: .55, interval: .5 },
  meteor: { file: 'meteor.wav', gain: .4, interval: .1 },
  lightning: { file: 'lightning.wav', gain: .48, interval: .1 },
  beam: { file: 'beam.wav', gain: .28, interval: .1 },
  beasts: { file: 'beasts.wav', gain: .18, interval: .1 },
  sinkhole: { file: 'sinkhole.wav', gain: .45, interval: .1 },
  collapse: { file: 'collapse.wav', gain: .45, interval: .1 },
  fog: { file: 'fog.wav', gain: .22, interval: 0, loop: true },
  tornado: { file: 'tornado.wav', gain: .24, interval: 0, loop: true },
};
const MUSIC = {
  explore: { file: 'explore-music.wav', gain: .28 },
  disaster: { file: 'disaster-music.wav', gain: .23 },
};

export function createGameAudio() {
  let context = null, output = null, muted = false, generation = 0;
  const buffers = new Map(), playing = new Map(), lastPlayed = new Map();
  const wantedLoops = new Set(), pendingLoops = new Map();
  let musicBus = null, musicMuted = false, wantedMusic = null, musicVoice = null, musicGeneration = 0;
  const musicVoices = new Set(), musicPositions = new Map();
  const load = (kind) => {
    if (!buffers.has(kind)) buffers.set(kind, (async () => {
      try {
        const response = await fetch(new URL(`../assets/audio/${(SOUNDS[kind] || MUSIC[kind]).file}`, import.meta.url));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await context.decodeAudioData(await response.arrayBuffer());
      } catch (error) { console.warn('音效加载失败', kind, error); return null; }
    })());
    return buffers.get(kind);
  };
  const unlock = () => {
    if ((muted && musicMuted) || document.hidden) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    if (!context) {
      context = new Audio();
      output = context.createDynamicsCompressor(); output.connect(context.destination);
      musicBus = context.createGain(); musicBus.connect(output);
      for (const kind of Object.keys(SOUNDS)) load(kind);
    }
    return context.state === 'suspended' ? context.resume().catch(() => {}) : Promise.resolve();
  };
  const stopEffects = () => {
    generation++;
    for (const source of playing.values()) source.stop();
    playing.clear(); lastPlayed.clear();
    wantedLoops.clear(); pendingLoops.clear();
  };
  const rememberMusic = (voice, when = context.currentTime) => {
    musicPositions.set(voice.kind, (voice.offset + when - voice.started) % voice.source.buffer.duration);
  };
  const stopMusic = (reset = false) => {
    wantedMusic = null; musicGeneration++;
    for (const voice of musicVoices) { rememberMusic(voice); voice.source.stop(); }
    musicVoices.clear(); musicVoice = null;
    if (reset) musicPositions.clear();
    if (musicBus) { musicBus.gain.cancelScheduledValues(context.currentTime); musicBus.gain.setValueAtTime(1, context.currentTime); }
  };
  const syncMusic = (kind) => {
    const next = musicMuted || document.hidden ? null : kind;
    if (!context || next === wantedMusic) return;
    if (!next) { stopMusic(); return; }
    wantedMusic = next;
    const ticket = ++musicGeneration;
    (async () => {
      await unlock();
      const buffer = await load(next);
      if (!buffer || ticket !== musicGeneration || wantedMusic !== next || document.hidden || context.state !== 'running') return;
      const now = context.currentTime, sound = MUSIC[next], fade = .6;
      if (musicVoice) {
        const old = musicVoice;
        old.gain.gain.cancelScheduledValues(now);
        old.gain.gain.setValueAtTime(old.gain.gain.value, now);
        old.gain.gain.linearRampToValueAtTime(0, now + fade);
        rememberMusic(old, now + fade); old.source.stop(now + fade);
      }
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = buffer; source.loop = true;
      source.connect(gain); gain.connect(musicBus);
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(sound.gain, now + fade);
      const voice = { kind: next, source, gain, offset: musicPositions.get(next) || 0, started: now };
      source.onended = () => {
        musicVoices.delete(voice); if (musicVoice === voice) musicVoice = null;
        source.disconnect(); gain.disconnect();
      };
      musicVoice = voice; musicVoices.add(voice); source.start(now, voice.offset);
    })();
  };
  const play = async (kind, repeats = 1) => {
    if (muted || document.hidden || !SOUNDS[kind]) return;
    const sound = SOUNDS[kind], request = {};
    if (sound.loop) {
      if (!wantedLoops.has(kind) || playing.has(kind) || pendingLoops.has(kind)) return;
      pendingLoops.set(kind, request);
    }
    const ticket = generation;
    await unlock();
    if (!context) return;
    const buffer = await load(kind);
    if (sound.loop) {
      if (pendingLoops.get(kind) !== request) return;
      pendingLoops.delete(kind);
      if (!wantedLoops.has(kind)) return;
    }
    if (!buffer || muted || document.hidden || generation !== ticket || context.state !== 'running') return;
    // 普通单次提示不打断正在进行的三遍警报。
    if (repeats === 1 && !sound.loop && playing.get(kind)?.loop) return;
    const now = context.currentTime;
    if (now - (lastPlayed.get(kind) ?? -Infinity) < sound.interval) return;
    lastPlayed.set(kind, now);
    playing.get(kind)?.stop();
    const source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer; source.loop = !!sound.loop || repeats > 1; gain.gain.value = sound.gain;
    source.connect(gain); gain.connect(output);
    source.onended = () => {
      if (playing.get(kind) === source) playing.delete(kind);
      source.disconnect(); gain.disconnect();
    };
    playing.set(kind, source); source.start(now);
    if (repeats > 1) source.stop(now + buffer.duration * repeats);
    if (kind === 'warning' && repeats > 1) {
      musicBus.gain.cancelScheduledValues(now); musicBus.gain.setValueAtTime(musicBus.gain.value, now);
      musicBus.gain.linearRampToValueAtTime(.25, now + .08);
      musicBus.gain.setValueAtTime(.25, now + buffer.duration * repeats);
      musicBus.gain.linearRampToValueAtTime(1, now + buffer.duration * repeats + .35);
    }
  };
  return {
    unlock,
    stopAll(resetMusic = false) { stopEffects(); stopMusic(resetMusic); },
    setMuted(value) { muted = value; if (muted) stopEffects(); },
    setMusicMuted(value) { musicMuted = value; if (musicMuted) stopMusic(); },
    syncMusic,
    play(kind, repeats = 1) { if (!SOUNDS[kind]?.loop) return play(kind, repeats); },
    syncDisasters(ids) {
      for (const kind of wantedLoops) {
        if (ids.includes(kind)) continue;
        wantedLoops.delete(kind); pendingLoops.delete(kind);
        playing.get(kind)?.stop(); playing.delete(kind);
      }
      // 跟随游戏状态，但首次加载仍必须由玩家手势解锁。
      if (!context || muted || document.hidden) return;
      for (const kind of ids) {
        if (!SOUNDS[kind]?.loop) continue;
        wantedLoops.add(kind); play(kind);
      }
    },
  };
}
