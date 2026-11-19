// 场景布局 + 每波刷新材料点
//
// 探索设计：
//   1. 距离梯度 —— 近区只出基础料，深区只出进阶件，但塌方概率也高
//   2. 位置随机 —— 每波材料点位置都在各自区间内抖动，不能靠背地图
//   3. 多层挖掘 —— 每次点击深入一层，越深越稀有（见 config.js 的 DIG）
//   4. 挖出前不知道是什么 —— 所有料堆外观完全一样
// 详见 docs/01 第 9 节

import {
  SHELTER, WORLD, ZONES, LOOT_RULES, LOOT_CATEGORY_WEIGHTS, PLAYER,
  RUIN_TYPES, caveInChance, TERRAIN, PLATFORMS, LIFTS, HIDDEN, TUNNELS, LEDGES,
  RULES, JUMP, UNDERWORLD, T7_RUIN, rollDepth,
} from './config.js';

const G = WORLD.groundY;
const L = SHELTER.cx - SHELTER.halfWidth;
const R = SHELTER.cx + SHELTER.halfWidth;
const T = SHELTER.wallThickness;
const roofBottom = G - SHELTER.rise;

/** 五个面的渲染/交互矩形（世界坐标） */
export function shelterRects() {
  return {
    roof:  { x: L, y: roofBottom - T, w: R - L, h: T },
    left:  { x: L, y: roofBottom, w: T, h: SHELTER.rise / 2 },
    door:  { x: L, y: roofBottom + SHELTER.rise / 2, w: T, h: SHELTER.rise / 2 },
    right: { x: R - T, y: roofBottom, w: T, h: SHELTER.rise },
    base:  { x: L, y: G, w: R - L, h: 26 },
  };
}

export const LOOT_Y = G - 14;

/**
 * 玩家是否**站在这一堆旁边**（能挖它，也能在走开时收走它的暂存堆）。
 *
 * ⚠️⚠️ 必须同时看 x 和 y —— 这是 2026-09-27 用户报的 bug 的根因：
 *    岩桥上的废墟和它**正下方**的地面废墟，x 可能只差几十 px（桥宽 200~320、
 *    废墟落在桥的中段，而地面废墟每隔 ~78px 就有一个）。
 *    只比 x 的话，`loot.find(...)` 永远返回**数组里靠前的那个**（地面废墟先 push），
 *    于是"站在桥上挖出来的材料"被算成"地面上那一堆的暂存"，走开时收的是空的那堆 →
 *    **桥上的材料永远进不了背包**，桥上的废墟也永远不会被消耗/复位。
 *
 * ⚠️ 同一个判定必须用在**挖、敲、收**三处 —— 只改其中一处就会出现
 *    "挖得到但收不走"或"收得走但挖不动"的错位（见 docs/04）。
 * 碎石堆、地穴和隧道也使用同样的水平／高度范围，远处点击不自动靠近。
 * @param {{x:number,y:number}} spot 料堆 / 碎石堆（只用到 x、y）
 */
export function atSpot(spot, px, py) {
  return Math.abs(spot.x - px) < PLAYER.digRadius
    && Math.abs(spot.y - py) < PLAYER.digVertTol;
}

// ============================================================
// 分层（2026-09-27 第四轮：**地下世界**）
// ============================================================
// 设计（用户选的是"分层世界"这条路线）：地面放**地穴入口**，点它切到"地下层"。
//
// ⚠️ 核心做法：把"层"实现成**当前生效数据的指针**（`CUR` + `setLayer`）。
//    于是 `terrainRise / platformsAt / surfaceAt / shelves / tunnels ...` 这些查询函数
//    全都**自动跟着当前层走** —— 撒点、物理、渲染一行都不用改（它们读的就是"当前层"）。
//    这比"到处传 layer 参数"或"每个调用方都判断在哪层"省太多事。
//
// ⚠️ 分层状态放在这里、**不是 config**：config 是"参数"，而这是每波会变的运行时数据
//    （和 PLATFORMS.list 那种"配置里留一个空数组当指针"是同一个套路）。
let PROFILE = null;   // **当前层**的地形剖面（setLayer 把它指向 LAYERS[CUR].profile）
let SHELVES = [];     // **当前层**的岩棚
const LAYERS = {
  ground: { profile: null, shelves: [], platforms: [], lifts: [], ledges: [], tunnels: [], entrances: [] },
  under:  { profile: null, shelves: [], platforms: [], lifts: [], ledges: [], tunnels: [], entrances: [] },
};
let CUR = 'ground';

/**
 * 切换"当前生效的层"。
 * ⚠️ 它把**所有"当前层数据"的指针**一次性切过去（剖面 / 岩棚 / 桥 / 升降台 / 石台 / 隧道）——
 *    于是 render/main 读 `PLATFORMS.list`、物理读 `terrainRise(x)` 时拿到的永远是当前层，
 *    不需要任何改动。这是整个分层方案能省事的关键一步。
 */
export function setLayer(name) {
  CUR = name === 'under' ? 'under' : 'ground';
  const L = LAYERS[CUR];
  PROFILE = L.profile;
  SHELVES = L.shelves;
  PLATFORMS.list = L.platforms;
  LIFTS.list = L.lifts;
  LEDGES.list = L.ledges;
  TUNNELS.list = L.tunnels;
}

export function currentLayer() { return CUR; }

/** 存档必须包含两层的地形与通道；只保存 World.loot 会在刷新后换图。 */
export function snapshotLayers() { return JSON.parse(JSON.stringify(LAYERS)); }
export function restoreLayers(data) {
  for (const name of ['ground', 'under']) Object.assign(LAYERS[name], data[name]);
  setLayer(CUR);
}

/**
 * 生成本层的**出入口**：
 *   · 地面层 = **地穴入口**（点它下到地下）
 *   · 地下层 = **上行口**（点它回地面）
 * ⚠️ 两层都要生成 —— 只给地面生成的话，玩家下去就上不来了。
 *    （出口也会画在小地图上：不然"下去了找不到路回来"是纯粹的挫败，不是难度）
 */
export function genEntrances(rng, layer = 'ground') {
  const L = LAYERS[layer];
  // ⚠️ 2026-09-28（用户："不要废墟与通道挤在一起"）：地穴入口也要避让**已经放好的**通道类物件
  //    （升降台 + 隧道两端）和**彼此**。它是这条生成链的最后一环（升降台 → 隧道 → 入口 → 废墟）。
  //    ⚠️ 用"撒 N 个候选取最不挤的那个"而不是"重试到合规"：世界虽有 4800 宽，
  //       但"离中轴 450~2100"这个环状区间和两个升降台、四个隧道口可能撞在一起 ——
  //       本项目在窄区间里踩过"硬约束可行域是空集"的坑（见 docs/04），所以一律用软约束。
  const fixed = [...L.lifts.map((k) => k.x), ...L.tunnels.flatMap((t) => [t.a.x, t.b.x])];
  const out = [];
  const [lo, hi] = UNDERWORLD.entranceCount;
  const n = lo + Math.floor(rng() * (hi - lo + 1));
  const [d0, d1] = UNDERWORLD.entranceDist;
  const pickX = () => Math.round(SHELTER.cx + (rng() < 0.5 ? -1 : 1) * (d0 + rng() * (d1 - d0)));
  for (let i = 0; i < n; i++) {
    let bestX = pickX();
    let bestScore = -Infinity;
    for (let t = 0; t < 24; t++) {
      const cand = pickX();
      let dFixed = Infinity;
      let dEnt = Infinity;
      for (const v of fixed) { const g = Math.abs(v - cand); if (g < dFixed) dFixed = g; }
      for (const e of out) { const g = Math.abs(e.x - cand); if (g < dEnt) dEnt = g; }
      const score = Math.min(dFixed - LOOT_RULES.worldGap, dEnt - LOOT_RULES.worldGap);
      if (score > bestScore) { bestScore = score; bestX = cand; }
      if (dFixed >= LOOT_RULES.worldGap && dEnt >= LOOT_RULES.worldGap) break;
    }
    out.push({ x: bestX });
  }
  out.sort((a, b) => a.x - b.x);
  LAYERS[layer].entrances = out;
}

/** 当前层的地穴入口（地下层为空 —— 出口是另外的东西） */
export function entrances() { return LAYERS[CUR].entrances; }

/**
 * 本层所有"**通道类物件**"的 x —— 地穴入口/上行口 + 隧道两端 + 升降台。
 *
 * ⚠️ 2026-09-28 新增（用户："不要废墟与通道挤在一起，相互重叠了"）：
 *    这些东西是**先于废墟**生成的（`genLifts` → `genTunnels` → `genEntrances` → 废墟），
 *    而且位置全是随机的、彼此也不知道对方在哪 —— 所以"不叠在一起"只能由
 *    **最后生成的废墟**去避让（间距 = `LOOT_RULES.worldGap`）。
 * ⚠️ 一律读 `LAYERS[layer]`，不读模块级的 `LIFTS` / `TUNNELS` 指针：
 *    那两个指针的含义是"**当前显示**的层"，而这里是"**正在生成**的层"，生成期两者未必一致。
 */
function passageXs(layer) {
  const L = LAYERS[layer];
  return [
    ...L.entrances.map((e) => e.x),
    ...L.tunnels.flatMap((t) => [t.a.x, t.b.x]),
    ...L.lifts.map((k) => k.x),
  ];
}

/** 跳跃能上多高（由 JUMP 参数推导，别写死 —— 改跳跃参数时它会跟着变） */
export function jumpHeight() {
  return (JUMP.speed * JUMP.speed) / (2 * JUMP.gravity);
}

/**
 * 生成本波的地形剖面。
 *   · 从庇护所**往外**分段：每段宽 `segW` 随机、高度**有升有降**（`±maxDelta` 随机）
 *   · 庇护所 ±`flatRadius` 内压平
 *   · 越远越"险"（地形起伏依旧，但**不再是单调上坡** —— 每段有升有降，见下面的偏置说明）
 * ⚠️ 生成后**必须自检相邻段高差 ≤ 跳跃高度** —— 这是"不会生成走不过去的死图"的唯一保证。
 *    一旦哪天把 `maxDelta` 调大了，这里就会在**生成那一刻**抛错（而不是让玩家走到半路卡死）。
 */
export function genTerrain(rng, layer = CUR) {
  const cx = SHELTER.cx;
  const flat = TERRAIN.flatRadius;
  const rand = (a, b) => a + rng() * (b - a);
  const segs = [];

  // ⚠️ 2026-09-27 用户："随便把地下的空地补好吧" —— **地下不再照搬地面的"庇护所附近压平"**。
  //    这条规则（`TERRAIN.flatRadius = 350`）本来是给地面用的：不压平的话台地会把庇护所埋进土里。
  //    可地下**根本没有庇护所**，照抄的结果是地下中段多出一条 **700px 的平地**（配合同一段没有废墟
  //    → 那就是用户一直说的"地下有一片比较空旷"）。
  //    · 地面：仍然从 `cx ± flat` 往外走，中间那一段由下面的压平段补上
  //    · 地下：**从 cx 直接往外走**（左右各一条），压平段也不推 → 中段有正常起伏
  //    ⚠️ 可达性不受影响：相邻段高差仍受 `maxDelta ≤ jumpHeight` 的自检约束（见函数末尾）。
  for (const dir of [-1, 1]) {
    let x = layer === 'ground' ? cx + dir * flat : cx;   // 地下从中心起步
    let h = 0;
    let lastSteep = false;          // 上一段是不是坎（用来禁止"坎连着坎"，见下面那段 ⚠️）
    while (dir < 0 ? x > 0 : x < WORLD.width) {
      // ---- ① 方向（带回归偏置）----
      //     原来每段只加不减（`h + rand(0, maxDelta)`）→ 从庇护所往外**一路上坡**，
      //     看起来像一条斜坡、不像地形。现在改成**有升有降**：
      //   · 方向按当前高度做**回归偏置**：贴近地面时更可能升、贴近上限时更可能降,
      //     否则会在边界上长期"贴平"成高原/平原（那又变成单调了）
      //   · 再叠一点**向上趋势**（`trend`），让远处平均略高一点 —— 保留"越远越险"的感觉
      const up = h / TERRAIN.maxRise;                       // 0 = 贴地，1 = 顶到上限
      const bias = 0.5 + TERRAIN.trend - (up - 0.5) * 0.8;
      const sign = rng() < bias ? 1 : -1;
      const room = sign > 0 ? TERRAIN.maxRise - h : h;

      // ---- ② 坡型 + 段宽（2026-10-03）----
      // **坡段**：宽 `segW`、高差 ≤ `maxDelta` → 坡度 ≤ 48/90 = 0.53（28°），能走
      // **坎段**：**高差取满、段宽由目标坡度反推**（`maxDelta / steepSlope` ≈ 8px）
      //          → 视觉上就是**一道垂直岩壁**，要跳。⚠️ 顺序反了就做不出来：
      //          先定宽段再定高差的话，8px 的段宽在 `segW` 的随机范围里根本抽不到。
      // ⚠️⚠️ **坎不能连着坎**。实测踩到的：连续两段都是坎时会形成
      //     "8px 下坡坎 + 8px 上坡坎"的**锯齿**（剖面 365→373→381，每 8px 一个）。
      //     玩家在锯齿里前瞻 6px **永远落在谷底**，落差最大只到 10（阈值 12）→ 判定形同虚设
      //     —— 实测漏网的那 1/7 全是这种。用户要的是"坡 + **偶尔**一道垂直岩壁"，不是锯齿。
      const steep = !lastSteep && rng() < TERRAIN.steepChance && room >= TERRAIN.steepMinRise;
      lastSteep = steep;
      let w, fixedDelta = null;
      if (steep) {
        fixedDelta = Math.min(TERRAIN.maxDelta, room);
        w = Math.max(2, Math.round(fixedDelta / TERRAIN.steepSlope));
      } else {
        w = Math.round(rand(TERRAIN.segW[0], TERRAIN.segW[1]));
      }
      const next = dir < 0 ? Math.max(0, x - w) : Math.min(WORLD.width, x + w);
      // ⚠️ 坡度要用**实际段宽**算：挨着世界两端时 `next` 会被 clamp 到 0 / WORLD.width，
      //    实际宽度比设计值短（实测设计 160 被裁成 108），同一个 delta 的坡度会凭空大 48%。
      const segW = Math.abs(next - x);

      // ---- ③ 高差 ----
      let delta;
      if (fixedDelta !== null) {
        delta = fixedDelta;                                  // 坎：取满
      } else {
        // 坡：按**实际** segW 限坡度（留 30% 余量，别贴着判定阈值）
        const capSlope = Math.floor(segW * TERRAIN.maxSlope * 0.7);
        delta = Math.floor(rng() * (Math.min(TERRAIN.maxDelta, capSlope, room) + 1));
      }

      const hPrev = h;                       // 这一段的**起点**（生成时的出发端）高度
      h += sign * delta;                     // 现在 h 是**终点**高度
      // ⚠️⚠️ 段存**两个端点**的高度（`riseL` = x 较小端 / `riseR` = x 较大端），而不是单一 `rise`。
      //    因为左右两半的**生成方向相反**（左半 x 递减、右半 x 递增），用单一 `rise` 就必然要
      //    在别处猜"它到底指哪一端" —— 自检和插值都会猜错（本次在这上面栽了两次）。
      //    存两端之后：插值不依赖邻居、自检用自己的 `delta`，两处都**结构上不可能错配**。
      const riseL = dir > 0 ? hPrev : h;
      const riseR = dir > 0 ? h : hPrev;
      segs.push({ x0: Math.min(x, next), x1: Math.max(x, next), riseL, riseR, delta, steep });
      x = next;
      if (next === 0 || next === WORLD.width) break;
    }
  }
  // 庇护所压平区 —— **只有地面层有**（地下没有庇护所，见上面的注释）
  // ⚠️ 它的 `riseL/riseR` 必须一起给：渲染要拿它们拼折线（少了就是 `undefined` → NaN）。
  if (layer === 'ground') segs.push({ x0: cx - flat, x1: cx + flat, riseL: 0, riseR: 0, delta: 0 });
  segs.sort((a, b) => a.x0 - b.x0);
  LAYERS[layer].profile = segs;
  if (layer === CUR) setLayer(layer);   // 生成的就是当前层 → 立刻让查询读到新剖面

  // 自检①：相邻段高差不能超过跳跃高度（否则会出现"跳不上去 = 走不过去"的死图）
  const limit = jumpHeight();
  for (let i = 1; i < segs.length; i++) {
    const d = Math.abs(segs[i].rise - segs[i - 1].rise);
    if (d > limit) {
      throw new Error(
        `地形生成自检没过：相邻段高差 ${d}px 超过跳跃高度 ${limit.toFixed(1)}px → 会生成走不过去的死图。`
        + `（检查 config 的 TERRAIN.maxDelta 是否被调大）`);
    }
  }
  // 自检②（2026-10-03 加）：**坡段不能太陡、坎段不能不够陡** ——
  //   两者之间留一条安全带（`maxSlope × 0.7` ~ `maxSlope × 1.3`），谁都不许踩进去。
  // ⚠️ 为什么：`player.move()` 是在"前方 `slopeProbe`(6px)"上量坡度的，踩在阈值附近的段会
  //    **一会儿能走、一会儿不能**（由取整噪声决定）—— 没法复现，玩家只会觉得"卡"。
  // ⚠️ 用段**自己的** `delta` 和 `steep` 标记，**不要靠"相邻两段"去推断** ——
  //    左右两半的生成方向相反，`sort()` 之后配对会错配到另一段上（本次在这上面栽了两次，见 docs/04）。
  // ⚠️ `delta === 0` 的段放行：压平段、以及任何原地不动的段都合法。
  const slopeBad = [];
  for (const s of segs) {
    const w = s.x1 - s.x0;
    if (w <= 0 || !s.delta) continue;
    const slope = s.delta / w;
    if (s.steep) {
      const need = TERRAIN.maxSlope * 1.3;
      if (slope < need) slopeBad.push(`坎 x=${s.x0}~${s.x1} 只有 ${slope.toFixed(2)}（要求 ≥ ${need.toFixed(2)}）`);
    } else {
      const cap = TERRAIN.maxSlope * 0.7;
      if (slope > cap) slopeBad.push(`坡 x=${s.x0}~${s.x1} 陡到 ${slope.toFixed(2)}（要求 ≤ ${cap.toFixed(2)}）`);
    }
  }
  if (slopeBad.length) {
    throw new Error(
      `地形生成自检没过：有 ${slopeBad.length} 段的坡度踩在判定阈值的安全带里`
      + `（${(TERRAIN.maxSlope * 0.7).toFixed(2)} ~ ${(TERRAIN.maxSlope * 1.3).toFixed(2)}）`
      + ` → 同一段坡会"一会儿能走、一会儿不能"。${slopeBad.slice(0, 3).join(' / ')}`);
  }
}

/**
 * 某处地面比基准高多少（>= 0，只向上隆起）。见 config 的 TERRAIN 注释。
 * ⚠️ 现在是**查表 + 折线插值**（每波生成），不再是数学函数。
 * ⚠️ 2026-10-03：级与级之间已从"阶跃（垂直岩壁）"改成**斜坡**（用户："不要明显的阶梯感"）。
 *    于是"阶跃挡人"那套失效了（贴地吸附每帧只升 1~2px）→ 挡住人的判定改成**按坡度**，
 *    在 `player.move()` 里量。见那里的注释与 config 顶部的说明。
 */
export function terrainRise(x) {
  // ⚠️ 压平区**只在有庇护所的那一层**成立（2026-09-27）—— 它比剖面表优先级更高，
  //    所以哪怕 `genTerrain` 已经不往地下推那段平面了，只要这里不按层判断，地下中段照样恒为 0。
  if (CUR === 'ground' && x >= SHELTER.cx - TERRAIN.flatRadius && x <= SHELTER.cx + TERRAIN.flatRadius) return 0;
  if (!PROFILE) return 0;
  // ⚠️ 折线插值：直接用**段自己的两个端点**（`riseL` / `riseR`）。
  //    不再拿"上一段的 rise"当本段左端 —— 那在左半（x 递减生成）会取到本段的**右端**，方向就反了。
  for (const s of PROFILE) {
    if (x < s.x0 || x > s.x1) continue;
    const w = s.x1 - s.x0;
    if (w <= 0) return s.riseR;
    return s.riseL + (s.riseR - s.riseL) * ((x - s.x0) / w);
  }
  return 0;   // 段之间理论上无缝，这里是兜底
}

/** 给调试/小地图用：当前地形剖面（只读） */
export function terrainProfile() {
  return PROFILE;
}

/**
 * 如果 `x` 落在某个**坎段**里（坡度 > `maxSlope` 的陡面）→ 返回它**下坡那一侧的边缘 x**；否则 null。
 *
 * ⚠️ 为什么需要它（2026-10-05）：坎面只有 **8px 宽**，玩家一旦落在上面，就会被 `player.move()`
 *    的坡度检查挡住（前方更高）而**又不会掉下去** —— 表现为"卡在陡坡半腰"（用户报的
 *    "没跳上陡坡会掉下来，不是卡在那里"）。所以 `player._vertical()` 每帧用它做一次校正：
 *    只要脚底已经贴到/低于坎面，就把人**推出到下坡侧边缘**（坎脚），再交回重力。
 * ⚠️ 端点（`x0` / `x1`）**不算在里面** —— 否则站在坎顶/坎脚那条线上的人会被推走。
 * @returns {number|null}
 */
export function steepFaceDownhillEdge(x) {
  if (!PROFILE) return null;
  for (const s of PROFILE) {
    if (!s.steep) continue;
    if (x <= s.x0 || x >= s.x1) continue;
    // rise 越大越高：右端更高 → 上坡在右 → 下坡侧是左端（把人推回坎脚）
    return s.riseR > s.riseL ? s.x0 - 0.5 : s.x1 + 0.5;
  }
  return null;
}

/** 某处地面的 y 坐标（世界坐标，越小越高） */
export function terrainY(x) {
  return G - terrainRise(x);
}

/** 某处算不算"高处"（可以躲地陷） */
export function isHighGround(x) {
  return terrainRise(x) >= TERRAIN.highGround;
}

/** 本层的岩棚列表（每波换图，见 genShelves）。⚠️ 调用方只读，不要改它 */
export function shelves() { return SHELVES; }

/**
 * 生成本波的岩棚（突出岩架）—— 站到它下面能躲陨石。
 * 位置：**中区以外**（那里才有"需要躲"的压力），左右各 `shelfCount` 个，避开庇护所压平区。
 * ⚠️ 它只看 x（与地形高度无关），所以"岩棚下面的地面是高是低"每波都不一样 ——
 *    这正是"每波陌生地图"的一部分：这一波的避难点在别的地方。
 */
export function genShelves(rng, layer = CUR) {
  const out = [];
  const [lo, hi] = TERRAIN.shelfCount;
  const half = WORLD.width / 2;
  for (const dir of [-1, 1]) {
    const n = lo + Math.floor(rng() * (hi - lo + 1));
    for (let i = 0; i < n; i++) {
      const d = TERRAIN.flatRadius + 150 + rng() * (half - TERRAIN.flatRadius - 300);
      out.push({ x: Math.round(SHELTER.cx + dir * d) });
    }
  }
  out.sort((a, b) => a.x - b.x);
  LAYERS[layer].shelves = out;
  if (layer === CUR) setLayer(layer);
}

/** 主角是不是站在某个岩棚下面（可以躲陨石） */
export function underShelf(x) {
  for (const s of SHELVES) {
    if (Math.abs(x - s.x) <= TERRAIN.shelfW / 2) return true;
  }
  return false;
}

/**
 * 地形躲避判定 —— 只有两种灾害躲得掉（2026-09-26 用户要求原话：
 * "可以找地形躲避陨石，也可以站高处躲避地陷，其他的就躲避不了"）。
 * @returns {'occluder'|'highground'|null}
 */
export function terrainDodge(disaster) {
  if (disaster.id === 'meteor') return underShelf(PLAYER_X) ? 'occluder' : null;
  if (disaster.id === 'sinkhole') return isHighGround(PLAYER_X) ? 'highground' : null;
  return null;
}

// ⚠️ 上面这个函数要读主角的 x，但它不该依赖 main 里的状态（会被循环 import）。
//    所以由 main 每次结算前写一次这个变量 —— 简单、无依赖。
let PLAYER_X = 0;
export function setDodgePlayerX(x) { PLAYER_X = x; }

// ============================================================
// 可站立平台与"地面查询"（2026-09-27 新增，配合台地地形与上层岩桥）
// ============================================================
// ⚠️ 这是本作第一次有"脚能踩、但不是地面"的东西。三个函数分工明确：
//   · platformsAt(x)      这个 x 上方横向有哪些平台
//   · surfaceAt(x, y)     贴地行走时脚下踩的是哪个面（地形 / 平台）
//   · crossedSurface(...) 这一帧下落**跨过**了哪个面（决定落在哪）
//     后两者的区别正是**单向平台**的关键：上升时穿过去、下落时踩住。
// ⚠️ 平台只按顶面判定（`PLATFORMS.thickness` 是纯视觉），所以不存在"撞到平台底部"。
const SURF_EPS = 0.5;

export function platformsAt(x) {
  const out = [];
  // ⚠️ 岩桥和**天然石台**共用这一套查询 —— 于是石台自动获得"可站立、单向、能落"的全部行为，
  //    不需要为它单写一套物理（这是"把石台塞进同一个列表"的最大好处）。
  for (const p of PLATFORMS.list) {
    if (x >= p.x && x <= p.x + p.w) out.push(p);
  }
  for (const l of LEDGES.list) {
    if (x >= l.x && x <= l.x + l.w) out.push(l);
  }
  return out;
}

/**
 * 贴地行走时脚下的面 = "**脚底附近**的候选面里最低的那个"。
 * 站在平台上就保持在平台上；走出平台边缘时会返回地面 —— 调用方（player._vertical）
 * 看到这个落差后会**转为下落**，而不是瞬移到地面。
 *
 * ⚠️⚠️ 两个容差都是必须的（2026-09-27 被两个 bug 各打了一次）：
 *   · 下界 `c > y + 4`：「明显低于脚底」不算踩到 —— 否则会瞬移到下面的地面。
 *   · 上界 `c < y - stepUp`：「**比能迈上去的台阶还高**」也不算脚下的面。
 *     ⚠️ 上界必须用 `stepUp`(26) 而不是一个拍脑袋的小值：
 *       · 用 6px 时，**同侧岩桥之间的 22px 级差会被当成"头顶的东西"排除掉** →
 *         玩家从一段桥走到另一段时会掉下去（走不上台阶）。
 *       · 不写上界时，玩家在台地上走下坡，前方地面被下界排除后，
 *         候选里只剩**头顶那座桥** → 返回桥面的高度 → 被误判成"上不去的岩壁"卡住
 *         （用户报告的"人物下坡时有时会被阻拦"，实测卡在 x=350）。
 *     所以：**只有"高过 stepUp"的面才算头顶**（那是跳不上去的岩壁或更上一层的桥）。
 */
export function surfaceAt(x, y) {
  let best = null;
  const cand = [terrainY(x), ...platformsAt(x).map((p) => p.y)];
  for (const c of cand) {
    if (c > y + 4) continue;              // 明显低于脚底 → 这一段是空的，不算踩到
    if (c < y - RULES.stepUp) continue;   // 高过能迈上去的台阶 → 那是头顶的面，不是脚下的
    if (best === null || c > best) best = c;
  }
  return best === null ? terrainY(x) : best;
}

/**
 * 这一帧从 prevY **下落**到 newY，跨过的最高面（y 最小值）—— 那就是落地位置。
 * ⚠️ y 越大越低，所以"下落"是 prevY < newY，跨过的面 c 满足 `prevY <= c <= newY`。
 *    没跨过任何面返回 null（说明下面是空的，继续下落）。
 */
export function crossedSurface(x, prevY, newY) {
  let best = null;
  const cand = [terrainY(x), ...platformsAt(x).map((p) => p.y)];
  for (const c of cand) {
    if (c < prevY || c > newY + SURF_EPS) continue;   // 只算被这一帧跨过的
    if (best === null || c < best) best = c;          // 取最高的（下落时最先碰到）
  }
  return best;
}

// ============================================================
// 岩桥与升降台：同样**每波生成**（2026-09-27 第三轮）
// ============================================================
/**
 * 生成本波的岩桥：每侧 2~4 条，**首尾相接**（不留空隙 → 玩家不会踩空）。
 *
 * 高度策略：
 *   · 靠庇护所那条从 `gen.yNear` 起，越往外**依次降 `stepNear`（约 22px，走得上去）**
 *   · 再用"离正下方地面至少 `minClear`"**逐条校验**，不够高就抬
 *     → 这一步可能把某条桥抬到与上一条差 > `stepUp`，于是**那一段必须跳**
 *       （这就是"有的桥连成一条、有的要跳一下"的来源，路线每波都不一样）
 * ⚠️ `minClear`(78) > 跳跃高度(≈63.8) 是硬要求：否则玩家能从地面直接跳上桥，
 *    升降台和"上层路线"就都没意义了。
 */
export function genBridges(rng, layer = CUR) {
  const rand = (a, b) => rng() * (b - a) + a;
  const g = PLATFORMS.gen;
  const list = [];
  for (const dir of [-1, 1]) {
    // ---- ① 主干：一条从庇护所往外、首尾相接的阶梯长廊（保证上层有路可走）----
    const n = Math.round(rand(g.perSide[0], g.perSide[1]));
    let edge = SHELTER.cx + dir * (SHELTER.halfWidth + 60);
    let y = Math.round(rand(g.yNear[0], g.yNear[1]));
    const trunks = [];
    for (let i = 0; i < n; i++) {
      const w = Math.round(rand(g.w[0], g.w[1]));
      const x0 = dir > 0 ? edge : edge - w;
      if (x0 < 20 || x0 + w > WORLD.width - 20) break;   // 越界就停
      if (i > 0) y += Math.round(rand(g.stepNear[0], g.stepNear[1]));
      const gy = terrainY(x0 + w / 2);
      y = Math.min(y, gy - g.minClear);                  // 不够高就抬（宁可打乱阶梯）
      y = Math.max(y, g.yMin);                           // 别顶到画面上方
      const br = { x: Math.round(x0), w, y: Math.round(y) };
      trunks.push(br);
      list.push(br);
      edge = dir > 0 ? edge + w : edge - w;              // 首尾相接
    }

    // ---- ② 网络化：从主干上分叉出"支桥"（2026-09-27 第四轮）----
    // ⚠️ 支桥**与宿主桥部分重叠**才像"分叉"；上方的高差 ≤ 跳跃极限（跳得上去），
    //    下方的高差 ≤ stepUp（直接走下去）—— 两种都要保证"够得着"，否则支桥就是死路。
    // ⚠️ 它同样要过 `minClear` 校验：低到"地面能跳上来"就破坏"上层必须坐升降台"这条设计。
    const nb = Math.round(rand(g.branch[0], g.branch[1]));
    for (let i = 0; i < nb && trunks.length; i++) {
      const host = trunks[Math.floor(rng() * trunks.length)];
      const w = Math.round(rand(g.branchW[0], g.branchW[1]));
      const up = rng() < g.branchUp;
      const dy = up
        ? Math.round(rand(g.branchUpGap[0], g.branchUpGap[1]))
        : Math.round(rand(g.branchDownGap[0], g.branchDownGap[1]));
      const off = Math.round(rand(-host.w * 0.5, host.w * 0.3));
      const x0 = Math.max(20, Math.min(WORLD.width - 20 - w, Math.round(host.x + off)));
      let by = Math.round(host.y + (up ? -dy : dy));     // y 越小越高
      by = Math.min(by, terrainY(x0 + w / 2) - g.minClear);
      by = Math.max(by, g.yMin);
      // ⚠️ 上面那道"抬到离地够高"的校正**可能把高差拉大**到"够不着"：
      //    实测 32 条支桥里有 2 条（6%）会因此变成跳不上去的死路。
      //    这种就不生成 —— 和"不生死图"是同一条原则（宁可少一条，不要留一条上不去的）。
      const gap = Math.abs(host.y - by);
      if (by < host.y ? gap > jumpHeight() : gap > RULES.stepUp) continue;
      // 记下宿主桥的高度：**校验脚本要靠它**（支桥可能横向跨过好几条主干，
      // 单靠"x 范围重叠"反查宿主会找错人 —— 这一步踩过，见 docs/04）
      list.push({ x: x0, w, y: by, branch: true, hostY: host.y });
    }
  }
  LAYERS[layer].platforms = list;
  if (layer === CUR) setLayer(layer);
}

/**
 * 生成本波的升降台：**每侧一座**，放在某条桥的**正下方** ——
 * 于是"升上去必然落在桥上"，不需要额外校验落点（落点就是那条桥的顶面）。
 * 挑"靠庇护所的第二条桥"：既不太近（否则上楼太方便、失去往返成本）、也不太远（跑不到）。
 */
export function genLifts(layer = CUR) {
  const list = [];
  for (const dir of [-1, 1]) {
    const onSide = (b) => (dir > 0 ? b.x >= SHELTER.cx : b.x + b.w <= SHELTER.cx);
    // ⚠️ 优先挑**主干**（更宽、更稳），支桥只在主干不够时才用 ——
    //    升降台的落点必须在"玩家站得住的地方"，支桥窄，落点更容易压边。
    const trunks = PLATFORMS.list.filter((b) => !b.branch && onSide(b));
    const side = trunks.length ? trunks : PLATFORMS.list.filter(onSide);
    if (!side.length) continue;
    side.sort((a, b) => Math.abs(a.x - SHELTER.cx) - Math.abs(b.x - SHELTER.cx));
    const b = side[Math.min(1, side.length - 1)];
    const cxp = Math.round(b.x + b.w / 2);
    list.push({ x: cxp, to: { x: cxp, y: b.y } });
  }
  LAYERS[layer].lifts = list;
  if (layer === CUR) setLayer(layer);
}

/**
 * 生成本波的**天然石台**（地面与岩桥之间的"第三层"）。
 * ⚠️ 它们**不承诺连成一条路** —— 离散、间隔随机（30~130），玩家得自己判断哪块跳得过去。
 *    这正是"地形复杂度"的来源。但每块都保证：**从它正下方的地面跳不到**（否则就退化成普通台阶了）。
 */
export function genLedges(rng, layer = CUR) {
  const rand = (a, b) => a + rng() * (b - a);
  const out = [];
  const [lo, hi] = LEDGES.count;
  for (const dir of [-1, 1]) {
    const n = Math.round(rand(lo, hi));
    let edge = SHELTER.cx + dir * (SHELTER.halfWidth + 120);
    for (let i = 0; i < n; i++) {
      const w = Math.round(rand(LEDGES.w[0], LEDGES.w[1]));
      const gap = Math.round(rand(30, 130));
      const x0 = dir > 0 ? edge + gap : edge - gap - w;
      if (x0 < 20 || x0 + w > WORLD.width - 20) break;
      const gy = terrainY(x0 + w / 2);
      const clear = Math.round(rand(LEDGES.minClear, LEDGES.maxClear));
      out.push({ x: Math.round(x0), w, y: Math.round(gy - clear) });
      edge = dir > 0 ? x0 + w : x0;
    }
  }
  LAYERS[layer].ledges = out;
  if (layer === CUR) setLayer(layer);
}

/**
 * 生成本波的**隧道**（**可能一条都没有**，见 TUNNELS 的注释）。
 * 三条随机性叠在一起，目的都是"不让捷径变成默认走法"：
 *   ① 每一侧独立 `sideChance` 概率才有；
 *   ② 洞口位置在各自区间里随机（玩家每波都得重新找）；
 *   ③ 跨度小于 `minSpan` 的组合直接重 roll（不做"只省几步路"的廉价捷径）。
 */
export function genTunnels(rng, layer = CUR) {
  const rand = (a, b) => a + rng() * (b - a);
  const list = [];
  // ⚠️ 2026-09-28（用户："不要废墟与通道挤在一起"）：隧道口也不许压在**升降台**上 ——
  //    两者都是"贴地画的石构摆设"，叠在一起既难看、点击命中也会互相抢。
  //    世界很宽、而升降台只有 1~2 个，所以"重 roll 到合规"在这里是**安全的**
  //    （可行域 = da 的 700px / db 的 600px 区间，减掉一个点的 ±worldGap）。10 次够用。
  const liftXs = LAYERS[layer].lifts.map((k) => k.x);
  const clearOfLifts = (x) => liftXs.every((lx) => Math.abs(lx - x) >= LOOT_RULES.worldGap);
  for (const dir of [-1, 1]) {
    if (rng() > TUNNELS.sideChance) continue;          // ① 这一侧本波没有
    for (let t = 0; t < 10; t++) {
      const da = rand(TUNNELS.aDist[0], TUNNELS.aDist[1]);
      const db = rand(TUNNELS.bDist[0], TUNNELS.bDist[1]);
      if (db - da < TUNNELS.minSpan) continue;         // ③ 太近 → 重 roll
      const ax = Math.round(SHELTER.cx + dir * da);
      const bx = Math.round(SHELTER.cx + dir * db);
      if (!clearOfLifts(ax) || !clearOfLifts(bx)) continue;   // ④ 洞口压在升降台上 → 重 roll
      list.push({ a: { x: ax }, b: { x: bx } });       // ② 位置随机
      break;
    }
  }
  LAYERS[layer].tunnels = list;
  if (layer === CUR) setLayer(layer);
}

const POS_SIZE = 18;   // 单元格的基准边长（放得下就用这个，放不下自动缩）
const POS_GAP = 7;
// 格子的**最小可点尺寸**。
// ⚠️ 2026-09-26 从 9 提到 11.5：补漏位改成会成长（最多 10 个）之后，"12 格挤在左墙/门
//    那个 40×100 的面上"会算出 9.2px —— 手机上根本点不中。11.5 是本项目早就定下的触屏下限。
// ⚠️ 提到 11.5 的代价：极端配置下整块格子会**微微溢出面的矩形**（实测最多 2px，
//    因为左墙/门只有 40×100，12 格排成 2 列 × 6 行时纵向要 104px）。
//    这 2px 溢出是刻意接受的 —— 另一条路是"限制单面最多放几个"，但那会推翻
//    用户明确要的"一面墙的空位可以一直叠加"。宁可格子探出去 2px，也不要点不中。
const POS_MIN = 11.5;

/**
 * 某面上所有格位的矩形：**补漏位在前，插槽位在后**（顺序必须和 shelter.js 的 positions 一致）。
 *
 * ⚠️ 格数是**调用方传进来的**（2026-09-26 起补漏位会随波次成长，没有静态值可读）。
 *    传错 = 画出来的格子和点到的格子错位，所以调用方一律从 `shelter.face(id)` 上取。
 *
 * 排布规则：
 *   1. 先试着排成一条直线（横向面横排、竖向面竖排）
 *   2. 排不下就缩格子（下限 POS_MIN）
 *   3. 还排不下就折成多行/多列（横向面往下载行、竖向面往右撂列）
 *   最后把整块**居中**在面的矩形里。
 *   竖向的左墙/门只有 40×100，格子多了根本放不下一列 —— 靠的就是第 3 步折成两列。
 */
export function facePositionRects(faceId, nStruct, nFunc) {
  const r = shelterRects()[faceId];
  const ns = nStruct;
  const nf = nFunc;
  const n = ns + nf;
  if (!r || n <= 0) return [];

  const kinds = [];
  for (let i = 0; i < ns; i++) kinds.push('struct');
  for (let i = 0; i < nf; i++) kinds.push('func');

  const horiz = r.w >= r.h;
  const pad = 5;
  const availW = Math.max(POS_MIN, r.w - pad * 2);
  const availH = Math.max(POS_MIN, r.h - pad * 2);
  const alongLen = horiz ? availW : availH;   // 主排方向
  const crossLen = horiz ? availH : availW;   // 折行方向（横向面 = 垂直空间，竖向面 = 水平空间）

  // 主排方向最多能放几个（按最小边长估算），再据此决定要折几行/列
  const perLineMax = Math.max(1, Math.floor((alongLen + POS_GAP) / (POS_MIN + POS_GAP)));
  const maxLines = Math.max(1, Math.floor((crossLen + POS_GAP) / (POS_MIN + POS_GAP)));

  // ⚠️ 折几行/列**要挑格子最大的那种排法**，不能只试"一排"。
  //    反例：左墙/门只有 40×100，一排 6 个只能给到 9px（手指点不动），
  //    换成 2 列 × 3 行反而能到 11.5px。所以这里把所有可行行数都算一遍取最优。
  let best = null;
  for (let L = 1; L <= Math.min(n, maxLines); L++) {
    const per = Math.ceil(n / L);
    if (per > perLineMax) continue;
    const sA = (alongLen - POS_GAP * (per - 1)) / per;
    const sC = (crossLen - POS_GAP * (L - 1)) / L;
    const s = Math.max(POS_MIN, Math.min(POS_SIZE, sA, sC));
    if (!best || s > best.size) best = { perLine: per, lines: L, size: s };
  }
  // 兜底：一个都放不下就硬塞进最大行数（保证至少有可点的格子，不返回空）
  if (!best) {
    const lines = maxLines;
    const perLine = Math.ceil(n / lines);
    best = { perLine, lines, size: POS_MIN };
  }
  const { perLine, lines, size } = best;

  const blockAlong = size * perLine + POS_GAP * (perLine - 1);
  const blockCross = size * lines + POS_GAP * (lines - 1);
  const blockW = horiz ? blockAlong : blockCross;
  const blockH = horiz ? blockCross : blockAlong;
  const x0 = r.x + (r.w - blockW) / 2;
  const y0 = r.y + (r.h - blockH) / 2;

  const out = [];
  for (let i = 0; i < n; i++) {
    const line = Math.floor(i / perLine);
    const idx = i % perLine;
    const cx = horiz ? idx : line;
    const cy = horiz ? line : idx;
    out.push({
      x: x0 + cx * (size + POS_GAP),
      y: y0 + cy * (size + POS_GAP),
      w: size,
      h: size,
      kind: kinds[i],
    });
  }
  return out;
}

/**
 * "扩展位"（那个可点的「+」格）的矩形 —— 只有一个，紧跟在补漏位后面。
 *
 * 做法：把补漏位**多算一个**再走同一套排布，取第 nStruct 个。
 * ⚠️ 必须用同一套排布（而不是"在最后一个格子右边加 25px"）——
 *    否则格数一多、排布折行之后，「+」会画到完全不相干的地方去。
 * @returns {object|null} 该面这个位置上的矩形（拿不到就 null）
 */
export function expandSlotRect(faceId, nStruct, nFunc) {
  const rs = facePositionRects(faceId, nStruct + 1, nFunc);
  return rs[nStruct] || null;
}

/**
 * 点到了某个面上的哪个位置？返回 {faceId, posIndex} 或 null。
 * ⚠️ 必须传入**活的** faces（`shelter.faces`）—— 格数会随波次成长，
 *    读配置里的静态值就会和画出来的格子错位。
 */
export function positionAt(worldX, worldY, faces) {
  const pad = 12;
  let best = null;
  let bestD = Infinity;
  for (const f of faces) {
    const rects = facePositionRects(f.id, f.structSlots, f.funcSlots);
    rects.forEach((pr, i) => {
      const dx = Math.abs(worldX - (pr.x + pr.w / 2));
      const dy = Math.abs(worldY - (pr.y + pr.h / 2));
      if (dx < pr.w / 2 + pad && dy < pr.h / 2 + pad) {
        const d = dx + dy;
        if (d < bestD) { bestD = d; best = { faceId: f.id, posIndex: i }; }
      }
    });
  }
  return best;
}

/** 按权重随机取一个 key */
export function pickWeighted(weights, rng) {
  const keys = Object.keys(weights);
  let total = 0;
  for (const k of keys) total += weights[k];
  let r = rng() * total;
  for (const k of keys) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

/** 某个 x 落在哪个区域（上层废墟用它决定基础掉落表） */
function zoneAtX(x) {
  for (const z of ZONES) {
    for (const [a, b] of z.xRanges) {
      if (x >= a && x <= b) return z.id;
    }
  }
  // 落在所有区间之外（平台可能横跨到区间外侧）→ 取最近的区间边界所属的区域
  let best = ZONES[0].id;
  let bestD = Infinity;
  for (const z of ZONES) {
    for (const [a, b] of z.xRanges) {
      const d = Math.min(Math.abs(x - a), Math.abs(x - b));
      if (d < bestD) { bestD = d; best = z.id; }
    }
  }
  return best;
}

export class World {
  constructor(rng = Math.random, layer = 'ground') {
    this.rng = rng;
    this.layer = layer;     // 'ground' | 'under'
    this.loot = [];
    this.onWaveStart();
  }

  /**
   * 每波刷新：**换一张地图** + 重新撒材料点。
   *
   * ⚠️ 两层生成的东西不同：
   *    · 地面 = 地形 + 石台 + 岩桥 + 升降台 + 岩棚 + 隧道 + **地穴入口**
   *    · 地下 = 地形（洞窟地面）+ 石台（钟乳/岩架）—— **没有**桥/升降台/隧道/入口：
   *      地下本来就是一个洞，不需要再往上搭路，也不该再有"捷径"（否则会层层套娃）
   */
  onWaveStart() {
    const L = this.layer;
    // ① 先切层：下面所有生成都要读**这一层**的地形（`terrainY` 跟着 CUR 走）
    setLayer(L);
    genTerrain(this.rng, L);
    genLedges(this.rng, L);
    if (L === 'ground') {
      genBridges(this.rng, L);
      genLifts(L);
      genShelves(this.rng, L);
      genTunnels(this.rng, L);
    }
    genEntrances(this.rng, L);      // 地下层内部会置空

    const out = [];
    // ⚠️ 避让是**全局**的：相邻两个区间是首尾相接的（深区 [40,300] 紧挨中区 [300,460]），
    //    各自只在区间内避让的话，深区 300 和中区 301 会贴在一起。
    const placed = [];
    // 通道类物件（地穴入口 / 隧道口 / 升降台）的位置 —— 废墟必须避让它们（见 LOOT_RULES.worldGap）。
    // ⚠️ 它们**先生成**，位置纯随机，彼此也不知道对方在哪；废墟是最后生成的，所以避让在废墟这一侧。
    const passages = passageXs(L);
    for (const zone of ZONES) {
      for (const [a, b] of zone.xRanges) {
        // ⚠️ 2026-09-26 用户要求："废墟散落在各处，主人公要去寻找"。
        //    之前是 `base + t*0.7` 均匀铺开再抖动 —— 废墟每波长得几乎一样，
        //    记住节奏后"找"这件事就不存在了。现在改成**区间内随机撒点**。
        //    数量仍然固定 = zone.perSide（材料产出量不能随机，否则经济会波动）。
        //
        //    间距是**软约束**（尽力而为）：区间只有 160~300px 宽，"随机撒点"本身就可能
        //    撒不出满足间距的落点。硬约束重试失败后只能硬塞，实测出现过间距退化成 12px
        //    （比完全不约束还差）的情况。所以这里改成"撒 N 个候选，取离已有废墟最远的那个"。
        //    ⚠️ bestD 初值必须是 -1 不能是 Infinity：初值 Infinity 会让 `d > bestD`
        //       永远不成立 → 兜底分支一次都不执行，bestX 永远是第一次随机的结果。
        //    ⚠️ 候选数 24 → **48**（2026-09-26）：深区改成每侧 3 个之后，24 个候选
        //       在窄区间里退让得太厉害（实测最小间距掉到 38px，而目标是 78px）。
        //       候选翻倍是纯采样层面的改善 —— 不改算法、只让"取最远"有更多选择。
        //       实测（400 波 × 5200 个间距）：全局最小间距 43 → **50**，中位 87~114，
        //       **低于 44px 的占 0%**。成本是每波多几百次整数比较，可忽略。
        //    ⚠️ 48 → **96**（2026-09-28）：加了"避让通道类"这一类新约束之后，可行域更紧，
        //       多给采样一点预算。实测（两层 × 200 波）：
        //         废墟↔升降台 的残余违规 45 → **30** 对，废墟↔废墟 最小间距 31 → **32**，
        //         <44px 的配对 149 → **131**。收益已经很小了（说明瓶颈是"窄区间里本来就放不下"，
        //         不是采样不够），所以到此为止、不再往上加。
        //
        //    ⚠️ 2026-09-28（用户："不要废墟与通道挤在一起，相互重叠了"）：候选的评分从
        //       "离最近的废墟多远"升级成"**离最近的世界物件多远**"—— 通道类（地穴入口 /
        //       隧道口 / 升降台）也进同一个约束里，但要求更大（`worldGap` 96 > `ruinMinGap` 78）。
        //       实现 = 取两项"富余量"里**最紧的那一项**当分数（`min(距离 − 要求)`）。
        //       ⚠️ 初值必须"比任何可能值都小"（`-Infinity`）：写成 `Infinity` 会让
        //          `score > bestScore` 永远不成立、兜底分支一次都不执行 ——
        //          这个反向错误本项目真踩过（docs/04）。
        for (let i = 0; i < zone.perSide; i++) {
          let bestX = 0;
          let bestScore = -Infinity;
          for (let t = 0; t < 96; t++) {
            const cand = Math.round(a + this.rng() * (b - a));
            let dLoot = Infinity;
            let dPass = Infinity;
            for (const v of placed) { const g = Math.abs(v - cand); if (g < dLoot) dLoot = g; }
            for (const v of passages) { const g = Math.abs(v - cand); if (g < dPass) dPass = g; }
            const score = Math.min(dLoot - LOOT_RULES.ruinMinGap, dPass - LOOT_RULES.worldGap);
            if (score > bestScore) { bestScore = score; bestX = cand; }
            if (dLoot >= LOOT_RULES.ruinMinGap && dPass >= LOOT_RULES.worldGap) break;
          }
          placed.push(bestX);
          // 废墟类型（2026-09-25 用户要求）：稳固 / 引怪 / 易塌，按区域权重随机
          const type = pickWeighted(zone.typeWeights, this.rng);
          // 龙级废墟（2026-09-27 第五轮）：只在**有资格的区域**里抽签（地面 = 极深区）
          const t7Ruin = T7_RUIN.eligibleZones.includes(zone.id) && this.rng() < T7_RUIN.chance;
          out.push({
            x: bestX,
            y: terrainY(bestX) - 14,   // ⚠️ 2026-09-26 加地形之后，废墟要**站在地形上**
            zone: zone.id,
            type,
            t7Ruin,            // ← 只有它才可能吐龙级（见 digOnce）
            depth: 0,          // 已挖深度
            // 层数**按类型分开抽**（2026-09-27 第六轮用户定案）：
            // 稳固 1~2 块 / 易塌·引怪 4~9 层。权重集中在 config 的 `DIG.depthWeights`，
            // 这里只负责把类型传进去 —— 要改产出分布只改那一处。
            // 层数不告诉玩家，只能靠"塌方风险%"和类型标签间接感觉。
            maxDepth: rollDepth(this.rng, type),
            pending: [],       // 脚下暂存堆（塌方则全丢）
            available: true,
          });
        }
      }
    }
    // ---- 上层岩桥上的废墟（2026-09-27 新增，"上去值得"的兑现处）----
    // 每块平台放 1 个料堆，掉落表按**所在区域 + `PLATFORMS.tableBonus` 档**（档次更高），
    // 代价是必须先坐升降台上去（见 config 的 LIFTS）。类型偏"易塌" ——
    // 用户要的是"越值钱越不稳定"，上层正好是两者都拉满的地方。
    // ⚠️ 2026-09-28：类型权重从写死的字面量改成读 `PLATFORMS.typeWeights`（config），
    //    并按用户要求**去掉了引怪型** —— 原因写在 config 那一段（怪上不来桥，
    //    但伤害只看 |Δx| 不看 y，所以桥上引怪 = "在高空无理由掉血"）。
    // ⚠️ x 取平台**中段**（30%~70%），不要贴边：贴着边缘生成的废墟，玩家站在旁边
    //    会有半个身子悬空，点起来也含糊。
    for (const p of PLATFORMS.list) {
      const x = Math.round(p.x + p.w * (0.3 + this.rng() * 0.4));
      const type = pickWeighted(PLATFORMS.typeWeights, this.rng);
      out.push({
        x,
        y: p.y - 14,                  // 站在平台表面上（与地面料堆同一套约定）
        zone: zoneAtX(x),
        plat: true,                   // ← "上层废墟"标记（渲染/调试用）
        bonus: PLATFORMS.tableBonus,  // ← 掉落表加成（digOnce 读这个）
        // 空中龙级资格沿用20%；地下有独立概率。
        t7Ruin: this.rng() < T7_RUIN.chance,
        type,
        depth: 0,
        maxDepth: rollDepth(this.rng, type),   // 同地面：稳固 1~2 / 易塌 4~9（空中已无引怪型）
        pending: [],
        available: true,
      });
    }

    // ---- 地下中段补点（2026-09-27 用户："随便把地下的空地补好吧"）----
    // 那 680px 不属于任何区（区间是近区 1700~2060 / 2740~3100），所以一个废墟都不会长在那儿。
    // ⚠️ 只补**地下**：地面上那一段是庇护所自己的院子，补了会把"出门"堵成一排料堆。
    // ⚠️ 必须放在下面那个 `if (L === 'under')` 覆写块**之前** —— 补的这些也要吃
    //    "掉落表拉满 + 龙级抽签"那套地下待遇（那段是遍历整个 `out` 的）。
    if (L === 'under') {
      const zone = this.zoneOf('near');
      const [d0, d1] = UNDERWORLD.centerFill.dist;
      for (const sign of [-1, 1]) {
        for (let i = 0; i < UNDERWORLD.centerFill.perSide; i++) {
          // 同主循环：撒 16 个候选、取"最不挤"的那个。
          // ⚠️ 2026-09-28：改成**和主循环共用 `placed` / `passages`**（原来这里自己开了一个
          //    只装中段补点的 `placed`）。理由：这段区间和近区的内边界只差 10px
          //    （近区到 ≥2060、中段从 ≤2070 起），各避各的就会出现"近区 2060 / 中段 2070"
          //    这种 10px 贴脸 —— 和 docs/04 那条"相邻区间边界必须用半开"是同一类坑。
          //    另外也顺带让中段补点避让通道类物件（地下同样有地穴入口）。
          let bestX = 0;
          let bestScore = -Infinity;
          for (let t = 0; t < 16; t++) {
            const cand = Math.round(SHELTER.cx + sign * (d0 + this.rng() * (d1 - d0)));
            let dLoot = Infinity;
            let dPass = Infinity;
            for (const v of placed) { const g = Math.abs(v - cand); if (g < dLoot) dLoot = g; }
            for (const v of passages) { const g = Math.abs(v - cand); if (g < dPass) dPass = g; }
            const score = Math.min(dLoot - LOOT_RULES.ruinMinGap, dPass - LOOT_RULES.worldGap);
            if (score > bestScore) { bestScore = score; bestX = cand; }
            if (dLoot >= LOOT_RULES.ruinMinGap && dPass >= LOOT_RULES.worldGap) break;
          }
          placed.push(bestX);
          const type = pickWeighted(zone.typeWeights, this.rng);
          out.push({
            x: bestX,
            y: terrainY(bestX) - 14,
            zone: zone.id,          // 下面会被覆写成 'deep'（地下统一给深区待遇）
            type,
            depth: 0,
            maxDepth: rollDepth(this.rng, type),
            pending: [],
            available: true,
          });
        }
      }
    }

    // 地下层：料的档次**统一按"深区"给**（不看距离）—— "地下 = 高回报"体现在
    //   **处处都是深区待遇、不用跑远**，而不是"档次拉到最高"。
    //   撒点本身的逻辑完全复用（位置/数量/类型/塌方都不变）。
    // ⚠️⚠️ 2026-09-28 改：原来是 `zone = 'abyss'` + `bonus = tableBonus(6)` ——
    //   而 `digOnce` 是 `idx = min(depth + bonus, 表数) - 1`，**bonus ≥ 表数时恒等于最后一张表**，
    //   于是地下每一层都在用"极深区最顶层"（那张表 80% 出蛟级）→ 全局蛟级占到 57%。
    //   完整根因与实测数字见 config.js 的 `UNDERWORLD.tableBonus` 注释。
    // ⚠️ 顺带说明：这里仍然**不按距离分区**（地下刻意保留"不看距离"这条身份）；
    //   若要恢复地下的距离梯度，注意 `caveInBase` 是挂在 `zone` 上的 ——
    //   换 zone 会连带把地下 12% 的塌方基线改成各区的 4/8/12/16%（风险身份会跟着变）。
    if (L === 'under') {
      for (const s of out) {
        s.zone = 'deep';
        s.bonus = UNDERWORLD.tableBonus;
        // 地下独立抽取龙级资格，不影响地面与空中。
        s.t7Ruin = this.rng() < UNDERWORLD.t7Chance;
      }
    }

    // ---- ⚠️ 2026-09-29：**庇护所附近不许有料堆**（配合"准备期从出门才开始计时"）----
    // 为什么必须有这一行：准备期现在要等玩家**离开庇护所**才开始计时。如果料堆能长在近处，
    //   玩家站在庇护所范围里（±shelterRange 160）就能挖到它（挖掘半径 52）→
    //   **不出门白拿料、倒计时永远不启动**。
    //   实测（300 张地面图 / 14743 个料堆）：岩桥上的料堆最内能到 **125px**，
    //   门槛是 240 → 低于门槛的有 17 个（约 1/18 的波次会撞上）。
    // ⚠️ 在**统一出口**过滤（而不是分别改三处生成）—— `out` 里混了三种来源
    //   （普通废墟 / 地下中段补点 / 上层岩桥料堆），只堵一个地方最稳。
    //   实际上只有岩桥会被真的滤掉：普通废墟的近区内边界是 340、隐藏区只在深区/中区。
    // ⚠️ 门槛 240 的完整推导见 config 的 `SHELTER.nearClear`。
    this.loot = out.filter((sp) => Math.abs(sp.x - SHELTER.cx) >= SHELTER.nearClear);
    // ---- 隐藏区：碎石堆（每波 1~2 个，只放深区/中区）----
    // ⚠️ 必须放在 `this.loot = out` **之后** —— 它要读料堆位置来做避让。
    this.genHidden(this.rng);
  }

  zoneOf(id) {
    return ZONES.find((z) => z.id === id);
  }

  /**
   * 生成本波的**隐藏区（碎石堆）**：只放深区/中区（值得跑过去），
   * 并与已有料堆尽量拉开距离（免得挤在一起、点不清）。
   *
   * ⚠️ 避让用"**撒 N 个候选、取离已有东西最远的那个**"，而不是"随机撒到合规为止" ——
   *    第一版写成"重试 24 次，找不到就跳过"，实测 10 波里**有 7 波一个都没生成**
   *    （深区/中区本来就挤满了料堆，可行域近乎空集，和撒点那轮踩的"硬约束在窄区间里是空集"是同一个坑）。
   *    取最远的写法则**总能放下**，最差也只是间距小一点。
   */
  genHidden(rng) {
    const out = [];
    // ⚠️ 2026-09-27 第五轮：从"每波必有 1~2 个"改成**每波 10% 概率出现**（用户要求）——
    //    它是"稀有惊喜"，不该是每波例行公事；而且它里面装的是龙级富矿。
    if (rng() >= HIDDEN.chance) { this.hidden = out; return; }
    const [lo, hi] = HIDDEN.count;
    const n = lo + Math.floor(rng() * (hi - lo + 1));
    const zones = ZONES.filter((z) => z.id !== 'near');
    // 通道类物件（地穴入口 / 隧道口 / 升降台）也要避让 —— 碎石堆同样是"世界里的一个物件"
    const passages = passageXs(this.layer);
    for (let i = 0; i < n; i++) {
      let bestX = null;
      let bestZone = null;
      let bestScore = -Infinity;
      for (let t = 0; t < 60; t++) {
        const z = zones[Math.floor(rng() * zones.length)];
        const range = z.xRanges[Math.floor(rng() * z.xRanges.length)];
        const x = Math.round(range[0] + rng() * (range[1] - range[0]));
        let dLoot = Infinity;
        let dHidden = Infinity;
        let dPass = Infinity;
        for (const l of this.loot) { const g = Math.abs(l.x - x); if (g < dLoot) dLoot = g; }
        for (const h of out) { const g = Math.abs(h.x - x); if (g < dHidden) dHidden = g; }
        for (const v of passages) { const g = Math.abs(v - x); if (g < dPass) dPass = g; }
        // 分数 = 三项"富余量"里最紧的那一项（口径同废墟撒点，见 LOOT_RULES.worldGap）
        const score = Math.min(
          dLoot - HIDDEN.minGap,
          dHidden - HIDDEN.minGap,
          dPass - LOOT_RULES.worldGap
        );
        if (score > bestScore) { bestScore = score; bestX = x; bestZone = z.id; }
        if (dLoot >= HIDDEN.minGap && dHidden >= HIDDEN.minGap && dPass >= LOOT_RULES.worldGap) break;
      }
      if (bestX === null) continue;
      out.push({
        x: bestX,
        y: terrainY(bestX) - 14,
        zone: bestZone,
        power: HIDDEN.power,   // 还要挖几下才开
        opened: false,
      });
    }
    this.hidden = out;
  }

  /**
   * 挖开一个碎石堆 → **在原地生成一个富料堆**（掉落表后翻 `HIDDEN.tableBonus` 张）。
   * @returns 生成的那个料堆（已推进 `this.loot`），已经打开过则返回 null
   */
  openHidden(hid) {
    if (!hid || hid.opened) return null;
    hid.opened = true;
    const [lo, hi] = HIDDEN.rewardDepth;
    const spot = {
      x: hid.x,
      y: hid.y,
      zone: hid.zone,
      type: 'stable',          // 隐藏区里**不会塌**：它是奖励，不该因为运气变成惩罚
      bonus: HIDDEN.tableBonus,
      rich: true,              // 标记：渲染/调试用
      // 碎石堆里的富料堆**定为龙级废墟**、且用更高的出率（`richRate`）——
      // 理由：它本身每波只有 10% 概率出现（还要先找到 + 挖 3 下打开），
      // 稀有度已经足够，再让它去抽 20% 就变成"几乎不会给龙级"了。
      t7Ruin: true,
      t7Rate: T7_RUIN.richRate,
      depth: 0,
      // 富料堆是**唯一的例外**：故意用 HIDDEN.rewardDepth（2~3 层）而不是 rollDepth。
      // 理由：它每波只有 10% 概率出现、还要找到 + 挖 3 下才开，稀有度已经足够，
      // 再让它有 50% 概率只吐 1 件就太亏了（见 config 的 HIDDEN 注释）。
      maxDepth: lo + Math.floor(this.rng() * (hi - lo + 1)),
      pending: [],
      available: true,
    };
    this.loot.push(spot);
    return spot;
  }

  /**
   * 挖一层。返回本层结果。
   * @returns {{ok:boolean, reason?:string, mat?:string, depth?:number, caveIn?:boolean, lost?:number, chance?:number}}
   */
  digOnce(spot) {
    const zone = this.zoneOf(spot.zone);
    if (!spot.available) return { ok: false, reason: 'gone' };
    if (spot.depth >= spot.maxDepth) return { ok: false, reason: 'bottom' };

    spot.depth += 1;
    // 超过产出表长度时沿用最后一张表（越深越偏进阶件的趋势到此封顶）
    // ⚠️ 掉落表加成用**通用的 `spot.bonus`**：上层废墟 = PLATFORMS.tableBonus(3)、
    //    隐藏区打开后的富料堆 = HIDDEN.tableBonus(5)。加成就写在各处的生成代码里。
    const idx = Math.min(spot.depth + (spot.bonus || 0), zone.tables.length) - 1;
    const table = zone.tables[idx];

    // 龙级（t7_*）走**独立的一条判定**，不再靠"第 6 张表的权重"（见 T7_RUIN 的注释）：
    //   · 只有**龙级废墟**（生成时按 20% 抽签得到）+ 挖到第 `minDepth` 层之后，才可能吐龙级
    //   · 普通废墟**永远不会**吐 —— 从表里抽到也降级成次高档。这条是硬保证，不依赖表怎么改。
    // ⚠️ 2026-09-28：龙级从 2 种扩到 8 种，所以"吐哪一种"和"降级成哪一种"都不能再写死两个 id，
    //    改由 config 的 `T7_RUIN.pool` / `T7_RUIN.downgrade` 驱动（表里写死会在扩容时静默漏掉 3 种）。
    const T7_DOWNGRADE = T7_RUIN.downgrade;
    const ruinRate = spot.t7Rate || T7_RUIN.rate;
    let mat;
    if (spot.t7Ruin && spot.depth >= T7_RUIN.minDepth && this.rng() < ruinRate) {
      mat = T7_RUIN.pool[Math.floor(this.rng() * T7_RUIN.pool.length)];   // 5 种里等概率
    } else {
      // 两段抽（2026-09-25 改为固定类别比例）：
      //   ① 先按 LOOT_CATEGORY_WEIGHTS 抽类别 —— 修复 52% / 结构 35% / 功能 13%，与深度无关
      //   ② 再在该类别的候选表里抽具体材料 —— 越深越偏进阶件
      // 好处：类别比例是精确的，不会出现"权重贴边被采样噪声翻掉"的情况。
      const cat = pickWeighted(LOOT_CATEGORY_WEIGHTS, this.rng);
      mat = pickWeighted(table[cat], this.rng);
      if (T7_DOWNGRADE[mat]) mat = T7_DOWNGRADE[mat];
    }
    spot.pending.push(mat);

    const ruin = RUIN_TYPES[spot.type];

    // 塌方只在"易塌"型发生 —— 稳固 / 引怪型永远不会塌（用户要求）
    // 概率随深度上升，这是"贪 vs 稳"的唯一约束
    if (ruin.caveIn) {
      const chance = caveInChance(zone, spot.depth, spot.type, this.layer);
      if (this.rng() < chance) {
        const lost = spot.pending.length;
        spot.pending = [];
        spot.available = false;
        return { ok: true, caveIn: true, lost, depth: spot.depth, chance, lure: false };
      }
    }
    // 挖到底（2026-09-27 第六轮用户定案）：除了"引怪型"（`refill`），废墟**就此消失** ——
    // 也就是"除了引怪性外，只能挖一次"。引怪型挖完还在，走开收走后可以从第 1 层再来一轮。
    // ⚠️ 这里**只打标记、不直接 `available = false`**：暂存堆还压在原地，要等玩家**走开收走**
    //    才算真正移除（见 main.js 的"走开自动收走"）。真在这一刻删掉的话，渲染里那条
    //    `if (!spot.available) continue` 会连暂存堆一起不画 → 表现成"最后一块材料凭空没了"。
    if (spot.depth >= spot.maxDepth && !ruin.refill) spot.depleted = true;
    // "引怪"型：这次挖掘会发出声响（由 main 交给怪物系统处理）
    return {
      ok: true, caveIn: false, mat, depth: spot.depth, chance: 0, lure: ruin.lure,
      atBottom: spot.depth >= spot.maxDepth, depleted: !!spot.depleted,
    };
  }
}
