// 浏览器原型本地检查点。恢复后暂停，不把离线时间算作游戏时间。
import { MATERIALS, UI_LAYOUT, DISASTERS } from './config.js';
import { snapshotLayers, restoreLayers } from './world.js';
import { Workbench } from './synthesis.js';

export const SAVE_KEY = 'alien-shelter.checkpoint.v1';
const TRANSIENT = [
  'shelter', 'player', 'world', 'worldGround', 'worldUnder', 'monsters', 'siege', 'director',
  'rng', 'drag', 'dragTarget', 'itemPress', 'inspectItem', 'removeConfirm', 'press',
  'repairingFaceId', 'uiDrag', 'uiPending', 'activePointerId', 'fade',
  'nearSpot', 'approachSpot', 'pendingDig', 'approachBreak', 'pendingBreak',
  'workbenches', 'synthPanel', 'synthOptions', 'synthTake', 'effects',
];
const copy = (v) => JSON.parse(JSON.stringify(v));
const own = (v, exclude = []) => Object.fromEntries(Object.entries(v)
  .filter(([k, value]) => typeof value !== 'function' && !exclude.includes(k)));

export function captureCheckpoint(s) {
  // fade.mid 是闭包，不能恢复一半的瞬移；保留上一个完整检查点。
  if (s.fade) return null;
  const lootIndex = (v) => v ? s.world.loot.indexOf(v) : -1;
  return copy({
    version: 1,
    state: own(s, TRANSIENT),
    player: own(s.player), shelter: own(s.shelter),
    director: own(s.director, ['shelter', 'active', 'events']),
    layers: snapshotLayers(),
    ground: own(s.worldGround), under: own(s.worldUnder),
    monsters: {
      contactTimer: s.monsters.contactTimer,
      byLayer: Object.fromEntries(['ground', 'under'].map((layer) => [layer,
        s.monsters.byLayer[layer].map((m) => own(m, ['profile']))])),
    },
    siege: own(s.siege, ['profile']),
    benches: s.workbenches.map((wb) => own(wb)),
    near: lootIndex(s.nearSpot), approach: lootIndex(s.approachSpot),
    pendingDig: s.pendingDig ? { index: lootIndex(s.pendingDig.spot), n: s.pendingDig.n } : null,
    approachBreak: s.approachBreak ? s.world.hidden.indexOf(s.approachBreak) : -1,
    pendingBreak: s.pendingBreak ? { index: s.world.hidden.indexOf(s.pendingBreak.hid), n: s.pendingBreak.n } : null,
    layout: UI_LAYOUT,
  });
}

export function restoreCheckpoint(s, data) {
  if (data.version !== 1 || !data.layers?.ground?.profile || !data.layers?.under?.profile
      || !Number.isFinite(data.director?.timer) || !Number.isInteger(data.director.wave)
      || data.director.wave < 1 || !['ground', 'under'].includes(data.state?.layer)
      || !Number.isFinite(data.player?.hp) || !Array.isArray(data.benches)) {
    throw new Error('存档版本或内容无效');
  }
  const ids = [...data.player.carry, ...Object.values(data.shelter.store).flat(),
    ...data.shelter.faces.flatMap((f) => f.positions.map((p) => p.mat)).filter(Boolean),
    ...[data.ground, data.under].flatMap((w) => w.loot.flatMap((l) => l.pending))];
  if (ids.some((id) => !MATERIALS[id])) throw new Error('存档包含未知材料');
  Object.assign(s, data.state);
  Object.assign(s.player, data.player);
  Object.assign(s.shelter, data.shelter);
  Object.assign(s.director, data.director);
  s.director.shelter = s.shelter;
  s.director.active = s.director.phase === 'disaster'
    ? s.director.cfg.disasters.map((id) => DISASTERS[id]) : [];
  Object.assign(s.worldGround, data.ground);
  Object.assign(s.worldUnder, data.under);
  restoreLayers(data.layers);
  s.world = s.layer === 'under' ? s.worldUnder : s.worldGround;
  for (const layer of ['ground', 'under']) {
    data.monsters.byLayer[layer].forEach((m, i) => Object.assign(s.monsters.byLayer[layer][i], m));
  }
  s.monsters.contactTimer = data.monsters.contactTimer;
  s.monsters.setLayer(s.layer);
  s.siege.restore(data.siege);
  s.workbenches = data.benches.map((b) => Object.assign(new Workbench(), b));
  s.nearSpot = s.world.loot[data.near] || null;
  s.approachSpot = s.world.loot[data.approach] || null;
  s.pendingDig = data.pendingDig && s.world.loot[data.pendingDig.index]
    ? { spot: s.world.loot[data.pendingDig.index], n: data.pendingDig.n } : null;
  s.approachBreak = s.world.hidden[data.approachBreak] || null;
  s.pendingBreak = data.pendingBreak && s.world.hidden[data.pendingBreak.index]
    ? { hid: s.world.hidden[data.pendingBreak.index], n: data.pendingBreak.n } : null;
  for (const key of Object.keys(UI_LAYOUT)) Object.assign(UI_LAYOUT[key], data.layout[key]);
  s.helpOpen = !UI_LAYOUT.help.collapsed;
  s.paused = true;
}
