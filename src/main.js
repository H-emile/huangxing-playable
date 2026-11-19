// 主循环 + 指针输入 + 动作派发
//
// 交互范式：手机上没有键盘，所以交互全部走指针（电脑鼠标 / 手机手指，同一套代码）
//   · 点地面 → 走过去
//   · 点废墟料堆 → 走过去，到达后自动挖第一层；之后继续点可以加深（越深越稀有，塌方则暂存全丢）
//   · 走开料堆 → 自动把暂存的东西收进背包
//   · 从背包拖材料到墙上 → 结构件进补漏位（补耐久）／功能件进插槽位（给属性）
//   · 从背包/仓库拖材料到垃圾桶 → 丢弃（真删除，3 秒内可撤销）
//   · 点墙上某个位置的材料 → 取下：结构件**完好**才回背包，**破损的直接消失**
//     （想拿回来必须先用修复材料长按修满，见 pickPatchBack）
//   · 点 HUD 上的「提前开波」区块（或按 Enter）→ 砍掉剩余准备期，按省下的秒数换材料奖励
//     ⚠️ 两个入口都要有：键盘只有电脑上有，而这是微信小游戏
//   · 走到庇护所右侧的**工作台**点一下 → 选两件结构材料启动**后台合成**（30 秒，可自由行动）
//     ⚠️ 合成中庇护所被打穿 → 进度暂停（不清零）；已经破着的面再挨打 → **投入的材料全毁**

import {
  VIEW, WORLD, PLAYER, SHELTER, MATERIALS, LOOT_RULES, DIG, REPAIR, RULES, WIN_WAVE, caveInChance, KIND_LABEL,
  healAfterWave, DISASTERS, TIER_NAME,
  RUIN_TYPES, LURE,
  BAG_SLOTS, bagSlotRect, bagPanelRect, pointInRect,
  trashRect, trashUndoRect, TRASH_UNDO_SECONDS, endButtonRect,
  LIGHT, skipBtnRect, SHELTER_SLOTS,
  SYNTH, workbenchRect, workbenchCapacity, synthPanelRect, synthSlotRect, synthOptionRect,
  synthScrollGeometry, synthStartRect, synthCloseRect, LIFTS, HIDDEN, TUNNELS, CAMERA,
  CAMERA_ANCHOR_Y, screenToWorld,
  UI_SKIN, FX, LAYER_FADE, DISASTER_TINT,
  // 常驻面板的"收起 / 拖动"（2026-10-05）
  UI_LAYOUT, UI_CHROME, uiIsDraggable, uiPanelBase, uiSetOffset, uiLabelRect, uiTitleBarRect, uiCollapseIconRect,
} from './config.js';
import { ShelterModel } from './shelter.js';
import { WaveDirector, Phase } from './waveDirector.js';
import { Player, clamp } from './player.js';
import {
  World, shelterRects, positionAt, expandSlotRect, terrainDodge, setDodgePlayerX, terrainY,
  setLayer, entrances, atSpot, facePositionRects,
} from './world.js';
import { MonsterPack, SiegePack } from './monsters.js';
import { Workbench, SYNTH_STATE, canSynthesize } from './synthesis.js';
import { render, fxSpritesFor } from './render.js';
import { captureCheckpoint, restoreCheckpoint, SAVE_KEY } from './checkpoint.js';
import { createExperience } from './experience.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const SHAPE = shelterRects();

let s = null;
const keys = Object.create(null);
let experience = null;
let saveElapsed = 0;
let touchDirection = 0;
let tutorialLayout = null;

/** 清空键盘状态。重开一局必须清，否则上一局残留的按键会继续推着主角走 */
function clearKeys() {
  for (const k in keys) keys[k] = false;
}

function newGame(resetCheckpoint = true, mode = 'game') {
  if (resetCheckpoint) {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* 保存时会显示存储受限 */ }
  }
  const shelter = new ShelterModel();
  clearKeys();
  touchDirection = 0;
  experience?.releaseMovement();
  experience?.resetSounds();
  s = {
    mode, screen: 'play', tutorialStep: 0, tutorialJumped: false,
    tutorialInspected: false, tutorialObserveLeft: 0, tutorialReviewed: false, tutorialRepairSpent: 0,
    shelter,
    player: new Player(),
    // ---------- 分层世界（2026-09-27 第四轮）：地面 + 地下 ----------
    // ⚠️ 两个 World 各自持有"这一层的地形/桥/料堆"；`s.world` / `s.layer` 只是**当前层的指针**。
    //    之所以能把"地下"加进来而不改撒点/物理/渲染 —— 全靠 world.js 的 setLayer 把
    //    "当前层数据"一次性切好（见那里的注释）。
    world: null,                    // ← 指向下面两个之一
    worldGround: new World(Math.random, 'ground'),
    worldUnder: new World(Math.random, 'under'),
    layer: 'ground',
    monsters: new MonsterPack(),
    siege: new SiegePack(),        // 兽潮围攻（2026-10-04）—— 只在 `beasts` 灾害期非空
    director: new WaveDirector(shelter),
    camera: { x: 0, y: 0 },
    effects: [],
    shake: 0,
    quakeT: 0,
    // 动作反馈粒子的**种子计数器**（2026-10-01）。⚠️ 不用 Math.random：
    //    粒子的横向偏移是 `wobble(种子, 序号, 幅度)` 的纯函数，种子只在这一处自增，
    //    于是"同一次爆发每次重绘长得一样、不同次爆发互不相同"。
    //    见 config 的 FX 与 art.js 的 wobble 注释。
    fxSeed: 0,
    speed: 1,
    rng: Math.random,
    showForecast: true,
    // 帮助默认收起；教学单独显示步骤，布局跨重开保留，存档恢复会还原布局。
    helpOpen: !UI_LAYOUT.help.collapsed,
    banner: null,
    tint: null,
    endSummary: null,      // { win, wave, cause } —— 结算面板。win=true 是通关，false 是死亡
    endless: false,        // 通关后选了"继续挑战" → 波次无限外推
    lastWave: 0,
    pointer: { x: 0, y: 0 },
    activePointerId: null,
    itemPress: null,
    inspectItem: null,
    removeConfirm: null,
    paused: false,
    tutorialGiven: false,
    tutorialDone: false,
    lastDefense: null,
    drag: null,            // { mat, fromBagIndex, x, y }
    dragTarget: null,      // { faceId, posIndex }
    uiDrag: null,          // { key, offX, offY } —— 正在拖常驻面板的标题条（只有小地图/背包能拖）
    hoverBagIndex: -1,
    approachSpot: null,    // 旧存档字段，场景点击不再自动靠近
    nearSpot: null,        // 当前站在哪个料堆旁（用于"走开自动收"）
    press: null,           // { faceId, posIndex, at, handled } —— 用于区分"长按修复"与"短按拆下"
    repairingFaceId: null, // 正在长按修复的面
    repairOpen: null,      // 当前正在消耗的那份修复材料 { matId, left }
    hoverStoreIndex: -1,
    trashUndo: null,       // { mat, from, t } —— 刚丢掉的材料，3 秒内可撤销
    leakAlert: null,       // { t, kind, name, dmg } —— 庇护所没挡住、伤害直接落到主角身上的提示
    blockAlert: null,      // { t, name } —— "完全拦住"的正反馈（悬崖式手感必须让玩家看见）
    dodgeAlert: null,      // { t, kind, name } —— "靠地形躲开了"的正反馈（不给他看就不会去用）
    flashlight: true,      // 手电筒（2026-09-26）：开关，无消耗。默认开着，否则一开始就摸黑太劝退
    pendingDig: null,      // { spot, n } —— 挖掘硬直期间缓冲下来的连点，硬直一结束补上
    killedBy: null,        // 只有"致死那一击"才会写入，用来决定结算里的死因
    _healed: 0,            // 本波切换时回了多少血（只用于横幅文案）
    _slotGranted: false,   // 本波切换时有没有发到"扩展空位"额度（只用于横幅文案）
    _benchAdded: false,    // 本波切换时有没有多出一个工作台（只用于横幅文案）
    // ---------- 合成（2026-09-27；2026-09-27 续：改成**多个工作台**）----------
    // ⚠️ 数组而不是单个：用户要"第 5 波后再增加一个工作台"，而且两个台子**可以同时合成**。
    //    开局只有 1 个；撑过第 5 波后 push 进第 2 个（见波次切换那段）。
    //    台子的**位置**由 config 的 WORKBENCH.offs 给（庇护所内部、左右并排），
    //    所以"第几个台子在哪"永远对得上，不需要在别处记。
    workbenches: [new Workbench()],
    synthPanel: null,            // null = 关闭；{ bench, slotA, slotB } = 打开（bench = 用哪个台子）
    // ⚠️ 2026-09-29：取货动画的运行时状态（`tapWorkbench` 起、主循环推、播完才入袋）。
    //    `{ bench, t, dur }`；null = 没在播。见 takeFromBench 的注释。
    synthTake: null,
    synthOptions: [],            // 打开面板时缓存的候选：背包 + 仓库里的结构材料，按 id 去重带数量
    synthPausedFaces: [],        // 暂停合成时"被打穿的那几个面"——它们补好后自动继续（不清零）
    synthLossT: 0,               // "材料全毁"红字的剩余显示秒数（不走横幅：横幅会被同帧的其他提示覆盖）
    // ---------- 隐藏区与小地图（2026-09-27）----------
    pendingBreak: null,          // { hid, n } —— 挖碎石堆时硬直期间缓冲的连点（和挖掘同款）
    approachBreak: null,         // 旧存档字段，场景点击不再自动靠近
    explored: { min: 1e9, max: -1e9 },   // 走过的 x 范围（小地图"逐步点亮"用；换波时重置）
    // 通用过渡（渐黑 → 在中点执行 mid() → 渐亮）。三处瞬移共用它：
    //   隧道传送 / 地穴口换层 —— 见 startFade 的注释（升降台不需要，它本来就是动画）。
    fade: null,                  // { t, dur, mid, done }
    // 手电筒的**平滑开合度**（0 = 关灯、1 = 开灯）。`flashlight` 是玩家的开关意图（布尔），
    // 这个是渲染实际读的值 —— 由 step 向目标指数趋近（见 LIGHT.transition）。
    // ⚠️ 初值必须是 1：`flashlight` 默认就是开的（见上面那一行的注释），
    //    初值给 0 的话开局会先"从摸黑亮起来"一下。
    lightK: 1,
  };
  s.lastWave = s.director.wave;
  // ⚠️ 两个 World 的构造都会调 setLayer（各自生成时会切到自己那层）→ 这里必须显式切回地面，
  //    否则开局所有"当前层"的指针都停在**地下**（人物会站在地下地形上、小地图画的是地下）。
  switchLayer('ground');
  updateCamera();
  window.__game = s;   // 调试钩子，供自动化验证读取内部状态
  banner('准备期开始',
    `第 ${s.director.wave}/${WIN_WAVE} 波 · ${s.director.cfg.prep} 秒 · 撑过 ${WIN_WAVE} 波即通关`,
    UI_SKIN.ok, 3.2);
}

function saveCheckpoint() {
  if (!s || s.mode === 'tutorial' || s.screen === 'home') return;
  try {
    const data = captureCheckpoint(s);
    if (!data) { s.saveStatus = '转场完成后保存'; return; }
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    s.saveStatus = '进度已保存，刷新可继续';
  } catch {
    s.saveStatus = '浏览器存储不可用，本次进度未保存';
  }
}

function cancelGesture() {
  if (!s) return;
  if (s.activePointerId !== null) {
    try { canvas.releasePointerCapture(s.activePointerId); } catch { /* 已释放 */ }
  }
  s.activePointerId = null;
  if (s.synthPanel) s.synthPanel.gesture = null;
  s.drag = null; s.itemPress = null; s.dragTarget = null;
  s.uiDrag = null; s.uiPending = null; s.press = null; s.repairingFaceId = null;
  clearKeys();
  touchDirection = 0;
  experience?.releaseMovement();
}

function pauseGame() {
  if (!s) return;
  cancelGesture();
  experience?.stopSounds();
  s.paused = true;
  saveCheckpoint();
}

function resumeGame() {
  if (!s || s.screen === 'home' || document.hidden) return;
  cancelGesture();
  s.paused = false;
  last = performance.now();
  startLoop();
}

function showHome() {
  if (s) pauseGame();
  if (tutorialLayout) {
    for (const key of Object.keys(UI_LAYOUT)) Object.assign(UI_LAYOUT[key], tutorialLayout[key]);
    tutorialLayout = null;
  }
  newGame(false);
  let hasSave = false, message = '';
  try {
    const stored = localStorage.getItem(SAVE_KEY);
    if (stored) {
      restoreCheckpoint(s, JSON.parse(stored));
      switchLayer(s.layer);
      hasSave = true;
      message = `第 ${s.director.wave} 波 · 进度已保存`;
    }
  } catch {
    newGame(false);
    message = '续玩记录无法读取，可以开始新游戏。';
  }
  s.mode = 'game'; s.screen = 'home'; s.paused = true;
  s.banner = null; s.inspectItem = null; s.removeConfirm = null; s.synthPanel = null;
  s.saveStatus = message;
  updateCamera();
  experience.showHome(hasSave, message);
}

function startGame() {
  s.screen = 'play'; s.mode = 'game';
  experience.hideHome(); resumeGame(); saveCheckpoint();
}

function startTutorial() {
  if (!tutorialLayout) tutorialLayout = JSON.parse(JSON.stringify(UI_LAYOUT));
  newGame(false, 'tutorial');
  s.shelter.dropCap = 0; // 教学首波先观察耐久损耗，避免随机掉落打断演示。
  const spot = s.world.loot.find((l) => l.type === 'stable' && !l.plat) || s.world.loot[0];
  s.world.loot = [{ ...spot, x: SHELTER.cx + 260, y: terrainY(SHELTER.cx + 260),
    type: 'stable', plat: null, depth: 0, maxDepth: 1, pending: [], available: true, depleted: false }];
  s.monsters.byLayer = { ground: [], under: [] }; s.monsters.setLayer('ground');
  s.banner = null;
  experience.hideHome(); resumeGame();
  experience.tutorialIntro();
}

function jumpPlayer() {
  if (!s.paused && s.player.jump()) {
    if (s.mode === 'tutorial') s.tutorialJumped = true;
    experience?.sound('jump');
  }
}

/**
 * 切"当前层" —— **唯一的入口**。
 *
 * ⚠️ 它一次切**四处**指针，缺一处就会错位（而且都是静默的）：
 *    · `setLayer()`（world.js）：地形剖面 / 桥 / 升降台 / 石台 / 隧道 / 岩棚
 *    · `s.layer`：main 自己的标志（渲染、inBuildZone、faceAt 都读它）
 *    · `s.world`：哪一份 World（撒点、料堆、碎石堆）
 *    · `s.monsters.setLayer()`：哪一套怪物（地面 6 只 / 地下 4 只）
 * ⚠️ 分层那轮的原话是"生成会自动切层，调用方要记得切回来"（见 docs/04）——
 *    当时只有 2 处地方要复位，靠人记；现在怪物也分层了，就有 4 处指针要同步。
 *    与其在每个调用点各写四行、以后加第五处指针时又漏，不如收成这一个函数。
 */
function switchLayer(name) {
  setLayer(name);
  s.layer = name;
  s.world = name === 'under' ? s.worldUnder : s.worldGround;
  s.monsters.setLayer(name);
}

/**
 * 通用过渡：渐黑 → 到**中点**时执行一次 `mid()` → 渐亮。
 *
 * ⚠️ 为什么两处瞬移要共用同一套：隧道传送和地穴口换层要解决的是**同一个问题** ——
 *    "瞬移看不见"。玩家该看到的是"我钻过去了 / 我下去了"，而不是"画面闪了一下"。
 *    各写一套的话，时长、曲线、以及"到底哪一刻才真的切"迟早会走偏
 *    （本项目反复踩过"两边各写一套必然漂移" —— 见 config.js 里 HUD 几何那段注释）。
 *
 * ⚠️ `mid` 放在**中点**、不是起点：要等屏幕黑到看不清了再动手，
 *    否则玩家能看见"人凭空换了个地方"那一下，过渡就白做了。
 * ⚠️ 过渡期间要锁住玩家（调用方设 `p.busyT`）并挡掉其它瞬移入口（各 `useXxx` 里的 `s.fade` 判定），
 *    否则他能在黑屏里再点一次、叠出两个过渡。
 */
function startFade(dur, mid) {
  s.fade = { t: 0, dur, mid, done: false };
}

function banner(title, sub, color, dur) {
  s.banner = { title, sub, color, t: dur, dur };
}

// ---------- 动作反馈粒子（2026-10-01）----------
// 这一组只负责**生成**（往 s.effects 里塞一条记录），画法全在 render.js 的 drawActionFx。
// ⚠️ 三条约定：
//   ① 每次爆发都取一个**新的自增种子** —— 这是粒子的唯一随机源，见 art.js 的 wobble。
//   ② 位置一律用事件发生地的**世界坐标**（粒子跟世界一起被摄像机平移，不是屏幕坐标）。
//   ③ 时长 / 数量 / 颜色全部读 `FX`，这里**不写死任何数值**（和"调参只改 config"一致）。
function nextFxSeed() {
  s.fxSeed = (s.fxSeed + 1) >>> 0;
  return s.fxSeed;
}

/** 挖掘落尘（`big` = 挖到底 / 塌方那种更大的一团扬尘） */
function fxDust(x, y, big = false) {
  const f = big ? FX.burst : FX.dust;
  s.effects.push({ type: big ? 'burst' : 'dust', x, y, t: 0, dur: f.dur, seed: nextFxSeed() });
}

/**
 * 拾取拖尾：从 (fromX, fromY) 飞向主角身上。
 * ⚠️ 终点在**生成时快照**（不是每帧追主角）：飞行只有 0.34 秒，追着人跑会让几粒碎屑
 *    各自拐弯、看着像散架；快照一个终点才有"被吸过去"的整体感。
 */
function fxGather(fromX, fromY) {
  experience?.sound('pickup');
  s.effects.push({
    type: 'gather',
    x: fromX, y: fromY,
    x2: s.player.x, y2: s.player.y - 30,
    t: 0, dur: FX.gather.dur, seed: nextFxSeed(),
  });
}

/** 贴料落位的冲击环（画在**那一格**的中心，让反馈和"我刚放下的位置"对上） */
function fxRing(x, y) {
  s.effects.push({ type: 'ring', x, y, t: 0, dur: FX.ring.dur });
}

function updateCamera() {
  // ⚠️ 2026-10-05：加了 `CAMERA.zoom` —— 相机中心仍然对着人物，但"可视世界宽度"从
  //    `VIEW.w` 变成 `VIEW.w / zoom`（世界被放大 zoom 倍画，见 render.js 的世界变换）。
  //    两边必须用**同一个** zw，否则人物会偏离屏幕中心（而且不报错，只是"人一直偏在一边"）。
  const zw = VIEW.w / CAMERA.zoom;
  s.camera.x = clamp(s.player.x - zw / 2, 0, WORLD.width - zw);
  // ⚠️ 纵向跟随（2026-09-29 用户："人物来到空中的时候，玩家视角也跟着上移，不然一些提示语会挡画面"）。
  //    人物越靠上，画面整体越往下推 —— 取值依据（safeTop 为什么是 350）全在 config 的 CAMERA 注释里。
  //    ⚠️ 只在**高于** safeTop 时才推：地面（570）和跳跃顶点（≈508）都推不到 →
  //       平地走路、原地跳一下的观感**一个像素都不变**。
  // ⚠️ 2026-10-05：`safeTop` 是**屏幕 y**（"人物在屏幕上低于这个高度才不会被横幅挡住"），
  //    而拉近之后同一段世界距离在屏幕上被放大了 zoom 倍 ⇒ 这条要**反解回世界口径**，
  //    否则"什么时候开始推"就变了（不改的话桥上的人会落进横幅那条带里 ✗）。
  //    屏幕 y = (世界 y + 相机 y − 锚点) × zoom + 锚点，令它 = safeTop 即可解出相机 y。
  s.camera.y = Math.max(0,
    (CAMERA.safeTop - CAMERA_ANCHOR_Y) / CAMERA.zoom + CAMERA_ANCHOR_Y - s.player.y);
}

/**
 * 玩家是否在**庇护所的建造范围**内（贴料 / 取下 / 修复 / 仓库 / 合成全靠它把关）。
 * ⚠️ 2026-09-27：**地下不算** —— 地下是另一张地图，庇护所不在那儿（用户问"为什么地下也有庇护所"）。
 *    它是这里唯一的门槛，所以加上这一条就把"在地底下还能贴料/修墙/存取仓库/开合成"
 *    这一整片行为一次性关掉了（和 `render.js` 里收起庇护所+工作台+两块面板的改动配套）。
 */
function inBuildZone() {
  return s.layer !== 'under' && Math.abs(s.player.x - SHELTER.cx) < PLAYER.buildRadius;
}

/**
 * 玩家是否在庇护所范围内。
 * ⚠️ 2026-09-26 取消"安全区"后它**不再意味着安全**：无论在里面还是外面，灾害都会打庇护所；
 *    差别只在主角侧 —— 在里面由庇护所替你挡，在外面庇护所保护不了你，只能靠地形躲。
 * 半径用庇护所自身的 footprint，这样画出来的边界和判定边界完全一致。
 */
function inShelterRange() {
  return Math.abs(s.player.x - SHELTER.cx) <= SHELTER.shelterRange;
}

// ---------- 坐标与命中 ----------

/** 客户端坐标 → 画布内部坐标（画布用 CSS 缩放显示，必须换算） */
function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}

function toWorld(p) {
  // ⚠️ 唯一入口在 config 的 `screenToWorld()` —— 那里是 `render.js` 世界变换的逆运算。
  //    **别在这儿自己写公式**：拉近（zoom）、纵向锚点（CAMERA_ANCHOR_Y）、相机位移三样只要漏一样，
  //    所有点击就会落在"离人物越远偏得越多"的位置上，而且**一行都不报错**
  //    （表现是"点废墟老挖不到 / 贴料贴到隔壁格 / 长按修复没反应"）。
  return screenToWorld(p.x, p.y, s.camera);
}

/** 命中哪一个面（长按修复 / 拖放用，判定放宽以便手指操作） */
function faceAt(canvasPoint) {
  // ⚠️ 2026-09-27：地下没有庇护所，也就没有"墙面"可点。
  //    不在这里挡掉的话，玩家会**在看不见的墙上**短按拆下 / 长按修复（状态真的会变）。
  if (s.layer === 'under') return null;
  const w = toWorld(canvasPoint);
  const pad = 14;
  for (const f of s.shelter.faces) {
    const r = SHAPE[f.id];
    if (!r) continue;
    if (pointInRect(w.x, w.y, { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 })) {
      return f.id;
    }
  }
  return null;
}

/** 拖放目标：仓库图标 / 墙面 / 垃圾桶 / 背包格。 */
function computeDragTarget(pt) {
  if (!s.drag) return null;
  if (pointInRect(pt.x, pt.y, trashRect())) return { kind: 'trash' };
  if (inBuildZone() && pointInRect(pt.x, pt.y, uiLabelRect('storage'))) return { kind: 'store' };
  if (s.drag.from.type === 'store' && pointInRect(pt.x, pt.y, uiLabelRect('bag'))) return { kind: 'bag' };

  // 前景背包不能把拖放穿透给背后的墙面。
  for (let i = 0; !UI_LAYOUT.bag.collapsed && i < BAG_SLOTS; i++) {
    if (pointInRect(pt.x, pt.y, bagSlotRect(i))) return { kind: 'bag', index: i };
  }
  if (!UI_LAYOUT.bag.collapsed && pointInRect(pt.x, pt.y, bagPanelRect())) return null;

  // 1) 拖到墙上 → 自动找该面第一个匹配类别的空位
  const faceId = faceAt(pt);
  if (faceId) {
    const kind = MATERIALS[s.drag.mat].kind;
    if (kind === 'repair') return { kind: 'face', faceId, posIndex: -2 };  // -2 = 这类材料不能贴
    const f = s.shelter.face(faceId);
    const idx = f.positions.findIndex((p) => p.kind === kind && p.mat === null);
    return { kind: 'face', faceId, posIndex: idx };
  }

  return null;
}

// ---------- 丢弃（拖到垃圾桶） ----------

/**
 * 丢掉一件材料：从来源容器里真正删掉（不是掉在地上 —— 掉在地上就等于把背包变成无限暂存）。
 * 留下 3 秒撤销窗口，纯粹用来兜住手滑。
 */
function dropToTrash(d) {
  if (d.from.type === 'bag') {
    const i = s.player.carry.indexOf(d.mat);
    if (i < 0) return;
    s.player.carry.splice(i, 1);
  } else if (!s.shelter.storeRemoveOne(d.mat)) {
    return;
  }

  // ⚠️ 丢掉的可能正是"正在消耗的那一份修复材料"（它用尽前仍留在容器里）。
  //    现在它从容器里没了，消耗进度必须一起清掉 —— 否则 repairOpen 会悬空，
  //    consumeRepair 会一直用它的剩余量、却不扣任何库存，等于免费修复。
  //    但进度本身要存进撤销记录：不然"丢一次再撤销"就等于把已经用掉的修复量白拿回来。
  const open = s.repairOpen && s.repairOpen.matId === d.mat ? s.repairOpen : null;
  if (open) s.repairOpen = null;

  s.trashUndo = { mat: d.mat, from: d.from, t: TRASH_UNDO_SECONDS, open };
  banner('已丢弃', `${MATERIALS[d.mat].name} —— ${TRASH_UNDO_SECONDS} 秒内可撤销`, UI_SKIN.warn, 1.5);
}

/** 撤销上一次丢弃（格位可能已经变了，所以用容器自己的追加 API 放回，不做原位恢复） */
function undoTrash() {
  if (!s.trashUndo) return;
  const { mat, from, open } = s.trashUndo;
  s.trashUndo = null;
  const m = MATERIALS[mat];

  if (from.type === 'bag') {
    if (s.player.isFull) { banner('放不回去了', '背包已经满了', UI_SKIN.warn, 1.8); return; }
    s.player.carry.push(mat);
  } else {
    if (s.shelter.storeSpaceOf(m.kind) <= 0) {
      banner('放不回去了', `${KIND_LABEL[m.kind]}区已经满了`, UI_SKIN.warn, 1.8);
      return;
    }
    s.shelter.storeAdd(mat);
  }
  // 连消耗进度一起恢复：撤销后这份材料还是"用掉了一半的那份"，不会被重新灌满
  if (open && !s.repairOpen) s.repairOpen = open;
  banner('已找回', m.name, UI_SKIN.ok, 1.2);
}

// ---------- 主角受伤、死因与"庇护所没挡住"的提示 ----------

/** 结算面板上的死因文案。key 由 applyPlayerDamage 在**致死那一击**写入 */
const CAUSE_LABEL = {
  monster: '被怪物咬死',
  outside: '被灾害直接打死（死在庇护所外）',
  pierce: '被毒雾打死',
  split: '被雷电／光束打死（墙体与人物分摊伤害）',
  breach: '庇护所被打穿后被打死',
};

/**
 * 对主角造成伤害，并**只在真的打死时**记下死因。
 *
 * ⚠️ 以前是"任何一次 3 点以上的灾害伤害就写死 s._cause"，于是死因记录的是
 *    "第一次挨打"而不是"致死那一击" —— 实测：主角还有 100 血、刚被扣 10.5 时，
 *    死因就已经是"被灾害打死"了。（2026-09-25 用户报告"我明明没死"）
 */
function applyPlayerDamage(n, cause) {
  if (n <= 0 || s.player.dead) return;
  s.player.takeDamage(n);
  experience?.sound('damage');
  if (s.player.dead) s.killedBy = cause;   // 只有这一帧会翻成 dead，所以这必然是致死那一击
}

/**
 * 庇护所**没能挡住**、伤害直接落到主角身上时的提示。
 *
 * 2026-09-26 重构后有两条路径（取代了旧的"击穿/透传"）：
 *   · split   雷电/光束：减伤后按全屋有效高度分配给墙体和人物
 *   · pierce  穿墙类（毒雾）：道具抵消 + 墙属性抵消之后**还剩多少**打主角
 *   · breach  破面类（陨石/龙卷风/地陷/兽潮）：那一面**已经彻底破了**，它那一份全额漏给主角
 *
 * ⚠️ 这两条都没有任何别的反馈 —— 不弹横幅、主角连闪红都不会，
 *    玩家只看到左上角血条在掉（2026-09-25 真实踩过这个坑，见 docs/04）。
 * ⚠️ 只在庇护所外挨打（ev.hitPlayer）不算 —— 那条本来就有"被砸中了"横幅。
 */
function alertLeak(ev) {
  const kind = ev.model;
  s.leakAlert = { t: 1.4, kind, name: ev.name, dmg: ev.playerDamage };   // HUD 常驻红字，每次刷新

  // 横幅只在**每波每种灾害第一次**弹。
  // ⚠️ 不能用"时间节流"：一波里会连续触发十几次，只要节流短于触发间隔，
  //    横幅就会一直占着屏幕，把"材料彻底破损"这类横幅全盖掉。
  const key = `${s.director.wave}:${ev.disaster}`;
  if (s._leakBannerKey === key) return;
  s._leakBannerKey = key;

  if (kind === 'split') {
    banner(`${ev.name}同时伤及墙体和人物`,
      `墙体 -${Math.round(ev.damage)} · 生命 -${Math.round(ev.playerDamage)} · 高级材料护人`,
      UI_SKIN.danger, 3.2);
  } else if (kind === 'pierce') {
    // 把"原始 → 道具抵消 → 墙属性抵消 → 还剩多少"整条账写出来：
    // 这是玩家唯一能自己推出"下一步该去找什么材料"的依据。
    banner(`${ev.name}穿透了庇护所！`,
      `原始 ${ev.raw} → 道具抵消 ${ev.toolBlock} → 墙属性抵消 ${ev.wallBlock}` +
      ` → 还剩 ${Math.round(ev.playerDamage)} 打在你身上`,
      UI_SKIN.danger, 3.2);
  } else {
    const names = ev.brokenFaces.map((id) => s.shelter.face(id).name).join('、');
    banner(`${names}已经彻底破了！`,
      `${ev.name}的伤害直接打在你身上（-${Math.round(ev.playerDamage)}）`,
      UI_SKIN.danger, 3.2);
  }
}

/**
 * "完全拦住"的正反馈（2026-09-26 新增）。
 *
 * ⚠️ 这条**很重要**：用户选的是"悬崖式"手感（抵消 ≥ 伤害就完全免疫）。
 *    如果玩家看不出自己"刚好挡住了"，就会以为伤害只是变小了，
 *    从而永远发现不了"再找好一点的材料就能彻底免伤"这个核心动力。
 */
function noticeBlocked(ev) {
  s.blockAlert = { t: 1.2, name: ev.name };
  const key = `${s.director.wave}:blk:${ev.disaster}`;
  if (s._blockBannerKey === key) return;
  s._blockBannerKey = key;
  banner(`${ev.name}被完全拦住了！`,
    `道具抵消 ${ev.toolBlock} + 墙属性抵消 ${ev.wallBlock} ≥ 原始伤害 ${ev.raw} —— 一点都没打进来`,
    UI_SKIN.ok, 2.6);
}

// ---------- 修复材料（消耗品） ----------

/** 背包 + 仓库里可用的总修复量（含正在消耗那一份的剩余）
 *  ⚠️ 正在消耗的那一份还留在背包/仓库里（等用尽才移除），所以要跳过一次，否则会重复计数。 */
function repairUnitsAvailable() {
  let sum = s.repairOpen ? s.repairOpen.left : 0;
  const skipId = s.repairOpen ? s.repairOpen.matId : null;
  let skipOne = !!skipId;

  const add = (id) => {
    const m = MATERIALS[id];
    if (!m || m.kind !== 'repair') return;
    if (skipOne && id === skipId) { skipOne = false; return; }
    sum += m.repairUnits;
  };
  for (const id of s.player.carry) add(id);
  for (const id of s.shelter.store.repair) add(id);
  return Math.round(sum);
}

/** 找一份修复材料：优先背包，其次仓库（仓库里只可能在 repair 区） */
function findRepairSource() {
  for (const id of s.player.carry) {
    const m = MATERIALS[id];
    if (m && m.kind === 'repair') return id;
  }
  return s.shelter.store.repair[0] || null;
}

/**
 * 扣掉 amount 点修复量。不足就扣多少算多少。
 * 用"当前开着的那一份"记账（repairOpen），这样一份材料不会被浪费掉半截。
 */
function consumeRepair(amount) {
  let need = amount;
  let got = 0;
  let guard = 0;
  while (need > 1e-6 && guard++ < 40) {
    if (!s.repairOpen) {
      const matId = findRepairSource();
      if (!matId) break;                     // 没有修复材料了
      s.repairOpen = { matId, left: MATERIALS[matId].repairUnits };
    }
    const use = Math.min(s.repairOpen.left, need);
    // ⚠️ 不要在这里取整到 0.1：单帧用量小于 0.05 时会被丢掉，
    //    导致"材料在消耗、剩余量却不下降"，于是永远到不了 0、也就永远不会消失。
    s.repairOpen.left -= use;
    need -= use;
    got += use;
    // 余量已经小到没有意义（< 0.05 点）就直接算用尽。
    // 否则会留下一个"剩0"的材料挂在背包/仓库里，玩家会以为它该消失却没消失。
    if (s.repairOpen.left <= 0.05) {
      // 这一份用完了 → 从来源里移除（按 id 找，避免索引因为背包左移而错位）
      const matId = s.repairOpen.matId;
      const idx = s.player.carry.indexOf(matId);
      if (idx >= 0) s.player.carry.splice(idx, 1);
      else s.shelter.storeRemoveOne(matId);
      s.repairOpen = null;
    }
  }
  return got;
}

/** 点到某个料堆上了吗 */
function lootAt(pt) {
  const w = toWorld(pt);
  for (const spot of s.world.loot) {
    if (!spot.available) continue;
    if (pointInRect(w.x, w.y, { x: spot.x - 38, y: spot.y - 40, w: 76, h: 62 })) return spot;
  }
  return null;
}

// ---------- 挖掘 ----------

function doDig(spot) {
  const p = s.player;
  // 上升中不能挖：人已经在半空，挖了会留下一堆悬空的暂存（2026-09-27）
  if (p.dead || p.isLifting) return;
  if (!atSpot(spot, p.x, p.y)) {
    banner('离废墟太远', '靠近废墟后再点击', UI_SKIN.warn, 1.6);
    return;
  }

  // ⚠️⚠️ 2026-09-26 修：原来这里是 `if (p.dead || p.isStunned || p.isBusy) return;` ——
  //    硬直期间**静默丢弃点击**，什么都不发生、也没有任何提示。
  //    而每次挖掘要 tapSeconds(1.0s) 的硬直，手机上正常速度连点必然有一大半落在硬直里被吃掉。
  //    玩家看到的就是"我点了想让他挖，他却不挖 / 跑去别的地方了"，而"点击 = 挖掘"是这个
  //    游戏的核心动作（"挖矿要多点一下，点的越多越稀有"），被吃掉等于核心循环是坏的。
  //    改成**输入缓冲**：硬直期间把点击记下来，硬直一结束立刻补上（最多补 3 下，不会排成长队）。
  if (p.isStunned) {
    // 被塌方埋住是真的挖不了 —— 但必须给反馈，不能静默什么都不做
    banner('被塌方埋住了', '等余震过去再挖', UI_SKIN.warn, 1.4);
    return;
  }

  // ⚠️⚠️ 2026-09-29（用户报 bug + 定案"背包满时干脆不让挖"）：**带不走的就不给挖**。
  //    判定必须是 `背包已装 + 这一堆的暂存 >= 背包容量`，**不能只看 `player.isFull`**：
  //    暂存是"挖完、走开"才进背包的，所以背包在挖的过程中并不会变满 ——
  //    实测 `背包 10/12` 时连挖 5 层（暂存 5）→ 离开时只收得下 2 件、**另 3 件被删掉**，
  //    而全程 `isFull` 都是 false。只看 `isFull` 的闸门拦不住这一类（这正是用户报的 bug）。
  //    ⚠️ 位置必须在 `isBusy` 缓冲**之前**：否则连点会被缓冲下来、1 秒后才报"满了"，说不清。
  //    ⚠️ 和 `collectPending` 的"绝不删料"是**一对**：这里挡住"装不下的那一次挖掘"，
  //       那里挡住"万一还是装不下"。两层都要有 —— 丢掉的料是找不回来的。
  if (p.carry.length + spot.pending.length >= BAG_SLOTS) {
    const free = BAG_SLOTS - p.carry.length;
    if (p.isFull) {
      banner('背包满了', `先腾出位置（回庇护所存进仓库）再来挖 —— 这一堆还压着 ${spot.pending.length} 件`, UI_SKIN.warn, 2.2);
    } else {
      banner('带不走了', `背包只剩 ${free} 格、这一堆还压着 ${spot.pending.length} 件 —— 走开收走之后才能接着挖`, UI_SKIN.warn, 2.2);
    }
    return;
  }

  if (p.isBusy) {
    if (!s.pendingDig || s.pendingDig.spot !== spot) s.pendingDig = { spot, n: 0 };
    s.pendingDig.n = Math.min(3, s.pendingDig.n + 1);
    return;
  }

  const res = s.world.digOnce(spot);
  // 保留第一波首次成功掉落的装配保底，教学也使用同一采集动作。
  if (res.ok && !res.caveIn && s.director.wave === 1 && !s.tutorialGiven) {
    res.mat = 't1_hard';
    spot.pending[spot.pending.length - 1] = res.mat;
    s.tutorialGiven = true;
  }
  if (res.ok && !res.caveIn) experience?.sound('dig');
  // ⚠️ 2026-09-29：**挖到料也算"已经出门"**（用户方案里的兜底那一条）。
  //    为什么要有它：准备期现在要等玩家离开庇护所才计时，所以"能不能在庇护所范围里挖到料"
  //    就变成了规则的命门。生成侧已经用 `SHELTER.nearClear`(240) 挡了一道（实测最近的料堆
  //    离中心 ≥240，而站在 160 的边界上够不着）—— 这条是**第二道闸**：万一将来有人改生成逻辑
  //    破坏那个约束，规则也不会被白嫖。
  //    ⚠️ 幂等且无害：不在准备期 / 已经解冻时，releasePrep() 什么都不做。
  if (res.ok) s.director.releasePrep();
  if (!res.ok) {
    if (res.reason === 'bottom') {
      banner(spot.depleted ? '这个废墟已经挖空了' : '已经挖到底了',
        `暂存 ${spot.pending.length} 件`,
        UI_SKIN.warn, 1.6);
      return;
    }
  }

  p.busyT = DIG.tapSeconds;   // 每次挖掘要花时间 —— 这是"多点几下"的代价
  p.digT = DIG.tapSeconds;    // 同一秒里播"挖"那条动画（见 player.js 的 digT）
  p.targetX = null;

  if (res.caveIn) {
    experience?.sound('collapse');
    // ⚠️⚠️ 2026-10-05（用户报："塌了以后才开始挖"）：塌方要**把这次挖掘的"忙"清掉**。
    //    根因：`stun()` 让 `player.update` 提前 return（`stunT` 那一支排在 `busyT` 之前），
    //    于是 `busyT` / `digT` **整个 1.5 秒晕眩里一个都不减** —— 渲染就一直停在"挖"的第 0 帧
    //    （那帧是**站姿**），等晕完才开始播那 1 秒挖地 → 玩家看到的就是
    //    "废墟塌了、人愣了 1.5 秒，然后才开始挖"。
    //    语义上也对：这次挖掘**被塌方打断了**，它的时间代价由"被埋"接管，不该叠加。
    p.busyT = 0;
    p.digT = 0;
    p.stun(LOOT_RULES.caveInStun);
    s.shake = 0.35;
    // 塌方：屏抖之外再给一团大扬尘 —— 屏抖是"晕"，扬尘才是"这堆真的塌了"
    fxDust(spot.x, spot.y - 6, true);
    banner('塌了！', `${res.lost} 块材料全埋在里面`, UI_SKIN.warn, 2.4);
    return;
  }

  const zone = s.world.zoneOf(spot.zone);
  const m = MATERIALS[res.mat];
  const ruin = RUIN_TYPES[spot.type];
  // 层数不对玩家显示（用户要求），只报材料名和下一步的塌方风险。
  // atBottom 用**这个料堆自己的** maxDepth（每个堆 4~7 层是随机的），不是全局上限。
  const atBottom = res.depth >= spot.maxDepth;
  const nextChance = caveInChance(zone, res.depth + 1, spot.type, s.layer);

  // 动作反馈：每挖一下溅几粒碎屑；挖到底那一下给更大的一团
  // （挖掘是全局最高频动作，这一下之前是**零物理反馈**的）
  fxDust(spot.x, spot.y - 6, atBottom);

  let title = `挖到 ${m.name}`;
  let sub = atBottom
    ? `暂存 ${spot.pending.length} 件 · ${spot.depleted ? '已挖空' : '本轮已挖完'}`
    : ruin.caveIn
      ? `暂存 ${spot.pending.length} 件 · 再挖一层塌方风险 ${Math.round(nextChance * 100)}%`
      : `暂存 ${spot.pending.length} 件 · 这个废墟不会塌`;
  let color = UI_SKIN.ok;

  // "引怪"型废墟：这次挖掘发出声响，把附近的怪物拉过来
  if (res.lure) {
    const n = s.monsters.attract(spot.x, LURE.radius);
    if (n > 0) {
      title = `挖到 ${m.name} · 引来 ${n} 只怪物！`;
      sub = '声响把它们吸引过来了 —— 但走开就保不住挖掘进度';
      color = UI_SKIN.danger;
    } else {
      // ⚠️ n = 0 时**必须明说**：否则这条横幅和普通挖掘**一模一样**（绿字、只写挖到啥），
      //    玩家分不清"怪离得远"和"引怪机制坏了"。实测约 1/5 引不到
      //    （地面 89.4% / 地下 68.2% 真能引到；地下低是因为怪只在最外两段）。
      //    用琥珀色而不是红色：**没招来怪不是坏事**，只是这条机制这次没触发。
      sub = `暂存 ${spot.pending.length} 件 · 附近没有怪物听到`;
      color = UI_SKIN.warn;
    }
  }
  banner(title, sub, color, res.lure ? 2.0 : 1.5);
}

/**
 * 把某料堆脚下的暂存收进背包。
 *
 * ⚠️⚠️ 2026-09-29（用户报 bug）：**绝不删料** —— 装不下的留在原地，并返回 false。
 *    原来这里是 `spot.pending = []`（一颗不留地清空）+ 调用方照样把废墟销掉，于是：
 *    实测 `背包 12/12、暂存 2 件` → 走开时 2 件**全部消失**、废墟也没了，
 *    而横幅写的是"2 块材料丢在原地"（**假话**，它们不在原地，是被删了）。
 *    现在装不下的连同"废墟不销掉"一起留着 —— 玩家腾出背包位置走回来还能拿。
 *    ⚠️ 正常情况下这条兜底**到不了**：`doDig` 的容量闸门（`背包 + 暂存 >= BAG_SLOTS` 就不给挖）
 *       已经保证离开时一定放得下。但丢料是不可逆的，所以这一层必须留着。
 * @returns {boolean} 这一堆是否已经**全部**收走（false = 还有料留在原地，废墟别销）
 */
function collectPending(spot) {
  if (!spot || !spot.pending.length) return true;
  const left = [];
  let taken = 0;
  for (const mat of spot.pending) {
    if (s.player.pick(mat)) taken += 1; else left.push(mat);
  }
  spot.pending = left;
  // 拾取拖尾：真的收走东西时才放（`taken === 0` 时画一串"飞向玩家"的碎屑会是假反馈）
  if (taken) fxGather(spot.x, spot.y - 6);
  if (!left.length) {
    banner('收走暂存', `${taken} 件进背包`, UI_SKIN.ok, 1.5);
  } else if (taken) {
    banner('收走暂存', `${taken} 件进背包 · ${left.length} 件还压在原地 —— 腾出位置回来还能拿`, UI_SKIN.warn, 2.2);
  } else {
    banner('背包满了', `${left.length} 件还压在原地 —— 腾出位置回来还能拿`, UI_SKIN.warn, 2.2);
  }
  return left.length === 0;
}

// ---------- 地穴入口：地面 ↔ 地下（2026-09-27 第四轮，分层世界）----------

/** 点到本层的出入口了吗。返回入口对象或 null */
function entranceAt(pt) {
  const w = toWorld(pt);
  for (const e of entrances()) {
    const gy = terrainY(e.x);
    if (pointInRect(w.x, w.y, { x: e.x - 44, y: gy - 100, w: 88, h: 110 })) return e;
  }
  return null;
}

/**
 * 下地穴 / 回地面。
 *
 * ⚠️ **只在准备期能用**：灾害期入口关闭。这条不只是"设定" ——
 *    它解决了一个真问题：如果灾害期能躲进地下，那整个灾害期的压力就没意义了。
 *    （顺带也保证了"地下的玩家不会挨灾害"这件事自动成立 —— 那时他不可能在地下。）
 *
 * ⚠️ 切层时要把**一切"基于旧层"的待办清掉**（走路目标 / 待挖的料 / 连点缓冲），
 *    否则人物会朝旧层的一个坐标跑过去。这和隧道传送是同一类问题。
 *
 * ⚠️ 2026-10-01：**整个切换动作挪进了过渡的中点**（`startFade`）。
 *    原来这里是"点一下、一帧内整个人换到另一张地图" —— 玩家看到的是画面闪了一下，
 *    分不清是自己卡了还是游戏换了场景。现在先渐黑、黑透了才换、再渐亮。
 *    ⚠️ 注意 `mid` 里的**顺序一个字都没改**（切指针 → 放人 → 收暂存 → 重置小地图 → 相机），
 *       只是整段延后到中点执行 —— 顺序里那些依赖关系（"先切指针再放人"）全都在注释里钉着。
 */
function useEntrance(e) {
  const p = s.player;
  if (p.dead || p.isLifting || s.fade) return;
  if (!atSpot({ x: e.x, y: terrainY(e.x) }, p.x, p.y)) {
    banner('离入口太远', '走到入口跟前再点它', UI_SKIN.warn, 1.6);
    return;
  }
  if (s.director.phase !== Phase.PREP) {
    banner('现在不能下去', '灾害期地穴会塌 —— 等这一波过去', UI_SKIN.warn, 1.8);
    return;
  }
  const goingUnder = s.layer === 'ground';

  // 过渡期间锁住玩家：否则他能在黑屏里走两步、或再点一次地穴口
  p.busyT = LAYER_FADE;
  p.targetX = null;

  startFade(LAYER_FADE, () => {
    // ① 切层（**先切指针再放人**：下面 terrainY 必须读新层的地形）
    switchLayer(goingUnder ? 'under' : 'ground');

    // ② 落到出口处 + 重新贴地（两层地面高度不同，不重贴会悬空/埋土）
    p.x = e.x;
    p.y = terrainY(e.x);
    p.vy = 0;
    p.onGround = true;
    p.targetX = null;
    s.approachSpot = null;
    s.approachBreak = null;
    s.pendingDig = null;
    s.pendingBreak = null;
    // ⚠️ 2026-09-29（用户报 bug）：**换层之前必须先把暂存收走** ——
    //    原来这里是直接 `s.nearSpot = null`，于是"挖完直接下地穴"会把脚下的暂存料**凭空弄丢**
    //    （而且没有任何提示：`collectPending` 根本没被调到）。两层的地图各自独立、不会因为切层重建，
    //    所以收不下的部分留在原地也没关系 —— 回到这一层还能拿（见 collectPending 的兜底）。
    collectPending(s.nearSpot);
    s.nearSpot = null;
    s.explored = { min: 1e9, max: -1e9 };   // 新的一层 → 小地图重新点亮（那是另一张地图）
    updateCamera();
  });

  banner(goingUnder ? '下到地下' : '回到地面',
    goingUnder
      // ⚠️ 这句必须跟着 `UNDERWORLD` 的机制一起改：2026-09-28 地下从"用极深区的表 + bonus 6"
      //    改成"统一深区待遇 + bonus 0"，旧文案（"料都是最高档、后翻 6 张"）就不再是真话了。
      //    （横幅是 canvas `fillText` 画的，别在这里写 Markdown —— `**` 会原样显示成星号。）
      ? '更暗、怪更凶，但处处都是深区档次的料、不用跑远 —— 灾害期会被震回地面'
      : '回到地面了',
    goingUnder ? UI_SKIN.kindFunc : UI_SKIN.ok, 2.8);
}

// ---------- 隧道：近区 ↔ 极深区的捷径（2026-09-27 新增）----------

/** 点到某个隧道洞口了吗（世界坐标）。返回 { t, end } 或 null */
function tunnelAt(pt) {
  const w = toWorld(pt);
  for (const t of TUNNELS.list) {
    for (const end of ['a', 'b']) {
      const p = t[end];
      const gy = terrainY(p.x);
      const pad = TUNNELS.hitPad;
      if (pointInRect(w.x, w.y, { x: p.x - TUNNELS.w / 2 - pad, y: gy - TUNNELS.h - pad,
        w: TUNNELS.w + pad * 2, h: TUNNELS.h + pad * 2 })) return { t, end };
    }
  }
  return null;
}

/**
 * 走隧道：1.5 秒过渡（渐黑 → 传送到另一端 → 渐亮）。
 *
 * ⚠️ 期间**不能动**（`busyT` 占住），而且**不是瞬间闪现** —— 瞬间跳会让玩家彻底失去方位感
 *    （"我怎么到这儿了"），有个黑场才像"钻进地下又从另一头出来"。
 * ⚠️ 另一端的地面高度可能完全不同（每波地形不一样）→ 传送时必须重新贴地、并清掉一切
 *    "基于旧位置"的待办（走路目标 / 待挖的料堆 / 缓存的连点）。
 * ⚠️ 2026-10-01：改成走**通用的 `startFade`**（和地穴口换层共用一套）——
 *    原来它自己存 `{ t, dur, to, moved }`、传送逻辑写死在 step 里，
 *    而地穴口换层另写一份（还是"不过渡"的版本）。现在两者都只说一件事：
 *    "黑透的时候做这个动作"。
 */
function useTunnel(hit) {
  const p = s.player;
  if (p.dead || p.isLifting || s.fade) return;
  const { t, end } = hit;
  if (!atSpot({ x: t[end].x, y: terrainY(t[end].x) }, p.x, p.y)) {
    banner('离洞口太远', '走到洞口跟前再点它', UI_SKIN.warn, 1.6);
    return;
  }
  const other = end === 'a' ? 'b' : 'a';
  const toX = t[other].x;
  p.busyT = TUNNELS.transition;
  p.targetX = null;

  startFade(TUNNELS.transition, () => {
    p.x = toX;
    p.y = terrainY(toX);   // ⚠️ 另一端的地面高度可能完全不同 → 必须重新贴地
    p.vy = 0;
    p.onGround = true;
    // 清掉一切"基于旧位置"的待办，否则传送后人物会朝旧目标跑、或去挖一个很远的料堆
    s.approachSpot = null;
    s.approachBreak = null;
    s.pendingDig = null;
    s.pendingBreak = null;
    updateCamera();
  });

  banner('钻进隧道…',
    end === 'a' ? '这条通道直通极深区外围' : '这条通道直通庇护所附近',
    UI_SKIN.info, TUNNELS.transition);
}

// ---------- 隐藏区：碎石堆（2026-09-27 新增）----------

/** 点到某个还没打开的碎石堆了吗（世界坐标命中；判定比画出来略大，方便手指点） */
function hiddenAt(pt) {
  const w = toWorld(pt);
  for (const h of s.world.hidden || []) {
    if (h.opened) continue;
    const r = {
      x: h.x - HIDDEN.w / 2 - 6,
      y: h.y - HIDDEN.h + 14 - 6,
      w: HIDDEN.w + 12,
      h: HIDDEN.h + 12,
    };
    if (pointInRect(w.x, w.y, r)) return h;
  }
  return null;
}

/**
 * 挖开碎石堆（隐藏区）。
 * **不新增操作**：就是"点一下、挖几下" —— 和挖废墟同一套手感，只是每次挖掉的是碎石。
 * 每下占一个挖掘硬直（`DIG.tapSeconds`），这是它唯一的代价（找到了还得花时间）。
 * 挖开后 `openHidden` 会在原地生成一个**富料堆**（掉落表后翻 `HIDDEN.tableBonus` 张）。
 */
function doBreak(hid) {
  const p = s.player;
  if (p.dead || p.isLifting || hid.opened) return;
  if (!atSpot(hid, p.x, p.y)) {
    banner('离碎石堆太远', '靠近碎石堆后再点击', UI_SKIN.warn, 1.6);
    return;
  }
  if (p.isStunned) { banner('被塌方埋住了', '等余震过去再挖', UI_SKIN.warn, 1.4); return; }
  if (p.isBusy) {
    // ⚠️ 和挖掘一样：硬直期间的连点要**缓冲**，不能静默吃掉（这是挖废墟那轮踩过的坑）
    if (!s.pendingBreak || s.pendingBreak.hid !== hid) s.pendingBreak = { hid, n: 0 };
    s.pendingBreak.n = Math.min(3, s.pendingBreak.n + 1);
    return;
  }
  p.busyT = DIG.tapSeconds;
  p.digT = DIG.tapSeconds;    // 挖碎石堆也播同一套（硬直时长一样，都是 tapSeconds）
  p.targetX = null;
  hid.power -= 1;
  s.shake = 0.12;
  // 敲碎石和挖废墟是同一个动作的两种形态 → 反馈保持一致（最后一下敲开给大的一团）
  fxDust(hid.x, hid.y - 10, hid.power <= 0);

  if (hid.power > 0) {
    banner('敲开碎石', `再挖 ${hid.power} 下`, UI_SKIN.warn, 1.3);
    return;
  }
  const spot = s.world.openHidden(hid);
  if (spot) {
    banner('挖开了一个洞口！', `里面那堆料更好（掉落表后翻 ${HIDDEN.tableBonus} 张）—— 点它继续挖`, UI_SKIN.ok, 3.0);
  }
}

// ---------- 动作 ----------

/** 把材料贴到面上（来源可能是背包，也可能是仓库） */
function dropOnFace(d, faceId) {
  if (!inBuildZone()) {
    banner('太远了', '要靠近庇护所才能往墙上贴材料', UI_SKIN.warn, 1.5);
    return;
  }
  const source = d.from.type === 'bag' ? s.player.carry[d.from.index] : s.shelter.storeAtFlat(d.from.index);
  if (source !== d.mat) return;
  const res = s.shelter.applyMaterial(faceId, d.mat);
  if (!res.ok) {
    banner(res.reason === 'struct_full' ? '补漏位满了' : '插槽位满了',
      '先点掉一个位置上的材料，或者贴到别的面', UI_SKIN.warn, 1.6);
    return;
  }
  // 从来源移除（按 id 找，避免索引错位）
  if (d.from.type === 'bag') s.player.carry.splice(d.from.index, 1);
  else s.shelter.storeRemoveOne(d.mat);
  experience?.sound('install');
  const f = s.shelter.face(faceId);
  const m = MATERIALS[d.mat];
  // 落位反馈：冲击环画在**刚填上的那一格**中心（不是整面墙的中心）——
  // 反馈必须和"我拖到的地方"对上，否则一圈环画在墙中央、而料在角落，看着像没生效。
  const slot = facePositionRects(faceId, f.structSlots, f.funcSlots)[res.posIndex];
  if (slot) fxRing(slot.x + slot.w / 2, slot.y + slot.h / 2);
  const kindTxt = m.kind === 'struct' ? '补漏位' : '插槽位';
  banner(`补上 ${f.name} · ${kindTxt}`,
    m.kind === 'struct'
      ? `血量 +${res.addedHp} · 强度 ${m.strength} 重量 ${m.weight} 绝缘 ${m.insulation}`
      : (m.blockTool
        ? `抵消「${DISASTERS[m.blockTool].name}」${m.blockValue} 点 · 重量 ${m.weight}`
        : `不提供血量 · 强度 ${m.strength} 重量 ${m.weight} 绝缘 ${m.insulation}`),
    UI_SKIN.ok, 1.9);
}

/**
 * 把 1 个"扩展空位"额度花在这一面（2026-09-26 用户要求）。
 *
 * ⚠️ 扩完之后该面**插槽位的下标会整体 +1**（shelter.expandFace 会把两类位置拆开重拼），
 *    所以必须清掉手上缓存的 posIndex —— 否则拖拽/按压的目标会有一帧指到错的格子上。
 */
function doExpandFace(faceId) {
  if (!inBuildZone()) {
    banner('太远了', '要靠近庇护所才能扩容', UI_SKIN.warn, 1.5);
    return;
  }
  if (!s.shelter.expandFace(faceId)) return;
  s.press = null;
  s.dragTarget = null;
  const f = s.shelter.face(faceId);
  const left = s.shelter.bonusSlots;
  banner('空位 +1', left > 0
    ? `${f.name} 的补漏位扩到 ${f.structSlots} 个 · 还剩 ${left} 个待放`
    : `${f.name} 的补漏位扩到 ${f.structSlots} 个 · 额度已用完`,
  UI_SKIN.ok, 2.0);
}

/** 点到了某个面上的「+」扩展位？返回 faceId 或 null */
function expandSlotAt(w) {
  if (s.shelter.bonusSlots <= 0) return null;
  for (const f of s.shelter.faces) {
    const r = expandSlotRect(f.id, f.structSlots, f.funcSlots);
    if (r && pointInRect(w.x, w.y, r)) return f.id;
  }
  return null;
}

function pickPatchBack(faceId, posIndex) {
  const p = s.player;
  if (!inBuildZone()) {
    banner('太远了', '要靠近庇护所才能拆材料', UI_SKIN.warn, 1.5);
    return;
  }
  const pos = s.shelter.face(faceId).positions[posIndex];
  if (!pos || !pos.mat) return;
  const m = MATERIALS[pos.mat];

  // 结构件（2026-09-26 用户要求）：**完好**（没挨过打）才能取回背包；
  // 破损的取下即消失 —— 想拿回来必须先用修复材料长按修满。
  // ⚠️ 这条规则在画面上是**看不出来**的（掉 5% 耐久时颜色和完好一样），
  //    所以 render 会给"挨过打但还没裂"的结构件画一个标记，文案也必须说清"怎么才能取回"。
  if (m.kind === 'struct' && !s.shelter.canRecoverAt(faceId, posIndex)) {
    s.removeConfirm = { faceId, posIndex, mat: pos.mat, at: performance.now() };
    return;
  }

  // 走到这里都能回收（完好的结构件 + 所有功能件），两种情况都要先看背包够不够
  if (p.isFull) {
    banner('背包满了', '先贴掉一件再来拆', UI_SKIN.warn, 1.5);
    return;
  }
  // 用 removeAt 的返回值，不要从材料对象上取字段
  // （曾写成 m.mat，但材料对象的字段名是 id，于是 push(undefined) 塞进背包、下一帧渲染直接崩）
  const mid = s.shelter.removeAt(faceId, posIndex);
  if (!mid) return;
  p.carry.push(mid);
  banner(m.kind === 'struct' ? '取回结构件' : '拆下功能件', `${m.name} 回到背包`, UI_SKIN.info, 1.2);
}

// ---------- 合成（2026-09-27 用户选定：庇护所工作台 + 后台 30 秒倒计时）----------

/**
 * 重算候选列表：背包 + 仓库里所有**结构材料**，按 id 去重并记数量。
 *
 * ⚠️ 缓存进 `s.synthOptions`，而不是每次渲染现算 —— 渲染和指针命中必须用**同一份顺序**，
 *    否则"点到的格子"和"看到的格子"会错位（和"几何只定义一次"是同一个道理）。
 * ⚠️ 只收 `kind === 'struct'`：功能件（道具）和修复材料**不能合成**（用户规则）。
 */
function refreshSynthOptions() {
  const order = [];
  const count = new Map();
  const add = (id) => {
    const m = MATERIALS[id];
    if (!m || m.kind !== 'struct') return;
    if (!count.has(id)) { count.set(id, 0); order.push(id); }
    count.set(id, count.get(id) + 1);
  };
  for (const id of s.player.carry) add(id);
  for (const id of s.shelter.store.struct) add(id);
  // 稳定排序：先按档次、再按 id —— 玩家一眼能找到自己要的那档
  order.sort((a, b) => (MATERIALS[a].tier - MATERIALS[b].tier) || (a < b ? -1 : 1));
  s.synthOptions = order.map((id) => ({ id, count: count.get(id) }));
}

/** 两个槽里已经选了几件 id（用来把候选格的数量显示成"还剩几件"） */
function synthSlotsUsed(id) {
  const p = s.synthPanel;
  if (!p) return 0;
  return (p.slotA === id ? 1 : 0) + (p.slotB === id ? 1 : 0);
}

function openSynthPanel(bench) {
  refreshSynthOptions();
  s.synthPanel = { bench, slotA: null, slotB: null, scrollY: 0 };
  s.banner = null;
}

/** 点候选格 → 放进第一个空槽。要取下来就点槽位本身（见 synthPanelHit） */
function synthPickOption(id) {
  const p = s.synthPanel;
  if (!p) return;
  if (!p.slotA) { p.slotA = id; return; }
  if (!p.slotB) { p.slotB = id; return; }
  banner('两个槽都满了', '点槽里的材料可以取下来', UI_SKIN.warn, 1.4);
}

/**
 * 启动合成：**先把两件材料从容器里扣掉**（投料），再开倒计时。
 *
 * ⚠️ 扣之前必须校验"容器里真的有这两件"：两槽可以是**同一种材料**（同 id 要两件），
 *    而且面板打开期间容器内容仍可能变化 —— 不校验就会出现"扣不到却已经开始合成"。
 * ⚠️ 产物只可能在**做完那一刻**落袋（见 finishSynth），所以中途被打穿 = 真的没了（用户要的风险感）。
 */
function startSynth() {
  const p = s.synthPanel;
  if (!p || !p.slotA || !p.slotB) return;
  if (!inBuildZone()) { banner('太远了', '要靠近工作台才能启动合成', UI_SKIN.warn, 1.6); return; }
  // ⚠️ 从面板上记的台子号取（不是固定第 1 个）—— 两个台子各自独立，可以同时在做两件。
  const wb = s.workbenches[p.bench];
  if (!wb) { s.synthPanel = null; return; }
  if (wb.busy) { banner('这个台子正在用', '换个台子，或者等它做完', UI_SKIN.warn, 1.6); return; }

  const a = p.slotA;
  const b = p.slotB;
  const need = new Map();
  need.set(a, (need.get(a) || 0) + 1);
  need.set(b, (need.get(b) || 0) + 1);
  const countIn = (arr, id) => arr.filter((x) => x === id).length;
  for (const [id, n] of need) {
    const total = countIn(s.player.carry, id) + countIn(s.shelter.store.struct, id);
    if (total < n) {
      banner('材料不够了', `${MATERIALS[id].name} 只剩 ${total} 件 —— 重选两件`, UI_SKIN.warn, 2.2);
      s.synthPanel = { bench: p.bench, slotA: null, slotB: null };
      return;
    }
  }

  const res = wb.start(a, b);
  if (!res.ok) {
    banner('这两件合不了',
      res.reason === 'no_recipe'
        ? `${MATERIALS[a].name} + ${MATERIALS[b].name} 不在配方表里 —— 只有特定组合能合成`
        : '这个组合不能合成',
      UI_SKIN.warn, 2.4);
    return;
  }

  // 投料：先扣背包、再扣仓库（按 id 找，避免索引因背包左移而错位）
  for (const [id, n] of need) {
    for (let k = 0; k < n; k++) {
      const i = s.player.carry.indexOf(id);
      if (i >= 0) s.player.carry.splice(i, 1);
      else s.shelter.storeRemoveOne(id);
    }
  }
  s.synthPanel = null;
  const tag = s.workbenches.length > 1 ? `台子 ${p.bench + 1} · ` : '';
  banner('合成开始',
    `${tag}${MATERIALS[a].name} + ${MATERIALS[b].name} · ${SYNTH.seconds} 秒后出结果（可以走开干别的，但房子被打穿就全毁）`,
    UI_SKIN.info, 3.0);
}

/**
 * 这件材料还有地方放吗（先背包、再仓库）。
 * ⚠️ 2026-09-29 起"取货"要先问这个 —— 放不下时**产物留在台子上**，不能丢（用户要求）。
 */
function hasRoomFor(matId) {
  return !s.player.isFull || s.shelter.storeSpaceOf(MATERIALS[matId].kind) > 0;
}

/**
 * 从工作台取货：优先背包 → 其次仓库 → **都满了就留在台子上**。
 *
 * ⚠️ 2026-09-29（用户要求）：合成产物**不再直接落袋**了，先暂存在台子上，玩家点台子才收。
 *    这个函数就是"收"的那一步（由 `tapWorkbench` 起了 `s.synthTake` 动画、动画播完才调它）。
 * ⚠️ 放不下时**绝不能丢**（用户明确："如果仓库满了点击工作台时就提醒玩家"）——
 *    所以失败时什么都不做、产物继续留在台子上，只提醒玩家去腾位置。
 * ⚠️ 有了"动画完才入袋"这一步之后，这里多一个新前提：**动画期间台子可能被打穿**
 *    （产物被 `collapse()` 清掉）→ 那时 `wb.product` 已经是 null，静默返回即可
 *    （"台子被打穿"那条横幅已经报过了，这里再报一次只会打架）。
 * @returns {boolean} 是否真的收走了
 */
function takeFromBench(bench) {
  const wb = s.workbenches[bench];
  if (!wb || !wb.product) return false;
  const prod = wb.product;
  const m = MATERIALS[prod.mat];
  const title = (prod.success ? '收好了 · ' : '收好了（次品）· ') + m.name;
  // 入袋反馈：从台面飞向主角（"东西进兜了"这一下之前只有一行字）
  const br = workbenchRect(bench);
  if (!s.player.isFull) {
    s.player.pick(prod.mat);
    wb.product = null;
    fxGather(br.x + br.w / 2, br.y);
    banner(title, '放进背包', UI_SKIN.ok, 2.6);
    return true;
  }
  if (s.shelter.storeSpaceOf(m.kind) > 0) {
    s.shelter.storeAdd(prod.mat);
    wb.product = null;
    fxGather(br.x + br.w / 2, br.y);
    banner(title, '背包满了，放进仓库', UI_SKIN.ok, 2.6);
    return true;
  }
  banner('拿不了 —— 没地方放', `${m.name} 还留在工作台上 · 先腾出背包或仓库的位置`, UI_SKIN.warn, 3.2);
  return false;
}

/** 合成结算：成功 / 降级（次X级）/ 彻底报废 —— 三种结果都必须让玩家看得清清楚楚 */
function finishSynth(res, bench, benchCount) {
  experience?.sound(res.success ? 'synth' : 'warning');
  const na = MATERIALS[res.recipe.a].name;
  const nb = MATERIALS[res.recipe.b].name;
  // 多个台子时带上编号：两份活同时在跑，不说清楚玩家不知道是哪一份出结果了
  const tag = benchCount > 1 ? `台子 ${bench + 1} · ` : '';
  if (res.scrap) {
    banner(`合成失败 · ${tag}报废了`, `${na} + ${nb} 全毁 —— 这种损失不可逆`, UI_SKIN.danger, 3.4);
    return;
  }
  const m = MATERIALS[res.mat];
  // ⚠️ 2026-09-29（用户要求）：产物**不再直接落袋**，而是留在台子上等玩家来取。
  //    真正入袋发生在 `takeFromBench()`（`tapWorkbench` 起了 s.synthTake 动画、播完才调）。
  //    ⚠️ 所以这里必须**说清"东西在台子上、去哪取"** —— 否则玩家会以为合成把材料吞了。
  if (res.success) {
    banner(`合成成功 · ${m.name}`, `${tag}做好了，就放在台子上 —— 走到工作台点一下收走`, UI_SKIN.ok, 4.0);
  } else {
    banner('合成失败 · 出了次品',
      `${tag}${na} + ${nb} → ${m.name}（高一档，但不是目标那一档）· 放在台子上，去取`,
      UI_SKIN.warn, 4.0);
  }
}

/**
 * 合成面板的指针命中（**屏幕坐标**）。返回 true = 这一下被面板吃掉了。
 * ⚠️ 面板打开时**优先接管所有点击**，点在面板外就关掉面板 —— 否则玩家会误触到
 *    世界里的料堆/墙面（面板盖着半个屏幕，误触一次就多走一段路）。
 */
function synthPanelHit(pt) {
  const p = s.synthPanel;
  if (!p) return false;

  if (pointInRect(pt.x, pt.y, synthCloseRect())) { s.synthPanel = null; return true; }

  // 点投入槽 → 把那件取下来
  for (let i = 0; i < 2; i++) {
    if (!pointInRect(pt.x, pt.y, synthSlotRect(i))) continue;
    p[i === 0 ? 'slotA' : 'slotB'] = null;
    return true;
  }

  // 点候选材料 → 放进第一个空槽
  const opts = s.synthOptions;
  const scroll = synthScrollGeometry(opts.length, p.scrollY);
  for (let i = 0; i < opts.length && pointInRect(pt.x, pt.y, scroll.view); i++) {
    const o = opts[i];
    if (pointInRect(pt.x, pt.y, synthOptionRect(i, scroll.offset))) {
      if (o.count > synthSlotsUsed(o.id)) synthPickOption(o.id);
      return true;
    }
  }

  if (pointInRect(pt.x, pt.y, synthStartRect())) { startSynth(); return true; }

  // 面板范围内的空白也吃掉（不要穿透到世界）
  return pointInRect(pt.x, pt.y, synthPanelRect());
}

/** 点第 i 号工作台：**必须靠近**才能启动（这是文档 7.2 的"往返成本"），在做就直接报进度 */
function tapWorkbench(bench) {
  const r = workbenchRect(bench);
  if (!inBuildZone() || Math.abs(s.player.x - r.x - r.w / 2) >= PLAYER.buildRadius
      || Math.abs(s.player.y - r.y - r.h) >= PLAYER.digVertTol) {
    banner('太远了', '要走到工作台前面才能启动合成', UI_SKIN.warn, 1.6);
    return;
  }
  const wb = s.workbenches[bench];
  if (!wb) return;
  // 多个台子时把编号带上 —— 两个台子长得一样，不说清楚玩家不知道是哪个在忙
  const tag = s.workbenches.length > 1 ? `台子 ${bench + 1} · ` : '';
  if (wb.busy) {
    const left = Math.ceil(wb.left);
    const paused = wb.state === SYNTH_STATE.PAUSED;
    const pair = wb.a
      ? `（${MATERIALS[wb.a].name} + ${MATERIALS[wb.b].name}）`
      : '';
    banner(paused ? `${tag}合成暂停中` : `${tag}正在合成`,
      paused
        ? `庇护所被打穿 —— 补上结构件就会接着走，还剩 ${left} 秒 ${pair}`
        : `还剩 ${left} 秒 ${pair}· 可以走开干别的，但房子被打穿就全毁`,
      paused ? UI_SKIN.warn : UI_SKIN.info, 2.6);
    return;
  }
  // ⚠️ 2026-09-29（用户要求）：台子上有"做好没取走"的产物 → 这一下是**取货**，不是开面板。
  //    时序也按用户说的："点击工作台 → 对材料有一个展示（特写）→ 然后自动放入仓库"：
  //    所以这里**只起动画**（`s.synthTake`），真正入袋在动画播完时才发生（见主循环）。
  // ⚠️ 先查有没有地方放：放不下就**直接提醒、不播动画**（用户明确："如果仓库满了点击工作台时
  //    就提醒玩家"）—— 先播一段动画、再告诉人放不下，是更差的体验。
  if (wb.hasProduct) {
    if (!hasRoomFor(wb.product.mat)) {
      banner('拿不了 —— 没地方放',
        `${MATERIALS[wb.product.mat].name} 还留在工作台上 · 先腾出背包或仓库的位置`,
        UI_SKIN.warn, 3.2);
      return;
    }
    if (s.synthTake) return;                 // 已经在播了，别叠（防连点把动画重置）
    s.synthTake = { bench, t: 0, dur: SYNTH.takeSeconds };
    return;
  }
  openSynthPanel(bench);
}

// ---------- 升降台：唯一能上到"上层岩桥"的方式（2026-09-27）----------

/** 点在某个升降台上吗（世界坐标）。判定矩形比台子画出来略大一圈，方便手指点 */
function liftAt(w) {
  for (const L of LIFTS.list) {
    const gy = terrainY(L.x);
    if (pointInRect(w.x, w.y, { x: L.x - 44, y: gy - 76, w: 88, h: 88 })) return L;
  }
  return null;
}

/**
 * 乘升降台升到上层（用户 2026-09-27 选定的"上高处"方式）。
 *
 * 门槛有两条，缺一不可：
 *   ① **站在台上**（±`LIFTS.standRadius` 且站在地面上）—— 隔空点它不行
 *   ② 背包里**至少有 1 件结构材料**，会被消耗掉（**取档次最低的那件**，
 *      免得把辛苦挖来的龙级料误吃掉）
 * ⚠️ 只认**背包**，不认仓库：材料必须随身带 —— 这是"上去一次要有成本"的体现。
 */
function useLift(L) {
  const p = s.player;
  if (p.dead || p.isLifting) return;

  if (Math.abs(p.x - L.x) > LIFTS.standRadius || !p.onGround
      || Math.abs(p.y - terrainY(L.x)) >= PLAYER.digVertTol) {
    banner('要站到台子上', '走到升降台中间再点它', UI_SKIN.warn, 1.8);
    return;
  }

  let bestIdx = -1;
  let bestTier = Infinity;
  p.carry.forEach((id, i) => {
    const m = MATERIALS[id];
    if (!m || m.kind !== 'struct') return;
    if (m.tier < bestTier) { bestTier = m.tier; bestIdx = i; }
  });
  if (bestIdx < 0) {
    banner('没有结构材料', `升降台要吃掉 ${LIFTS.cost} 件结构材料（取档次最低的），先去废墟挖`, UI_SKIN.warn, 2.4);
    return;
  }

  const cost = p.carry[bestIdx];
  p.carry.splice(bestIdx, 1);
  if (!p.startLift(L.to, LIFTS.seconds)) {
    p.carry.push(cost);   // 启动失败 → 把材料还回去（不能白吃）
    banner('现在不能乘', '（正在挖掘 / 被埋住 / 已经在上升中）', UI_SKIN.warn, 1.8);
    return;
  }
  banner('升降台启动',
    `消耗 ${MATERIALS[cost].name} · ${LIFTS.seconds} 秒后到达上层（期间不能动，注意灾害）`,
    UI_SKIN.info, 3.0);
}

function grantSkipBonus(savedSeconds) {
  let n = Math.min(
    LOOT_RULES.bonusMaxOnSkip,
    Math.floor(savedSeconds / LOOT_RULES.bonusPerPrepHonored)
  );
  // ⚠️ 2026-09-28：池子从"随机一块 tier-1 料"改成**显式列表**（`LOOT_RULES.skipBonusPool`）。
  //    材料表扩容到 125 种后 tier 1 有 6 种，按 tier 取会把 翼/砖 也发出去 ——
  //    而这两种（最轻 / 最厚）是有策略意义的材料，不该由"省时间"白送。
  //    写错 id 会让背包混进 undefined、主循环冻住，所以 config 里有启动自检兜着。
  const basics = LOOT_RULES.skipBonusPool;
  let got = 0;
  while (n-- > 0 && !s.player.isFull) {
    s.player.pick(basics[Math.floor(s.rng() * basics.length)]);
    got += 1;
  }
  return got;
}

/**
 * 提前开波：把准备期剩下的时间直接砍掉，按省下的秒数换材料奖励。
 *
 * ⚠️ 键盘 Enter 和 HUD 上的可点区块**必须共用这一个函数**。
 *    这是微信小游戏，手机上没键盘 —— 只绑 Enter 等于这功能在真机上不存在
 *    （和当年"结算页只能按 R"是同一类坑）。
 */
function doSkipPrep() {
  if (!s || s.director.phase !== Phase.PREP) return;
  if (s.mode === 'tutorial') {
    if (s.tutorialStep !== 4 || !inShelterRange()) {
      banner('教学准备中', '完成顶盖装配和墙属性查看，再回屋内开波', UI_SKIN.info, 2); return;
    }
    s.tutorialStep = 5; s.director.startDisaster(); s.director.nextFire = [1.5];
    return;
  }
  // ⚠️ 2026-09-29：**冻结期（还没出门）不许提前开波**，用户定"停用"。
  //    理由：冻结时倒计时是满额，而奖励是按"省下多少秒"发的 → 不挡的话白等反而变成满额奖励。
  //    ⚠️ 必须给反馈、不能静默 return —— 手机上点按钮什么都不发生，玩家只会以为按钮坏了
  //       （这是本项目反复踩过的坑，见 doDig 里那段"硬直期间静默丢弃点击"）。
  if (s.director.prepWaiting) {
    banner('先出门', '离开庇护所之后才能提前开波 —— 现在倒计时还没开始', UI_SKIN.warn, 2.0);
    return;
  }
  const saved = s.director.skipPrep();
  const got = grantSkipBonus(saved);
  banner('提前开波',
    got > 0 ? `省下 ${saved} 秒，奖励 ${got} 块材料` : `省下 ${saved} 秒（背包已满，无奖励）`,
    UI_SKIN.info, 1.8);
}

// ---------- 指针输入 ----------

/**
 * 常驻面板的"收起图标 / 标题条"命中（2026-10-05）。
 *
 * ⚠️⚠️ 必须排在 **pointerdown 的最前面**（世界点击之前）：面板盖在世界之上，命中却掉到
 *   "点空地 → 走过去"的话，玩家点面板 / 拖面板就会让主角莫名其妙跑掉。
 *   本项目反复写过这条（垃圾桶、帮助按钮都是为此才显式吃掉点击）。
 * ⚠️ 命中标题条的面板里，能拖的见 `UI_DRAGGABLE`（2026-10-05 起是**全部 5 块**）；
 *   即使哪块被移出列表，也照样吃掉点击（只是不设 s.uiDrag，不会穿透到世界）。
 * ⚠️ 收起态那个方块**既能点开、也能拖走**：按下时先记成 `s.uiPending`，**不立刻展开** ——
 *   松手时还没超过 `UI_CHROME.dragSlop` 才算"点击"（见 pointermove 的升级分支 / onPointerUp）。
 * @returns {boolean} true = 这次点击已被吃掉，调用方直接 return
 */
function uiChromeHit(pt) {
  for (const key of ['hud', 'minimap', 'attr', 'storage', 'bag']) {
    if (key === 'attr' || key === 'storage' || key === 'bag') {
      if (key !== 'bag' && !inBuildZone()) continue;
      if (pointInRect(pt.x, pt.y, uiLabelRect(key))) {
        if (key !== 'bag') UI_LAYOUT[key].collapsed = true;
        s.uiPending = { key, x: pt.x, y: pt.y }; s.press = null;
        return true;
      }
      if (key !== 'bag') continue;
    }
    const L = UI_LAYOUT[key];
    if (L.collapsed) {
      // ⚠️ 收起态：**先不当成"点击"** —— 见函数头注释（要区分点击展开 / 拖走）
      if (pointInRect(pt.x, pt.y, uiLabelRect(key))) {
        s.uiPending = { key, x: pt.x, y: pt.y };
        s.press = null;
        return true;
      }
      continue;
    }
    // 展开态：先判标题条**右端**的收起图标，再判标题条本身
    if (key !== 'bag' && pointInRect(pt.x, pt.y, uiCollapseIconRect(key))) { L.collapsed = true; s.press = null; return true; }
    if (pointInRect(pt.x, pt.y, uiTitleBarRect(key))) {
      if (uiIsDraggable(key)) {
        const b = uiPanelBase(key);
        // 记下"按下点相对面板基准左上角"的偏移；pointermove 里用同一偏移反推 dx/dy
        s.uiDrag = { key, offX: pt.x - (b.x + L.dx), offY: pt.y - (b.y + L.dy) };
      }
      s.press = null;
      return true;   // ⚠️ 不可拖的面板也必须吃掉这次点击（否则点面板会让人物走掉）
    }
  }
  return false;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!s) return;
  experience?.unlockAudio();
  const pt = toCanvas(e);
  if (s.paused) return;
  // 跳跃由独立按钮处理；第二根画布指针不能接管已有手势。
  if (s.activePointerId !== null) return;
  s.activePointerId = e.pointerId;
  try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 自动化测试的指针可能没有有效 id */ }
  s.pointer.x = pt.x;
  s.pointer.y = pt.y;

  // 结算面板：只响应它自己的按钮，其它点击一律忽略（否则会穿透到"点空地走路"）
  // ⚠️ 必须做成**可点的按钮** —— 这是微信小游戏，手机上按不了 R 键，
  //    以前结算面板只写"按 R 秒重开"，触屏玩家会卡死在结算页。
  if (s.endSummary) {
    const n = s.endSummary.win ? 2 : 1;   // 通关才有第二个按钮（继续挑战·无尽模式）
    if (n === 2 && pointInRect(pt.x, pt.y, endButtonRect(1, n))) { startEndless(); return; }
    if (pointInRect(pt.x, pt.y, endButtonRect(0, n))) { newGame(); startLoop(); return; }
    return;
  }
  clearKeys();   // 指针输入优先，清掉残留按键，避免与点击移动打架
  if (s.synthPanel) {
    const p = s.synthPanel, g = synthScrollGeometry(s.synthOptions.length, p.scrollY);
    const rail = g.max > 0 && pointInRect(pt.x, pt.y, g.rail);
    if (rail || pointInRect(pt.x, pt.y, g.view)) {
      if (rail && !pointInRect(pt.x, pt.y, g.thumb)) {
        p.scrollY = clamp((pt.y - g.rail.y - g.thumb.h / 2) / Math.max(1, g.rail.h - g.thumb.h) * g.max, 0, g.max);
      }
      p.gesture = { x: pt.x, y: pt.y, scrollY: p.scrollY || 0, rail, moved: false };
    } else synthPanelHit(pt);
    s.press = null; return;
  }

  // -1) 常驻面板的"收起图标 / 标题条"—— **必须在所有世界点击之前**：
  //     面板盖在世界之上，落到"点空地走路"就会让主角乱跑；命中即吃掉这次点击。
  if (uiChromeHit(pt)) return;

  // 0) "撤销丢弃"按钮（只在 3 秒窗口内存在）→ 优先于其他所有命中
  if (s.trashUndo && pointInRect(pt.x, pt.y, trashUndoRect())) {
    undoTrash();
    s.press = null;
    return;
  }

  // 0.5) 点在垃圾桶本身上（空点）→ 什么也不做。
  //      必须显式吃掉，否则会掉到最后的"点空地 → 走过去"，玩家会莫名其妙往垃圾桶走。
  if (pointInRect(pt.x, pt.y, trashRect())) {
    s.press = null;
    return;
  }

  // 只在准备阶段且 HUD 展开时响应倒计时旁的提前开波。
  if (s.director.phase === Phase.PREP && !UI_LAYOUT.hud.collapsed
    && pointInRect(pt.x, pt.y, skipBtnRect())) { doSkipPrep(); s.press = null; return; }

  // 0.9) 点工作台 → 打开合成面板（不在庇护所范围内只会被提示"太远了"）
  //      ⚠️ 地下不判它：工作台是地面上的建筑，在那层根本没画出来（用户问"地下也有庇护所"）
  //      ⚠️ 有多个台子时要逐个判，"点哪个就用哪个"（两个台子可以同时各跑一件）
  const worldPt = toWorld(pt);
  if (s.layer !== 'under') {
    for (let i = 0; i < s.workbenches.length; i++) {
      if (pointInRect(worldPt.x, worldPt.y, workbenchRect(i))) {
        tapWorkbench(i); s.press = null; return;
      }
    }
  }

  // 0.95) 点升降台 → 上高层（要站在台上 + 消耗 1 件结构材料）
  //       ⚠️ 必须排在"料堆 / 墙面"之前：升降台立在台地上，命中区可能和地面的东西相邻。
  const lift = liftAt(worldPt);
  if (lift) { useLift(lift); s.press = null; return; }

  // 点选查看，移动超过阈值才拖拽；收起的格子不接受点击。
  for (let i = 0; !UI_LAYOUT.bag.collapsed && i < BAG_SLOTS; i++) {
    if (pointInRect(pt.x, pt.y, bagSlotRect(i))) {
      const mid = s.player.carry[i];
      if (mid) s.itemPress = { mat: mid, from: { type: 'bag', index: i }, x: pt.x, y: pt.y };
      s.press = null;
      return;
    }
  }

  // 1.5) 墙上的「+」扩展位 → 把 1 个空位额度花在这面。
  //      ⚠️ 必须排在"2) 点在墙上"**之前** —— 「+」格就在墙面矩形内部，
  //         晚一步就会被当成"按在墙上"（于是变成修复/取下）。
  //      ⚠️ 地下不判（同 faceAt）：那是庇护所墙面上的格子，地下没画出来。
  if (s.shelter.bonusSlots > 0 && s.layer !== 'under') {
    const w = toWorld(pt);
    const fid = expandSlotAt(w);
    if (fid) { doExpandFace(fid); s.press = null; return; }
  }

  // 2) 点在墙上 → 先只记"按下"，等松手时才决定是"长按修复"还是"短按拆下"
  const faceId = faceAt(pt);
  if (faceId) {
    const w = toWorld(pt);
    const hit = positionAt(w.x, w.y, s.shelter.faces);
    s.press = {
      faceId,
      posIndex: hit && hit.faceId === faceId ? hit.posIndex : -1,
      at: performance.now(),
      handled: false,
    };
    return;
  }

  // 2.4) 点地穴入口 / 上行口 → 下到地下 / 回到地面（分层世界）
  {
    const en = entranceAt(pt);
    if (en) { s.press = null; useEntrance(en); return; }
  }

  // 2.5) 点隧道洞口 → 走隧道（近区 ↔ 极深区）
  // 废墟绘制在洞口上方，重叠处点击同样优先命中废墟。
  const spot = lootAt(pt);
  if (!s.fade) {
    const tn = tunnelAt(pt);
    if (tn && !spot) { s.press = null; useTunnel(tn); return; }
  }

  // 2.6) 点碎石堆（隐藏区）→ 必须已在旁边。
  //      ⚠️ 必须排在"点废墟料堆"**之前**：碎石堆和料堆都可能出现在中区/深区，先点到谁就是谁。
  const hid = hiddenAt(pt);
  if (hid) {
    s.press = null;
    s.approachSpot = null;
    doBreak(hid);
    return;
  }

  // 3) 点在废墟料堆 → 必须已在旁边，远处点击不登记移动或挖掘。
  if (spot) {
    s.press = null;
    doDig(spot);
    return;
  }

  // 4) 点在空地上 → 走过去
  s.press = null;
  s.approachSpot = null;
  s.pendingDig = null;   // 意图改成"走路"了，缓冲的连点作废
  s.player.targetX = toWorld(pt).x;
});

canvas.addEventListener('pointermove', (e) => {
  if (!s) return;
  if (s.paused || (s.activePointerId !== null && s.activePointerId !== e.pointerId)) return;
  const pt = toCanvas(e);
  s.pointer.x = pt.x;
  s.pointer.y = pt.y;
  if (s.synthPanel) {
    const p = s.synthPanel, q = p.gesture;
    if (q) {
      const g = synthScrollGeometry(s.synthOptions.length, p.scrollY);
      if (Math.hypot(pt.x - q.x, pt.y - q.y) > UI_CHROME.dragSlop) q.moved = true;
      if (q.moved) p.scrollY = clamp(q.scrollY + (q.rail ? (pt.y - q.y) * g.max / Math.max(1, g.rail.h - g.thumb.h) : q.y - pt.y), 0, g.max);
    }
    return;
  }
  if (s.itemPress && Math.hypot(pt.x - s.itemPress.x, pt.y - s.itemPress.y) > UI_CHROME.dragSlop) {
    s.drag = s.itemPress;
    s.itemPress = null;
    s.inspectItem = null;
  }

  // 收起态的方块：按下后移开超过阈值 → 从"点击展开"升级成"拖动搬运"（升级后就不再展开了）
  if (s.uiPending) {
    const q = s.uiPending;
    if (Math.hypot(pt.x - q.x, pt.y - q.y) > UI_CHROME.dragSlop && uiIsDraggable(q.key)) {
      const b = uiPanelBase(q.key);
      const L = UI_LAYOUT[q.key];
      s.uiDrag = { key: q.key, offX: q.x - (b.x + L.dx), offY: q.y - (b.y + L.dy) };
      s.uiPending = null;
    }
  }

  // 正在拖常驻面板（标题条 / 收起后的方块）→ 只更新它的偏移（夹屏内），不去比 hover / 拖材料
  if (s.uiDrag) {
    const { key, offX, offY } = s.uiDrag;
    const b = uiPanelBase(key);
    uiSetOffset(key, pt.x - offX - b.x, pt.y - offY - b.y);
    return;
  }

  s.hoverBagIndex = -1;
  for (let i = 0; i < BAG_SLOTS; i++) {
    if (pointInRect(pt.x, pt.y, bagSlotRect(i)) && s.player.carry[i]) s.hoverBagIndex = i;
  }
  if (s.drag) {
    s.drag.x = pt.x;
    s.drag.y = pt.y;
    s.dragTarget = computeDragTarget(pt);
  }
});

function endDrag() {
  if (!s || !s.drag) return;
  const d = s.drag;
  const target = s.dragTarget;
  s.drag = null;
  s.dragTarget = null;
  if (!target) return;

  // 落到墙上
  if (target.kind === 'face') {
    if (MATERIALS[d.mat].kind === 'repair') {
      banner('修复材料不能贴', '它是消耗品 —— 长按墙面时会自动用掉', UI_SKIN.warn, 1.9);
      return;
    }
    if (target.posIndex < 0) {
      banner(MATERIALS[d.mat].kind === 'struct' ? '补漏位满了' : '插槽位满了',
        '先点掉一个位置上的材料', UI_SKIN.warn, 1.6);
      return;
    }
    dropOnFace(d, target.faceId);
    return;
  }

  // 落到垃圾桶 → 丢弃（背包/仓库都一样）
  if (target.kind === 'trash') {
    dropToTrash(d);
    return;
  }

  // 落到仓库格：背包 → 仓库（格位由材料类别决定，放进对应分区）
  if (target.kind === 'store') {
    if (d.from.type !== 'bag') return;
    if (!inBuildZone()) { banner('太远了', '要靠近庇护所才能存取仓库', UI_SKIN.warn, 1.5); return; }
    const kind = MATERIALS[d.mat].kind;
    s.player.carry.splice(d.from.index, 1);
    s.shelter.storeAdd(d.mat);
    banner('存入仓库', `${MATERIALS[d.mat].name} → ${KIND_LABEL[kind]}区（${s.shelter.store[kind].length} 件）`, UI_SKIN.info, 1.4);
    return;
  }

  // 落到背包格：仓库 → 背包
  if (target.kind === 'bag') {
    if (d.from.type !== 'store') return;
    if (s.player.isFull) { banner('背包满了', '先把背包里的东西贴到墙上或存进仓库', UI_SKIN.warn, 1.6); return; }
    if (!s.shelter.storeRemoveOne(d.mat)) return;
    s.player.carry.push(d.mat);
    banner('取出到背包', `${MATERIALS[d.mat].name}`, UI_SKIN.info, 1.3);
  }
}

/** 松手：区分"长按修复结束"和"短按拆下材料" */
function onPointerUp(e) {
  if (!s) return;
  if (s.activePointerId !== e.pointerId) return;
  s.activePointerId = null;
  if (s.synthPanel) {
    const q = s.synthPanel.gesture;
    s.synthPanel.gesture = null;
    if (q && !q.rail && !q.moved && Math.hypot(toCanvas(e).x - q.x, toCanvas(e).y - q.y) <= UI_CHROME.dragSlop) synthPanelHit(toCanvas(e));
    return;
  }
  if (s.itemPress) {
    s.inspectItem = s.itemPress;
    s.itemPress = null;
    return;
  }
  // 图标短按打开对应面板；背包图标再次点击收起。超过阈值则只拖动位置。
  if (s.uiPending) {
    const key = s.uiPending.key;
    s.uiPending = null;
    s.press = null;
    if (key === 'attr' || key === 'storage') experience?.management(key);
    else if (key === 'bag') {
      const L = UI_LAYOUT.bag;
      L.collapsed = !L.collapsed;
      uiSetOffset('bag', L.dx, L.dy);
    }
    else UI_LAYOUT[key].collapsed = false;
    return;
  }
  // 拖常驻面板结束：清掉拖动状态（面板位置已经改在 UI_LAYOUT 里了，不用再做什么）
  if (s.uiDrag) {
    s.uiDrag = null;
    s.press = null;
    return;
  }
  if (s.drag) {
    s.dragTarget = computeDragTarget(toCanvas(e));
    endDrag();
    s.press = null;
    return;
  }
  const press = s.press;
  const wasRepairing = !!s.repairingFaceId;
  s.press = null;
  s.repairingFaceId = null;

  // 短按（没被判定成长按）→ 拆下材料
  if (press && !press.handled && !wasRepairing && press.posIndex >= 0) {
    const pos = s.shelter.face(press.faceId).positions[press.posIndex];
    if (pos.mat) pickPatchBack(press.faceId, press.posIndex);
  }
}

canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('wheel', (e) => {
  if (!s?.synthPanel || s.paused) return;
  const p = s.synthPanel, g = synthScrollGeometry(s.synthOptions.length, p.scrollY), pt = toCanvas(e);
  if (!pointInRect(pt.x, pt.y, synthPanelRect())) return;
  e.preventDefault();
  const unit = VIEW.h / canvas.getBoundingClientRect().height;
  p.scrollY = clamp(g.offset + e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? g.view.h / unit : 1) * unit, 0, g.max);
}, { passive: false });
canvas.addEventListener('pointercancel', (e) => {
  if (!s) return;
  if (s.activePointerId !== e.pointerId) return;
  s.activePointerId = null;
  if (s.synthPanel) s.synthPanel.gesture = null;
  s.itemPress = null;
  s.drag = null; s.dragTarget = null; s.uiDrag = null; s.uiPending = null; s.press = null; s.repairingFaceId = null;
});

// ---------- 键盘（电脑上的便利键 + 全局操作） ----------

window.addEventListener('keydown', (e) => {
  if (s?.screen === 'home') return;
  if (document.querySelector('dialog[open]') || /BUTTON|INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const k = e.key;
  const low = k.toLowerCase();
  if (low === 'escape' || low === 'p') { e.preventDefault(); experience?.pauseMenu(); return; }
  if (s?.paused && low !== 'r') return;
  experience?.unlockAudio();
  keys[low] = true;
  if (low === 'r') { experience?.restartConfirm(); return; }
  if (!s) return;
  if (low === 't') { s.speed = s.speed === 1 ? 2 : s.speed === 2 ? 4 : 1; return; }
  if (low === 'y') { s.showForecast = !s.showForecast; return; }
  // 手电筒开关（2026-09-26）。手机上由屏幕按钮触发。
  if (low === 'f') { s.flashlight = !s.flashlight; return; }
  // 跳跃（2026-09-26）：空格 / W / ↑。手机上由屏幕按钮触发。
  if (k === ' ' || low === 'w' || k === 'ArrowUp') {
    e.preventDefault();
    jumpPlayer();
    return;
  }
  // "提前开波"从空格挪到 Enter —— 空格让给跳跃（跳跃是常按的，提前开波一局按不了几次）
  // ⚠️ 手机上没键盘，所以 HUD 上还必须有一个可点区块，两处共用 doSkipPrep()
  if (k === 'Enter') { e.preventDefault(); doSkipPrep(); return; }
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
window.addEventListener('blur', pauseGame);
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
window.addEventListener('pagehide', pauseGame);

// ---------- 主循环 ----------

let last = performance.now();
let loopRunning = false;
const UI_FONT = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);
  try {
    step(dt);
    if (s.screen !== 'home') render(ctx, s);
    experience?.update(now);
    saveElapsed += dt;
    if (s.checkpointDue || saveElapsed >= 5) {
      s.checkpointDue = false; saveElapsed = 0; saveCheckpoint();
    }
  } catch (err) {
    // 崩了必须看得见。
    // 教训：之前 pickPatchBack 有个字段名写错（m.mat 应为 m.id），把 undefined 塞进背包，
    // 渲染在第一处读 .weight 时抛异常 → rAF 循环直接死掉 → 玩家只看到"画面冻住"，
    // 堆栈只留在控制台里，极容易误判成"性能问题"或"卡住了"。
    console.error('[灰盒崩溃]', err);
    drawCrash(err);
    loopRunning = false;   // 停循环避免刷屏；按 R 会重新拉起
    return;
  }
  requestAnimationFrame(frame);
}

function drawCrash(err) {
  ctx.save();
  ctx.fillStyle = 'rgba(16,10,6,0.95)';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  ctx.textAlign = 'left';
  ctx.fillStyle = UI_SKIN.danger;
  ctx.font = `bold 22px ${UI_FONT}`;
  ctx.fillText('原型崩溃了 —— 按 R 重开（堆栈已打到控制台）', 40, 64);
  ctx.fillStyle = UI_SKIN.textStrong;
  ctx.font = `13px ${UI_FONT}`;
  const lines = String((err && err.stack) || err).split('\n').slice(0, 14);
  lines.forEach((line, i) => ctx.fillText(line.slice(0, 120), 40, 104 + i * 21));
  ctx.restore();
}

function step(rawDt) {
  if (s.paused) return;
  const dt = rawDt * s.speed;

  // 主角待机动画的时钟（2026-10-04）：按**游戏速度**累加 —— 倍速时跟着快、暂停/结算时跟着停。
  // ⚠️ 放在状态里、由 `drawPlayer` 读；**不在渲染层读 `performance.now()`**（那样倍速会穿帮、
  //    也没法复现"某一帧长什么样"）。见 `render.js` 的 `drawPlayer`。
  s.player.animT = (s.player.animT || 0) + dt;
  // 世界时钟（2026-10-04）：现在只给**怪物动画**用 —— 它们没有"自己的"时钟，逐只记很啰嗦。
  // ⚠️ 和主角的 `p.animT` **故意分开**：主角将来可能要在"被埋 / 坐升降台"时单独停表，混在一起会互相牵制。
  s.animT = (s.animT || 0) + dt;
  // 「这一帧有没有位移」→ 决定播跑步还是待机（`drawPlayer` 按它切条）。
  // ⚠️ 用**实际位移**判、不用"按了方向键"：点击移动 / 被升降台抬升 / 跳跃都不按方向键，
  //    而按着键撞墙时又其实没动 —— 位移是唯一诚实的判据。取 0.05 是"小于半像素不算动"。
  // ⚠️ 朝向（2026-10-04 用户要求"跟随行走方向转向"）**复用同一个位移**：朝右 +1 / 朝左 -1。
  //    只在**真的动了的那一帧**更新 —— 站着不动时保留上一次的朝向（否则一松手就翻回去）。
  const pdx = s.player.x - (s.player.lastX ?? s.player.x);
  s.player.moving = Math.abs(pdx) > 0.05;
  if (s.player.moving) s.player.faceDir = pdx > 0 ? 1 : -1;
  s.player.lastX = s.player.x;

  if (s.banner) {
    s.banner.t -= rawDt;
    if (s.banner.t <= 0) s.banner = null;
  }
  // 撤销窗口倒计时（只用来兜住手滑，过期就真的没了）
  if (s.trashUndo) {
    s.trashUndo.t -= rawDt;
    if (s.trashUndo.t <= 0) s.trashUndo = null;
  }
  // "庇护所没挡住"的 HUD 警告：每次挨打都刷新，所以只要还在挨打就一直显示
  if (s.leakAlert) {
    s.leakAlert.t -= rawDt;
    if (s.leakAlert.t <= 0) s.leakAlert = null;
  }
  // "完全拦住"的 HUD 提示
  if (s.blockAlert) {
    s.blockAlert.t -= rawDt;
    if (s.blockAlert.t <= 0) s.blockAlert = null;
  }
  // "靠地形躲开了"的 HUD 提示
  if (s.dodgeAlert) {
    s.dodgeAlert.t -= rawDt;
    if (s.dodgeAlert.t <= 0) s.dodgeAlert = null;
  }
  // 工作台"材料全毁"的红字（不随横幅走，见事件循环里的注释）
  if (s.synthLossT > 0) s.synthLossT = Math.max(0, s.synthLossT - rawDt);
  s.player.tick(rawDt);
  if (s.endSummary) return;

  let dir = 0;
  if (keys['a'] || keys['arrowleft']) dir -= 1;
  if (keys['d'] || keys['arrowright']) dir += 1;
  if (touchDirection) dir = touchDirection;
  s.player.move(dir, dt);
  updateCamera();

  // 小地图"逐步点亮"：记录走过的 x 范围（换波时重置 —— 新地图要重新探索）
  if (s.player.x < s.explored.min) s.explored.min = s.player.x;
  if (s.player.x > s.explored.max) s.explored.max = s.player.x;

  // 通用过渡：到时间一半时执行 mid()（隧道传送 / 地穴口换层），其余时间只是渐黑/渐亮
  // ⚠️ mid 必须**只执行一次**（`f.done`）—— 判据是"跨过中点"，不是"正好等于中点"：
  //    帧长会跳（切后台、掉帧），用 `=== dur/2` 会整个漏掉、人就永远不换层了。
  if (s.fade) {
    const f = s.fade;
    f.t += dt;
    if (!f.done && f.t >= f.dur / 2) {
      f.done = true;
      f.mid();
    }
    if (f.t >= f.dur) s.fade = null;
  }

  // 手电筒的平滑开合：向目标指数趋近（与帧率无关），收敛后**贴死**
  // ⚠️ 收敛后必须贴死（而不是无限趋近）：否则 `lightK` 永远差 0.001，
  //    每帧都重算渐变、而且关灯时"永远没完全关"（边缘那点亮度会一直在）。
  {
    const target = s.flashlight ? 1 : 0;
    if (s.lightK !== target) {
      const k = 1 - Math.exp(-dt / Math.max(0.01, LIGHT.transition));
      s.lightK += (target - s.lightK) * k;
      if (Math.abs(target - s.lightK) < 0.002) s.lightK = target;
    }
  }

  // 长按墙面 → 进入修复状态（短按仍然是"拆下"，见 onPointerUp）
  if (s.press && !s.press.handled && !s.drag
      && performance.now() - s.press.at > REPAIR.holdSeconds * 1000) {
    s.press.handled = true;
    const fid = s.press.faceId;
    if (!inBuildZone()) {
      banner('太远了', '要靠近庇护所才能长按修复', UI_SKIN.warn, 1.6);
    } else if (!s.shelter.hasStruct(fid)) {
      banner('已经彻底破了', '长按救不回来，得重新贴结构件', UI_SKIN.warn, 1.9);
    } else if (!s.shelter.canRepair(fid)) {
      banner('不用修', `${s.shelter.face(fid).name}的耐久是满的`, UI_SKIN.warn, 1.3);
    } else if (repairUnitsAvailable() <= 0) {
      banner('没有修复材料', '长按修复要消耗修补浆／纳米修补剂，先去废墟挖', UI_SKIN.warn, 2.1);
    } else {
      s.repairingFaceId = fid;
      banner('修复中', '正在消耗修复材料；越稀有的材料修得越慢', UI_SKIN.ok, 1.4);
    }
  }

  // 正在长按修复：持续补耐久，**消耗修复材料**（不再免费）
  if (s.repairingFaceId) {
    if (!inBuildZone()) {
      s.repairingFaceId = null;
    } else {
      const fid = s.repairingFaceId;
      const plan = s.shelter.repairPlan(fid, dt);   // 这一帧想修多少耐久 / 要花多少修复量
      const got = consumeRepair(plan.units);        // 实际扣到多少修复量
      if (plan.units <= 1e-6) {
        s.repairingFaceId = null;
        banner(s.shelter.hasStruct(fid) ? '修复完成' : '已经彻底破了',
          s.shelter.hasStruct(fid) ? `${s.shelter.face(fid).name}的耐久已修满` : '需要重新贴结构件', UI_SKIN.ok, 2.1);
      } else if (got <= 1e-6) {
        s.repairingFaceId = null;
        banner('修复材料用完了', '去废墟挖修补浆／纳米修补剂', UI_SKIN.warn, 2.1);
      } else {
        s.shelter.repairApply(fid, plan, got);
        if (s.mode === 'tutorial' && s.tutorialStep >= 5 && fid === 'roof') s.tutorialRepairSpent += got;
        if (!s.shelter.canRepair(fid)) {
          s.repairingFaceId = null;
          banner('修复完成', `${s.shelter.face(fid).name}的耐久已修满`, UI_SKIN.ok, 2.1);
        }
      }
    }
  }

  // 供 HUD 显示（背包 + 仓库里剩余的修复量）
  s.repairUnits = repairUnitsAvailable();

  // 合成倒计时：**后台推进**（用户选定的交互）—— 启动之后可以走开干别的，
  // 暂停/报废由下面的事件循环决定，这里只管走时间。
  // ⚠️ 逐个台子推进：两个台子各自独立，可以同时在跑（第 5 波后会有第 2 个）。
  // ⚠️ 2026-09-29：**合成倒计时共用"等出门"的冻结开关**（用户要求："合成也是从人物离开
  //    庇护所之后开始计时"）。冻结期喂 dt=0 → 进度条原地停住，出门后才开始走。
  //    ⚠️ 这与"庇护所被打穿 → Workbench 自己 PAUSED"是两回事：那个是内部状态机，
  //       这个是外部门控喂不喂时间，两者可以叠。
  const synthDt = s.director.prepWaiting ? 0 : dt;
  for (let i = 0; i < s.workbenches.length; i++) {
    const synthDone = s.workbenches[i].update(synthDt);
    if (synthDone) finishSynth(synthDone, i, s.workbenches.length);
  }

  // ⚠️ 2026-09-29：**取货动画**（见 tapWorkbench）—— 播完才真的入袋，这是用户要的时序
  //    （"点击工作台 → 对材料有一个展示 → 然后自动放入仓库"）。
  //    ⚠️ 用真实 `dt`（不受"整备期冻结"影响）：它纯是表现，和游戏计时无关。
  //    ⚠️ 先清 `s.synthTake` 再调 `takeFromBench` —— 后者可能失败（仓满），要允许玩家再点一次。
  if (s.synthTake) {
    s.synthTake.t += dt;
    if (s.synthTake.t >= s.synthTake.dur) {
      const b = s.synthTake.bench;
      s.synthTake = null;
      takeFromBench(b);
    }
  }

  // 硬直结束 → 把缓冲下来的连点补上（见 doDig 里那段注释：连点不该被静默吃掉）。
  // ⚠️ 一帧只补一下，让每一下仍然占满一个 tapSeconds 硬直 —— 保持"多点几下"的节奏感。
  // ⚠️ 位置必须在这里：`move()` 刚刚扣完 busyT，所以"硬直刚好归零"这一帧才补得上。
  if (s.pendingDig && !s.player.isBusy && !s.player.isStunned && !s.player.dead) {
    const b = s.pendingDig;
    s.pendingDig = null;
    if (b.spot.available && atSpot(b.spot, s.player.x, s.player.y)) {
      doDig(b.spot);
      if (b.n > 1) s.pendingDig = { spot: b.spot, n: b.n - 1 };
    }
  }

  // 碎石堆的连点补上（隐藏区 —— 和挖掘同款缓冲，理由见 doBreak）
  if (s.pendingBreak && !s.player.isBusy && !s.player.isStunned && !s.player.dead) {
    const b = s.pendingBreak;
    s.pendingBreak = null;
    if (!b.hid.opened && Math.abs(b.hid.x - s.player.x) < PLAYER.digRadius) {
      doBreak(b.hid);
      if (b.n > 1) s.pendingBreak = { hid: b.hid, n: b.n - 1 };
    }
  }

  // 走开 / 换到别的料堆 → 自动收走暂存，并且**深度归零**（2026-09-25 用户要求：
  // "主人公一旦离开，层数就会重新开始"）。
  // ⚠️⚠️ 2026-09-27 第六轮续（用户定案）：**非引怪型只要被挖过，走开就消失**。
  //    用户原话："易塌性挖完以后，无论塌没塌，只要离开了，也会消失"。
  //    澄清后确认的是"**挖过就算**"—— 不要求挖到底（挖一半走开也消失）。
  //    为什么必须连"挖一半走开"也一起算：否则"挖两层走开 → 深度归零 → 回来再挖两层"
  //    可以无限刷，和"只有引怪型能反复挖"直接矛盾（而且稳固型占近区 70% 的废墟，漏洞更大）。
  //    塌方的更早就消失了（`digOnce` 里当场 `available = false`，用户确认保持现状）。
  //    ⚠️ 必须先读 `depth`：下一行就要把它归零了。
  // ⚠️⚠️ 2026-09-27 修 bug：这里的"站在哪一堆旁边"必须用 `atSpot`（**连高度一起判**）。
  //    原来只比 x，桥上挖出的材料会被算到"正下方那堆地面废墟"头上 → 永远收不走
  //    （用户报的"空中的废墟挖出材料后无法获得"）。同一个判定在**挖 / 敲 / 收**三处必须一致。
  const near = s.world.loot.find(
    (l) => l.available && atSpot(l, s.player.x, s.player.y)
  ) || null;
  // 可挖范围可能重叠，不能只收 nearSpot 指向的第一处。
  for (const spot of s.world.loot) {
    if (atSpot(spot, s.player.x, s.player.y)) {
      if (spot.pending.length) spot.collectOnLeave = true;
      continue;
    }
    if (!spot.collectOnLeave && spot !== s.nearSpot && spot.depth <= 0) continue;
    spot.collectOnLeave = false;
    const cleared = collectPending(spot);
    const dug = spot.depth > 0 || spot.depleted;
    // 收不下的材料留在原地，回来再离开时重试；不能每帧远程收取。
    if (cleared && dug && !RUIN_TYPES[spot.type].refill) spot.available = false;
    spot.depth = 0;
  }
  s.nearSpot = near;

  // 怪物：不能打，只能躲
  // ⚠️ 2026-09-29：**必须把 player.y 一起传** —— 判定里要看"玩家离地多高"，
  //    否则玩家站在上层岩桥/石台上时，正下方的怪照样咬得到他（见 monsters.js 的 canReach）。
  const monsterDamage = s.monsters.update(dt, s.player.x, s.player.y, s.player.dead);
  if (monsterDamage > 0) {
    s.player.hurtFlash = 0.25;
    applyPlayerDamage(monsterDamage, 'monster');
  }

  // 兽潮围攻（2026-10-04 用户："兽潮改为怪物围攻"）—— **灾害期 = 围攻期**：
  //   本波灾害里有 `beasts` 就聚到门外，灾害一结束就撤（见 `SiegePack` 那节的边界说明）。
  // ⚠️ 只在**地面层**：庇护所只在地面，而灾害期地穴入口是关的（跑不到地下去）——
  //    这里那道 `s.layer === 'ground'` 是**兜底**，防的是"灾害刚结束、撤离那 1 秒里玩家换层"。
  // ⚠️ 纯视觉：它**不掉门的血**（门仍走 `DISASTERS.beasts` 的老管线），但**会咬玩家**。
  const siegeOn = s.layer === 'ground' && s.director.phase === Phase.DISASTER
    && s.director.active.some((d) => d.id === 'beasts');
  if (siegeOn) s.siege.start(SHAPE.door.x, s.rng);
  else s.siege.end();
  const siegeDamage = s.siege.update(dt, s.player.x, s.player.y, s.player.dead);
  if (siegeDamage > 0) {
    s.player.hurtFlash = 0.25;
    applyPlayerDamage(siegeDamage, 'monster');
  }

  // 波次推进。2026-09-26 取消了"安全区"规则：
  //   · 庇护所**不管主角在哪都照打**
  //   · 雷电／光束使用同一份减伤后预算；其他灾害在外面吃全额伤害
  //   · 唯一能救你的是地形（陨石躲岩棚、地陷站高处），判定函数来自 world.js
  setDodgePlayerX(s.player.x);
  // ⚠️ 2026-09-29：准备期"等玩家出门"的**解冻判定**（用户要求："每波准备期从人物离开庇护所开始计时"）。
  //   · 玩家离开庇护所范围 → 解冻（他已经在探索了）
  //   · 兜底：**挖到料**也会解冻（在 doDig 里直接调 releasePrep，见那一段的注释）
  //   ⚠️ 必须放在 `director.update` **之前** —— 它自己要用 `prepWaiting` 决定 timer 走不走。
  //   ⚠️ 解冻**不可逆**（之后回庇护所也不会重新冻结），否则"反复进出"就能无限拖时间。
  //   ⚠️ 顺带覆盖了"灾害结束时人已经在外面"这种情况：那一帧就会命中 → 立即开始计时
  //      （用户 2026-09-29 选的处理，理由是这样才不会有"整波在外面游荡所以永远不开始"的漏洞）。
  if (s.mode === 'tutorial') {
    if (s.tutorialStep === 0 && Math.abs(s.player.x - SHELTER.cx) > 40 && s.tutorialJumped) s.tutorialStep = 1;
    const stored = s.shelter.store.struct.includes('t1_hard');
    if (s.tutorialStep === 1 && (s.player.carry.includes('t1_hard') || stored || s.shelter.hasStruct('roof'))) s.tutorialStep = 2;
    if (s.tutorialStep === 2 && s.shelter.hasStruct('roof')) s.tutorialStep = 3;
    if (s.tutorialStep === 3 && s.tutorialInspected) s.tutorialStep = 4;
    if (s.tutorialStep < 5 || s.tutorialStep === 6) {
      s.director.prepFrozen = s.tutorialStep !== 4; s.director.timer = s.director.cfg.prep;
    }
    if (s.tutorialObserveLeft > 0) {
      s.tutorialObserveLeft = Math.max(0, s.tutorialObserveLeft - rawDt);
      if (!s.tutorialObserveLeft) {
        s.tutorialStep = 6;
        if (!s.player.isFull) s.player.carry.push('patch_kit'); // 修复课现场发放，让玩家在背包看到实际耗材。
        else s.shelter.store.repair.push('patch_kit');
        UI_LAYOUT.bag.collapsed = false;
        UI_LAYOUT.hud.collapsed = true; UI_LAYOUT.minimap.collapsed = true;
        s.director.phase = Phase.PREP; s.director.prepFrozen = true;
        s.director.active = []; s.director.nextFire = [];
        s.banner = null; // 修复指引由常驻提示显示，横幅不遮住待修的顶盖。
      }
    }
    if (s.tutorialStep === 6 && s.tutorialRepairSpent > 0 && s.shelter.hasStruct('roof') && !s.shelter.canRepair('roof')) s.tutorialDone = true;
    if (s.tutorialStep === 6 && !s.tutorialDone && s.shelter.canRepair('roof') && repairUnitsAvailable() <= 0) {
      if (!s.player.isFull) s.player.carry.push('patch_kit');
      else s.shelter.store.repair.push('patch_kit');
      banner('教学补给', '补充一份修补浆，继续长按受损顶盖', UI_SKIN.ok, 2);
    }
    // 装错位置或丢弃练习材料后仍能重试，不影响正式局的资源规则。
    const spot = s.worldGround.loot[0];
    if (s.tutorialStep < 3 && s.tutorialGiven && !stored && !s.player.carry.includes('t1_hard') && !spot.pending.length) {
      Object.assign(spot, { depth: 0, depleted: false, available: true });
      s.tutorialGiven = false;
      if (s.tutorialStep === 2 && !s.shelter.hasStruct('roof')) s.tutorialStep = 1;
    }
  } else if (s.director.prepWaiting && !inShelterRange()) s.director.releasePrep();

  const events = s.director.update(dt, !inShelterRange(), terrainDodge);
  for (const ev of events) {
    experience?.sound(ev.disaster);
    const d = DISASTERS[ev.disaster];
    s.lastDefense = ev.blocked ? `${d.name}完全挡住了。`
      : ev.dodged ? `${d.name}：地形保护了你。`
        : `${d.name}：墙损 ${Math.round(ev.damage * 10) / 10}，人伤 ${Math.round(ev.playerDamage * 10) / 10}。`;
    s.lastThreat = { disaster: ev.disaster, damage: ev.damage, playerDamage: ev.playerDamage };
    if (s.mode === 'tutorial' && s.tutorialStep === 5 && !s.tutorialDone && !ev.playerDamage && !s.tutorialObserveLeft) {
      s.tutorialObserveLeft = 6;
      s.director.nextFire = [60]; s.director.timer = 60;
    }
    // 工作台的风险（文档 7.3）：庇护所被打穿 → 进度**暂停**（不清零）；
    // "已经破着的面再挨打" → 工作台被打穿、**投入的材料全毁**。
    // ⚠️ 判定挂在"庇护所的任意一面"上，不给工作台单独造一套血量 —— 语义也说得通：
    //    房子漏了，台子上的活干不下去（见 config.js 合成段与 7.3）。
    // ⚠️ 顺序要紧：先判"已破的面又被打"（报废），再判"这一击新打穿了面"（暂停）。
    //    反过来的话，同一击既打穿又报废时会先说暂停、下一击才报废，读数会慢一拍。
    // ⚠️ 2026-09-27 续：台子可能不止一个 —— 逐个处理，**不能用 some()**
    //    （some 会短路，第 1 个台子一命中，第 2 个就永远轮不到暂停/报废）。
    // ⚠️ 2026-09-29：判定要连"台子上有没有待取产物"一起看 —— 空闲但台上有货时，
    //    原来这里 `anyBusy` 为 false 会跳过整段处理，产物就永远毁不掉（用户定"产出跟着毁掉"）。
    const anyBusy = s.workbenches.some((w) => w.busy || w.hasProduct);
    if (anyBusy) {
      if (ev.brokenFaces && ev.brokenFaces.length) {
        const lostList = [];
        for (const w of s.workbenches) { const l = w.collapse(); if (l) lostList.push(l); }
        if (lostList.length) {
          s.synthPausedFaces = [];
          // ⚠️ 2026-09-29：取货动画**播到一半时台子被砸** → 必须把动画也掐掉。
          //    产物已经被 `collapse()` 清成 null 了，卡片若还在飞就是在展示一个**已经不存在**的东西；
          //    而且主循环会在动画结束时调 `takeFromBench()`（那时只静默返回 false）。
          //    `collapse()` 是**对所有台子**调的，所以这里整段清掉是对的（没有"另一个台子的动画还在跑"）。
          s.synthTake = null;
          // ⚠️ 这个提示**不能只靠横幅**：同一帧里"整面墙彻底坏了 / 伤害打在你身上"也会弹横幅，
          //    后弹的会把这条盖掉，玩家看到的就是"材料凭空没了"。所以另配一个工作台上的红字
          //    （见 render.js 的 drawWorkbench），持续 6 秒。
          s.synthLossT = 6;
          // ⚠️ 2026-09-29：`l.a` / `l.b` 可能是 **null**（台子上只有"做好没取走"的产物时）——
          //    直接取 `MATERIALS[null].name` 会当场抛错，把这一帧的整个结算打断。
          const names = lostList.map((l) => {
            const bits = [];
            if (l.a && l.b) bits.push(`投入的 ${MATERIALS[l.a].name} + ${MATERIALS[l.b].name}`);
            else if (l.a) bits.push(`投入的 ${MATERIALS[l.a].name}`);
            if (l.product) bits.push(`刚做好的 ${MATERIALS[l.product.mat].name}`);
            return bits.join(' 和 ');
          }).join('、');
          banner(lostList.length > 1 ? `${lostList.length} 个工作台被打穿了！` : '工作台被打穿了！',
            `${names} 全毁了 —— 破着的面再挨打就会这样`,
            UI_SKIN.danger, 3.4);
        }
      } else if (ev.deadFaces && ev.deadFaces.length) {
        let anyPaused = false;
        for (const w of s.workbenches) { if (w.pause()) anyPaused = true; }
        if (anyPaused) {
          // 只记**这一击打穿的面**：它们补好就继续（不是"所有破面"，否则前期没补漏的
          // 房子会让合成永远恢复不了 —— 那对玩家是莫名其妙的中断）
          s.synthPausedFaces = [...ev.deadFaces];
          banner('合成暂停', '庇护所被打穿 · 受损面未补漏 · 进度保留', UI_SKIN.warn, 2.8);
        }
      }
    }

    s.shake = ev.disaster === 'sinkhole' ? 0.35 : ev.disaster === 'lightning' ? 0.25 : 0.18;
    if (ev.disaster === 'sinkhole') s.quakeT = 1.1;
    spawnEffect(ev);
    if (ev.hitPlayer) {
      s.player.hurtFlash = 0.3;
      banner('被砸中了！',
        `你在庇护所外面 —— ${ev.name}直接打在你身上（-${Math.round(ev.playerDamage)}）。回来才能让墙替你挡`,
        UI_SKIN.danger, 1.9);
    }
    // 地形救了你一命（2026-09-26 新增）。必须给正反馈 ——
    // 不然玩家不知道"躲地形"这件事真的有用，也就不会去用它。
    if (ev.dodged) {
      s.dodgeAlert = { t: 1.1, kind: ev.dodged, name: ev.name };
      banner('躲开了！',
        ev.dodged === 'occluder'
          ? `你站在岩棚下面，${ev.name}被挡住了`
          : `你站在高处，${ev.name}没波及到你`,
        UI_SKIN.ok, 1.6);
    }
    if (ev.lost && ev.lost.length) {
      for (const l of ev.lost) {
        const fn = l.faceId ? s.shelter.face(l.faceId).name : '';
        const mn = MATERIALS[l.mat].name;
        // why 的三种来源（都在这一个 ev.lost 里，所以必须按 why 分开说，否则玩家分不清）：
        //   worn    整面墙彻底坏了 → 上面所有结构件一起失效
        //   cracked 破损后自己掉了（2026-09-26 新增机制，见 WEAR_DROP）
        //   exposed 结构件全破之后，功能件被砸飞
        const TEXTS = {
          worn: ['整面墙彻底坏了', `${fn}被彻底打穿，上面的${mn}跟着一起失效了`],
          cracked: ['破损的材料掉了', `${fn}上的${mn}破损后被砸掉了 —— 及时修满就不会掉`],
          exposed: ['材料被打飞', `${fn}上的${mn}（结构件全破后被砸掉）`],
        };
        const [title, sub] = TEXTS[l.why] || TEXTS.exposed;
        banner(title, sub, UI_SKIN.warn, l.why === 'cracked' ? 2.3 : 1.9);
      }
    }
    // 完全拦住：给正反馈。悬崖式手感里"刚好挡住"是核心动力，看不见就等于没有。
    if (ev.blocked) {
      noticeBlocked(ev);
    } else if (ev.playerDamage) {
      // 庇护所没挡住、伤害落到主角身上的两条路径（穿墙 / 破面）以前完全没有反馈，
      // 所以这里必须让主角闪红 + 给出可执行的提示，否则玩家只会看到血条莫名在掉。
      if (ev.hitPlayer) {
        applyPlayerDamage(ev.playerDamage, 'outside');
      } else {
        s.player.hurtFlash = 0.3;
        alertLeak(ev);
        applyPlayerDamage(ev.playerDamage, ev.model);
      }
    }
  }

  // 暂停的合成：被打穿的那几面补好 → **自动接着走**（不清零，只是冻住了时间）
  // ⚠️ 所有台子一起暂停/一起恢复（暂停的条件是"房子漏了"，和哪个台子无关）
  if (s.workbenches.some((w) => w.state === SYNTH_STATE.PAUSED)
      && s.synthPausedFaces.every((id) => s.shelter.hasStruct(id))) {
    for (const w of s.workbenches) w.resume();
    s.synthPausedFaces = [];
    banner('合成继续', '打穿的面补好了，倒计时接着走', UI_SKIN.ok, 2.2);
  }

  // 灾害期的画面染色：按**本波第一种**灾害取色（同时来多种时取第一种，够用了）
  // 罩色表在 config 的 `DISASTER_TINT` —— 它是"每个灾害一张脸"的身份色（本轮去掉了里面的冷色）。
  // ⚠️ 兜底用 `sinkhole` 那支暖棕，不再另写一个字面量：灾害 id 对不上时，整屏罩色绝不该是 undefined
  //    （`DISASTER_TINT` 的键名有启动自检兜着，这里只是防御"id 存在但表里漏了"）。
  s.tint = s.director.phase === Phase.DISASTER && s.director.active.length
    ? (DISASTER_TINT[s.director.active[0].id] || DISASTER_TINT.sinkhole)
    : null;

  if (s.director.wave !== s.lastWave) {
    s.checkpointDue = true;
    s.lastDefense = null;
    const prevWave = s.lastWave;
    s.lastWave = s.director.wave;
    // ⚠️ **两层都要重新生成**（必须在下面对地形吸附之前做完）—— 而且最后**必须切回玩家所在的层**：
    //    `onWaveStart` 内部会 setLayer（生成哪层就切到哪层），不切回来的话，
    //    生成完地下之后"当前层"会停在地下 → 人物的 y 会按地下地形算（穿到地里）。
    // ⚠️ 2026-09-29（用户报 bug）：换波会把**两层地图全部重建**（下面就重建），
    //    旧图上的暂存堆**再也没有机会回收** —— 玩家"站在废墟旁挖着挖着换波了"就会静默失去那几块料。
    //    所以必须在重建**之前**先收一次。⚠️ 不能放到重建之后：那时 `s.world` 已经指向新图，
    //    靠 `nearSpot` 变化触发的那条收取路径再也不会有机会跑（`nearSpot` 已被清成 null）。
    //    ⚠️ 这条横幅随后会被波次横幅顶掉 —— 收下的料进了背包，不吭声也比丢掉好。
    collectPending(s.nearSpot);
    s.worldGround.onWaveStart();
    s.worldUnder.onWaveStart();
    switchLayer(s.layer);   // 把四处指针切回玩家所在的那层（见 switchLayer 的注释）
    // ⚠️ 2026-09-27：每波**换图**（地形/岩桥/升降台都重新生成）→ 人物可能正站在
    //    "已经被换掉的地面"上（悬空、或者埋进土里）。所以换图后必须把脚底**重新吸附到新地形**，
    //    并取消上升（落点那条桥可能已经不存在了）。
    s.player.lifting = null;
    s.player.y = terrainY(s.player.x);
    s.player.vy = 0;
    s.player.onGround = true;
    s.approachSpot = null;
    s.nearSpot = null;
    s.approachBreak = null;
    s.pendingBreak = null;
    s.explored = { min: 1e9, max: -1e9 };   // 新地图 → 小地图重新点亮
    s.fade = null;                    // 隧道也重新生成了（见 world 的 genTunnels）；顺带清掉任何没走完的过渡

    // 撑过一波 → 主角回血（2026-09-26 用户决定："每波恢复固定量"，不回满）。
    // ⚠️ 必须在这里（波次切换）而**不是**在灾害期结束时回 —— 这样和 tools/simulate.js 的
    //    标定模型是同一条规则（工具里也是"每波伤害结算完就回一次"）。
    //    规则本身在 config.js 的 healAfterWave，两边共用，避免标定的数和游戏跑的数不一致。
    if (prevWave >= 1 && !s.player.dead) {
      const before = s.player.hp;
      s.player.hp = healAfterWave(s.player.hp);
      s._healed = Math.round(s.player.hp - before);
    }

    // 撑过一波 → **再发一个"扩展空位"额度**（2026-09-26 用户要求：补漏位改成会成长的）。
    // ⚠️ 判定用**刚结束的那一波**（prevWave）：第 1 波结束发第 1 个 …… 第 8 波结束发第 8 个，
    //    第 9 波之后不再发 —— 用户原话"第 8 波灾难后就不给了"。
    //    grantBonusSlot() 内部还有一道 bonusTotal 封顶，所以无尽模式也不会超发。
    s._slotGranted = false;
    if (prevWave >= 1 && prevWave <= SHELTER_SLOTS.bonusTotal && !s.player.dead) {
      s._slotGranted = s.shelter.grantBonusSlot();
    }

    // 撑过第 5 波 → **多一个工作台**（2026-09-27 用户要求："第 5 波后，再增加一个工作台"）。
    // ⚠️ 判定用**刚结束的那一波**（prevWave）：prevWave === 5 时正好是第 6 波的准备期，
    //    台子当场出现在庇护所里、这一波就能用上 —— 两个台子可以**同时各跑一件**。
    // ⚠️ 上限由 config 的 `WORKBENCH.offs` 决定（位置表里有几个就最多放几个），
    //    所以无尽模式不会越玩越多台子；也不会出现"台子数超过位置数"导致它们叠在一起。
    s._benchAdded = false;
    if (prevWave >= 5 && !s.player.dead && s.workbenches.length < workbenchCapacity()) {
      s.workbenches.push(new Workbench());
      s._benchAdded = true;
    }

    // ⚠️ 这里**不要**把 s.repairOpen 清空。
    //    材料是跨波留在背包/仓库里的，所以它"已消耗多少"也必须跨波保留。
    //    曾经在这里写了 s.repairOpen = null，后果就是：每次换波都把正在消耗的那份的进度丢掉，
    //    材料还挂在库存里、却永远用不尽 → 玩家看到"修复材料一直不消失"。
    if (s.director.phase === Phase.PREP) {
      const isLast = !s.director.endless && s.director.wave === WIN_WAVE;
      const heal = s._healed > 0 ? ` · 回血 +${s._healed}` : '';
      const slot = s._slotGranted ? ` · 空位 +1（待放 ${s.shelter.bonusSlots}）` : '';
      const bench = s._benchAdded ? ' · 工作台 +1（现在 2 个，可以同时合成两件）' : '';
      banner(
        s.director.endless ? `第 ${s.director.wave} 波 · 无尽` : `第 ${s.director.wave}/${WIN_WAVE} 波 · 准备期`,
        (isLast ? `最后一波：${s.director.upcomingNames.join(' + ')} —— 撑过去就通关`
          : s.showForecast ? `下一波：${s.director.upcomingNames.join(' + ')}` : '准备时间开始')
          + ' · 地形重排（每波换图）' + heal + slot + bench,
        isLast ? UI_SKIN.hi : UI_SKIN.ok,
        isLast ? 3.2 : 2.2);
    }
  }

  if (s.director.phase === Phase.DISASTER && !s._disasterAnnounced) {
    experience?.sound('warning', 3);
    s._disasterAnnounced = true;
    const names = s.director.active.map((d) => d.name).join(' + ');
    // ⚠️ 灾害期不能待在地下 → **把已经在地下的人震回地面**（分层世界）。
    //    只禁"再下去"是不够的：那样玩家可以卡在灾害开始前下去、然后整波躲着。
    if (s.layer === 'under') {
      switchLayer('ground');
      s.player.x = 40 + s.rng() * (WORLD.width - 80);
      s.player.targetX = null;
      s.player.y = terrainY(s.player.x);   // ⚠️ 两层地面高度不同 → 换层必须重新贴地
      s.player.vy = 0;
      s.player.onGround = true;
      s.approachSpot = null;
      s.pendingDig = null;
      s.approachBreak = null;
      s.pendingBreak = null;
      s.explored = { min: 1e9, max: -1e9 };
      updateCamera();
      banner('被震回地面', '灾害期地穴会塌 —— 被抛到地表随机位置', UI_SKIN.warn, 3);
    } else if (!inShelterRange()) {
      // 玩家还在外面 —— 2026-09-26 取消安全区之后，外面不但会挨全额伤害，
      // **庇护所也照样在挨打**，所以这波是双向损失，必须马上警告。
      banner('暴露在灾害中', `${names} 来袭 · 庇护所和你同时受到攻击`, UI_SKIN.danger, 3.2);
    } else {
      banner(`${names} 来袭`, s.mode === 'tutorial' ? s.director.active.map((d) => d.hint).join('；')
        : `第 ${s.director.wave} 波 · 灾害期`, UI_SKIN.warn, 2.4);
    }
  }
  if (s.director.phase === Phase.PREP) s._disasterAnnounced = false;

  if (s.shake > 0) s.shake = Math.max(0, s.shake - rawDt * 2.2);
  if (s.quakeT > 0) s.quakeT = Math.max(0, s.quakeT - rawDt);
  s.effects = s.effects.filter((e) => { e.t += rawDt; return e.t < e.dur; });

  // 两种结局：先判死亡（灾害期被打死也可能正好在第 12 波），再判通关
  if (s.player.dead && !s.endSummary) {
    s.checkpointDue = true;
    s.director.die();
    // 死因取**致死那一击**（killedBy），不是"第一次挨打"
    s.endSummary = {
      win: false,
      wave: s.director.wave,
      cause: CAUSE_LABEL[s.killedBy] || '力竭而亡',
    };
  }
  if (!s.endSummary && s.director.phase === Phase.WIN) {
    s.checkpointDue = true;
    s.endSummary = { win: true, wave: s.director.wave, cause: null };
  }
}

/** 通关后选"继续挑战"：波次无限外推，不再有终点，只记能撑到第几波 */
function startEndless() {
  if (!s.endSummary || !s.endSummary.win) return;
  s.endSummary = null;
  s.endless = true;
  s.director.enterEndless();
  banner('无尽模式', `从第 ${s.director.wave} 波开始 —— 没有终点了，看你能撑到第几波`, UI_SKIN.hi, 3.2);
}

function spawnEffect(ev) {
  const px = s.player.x;
  // ⚠️ 2026-09-27：不能再写死 `WORLD.groundY - 44` —— 加了台地与上层岩桥之后，
  //    主角的脚底高度会差 300px，特效会画到地面上、和人对不上。
  const py = s.player.y - 44;
  const onPlayer = () => s.effects.push({
    type: ev.disaster === 'lightning' ? 'bolt' : 'impact',
    x: px, y: py, t: 0, dur: ev.disaster === 'lightning' ? 0.28 : 0.34,
  });

  // 屋外受击仍保留天空灾害和屋外龙卷风的场景效果。
  if (ev.hitPlayer) {
    if (['tornado', 'meteor', 'beam', 'sinkhole'].includes(ev.disaster)) {
      for (const fx of fxSpritesFor(ev.disaster, 'roof', px)) s.effects.push(fx);
    }
    onPlayer(); return;
  }

  // 打在墙上的部分：取该灾害的**第一个目标面**（多面灾害如龙卷风只画一处，够用了）
  const d = DISASTERS[ev.disaster];
  const faceId = (ev.deadFaces && ev.deadFaces[0]) || (d && d.faces[0]);
  const r = SHAPE[faceId];
  const cx = r ? r.x + r.w / 2 : SHELTER.cx;
  const cy = r ? r.y : WORLD.groundY - SHELTER.rise;
  if (ev.disaster === 'lightning') {
    // ⚠️ 雷电**保留代码画**（2026-10-04 用户定）：折线每帧随机才是"电光闪烁"，换成固定贴图反而假。
    s.effects.push({ type: 'bolt', x: cx, y: cy, t: 0, dur: 0.28 });
  }
  if (ev.damage > 0) {
    s.effects.push({ type: 'impact', x: cx, y: cy, t: 0, dur: 0.34 });
  }
  // 灾害精灵（2026-10-04）：陨石 / 龙卷风 / 死亡光束 / 毒雾 / 地陷裂纹 / 兽潮（待出图）。
  // ⚠️ 位置**在 `fxSpritesFor` 里算**（只有 `FX_TEX` 知道每张精灵的 w/h），这里只管 push。
  // ⚠️ 地陷原来那条"代码画折线"已经并进这张表（`FX_TEX.crack`），别再往这里加回来。
  for (const fx of fxSpritesFor(ev.disaster, faceId)) s.effects.push(fx);

  // 漏到主角身上的那部分（穿墙没挡住 / 破面）→ 特效也必须画在**主角**身上。
  // 否则玩家看到的画面和"灾害正常打在墙上"完全一样，等于没有提示。
  if (ev.playerDamage > 0) onPlayer();
}

experience = createExperience({
  state: () => s, pause: pauseGame, resume: resumeGame,
  begin: startGame, tutorial: startTutorial, home: showHome,
  move: (dir) => {
    if (!dir) { touchDirection = 0; return; }
    if (!s || s.paused || s.endSummary) return;
    touchDirection = dir;
    clearKeys();
    s.player.targetX = null;
    s.approachSpot = null; s.approachBreak = null;
    s.pendingDig = null; s.pendingBreak = null;
  },
  jump: jumpPlayer,
  light: () => { s.flashlight = !s.flashlight; },
  restart: () => {
    if (s.mode === 'tutorial') startTutorial();
    else { newGame(); experience.hideHome(); saveCheckpoint(); startLoop(); }
  },
  install: dropOnFace,
  beginItemDrag: (item, e) => {
    if (!inBuildZone() || s.shelter.storeAtFlat(item.from.index) !== item.mat) return;
    const pt = toCanvas(e);
    s.drag = { ...item, x: pt.x, y: pt.y };
    s.activePointerId = e.pointerId;
    s.dragTarget = computeDragTarget(pt);
    canvas.setPointerCapture(e.pointerId);
  },
  openCraft: openSynthPanel,
  pickCraft: synthPickOption,
  startCraft: startSynth,
  takeCraft: tapWorkbench,
  remove: pickPatchBack,
  confirmRemoval: (q) => {
    const pos = s.shelter.face(q.faceId)?.positions[q.posIndex];
    if (pos?.mat === q.mat && !s.shelter.canRecoverAt(q.faceId, q.posIndex) && inBuildZone()) {
      s.shelter.removeAt(q.faceId, q.posIndex);
      banner('已拆除并报废', MATERIALS[q.mat].name, UI_SKIN.warn, 2);
    }
  },
  transfer: (item) => {
    const source = item.from.type === 'bag' ? s.player.carry[item.from.index] : s.shelter.storeAtFlat(item.from.index);
    if (!inBuildZone() || source !== item.mat) return;
    if (item.from.type === 'bag') {
      if (s.shelter.storeAdd(item.mat)) {
        s.player.carry.splice(item.from.index, 1);
      }
      else banner('仓库分区已满', '先取出一件材料再存入', UI_SKIN.warn, 2);
    } else if (!s.player.isFull && s.shelter.storeRemoveOne(item.mat)) s.player.carry.push(item.mat);
    else banner('背包已满', '先腾出一个格子', UI_SKIN.warn, 2);
  },
});
document.addEventListener('pointerdown', () => experience.unlockAudio(), { passive: true });
showHome();
startLoop();
