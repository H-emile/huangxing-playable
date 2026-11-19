// Canvas 渲染层 —— 灰盒：只有色块和数字，美术投入为零
// 这一层将来移植到 Cocos 时会被整体重写，逻辑层不受影响
//
// 2026-09-25 改动：
//   · 每个面画成"格子 + 4 个位置"：补漏位（实线框）放结构件，插槽位（虚线框）放功能件
//   · 材料点统一外观，不透露内容；挖出的东西显示在"暂存堆"
//   · 庇护所面板把"这面墙现在有什么属性"汇总显示出来

import {
  VIEW, WORLD, MATERIALS, SHELTER, PLAYER, KIND_LABEL, REPAIR, WIN_WAVE, DIG, MONSTERS, CAMERA,
  CAMERA_ANCHOR_Y,
  PLAYER_HEAL_PER_WAVE, TIER_NAME, DISASTERS,
  RUIN_TYPES,
  UI, bagPanelRect, bagSlotRect, BAG_SLOTS,
  caveInChance,
  trashRect, trashUndoRect, TRASH_UNDO_SECONDS, endButtonRect,
  LIGHT, TERRAIN,
  hudPanelRect, skipBtnRect, skipTextInsetX,
  SYNTH, synthGeometry, workbenchRect, synthPanelRect, synthSlotRect, synthOptionRect,
  synthOptionCapacity, synthScrollGeometry, synthStartRect, synthCloseRect, pointInRect,
  PLATFORMS, LIFTS, HIDDEN, MINIMAP, TUNNELS, LEDGES, UNDERWORLD,
  PALETTE, UI_SKIN, OBJ_SKIN, SHELL_SKIN, FX, IDENTITY,
  UI_LAYOUT, UI_PANEL_BASE, UI_CHROME, uiCollapseIconRect, uiLabelRect, minimapRect,
  uiOffsetRect, uiTitleTextInset,
} from './config.js';
import {
  shelterRects, facePositionRects, expandSlotRect, terrainY, terrainRise, terrainProfile,
  isHighGround, underShelf, shelves, entrances, atSpot,
} from './world.js';
import { Phase } from './waveDirector.js';
import { SYNTH_STATE, canSynthesize, recipeOf } from './synthesis.js';
import { ART, wobble, strSeed, slouchBox } from './art.js';
import { drawConsoleFrame, drawEnamelPlate, drawConsoleBar } from './uiSkin.js';

const FONT = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

function hpColor(ratio, broken) {
  // 打穿/空面的灰：原来是冷板岩色 `#3a3f4b`，跟着墙一起转暖（见 config 的 OBJ_SKIN）
  if (broken) return OBJ_SKIN.mid;
  if (ratio > 0.6) return UI_SKIN.ok;
  if (ratio > 0.3) return UI_SKIN.warn;
  return UI_SKIN.danger;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 给一个色加透明度 → `rgba(...)`。
 *   withA(UI_SKIN.ok, 0.16)       // '#0FDC78'  → 'rgba(15,220,120,0.16)'
 *   withA(PALETTE.darkRgb, 0.8)   // '20,11,5'   → 'rgba(20,11,5,0.8)'
 *
 * ⚠️ 为什么需要它：本轮之前"同一个色的不同透明度"是**手抄一遍十六进制 → rgb**，散在 20 多处
 *    （`rgba(157,196,107,0.16)` 这种）。后果是改 `UI_SKIN.ok` 的值时，这些变体**原地不动** ——
 *    "单一来源"只对纯色成立，而带透明度的那一半才是到处在用的那一半。
 * ⚠️ 两种写法都吃：`#RRGGBB`（UI_SKIN / OBJ_SKIN / IDENTITY 的纯色）
 *    和 `'r,g,b'`（PALETTE.darkRgb、UI_SKIN.panelRgb、IDENTITY.playerRing 那几种）。
 * ⚠️ **别把非法颜色喂进来**：canvas 对 `rgba()` 里不合法的部分不报错、只是**保留上一次的
 *    fillStyle**（画出来的东西颜色不对、但不抛异常）。所以 IDENTITY / UI_SKIN 各有启动自检
 *    钉住"`*Rgb` 字段必须是 r,g,b 串"。
 */
function withA(color, a) {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return `rgba(${color},${a})`;
}

/**
 * 「切角矩形」路径 —— HUD 皮肤"轻质感"的地基（八边形，四角削平）。
 *
 * ⚠️ 为什么用切角而不是圆角：圆角是"现代扁平 UI"的语言，和"贫民铁锈 / 手工焊的铁皮箱"
 *    这个调子不搭。切角是四块铁皮对焊的接缝形状，一眼是"拼出来的"。
 * ⚠️ 只削四角、不削边中段：真削成完整八边形（每条边都折）会像"停车牌"，
 *    在小面板（撤销按钮只有 34px 高）上尤其难看。
 * ⚠️ `c` 会被夹到 `w/3, h/3` —— 小面板上不加这个夹子，切角会两两相接、把面板削成菱形。
 *    返回值是**实际生效的切角**，panelPlate 要靠它算铆钉位置。
 */
function cutCornerPath(ctx, x, y, w, h, c) {
  const cc = Math.max(0, Math.min(c, w / 3, h / 3));
  ctx.beginPath();
  ctx.moveTo(x + cc, y);
  ctx.lineTo(x + w - cc, y);
  ctx.lineTo(x + w, y + cc);
  ctx.lineTo(x + w, y + h - cc);
  ctx.lineTo(x + w - cc, y + h);
  ctx.lineTo(x + cc, y + h);
  ctx.lineTo(x, y + h - cc);
  ctx.lineTo(x, y + cc);
  ctx.closePath();
  return cc;
}

/**
 * 统一的"铁皮面板" —— **HUD 皮肤的唯一入口**（2026-10-01）。
 *
 * 本轮之前，面板底是 14 处硬编码的 `rgba(10,14,20,α)`；改一个调子要全局搜替换、还容易漏
 * （HUD 皮肤和"环境色"是同一个病，上一轮给环境色开的药方是"统一入口 + 审计断言"，
 * 这里照样来一遍）。所有面板都必须走这个函数，否则新一轮又会散开。
 *
 * ⚠️⚠️ 底色**不许在这个函数里被替换成暖棕 / 铁锈色** —— 见 config.js 的 `UI_SKIN` 长注释：
 *    暖色相压住了材料最密的色带，面板底只能靠**明度**和材料分层，所以它必须一直是暖黑。
 *    "铁锈感"由边、铆钉、顶部磨损高光承担。
 *
 * opts：
 *   · `alpha`     覆盖底色透明度（默认常驻档 `panelA`）
 *   · `bg`        整串覆盖底色（垃圾桶拖拽态那种"变红"用）
 *   · `edge`      覆盖描边色（合成面板用 info 铜绿、垃圾桶拖拽态用 danger）
 *   · `lineWidth` 覆盖描边粗细
 *   · `cut`       覆盖切角大小
 *   · `rivets`    false = 不画四角铆钉（小按钮上铆钉会挤成一坨时用）
 *   · `wear`      false = 不画顶部磨损高光
 */
function panelPlate(ctx, x, y, w, h, opts = {}) {
  if (!opts.bg) {
    ctx.save(); ctx.globalAlpha *= opts.alpha ?? UI_SKIN.panelA;
    if (w <= 100 && h <= 100) drawEnamelPlate(ctx, x, y, w, h);
    else drawConsoleFrame(ctx, x, y, w, h, Math.min(12, h / 7));
    if (opts.edge) { ctx.strokeStyle = opts.edge; ctx.lineWidth = opts.lineWidth || 1; ctx.strokeRect(x + 2, y + 2, w - 4, h - 4); }
    ctx.restore(); return;
  }
  const cut = opts.cut ?? 7;
  const alpha = opts.alpha ?? UI_SKIN.panelA;
  const cc = cutCornerPath(ctx, x, y, w, h, cut);

  ctx.fillStyle = opts.bg ?? `rgba(${UI_SKIN.panelRgb},${alpha})`;
  ctx.fill();

  // 铁锈边框：往里收 0.75px 描，否则 1.5px 的线会有一半落在面板外的世界像素上、看着发虚
  cutCornerPath(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, cc);
  ctx.strokeStyle = opts.edge ?? UI_SKIN.rivet;
  ctx.lineWidth = opts.lineWidth ?? 1.5;
  ctx.stroke();

  // 顶部磨损高光：只画中段，两头的切角处不画 —— 那条线是"金属被摩擦过的地方"，
  // 画满到角上会变成"描边加粗"，反而糊掉切角的形状
  if (opts.wear !== false && cc < w / 2 - 4) {
    ctx.beginPath();
    ctx.moveTo(x + cc * 1.6, y + 2.2);
    ctx.lineTo(x + w - cc * 1.6, y + 2.2);
    ctx.strokeStyle = withA(UI_SKIN.rivetHi, 0.38);   // = rivetHi @ 0.38
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 四角铆钉：钉在切角面的中点上（不是钉在矩形角上 —— 角已经被削掉了，钉在那儿会悬空）
  if (opts.rivets !== false) {
    const rr = 1.8;
    for (const [rx, ry] of [[x + cc / 2, y + cc / 2], [x + w - cc / 2, y + cc / 2],
      [x + cc / 2, y + h - cc / 2], [x + w - cc / 2, y + h - cc / 2]]) {
      ctx.beginPath();
      ctx.arc(rx, ry, rr, 0, Math.PI * 2);
      ctx.fillStyle = UI_SKIN.rivet;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(rx - rr * 0.3, ry - rr * 0.3, rr * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = UI_SKIN.rivetHi;
      ctx.fill();
    }
  }
}

/**
 * 世界里的一行"物件标签"（废墟类型 / 隧道 / 地穴入口 / 升降台 / 碎石堆）—— 先垫一层暗底再写字。
 *
 * ⚠️ 2026-09-28（用户："随便优化一下界面，让 UI 看的更舒服"）：
 *    这些标签以前是**裸文字**直接压在世界里 —— 压在废墟/地形轮廓上时，
 *    浅色的字和浅色的石头糊成一片（实测截图里"稳固"几乎读不出来）；
 *    两个标签挨得近时更是两行字互相穿插。加一层半透明暗底之后，
 *    "这里有一行标签、它属于哪个物件"一眼可辨，而且**不用改任何间距或机制**。
 *
 * ⚠️ 宽度用 `measureText` 量，不要写死：中文标签长短差很多
 *    （"升降台" 3 字 vs "地穴入口 · 点它下去" 10 字），写死宽度必然有一头难看。
 * ⚠️ 会改 `ctx.font` / `ctx.textAlign`（调用方本来每次也都在设），退出前不还原。
 * ⚠️ 2026-10-01 只改了底色（冷黑 → 暖黑）：它虽然是世界坐标里的东西，但性质上就是
 *    一块小面板 —— 留着冷黑会和这一轮"全暖"的 HUD 断层（用户选的就是"避免一半暖一半冷"）。
 *    药丸形状（圆角）**保留**：它是"贴在物件上的一小片标签"，和切角的铁皮面板不是一类。
 */
function labelPill(ctx, text, x, y, color, font = `bold 11px ${FONT}`) {
  ctx.font = font;
  ctx.textAlign = 'center';
  const w = ctx.measureText(text).width;
  const padX = 5;
  const h = 15;
  ctx.fillStyle = `rgba(${UI_SKIN.panelRgb},0.66)`;
  roundRect(ctx, x - w / 2 - padX, y - 11, w + padX * 2, h, 4);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function bar(ctx, x, y, w, h, ratio, color) {
  drawConsoleBar(ctx, x, y, w, h, ratio, color);
}

/** 一面墙 = **一整块墙板**（2026-10-03 用户要求："每面墙都是一整块，不是像这样拼在一起的"）。
 *
 * 血量从"8 个格子"换成"**从下往上点亮**"：亮区与暗区的分界线就是剩余比例。
 *   · 亮区（还活着）＝ 贴图原色 · 暗区（已损失）＝ 同一张贴图被压暗。
 * ⚠️ 只铺**一次**图案、暗区靠"盖一层深色"实现 —— 铺两次会有两个图案相位，接缝处立刻露馅。
 * ⚠️ 为什么敢不要格子：墙上方那条 `bar()` 仍然是绿→琥珀→红的**颜色警报**。
 *    "还剩多少"由分界线给、"危不危险"由耐久条给 —— 两条读数分工，而且比 8 格更细（原来一档 12.5%）。
 * ⚠️ 分界线必须是一条**亮线**：它是唯一的"还剩多少"读数，不能让人靠亮度差去猜。
 * ⚠️ `r` 是**面的原始矩形**（不再内缩）—— 外壳已经并进墙里了，`faceInnerRect` 已删。
 * @param {object} r 面的矩形
 * @param {number} ratio 该面结构件的耐久占比
 * @param {'deck'|'hull'} tileKey 用哪张可平铺单元（横向面 `deck` / 竖向面 `hull`）
 * @param {{x:number,y:number}} [anchor] 图案相位锚点 —— 见 `drawTiled`（`left`/`door` 要传同一个）
 */
function drawFaceCells(ctx, r, ratio, tileKey, anchor) {
  const alive = Math.max(0, Math.min(1, ratio));
  const top = r.y + r.h * (1 - alive);          // 分界线：从下往上点亮

  drawTiled(ctx, tileKey, r.x, r.y, r.w, r.h, anchor);  // ① 整块（原色）

  if (alive < 1) {                              // ② 暗区：盖一层深色，不重画图案
    // ⚠️ `alive === 0`（打穿）压得更狠：那是**必须一眼看出来**的状态。
    const deadA = alive <= 0 ? 0.92 : 0.82;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, top - r.y);
    ctx.clip();
    ctx.fillStyle = withA(SHELL_SKIN.deep, deadA);
    ctx.fillRect(r.x, r.y, r.w, top - r.y);
    ctx.restore();
  }

  if (alive > 0) {                              // ③ 亮区**提亮**
    // ⚠️ 必须两头拉：这一族（深青）本身就暗（主体 L=20%），只把暗区压下去的话，
    //    "20% → 12%"在偏暗的场景里根本看不出来 —— 第一版就是这么翻车的（实测截图里 45% 和 100% 几乎一样）。
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, top, r.w, r.y + r.h - top);
    ctx.clip();
    ctx.fillStyle = withA(SHELL_SKIN.glow, 0.14);
    ctx.fillRect(r.x, top, r.w, r.y + r.h - top);
    ctx.restore();
  }

  if (alive > 0 && alive < 1) {                 // ④ 分界线：唯一的"还剩多少"读数，要显眼
    ctx.strokeStyle = SHELL_SKIN.glow;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(r.x, top);
    ctx.lineTo(r.x + r.w, top);
    ctx.stroke();
  }
}

/** 材料按自身耐久分四档：完好 → 裂痕 → 变暗 → 彻底破损（消失） */
function matState(hp, maxHp) {
  if (!maxHp || hp <= 0) return 'empty';
  const r = hp / maxHp;
  if (r > 0.66) return 'ok';
  if (r > 0.33) return 'cracked';
  return 'dimmed';
}

function drawCrack(ctx, pr) {
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pr.x + 3, pr.y + 2);
  ctx.lineTo(pr.x + pr.w * 0.55, pr.y + pr.h * 0.5);
  ctx.lineTo(pr.x + pr.w - 3, pr.y + pr.h - 2);
  ctx.stroke();
}

// ==================== 材料形状语言（2026-09-30） ====================
// 形状编码"取向"（板/膜/镜/匣/翼/砖）；颜色继续编码属性（gen-materials.js 生成，本轮不动）。
// 分两个尺寸层：净区短边 ≥ GLYPH_LAYER_B_MIN 走层 B（内部记号 + 合成料副形），否则层 A 只画主形。

const GLYPH_LAYER_B_MIN = 28;    // 净区短边达到这个值才进层 B
const GLYPH_SUB_SCALE = 0.42;    // 合成料副取向的缩放比
const ORIENT_SET = new Set(['hard', 'soft', 'gloss', 'seal', 'light', 'tough']);

/**
 * 从材料 id 解析取向。
 * 切开 '_' 后首段恒为 `t<数字>`；剩 1 段 = 纯料（main），2 段 = 合成料
 * （前段 = 副取向 0.4、后段 = 主取向 0.6 —— 与 gen-materials.js 的取向向量一致）。
 * 非结构件（rod1 / nano_gel …）返回 null。
 */
export function parseMatId(id) {
  const parts = String(id).split('_');
  if (!/^t\d+$/.test(parts[0] || '')) return null;
  const rest = parts.slice(1);
  if (rest.length === 1 && ORIENT_SET.has(rest[0])) return { main: rest[0], sub: null };
  if (rest.length === 2 && ORIENT_SET.has(rest[0]) && ORIENT_SET.has(rest[1])) {
    return { main: rest[1], sub: rest[0] };
  }
  return null;
}

/** 尺寸层：净区短边 ≥ 28 → 'B'，否则 'A' */
export function glyphLayer(w, h) {
  return Math.min(w, h) >= GLYPH_LAYER_B_MIN ? 'B' : 'A';
}

// 启动自检：所有结构件的 id 必须能解析出取向。
// ⚠️ 为什么必须有它：id 是**字符串弱引用**，取向解析失败是**静默**的
//    （画出来还是个纯色块、不抛错），和 config.js 里那些启动自检是同一类问题。
(() => {
  const broken = Object.values(MATERIALS).filter((m) => m.kind === 'struct' && !parseMatId(m.id));
  if (broken.length) {
    throw new Error(`[render] ${broken.length} 个结构件 id 解析不出取向：`
      + broken.slice(0, 5).map((m) => m.id).join(' / ')
      + (broken.length > 5 ? ' …' : ''));
  }
})();

/**
 * 形状在"以 (0,0) 为中心、边长 s"的框里的包围盒（纯几何，不碰 ctx）。
 * ⚠️ 这里的数字必须与 glyphShapePath 里的**取值一致** —— 测试断言两者相等，不一致会红。
 *    （hard/soft/seal 直接复用本函数的返回值、是单一来源；gloss/light/tough 是独立字面量，改动必须同步两处。）
 */
export function glyphBox(orient, s) {
  switch (orient) {
    case 'hard':  { const bw = 0.96 * s, bh = 0.60 * s; return { x: -bw / 2, y: -bh / 2, w: bw, h: bh }; }
    case 'soft':  { const bw = 0.92 * s, bh = 0.70 * s; return { x: -bw / 2, y: -bh / 2, w: bw, h: bh }; }
    case 'gloss': return { x: -0.50 * s, y: -0.50 * s, w: s, h: s };
    case 'seal':  { const bw = 0.60 * s, bh = 0.96 * s; return { x: -bw / 2, y: -bh / 2, w: bw, h: bh }; }
    case 'light': { const bw = 1.00 * s; return { x: -bw / 2, y: -0.40 * s, w: bw, h: 0.90 * s }; }
    case 'tough': { const R = 0.50 * s, hh = (Math.sqrt(3) / 2) * R; return { x: -R, y: -hh, w: 2 * R, h: 2 * hh }; }
    default: throw new Error(`未知取向：${orient}`);
  }
}

/**
 * 把形状路径写进当前 ctx（调用方负责 fill/stroke）。返回**绝对坐标**包围盒。
 * 中心 (cx, cy)、基准边长 s。全部只由直线与圆构成 —— 11.5px 下不会糊成雾。
 */
export function glyphShapePath(ctx, orient, cx, cy, s) {
  const b = glyphBox(orient, s);
  ctx.beginPath();
  switch (orient) {
    case 'hard':                                   // 板：横长方形（直角）
      ctx.rect(cx + b.x, cy + b.y, b.w, b.h);
      break;
    case 'soft':                                   // 膜：胶囊（圆角 = 半高）
      roundRect(ctx, cx + b.x, cy + b.y, b.w, b.h, b.h / 2);
      break;
    case 'gloss':                                  // 镜：菱形
      ctx.moveTo(cx, cy - 0.50 * s);
      ctx.lineTo(cx + 0.50 * s, cy);
      ctx.lineTo(cx, cy + 0.50 * s);
      ctx.lineTo(cx - 0.50 * s, cy);
      ctx.closePath();
      break;
    case 'seal':                                   // 匣：竖长方形（微圆角）
      roundRect(ctx, cx + b.x, cy + b.y, b.w, b.h, 0.12 * s);
      break;
    case 'light':                                  // 翼：尖朝下三角形（上边两点在 −0.40s、下尖在 +0.50s → 包围盒 1.0s×0.90s，上宽下尖）
      ctx.moveTo(cx - 0.50 * s, cy - 0.40 * s);
      ctx.lineTo(cx + 0.50 * s, cy - 0.40 * s);
      ctx.lineTo(cx, cy + 0.50 * s);
      ctx.closePath();
      break;
    case 'tough': {                                // 砖：平顶正六边形
      const R = 0.50 * s;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i);
        const px = cx + R * Math.cos(a), py = cy + R * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    default:
      throw new Error(`未知取向：${orient}`);
  }
  return { x: cx + b.x, y: cy + b.y, w: b.w, h: b.h };
}

// ============================================================
// 结构材料 PNG 贴图（2026-10-02）
//
// 为什么是「灰度图 × 材料色」：结构材料 **125 种颜色**、形状却只有 **6 种取向** —— 图必须共用，
//   颜色只能在运行时上。6 张灰度图放 `prototype/assets/`（dev-server 的根是 `prototype/`，
//   而素材库 `art/` 在它外面、浏览器读不到；小游戏也要求资源在工程内）。
//
// ⚠️ 三条硬约束（都有踩坑来源）：
//   ① **加载必须做环境守卫**：`tools/verify-glyph.js` 是 Node 脚本、却 import 了本模块 ——
//      裸写 `new Image()` 会让它 `ReferenceError: Image is not defined` **直接崩**。
//      Node 下永远拿不到图 → 一律走矢量回退 → 那个自检的全部断言保持原样（这是刻意的）。
//   ② 贴图要**贴合取向的 footprint**（`glyphBox`），不是铺满净区：净区是方的，而"板"是横条、
//      "匣"是竖条 —— 铺满会把 6 种形状的宽高比抹平，而宽高比正是"形状 = 取向"的识别语言。
//      贴合之后 PNG 与矢量回退落在**同一个位置、同一个外接框**，大小尺寸混用也不打架。
//   ③ 灰度图的"白点"必须**每张图各自归一**：6 次独立出图，白点天生不同（实测 `hard/gloss/tough`
//      是 176、`soft/seal/light` 是 255）—— 不归一的话，同一档位的不同取向会差出一整档明度，
//      而"明度 = 档位"是玩法语义。白点取**占比最大的非描边色阶**（= 主体色）；
//      ⚠️ 不能取"最亮像素"：`hard` 图里最亮的只占 3.6%（零星高光），拿它当白点等于没归一。
// ============================================================
// ⚠️ 2026-11-19（用户："把 STRUCT_TEX_MIN 调低，让小格子也显示贴图"）：28 → 11，覆盖
//    墙面补漏位 11.5~18px、工作台台面 24px、暂存堆 12px —— 这些格子现在也贴 PNG，不再画纯色几何形。
// ⚠️ 降阈值时必须同时守住两条**按尺寸独立判断**的通道，否则小格子会被塞爆：
//    ① 副取向仍是 `glyphLayer()`（≥28）才画 —— 副形自身只有 0.42s，11.5px 上只剩 5px，
//       再叠 2px 暗色光晕就是一团糊；
//    ② 档位刻度同理（见 `drawTierBars` 调用处的门槛）—— 4 段短杠连底衬要 17×7px，放不下。
//    也就是说：小格子上"贴图 + 明度"在，"副形 / 刻度"不在，这是尺寸的物理限制、不是漏画。
const STRUCT_TEX_MIN = 11;
const structTex = Object.create(null);      // orient -> Image（加载完才有值；Node 下恒为空）
const structTint = new Map();               // matId -> canvas（灰度 × 该材料色）

if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
  for (const o of ORIENT_SET) {
    const im = new Image();
    im.onload = () => { structTex[o] = im; };
    im.src = `assets/struct_${o}.png`;
  }
}

/** 贴图的剪影 bbox 与白点 —— 首次用到时算一次、挂在 Image 上（每张图只扫描一遍） */
function structMeta(img) {
  if (img._meta) return img._meta;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  const hist = new Map();
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    if (d[i + 3] < 128) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    const v = Math.max(d[i], d[i + 1], d[i + 2]);          // 灰度图三通道相等，取任一即可
    hist.set(v, (hist.get(v) || 0) + 1);
  }
  const darkest = Math.min(...hist.keys());                // 最暗的一档 = 描边色
  let wp = 0, best = -1;
  for (const [v, n] of hist) {
    if (v === darkest) continue;                           // 描边不参与选白点
    if (n > best) { best = n; wp = v; }
  }
  const meta = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, wp, flat: c };
  img._meta = meta;
  return meta;
}

// ============================================================
// 档位的**第二条通道**（2026-10-02，用户从三个候选里选了「② 次档拼缝 + ③ 档位刻度」）
//
// 起因：「明度 = 档位」这一条通道对 7 档来说太挤 —— 实测每档只差 **3.7~5.7pp**，
//   而且同样的"档"在不同取向上亮度不同（t1 板 62% vs t1 镜 84%），玩家学不会"越亮越高档"。
//   于是加两条**不吃颜色**的通道（色相 = 取向 那条硬约束一个字没动）：
//     ② 拼缝：把 7 档拆成「4 组纯档 + 3 组次档」——**语义和机制天然一致**
//        （次蛇/次蛟/次龙 本来就只能靠"合成失败"得到，画成"拼起来、中间有缝"玩家不用学刻度就懂）
//     ③ 刻度：左上角 n 段短杠（n = `tierBars(tier)`，**最多 4 段**）—— 扫得快，但**需要净区 ≥ 28**
//        （墙面格位只有 11.5~18px，放不下；那一档仍然只有明度，这是有意的取舍）
// ⚠️ 两者叠加后，"第几档"变成了「**杠数**（哪一对）× **有无缝**（纯/次）」——
//    7 档是**唯一编码**（4 对 × 2 态 − 1），下面有自检守着。
// ============================================================

/** 是不是"次X级"（合成失败那一档）。⚠️ 从 `TIER_NAME` 取，不写死 `tier % 2` —— 奇偶是**隐含**规则，
 *  而"名字里带次"是写出来的规则。下面配了启动自检，前缀改名会立刻抛错而不是让拼缝静默消失。 */
function isSubTier(tier) {
  return String(TIER_NAME[tier] || '').startsWith('次');
}

// 启动自检：`次X级` 必须正好是"纯档 + 1"那一档（次蛇级在蛇级**下面**那一档）。
// ⚠️ 为什么必须有：拼缝认的是"次"这个**字**，前缀一旦被改名（"次蛇级" → "亚蛇级"），
//    表现是**拼缝静默消失**（图还画得出来、不报错、不断言），和 config 里那些字符串自检同一类问题。
(() => {
  const bad = [];
  for (let t = 2; t <= 6; t += 2) {
    if (!isSubTier(t)) bad.push(`${t}:${TIER_NAME[t]} 不是「次」开头`);
    if (String(TIER_NAME[t]).slice(1) !== TIER_NAME[t + 1]) {
      bad.push(`${t}:${TIER_NAME[t]} 与 ${t + 1}:${TIER_NAME[t + 1]} 不成对`);
    }
  }
  if (bad.length) throw new Error(`[render] TIER_NAME 的「次档」前缀不成立：${bad.join(' / ')}`);
})();

/** ② 次档的「拼缝 + 夹杂」：沿剪影**长轴中点**切一道 1px 错位缝，缝上 3 处夹杂。
 *  ⚠️ ① 按**剪影包围盒**画，不按整张画布画 —— 踩过：用贯穿画布的 45° 斜线时，
 *        它只从"扁板"的一角掠过（板只占 12 行），缝基本看不见；
 *     ② 用 `source-atop` —— 只落在不透明像素上，透明区不会留脏线。 */
function drawStructSeam(ctx, m) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = 'rgba(6,5,4,0.82)';
  const horiz = m.w >= m.h;                      // 横宽的形切竖缝（垂直于长轴），竖高的形切横缝
  if (horiz) {
    const mx = m.x + (m.w >> 1);
    for (let i = 0; i < m.h; i++) {
      const off = (Math.floor(i / 2) % 2) ? 1 : 0;   // 每 2px 错开 1 → 读作"拼接"而不是"切开"
      ctx.fillRect(mx + off, m.y + i, 1, 1);
    }
    for (const f of [0.22, 0.5, 0.78]) {             // 缝上的夹杂（2×2 加粗）
      const iy = m.y + Math.round(m.h * f);
      const off = (Math.floor(Math.round(m.h * f) / 2) % 2) ? 1 : 0;
      ctx.fillRect(mx + off - 1, iy - 1, 2, 2);
    }
  } else {
    const my = m.y + (m.h >> 1);
    for (let i = 0; i < m.w; i++) {
      const off = (Math.floor(i / 2) % 2) ? 1 : 0;
      ctx.fillRect(m.x + i, my + off, 1, 1);
    }
    for (const f of [0.22, 0.5, 0.78]) {
      const ix = m.x + Math.round(m.w * f);
      const off = (Math.floor(Math.round(m.w * f) / 2) % 2) ? 1 : 0;
      ctx.fillRect(ix - 1, my + off - 1, 2, 2);
    }
  }
  ctx.restore();
}

/** ③ 档位的**杠数**：**`次X` 与它对应的 `X` 共用同一个杠数**，靠 ② 的拼缝区分。
 *
 *     虫 1 杠｜次蛇 · 蛇 2 杠（次蛇多一道缝）｜次蛟 · 蛟 3 杠｜次龙 · 龙 4 杠
 *
 *  ⚠️ 为什么是这个划分（前两版都被淘汰）：
 *     · "每档一杠"（7 杠）—— **要一个个数**，扫得慢；
 *     · "3 段"（虫蛇系 / 蛟系 / 龙系）—— 只有 3×2 = 6 种组合，**编码不满** → `t1 虫` 与 `t3 蛇`
 *       撞车（都是 1 段 + 无缝），只能靠明度分。
 *     这一版把 7 档**唯一编码**：杠数管"哪一对"、缝管"是不是次品"（7 = 4 对 × 2 态 − 1，
 *     减的是"虫"—— 没有`次虫`这一态）。最多 4 杠，仍在"一眼数得清"的范围内。
 *  ⚠️ 配对关系**不是巧合**、也不是按奇偶硬凑的：它和**合成树**一致 ——
 *     虫×虫 → 蛇（成功）/ 次蛇（失败），同一次合成的两种结果本来就是"同一级的一对"。
 *     所以这里用 `floor(tier / 2) + 1`（纯算术，不依赖任何字符串），
 *     再由下面的自检去**核对它是否仍与命名（次X）一致** —— 改名破坏配对会立刻抛错。 */
function tierBars(tier) {
  return Math.floor(tier / 2) + 1;            // → 1,2,2,3,3,4,4
}

// 启动自检（两道）：
//   ① **配对必须与命名一致** —— `次X` 要和它上面那个纯档同杠数、纯档要和它下面那个次档同杠数。
//      这样"杠数"和"缝"这两条通道才是对齐的；某档一旦被改名（"次蛇级" → "亚蛇级"），
//      配对断裂、这里立刻抛错（否则表现是"次档和纯档看起来一样"，图仍画得出来）。
//   ② **（杠数, 有无缝）必须能唯一区分 7 档** —— 这是"编码不满"那个坑的守卫：
//      3 段版就是死在这一条上（t1 与 t3 撞车），而当时**没有任何断言拦得住**。
(() => {
  const bad = [];
  for (let t = 1; t <= 7; t++) {
    if (isSubTier(t)) {
      if (tierBars(t) !== tierBars(t + 1)) bad.push(`次档 ${t}:${TIER_NAME[t]} 与 ${t + 1}:${TIER_NAME[t + 1]} 杠数不同`);
    } else if (t > 1 && isSubTier(t - 1)) {
      if (tierBars(t) !== tierBars(t - 1)) bad.push(`纯档 ${t} 与 ${t - 1} 杠数不同`);
    }
  }
  const seen = new Map();
  for (let t = 1; t <= 7; t++) {
    const key = `${tierBars(t)}|${isSubTier(t)}`;
    if (seen.has(key)) bad.push(`${t} 与 ${seen.get(key)} 的（杠数, 有无缝）完全相同 → 撞车`);
    seen.set(key, t);
  }
  if (bad.length) throw new Error(`[render] 档位杠数划分不成立：${bad.join(' / ')}`);
})();

/** ③ 档位刻度：净区左上角 **n 段短杠**（n = `tierBars(tier)`），带深色底衬（任意材料色上都看得见）。
 *  ⚠️ 画在**屏幕坐标**（净区左上角），不是烤进贴图 —— 贴图是"按取向 footprint 贴合"之后再画的，
 *     烤在剪影之外的部分会被那次裁剪切掉；而且固定尺寸能让背包里所有格子的刻度对齐、好扫。 */
function drawTierBars(ctx, x, y, tier) {
  const n = tierBars(tier);
  const w = 3, h = 5, gap = 1, pad = 1;      // 竖短杠：比小方块醒目，3 段也不会糊成一条
  const total = n * w + (n - 1) * gap;
  ctx.save();
  ctx.fillStyle = 'rgba(6,5,4,0.72)';
  ctx.fillRect(x - pad, y - pad, total + pad * 2, h + pad * 2);
  ctx.fillStyle = '#FFFFFF';
  let px = x;
  for (let i = 0; i < n; i++) { ctx.fillRect(px, y, w, h); px += w + gap; }
  ctx.restore();
}

/** 灰度贴图 × 材料色 → 一张上好色的 canvas（按 `matId` 缓存，只算一次）。
 *  白点归一：每个像素 `材料色 × (该像素灰度 / 本图白点)`，超出截到 255。
 *  ⚠️ ② 的拼缝也在这里烤进去（跟着剪影一起缩放）；③ 的刻度**不在这里**（见 `drawTierBars`）。 */
function structTexture(matId, img) {
  const hit = structTint.get(matId);
  if (hit) return hit;
  const m = structMeta(img);
  const mat = MATERIALS[matId];
  const c = document.createElement('canvas');
  c.width = m.flat.width;
  c.height = m.flat.height;
  const g = c.getContext('2d');
  g.drawImage(m.flat, 0, 0);
  if (m.wp > 0) {
    const d = g.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    const col = hexToRgb(mat.color);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      const k = Math.max(px[i], px[i + 1], px[i + 2]) / m.wp;
      px[i] = Math.min(255, Math.round(col.r * k));
      px[i + 1] = Math.min(255, Math.round(col.g * k));
      px[i + 2] = Math.min(255, Math.round(col.b * k));
    }
    g.putImageData(d, 0, 0);
  }
  if (isSubTier(mat.tier)) drawStructSeam(g, m);          // ② 次档：拼缝 + 夹杂
  structTint.set(matId, c);
  return c;
}

/** 把贴图按取向的 footprint 贴合到 (cx,cy)、基准边长 s（保比例、在 footprint 内居中）。
 *  返回 footprint 的**绝对包围盒**（与 `glyphShapePath` 的返回值同构，供 `drawCrack` 用）。 */
function blitStruct(ctx, img, matId, orient, cx, cy, s) {
  const m = structMeta(img);
  const box = glyphBox(orient, s);
  const bx = cx + box.x, by = cy + box.y;
  const k = Math.min(box.w / m.w, box.h / m.h);
  const dw = m.w * k, dh = m.h * k;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;                        // 像素画：只用最近邻，不做插值
  ctx.drawImage(structTexture(matId, img), m.x, m.y, m.w, m.h,
    bx + (box.w - dw) / 2, by + (box.h - dh) / 2, dw, dh);
  ctx.imageSmoothingEnabled = prev;
  return { x: bx, y: by, w: box.w, h: box.h };
}

// ============================================================
// 道具图标（2026-10-04）
// ============================================================
// 与"结构材料贴图"的区别：道具图是**彩图、不需要 tint** —— 档位色（虫 / 蛇 / 蛟）已经烤进图里
//   （`--palette-from <id>` 出图时就按档位色量化过），所以比结构材料少一步：没有
//   `structTexture` 那层"灰度 × 材料色"。
// ⚠️ 文件名 = `item_<matId>.png`（`rod1` / `mir3` / `amp` / `patch_kit` …），matId 直接拼得出来。
//   ⚠️ **不另抄一份 id 清单**：清单直接从 `MATERIALS` 里筛 `kind !== 'struct'` ——
//      正好就是走非结构件分支的那 22 件（6 组 × 3 档 + amp / devour / patch_kit / nano_gel）。
//      抄一份硬编码清单 = 加一件道具就静默漏掉一个图标（回落成色块、不报错），正是本项目反复吃过的
//      "字符串弱引用"那类坑。
// ⚠️ 加载必须做**环境守卫**：`tools/verify-glyph.js` 是 Node 脚本、却 import 了本模块 ——
//   裸写 `new Image()` 会让它 `ReferenceError` 直接崩（同结构材料那批）。Node 下永远拿不到图 →
//   一律走矢量回退（圆角矩形色块），verify-glyph 里"功能件/修复材料回退填满净区"那条断言保持原样。
// ⚠️ **不设尺寸门槛**（2026-10-04 用户选："小尺寸也画图标，先看效果"）：只要图加载了就画，
//   墙面插槽位（11.5~18px）、暂存堆小格（12px）也一样。⚠️ 这一条与结构材料**不同** ——
//   结构材料在 < 28 时退回矢量（它的矢量**带取向形状**，是信息；而道具的矢量只是一块颜色）。
//   📊 待肉眼验收：32px 图标缩到 12px 会不会糊成噪点；若糊，再决定是否按尺寸分层。
// ⚠️ 图标在源图里是**底部对齐**的（pixelize 的"脚贴底"）：直接整张画进净区会让矮件偏下。
//   所以先裁到**剪影包围盒**再居中贴合 —— 和 `blitStruct` 同一个做法。
const ITEM_TEX = Object.create(null);       // matId -> Image（加载完才有值；Node 下恒为空）
const ITEM_IDS = Object.values(MATERIALS).filter((m) => m.kind !== 'struct').map((m) => m.id);

if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
  for (const id of ITEM_IDS) {
    const im = new Image();
    im.onload = () => { ITEM_TEX[id] = im; };
    im.src = `assets/item_${id}.png`;
  }
}

/** 图标剪影的包围盒 —— 首次用到时算一次、挂在 Image 上（每张图只扫描一遍）。
 *  ⚠️ 只量 bbox，不像 `structMeta` 还要算"白点"（道具是彩图、没有灰度归一那一步）。 */
function itemMeta(img) {
  if (img._itemMeta) return img._itemMeta;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] < 128) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const meta = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  img._itemMeta = meta;
  return meta;
}

/** 把道具图标**按剪影包围盒、保比例、居中**贴合到净区 (x,y,w,h)。 */
function blitItem(ctx, img, x, y, w, h) {
  const m = itemMeta(img);
  const k = Math.min(w / m.w, h / m.h);
  const dw = m.w * k, dh = m.h * k;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;                        // 像素画：只用最近邻
  ctx.drawImage(img, m.x, m.y, m.w, m.h, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.imageSmoothingEnabled = prev;
}

// ============================================================
// 世界物件贴图（2026-10-02）—— 目前只有废墟料堆
//
// 和"结构材料贴图"的区别：这些是**物件固有色**（`OBJ_SKIN` 暖灰铁锈阶），不需要按材料上色，
//   所以是一张普通彩图、1:1 直接画。尺寸 **34×29** 就是原来那 4 块矩形拼出来的包围盒 →
//   画在 `(spot.x - 19, spot.y - 19)`，和原几何**逐像素对齐**（接入不该顺手挪动物件）。
//
// ⚠️⚠️ **三种废墟类型（稳固 / 易塌 / 引怪）各有一张外形不同的图**（`RUIN_TEX_KEY`）——
//    2026-10-05 用户："不要用文字表明，不同的图表示不同的废墟"。
//    ⚠️ 这一条**推翻了**原来那句「所有料堆外观完全一样，不透露内容 —— 否则'随机挖出'就没有意义了」。
//       推翻得成立，是因为**类型本来就是公开信息**（2026-09-25 起头顶就写着类型名）——
//       那张小药丸读不清（本文件 171 行自己记着"实测截图里'稳固'几乎读不出来"），
//       现在改成"外形直接说话"。⚠️ 真正**不能透露**的是"里面有什么材料 / 还剩几层"，
//       那两条仍然靠"看不见"守着（层数刻意不显示，见 `drawLoot` 尾部）。
// ⚠️ 加载同样要**环境守卫**（`tools/verify-glyph.js` 在 Node 里 import 本模块），拿不到图就走矢量回退。
// ============================================================
const PROP_TEX = Object.create(null);       // 'ruin' -> Image（加载完才有值；Node 下恒为空）

/** 废墟类型 → 贴图键（三种类型各一张**外形不同**的图，2026-10-05 用户要求）。
 *  ⚠️⚠️ **别用 `'ruin_' + spot.type` 拼**：`RUIN_TYPES` 的 id 是 `caveIn`（大写 I），
 *     而文件名是全小写 `prop_ruin_cavein.png` —— 拼出来的键取不到图，会**静默**退回兜底那张
 *     `ruin`（表现是"三种废墟长得一模一样"，看着像没接上，而所有自检都是绿的）。
 *  ⚠️ 兜底链：类型图 → `ruin`（老那张）→ 矢量矩形（见 `drawLoot`）。 */
const RUIN_TEX_KEY = { stable: 'ruin_stable', caveIn: 'ruin_cavein', lure: 'ruin_lure' };

/** 传送口在门框里的位置 —— **从 `prop_entrance.png` 里量出来的**（那块内嵌面板：x 21~58 / y 22~85）。
 *  ⚠️ 换贴图就必须重量，否则传送口会和面板错位 —— 而且**不会报错**，只是"看着歪了"。
 *     所以下面配了一道加载后自检（`assertPortal`），把这件事变成显式错误。 */
const PORTAL = { x: 21, y: 22, w: 38, h: 64 };

/** 量出"内嵌面板"的矩形：从中点沿四个方向走，走到颜色不再一致为止。只服务 `assertPortal`。 */
function measurePanel(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
  const cx = c.width >> 1, cy = c.height >> 1;
  const base = at(cx, cy);
  const same = (p) => p[3] > 200
    && Math.abs(p[0] - base[0]) <= 6 && Math.abs(p[1] - base[1]) <= 6 && Math.abs(p[2] - base[2]) <= 6;
  let l = cx, r = cx, t = cy, b = cy;
  while (l > 0 && same(at(l - 1, cy))) l--;
  while (r < c.width - 1 && same(at(r + 1, cy))) r++;
  while (t > 0 && same(at(cx, t - 1))) t--;
  while (b < c.height - 1 && same(at(cx, b + 1))) b++;
  return { x: l, y: t, w: r - l + 1, h: b - t + 1 };
}

/** 启动自检：`PORTAL` 必须和贴图里那块面板对得上（容差 2px）。
 *  ⚠️ 为什么必须有：这四个数字是**从素材量出来的几何常量**，和"素材推出来的值"一样 ——
 *     素材一换它就该重算，而它和"设计定的常量"长得一模一样、错了也不报错。 */
function assertPortal(img) {
  const m = measurePanel(img);
  const d = Math.max(Math.abs(m.x - PORTAL.x), Math.abs(m.y - PORTAL.y),
    Math.abs(m.w - PORTAL.w), Math.abs(m.h - PORTAL.h));
  if (d > 2) {
    console.error(`[render] 传送口位置和贴图对不上：图里量到 ${JSON.stringify(m)}，`
      + `而 PORTAL = ${JSON.stringify(PORTAL)}（最大差 ${d}px）。`
      + '换过 prop_entrance.png 就要把 PORTAL 重量一遍 —— 现在画出来的传送口是歪的。');
  }
}

if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
  // ⚠️ 2026-10-05：`ruin_stable / ruin_cavein / ruin_lure` 是同一堆废墟的三种外形
  //    （用户："不要用文字表明，不同的图表示不同的废墟"）。`ruin` 留着当兜底。
  for (const k of ['ruin', 'ruin_stable', 'ruin_cavein', 'ruin_lure',
    'workbench', 'entrance', 'hidden', 'lift', 'tunnel']) {
    const im = new Image();
    im.onload = () => {
      PROP_TEX[k] = im;
      if (k === 'entrance') assertPortal(im);
    };
    im.src = `assets/prop_${k}.png`;
  }
}

/** 画一个物件贴图（1:1 逻辑像素）。**返回是否画了** —— 图没加载完 / Node 环境返回 false，调用方走矢量回退。 */
function drawPropTex(ctx, key, x, y, w, h) {
  const im = PROP_TEX[key];
  if (!im) return false;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(im, x, y, w, h);
  ctx.imageSmoothingEnabled = prev;
  return true;
}

// ============================================================
// 庇护所外壳（飞船 · 2026-10-03）
//
// 庇护所不是"一个物件"、而是一圈**墙条**，所以外壳不能整张贴 —— 拆成 3 条：
//   · `deck` 舱顶   —— 建筑上方 + 顶盖面内的上沿
//   · `gear` 着陆架 —— 基座面内的下沿 + 建筑下方
//   · `hull` 舱壁   —— 左右墙最外那一窄条
//
// ⚠️ 为什么是"可平铺单元"而不是一张整图：320×36 / 11×200 这种扁条**没法从方形源图出图** ——
//    `pixelize` 是等比 contain + 底部对齐，方形源图压进去只会剩一条、上下大片留白。
//    所以素材是**一块模块**，靠重复铺满；单元两端本来就画了"铆接板"的凸起，接起来正好成缝。
// ⚠️ 单元图自带 1px 留白（出图用了 `--inset 1`，不然覆盖率会顶到 96% / 93% 撞断言）→
//    **必须先垫一层底色再铺**，否则每块之间会漏出**世界背景**；垫底之后那 2px 就成了"板缝"。
// ⚠️ 外壳只贴在 `shelterRects()` 之内，或向**上/下**长（`outside` 判定只看 x，见 `SHELTER.shelterRange`）。
//    左右**绝不允许**越出建筑外沿 —— 否则会变成"看着在墙里、判定在外面"的坑人规则。
// ============================================================
/** 所有"贴图素材"的总表（key -> Image）。**Node 下恒为空** —— 拿不到图时调用方走矢量回退。
 *  ⚠️ 2026-10-03 从 `SHELL_TEX` 改名扩充：地形和庇护所外壳用的是**同一套**加载 + 平铺机制，
 *     分两张表只会让 `drawTiled` 每次都要判断"该查哪张"。 */
const TEX = Object.create(null);

/** key -> 文件。⚠️ key 带类别前缀（`shelter_` / `terrain_`），和 PNG 文件名的分法一致。 */
const TEX_SRC = {
  shelter_deck: 'assets/shelter_deck.png',
  shelter_gear: 'assets/shelter_gear.png',
  shelter_hull: 'assets/shelter_hull.png',
  shelter_door: 'assets/shelter_door.png',
  terrain_surface: 'assets/terrain_surface.png',
  terrain_body: 'assets/terrain_body.png',
  // 天空远景（2026-10-04）—— 两层：星云满铺（**双向**无缝）+ 远景岩脊条带（**横向**无缝）
  sky_cloud: 'assets/sky_cloud.png',               // 星云/尘带 512×256（双向，铺满整屏）
  // 悬空岩桥（2026-10-04）—— 三种落脚点各一张**横向可平铺**条带（宽度 90~320 随机 → 必须平铺）
  platform_main: 'assets/platform_main.png',       // 主干岩桥 210×18
  platform_branch: 'assets/platform_branch.png',   // 支桥     237×18
  platform_ledge: 'assets/platform_ledge.png',     // 天然石台 104×14
  prop_shelf: 'assets/prop_shelf.png',             // 天然岩棚 104×76，右侧岩柱
  // 庇护所室内（2026-10-04）—— 后墙是**双向**可平铺、地板是**横向**可平铺条带
  interior_wall: 'assets/interior_wall.png',       // 室内后墙 128×128（双向）
  interior_floor: 'assets/interior_floor.png',     // 室内地板 160×26（横向；宽 160 → base 320 正好 2 块）
  // 补漏位的**底面**（2026-10-05）—— 两个状态各一张 18×18；**插槽位不出图**（保持矢量虚线框）
  slot_breach: 'assets/slot_breach.png',           // 空位 = 破洞（深色缺口 + 青绿断口）
  slot_patch: 'assets/slot_patch.png',             // 有料 = 已补（青绿补板 + 四角铆钉），画在材料图标**下面**
  // 地下洞顶（2026-10-05）—— **横向**可平铺：岩带 80 + 钟乳石 42 = 高 122（设计值），宽 483 由剪影比反算
  under_ceiling: 'assets/under_ceiling.png',
};

if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
  for (const [k, src] of Object.entries(TEX_SRC)) {
    const im = new Image();
    im.onload = () => { TEX[k] = im; };
    im.src = src;
  }
}

/** 外壳装饰的尺寸 —— **纯渲染参数、不参与任何命中判定**，所以留在渲染层（对照 `PORTAL`）。
 *  ⚠️ 2026-10-03 删掉了 `deck` / `base` / `side` 三条：墙面现在是**整块墙板**（外壳并进墙里了），
 *     不再需要"从墙条里让出一圈"。只剩上下两条**长在建筑之外**的装饰 ——
 *     它们之所以免费，是因为 `outside` 判定**只看 x**（见 `SHELTER.shelterRange`）。 */
const SHELL = { up: 24, down: 24 };

/** 地表层的厚度（2026-10-03）—— 同样是**纯渲染参数**，不参与任何判定。
 *  ⚠️ 它从**地表线往下**长（上沿贴住 `terrainY`），所以玩家的脚正好踩在它的上沿上。
 *     这也是为什么不能让素材"骑"在地表线上：那样会盖住 8px 天空，而且脚看起来会陷进地里。 */
const TERRAIN_SURFACE_H = 16;

/** 天然石台（`LEDGES`）的绘制高度 —— **纯渲染参数**（落地判定只看顶面），
 *  ⚠️ 但它**是素材推出来的**：`platform_ledge.png` 就是 14 高（2026-10-04）。
 *     换素材必须重算，否则那块石头会被压扁 / 顶面高光浮在图外（见 04 里"框的宽高比"那两条）。 */
const LEDGE_H = 14;

/** 平铺相位的**世界锚点**。给"同一层里分几次铺"的场合用（地形的每个台地、左墙的门与墙…）——
 *  各段自己起算的话，接缝处图案会跳一下。 */
const ANCHOR0 = { x: 0, y: 0 };

// （庇护所外壳的加载列表已并进上面的 `TEX_SRC` —— 2026-10-03 与地形素材合并成一张表。）

/** pattern 缓存 —— 每帧都 `createPattern` 是白花；同一 ctx 上按 key 缓存一次就够。 */
let _patCtx = null;
const TEX_PAT = Object.create(null);

/** 把一个**可平铺单元**铺满矩形（1:1 逻辑像素，图案按自身尺寸重复）。**返回是否铺了**。
 *  ⚠️ 2026-10-03（单元改成"两端形状一致"之后）：**不再垫底色**。
 *     上一版必须垫底，是因为单元四周留了 1px（`--inset 1`）→ 每两块之间出现 2px 透明缝。
 *     现在单元走 `pixelize --tile`（cover + 两端形状一致）→ 图案是**接得上的**；
 *     而图案自己的透明区（比如着陆架的腿之间）**本来就该露出背景**（地面 / 天空），
 *     再垫一层反而会在地面上糊出一块深青色块。
 *  @param {{x:number,y:number}} [anchor] 图案相位的锚点（默认 = 矩形左上角）。
 *    ⚠️ 为什么要它：`left` 与 `door` 是**同一面墙的上下两段**（各有各的耐久 → 必须分两次铺），
 *       而它们在世界上是**连续的 y**。传同一个锚点，两段的图案才接得上；不传的话
 *       每段都从自己的左上角起算，接缝处图案会**跳一下**（不报错，只是看着"那段墙重了"）。 */
function drawTiled(ctx, key, x, y, w, h, anchor) {
  const im = TEX[key];
  if (!im || w <= 0 || h <= 0) return false;
  if (_patCtx !== ctx) {
    _patCtx = ctx;
    for (const k in TEX_PAT) delete TEX_PAT[k];
  }
  if (!TEX_PAT[key]) TEX_PAT[key] = ctx.createPattern(im, 'repeat');
  const pat = TEX_PAT[key];
  if (!pat) return false;

  const ax = anchor ? anchor.x : x;
  const ay = anchor ? anchor.y : y;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(ax, ay);            // 相位锚点（世界坐标里的一个固定点，不随相机滚）
  ctx.fillStyle = pat;
  ctx.fillRect(x - ax, y - ay, w, h);
  ctx.restore();
  return true;
}

/** 面**真正用来画血量格子**的矩形 —— 2026-10-03 已删除。
 *  墙面现在是整块墙板（外壳并进墙里），不再需要"让出一圈"；
 *  保留这段注释只为让搜 `faceInnerRect` 的人知道它去哪了（别再照着老代码加回来）。 */

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/**
 * 层 B 的内部记号：给形状做二次确认（大格上"轮廓 + 记号"双通道，容错更高）。
 * 记号颜色**自适应底色亮度** —— 深度料里的板/砖系底色很暗（如 t7_hard 的 #3d4557），
 * 固定深色记号会看不见；而浅色系（如 t1_light 的 #f5ebad）又需要深记号。所以按亮度二选一。
 * box = 主形绝对包围盒（glyphShapePath 的返回值）。
 */
function glyphMark(ctx, orient, box, fillColor) {
  const { r, g, b } = hexToRgb(fillColor);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const ink = lum >= 0.45 ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.5)';
  const m = Math.min(box.w, box.h);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

  ctx.save();
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = Math.max(1.5, m * 0.09);
  ctx.beginPath();
  switch (orient) {
    case 'hard':                                  // 中缝
      ctx.moveTo(cx - 0.25 * m, cy); ctx.lineTo(cx + 0.25 * m, cy);
      break;
    case 'soft':                                  // 波纹
      ctx.moveTo(cx - 0.25 * m, cy + 0.10 * m);
      ctx.quadraticCurveTo(cx, cy - 0.18 * m, cx + 0.25 * m, cy + 0.10 * m);
      break;
    case 'gloss':                                 // 高光
      ctx.moveTo(cx - 0.14 * m, cy + 0.20 * m); ctx.lineTo(cx + 0.18 * m, cy - 0.22 * m);
      break;
    case 'seal':                                  // 盖扣（下面画实心小方块）
      break;
    case 'light':                                 // 中轴
      ctx.moveTo(cx, cy - 0.25 * m); ctx.lineTo(cx, cy + 0.25 * m);
      break;
    case 'tough':                                 // 交叉
      ctx.moveTo(cx - 0.25 * m, cy); ctx.lineTo(cx + 0.25 * m, cy);
      ctx.moveTo(cx, cy - 0.25 * m); ctx.lineTo(cx, cy + 0.25 * m);
      break;
    default:
      throw new Error(`未知取向：${orient}`);
  }
  ctx.stroke();
  if (orient === 'seal') {
    const d = 0.16 * m;
    ctx.fillRect(cx - d / 2, cy - d / 2, d, d);
  }
  ctx.restore();
}

/**
 * 材料图标的**唯一绘制入口**。
 * (x, y, w, h) = 图标净区（调用方自己算内缩），**不是**格子外框。
 * opts.state  : 'ok' | 'cracked' | 'dimmed'（破损三态，默认 ok；**其它值一律按 ok 处理**，不抛错 —— 这条路径每帧都在跑）
 * opts.radius : 功能件/修复材料**回退成圆角矩形**时的圆角（结构件走形状、用不到它）；
 *               破损变暗时"叠黑整格"的圆角也复用它
 *
 * ⚠️ 为什么必须收敛成一个入口：形状一旦有第二份实现，5 处调用点迟早漂移。
 * ⚠️ 功能件（rod1 / mir1 / …）与修复材料没有取向 → 优先画**道具图标**（`ITEM_TEX`，图已加载时；
 *    不设尺寸门槛，小尺寸也画），否则回退成圆角矩形色块。
 * ⚠️ 填充色仍是 MATERIALS[id].color —— 颜色语义（色相=取向、明度=档位）一个字不改。
 * ⚠️ 整个函数包在 save/restore 里：它会改 fillStyle（破损态经 drawCrack 还会改 strokeStyle/lineWidth），
 *    不该把样式污染甩给调用方 —— 5 处调用点每帧都在画，迟早有人依赖调用前的样式。
 */
export function drawMaterialGlyph(ctx, x, y, w, h, matId, opts = {}) {
  const mat = MATERIALS[matId];
  if (!mat) return;
  const state = opts.state || 'ok';
  const radius = opts.radius ?? 4;
  const parsed = mat.kind === 'struct' ? parseMatId(matId) : null;

  ctx.save();

  if (!parsed) {                        // 功能件 / 修复材料：有图标就画图标，拿不到（图没加载 / Node）再回退成色块
    // ⚠️ **先建 roundRect 路径、再决定填不填**：`drawFacePositions` 靠这个函数留下的**当前路径**
    //    画（虚线）插槽框 —— 画图标不会建路径，若不先建，那个 `ctx.stroke()` 会描到**上一个残留路径**
    //    （不报错、只画歪）。回退那条同样复用这条路径来填色。
    // ⚠️ 回退那条**填满整个净区**，是 verify-glyph.js "功能件/修复材料回退填满净区"那条断言依据，别改。
    roundRect(ctx, x, y, w, h, radius);
    const icon = ITEM_TEX[matId];
    if (icon) {
      blitItem(ctx, icon, x, y, w, h);
      ctx.restore();
      return;
    }
    ctx.fillStyle = mat.color;
    ctx.fill();
    ctx.restore();
    return;
  }

  const s = Math.min(w, h);
  const cx = x + w / 2, cy = y + h / 2;

  // ---- PNG 贴图分支（净区够大 + 图已加载完；图未加载 / Node 自检一律落到下面的矢量）----
  const tex = s >= STRUCT_TEX_MIN ? structTex[parsed.main] : null;
  if (tex) {
    const box = blitStruct(ctx, tex, matId, parsed.main, cx, cy, s);
    if (glyphLayer(w, h) === 'B' && parsed.sub) {
      // 副取向：同一张贴图缩到 42%、锚在净区右下角内侧。
      // ⚠️ PNG 这边**不需要**额外描一圈暗色光晕 —— 贴图自带深色描边，主形/副形天然分得开；
      //    矢量那边必须描，是因为两个形状都是**同色实心块**、不描就糊成一片。
      const sub = structTex[parsed.sub];
      if (sub) {
        const s2 = s * GLYPH_SUB_SCALE;
        blitStruct(ctx, sub, matId, parsed.sub, x + w - 1 - s2 / 2, y + h - 1 - s2 / 2, s2);
      }
    }
    // ③ 档位刻度：净区左上角 n 段短杠（**只在净区 ≥28 时画** —— 4 段短杠连底衬要 17×7px，
    //    墙面 11.5px 的格子放不下，硬画会整格盖住；这一档只靠明度区分，是有意取舍）
    if (s >= GLYPH_LAYER_B_MIN) drawTierBars(ctx, x + 1, y + 1, MATERIALS[matId].tier);
    // ⚠️ PNG 路径**不画 glyphMark**：那套内部记号（中缝/波纹/高光…）是给**纯色块**做的
    //    二次确认；贴图自带内部细节，再叠一层会打架。
    if (state === 'cracked') drawCrack(ctx, box);
    if (state === 'dimmed') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, x, y, w, h, radius);
      ctx.fill();
      drawCrack(ctx, box);
    }
    ctx.restore();
    return;
  }

  // ---- 矢量回退（原路径：小尺寸 / 贴图未加载 / Node 无头自检）----
  const box = glyphShapePath(ctx, parsed.main, cx, cy, s);
  ctx.fillStyle = mat.color;
  ctx.fill();

  const layerB = glyphLayer(w, h) === 'B';
  if (layerB && parsed.sub) {
    // 副取向：缩到 0.42，锚在净区右下角内侧。
    // 副形与主形**同色**（材料只有一个混色），所以先描一圈暗色光晕把两者"抠"开。
    // ⚠️ 光晕 width 在现有全部层 B 尺寸（32/34/46）下都命中 2px 下限，系数项暂时不生效。
    const s2 = s * GLYPH_SUB_SCALE;
    const scx = x + w - 1 - s2 / 2;
    const scy = y + h - 1 - s2 / 2;
    ctx.save();
    glyphShapePath(ctx, parsed.sub, scx, scy, s2);
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, s2 * 0.10);
    ctx.strokeStyle = `rgba(${UI_SKIN.panelRgb},0.85)`;
    ctx.stroke();
    ctx.fillStyle = mat.color;
    ctx.fill();
    ctx.restore();
  }
  if (layerB) glyphMark(ctx, parsed.main, box, mat.color);

  if (state === 'cracked') drawCrack(ctx, box);
  if (state === 'dimmed') {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, x, y, w, h, radius);
    ctx.fill();
    drawCrack(ctx, box);
  }

  ctx.restore();
}

/**
 * 「+」扩展位：点一下就把 1 个"扩展空位"额度花在这面（该面补漏位永久 +1）。
 * ⚠️ 这是真机上唯一的入口，而且它代表"玩家手上还没用掉的成长资源"，
 *    所以必须画得比普通空格更显眼（绿色虚线 + 粗体 + 半透明底）。
 */
function drawExpandSlot(ctx, r) {
  ctx.save();
  ctx.fillStyle = withA(UI_SKIN.ok, 0.16);   // = ok @ 0.16
  roundRect(ctx, r.x, r.y, r.w, r.h, 3);
  ctx.fill();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = UI_SKIN.ok;
  ctx.lineWidth = 2;
  roundRect(ctx, r.x, r.y, r.w, r.h, 3);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = UI_SKIN.ok;
  ctx.font = `bold ${Math.max(12, Math.round(r.w * 0.72))}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('+', r.x + r.w / 2, r.y + r.h / 2);
  ctx.restore();
}

/** 补漏位的**底面贴图**（2026-10-05）。
 *  `key` ∈ `slot_breach`（空位 = 破洞）/ `slot_patch`（有料 = 已补）。
 *  ⚠️ 用**最近邻**（和本项目其他像素贴图一致，见 `blitStruct` 那族）。
 *  ⚠️ 图四周留了 1px 透明边（`pixelize --inset 2` + 工具统一补的那圈深青描边）——
 *     那 1px 正好被上面那圈框线压住，所以看起来"贴图刚好填满格子"。
 *  @returns {boolean} 画了没（图没加载 → false，调用方回退）
 */
function drawSlotFill(ctx, key, r) {
  const im = TEX[key];
  if (!im) return false;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;     // 像素画：只用最近邻，不做插值
  ctx.drawImage(im, r.x, r.y, r.w, r.h);
  ctx.imageSmoothingEnabled = prev;
  return true;
}

/** 面上的格位：补漏位实线框、插槽位虚线框；结构件按耐久显示裂痕/变暗 */
function drawFacePositions(ctx, face, faceId, s) {
  const rects = facePositionRects(faceId, face.structSlots, face.funcSlots);
  const repairing = s.repairingFaceId === faceId;
  // 参差的种子取自面 id：**同一面每次重绘得到同一套抖动**（不能用随机数，
  // 否则每帧都在变，画面会抖成噪点 —— 见 art.js 的 wobble 注释）。
  const seed = strSeed(faceId);
  rects.forEach((pr, i) => {
    const p = face.positions[i];
    // 荒诞几何·参差：每个格子按 (面, 序号) 微抖。
    //   位置 ±1px；尺寸**只放大 0~1.5px**（Math.abs）——
    //   格子下限 11.5px 是本项目定下的触屏可点下限（world.js 的 POS_MIN），缩小会破掉它。
    //   三个种子偏移 0 / +101 / +202 不是随手写的：同种子同序号会让 x / y / 尺寸三处
    //   拿到**同一个** wobble 值，整个格子就变成沿对角线整体平移（看起来是"整片歪了"），
    //   而不是每格各偏一点。错开后三处才互不相关，才有参差感。
    // ⚠️ 抖动只作用于**绘制**：点击命中仍用 facePositionRects 的原矩形。
    //    1px 的偏差相对最小 11.5px 的格子可以忽略，换来的是绘制层不必污染纯逻辑层（world.js）。
    const dSize = Math.abs(wobble(seed + 202, i, ART.wobbleSize));
    const gr = {
      x: pr.x + wobble(seed, i, ART.wobblePos),
      y: pr.y + wobble(seed + 101, i, ART.wobblePos),
      // w / h 共用同一个 dSize 是**有意的**：正方格子抖成正方形，只变大小不变形状。
      w: pr.w + dSize,
      h: pr.h + dSize,
    };
    const isStruct = p.kind === 'struct';
    const isDropTarget = s.dragTarget && s.dragTarget.faceId === faceId && s.dragTarget.posIndex === i;
    const st = isStruct ? matState(p.hp, p.maxHp) : (p.mat ? 'ok' : 'empty');

    // 底面（2026-10-05）：**只有补漏位（结构件）换贴图** ——
    //   空位 = `slot_breach`（破洞）、有料 = `slot_patch`（已补的补丁板，压在材料图标下面）。
    //   ⚠️ 插槽位**不做贴图**（用户 2026-10-05 定）：它是虚线框，底色保持原矢量填充。
    //   ⚠️ 贴图**只当"底"**：实线=补漏位 / 虚线=插槽位 这条**功能信息仍由下面那段
    //      `ctx.stroke()` 画**（不能让贴图去承担 —— 12px 下贴图里的线型根本读不出来）。
    //   ⚠️⚠️ **顺序不能改**：`ctx.stroke()` 描的是"当前路径"，而贴图是 `drawImage`（**不建路径**）。
    //      所以空位分支必须"**先 `roundRect` 建路径、再画贴图**"；有料分支必须
    //      "**先画贴图、再让 `drawMaterialGlyph` 建它自己那条路径**"。
    //      在这两处之间插进别的建路径调用 = 下面静默描错对象（那段注释里写着的坑）。
    if (!isStruct) {
      if (st === 'empty') {
        ctx.fillStyle = `rgba(${UI_SKIN.panelRgb},0.42)`;
        roundRect(ctx, gr.x, gr.y, gr.w, gr.h, 3);
        ctx.fill();
      } else {
        drawMaterialGlyph(ctx, gr.x, gr.y, gr.w, gr.h, p.mat, { state: st, radius: 3 });
      }
    } else if (st === 'empty') {
      roundRect(ctx, gr.x, gr.y, gr.w, gr.h, 3);        // 先建路径（下面 stroke 要用），不填
      if (!drawSlotFill(ctx, 'slot_breach', gr)) {      // 图没加载 → 回退成原来的矢量填充
        ctx.fillStyle = `rgba(${UI_SKIN.panelRgb},0.42)`;
        ctx.fill();
      }
    } else {
      drawSlotFill(ctx, 'slot_patch', gr);              // 已补的底衬（图没加载时什么都不画）
      // 净区 = 整个格子（墙上格子只有 11.5~18px，没有内缩余量）→ 层 A
      drawMaterialGlyph(ctx, gr.x, gr.y, gr.w, gr.h, p.mat, { state: st, radius: 3 });
    }

    // ⚠️「挨过打」的角标（2026-09-26 用户要求"破损的结构件取下会消失"之后加的）。
    //    规则是"耐久 < 满耐久就算破损、取下即废"，但画面上**看不出来** ——
    //    matState 要到 66% 以下才画裂痕，所以掉 5% 耐久时颜色和完好完全一样。
    //    如果只做规则不做标记，玩家会以为一块完好的料取下来却凭空消失（= 看不见的坑人规则）。
    //    所以这个角标的意思很明确：**带上它，取下来就没了**。修复修满，角标消失。
    if (isStruct && p.mat && p.hp < p.maxHp) {
      const d = Math.max(3, Math.min(5, gr.w * 0.32));
      ctx.fillStyle = UI_SKIN.warn;
      ctx.fillRect(gr.x + gr.w - d - 2, gr.y + 2, d, d);
    }

    // ⚠️ 下面这个 ctx.stroke() 描的是**当前路径**——即上面分支里最后一次建路径调用留下的东西：
    //    空位 / 功能件 → roundRect(gr) 的格子框；结构件完好 → drawMaterialGlyph 内的材料主形轮廓；
    //    结构件破损 → drawCrack 内的裂痕折线。
    //    save()/restore() **不会**保存/恢复路径，只有 beginPath() 会重置它；所以路径"活"到了这里。
    //    这是改动前就有的行为（本轮只是把 pr 换成 gr）。**别在上面的 empty/else 分支与这个
    //    stroke 之间插入新的建路径调用**（多画一道线、或补一个 roundRect），否则这里会静默
    //    描错对象 —— 不会报错，只会画歪。
    // 实线 = 补漏位（结构件）；虚线 = 插槽位（功能件）
    // ⚠️ 这几条框线压在**暖棕的墙**上，白线（`rgba(255,255,255,·)`）会偏冷发青 →
    //    换成暖白（= UI_SKIN.textStrong 的 rgb）。
    ctx.strokeStyle = isDropTarget ? UI_SKIN.info
      : repairing && isStruct ? UI_SKIN.ok
        : p.mat ? withA(UI_SKIN.textStrong, 0.55)
          : isStruct ? withA(UI_SKIN.textStrong, 0.30) : withA(UI_SKIN.textStrong, 0.16);
    ctx.lineWidth = isDropTarget || (repairing && isStruct) ? 3 : 1.5;
    ctx.setLineDash(isStruct ? [] : [3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // 「+」扩展位（2026-09-26）：只要手上还有没放置的空位额度，每面都画一个。
  // 它排在各面所有格位的**最后**（用同一套排布算出来，所以折行时也不会跑偏）。
  if (s.shelter.bonusSlots > 0) {
    const er = expandSlotRect(faceId, face.structSlots, face.funcSlots);
    if (er) drawExpandSlot(ctx, er);
  }
}

export function render(ctx, s) {
  ctx.save();
  ctx.clearRect(0, 0, VIEW.w, VIEW.h);

  const sh = s.shake > 0 ? s.shake : 0;
  const quake = Math.min(1, (s.quakeT || 0) / 0.25);
  const shx = quake ? Math.sin(s.quakeT * 70) * 12 * quake : sh ? (Math.random() - 0.5) * sh * 12 : 0;
  const shy = quake ? Math.cos(s.quakeT * 93) * 6 * quake : sh ? (Math.random() - 0.5) * sh * 8 : 0;

  ctx.save();
  ctx.translate(shx, shy);
  ctx.save();
  // ⚠️⚠️ 世界**整体放大** `CAMERA.zoom` 倍（2026-10-05 用户："人物看上去有点小，镜头拉近一点"）。
  //    它必须放在**所有世界绘制之前**，而且**只包住世界**：UI 在 `ctx.restore()` 之后画，
  //    保持 1:1 —— 面板坐标是按 1280×720 写死的，跟着缩放会直接跑出画布。
  //    ⚠️ 相机位移在缩放**之内**（顺序：translate(shake) → translate(锚点) → scale → translate(-camera)），
  //       所以屏幕 = (世界 − 相机) × zoom，而 y 以 `CAMERA_ANCHOR_Y` 为锚。
  //       逆运算在 config 的 `screenToWorld()` —— **改一处必须改两处**（漂了 = 看着在哪、点在哪错开）。
  //    ⚠️ 锚点那一行不能省：不锚的话地面（世界 y=570）会被放大到屏幕 769 > 画布 720 → **整条地面推出屏幕**。
  ctx.translate(0, CAMERA_ANCHOR_Y * (1 - CAMERA.zoom));
  ctx.scale(CAMERA.zoom, CAMERA.zoom);
  drawBackground(ctx, s);
  ctx.save();
  // ⚠️ 纵向也要位移（2026-09-29 新增"视角跟随"）：`+s.camera.y` = 画面整体往下推，
  //    于是"人物上到岩桥"时他不会顶到屏幕上方的横幅/HUD 里（见 config 的 CAMERA 注释）。
  ctx.translate(-s.camera.x, s.camera.y);
  drawPlatforms(ctx, s);      // 悬空岩桥（地形之上的"上层路线"）
  drawMonsters(ctx, s);
  // ⚠️ 庇护所 + 工作台是**地面上的建筑**：地下是另一张地图，不该出现
  //    （2026-09-27 用户问"为什么地下也有庇护所"）。
  //    它们的**面板与交互**也一并只在有地面时生效：见下面 drawStore / 庇护所面板，
  //    以及 main.js 的 `inBuildZone()`（它管着贴料/取下/修复/仓库/合成这一整片）。
  if (s.layer !== 'under') {
    drawShelter(ctx, s);
    drawWorkbench(ctx, s);
  }
  drawLifts(ctx, s);          // 遗迹升降台（地面上的入口，地下本层列表为空）
  drawEntrances(ctx, s);      // 地穴入口 / 上行口（分层世界的门）
  drawHidden(ctx, s);         // 隐藏区：碎石堆
  drawTunnels(ctx, s);        // 隧道洞口
  drawLoot(ctx, s);
  if (s.mode === 'tutorial' && [1, 2].includes(s.tutorialStep) && !s.tutorialDone) {
    ctx.save();
    ctx.strokeStyle = UI_SKIN.ok; ctx.lineWidth = 2;
    if (s.tutorialStep === 2) {
      if (s.layer !== 'under') {
        const r = shelterRects().roof;
        ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
      }
    } else {
      const target = s.world.loot.filter((l) => l.available && l.type === 'stable' && !l.plat)
        .sort((a, b) => Math.abs(a.x - s.player.x) - Math.abs(b.x - s.player.x))[0];
      if (target) { ctx.beginPath(); ctx.arc(target.x, target.y - 18, 40, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.restore();
  }
  drawEffects(ctx, s);        // 灾害特效（威胁侧：零抖动，见 art.js 的分类表）
  drawActionFx(ctx, s);       // 玩家动作反馈（玩家侧：用 wobble，见它的注释）
  drawPlayer(ctx, s);
  ctx.restore();
  ctx.restore(); // 退出世界缩放；光圈和整屏染色只保留屏幕震动
  drawDarkness(ctx, s);        // 可见度（屏幕坐标，必须在世界绘制之后、UI 之前）

  // 洞顶（地下专属）—— **画在黑暗层之后**，所以不吃手电筒的黑暗（2026-10-05 方案 C，理由见函数注释）。
  // ⚠️ 它是**世界坐标**里的东西，而这一段已经在屏幕坐标下 → 必须手动把相机位移补回来。
  // ⚠️ 放在 `drawDisasterOverlay` **之前**：它是世界的一部分，灾害期的整屏染色该盖到它。
  // ⚠️ 仍在 shake 的变换里（跟着画面一起震）。
  if (s.layer === 'under') {
    ctx.save();
    // ⚠️ 这里要**手动补回世界变换**（它画在屏幕坐标下，理由见上），所以 zoom 与锚点都要带上 ——
    //    少一样洞顶就会比地形小一圈 / 整体错位，和岩壁对不上。
    ctx.translate(0, CAMERA_ANCHOR_Y * (1 - CAMERA.zoom));
    ctx.scale(CAMERA.zoom, CAMERA.zoom);
    ctx.translate(-s.camera.x, s.camera.y);
    drawUnderCeiling(ctx, s);
    ctx.restore();
  }

  // 发光的陨石／光束和屋外龙卷风单独画在夜色上方。
  ctx.save();
  ctx.translate(0, CAMERA_ANCHOR_Y * (1 - CAMERA.zoom));
  ctx.scale(CAMERA.zoom, CAMERA.zoom);
  ctx.translate(-s.camera.x, s.camera.y);
  drawEffects(ctx, s, true);
  ctx.restore();
  drawDisasterOverlay(ctx, s);
  ctx.restore();

  drawHUD(ctx, s);
  drawMinimap(ctx, s);        // 小地图（HUD 下方的空档里）
  if (s.layer === 'ground' && Math.abs(s.player.x - SHELTER.cx) < PLAYER.buildRadius) {
    drawPanelChrome(ctx, 'attr', true);
    drawPanelChrome(ctx, 'storage', true);
  }

  // 地下标识 —— 必须显眼：小地图这时也换成了**另一张地图**，
  // 没有这个标记的话，玩家会误以为"地图怎么变了/我是不是卡住了"。
  if (s.layer === 'under') {
    ctx.fillStyle = withA(IDENTITY.zoneUnder, 0.9);
    ctx.font = `bold 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('◈ 地下（灾害期会被震回地面）', VIEW.w / 2, 32);
    ctx.textAlign = 'left';
  }
  drawBag(ctx, s);
  drawSynthPanel(ctx, s);
  drawTrash(ctx, s);
  drawTrashUndo(ctx, s);
  if (s.mode === 'tutorial' && !s.tutorialDone && s.layer === 'ground'
      && Math.abs(s.player.x - SHELTER.cx) < PLAYER.buildRadius) {
    const r = s.tutorialStep === 3 ? uiLabelRect('attr') : s.tutorialStep === 4 ? skipBtnRect() : null;
    if (r) { ctx.strokeStyle = UI_SKIN.ok; ctx.lineWidth = 2; ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8); }
  }
  drawDragGhost(ctx, s);
  if (s.endSummary) drawSummary(ctx, s);
  else if (s.banner) drawBanner(ctx, s);

  // 通用过渡的黑幕（盖在最上面：渐黑 → 中点执行动作 → 渐亮）。
  // ⚠️ 隧道传送和地穴口换层共用它，见 main.js 的 startFade。
  // ⚠️ 曲线刻意做成"对称三角"（前一半渐黑、后一半渐亮），中点恰好最黑 ——
  //    而真正的瞬移就发生在那一帧（main.js 的 `f.mid()`），所以玩家看不到人换地方。
  if (s.fade) {
    const f = s.fade;
    const k = f.t / f.dur;
    const a = Math.min(1, k < 0.5 ? k * 2 : (1 - k) * 2);
    ctx.fillStyle = `rgba(0,0,0,${a.toFixed(2)})`;
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  }

  ctx.restore();
}

function drawBackground(ctx, s) {
  ctx.fillStyle = PALETTE.envDeep;
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);

  ctx.save();
  ctx.translate(-s.camera.x, s.camera.y);

  // ---- 天空远景层（2026-10-04）----
  // ⚠️ 光"铺"是不够的，**必须带视差**：远景按 0.3 倍跟着相机走（近景地形是 1.0）。
  //    没有视差的话，远景就是**贴在屏幕上的墙纸**，"世界有多远"立刻消失 —— 那还不如原来的纯色。
  //    实现就是"把层的有效平移量乘 k"：基础平移已是 `-camera.x`，所以这里再补 `+camera.x*(1-k)`。
  // 天空贴图缺失时使用底色；不叠加有明显水平硬边的岩脊色带。
  const SKY_PARALLAX = 0.3;
  const kx = s.camera.x * SKY_PARALLAX, ky = s.camera.y * SKY_PARALLAX;
  ctx.save();
  ctx.translate(s.camera.x * (1 - SKY_PARALLAX), -s.camera.y * (1 - SKY_PARALLAX));
  drawTiled(ctx, 'sky_cloud', kx, -ky, VIEW.w, VIEW.h, ANCHOR0);
  ctx.restore();

  // ---- 地形（每波程序化生成，见 world.js 的 genTerrain）----
  // ⚠️ 按**段**画，不是等距采样：
  //   ① 采样法在"垂直岩壁"处会画出一条斜线 → 墙的视觉位置与物理位置对不上（最多差一个步长）；
  //   ② 世界 4800 宽时逐点采样也更贵。段本身就是"水平台阶"，直接画最准、也最省。
  const prof = terrainProfile();
  const segPts = [];
  if (prof && prof.length) {
    // ⚠️ 2026-10-03：段变成**斜的**了，而且每段**自带两个端点**的高度（`riseL` / `riseR`）——
    //    直接从段里取，不要拿"上一段的 rise"去拼（左右两半的生成方向相反，拼出来会反）。
    for (const s of prof) {
      segPts.push([s.x0, WORLD.groundY - s.riseL], [s.x1, WORLD.groundY - s.riseR]);
    }
  } else {
    segPts.push([0, WORLD.groundY], [WORLD.width, WORLD.groundY]);
  }
  ctx.beginPath();
  ctx.moveTo(0, VIEW.h + 200);
  for (const [px, py] of segPts) ctx.lineTo(px, py);
  ctx.lineTo(WORLD.width, VIEW.h + 200);
  ctx.closePath();
  ctx.fillStyle = PALETTE.envFill;
  ctx.fill();

  // ---- 地形体：岩石层理（2026-10-03）----
  // `drawTiled` 只会铺矩形，而地形是"每波随机生成的台阶" → 先 **clip 到地形轮廓** 再铺。
  // ⚠️ 铺完必须**叠一层暗色**：这张图的主体色量化后落在 `#4A3428`（实测占 67%），
  //    和地表层**是同一个色** —— 不压暗的话，"地表层参差的下沿"根本看不出来，
  //    那一整套"过渡"就白做了。（顺带也兑现了"越往下越暗"。）
  // ⚠️ 只铺**屏幕可见的那一块**：世界宽 4800，全铺一遍是白费。
  const bx = s.camera.x - 64;
  const bw = VIEW.w + 128;
  const by = WORLD.groundY - TERRAIN.maxRise - 40;
  const bh = (-s.camera.y + VIEW.h + 64) - by;
  if (bh > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, VIEW.h + 200);
    for (const [px, py] of segPts) ctx.lineTo(px, py);
    ctx.lineTo(WORLD.width, VIEW.h + 200);
    ctx.closePath();
    ctx.clip();
    if (drawTiled(ctx, 'terrain_body', bx, by, bw, bh, ANCHOR0)) {
      ctx.fillStyle = withA(PALETTE.envMid, 0.34);
      ctx.fillRect(bx, by, bw, bh);
    }
    ctx.restore();
  }

  // ---- 地表层（2026-10-03）----
  // ⚠️ 段是**斜的**（2026-10-03 起）→ 把每段**细分成 `SURF_STEP` 宽的小段**再逐段铺。
  //    每个小段当水平处理（误差 ≤ 坡度 × 步长 ≈ 0.5 × 4 = 2px，1:1 下看不出来），
  //    这样地表层自动贴着坡走、而 `drawTiled` 一个字都不用改。
  // ⚠️ 所有台地共用 `ANCHOR0`（世界原点）—— 各段自己起算的话，接缝处图案会跳一下。
  // ⚠️ 只铺**屏幕可见**的那几段：一条 4px 的小段意味着全图会有 1200 次铺图，全铺是白费。
  // ⚠️ 任一段没铺成（图没加载完 / Node 环境）→ **整条回退**到原来那条 5px 纯色描边。
  //    不能铺一半：那会变成"有的台地有表层、有的没有"，比整体回退更难查。
  const SURF_STEP = 4;
  const visL = s.camera.x - 64;
  const visR = s.camera.x + VIEW.w + 64;
  let surfaceOK = !!(prof && prof.length);
  if (surfaceOK) {
    for (let i = 0; i < prof.length && surfaceOK; i++) {
      const seg = prof[i];
      if (seg.x1 < visL || seg.x0 > visR) continue;
      const w = seg.x1 - seg.x0;
      if (w <= 0) continue;
      for (let x = seg.x0; x < seg.x1; x += SURF_STEP) {
        const dw = Math.min(SURF_STEP, seg.x1 - x);
        const rise = seg.riseL + (seg.riseR - seg.riseL) * ((x - seg.x0) / w);
        if (!drawTiled(ctx, 'terrain_surface', x, WORLD.groundY - rise, dw, TERRAIN_SURFACE_H, ANCHOR0)) {
          surfaceOK = false;
          break;
        }
      }
    }
  }
  if (!surfaceOK) {
    ctx.beginPath();
    let firstPt = true;
    for (const [px, py] of segPts) {
      if (firstPt) { ctx.moveTo(px, py); firstPt = false; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = PALETTE.envEdge;
    ctx.lineWidth = 5;
    ctx.stroke();
  }

  // 岩棚（遮挡物）：站到它下面就能躲陨石
  for (const sh of shelves()) drawShelf(ctx, sh);

  // 不画地面范围带，灾害期仍保留屋外受击警告。
  const alert = s.director.phase === Phase.DISASTER
    && Math.abs(s.player.x - SHELTER.cx) > SHELTER.shelterRange;
  const gy0 = terrainY(SHELTER.cx);
  ctx.textAlign = 'center';
  ctx.fillStyle = UI_SKIN.danger;
  ctx.font = `${alert ? 'bold ' : ''}12px ${FONT}`;
  if (alert) ctx.fillText('暴露在外 · 灾害同时攻击你和庇护所', SHELTER.cx, gy0 + 34);

  ctx.restore();
}

/**
 * 可见度（2026-09-26 用户要求："可见度减低，人物要开手电筒才能勉强看清前方"）。
 * 做法：画完世界之后盖一层"中心透明、四周几乎全黑"的径向渐变。
 * ⚠️ 必须在**屏幕坐标**下画（不带相机位移），否则光圈会跟着相机跑偏。
 * ⚠️ 关灯也不做全黑 —— 留一点点"勉强看清脚下"。全黑会让玩家彻底迷路，
 *    那不叫难度，叫劝退（和"看得见的危险叫挑战"是同一条原则）。
 */
function drawDarkness(ctx, s) {
  const p = s.player;
  // ⚠️ 2026-10-05：这一层画在**屏幕坐标**下（世界那一段已经 restore 了），所以要把
  //    `CAMERA.zoom` **乘回来** —— 中心和半径都要乘，否则光圈会小于/偏离人物
  //    （那是"手电筒照在身上一小块"的观感，而且不报错）。
  const z = CAMERA.zoom;
  const sx = (p.x - s.camera.x) * z;
  // ⚠️ 2026-09-29：加 `camera.y` —— 这一层画在**屏幕坐标**下（不带相机位移），
  //    所以纵向上要手动补回"画面被推下去的那一段"，否则光圈会和人物错开
  //    （人越高差得越多，而它**不报错**，只是"手电筒照在脚下面"）。
  //    ⚠️ 2026-10-05 连同 `CAMERA_ANCHOR_Y` 一起补：y 的变换是"以地面线为锚放大"，
  //       这里少减锚点，光圈就会和人物差 60 多像素（正是那条"照在脚下面"的病）。
  const sy = (p.y - 17 + s.camera.y - CAMERA_ANCHOR_Y) * z + CAMERA_ANCHOR_Y;   // 光圈中心放在身体中部
  // ⚠️ 地下更暗（UNDERWORLD.lightScale）：**压的是半径，不是透明度** ——
  //    半径变小才真的"看不见远处"；只调透明度只是整屏变灰，压迫感完全不一样。
  const underground = s.layer === 'under';
  // ⚠️ 2026-10-01：半径不再直接读 `s.flashlight` 那个布尔，而是读 **`s.lightK`**（0=关/1=开，
  //    由 main.js 的 step 平滑驱动）。原来三样东西（半径 / 中段浓度 / 中心暖光）都是
  //    跟着布尔一帧跳变 —— 点一下「灯」全屏亮度"啪"地换档，看着像闪了一下，而不是"灯亮了"。
  //    现在三者都按同一个 k 插值，开合是一个连续的过程。
  const k = s.lightK;
  const radius = LIGHT.offRadius + (LIGHT.onRadius - LIGHT.offRadius) * k;
  // ⚠️ 半径也乘 `zoom` —— 光圈的"世界半径"不变（`LIGHT` 那套数值是按世界 px 标定的，
  //    见 docs/01）：拉近镜头只是把它**画大**。不乘的话等于把可见度白削掉 1/zoom 倍 ✗。
  const r = radius * (underground ? UNDERWORLD.lightScale : 1) * CAMERA.zoom;
  const g = ctx.createRadialGradient(sx, sy, r * 0.22, sx, sy, r);
  // ⚠️ 2026-10-01 调子改造：黑幕原来是中性偏蓝的 `4,6,10`（和冷灰背景配套），
  //    换成"贫民铁锈"的**暖黑** `PALETTE.darkRgb`（h≈24°）。同时光锥**正中心**不再
  //    留纯透明，而是叠一点暖光 `PALETTE.glowRgb` —— 中心纯透明等于"没打灯"，
  //    叠暖光才有"手电筒打在土墙上的那圈黄"。关灯也留 0.03（几乎看不出，但整屏不至于死灰）。
  const midA = 0.72 + ((underground ? 0.55 : 0.42) - 0.72) * k;
  const edgeA = 0.97 + ((underground ? 0.97 : 0.93) - 0.97) * k;
  const glowA = 0.03 + (0.09 - 0.03) * k;
  g.addColorStop(0, `rgba(${PALETTE.glowRgb},${glowA})`);
  g.addColorStop(0.55, `rgba(${PALETTE.darkRgb},${midA})`);
  g.addColorStop(1, `rgba(${PALETTE.darkRgb},${edgeA})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
}

/** 洞顶贴图的**岩带**那一段的高（其余是垂下来的钟乳石）。`UNDERWORLD.ceilingY` 指的就是"岩带下沿"。 */
const CEILING_BAND_H = 80;
/** 洞顶的**整体不透明度** —— 因为它是"远处的一大块暗质量"，不该和玩家光圈一样亮。
 *  ⚠️ 用 `globalAlpha` 而不是"再叠一层黑"：半透明在这里等价于"朝背景（近黑）压暗"，
 *     而且**不会有 `source-atop` 那种全画布语义**（见 docs/04 里那条坑）。
 *  ⚠️ 1.0 = 素材原色（实测偏亮、整屏最显眼）；0.6 左右才是"远景"。改这个值要重看一次地下截图。 */
const CEILING_ALPHA = 0.6;
/** 洞顶贴图的总高 —— **设计值**，= 岩带 80 + 最长的钟乳石 42（见 spec §7.5）。改素材必须同步这里。 */
const CEILING_TEX_H = 122;

/**
 * 洞顶（**地下专属**）：一条横向可平铺的岩带 + 垂下来的钟乳石。
 * 为什么要有它：地下如果没有"顶"，看起来只是"另一片地面"，玩家不会觉得自己在洞里。
 * 它是纯视觉的（不参与碰撞）。
 *
 * ⚠️⚠️ **它画在 `drawDarkness` 之后**（2026-10-05 用户选方案 C）—— 也就是**不吃手电筒的黑暗**。
 *     为什么必须这样：地下光圈半径只有 `LIGHT.onRadius(250) × UNDERWORLD.lightScale(0.5)` = **125px**，
 *     而洞顶在玩家**头顶 300+px**，光圈边缘的 alpha 又是 0.97 → 画在黑暗层之前的话它**完全是黑的**
 *     （实测：那片区域色阶只有 4~6 种、恒定 `#140b05`，玩家看不到任何洞顶细节）。
 *     代价：它会在黑幕上以**固定亮度**显形，所以素材本身必须是**很暗的低对比岩带**
 *     （色号全取环境带 `PALETTE`，L ≤ 28% —— 那条由 `hue-audit` 守着）。
 *     ⚠️ 反过来：**别把它挪回黑暗层之前**，那样它又看不见了。
 */
function drawUnderCeiling(ctx, s) {
  const y = UNDERWORLD.ceilingY;               // 岩带**下沿**（= 钟乳石的根）
  // ⚠️ 只铺屏幕可见那一段（世界宽 4800，全铺是白费）—— 相位锚点固定在世界原点，
  //    所以裁掉两端**不会**让图案跳（和地形层同一个做法）。
  const x0 = Math.max(0, s.camera.x - 64);
  const x1 = Math.min(WORLD.width, s.camera.x + VIEW.w + 64);
  // ⚠️ `globalAlpha` 要在 `drawTiled` **之前**设：它内部只改 fillStyle，透明度会跟着 save/restore 进去。
  const prevA = ctx.globalAlpha;
  ctx.globalAlpha = prevA * CEILING_ALPHA;
  const tiled = drawTiled(ctx, 'under_ceiling', x0, y - CEILING_BAND_H, x1 - x0, CEILING_TEX_H, ANCHOR0);
  ctx.globalAlpha = prevA;
  if (tiled) return;

  // 回退（图没加载 / Node 环境）：原来的"一条岩带 + 一排三角钟乳石"，别留一片空白。
  // ⚠️ 高度用的是 `CEILING_BAND_H`，不再写死 80 —— 免得改了常量这两处漂开。
  ctx.fillStyle = PALETTE.envDeep;
  ctx.fillRect(0, y - CEILING_BAND_H, WORLD.width, CEILING_BAND_H);
  ctx.fillStyle = PALETTE.envMid;
  for (let x = 0; x < WORLD.width; x += 64) {
    const h = 16 + ((x * 37) % 26);            // 用 x 生成固定高度（不是每帧随机，否则会抖）
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 26, y);
    ctx.lineTo(x + 13, y + h);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * 地穴入口 / 上行口（分层世界）。
 * ⚠️ 文字必须**说清楚会通往哪一层** —— 玩家点了就会被传送，不能让他猜。
 */
function drawEntrances(ctx, s) {
  const under = s.layer === 'under';
  for (const e of entrances()) {
    const gy = terrainY(e.x);
    // 门框 + 黑洞（和隧道洞口同一种"石构"语言，但更大、更醒目：它是层之间的门）
    // ⚠️ 只换**本体**的色（门框石 / 洞口黑）→ 暖灰铁锈阶；
    //    下面那圈"指向哪一层"的描边（地下紫 / 地面金）**不动** —— 它和区域色带同义（见 OBJ_SKIN 注释）
    // 门框：贴图优先（80×92 = 门框本身的矩形），没加载完 / Node 环境走原来的圆角矩形
    if (!drawPropTex(ctx, 'entrance', e.x - 40, gy - 92, 80, 92)) {
      ctx.fillStyle = OBJ_SKIN.mid;
      roundRect(ctx, e.x - 40, gy - 92, 80, 92, 6);
      ctx.fill();
    }
    // 传送口 = 门框里那块**内嵌面板**（2026-10-02 用户圈出面板指定："这个地方为传送口"）。
    // 原来是门底部一个 60×36 的小拱门；面板几乎有整扇门那么大（38×64）。
    // ⚠️ 几何常量 `PORTAL` 定义在**模块顶部**（连同一道"它和贴图对得上吗"的加载自检）——
    //    别在这里再写一份：两份会各自漂移，而它本来就只有一个真相源。
    const px0 = e.x - 40 + PORTAL.x;
    const py0 = gy - 92 + PORTAL.y;
    const layerColor = under ? IDENTITY.zoneUnder : UI_SKIN.hi;
    ctx.beginPath();
    roundRect(ctx, px0, py0, PORTAL.w, PORTAL.h, 4);
    ctx.fillStyle = OBJ_SKIN.deep;
    ctx.fill();
    // 上沿透一点"层色"（金/紫）→ 读作"里面透出来的光"，而不是一块死黑。
    // ⚠️ 用「先铺不透明底色、再叠半透明渐变」而不是直接把渐变做成半透明 ——
    //    后者会让贴图的面板色透上来，和石头的色调混在一起发脏。
    const glow = ctx.createLinearGradient(0, py0, 0, py0 + PORTAL.h * 0.6);
    glow.addColorStop(0, withA(layerColor, 0.30));
    glow.addColorStop(1, withA(layerColor, 0));
    ctx.fillStyle = glow;
    ctx.fill();
    // ⚠️ 这圈描边**必须留着**：它的颜色是信息（金 = 下到地下 / 紫 = 回到地面），
    //    和区域色带同义 —— 不是装饰。
    ctx.strokeStyle = under ? withA(IDENTITY.zoneUnder, 0.75) : withA(UI_SKIN.hi, 0.7);
    ctx.lineWidth = 2;
    ctx.stroke();
    // 文字（两行都用"带底衬"的标签：地穴入口经常和废墟/隧道挨着，裸文字会糊成一片）
    labelPill(ctx, under ? '上行口 · 点它回地面' : '地穴入口 · 点它下去', e.x, gy - 100, under ? IDENTITY.zoneUnder : UI_SKIN.hi);
    if (!under) {
      labelPill(ctx, '（只能准备期下）', e.x, gy - 116, withA(UI_SKIN.hi, 0.75), `10px ${FONT}`);
    }
  }
  ctx.textAlign = 'left';
}

/** 岩棚：一根立柱 + 一块外伸的岩板，站在岩板下面就算被遮住 */
function drawShelf(ctx, sh) {
  const gy = terrainY(sh.x);
  const w = TERRAIN.shelfW;
  const h = TERRAIN.shelfH;
  const im = TEX.prop_shelf;
  if (im) {
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    const x = Math.round(sh.x - w / 2);
    const top = Math.round(gy - h);
    const roofH = 32;
    // 岩板高度不变，岩柱单独贴到右侧地形，坡边不会悬空。
    const foot = Math.round(terrainY(sh.x + w / 2 - 12));
    ctx.drawImage(im, 0, 0, w, roofH, x, top, w, roofH);
    ctx.drawImage(im, 0, roofH, w, h - roofH, x, top + roofH, w, Math.max(8, foot - top - roofH));
    ctx.imageSmoothingEnabled = prevSmooth;
    return;
  }
  // 岩棚：**能躲的物件**，本体色跟着地形走暖灰铁锈阶（原来是冷板岩 `#3a4356`/`#2e3646`，
  // 和暖棕地形并排时像贴上去的）。阴影那层保持纯黑 —— 它要表达的是"遮住光"，不是"石头"。
  ctx.fillStyle = OBJ_SKIN.body;
  ctx.fillRect(sh.x - w / 2, gy - h, w, 14);              // 岩板
  ctx.fillStyle = OBJ_SKIN.mid;
  ctx.fillRect(sh.x + w / 2 - 16, gy - h + 10, 16, h - 10); // 支柱
  ctx.fillStyle = 'rgba(0,0,0,0.22)';                      // 岩板下的阴影：一眼看出"能躲"
  ctx.fillRect(sh.x - w / 2, gy - h + 14, w, 10);
}

// ============================================================
// 怪物精灵（2026-10-04）
// ============================================================
// 用户给的**单行 16 帧巡逻动画**（15360×960 的透明底帧条）—— 帧间距不匀，所以用 `pixelize --sheet auto` 切。
//
// ⚠️⚠️ **这条素材主动放松了 `art.js` 里"威胁侧 = 严格左右轴对称 + 只用直线锐角"那条硬规则**
//    （2026-10-04 用户决定）。它是**侧/四分之三视角的有机造型**（不对称、有曲线），
//    换来的是**朝向** —— 由 `m.dir` 驱动镜像，玩家能一眼看出它往哪边走。
//    `art.js` 顶部那段审计叙述**已同步改过**，别再把它当"违规"去修。
// ⚠️⚠️ **素材尺寸不是随便定的**（2026-10-05 用户"怪物体型再大一些"，30 → 40）：
//    怪的接触判定用的是 config 的 `MONSTERS.contactRadius = 34`（**世界半径**，和素材尺寸是两套数），
//    两者要对得上 —— 目标是"**视觉贴上 ≈ 开始掉血**"：
//      视觉贴上 ⇔ |Δx| < 怪半宽 + 主角半宽（主角 24 宽 → 半宽 12）
//    ⇒ **怪半宽 ≤ 34 − 12 = 22**，即 **素材宽 ≤ 44**。
//    现在 **40**（半宽 20）：视觉贴上 32、掉血 34 → 差 2px（肉眼看不出来）✓。
//    旧的 30 差 7px；再大过 44 就会变成"明显叠在一起了还不掉血" ✗。
// ⚠️ 改尺寸**不需要重跑 `simulate.js`** —— 它完全不碰怪物（实测 grep 无引用）；
//    但**围攻怪的横向间距**（config 的 `SIEGE.rank`）是照素材宽度写死的，**必须一起改**。
// ⚠️ 素材本身按**朝右**画的（和主角同一条约定）：`dir < 0` 时水平镜像。
// ⚠️ 加载要环境守卫；图没加载 → 回退成原来那个等腰三角（见 `drawMonsterBody`，它按同一个高缩放）。
const MONSTER_TEX = { src: 'assets/monster_walk.png', w: 48, h: 48, frames: 16 };

// 怪物**攻击**动画（2026-10-05）：12 帧"抬手 → 挥出 → 收回"。
// ⚠️ 触发与时长都在 `monsters.js` 的 `_attack()` / config 的 `MONSTERS.attackRange|attackSeconds`，
//    渲染层只负责"挑哪张表、取第几帧" —— 别把判定写到这里来。
// ⚠️ 帧号**不能用共享的 `s.animT`**（走路那套是这么做的）：每只怪起手时刻不同，
//    必须按**它自己的 `atkT`**（已播秒数）折算，否则一屏的怪会整齐划一地出拳。
// ⚠️⚠️ **两张表的 w/h 必须一样**：`drawMonsterAt()` 用的是 `MONSTER_TEX.h` 来定"脚站在哪" ——
//    攻击表比走路表高一点，出拳时整只怪就会跳一下。
const MONSTER_ATTACK_TEX = { src: 'assets/monster_attack.png', w: 48, h: 48, frames: 12 };

if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
  for (const T of [MONSTER_TEX, MONSTER_ATTACK_TEX]) {
    const im = new Image();
    im.onload = () => { T.img = im; };
    im.src = T.src;
  }
}

/** 画一只怪物的**形体** —— 普通怪 / 兽潮围攻怪 / 地下那套**共用这一个入口**。
 *
 *  ⚠️ 两条实现必须**同框同锚**（都是 30×30、底边贴 `y + 30`）：换素材时外形会变，
 *    "画在哪"不能变 —— 变了就会和接触判定/预警圈错位。
 *  ⚠️ 回退分支（三角 + 两只方眼）**必须留着**：它是 Node / 图挂掉时的可跑性，
 *    也是"威胁侧原来长什么样"的唯一存证。
 *  @param {number} [atkT] 攻击动画已播秒数（>0 = 出拳中，见 `monsters.js` 的 `_attack`）；
 *                         缺省/0 = 走路。图没加载时自动落回走路表。
 */
function drawMonsterBody(ctx, s, x, y, dir, atkT = 0) {
  const MT = (atkT > 0 && MONSTER_ATTACK_TEX.img) ? MONSTER_ATTACK_TEX : MONSTER_TEX;
  if (MT.img) {
    // ⚠️ 帧号：走路那套用**世界时钟**（`s.animT`，main.js 按游戏速度累加）—— 和主角一样，
    //    不在渲染层读时钟；攻击那套改用**这只怪自己的 `atkT`**（见 `MONSTER_ATTACK_TEX` 的注释）。
    const frame = MT === MONSTER_ATTACK_TEX
      ? Math.min(MT.frames - 1, Math.floor((atkT / MONSTERS.attackSeconds) * MT.frames))
      : Math.floor((s.animT || 0) * ART.monsterFps) % MT.frames;
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    // 两张动画底部的 2px 红色底座不显示；保留帧宽及脚底地形锚点。
    const bodyH = MT.h - 2;
    const bodyY = y + 2;
    if (dir < 0) {
      // 就地镜像：锚点是怪自己那条竖线（同主角，见 drawPlayer 那段注释）
      ctx.save();
      ctx.translate(x, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(MT.img, frame * MT.w, 0, MT.w, bodyH, -MT.w / 2, bodyY, MT.w, bodyH);
      ctx.restore();
    } else {
      ctx.drawImage(MT.img, frame * MT.w, 0, MT.w, bodyH, x - MT.w / 2, bodyY, MT.w, bodyH);
    }
    ctx.imageSmoothingEnabled = prevSmooth;
    return;
  }
  // ---- 回退：原来的等腰三角 + 两只方块眼 ----
  // ⚠️ 尺寸跟着 `MONSTER_TEX.h` 走（别写死 30）：素材从 30 改到 40 之后，
  //    写死的回退分支会比真素材小一圈（Node 里跑、或图挂掉时才看得到，但一样要一致）。
  const h = MONSTER_TEX.h;
  ctx.fillStyle = IDENTITY.monster;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + h * 0.5, y + h);
  ctx.lineTo(x - h * 0.5, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = IDENTITY.monsterEye;
  ctx.fillRect(x - h * 0.2, y + h * 0.4, h * 0.13, h * 0.13);
  ctx.fillRect(x + h * 0.067, y + h * 0.4, h * 0.13, h * 0.13);
}

/**
 * 画一只怪。y 跟着**本层地形**算。`dir` 只影响贴图朝向；`atkT` 见 `drawMonsterBody`（缺省 = 走路）。
 *
 * ⚠️ 2026-10-05 用户："不要那个红圈了" —— 原来"进 `warnRadius` 就画一圈红环"（`IDENTITY.monsterRing`）
 *    已**整个去掉**：那条环半径 26~36（按身高缩放）比怪还大，贴上来时糊成一团。
 *    ⚠️ 去掉的只是**画面上的圈**：HUD 那行「⚠ 附近有怪物（N px）」还在（走 `monsters.nearestDistance`），
 *       预警信息本身没丢 —— 别把 `warnRadius` 一起删了。
 */
function drawMonsterAt(ctx, s, x, dir, atkT = 0) {
  // ⚠️ y 必须**跟着本层地形算**（`terrainY` 读的就是当前层）——
  //    原来写死 `WORLD.groundY - 30`，分层之后地下那一套会画在半空/土里（2026-09-27 修）。
  // ⚠️⚠️ 高必须用 `MONSTER_TEX.h`（**不能写死**）：下面是"脚底 = y"的约定，
  //    体型一改，写死的偏移就让整只怪**悬在半空 / 陷进地里**（而且不报错，只是"看着飘"）。
  const y = terrainY(x) - MONSTER_TEX.h;
  drawMonsterBody(ctx, s, x, y, dir, atkT);
}

function drawMonsters(ctx, s) {
  // 巡逻怪：各有区间、参与引怪、永远不靠近庇护所
  // ⚠️ 2026-10-05：这里原来还传 `warnRadius` 去画那圈红环，用户说"不要那个红圈了" → 已去掉
  //    （见 `drawMonsterAt` 的注释：HUD 的"附近有怪物（N px）"仍在）。
  for (const m of s.monsters.list) drawMonsterAt(ctx, s, m.x, m.dir, m.atkT);

  // 兽潮围攻怪（2026-10-04）—— ⚠️ **只在地面层画**：它们属于地面那张图（庇护所只在地面）。
  //    不判这一下的话，玩家在准备期钻进地下会看到"门外那群怪"跟着出现在洞里（"层"这个维度
  //    在本项目已经被漏过三次，见 docs/04 那条）。数量少、直接画，不必再走一遍 setLayer。
  if (s.layer !== 'ground') return;
  for (const g of s.siege.list) {
    // 围攻怪的目标就是门 → 朝目标的方向就是它的朝向（站在门前不动时朝右 = 朝着门）
    const dir = Math.sign(g.targetX - g.x) || 1;
    drawMonsterAt(ctx, s, g.x, dir, g.atkT);
  }
}

function drawShelter(ctx, s) {
  const rects = shelterRects();

  // ---------- 室内：后墙（2026-10-04）----------
  // 背景：在这之前**室内的那块矩形什么都没画** → 直接透出天空色（`PALETTE.envDeep`），
  //   于是庇护所读起来像个"框"而不是房子（用户要"室内地板/后墙"）。
  // ⚠️ 必须画在**五个面之前**：每个面都会往外画 2px 的墙体外框（`roundRect(r.x-2, …)`），
  //    后墙若画在后面就会盖住那圈框线。
  // ⚠️ 面积用**面矩形推**（`roof` 的下沿 = 室内顶、`base` 的上沿 = 地面线、
  //    左/右墙的 `w` = 壁厚），不写死 —— `SHELTER.rise` / `wallThickness` 一改这里跟着走。
  {
    const roof = rects.roof, base = rects.base, left = rects.left, right = rects.right;
    const iw = left.w;                                   // = 壁厚
    const ix = roof.x + iw;
    const iy = roof.y + roof.h;                          // 顶盖下沿
    const iwIn = right.x - ix;                           // 内宽
    const ihIn = base.y - iy;                            // 内高（= rise）
    if (iwIn > 0 && ihIn > 0) drawTiled(ctx, 'interior_wall', ix, iy, iwIn, ihIn, ANCHOR0);
  }

  for (const f of s.shelter.faces) {
    const r = rects[f.id];
    if (!r) continue;
    // 墙的血量来自结构件的耐久；没贴料 → 0 血，格子全暗
    const hp = s.shelter.hpOf(f.id);
    const maxHp = s.shelter.maxHpOf(f.id);
    const ratio = maxHp > 0 ? hp / maxHp : 0;
    const broken = maxHp <= 0 || hp <= 0;
    const whole = s.shelter.structRatio(f.id);

    ctx.fillStyle = SHELL_SKIN.deep;   // 墙体外框 —— 跟着墙板走深青（原来是暖黑 OBJ_SKIN.deep）
    roundRect(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 4, 4);
    ctx.fill();

    // 整面墙 = **一整块墙板**（横向面用 `deck` / 竖向面用 `hull`）。
    // ⚠️ 位置不能挪：它在"墙体外框"之上、在"材料格位"之下 —— 材料格位是**可点的**，
    //    补漏位一多（n≥6）材料块会溢出面外，被墙板盖住就等于点不到（见 docs/04 那条"绘制顺序也是契约"）。
    // ⚠️ 门（`door`）用**自己的图**，不再和左墙共用 `hull` —— 它是"入口"，要一眼认出来。
    //    图没加载时**回退到 `hull`**：否则门那一段会变成一块空白（只剩墙体外框色）。
    // ⚠️ 地板（`base`）同理换成 `interior_floor`（2026-10-04）：`G..G+26` 那条**就是机制上的"地板"**
    //    （地陷打的是它、补漏位也贴在上面），所以"室内地板"= 换它的贴图，而**不是**另画一条带子 ——
    //    画在地面线**上方**会变成"人站在一条带子前面"，画在**下方**会盖住居中的补漏位。
    //    它的上沿 = 地面线，玩家的脚正好踩在它上面（和地表层同一条约定）。
    const horiz = f.id === 'roof' || f.id === 'base';
    let tileKey = horiz ? 'shelter_deck' : 'shelter_hull';
    if (f.id === 'door' && TEX.shelter_door) tileKey = 'shelter_door';
    if (f.id === 'base' && TEX.interior_floor) tileKey = 'interior_floor';
    // 相位锚点只给 `left`：门换成独立图案之后，"左墙上下两段图案连续"这条**不再成立**（也不该成立）。
    const anchor = f.id === 'left' ? { x: r.x, y: r.y } : null;
    drawFaceCells(ctx, r, whole, tileKey, anchor);

    // 门框：上下各一条铜绿亮线。素材自带门板，这两条是**边界** —— 把门从一整条墙里"切"出来。
    if (f.id === 'door') {
      ctx.strokeStyle = withA(SHELL_SKIN.glow, 0.9);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(r.x, r.y + 1);
      ctx.lineTo(r.x + r.w, r.y + 1);
      ctx.moveTo(r.x, r.y + r.h - 1);
      ctx.lineTo(r.x + r.w, r.y + r.h - 1);
      ctx.stroke();
    }

    // 舱顶 / 着陆架：只画在**建筑之外**。判定只看 x，所以上下这两条是免费的（见 `SHELL` 的注释）。
    if (f.id === 'roof') drawTiled(ctx, 'shelter_deck', r.x, r.y - SHELL.up, r.w, SHELL.up);
    else if (f.id === 'base') drawTiled(ctx, 'shelter_gear', r.x, r.y + r.h, r.w, SHELL.down);

    drawFacePositions(ctx, f, f.id, s);

    // 耐久条：**一整条**（整面墙是一体的，所有结构件同步掉血、一起失效）
    bar(ctx, r.x + 2, r.y - 12, r.w - 4, 6, whole, hpColor(whole, whole <= 0));
    if (broken) {
      ctx.fillStyle = UI_SKIN.warn;
      ctx.font = `bold 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(maxHp <= 0 ? '未补漏' : '打穿', r.x + r.w / 2, r.y - 16);
    } else if (s.repairingFaceId === f.id) {
      ctx.fillStyle = UI_SKIN.ok;
      ctx.font = `bold 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('修复中…', r.x + r.w / 2, r.y - 16);
    }
  }

  // 有效高度指示
  const hx = SHELTER.cx + SHELTER.halfWidth + 24;
  const topY = WORLD.groundY - s.shelter.height;
  ctx.strokeStyle = withA(UI_SKIN.info, 0.55);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(hx, WORLD.groundY);
  ctx.lineTo(hx, topY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = UI_SKIN.info;
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(`高 ${Math.round(s.shelter.height)}`, hx + 8, topY + 14);
}

/**
 * 工作台 —— 合成系统的**唯一入口**（2026-09-27）。
 * ⚠️ 它必须一眼看得见、且状态要画出来：看不到台子 / 不知道它在忙什么，
 *    这套机制在手机上就等于不存在（和"垃圾桶必须常驻"是同一个教训）。
 * ⚠️ 2026-09-27 续：台子**可能不止一个**（撑过第 5 波会多一个，两个能同时合成），
 *    所以逐个画；两个以上时每个台子上标个序号 —— 否则报进度时说"台子 2"玩家找不到是哪张。
 * ⚠️ 它们现在站在**庇护所室内、直接坐在地上**（用户要求搬进来），所以腿高算出来是 0。
 */
function drawWorkbench(ctx, s) {
  const list = s.workbenches;
  for (let i = 0; i < list.length; i++) drawOneWorkbench(ctx, s, list[i], i, list.length);
}

function drawOneWorkbench(ctx, s, wb, i, n) {
  const r = workbenchRect(i);
  const near = Math.abs(s.player.x - SHELTER.cx) < PLAYER.buildRadius;
  const legH = Math.max(0, WORLD.groundY - (r.y + r.h));

  ctx.fillStyle = OBJ_SKIN.mid;
  ctx.fillRect(r.x + 12, r.y + r.h, 14, legH);
  ctx.fillRect(r.x + r.w - 26, r.y + r.h, 14, legH);

  // 台体：贴图优先（96×64 = 台体本身的矩形），没加载完 / Node 环境走原来的圆角矩形 + 装饰
  if (!drawPropTex(ctx, 'workbench', r.x, r.y, r.w, r.h)) {
    ctx.fillStyle = OBJ_SKIN.body;
    roundRect(ctx, r.x, r.y, r.w, r.h, 6);
    ctx.fill();
    // 台面上的工具（纯装饰：让"这是工作台"不靠文字也能认出来）
    ctx.fillStyle = OBJ_SKIN.woodBar;
    ctx.fillRect(r.x + 10, r.y + r.h - 20, r.w - 20, 7);
    ctx.fillStyle = OBJ_SKIN.woodTool;
    ctx.fillRect(r.x + 14, r.y + 12, 24, 9);
  }
  // ⚠️ 这圈描边**留在贴图外面**：它是有信息的（`busy` = 在合成 / `near` = 在建造范围内），
  //    不是装饰 —— 把它一起换成贴图，就等于把"这台子在忙"变成看不见。
  ctx.strokeStyle = wb.busy ? UI_SKIN.info : (near ? UI_SKIN.hi : withA(UI_SKIN.rivetHi, 0.55));
  ctx.lineWidth = (wb.busy || near) ? 2.5 : 1.5;
  roundRect(ctx, r.x, r.y, r.w, r.h, 6);
  ctx.stroke();

  // 序号（只有 2 个以上才画）：报进度/报结果时会说"台子 2"，得让它找得到
  if (n > 1) {
    ctx.fillStyle = `rgba(${UI_SKIN.panelRgb},0.75)`;
    ctx.beginPath();
    ctx.arc(r.x + r.w - 13, r.y + 13, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = withA(UI_SKIN.hi, 0.6);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = UI_SKIN.hi;
    ctx.font = `bold 11px ${FONT}`;
    ctx.fillText(`${i + 1}`, r.x + r.w - 13, r.y + 17);
  }

  // 取货动画进行中？→ 台面上的东西正在"被拿走"，下面几处都要据此错开
  const taking = s.synthTake && s.synthTake.bench === i;

  ctx.textAlign = 'center';
  ctx.font = `bold 12px ${FONT}`;
  if (wb.hasProduct) {
    // ⚠️ 2026-09-29（用户要求：合成好的先留在台子上等玩家来取）——
    //    台上有东西时这一行**必须换掉**：再写"点我合成"就是假的（点下去是取货、不是开面板），
    //    玩家会以为台子空着，然后对着台子反复点"合成"却什么也没发生。
    //    不在建造范围里时只说"台上有东西"：这时点了也没用（tapWorkbench 会先报"太远了"）。
    // ⚠️ **不看 `taking`**：取货动画那 0.9 秒里产物**还在台子上**（`takeFromBench` 要等动画
    //    播完才入袋），所以这行字必须照旧 —— 掉进下面的 else 分支会写出"点我合成"，那是错的。
    const p = wb.product;
    ctx.fillStyle = p.success ? UI_SKIN.ok : UI_SKIN.warn;
    ctx.fillText(near ? (taking ? '正在收…' : '收取') : '台上有东西', r.x + r.w / 2, r.y - 22);
  } else if (wb.state === SYNTH_STATE.PAUSED) {
    ctx.fillStyle = UI_SKIN.warn;
    ctx.fillText('合成暂停', r.x + r.w / 2, r.y - 22);
  } else if (wb.state === SYNTH_STATE.RUNNING) {
    ctx.fillStyle = UI_SKIN.info;
    ctx.fillText(`合成中 ${Math.ceil(wb.left)}s`, r.x + r.w / 2, r.y - 22);
  } else {
    ctx.fillStyle = near ? UI_SKIN.hi : UI_SKIN.textMid;
    ctx.fillText(near ? '合成' : '工作台', r.x + r.w / 2, r.y - 22);
  }

  // 进度条：只在开工时画（空闲时也画一条满格的会让人以为"有个进度卡住了"）
  if (wb.busy) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, r.x, r.y - 16, r.w, 7, 3);
    ctx.fill();
    ctx.fillStyle = wb.state === SYNTH_STATE.PAUSED ? UI_SKIN.warn : UI_SKIN.info;
    roundRect(ctx, r.x, r.y - 16, r.w * wb.progress, 7, 3);
    ctx.fill();
  }

  // ---------- 台面上的待取产物（2026-09-29 用户要求：合成好的先暂存在工作台里）----------
  // ⚠️ 画在**台面上**（不是浮在半空）：语义就是"东西做出来了、搁在台子上"，一眼能懂。
  //    "点我收走"那行字在上面 r.y-22，这两者一起构成"这儿有个东西可以拿"。
  // ⚠️ 和"材料全毁"红字不会同时出现：台子被打穿时 collapse() 连产物一起清了。
  if (wb.hasProduct && !taking) {
    const p = wb.product;
    const cx = r.x + r.w / 2;
    const swW = 34;
    const swH = 24;
    const swX = cx - swW / 2;
    const swY = r.y + r.h - 40;          // 搁在台面上（台面工具条在 r.y+r.h-20）
    ctx.save();
    ctx.shadowColor = p.success ? withA(UI_SKIN.ok, 0.95) : withA(UI_SKIN.warn, 0.95);
    ctx.shadowBlur = 12;
    // 净区 = 台面上那块 34×24（短边 24 < 28）→ 层 A
    drawMaterialGlyph(ctx, swX, swY, swW, swH, p.mat, { radius: 4 });
    ctx.restore();
    ctx.strokeStyle = p.success ? UI_SKIN.ok : UI_SKIN.warn;
    ctx.lineWidth = 2;
    roundRect(ctx, swX, swY, swW, swH, 4);
    ctx.stroke();
    // 次品角标：它不是玩家点的那一档，必须一眼看出来 —— 否则贴上去才发现属性不对，
    // 而那时已经拿不回来了（破损件取下即废）
    if (!p.success) {
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(swX + swW - 13, swY + 2, 12, 11);
      ctx.fillStyle = UI_SKIN.warn;
      ctx.font = `bold 9px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('次', swX + swW - 7, swY + 11);
    }
  }

  // "材料全毁"红字（刚被打破面砸掉时）。⚠️ 不能只靠横幅 —— 同一帧里"整面墙彻底坏了"
  // 会把横幅顶掉，玩家就会以为材料凭空消失了（见 main.js 事件循环里的注释）。
  // ⚠️ 两个台子会同时被砸（判定挂在"房子"上），所以每个台子上都写 —— 它们都真的毁了。
  if (s.synthLossT > 0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = UI_SKIN.danger;
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillText('⚠ 材料全毁', r.x + r.w / 2, r.y - 46);
  }

  // ---------- 取货特写（2026-09-29）----------
  // 用户要的"点工作台后对材料有一个特写镜头" —— 但**游戏不暂停、没有摄像机**（2D canvas），
  // 所以这里做成一张**不遮屏的小卡片**：在台子上方弹出，材料块放大一档（特写）→ 上浮 → 淡出。
  // ⚠️ 必须要有它：否则"点一下台子、东西就没了"——背包里多一件对玩家是**完全隐形**的，
  //    他会以为台子把材料吞了（这是本项目反复踩过的"看不见的规则等于不存在"）。
  // ⚠️ 去向（背包/仓库）在这里按当前背包状态预览；真放进哪在动画结束、`takeFromBench()` 里定
  //    （判定条件同一个 `player.isFull`，所以除非这 0.9 秒里玩家又捡了东西，否则一致）。
  if (taking && wb.product) {
    const p = wb.product;
    const m = MATERIALS[p.mat];
    const cx = r.x + r.w / 2;
    const prog = Math.min(1, s.synthTake.t / s.synthTake.dur);
    const popIn = Math.min(1, prog / 0.4);        // 前 40%：放大弹入（特写）
    const rise = Math.max(0, (prog - 0.4) / 0.6); // 后 60%：上浮
    const alpha = 1 - rise * rise;                // 后 60%：淡出
    const scale = 0.8 + 0.35 * popIn - 0.2 * rise;
    const cardW = 190;
    const cardH = 58;
    const cardX = cx - cardW / 2;
    const cardY = r.y - 34 - cardH - rise * 44;

    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(cx, cardY + cardH / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -(cardY + cardH / 2));

    panelPlate(ctx, cardX, cardY, cardW, cardH, {
      cut: 9,
      alpha: UI_SKIN.panelAStrong,
      edge: p.success ? withA(UI_SKIN.ok, 0.9) : withA(UI_SKIN.warn, 0.9),
      lineWidth: 2,
    });

    // 左：**放大**的材料块（"特写"就体现在这里 —— 比台面上那块和格位里的都大一档）
    const swW = 52;
    const swH = 36;
    const swX = cardX + 12;
    const swY = cardY + (cardH - swH) / 2;
    ctx.save();
    ctx.shadowColor = p.success ? withA(UI_SKIN.ok, 0.95) : withA(UI_SKIN.warn, 0.95);
    ctx.shadowBlur = 14;
    // 净区 = 卡片里那块 52×36（短边 36 ≥ 28）→ 层 B
    drawMaterialGlyph(ctx, swX, swY, swW, swH, p.mat, { radius: 5 });
    ctx.restore();
    ctx.strokeStyle = withA(UI_SKIN.rivetHi, 0.5);
    ctx.lineWidth = 1;
    roundRect(ctx, swX, swY, swW, swH, 5);
    ctx.stroke();

    // 右：品名 + 去向
    const tx = swX + swW + 12;
    ctx.textAlign = 'left';
    ctx.fillStyle = UI_SKIN.textStrong;
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillText(m.name, tx, cardY + 25);
    ctx.fillStyle = UI_SKIN.ok;
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillText(s.player.isFull ? '→ 放进仓库' : '→ 放进背包', tx, cardY + 43);

    ctx.restore();
  }

  ctx.textAlign = 'left';
}

/**
 * 悬空岩桥（2026-09-27 新增）—— "上层路线"的实体。
 *
 * ⚠️ 2026-09-27 第二轮（用户反馈"支撑脚有挡路的 bug"）：**去掉了两条斜撑**，原因有两个：
 *   ① 它固定画到 `WORLD.groundY`，加了台地之后**会穿进地面**（画到土里去）；
 *   ② 它纯视觉、不阻挡移动，但画出来像柱子 —— 玩家会以为要绕开它。
 *      在"看得见的危险才叫挑战、看不见的叫坑人"这条原则下，
 *      "看起来挡路其实不挡"是纯粹的误导。
 * 改成**悬浮岩板**（外星遗迹的浮空石板）：只用一道很淡的下沉光晕说明它悬在空中。
 */
function drawPlatforms(ctx, s) {
  // ⚠️ 色换了，但**三者的区分关系必须原样保留**（它们是三种不同的落脚点，玩家要一眼分得清）：
  //    主干岩桥 = 有悬空光晕 + 最亮的顶面；支桥 = 无光晕 + 更暗；天然石台 = 无光晕 + 另一个色。
  //    原来的冷蓝 → 暖灰；亮度顺序（支桥 < 主干 < 石台顶面高光）一个都没动。
  //
  // ⚠️ 2026-10-04 板身改成**贴图**（三张横向可平铺条带，见 `TEX_SRC`）：宽度 200~320 随机，
  //    所以只有平铺一条路。**三者的区分靠"三张不同的图"**（色阶真的分开了 —— 实测量化后
  //    主色占比：支桥 `#4a3f33`(L=24.5%) / 主干 `#5c5044`(L=31.4%) / 石台 `#6a5c4a`(L=35.3%)），
  //    顺序仍是"支桥 < 主干 < 石台"，与上一行那条约定一致。
  // ⚠️ **顶面高光与悬空光晕留在代码里、不烤进图**：它们是信息（"这一条能站" / "这块浮在空中"），
  //    图里画死就改不动了（同 `prop_entrance` 的洞、`drawHidden` 的裂纹）。
  // ⚠️ 相位锚点传 `ANCHOR0`（世界原点）：主干是"首尾相接的阶梯长廊"，各段自己起算的话，
  //    接缝处图案会跳一下（同地形每段共用锚点的理由）。
  for (const p of PLATFORMS.list) {
    // ⚠️ 支桥（网络化的分叉）画得**略暗、无悬空光晕** —— 一眼能分出"主干长廊"和"分叉小路"，
    //    否则上层看起来还是一坨，玩家不知道哪条是主干。
    const branch = !!p.branch;
    if (!branch) {
      // 悬浮光晕（向下渐隐：说明这块板是浮着的、下面没有柱子）
      const g = ctx.createLinearGradient(0, p.y + PLATFORMS.thickness, 0, p.y + PLATFORMS.thickness + 46);
      g.addColorStop(0, withA(UI_SKIN.textMid, 0.16));
      g.addColorStop(1, withA(UI_SKIN.textMid, 0));
      ctx.fillStyle = g;
      ctx.fillRect(p.x + 4, p.y + PLATFORMS.thickness, p.w - 8, 46);
    }

    // 板身：优先铺贴图；拿不到（图没加载 / Node 无头自检）回退成原来的圆角矩形色块。
    // ⚠️ 目标高**必须 = `PLATFORMS.thickness`**（= 素材高度 18）—— 见"框的宽高比要随素材重算"那条。
    if (!drawTiled(ctx, branch ? 'platform_branch' : 'platform_main', p.x, p.y, p.w, PLATFORMS.thickness, ANCHOR0)) {
      ctx.fillStyle = branch ? OBJ_SKIN.mid : OBJ_SKIN.body;
      roundRect(ctx, p.x, p.y, p.w, PLATFORMS.thickness, 4);
      ctx.fill();
      ctx.strokeStyle = branch ? withA(UI_SKIN.rivetHi, 0.35) : withA(UI_SKIN.rivetHi, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // 顶面高光（"这一条能站"）
    ctx.fillStyle = branch ? withA(UI_SKIN.textMid, 0.45) : withA(UI_SKIN.textStrong, 0.65);
    ctx.fillRect(p.x + 3, p.y + 0.5, p.w - 6, 2.5);
  }

  // 天然石台（"第三层"）—— ⚠️ 画得和岩桥**明显不同**（粗糙岩石、无悬空光晕），
  // 否则玩家分不清"这条是走得通的长廊"还是"这块只是一个孤立落脚点"。
  for (const l of LEDGES.list) {
    // ⚠️ 14 是**素材推出来的**（`platform_ledge` 就是 14 高），换素材要跟着重算。
    if (!drawTiled(ctx, 'platform_ledge', l.x, l.y, l.w, LEDGE_H, ANCHOR0)) {
      ctx.fillStyle = OBJ_SKIN.top;
      roundRect(ctx, l.x, l.y, l.w, LEDGE_H, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(150,133,112,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.fillStyle = withA(UI_SKIN.textMid, 0.5);
    ctx.fillRect(l.x + 2, l.y + 0.5, l.w - 4, 2);
  }
}

/** 隧道洞口贴图（`prop_tunnel.png`）的尺寸 —— 两个都是**设计值**，不是从剪影比反算的：
 *  · 宽 **52** = ±26 —— 世界生成器给"隧道口"留的**半宽就是 26**（见 config 里那条"废墟↔通道类物件
 *    最小间距"的注释：`隧道口 ±26`）。所以贴图**不能比 52 宽**，否则会超出生成器的避让假设、
 *    和废墟叠在一起（它会静默发生，只是"看着挤"）。
 *  · 高 **30** = 原来那个半圆（`arc(r=26)` + 落到 `terrainY` 那 4px）的包围盒。
 *  ⚠️ 贴图内容只占盒子的**下半部**（源图剪影比 2.54，而 52:30 = 1.73）——
 *     `pixelize` 是等比 contain + 脚贴底，所以底边严格落在地面线上、洞口会**比半圆扁一点**（有意的）。
 *  绘制尺寸与点击留边共同定义在 TUNNELS。 */
const TUNNEL_W = TUNNELS.w;
const TUNNEL_H = TUNNELS.h;

/**
 * 隧道洞口（2026-09-27 新增）—— 连接**近区 ↔ 极深区**的捷径（见 config 的 TUNNELS）。
 *
 * ⚠️ 2026-09-27 改（用户："我希望隐蔽一点"）：**远看只是一个暗色凹坑**，几乎融进地形；
 *    走到 `TUNNELS.revealDist` 之内才浮现（铺一层青色光晕 + 标出通向哪边）。
 *    → "找到隧道"本身变成一次探索。但**不做成隐形** —— 走近必须显现，
 *      否则就走到"看不见的机会等于不存在"的反面了（本项目反复写过这条）。
 */
function drawTunnels(ctx, s) {
  const px = s.player.x;
  for (const t of TUNNELS.list) {
    for (const end of ['a', 'b']) {
      const p = t[end];
      const gy = terrainY(p.x);
      const near = Math.abs(px - p.x) <= TUNNELS.revealDist;

      // 走近的"浮现"：先铺一层**柔光晕**（不是硬描边）。
      // ⚠️ 原来是在那个半圆上 `stroke()` 一圈 —— 换成贴图之后那条线会和贴图自己的轮廓对不上
      //    （贴图内容只占盒子的下半部，硬线会"浮在洞口上方"）。光晕没有形状约束，天然对得上。
      if (near) {
        ctx.beginPath();
        ctx.arc(p.x, gy - 2, 32, Math.PI, 0);
        ctx.lineTo(p.x + 32, gy);
        ctx.lineTo(p.x - 32, gy);
        ctx.closePath();
        ctx.fillStyle = withA(UI_SKIN.info, 0.16);
        ctx.fill();
      }

      // 岩壁上的凹坑：平时再压一档透明度，远看更"融进地形"（"找到隧道"是一次探索）
      const prevA = ctx.globalAlpha;
      ctx.globalAlpha = prevA * (near ? 1 : 0.8);
      const drew = drawPropTex(ctx, 'tunnel', p.x - TUNNEL_W / 2, gy - TUNNEL_H, TUNNEL_W, TUNNEL_H);
      ctx.globalAlpha = prevA;

      // 图没加载（Node / 还没下载完）→ 走原来的半圆，形状和配色都保留
      if (!drew) {
        ctx.beginPath();
        ctx.arc(p.x, gy - 4, 26, Math.PI, 0);
        ctx.lineTo(p.x + 26, gy);
        ctx.lineTo(p.x - 26, gy);
        ctx.closePath();
        ctx.fillStyle = near ? OBJ_SKIN.deep : OBJ_SKIN.dark;
        ctx.fill();
        ctx.strokeStyle = near ? withA(UI_SKIN.info, 0.7) : 'rgba(150,133,112,0.3)';
        ctx.lineWidth = near ? 2 : 1.5;
        ctx.stroke();
      }

      if (near) {
        labelPill(ctx, end === 'a' ? '隧道 · 通向极深区' : '隧道 · 通向近区', p.x, gy - 38, UI_SKIN.info);
      }
    }
  }
  ctx.textAlign = 'left';
}

/**
 * 遗迹升降台（2026-09-27）—— 地面上去往**上层岩桥**的唯一入口。
 * ⚠️ 三件事必须一眼看到：① 它是个能站的台子；② 站上去就可以启动；③ 它通到上面哪一层。
 *    否则玩家走到旁边也不知道它是干什么的（"机制在，但没人知道"等于没做）。
 */
function drawLifts(ctx, s) {
  const p = s.player;
  for (const L of LIFTS.list) {
    const gy = terrainY(L.x);
    const on = !p.isLifting && p.onGround && Math.abs(p.x - L.x) <= LIFTS.standRadius;

    // 光柱：一直画到目标岩桥的高度（一眼看出它通到上面哪一层）
    // ⚠️ 光柱和"站上去时亮起的台面"共用 `deck` 一个色 —— 它们是同一件事的两处表达
    //    （"这一层的可站立面在发光"），分成两个色反而会让玩家以为是两个机制。
    // ⚠️ 光柱是**信息**、且长度随目标岩桥变 → 不许烤进图里。
    const topY = L.to.y + 24;
    ctx.save();
    ctx.globalAlpha = on ? 0.42 : 0.16;
    ctx.fillStyle = OBJ_SKIN.deck;
    ctx.fillRect(L.x - 15, topY, 30, Math.max(0, gy - 28 - topY));
    ctx.restore();

    // 台体 = **一整块贴图**（2026-10-04）。92×28 就是"台面 / 卡箍 / 柱体"三段的包围盒 ——
    // 也正是换图之前那三笔几何的位置，所以是**逐像素对齐**、物件位置一点没动。
    // ⚠️ 盒子有两条**别动**的约束：
    //    ① 宽 92 = `LIFTS.standRadius(46) × 2` —— "能站上去"的判定半径就是它；
    //    ② 高 28 **必须 < 主角身高 34** —— 高了就会把站在前面的人挡掉（主角画在台体之后）。
    //    素材的剪影比如果和 92:28 差太多，**先量再裁**（见 spec §7.5 那条：源图是 2.40:1，
    //    按"盒底 = 地面线"把柱体下沿裁到 3.34:1 才铺满）。
    // ⚠️ 图没加载（或 Node 里 import）→ 回退成同样轮廓的三笔几何，别留一块空白。
    const LW = 92, LH = 28, LT = 10;          // 宽 / 总高 / **台面那一段的厚度**（提亮范围就是它）
    if (!drawPropTex(ctx, 'lift', L.x - LW / 2, gy - LH, LW, LH)) {
      ctx.fillStyle = OBJ_SKIN.mid;                              // 柱体（最窄的一圈）
      ctx.fillRect(L.x - 28, gy - LH + LT + 8, 56, LH - LT - 8);
      ctx.fillStyle = OBJ_SKIN.body;                             // 卡箍（比柱体宽、两侧探出）
      ctx.fillRect(L.x - 38, gy - LH + LT, 76, 8);
      ctx.fillStyle = OBJ_SKIN.top;                              // 台面
      ctx.fillRect(L.x - LW / 2, gy - LH, LW, LT);
    }

    // 「能站」的状态提示：站上去时**台面整块**提亮 + 描边加粗（和光柱同色 = 同一件事）。
    // ⚠️ 这一段**必须留在代码里**：它是 on/off 的**状态**，不是纹样 —— 烤进图里就永远"亮着"，
    //    玩家再也分不出"这部能用"和"这部不能用"。
    if (on) {
      ctx.fillStyle = withA(OBJ_SKIN.deck, 0.8);
      ctx.fillRect(L.x - LW / 2, gy - LH, LW, LT);
    }
    ctx.strokeStyle = on ? UI_SKIN.hi : withA(UI_SKIN.textMid, 0.45);
    ctx.lineWidth = on ? 2 : 1;
    roundRect(ctx, L.x - LW / 2, gy - LH, LW, LT, 3);
    ctx.stroke();

    labelPill(ctx, on ? '上升' : '升降台', L.x, gy - 36, on ? UI_SKIN.hi : UI_SKIN.textMid);
  }
  ctx.textAlign = 'left';
}

/**
 * 隐藏区：碎石堆（2026-09-27 新增）—— 挖开它才会露出里面的**富料堆**。
 * ⚠️ 必须画得**和普通废墟明显不同**：它是"能挖开的障碍"，不是废墟。
 *    长得像废墟的话，玩家要么以为挖不出东西、要么把它当料堆反复点。
 * 裂缝条数 = 已经挖掉几层（进度反馈，和"塌方风险 %"同一个思路：可判断才敢投入）。
 */
function drawHidden(ctx, s) {
  const list = s.world.hidden || [];
  for (const h of list) {
    if (h.opened) continue;
    const w = HIDDEN.w;
    const hh = HIDDEN.h;
    const x = h.x - w / 2;
    const y = h.y - hh + 14;

    // 石堆本体：贴图优先（`w × hh` = 原来那 3 个圆角矩形的并集），没加载完 / Node 环境走原来的几何
    if (!drawPropTex(ctx, 'hidden', x, y, w, hh)) {
      ctx.fillStyle = OBJ_SKIN.body;                             // 底部石堆
      roundRect(ctx, x, y + hh * 0.34, w, hh * 0.66, 4);
      ctx.fill();
      ctx.fillStyle = OBJ_SKIN.top;                              // 上面两块错开的石头
      roundRect(ctx, x + 3, y + hh * 0.14, w * 0.54, hh * 0.38, 3);
      ctx.fill();
      roundRect(ctx, x + w * 0.44, y, w * 0.53, hh * 0.44, 3);
      ctx.fill();
    }

    // ⚠️ 进度裂纹**留在贴图外面**：挖掉几下就裂开几道，是"还要挖几下"的读数 —— 贴图替不了
    //    （贴图里刻意**一条裂纹都没有**，提示词里写死了 `no cracks`，见 spec §7.6）。
    const cracked = HIDDEN.power - h.power;
    ctx.strokeStyle = `rgba(${UI_SKIN.panelRgb},0.9)`;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < cracked; i++) {
      const cxp = x + 9 + i * ((w - 18) / Math.max(1, HIDDEN.power - 1));
      ctx.beginPath();
      ctx.moveTo(cxp, y + hh * 0.18);
      ctx.lineTo(cxp + 3, y + hh * 0.84);
      ctx.stroke();
    }

    labelPill(ctx, `碎石堆 ${h.power}`, h.x, y - 6, UI_SKIN.kindFunc);
  }
  ctx.textAlign = 'left';
}

function drawLoot(ctx, s) {
  const p = s.player;
  for (const spot of s.world.loot) {
    // ⚠️ 挖空的废墟（稳固 / 易塌）在"走开收走"之前**只剩暂存堆**：这时不能整个跳过，
    //    否则最后挖出来的那几块材料会在画面上凭空消失（玩家以为丢了）。
    //    只有"废墟没了、材料也收走了"才真的不用画。
    if (!spot.available && !spot.pending.length) continue;

    // ⚠️ 2026-09-29：**带不走了**（背包 + 暂存已满）—— 和 main.js 的 `doDig` 容量闸门同一判定。
    //    画提示的地方有两处（暂存堆的说明、站在旁边的圆环提示），都会用到它。
    const noRoom = p.carry.length + spot.pending.length >= BAG_SLOTS;

    if (!spot.depleted) {
      // ⚠️ 2026-10-05：**按类型选图**（三种外形各一张）—— 原来这里是三型共用一张。
      //    兜底链：类型图 → 兜底 `ruin` → 矢量矩形（`drawPropTex` 返回 false 才走最后那条）。
      const ruinKey = RUIN_TEX_KEY[spot.type] || 'ruin';
      if (!drawPropTex(ctx, ruinKey, spot.x - 19, spot.y - 19, 34, 29)) {
        // ⚠️ 贴图回退（图没加载完 / Node 环境）：原来那 4 块矩形，**与贴图同一包围盒**
        //    （x −19~+15、y −19~+10 = 34×29）→ 两版落在同一位置，切换时不会跳。
        // ⚠️ 2026-10-01：这三块石头原来是冷板岩色（`#4a4f5a`/`#3d424c`/`#555b68`）——
        //    它们是世界上**数量最多**的物件，漏掉之后整个画面里就剩这一片冷色（验收截图一眼可见）。
        //    现在按"最亮的那块在最上"映射到暖灰铁锈阶，明暗顺序不变。
        ctx.fillStyle = OBJ_SKIN.top;
        ctx.fillRect(spot.x - 15, spot.y - 2, 30, 12);
        ctx.fillRect(spot.x - 9, spot.y - 13, 18, 12);
        ctx.fillStyle = OBJ_SKIN.body;
        ctx.fillRect(spot.x - 19, spot.y + 2, 13, 8);
        ctx.fillStyle = OBJ_SKIN.lit;
        ctx.fillRect(spot.x + 5, spot.y - 19, 9, 7);
      }

      // ⚠️ 2026-10-05：这里原本画一个写类型名的药丸标签（"稳固 / 易塌 / 引怪"）——
      //    用户改成"用图表明"，标签**整个删掉**：类型的可见性现在由上面那张外形图承担
      //    （原来的理由"看不到类型就没法做选择"仍然成立，只是换了表达方式）。
      //    ⚠️ 别顺手把"挖空"那个标签也删了：它是**状态**（下面 else 分支），不是类型。
      //    ⚠️ 也别顺手去画"里面有多少材料 / 还剩几层"——那两条是刻意隐藏的（见本函数尾部）。
    } else {
      // 挖空了（2026-09-27 第六轮）：料堆本体没了，只留一个浅坑
      ctx.fillStyle = `rgba(${UI_SKIN.panelRgb},0.55)`;
      ctx.beginPath();
      ctx.ellipse(spot.x, spot.y + 6, 20, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      labelPill(ctx, '挖空', spot.x, spot.y - 30, withA(UI_SKIN.textMid, 0.85));
    }

    // ⚠️ 刻意不显示层数（2026-09-25 用户要求）。
    // 层数是每个料堆随机的（稳固 1~2、易塌/引怪 4~9），显示"N/4"本身就是错的。
    // 玩家只能靠下面的"塌方风险%"间接感觉到自己挖到多深了。

    // 脚下暂存堆（塌方会全丢）
    if (spot.pending.length) {
      const w = spot.pending.length * 16 + 6;
      ctx.fillStyle = withA(UI_SKIN.panelRgb, 0.8);
      roundRect(ctx, spot.x - w / 2, spot.y + 36, w, 24, 6);
      ctx.fill();
      spot.pending.forEach((mid, i) => {
        // 净区 = 脚下那一小格 12×12（短边 12 < 28）→ 层 A
        drawMaterialGlyph(ctx, spot.x - w / 2 + 5 + i * 16, spot.y + 43, 12, 12, mid, { radius: 3 });
      });
      // ⚠️ 2026-10-01（用户："只给最近的那一堆画提示"）：把**长文字**只留给玩家正站着的那一堆。
      //    为什么切在这里（而不是整块不画）：那排小材料图标必须留给**每一堆** ——
      //    它是"这里还压着料"的唯一提示，玩家在远处也要看得见；
      //    叠字的元凶是文字（20+ 字、居中、宽度能到 200px+）：半屏内有两三堆时就必然糊成一片
      //    （实测：背包满时这一堆的"背包装不下…"和邻堆的"走开自动收走"叠成了乱码）。
      //    `s.nearSpot` 正是 main.js 每帧算出的"站在哪个料堆旁"，也**就是走开时触发自动收走的那一个** ——
      //    所以"只给它画文字"在语义上也对得上：这句话本来就是说给"你正站在它旁边"的人听的。
      if (s.nearSpot === spot) {
        ctx.fillStyle = UI_SKIN.warn;
        ctx.font = `11px ${FONT}`;
        ctx.textAlign = 'center';
        // 挖空的废墟不会再塌了，提示词要跟着变（不然会误导玩家"还可能塌"）
        // ⚠️ 2026-09-29：**带不走时不能再说"走开自动收走"** —— 背包满了，走开也收不走，
        //    那几件会留在原地等玩家腾出位置（见 main.js 的 collectPending）。
        ctx.fillText(noRoom
          ? `暂存 ${spot.pending.length} 件 · 背包已满`
          : spot.depleted ? `暂存 ${spot.pending.length} 件`
            : `暂存 ${spot.pending.length} 件（塌方全丢）`, spot.x, spot.y + 74);
      }
    }

    // 站在旁边：提示可以挖 / 继续挖（不显示层数，只显示风险）
    // ⚠️ 用 `atSpot`（连高度一起判）—— 和 main.js 的"能挖 / 能收"判定必须一致，
    //    否则桥上会同时出现"点了提示却不能挖"或"挖了却收不走"（见 world.js 的 atSpot）。
    if (atSpot(spot, p.x, p.y) && !p.isBusy) {
      const zone = s.world.zoneOf(spot.zone);
      const nextChance = caveInChance(zone, spot.depth + 1, spot.type, s.layer);
      const atBottom = spot.depth >= spot.maxDepth;
      if (s.mode === 'tutorial') {
        ctx.strokeStyle = noRoom ? UI_SKIN.warn : UI_SKIN.ok;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(spot.x, spot.y - 4, 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = noRoom ? UI_SKIN.warn : UI_SKIN.ok;
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = 'center';
      // 底部提示分四种（2026-09-27 第六轮）：
      //   · 已挖空（稳固/易塌）→ 废墟马上消失，只等收走
      //   · 挖到底但还在（引怪型）→ 走开收走后能从第 1 层再来一轮
      //   · 挖过但没到底（稳固/易塌）→ ⚠️ 必须提醒"走开就没了"，否则玩家
      //     会以为还能回来接着挖（第六轮之前确实是那样），走出去才发现废墟没了
      //   · 还没挖 → 继续挖的提示
      // ⚠️ 2026-09-29 加第 0 种（最高优先）：**带不走了** —— 挖不了 / 收不走，先腾位置。
      const tip = s.mode !== 'tutorial'
        ? noRoom ? '背包已满' : spot.depleted ? '已挖空' : atBottom ? '本轮已挖完'
          : spot.depth > 0 && !RUIN_TYPES[spot.type].refill ? '离开后废墟消失' : ''
        : noRoom
        ? (spot.depleted || atBottom ? '背包装不下 · 腾出位置再回来收' : '背包装不下 · 先腾位置才能继续挖')
        : spot.depleted ? '挖空了 · 走开自动收走'
          : atBottom ? '挖到底了 · 走开收走后还能再挖一轮'
            : spot.depth > 0 && !RUIN_TYPES[spot.type].refill
              ? '点击继续挖　｜　⚠ 走开这个废墟就没了'
              : '点击继续挖（越深越值钱、越容易塌）';
      ctx.fillText(tip, spot.x, spot.y - 48);
      if (!noRoom && !atBottom && nextChance > 0) {
        ctx.fillStyle = UI_SKIN.warn;
        ctx.font = `11px ${FONT}`;
        ctx.fillText(`塌方风险 ${Math.round(nextChance * 100)}%`, spot.x, spot.y - 62);
      }
    }
  }
}

// ============================================================
// 主角精灵（2026-10-04）
// ============================================================
// 三条**横排**动画条（`pixelize --sheet` 出的，源图是用户给的精灵表）：
//   · `idle` 4×3 表 → 9 帧待机；`run` 4×4 表 → 14 帧跑步；`dig` 4×4 表 → 16 帧挖地（2026-10-05）。
// ⚠️ `dig` 和前两条不同：它**播一次、不循环** —— 正好跑满一次挖掘硬直 `DIG.tapSeconds`(1.0s)，
//    16 帧 / 1 秒 = 16fps 是它自己的节奏（不走 `ART.idleFps` / `ART.runFps`，那两个是循环播放的）。
// ⚠️ `w/h/frames` **都是素材推出来的**：w/h = pixelize 的目标尺寸、frames = 那条长条里有几格。
//    换素材必须一起改（宽度改了会让帧跨格错位，**不报错、只是每帧都画歪**）。
// ⚠️⚠️ **两条动画的"渲染尺寸"必须一致**（切换动作时角色不能突然变大/变小、不能跳）：
//    各自取"自己那张表的并集包围盒"是**可以**的 —— 前提是两边的整体高度都被归一化到 34。
//    2026-10-04 实测确认过：待机每帧 **20×34**、跑步每帧 **高 34 / 头顶 y=0**（宽度 19~24 随步幅变）✓。
//    ⚠️ 哪天换素材对不上了，用 `pixelize --box WxH` 给两条**指定同一个源图包围盒**。
//    判据就是上面那句话 —— 别凭感觉，量输出图里每帧的实体包围盒。
// ⚠️ 加载要环境守卫（`verify-glyph.js` 在 Node 里 import 本模块）；图没加载 → `drawPlayer` 走矢量回退。
const HERO_TEX = {
  idle: { src: 'assets/hero_idle.png', w: 24, h: 34, frames: 9 },
  run: { src: 'assets/hero_run.png', w: 24, h: 34, frames: 14 },
  // ⚠️⚠️ `dig` 的 **w 是 32、不是 24** —— 它不是"和另两条一样宽"，是**由这套素材的并集比例反推的**。
  //    这套表的并集是 **220×243**（比 24:34 宽得多：蹲姿那只手伸出去很远）→ 若框仍按 24×34，
  //    `contain` 就会**按宽定缩放** → 整个人只画到 **26.5px 高**（该 34）→ **挖的时候人明显变小**
  //    （2026-10-05 用户报的）。要让它"按高定"（站姿和另两条一样高），框的宽高比必须
  //    ≥ 素材并集的宽高比（220/243 = 0.905）→ 34 × 0.905 ≈ 31，取 **32** 留余量。
  //    多出来的宽度只是**两侧的透明边**，不影响观感（`drawPlayer` 按 `HT.w` 居中）。
  //    ⚠️ 换素材后必须重量"**站姿那段的高度是不是还是 34**"（判据同上一条）。
  dig: { src: 'assets/hero_dig.png', w: 32, h: 34, frames: 16 },
};

if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
  for (const k of Object.keys(HERO_TEX)) {
    const im = new Image();
    im.onload = () => { HERO_TEX[k].img = im; };
    im.src = HERO_TEX[k].src;
  }
}

/** 主角某一帧的离屏小画布（24×34），需要时把**状态色叠在精灵上**。
 *
 *  ⚠️⚠️ 为什么非要过一遍离屏：`globalCompositeOperation = 'source-atop'` 是相对**整张画布**
 *    现有的不透明像素算的 —— 直接在主画布上叠，会把**背景**也一起染，主角周围出现一个色方块。
 *    先渲到只含主角的离屏，`source-atop` 才精确地只染主角。
 *  ⚠️ 缓冲**复用**一块（每帧 createElement 会一直产生垃圾）；两条动画同为 24×34，所以能复用。 */
let heroBuf = null;
function heroFrameBuffer(anim, frame, tint) {
  if (typeof document === 'undefined') return null;
  if (!heroBuf) heroBuf = document.createElement('canvas');
  if (heroBuf.width !== anim.w || heroBuf.height !== anim.h) {
    heroBuf.width = anim.w;
    heroBuf.height = anim.h;
  }
  const g = heroBuf.getContext('2d');
  g.clearRect(0, 0, anim.w, anim.h);
  g.imageSmoothingEnabled = false;
  g.drawImage(anim.img, frame * anim.w, 0, anim.w, anim.h, 0, 0, anim.w, anim.h);
  if (tint) {
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = withA(tint, 0.6);
    g.fillRect(0, 0, anim.w, anim.h);
    g.globalCompositeOperation = 'source-over';
  }
  return heroBuf;
}

function drawPlayer(ctx, s) {
  const p = s.player;
  const y = p.y - 34;    // 脚底在 p.y（2026-09-26：加了地形与跳跃之后不再是固定地面高度）

  if (p.targetX !== null && Math.abs(p.targetX - p.x) > 4) {
    ctx.strokeStyle = withA(IDENTITY.playerRing, 0.55);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.targetX, terrainY(p.targetX) - 4, 9, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 主角的四态（2026-10-01 定的语义）：常态无色差、死暗、被咬闪红、被埋闪琥珀。
  // ⚠️ 2026-10-04 换成宇航员精灵后，四态**从"整块换色"改成"在精灵上叠一层色"** ——
  //    颜色语义一个字没改，改的只是载体（从"一个色块"变成"一个被打上光的人"）。
  //    常态特意是 `null`（不叠）：精灵自带固有色，不该再盖一层。
  const tint = p.dead ? IDENTITY.playerDead
    : p.hurtFlash > 0 ? IDENTITY.playerHurt
      : p.isStunned ? IDENTITY.playerStun : null;

  // 动画帧号 = 累计时间 × 该动作的速度。**播哪条由"这一帧有没有位移"决定**（`p.moving`，在 main.js 里算）。
  // ⚠️ 时间来自 `p.animT`（`main.js` 每帧按**游戏速度**累加）：不在渲染层读 `performance.now()` ——
  //    那样倍速和暂停都会穿帮，也没法复现"某一帧长什么样"。
  // ⚠️ 三条动画的帧数不同（9 / 14 / 16），所以切动作时帧号会**跳一下** —— 这是正常的（绝大多数游戏都这样），
  //    别为此加"相位对齐"，那反而会让起步/停步的第一帧变得不可预测。
  const moving = !!p.moving;
  // 挖掘**优先于**"跑 / 待机"：`p.digT` > 0 = 正在那一次 1 秒硬直里（见 player.js 的 digT）。
  // ⚠️ 它**播一次、不循环**：按"已经挖了多少"取帧（0 → frames-1 正好跑满硬直）。
  //    连点（`pendingDig` 缓冲）时每一下都会从头播一次，节奏和硬直天然对齐。
  const digging = (p.digT || 0) > 0;
  const HT = HERO_TEX[digging ? 'dig' : moving ? 'run' : 'idle'];
  let frame;
  if (digging) {
    const k = 1 - Math.min(1, p.digT / DIG.tapSeconds);      // 0 = 刚起手 · 1 = 挖完
    frame = Math.min(HT.frames - 1, Math.floor(k * HT.frames));
  } else {
    const fps = moving ? ART.runFps : ART.idleFps;
    frame = Math.floor((p.animT || 0) * fps) % HT.frames;
  }
  const buf = HT.img ? heroFrameBuffer(HT, frame, tint) : null;
  // 朝向（2026-10-04 用户要求"跟随行走方向转向"）：**素材本身朝右**（背包在左、面罩朝右），
  // 所以朝左时水平镜像即可，不需要第二套图。
  // ⚠️ 镜像必须 **translate(p.x) + scale(-1,1) 就地翻** —— 不能"先画到旁边再翻"：
  //    镜像的锚点就是 p.x 那条竖线，锚点错了主角会左右跳半个人身。
  // ⚠️ `scale(-1,1)` 只翻 x：所以 y 仍然写 `p.y - HT.h`（脚本里别顺手也翻 y）。
  const flip = (p.faceDir ?? 1) < 0;
  if (buf) {
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    if (flip) {
      ctx.save();
      ctx.translate(p.x, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(buf, 0, 0, HT.w, HT.h, -HT.w / 2, p.y - HT.h, HT.w, HT.h);
      ctx.restore();
    } else {
      ctx.drawImage(buf, 0, 0, HT.w, HT.h, p.x - HT.w / 2, p.y - HT.h, HT.w, HT.h);
    }
    ctx.imageSmoothingEnabled = prevSmooth;
  } else {
    // 回退（图没加载 / Node 环境）：画回抽象四边形。
    // ⚠️ 这里**必须**保留四态换色 —— 它是老视觉的唯一去处，也是"图挂了还能看出四态"的兜底。
    // ⚠️ 回退也要**跟着朝向镜像**：那个四边形的"前倾"（`playerLean`）本来就该朝向哪边倾哪边。
    ctx.fillStyle = tint || IDENTITY.player;
    // 荒诞几何：上宽下窄 + 略前倾 + 左右不对称。
    // ⚠️ 原点在**底边**（≈ 脚底 p.y；不对称让底边中点偏左 0.77px、旋转让最低点低于 p.y 约 0.5px），
    //    所以下面用 p.y + pts[j].y，不再用 y。
    //    y（= p.y - 34）仍然保留给上方文字用（背包计数 + 三种状态提示）。
    const pts = slouchBox(24, 34, ART.playerLean, ART.playerTopRatio, ART.playerAsym);
    ctx.save();
    if (flip) { ctx.translate(p.x, 0); ctx.scale(-1, 1); } else { ctx.translate(p.x, 0); }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, p.y + pts[0].y);
    for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, p.y + pts[j].y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 主角头上的三行字是**UI 文字**（屏幕语义、不是世界物件）→ 走 UI_SKIN
  ctx.fillStyle = UI_SKIN.textStrong;
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${p.carry.length}/${BAG_SLOTS}`, p.x, y - 8);

  if (p.isBusy) {
    ctx.fillStyle = UI_SKIN.ok;
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText(`挖掘中 ${p.busyT.toFixed(1)}s`, p.x, y - 24);
  } else if (p.isStunned) {
    ctx.fillStyle = UI_SKIN.warn;
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText(`被埋了 ${p.stunT.toFixed(1)}s`, p.x, y - 24);
  } else if (s.monsters.isTouching(p.x, p.y) || s.siege.isTouching(p.x, p.y)) {
    // ⚠️ 要传 p.y：站高处时够不着的怪不算"咬住"
    // ⚠️ 兽潮围攻怪也要算进来（2026-10-04）—— 只算巡逻怪的话，被围攻的怪咬着时**没有任何提示**
    ctx.fillStyle = UI_SKIN.danger;
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillText('被怪物咬住！', p.x, y - 24);
  }
}

// ============================================================
// 灾害特效贴图（2026-10-04）
// ============================================================
// 背景：在这之前 7 种灾害只有 3 类形体（`impact` 圆环 / `bolt` 折线 / `crack` 折线），
//   其中**陨石雨、龙卷风、死亡光束、毒雾、兽潮 5 种完全没有画面** —— 只有全屏染色 + 命中点一个圆环。
//   这张表把它们补成**点阵精灵**（用户 2026-10-04 选定"贴图精灵"）。
//
// ⚠️ `w` / `h` **是素材推出来的**（= `pixelize` 的目标尺寸），换图必须跟着重算。
//    放在这里、和文件名挨着，是因为"位置计算"（`fxSpritesFor`）也要用它 —— 分两处必漂。
// ⚠️ 加载要**环境守卫**（`tools/verify-glyph.js` 在 Node 里 import 本模块）。
//    图没加载就**不画那一个**：灾害特效宁可少一张，也不能像墙体那样画个形状错的替代品。
// ⚠️⚠️ **雷电不在这张表里，这是有意的**（2026-10-04 用户定："雷电保留代码画"）：
//    它的折线**每帧随机**，那正是"电光闪烁"（见 `drawEffects` 里那条注释）；
//    换成一张固定贴图会变成"每次都长一样的一道折线"，反而更假。
// ⚠️ 兽潮（`beasts`）**不需要这张表里的图**（2026-10-04 用户："兽潮改为怪物围攻"）：
//    它改由 `SiegePack` 在门外聚一群**真的怪物**来表现（见 `monsters.js` 与 `main.js`），
//    所以 `fxSpritesFor('beasts', …)` 返回空数组是**有意的**，不是"图还没出"。也**不必**再出 `fx_beasts`。
const FX_TEX = {
  meteor:  { src: 'assets/fx_meteor.png',  w: 24,  h: 36 },
  tornado: { src: 'assets/fx_tornado.png', w: 174, h: 180 },
  fog:     { src: 'assets/fx_fog.png',     w: 82,  h: 64 },
  beam:    { src: 'assets/fx_beam.png',    w: 48,  h: 200 },
  crack:   { src: 'assets/fx_crack.png',   w: 88,  h: 28 },
};

if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
  for (const k of Object.keys(FX_TEX)) {
    const im = new Image();
    im.onload = () => { FX_TEX[k].img = im; };
    im.src = FX_TEX[k].src;
  }
}

/**
 * 某次灾害命中时该放的**精灵特效** —— 纯函数，返回给 `main.js` 往 `s.effects` 里 push。
 *
 * ⚠️ **位置在这里算、不在 main.js 算**：精灵尺寸只有上面那张表知道，分两处必然漂
 *    （`main.js` 那边只有"面矩形"的 cx/cy，没有精灵的 `w/h`）。
 * ⚠️ 全部是**确定性**的：位置只由 `(x0,y0) → (x1,y1)` 线性插值得到，不用任何抖动 ——
 *    灾害特效属于 `art.js` 的**"威胁侧"，必须零抖动**（那是硬规则，别在这里加 wobble）。
 * ⚠️ 兽潮那张图还没出 → 这个分支**必须连 `FX_TEX.beasts` 一起判空**，
 *    否则读 `s.h` 会当场抛错（`FX_TEX.beasts` 是 undefined）。
 *
 * @param {string} disasterId 灾害 id（`DISASTERS` 的键）
 * @param {string} faceId 本次命中的面（`shelterRects()` 的键）
 * @param {number|null} centerX 屋外人物受击时的场景落点
 */
export function fxSpritesFor(disasterId, faceId, centerX = null) {
  const G = WORLD.groundY;
  const r = shelterRects()[faceId];
  const cx = r ? r.x + r.w / 2 : SHELTER.cx;
  const cy = r ? r.y : G - SHELTER.rise;
  const out = [];
  /** @param {string} key @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   *  @param {number} dur @param {number} [moveK] 位移在 `k = moveK` 时就走完（之后**停在落点**继续淡出）。 */
  const put = (key, x0, y0, x1, y1, dur, moveK) => {
    if (!FX_TEX[key]) return;
    out.push({ type: 'sprite', key, x0, y0, x1, y1, t: 0, dur, moveK: moveK || 1 });
  };

  // ⚠️⚠️ 下坠类（陨石 / 光束）**必须给 `moveK < 1`**：
  //    `drawEffects` 的 alpha 在 `k = 1` 正好归零 → 位移也线性走到 1 的话，
  //    精灵**恰好在落点消失**、玩家永远看不到"砸到墙上"那一刻（实测踩到过）。
  //    给 0.6 之后：前 60% 下坠、后 40% **停在落点**边烧边淡出。
  // ⚠️ 下坠的**起点不能太高**：庇护所面板（屏幕 y 16~260）会盖住上半屏，
  //    起点越高、被面板吃掉的部分越多（面板只在建造范围内显示，走出庇护所就收起）。
  if (disasterId === 'meteor') {
    const s = FX_TEX.meteor;
    const offsets = [-330, -300, -270, -240, -210, -180, -80, 0, 80, 180, 210, 240, 270, 300, 330];
    for (let i = 0; i < offsets.length; i++) {
      const x = (centerX ?? SHELTER.cx) + offsets[i];
      const roof = x >= SHELTER.cx - SHELTER.halfWidth && x <= SHELTER.cx + SHELTER.halfWidth;
      const y = (roof ? shelterRects().roof.y : terrainY(x)) - s.h / 2;
      put('meteor', x - 45, y - 260, x, y, 1.8, 0.7);
      out[out.length - 1].t = -(i % 3) * 0.18;
    }
  } else if (disasterId === 'beam') {
    const s = FX_TEX.beam;
    const x = centerX ?? cx, y = terrainY(x);
    put('beam', x, y - s.h / 2 - 170, x, y - s.h / 2, 0.9, 0.5);
  } else if (disasterId === 'tornado') {
    const s = FX_TEX.tornado;
    for (const dir of [-1, 1]) {
      const x1 = SHELTER.cx + dir * (SHELTER.halfWidth + s.w / 2 + 12);
      const x0 = x1 + dir * 100;
      put('tornado', x0, terrainY(x0) - s.h / 2, x1, terrainY(x1) - s.h / 2, 2.0);
    }
  } else if (disasterId === 'fog') {
    const s = FX_TEX.fog;
    put('fog', SHELTER.cx - 230, G - 74, SHELTER.cx + 230, G - 74, 1.6);     // 横向飘过庇护所
  } else if (disasterId === 'sinkhole') {
    const s = FX_TEX.crack;
    const x = centerX ?? cx, y = terrainY(x) - s.h / 2 + 6;
    put('crack', x, y, x, y, 1.1);                                        // 贴地裂纹（骑在地面线上）
  }
  // ⚠️ `beasts` **没有精灵**（2026-10-04 用户："兽潮改为怪物围攻"）：它改由 `SiegePack`
  //    在门外聚一群**真的怪物**来表现（见 monsters.js 与 main.js），所以这里不画任何贴图。
  return out;
}

function drawEffects(ctx, s, brightOnly = false) {
  // ⚠️ 只剩 `impact`（命中环）跟着 UI_SKIN 走 —— 它是"操作反馈"；`bolt` 是闪电，
  //    暖白是它自己的"电光"语义（和 `main.js` 的灾害地面 tint 同一族，见 config 的 OBJ_SKIN 注释）。
  // ⚠️ 2026-10-04：`crack`（地陷裂纹）已从"代码画 4 段折线"换成**点阵精灵**（`FX_TEX.crack`），
  //    所以这里不再有 `crack` 分支；用精灵的灾害统一走下面的 `sprite` 分支。
  for (const e of s.effects) {
    if (['tornado', 'meteor', 'beam'].includes(e.key) !== brightOnly || e.t < 0) continue;
    const k = e.t / e.dur;
    if (e.type === 'impact') {
      ctx.strokeStyle = withA(UI_SKIN.hi, 1 - k);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 8 + k * 46, 0, Math.PI * 2);
      ctx.stroke();
    } else if (e.type === 'bolt') {
      // ⚠️ 2026-10-01：闪电从冷青蓝 `160,220,255` 换成**暖白** —— 它是全屏最刺眼的一道折线，
      //    在暖棕世界里用冷蓝会像"外接的一根灯管"。暖白仍然读得出"电光"，而且和铁锈不打架。
      // ⚠️⚠️ 这里的 `Math.random()` 是**有意保留**的（`art.js` 顶部那张分类表里写明了）：
      //    折线每帧变 = "电光闪烁"（表现层）。别"修"成确定性 —— 那会变成一根静止的折线。
      ctx.strokeStyle = `rgba(255,236,190,${1 - k})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      let x = e.x;
      ctx.moveTo(x, 0);
      for (let y = 0; y < e.y; y += 40) {
        x += (Math.random() - 0.5) * 34;
        ctx.lineTo(x, y + 40);
      }
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
    } else if (e.type === 'sprite') {
      // 灾害精灵：位置 = `(x0,y0) → (x1,y1)` **线性**插值（在 `moveK` 处走完、之后停在落点），
      // 越接近消散越淡。
      // ⚠️ 必须**取整**再画：像素画用最近邻，非整数位置会让整张精灵半像素抖动。
      const def = FX_TEX[e.key];
      const im = def && def.img;
      if (!im) continue;                       // 图没加载 → 不画（见 `FX_TEX` 那节）
      const p = Math.min(1, k / (e.moveK || 1));
      const cx = e.x0 + (e.x1 - e.x0) * p;
      const cy = e.y0 + (e.y1 - e.y0) * p;
      const prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 1 - k * k;             // 前段几乎不透明、尾段快速淡出
      if (e.key === 'beam') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const glow = ctx.createLinearGradient(cx - 60, 0, cx + 60, 0);
        glow.addColorStop(0, 'rgba(255,230,170,0)');
        glow.addColorStop(0.5, 'rgba(255,242,205,0.75)');
        glow.addColorStop(1, 'rgba(255,230,170,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx - 60, cy - def.h / 2, 120, def.h);
        ctx.fillStyle = 'rgba(255,255,240,0.9)';
        ctx.fillRect(cx - 4, cy - def.h / 2, 8, def.h);
        ctx.drawImage(im, Math.round(cx - def.w / 2), Math.round(cy - def.h / 2), def.w, def.h);
        ctx.restore();
      } else {
        ctx.drawImage(im, Math.round(cx - def.w / 2), Math.round(cy - def.h / 2), def.w, def.h);
      }
      ctx.imageSmoothingEnabled = prev;
      ctx.globalAlpha = 1;
    }
  }
}

/**
 * 玩家动作反馈（2026-10-01）—— 挖掘落尘 / 挖到底与塌方的扬尘 / 拾取拖尾 / 贴料落位冲击环。
 *
 * ⚠️⚠️ 为什么**单开一个函数**、而不是塞进上面那个 `drawEffects`：
 *    `art.js` 顶部那张分类表把 `drawEffects` 钉成了 **spec §3.1 的"威胁侧"** ——
 *    原文是"怪物、灾害特效、陨石 → 一律**不用**本文件的抖动，保持对称与锐角"，而且那条审计
 *    已经核对过"三类形体零抖动 ✓"。这里三个特效是**玩家侧**（玩家自己动手产生的），
 *    按同一条 spec 属于"可荒诞"、**允许**用 `wobble`。混进同一个函数，
 *    art.js 那条断言就变成假话了 —— 这比"多一个函数"危险得多。
 *
 * ⚠️ 粒子位置是 **(种子, 时间) 的纯函数**：横向偏移来自 `wobble(seed, i, spread)`，
 *    纵向是抛物线的解析解。所以同一帧重绘两次结果完全一样；反过来说，
 *    这里**一旦出现 `Math.random()`，粒子就会每帧换位置、整团抖成噪点**
 *    （art.js 的 wobble 注释里有完整的踩坑来由，别在这里重犯）。
 *
 * ⚠️ 画在 `drawDarkness` **之前**是有意的：这些碎屑属于**世界**，该和地形一起被黑幕压暗
 *    （"开灯才看得见"本身就是规则）。它们都发生在玩家身边 —— 挖掘/拾取时玩家就站在料堆旁、
 *    贴料时在庇护所旁，都在光锥里。**别**为了"让它永远可见"把它挪到黑幕之后：
 *    那会让碎屑浮在暗幕上面、像贴在屏幕上，反而假。
 */
function drawActionFx(ctx, s) {
  for (const e of s.effects) {
    const k = e.t / e.dur;                 // 0 → 1 的进度
    if (k < 0 || k > 1) continue;

    if (e.type === 'dust' || e.type === 'burst') {
      const f = e.type === 'burst' ? FX.burst : FX.dust;
      ctx.globalAlpha = 1 - k;             // 越接近消散越淡
      ctx.fillStyle = f.color;
      for (let i = 0; i < f.n; i++) {
        // 横向：偏移随进度线性张开（起手时挤在一起、散开得快）
        const x = e.x + wobble(e.seed, i, f.spread) * k;
        // 纵向：z = -rise·t + ½·fall·t²（先上后落）；用 e.t 而不是 k —— 这是有量纲的
        const y = e.y - f.rise * e.t + 0.5 * f.fall * e.t * e.t;
        // 半径：wobble(…,1) ∈ [-1,1] → 0.5+0.5·v ∈ [0,1]，再线性插值到 rMin~rMax
        const r = f.rMin + (f.rMax - f.rMin) * (0.5 + 0.5 * wobble(e.seed, i + 97, 1));
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (e.type === 'gather') {
      const f = FX.gather;
      const ease = k * k * (3 - 2 * k);    // smoothstep：起步慢、中段快、到手里慢
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = f.color;
      for (let i = 0; i < f.n; i++) {
        // 出发点散开量随飞行收敛到 0（否则碎屑会各自飘到不同终点，像散架）
        const ox = wobble(e.seed, i, f.spread) * (1 - ease);
        const oy = wobble(e.seed, i + 61, f.spread) * (1 - ease);
        const x = e.x + (e.x2 - e.x) * ease + ox;
        // 弧：中途抬起来一下，看着像"被吸过去"而不是直线平移
        const y = e.y + (e.y2 - e.y) * ease + oy - Math.sin(Math.PI * ease) * f.arc;
        const r = f.rMin + (f.rMax - f.rMin) * (0.5 + 0.5 * wobble(e.seed, i + 233, 1));
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (e.type === 'ring') {
      const f = FX.ring;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 0.5 + 2.5 * (1 - k);   // 边扩散边变细
      ctx.beginPath();
      ctx.arc(e.x, e.y, f.r0 + (f.r1 - f.r0) * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

function drawDisasterOverlay(ctx, s) {
  if (s.director.phase !== Phase.DISASTER) return;
  if (s.tint) {
    ctx.fillStyle = s.tint;
    ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  }
}

// ============================================================
// 常驻面板的"收起 / 展开"外框（2026-10-05）
// ============================================================
// ⚠️ 图标支持**图片替换**：约定资源名 `assets/ui_collapse.png` / `assets/ui_expand.png`（14×14）。
//    图没加载（文件不存在 / Node 无头）就**回退到代码画的占位**（一个"−"/"+"方块）——
//    这是本项目所有素材的统一惯例，且**必须做环境守卫**：verify-glyph.js 用 Node 直接 import
//    本模块，裸写 `new Image()` 会 `ReferenceError` 直接崩（见 structTex 那批的同款注释）。
// ⚠️ `map` / `bag` 是**面板专属图标**（收起后的标签用它，见 `PANEL_ICON`）——
//    它们和 `collapse/expand` 是两回事：后者是"按钮"，前者是"这块面板是什么"。
//    图还没出也**不影响运行**：一路回退到代码画的方块（见 `drawChromeIcon`）。
// 房屋属性与仓库保留原图标，点击进入原生管理面板的对应页。
//    ⚠️ `ui_collapse` / `ui_expand` **仍然没出**（还是代码画的占位），所以浏览器里那两个 404 是预期内的。
const UI_ICON_TEX = {
  collapse: null, expand: null,
  map: null, bag: null,
  status: null, attr: null, storage: null,
};
if (typeof Image !== 'undefined' && typeof document !== 'undefined') {
  for (const [k, f] of Object.entries({
    collapse: 'ui_collapse', expand: 'ui_expand', map: 'ui_map', bag: 'ui_bag',
    status: 'ui_status', attr: 'ui_attr', storage: 'ui_storage',
  })) {
    const im = new Image();
    im.onload = () => { UI_ICON_TEX[k] = im; };
    im.src = `assets/${f}.png`;
  }
}

/** 哪块面板收起时用**自己**的图标（其余面板用通用的"展开"图标）。
 *  ⚠️ 没配 / 配了但图没加载 → 退回通用的"展开"图标 → 再退回代码画的方块（三级回退，都不会报错）。
 *  ⚠️ 2026-10-05：5 块**可收起**的面板至此各有其脸（hud=状态 / attr=属性 / storage=仓库）。
 *     ⚠️ 这里**只有 5 个键**（= `UI_PANEL_BASE`）—— 帮助面板不在其中，见 `UI_ICON_TEX` 那段注释。 */
const PANEL_ICON = {
  hud: 'status', minimap: 'map', attr: 'attr', storage: 'storage', bag: 'bag',
};

/** 画"收起/展开"小图标：优先贴图，没图就用代码画的方块 + 符号（− / +） */
function drawChromeIcon(ctx, kind, r) {
  // ⚠️ 按 `kind` 直接取（'map' / 'bag' 是面板专属图标，不是"按钮"）——
  //    写成 `kind === 'collapse' ? ... : expand` 会把专属图标全吞掉、静默画成加号。
  const tex = UI_ICON_TEX[kind];
  if (tex) {
    // ⚠️ 像素画只用最近邻（全项目惯例）。面板按钮是 40→40 的 1:1、开不开都一样，
    //    但**帮助按钮那个是 40→20 的缩小** —— 不关插值会被浏览器平滑成一团糊色
    //    （2026-10-05 实测：平滑时图标里的 `#f2e6d6` 只剩 47 格、还多出一堆不存在的插值色）。
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tex, r.x, r.y, r.w, r.h);
    ctx.imageSmoothingEnabled = prev;
    return;
  }
  // 矢量占位：和项目现有小按钮一个风格（铁皮底 + 铁锈边 + 亮色符号）
  ctx.fillStyle = withA(UI_SKIN.textStrong, 0.16);
  roundRect(ctx, r.x, r.y, r.w, r.h, 4);
  ctx.fill();
  ctx.strokeStyle = withA(UI_SKIN.rivetHi, 0.8);
  ctx.lineWidth = 1;
  ctx.stroke();
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, arm = r.w * 0.30;
  ctx.strokeStyle = UI_SKIN.textStrong;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy); ctx.stroke();   // 横杠（− 与 + 都有）
  if (kind === 'expand') {   // 再补一竖 = "+"（表示"点一下展开"）
    ctx.beginPath(); ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm); ctx.stroke();
  }
}

/**
 * 面板外框：展开时在标题条右端画"收起"图标；收起时画成一个小标签（图标 + 面板名）。
 *
 * ⚠️ 调用时机：每个面板的 draw 函数**最开头**调用，并用同一个 `collapsed` 提前 return ——
 *    否则收起后还会照着原面板几何再画一遍（盖住别的东西）。
 * @param {string} key       UI_LAYOUT / UI_PANEL_BASE 的键（hud/minimap/attr/storage/bag）
 * ⚠️ 收起态是**图标-only 的方形按钮**，没有文字 —— 所以这里不收"面板名"参数（2026-10-05）。
 * @param {boolean} collapsed 是否收起
 */
function drawPanelChrome(ctx, key, collapsed) {
  if (collapsed) {
    // 收起态 = **方形铁皮按钮 + 居中的大图标**（2026-10-05 用户："图标太小了，而且我希望是正方形的框"）。
    // ⚠️ 这里**不再画面板名字**（40×40 里放不下）—— 只能靠图标认脸，所以
    //    **没配专属图标的面板会显示通用的"展开"方块**（`PANEL_ICON` 里加一行才会换掉）。
    const r = uiLabelRect(key);
    panelPlate(ctx, r.x, r.y, r.w, r.h, { cut: 8, alpha: 0.86 });
    const s = UI_CHROME.labelIcon;
    const ir = { x: r.x + (r.w - s) / 2, y: r.y + (r.h - s) / 2, w: s, h: s };
    // 三级回退：面板专属图标 → 通用"展开"图标 → 代码画的方块（见 PANEL_ICON 的注释）
    const own = PANEL_ICON[key];
    drawChromeIcon(ctx, own && UI_ICON_TEX[own] ? own : 'expand', ir);
    return;
  }
  drawChromeIcon(ctx, 'collapse', uiCollapseIconRect(key));
}

// ---------- 左侧状态面板 ----------

export function drawCountdownClock(ctx, d, x, y, size) {
  const total = d.phase === Phase.PREP ? d.cfg.prep : d.cfg.disaster;
  const elapsed = Math.max(0, total - Math.max(0, d.timer));
  const color = !d.prepWaiting && d.timer <= 10 ? '#ef806f' : '#8fd694';
  const cx = x + size / 2, cy = y + size / 2, radius = size * .43;
  const hand = (angle, length, width) => {
    ctx.lineWidth = size * width; ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(angle) * radius * length, cy - Math.cos(angle) * radius * length); ctx.stroke();
  };
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = '#1a231e'; ctx.lineWidth = size * .065;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * radius * .82, cy - Math.cos(a) * radius * .82);
    ctx.lineTo(cx + Math.sin(a) * radius * .95, cy - Math.cos(a) * radius * .95); ctx.stroke();
  }
  hand(elapsed / 3600 * Math.PI * 2, .48, .085);
  hand(elapsed / 60 * Math.PI * 2, .74, .055);
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, size * .055, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawHUD(ctx, s) {
  // ⚠️ 收起判定必须在最前：收起时只画一个小标签就 return（不画任何面板内容）
  const collapsed = UI_LAYOUT.hud.collapsed;
  if (collapsed) { drawPanelChrome(ctx, 'hud', true); return; }
  const d = s.director;
  const p = s.player;
  const panel = hudPanelRect();
  // ⚠️⚠️ 面板内容一律用 `px / py`（**面板原点**）定位，**不能再用 `HUD.pad` 那个绝对常量**：
  //    这是"子矩形没走 offset rect"那类病的**第 4 处**（前 3 处：属性面板本体、仓库格子/分区标题、
  //    提前开波按钮）。症状最直观 —— 拖动状态面板时**只有面板底 / 收起图标 / 提前开波按钮跟着走**，
  //    其余十几行文字全钉在屏幕左上角（2026-10-05 用户："就剩状态面板不太对了"）。
  //    ⚠️ 为什么前一轮没扫到它：这里用的是局部名 `pad`，**搜 `HUD.pad` 查不到 render** ——
  //    找同类时要搜"那个数被赋给了谁"，光搜常量名会漏。
  const px = panel.x;
  const py = panel.y;
  ctx.textAlign = 'left';

  // 面板底：走统一的「铁皮面板」（切角 + 铁锈边 + 铆钉），见 panelPlate 的注释
  panelPlate(ctx, panel.x, panel.y, panel.w, panel.h, {});
  ctx.fillStyle = '#25332d'; ctx.fillRect(panel.x + 12, panel.y + 10, panel.w - 24, 28);
  drawPanelChrome(ctx, 'hud', false);

  ctx.fillStyle = UI_SKIN.textStrong;
  ctx.font = `bold 20px ${FONT}`;
  // ⚠️ 终点是 12 波，所以必须让玩家随时知道"还差几波"。
  //    拉长到 12 波却只显示"第 7 波"，那就只是一个看不到头的数字。
  ctx.fillText(d.endless ? `第 ${d.wave} 波 · 无尽` : `第 ${d.wave}/${WIN_WAVE} 波`,
    // ⚠️ 从 `pad + 16` 改成让开左上角的收起图标（见 config 的 `uiTitleTextInset`）——
    //    不让开的话，那行字会被图标方块压住头一个字。右侧的「准备期」不用动（176 > 图标右缘 45）。
    px + uiTitleTextInset(), py + 32);

  const phaseLabel = d.phase === Phase.PREP ? '准备期'
    : d.phase === Phase.DISASTER ? '灾害期'
      : d.phase === Phase.WIN ? '已通关' : '已结束';
  ctx.font = `14px ${FONT}`;
  ctx.fillStyle = d.phase === Phase.DISASTER ? UI_SKIN.warn : UI_SKIN.ok;
  // ⚠️ x 从 `176` 挪到 `198`（2026-10-05）：无尽模式下波次文字是「第 13 波 · 无尽」，
  //    实测宽 137.3px、从 px+35 起 → 末尾 px+188.3，离原来的 176 只剩 3.7px（贴脸）。
  //    挪到 198 后：离波次末尾 25.7px ✓、离「最后一波」（px+250）10px ✓。
  ctx.fillText(phaseLabel, px + 198, py + 32);

  // 最后一波要显式标出来 —— 否则玩家在第 12 波被"突然通关"会反应不过来
  if (!d.endless && d.wave === WIN_WAVE) {
    ctx.fillStyle = UI_SKIN.hi;
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText('最后一波', px + 250, py + 32);
  }

  // ⚠️ 2026-09-29：准备期"等玩家出门"时倒计时**是冻结的**（见 waveDirector 的 `prepWaiting`）。
  //    此时不能再显示那串静止不动的 "180.0s" —— 玩家只会以为游戏卡住了。改成状态文字。
  if (d.prepWaiting) {
    ctx.fillStyle = UI_SKIN.hi;
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillText('整备中', px + 56, py + 70);
  } else {
    ctx.fillStyle = d.timer <= 10 ? '#ef806f' : '#8fd694';
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillText(`${Math.max(0, d.timer).toFixed(1)}s`, px + 56, py + 70);
  }
  drawCountdownClock(ctx, d, px + 16, py + 44, 30);

  ctx.font = `13px ${FONT}`;
  ctx.fillStyle = UI_SKIN.textMid;
  if (d.phase === Phase.PREP) {
    // "提前开波"按钮（2026-09-26）：把"本波灾害"行和操作提示合成**一个可点区块**。
    // ⚠️ 两行必须合并：面板很密，原来那行提示（基线 102）上方只有约 5px 空隙，
    //    单独做成按钮只有 18px 高 —— 手机上根本点不中。两行合起来才有 42px。
    // ⚠️ 它必须有：Enter 只有键盘有，而这是微信小游戏（见 config.js 的 SKIP_BTN 注释）。
    const b = skipBtnRect();
    // ⚠️ 2026-09-29：冻结期（还没出门）这个按钮是**禁用的**（用户定"停用"）。
    //    必须画成"灰的 + 写明为什么" —— 只把点击挡掉、外观不变，玩家点了几次没反应
    //    只会当成按钮坏了（本项目反复踩过"静默无反馈"这个坑）。
    const locked = d.prepWaiting;
    ctx.setLineDash([]);
    // 禁用态 = 铁锈色系里最暗的一档（不是"另一种颜色的按钮"）：只降饱和度和亮度
    ctx.fillStyle = locked ? withA(UI_SKIN.textDim, 0.12) : withA(UI_SKIN.info, 0.14);
    roundRect(ctx, b.x, b.y, b.w, b.h, 5);
    ctx.fill();
    ctx.strokeStyle = locked ? withA(UI_SKIN.textDim, 0.45) : withA(UI_SKIN.info, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = locked ? UI_SKIN.textDim : UI_SKIN.textMid;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(`本波灾害：${d.upcomingNames.join(' + ')}`, b.x + 10, b.y + 20);
    ctx.fillStyle = locked ? UI_SKIN.textDim : UI_SKIN.info;
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText(locked ? '▶ 提前开波（离开庇护所后可用）' : '▶ 提前开波（省时间换材料）', b.x + 10, b.y + 38);
  } else {
    ctx.fillText(`本波灾害：${d.upcomingNames.join(' + ')}`, px + skipTextInsetX(), py + 66);
  }

  ctx.fillStyle = UI_SKIN.textMid;
  ctx.font = `13px ${FONT}`;
  ctx.fillText('主角', px + 16, py + 100);
  bar(ctx, px + 56, py + 89, 150, 12, p.hp / PLAYER.maxHp, p.hp > 40 ? UI_SKIN.ok : UI_SKIN.danger);
  ctx.fillStyle = UI_SKIN.textStrong;
  ctx.fillText(`${Math.round(p.hp)}`, px + 214, py + 100);

  ctx.fillStyle = UI_SKIN.textMid;
  ctx.fillText(`背包 ${p.carry.length}/${BAG_SLOTS}  负重 ${p.carryWeight}  速度 ${Math.round(p.speed)}`, px + 16, py + 120);
  ctx.fillText(`庇护所总重 ${s.shelter.totalWeight}   有效高度 ${Math.round(s.shelter.height)}`, px + 16, py + 138);
  ctx.fillStyle = s.repairUnits > 0 ? UI_SKIN.kindRepair : UI_SKIN.textDim;
  ctx.fillText(`修复材料余量 ${s.repairUnits} 点耐久`, px + 16, py + 156);

  // 还没放置的"扩展空位"额度（2026-09-26 用户要求）。
  // ⚠️ 必须常驻显示：它是玩家手上没用掉的成长资源，藏起来就会有人一路漏放 ——
  //    而"放哪一面"正是这条机制的全部决策点。
  //    面板高度为此从 212 加到 224（见 config.js 的 HUD）。
  //    ⚠️ y 必须排在「倍速/预告/每波回血」那行（py+194）**下面**，
  //       一开始写成 py+196 正好压在它上面（两行字叠在一起）。面板底边 = py+h = panel.y+224。
  if (s.shelter.bonusSlots > 0) {
    ctx.fillStyle = UI_SKIN.ok;
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillText(`待放空位 ${s.shelter.bonusSlots}`, px + 16, py + 214);
  }

  // 优先级：在外面被打 > 庇护所没挡住（击穿/透传）> 引怪 > 附近有怪物
  const md = s.monsters.nearestDistance(p.x, p.y);   // ⚠️ 带 p.y：站高处时下方的怪不算威胁
  const lured = s.monsters.luredCount;
  const insideRange = Math.abs(p.x - SHELTER.cx) <= SHELTER.shelterRange;
  if (d.phase === Phase.DISASTER && !insideRange) {
    ctx.fillStyle = UI_SKIN.danger;
    ctx.fillText('⚠ 暴露在外 · 你和庇护所同时受灾', px + 16, py + 176);
  } else if (s.leakAlert) {
    // 庇护所看着好好的、人却在掉血 —— 必须说出来，否则玩家根本不知道自己在挨打
    ctx.fillStyle = UI_SKIN.danger;
    ctx.fillText(s.leakAlert.kind === 'split'
      ? `⚠ ${s.leakAlert.name}由墙体和人物分摊，生命每次 -${Math.round(s.leakAlert.dmg)}`
      : s.leakAlert.kind === 'pierce'
      ? `⚠ ${s.leakAlert.name}穿透了庇护所，正在扣你的血（每次 -${Math.round(s.leakAlert.dmg)}）`
      : `⚠ 有面已彻底破了，${s.leakAlert.name}直接打在你身上（每次 -${Math.round(s.leakAlert.dmg)}）`,
      px + 16, py + 176);
  } else if (s.blockAlert) {
    // 悬崖式手感的核心反馈：让玩家明确知道"这次刚好完全挡住了"。
    // 看不见这个，玩家就只会以为伤害变小了，永远发现不了"再换好一点的材料就能免伤"。
    ctx.fillStyle = UI_SKIN.ok;
    ctx.fillText(`✓ ${s.blockAlert.name}被完全拦住（一点都没打进来）`, px + 16, py + 176);
  } else if (s.dodgeAlert) {
    // 靠地形躲掉了 —— 这条反馈决定了玩家会不会再去用地形
    ctx.fillStyle = UI_SKIN.ok;
    ctx.fillText(
      s.dodgeAlert.kind === 'occluder'
        ? `✓ 躲在岩棚下，${s.dodgeAlert.name}没打到你`
        : `✓ 站在高处，${s.dodgeAlert.name}没波及到你`,
      px + 16, py + 176
    );
  } else if (lured > 0) {
    ctx.fillStyle = UI_SKIN.danger;
    ctx.fillText(`⚠ ${lured} 只怪物正被挖掘声吸引过来`, px + 16, py + 176);
  } else if (md < s.monsters.warnRadius) {
    ctx.fillStyle = md < 120 ? UI_SKIN.danger : UI_SKIN.warn;
    ctx.fillText(`⚠ 附近有怪物（${Math.round(md)}px）`, px + 16, py + 176);
  } else {
    ctx.fillStyle = UI_SKIN.textDim;
    ctx.fillText(`庇护所内 · 附近暂无怪物`, px + 16, py + 176);
  }
  ctx.fillStyle = UI_SKIN.textDim;
  // "每波回血"必须写在 HUD 上 —— 它是"为什么我撑了 12 波还没死"的唯一解释，
  // 只在换波横幅里闪现一次是不够的（玩家会以为血条在自动回满，误解规则）。
  ctx.fillText(
    `倍速 ${s.speed}x   预告 ${s.showForecast ? '开' : '关'}   每波回血 +${PLAYER_HEAL_PER_WAVE}`,
    px + 16, py + 194);

}

// ---------- 背包 ----------

function drawBag(ctx, s) {
  const p = s.player;
  const collapsed = UI_LAYOUT.bag.collapsed;
  // 展开与收起共用同一个原背包图标，材料条不会覆盖它。
  drawPanelChrome(ctx, 'bag', true);

  let hovered = -1;
  // 收起时整块背包（面板 + 格子）不画 —— 只留上面的小标签
  if (!collapsed) {
    const panel = bagPanelRect();

    panelPlate(ctx, panel.x, panel.y, panel.w, panel.h, {});

    ctx.textAlign = 'left';
    ctx.fillStyle = UI_SKIN.textMid;
    ctx.font = `12px ${FONT}`;
    ctx.fillText('背包', panel.x + UI.bagPad, panel.y - 6);

    // 正在被消耗的那一份修复材料（要显示剩余量）
    const openIdx = s.repairOpen ? s.player.carry.indexOf(s.repairOpen.matId) : -1;
    for (let i = 0; i < BAG_SLOTS; i++) {
      const r = bagSlotRect(i);
      const mid = p.carry[i] || null;
      const isHover = s.hoverBagIndex === i;

      // ⚠️ 格子底**不能跟着面板一起转暖棕**：格子里直接叠材料图标，底一亮材料就糊了
      //    （见 config.js 的 UI_SKIN 长注释）。所以格子只换"空的暗底"和"边"，有料的那档维持原样。
      ctx.fillStyle = mid ? UI_SKIN.slotBg : UI_SKIN.slotBgEmpty;
      roundRect(ctx, r.x, r.y, r.w, r.h, 6);
      ctx.fill();
      ctx.strokeStyle = isHover && mid ? UI_SKIN.info : UI_SKIN.slotEdge;
      ctx.lineWidth = isHover && mid ? 2 : 1;
      ctx.stroke();

      if (mid) {
        const m = MATERIALS[mid];
        drawMaterialGlyph(ctx, r.x + 7, r.y + 7, r.w - 14, r.h - 14, mid, { radius: 6 });
        // 类别标记：结 = 结构件；功 = 功能件；修 = 修复材料（消耗品）
        const [tag, tagColor] = kindTag(m.kind);
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        roundRect(ctx, r.x + 4, r.y + r.h - 21, 22, 17, 4);
        ctx.fill();
        ctx.fillStyle = tagColor;
        ctx.font = `bold 11px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(tag, r.x + 15, r.y + r.h - 8);
        ctx.textAlign = 'left';

        // 正在消耗的那一份：显示剩余修复量（用完就会自动消失）
        // 用 ceil 而不是 round —— 还剩 0.1 时若显示"剩0"，玩家会以为它该消失却没消失
        if (i === openIdx && s.repairOpen) {
          ctx.fillStyle = 'rgba(0,0,0,0.78)';
          roundRect(ctx, r.x + r.w - 34, r.y + 4, 30, 15, 4);
          ctx.fill();
          ctx.fillStyle = UI_SKIN.kindRepair;
          ctx.font = `bold 10px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(`剩${Math.ceil(s.repairOpen.left)}`, r.x + r.w - 19, r.y + 15);
          ctx.textAlign = 'left';
        }
      } else {
        ctx.fillStyle = withA(UI_SKIN.textMid, 0.30);
        ctx.font = `11px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('空', r.x + r.w / 2, r.y + r.h / 2 + 4);
        ctx.textAlign = 'left';
      }
      if (isHover && mid) hovered = i;
    }
  }

  if (!collapsed && hovered >= 0) drawMaterialTooltip(ctx, p.carry[hovered], bagSlotRect(hovered));
}

/** 类别标记：结 = 结构件，功 = 功能件，修 = 修复材料（消耗品） */
function kindTag(kind) {
  if (kind === 'struct') return ['结', UI_SKIN.kindStruct];
  if (kind === 'func') return ['功', UI_SKIN.kindFunc];
  return ['修', UI_SKIN.kindRepair];
}

/**
 * 合成面板（**屏幕坐标**）—— 2026-09-27。
 * 玩法：选两件**结构材料** → 开始 → 30 秒后台出结果（成功 / 出次品 / 报废）。
 * ⚠️ 面板上必须把"成功率和失败后果"直接写出来：失败里有一档是**不可逆报废**，
 *    不提前说明就是让玩家在不知情的情况下赌（文档第 7 节也要求上线前定夺是否加二次确认）。
 * ⚠️ 候选格的数量要**扣掉已经选进槽里的那些**（两槽可以是同一种材料），
 *    否则玩家会看到"x1 却能选两件"，点了开始才被拒。
 */
function drawSynthPanel(ctx, s) {
  if (!s.synthPanel || document.getElementById('game-dialog')?.open) return;
  const g = synthGeometry(), { panel, u } = g, p = s.synthPanel;
  const cap = synthOptionCapacity(), scroll = synthScrollGeometry(s.synthOptions.length, p.scrollY);
  p.scrollY = scroll.offset;
  const label = (value, x, y, width, color = UI_SKIN.textStrong, size = 14, bold = false) => {
    ctx.font = `${bold ? 'bold ' : ''}${size * u}px ${FONT}`;
    ctx.textAlign = 'left'; ctx.fillStyle = color;
    while (ctx.measureText(value).width > width && value.length > 1) value = value.slice(0, -2) + '…';
    ctx.fillText(value, x, y);
  };
  const action = (r, value, enabled = true, primary = false) => {
    drawEnamelPlate(ctx, r.x, r.y, r.w, r.h, primary && enabled ? '#356b58' : enabled ? '#47554d' : '#26342d',
      primary && enabled ? '#a8ce98' : '#73816a');
    ctx.font = `${(value === '×' ? 24 : 14) * u}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.fillStyle = enabled ? UI_SKIN.textStrong : UI_SKIN.textDim;
    ctx.fillText(value, r.x + r.w / 2, r.y + r.h / 2 + 5 * u);
  };
  ctx.save();
  ctx.fillStyle = '#08100dcc'; ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  panelPlate(ctx, panel.x, panel.y, panel.w, panel.h, { alpha: 1 });
  ctx.fillStyle = '#25332d'; ctx.fillRect(panel.x + 10*u, panel.y + 8*u, panel.w - 20*u, 46*u);
  label(`合成台 ${String(p.bench + 1).padStart(2, '0')}`, panel.x + g.pad, panel.y + 35*u, panel.w - 80*u, '#f1dfaa', 18, true);
  action(synthCloseRect(), '×');
  ctx.fillStyle = '#8c8057'; ctx.fillRect(panel.x + g.pad, panel.y + 54*u, panel.w - g.pad*2, u);
  ctx.fillStyle = '#65735f'; ctx.fillRect(g.optionX - 8*u, g.top, u, g.bottom - g.top);
  label('第一件', panel.x + g.pad, g.top + 16*u, 68*u, UI_SKIN.textMid);
  const second = synthSlotRect(1);
  label('第二件', second.x, g.top + 16*u, 68*u, UI_SKIN.textMid);
  for (let i = 0; i < 2; i++) {
    const r = synthSlotRect(i), id = p[i ? 'slotB' : 'slotA'];
    drawEnamelPlate(ctx, r.x, r.y, r.w, r.h, '#26312b', id ? '#e7bd69' : '#65735f');
    if (id) drawMaterialGlyph(ctx, r.x + (r.w - 48*u)/2, r.y + (r.h - 48*u)/2, 48*u, 48*u, id, { radius: 4*u });
    else label('＋', r.x + r.w/2 - 7*u, r.y + r.h/2 + 5*u, r.w, '#73816a', 18);
    label(id ? MATERIALS[id].name : '未投入', r.x, r.y + r.h + 16*u, r.w, id ? UI_SKIN.textStrong : UI_SKIN.textDim, 12);
  }
  const a = synthSlotRect(0);
  label('+', a.x + a.w + 5*u, a.y + a.h/2 + 5*u, 18*u, '#f1dfaa', 18);
  const recipe = p.slotA && p.slotB && recipeOf(p.slotA, p.slotB);
  const previewY = a.y + a.h + 34*u;
  if (g.bottom - previewY >= 60*u && recipe) {
    drawMaterialGlyph(ctx, panel.x + g.pad, previewY, 40*u, 40*u, recipe.ok, { radius: 4*u });
    label('预计产物', panel.x + g.pad + 48*u, previewY + 15*u, g.sideW - 48*u, UI_SKIN.textMid);
    label(MATERIALS[recipe.ok].name, panel.x + g.pad + 48*u, previewY + 35*u, g.sideW - 48*u, '#f1dfaa');
    label(`成功 ${Math.round(SYNTH.successRate[MATERIALS[recipe.a].tier] * 100)}% · 30秒`, panel.x + g.pad, previewY + 57*u, g.sideW, UI_SKIN.ok, 12);
  } else {
    label(recipe ? `→ ${MATERIALS[recipe.ok].name}` : p.slotA && p.slotB ? '无匹配配方' : '等待投入', panel.x + g.pad, Math.min(previewY + 14*u, g.bottom - 4*u), g.sideW, recipe ? UI_SKIN.ok : UI_SKIN.textMid);
  }
  label(`结构材料 · ${s.synthOptions.length}种`, g.optionX, g.top + 16*u, g.gridW, '#f1dfaa');
  if (!s.synthOptions.length) {
    label('暂无结构材料', g.optionX + 8*u, g.top + 64*u, g.gridW - 16*u, UI_SKIN.textMid);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(scroll.view.x, scroll.view.y, scroll.view.w, scroll.view.h); ctx.clip();
  for (let i = 0; s.synthOptions.length && i < Math.max(cap, s.synthOptions.length); i++) {
    const r = synthOptionRect(i, scroll.offset), o = s.synthOptions[i];
    if (r.y + r.h < scroll.view.y || r.y > scroll.view.y + scroll.view.h) continue;
    ctx.fillStyle = '#1a231e'; ctx.fillRect(r.x, r.y, r.w, r.h);
    const partner = o && p.slotA && !p.slotB && canSynthesize(p.slotA, o.id).ok;
    ctx.strokeStyle = partner ? UI_SKIN.ok : '#46513f'; ctx.lineWidth = (partner ? 2 : 1)*u;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (!o) { ctx.strokeStyle = '#364333'; ctx.strokeRect(r.x + 5*u, r.y + 5*u, r.w - 10*u, r.h - 10*u); continue; }
    const rest = o.count - (p.slotA === o.id ? 1 : 0) - (p.slotB === o.id ? 1 : 0);
    ctx.globalAlpha = rest > 0 ? 1 : .4;
    drawMaterialGlyph(ctx, r.x + (r.w - 48*u)/2, r.y + 4*u, 48*u, 48*u, o.id, { radius: 4*u });
    label(MATERIALS[o.id].name, r.x + 4*u, r.y + r.h - 7*u, r.w - 8*u, UI_SKIN.textStrong);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#111a14'; ctx.fillRect(r.x + r.w - 30*u, r.y + 2*u, 28*u, 17*u);
    label(`×${rest}`, r.x + r.w - 28*u, r.y + 15*u, 26*u, rest > 0 ? '#f1dfaa' : UI_SKIN.danger, 12);
  }
  ctx.restore();
  if (scroll.max > 0) {
    const r = scroll.rail, t = scroll.thumb;
    ctx.fillStyle = '#111a14'; ctx.fillRect(r.x + 18*u, r.y, 4*u, r.h);
    drawEnamelPlate(ctx, t.x, t.y, t.w, t.h, '#65735f', '#a8b28b');
  }
  ctx.fillStyle = '#25332d'; ctx.fillRect(panel.x + 10*u, g.bottom, panel.w - 20*u, 52*u);
  ctx.fillStyle = '#71806a'; ctx.fillRect(panel.x + g.pad, g.bottom, panel.w - g.pad*2, u);
  label(`${s.synthOptions.length} 种材料`, panel.x + g.pad, g.bottom + 35*u, 120*u, UI_SKIN.textMid);
  const busy = s.workbenches[p.bench]?.busy;
  action(synthStartRect(), busy ? '工作台正在用' : recipe ? '开始合成 · 30秒' : '等待材料', !!recipe && !busy, true);
  ctx.restore();
}

/**
 * 小地图（2026-09-27 新增）—— HUD 下方的一块缩略图。
 *
 * 两个设计点：
 *  ① **逐步点亮**：只显示"走过的 x 范围"，其余盖暗 —— 一开局就把全图摆出来就没有"探索"了。
 *  ② 纵向按**世界 y** 映射：地面废墟、桥上废墟、玩家各在各的高度上，
 *     于是这张图还能当"高度尺"看（一眼知道哪条桥在上面）。
 * ⚠️ 半透明：人物跑到世界最左端时屏幕位置会靠近它，压住了也得看得见。
 */
function drawMinimap(ctx, s) {
  // ⚠️ 收起判定在最前：收起时只画小标签就 return
  const collapsed = UI_LAYOUT.minimap.collapsed;
  if (collapsed) { drawPanelChrome(ctx, 'minimap', true); return; }
  // ⚠️ 用 minimapRect() 而不是直接读 MINIMAP —— 拖动小地图时偏移落在 M.x/M.y 上（下面全用 M）。
  const M = minimapRect();
  const pad = MINIMAP.pad;
  const innerW = M.w - pad * 2;
  const innerH = M.h - pad * 2;
  const toX = (wx) => M.x + pad + (wx / WORLD.width) * innerW;
  const toMY = (wy) => M.y + pad + (wy / VIEW.h) * innerH;

  // 半透明档（panelASoft）：人物跑到世界最左端时会压住它，全不透明就把他挡住了
  panelPlate(ctx, M.x, M.y, M.w, M.h, { alpha: UI_SKIN.panelASoft });
  drawPanelChrome(ctx, 'minimap', false);

  // 地形轮廓（世界每 40px 取一点；高度压在 `lineH` 像素内）
  ctx.beginPath();
  for (let wx = 0; wx <= WORLD.width; wx += 40) {
    const rise = Math.min(terrainRise(wx), TERRAIN.maxRise) / TERRAIN.maxRise;
    const y = M.y + M.h - pad - rise * MINIMAP.lineH;
    if (wx === 0) ctx.moveTo(toX(wx), y); else ctx.lineTo(toX(wx), y);
  }
  ctx.strokeStyle = withA(UI_SKIN.textMid, 0.55);   // = textMid 的暖灰，替代原来的冷灰蓝
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 岩桥（横线）
  ctx.strokeStyle = withA(UI_SKIN.info, 0.6);    // = info 铜绿
  ctx.lineWidth = 2;
  for (const b of PLATFORMS.list) {
    ctx.beginPath();
    ctx.moveTo(toX(b.x), toMY(b.y));
    ctx.lineTo(toX(b.x + b.w), toMY(b.y));
    ctx.stroke();
  }

  // 未探索的部分盖暗（左右各一块）
  const ex = s.explored;
  const seen = (x) => ex.max <= ex.min || (x >= ex.min - 50 && x <= ex.max + 50);
  if (ex.max > ex.min) {
    ctx.fillStyle = `rgba(${UI_SKIN.panelRgb},0.72)`;
    const x0 = M.x + pad;
    const x1 = M.x + M.w - pad;
    ctx.fillRect(x0, M.y + pad, Math.max(0, toX(ex.min) - x0), innerH);
    ctx.fillRect(toX(ex.max), M.y + pad, Math.max(0, x1 - toX(ex.max)), innerH);
  }

  // 废墟（带掉落加成的用金色：上层废墟 / 隐藏区里的富料堆）
  // ⚠️ 2026-09-28：**地下不再金色** —— 它原来是 `zone abyss + bonus 6`（金色），现在改成
  //    "统一深区待遇 + bonus 0"（见 config 的 UNDERWORLD）。地下的料整体比近/中区好，
  //    但那是**整层**的性质、不是"这一堆特别好"，所以不给它金色标记（和这行注释的原意一致）。
  for (const l of s.world.loot) {
    if (!l.available || !seen(l.x)) continue;
    ctx.fillStyle = l.bonus ? UI_SKIN.hi : withA(UI_SKIN.textMid, 0.8);
    ctx.fillRect(toX(l.x) - 1, toMY(l.y) - 1, 2.5, 2.5);
  }
  // 升降台
  for (const L of LIFTS.list) {
    if (!seen(L.x)) continue;
    ctx.fillStyle = UI_SKIN.info;
    ctx.fillRect(toX(L.x) - 2, toMY(terrainY(L.x)) - 4, 4, 4);
  }
  // 天然石台（细横线）
  ctx.strokeStyle = withA(UI_SKIN.textMid, 0.5);
  ctx.lineWidth = 1.5;
  for (const l of LEDGES.list) {
    if (!seen(l.x)) continue;
    ctx.beginPath();
    ctx.moveTo(toX(l.x), toMY(l.y));
    ctx.lineTo(toX(l.x + l.w), toMY(l.y));
    ctx.stroke();
  }
  // 隧道：两端画圆 + 一条虚线（一眼看出"这两个口是连着的"）
  ctx.strokeStyle = withA(UI_SKIN.info, 0.75);
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  for (const t of TUNNELS.list) {
    if (!seen(t.a.x) && !seen(t.b.x)) continue;
    ctx.beginPath();
    ctx.moveTo(toX(t.a.x), toMY(terrainY(t.a.x)));
    ctx.lineTo(toX(t.b.x), toMY(terrainY(t.b.x)));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const t of TUNNELS.list) {
    for (const p of [t.a, t.b]) {
      if (!seen(p.x)) continue;
      ctx.fillStyle = UI_SKIN.info;
      ctx.beginPath();
      ctx.arc(toX(p.x), toMY(terrainY(p.x)), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 地穴入口 / 上行口：
  //   · 地面层的入口要**探索到**才显示（找入口本身是探索的一部分）
  //   · 地下层的上行口**始终显示** —— 不然玩家会困在地下转不出去，那是挫败不是难度
  for (const e of entrances()) {
    if (s.layer === 'ground' && !seen(e.x)) continue;
    ctx.fillStyle = s.layer === 'under' ? UI_SKIN.kindFunc : UI_SKIN.hi;
    ctx.beginPath();
    ctx.arc(toX(e.x), toMY(terrainY(e.x)), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // 碎石堆（没打开的才画）
  for (const h of s.world.hidden || []) {
    if (h.opened || !seen(h.x)) continue;
    ctx.fillStyle = UI_SKIN.kindFunc;
    ctx.fillRect(toX(h.x) - 2, toMY(h.y) - 2, 4, 4);
  }
  // 庇护所（⚠️ 2026-09-27：地下不画 —— 那是另一张地图，标出来会误导，见"为什么地下也有庇护所"）
  if (s.layer !== 'under' && seen(SHELTER.cx)) {
    ctx.fillStyle = withA(UI_SKIN.hi, 0.85);   // = hi @ 0.85
    ctx.fillRect(toX(SHELTER.cx) - 2, toMY(370), 4, Math.max(2, toMY(570) - toMY(370)));
  }
  // 玩家
  ctx.fillStyle = UI_SKIN.ok;
  ctx.fillRect(toX(s.player.x) - 1.5, toMY(s.player.y) - 5, 3, 6);

  // 标题（画在面板**上方**，免得和内容挤）
  ctx.fillStyle = UI_SKIN.textDim;
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('地图 · 已探索范围', M.x + 4, M.y - 4);
}

/**
 * 垃圾桶（丢弃区）—— 常驻在背包右侧。
 * ⚠️ 必须常驻：只在拖拽时浮现的话，玩家根本不知道有这个功能。
 * 拖材料压上来时整体变红并改文案，松手才真的丢掉。
 */
function drawTrash(ctx, s) {
  const r = trashRect();
  const active = !!(s.drag && s.dragTarget && s.dragTarget.kind === 'trash');

  panelPlate(ctx, r.x, r.y, r.w, r.h, {
    bg: active ? withA(UI_SKIN.danger, 0.26) : undefined,
    edge: active ? UI_SKIN.danger : UI_SKIN.rivet,
    lineWidth: active ? 3 : 1.5,
  });

  // 桶：盖 + 提手 + 身
  const cx = r.x + r.w / 2;
  const lidY = r.y + 22;
  const ink = active ? '#ff8a7a' : UI_SKIN.textMid;
  ctx.fillStyle = ink;
  ctx.fillRect(cx - 6, lidY - 7, 12, 5);
  ctx.fillRect(cx - 23, lidY, 46, 6);
  ctx.fillRect(cx - 18, lidY + 12, 36, 32);

  // 桶身上的竖纹（让它一眼看出是垃圾桶，而不是一个方块）
  ctx.fillStyle = active ? 'rgba(80,10,0,0.45)' : `rgba(${UI_SKIN.panelRgb},0.55)`;
  for (let i = -1; i <= 1; i++) ctx.fillRect(cx + i * 10 - 1.5, lidY + 18, 3, 20);

  ctx.textAlign = 'center';
  ctx.fillStyle = active ? '#ffd7d0' : UI_SKIN.textMid;
  ctx.font = `bold 12px ${FONT}`;
  ctx.fillText(active ? '松手丢弃' : '丢弃', cx, r.y + r.h - 8);
  ctx.textAlign = 'left';
}

/** 丢弃后的"撤销"按钮 —— **吊在垃圾桶正下方**（垃圾桶在画布右上角，见 config 的 `trashUndoRect`），
 *  只存在 TRASH_UNDO_SECONDS 秒 */
function drawTrashUndo(ctx, s) {
  if (!s.trashUndo) return;
  const r = trashUndoRect();
  const left = Math.max(0, s.trashUndo.t);

  // ⚠️ 顺序：先铺底 + 进度条，**最后**才让 panelPlate 描边压上去。
  //    反过来（先描边再填进度）进度色会盖住左边那段边框和左上角的铆钉。
  ctx.fillStyle = `rgba(${UI_SKIN.panelRgb},${UI_SKIN.panelA})`;
  cutCornerPath(ctx, r.x, r.y, r.w, r.h, 6);
  ctx.fill();
  ctx.save();
  cutCornerPath(ctx, r.x, r.y, r.w, r.h, 6);
  ctx.clip();
  ctx.fillStyle = withA(UI_SKIN.ok, 0.30);    // = ok @ 0.30
  ctx.fillRect(r.x, r.y, r.w * (left / TRASH_UNDO_SECONDS), r.h);
  ctx.restore();
  // 透明底 → 只画边 + 铆钉（不覆盖刚铺好的进度条）
  panelPlate(ctx, r.x, r.y, r.w, r.h, {
    cut: 6, bg: 'rgba(0,0,0,0)', edge: UI_SKIN.ok, lineWidth: 2,
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = UI_SKIN.textStrong;
  ctx.font = `bold 13px ${FONT}`;
  ctx.fillText(`撤销 ${left.toFixed(1)}s`, r.x + r.w / 2, r.y + 22);
  ctx.textAlign = 'left';
}

function drawMaterialTooltip(ctx, mid, near) {
  const m = MATERIALS[mid];
  // 材料属性从 3 个扩到 6 个（2026-09-26），提示框要跟着变高，否则属性被截断
  const w = 268;
  const h = m.kind === 'repair' ? 96 : 152;
  let x = near.x + near.w + 12;
  let y = near.y - h - 8;
  if (x + w > VIEW.w - 12) x = VIEW.w - w - 12;
  if (y < 12) y = near.y + near.h + 8;
  if (y + h > VIEW.h - 12) y = Math.max(12, VIEW.h - h - 12);

  // 提示框要压在世界之上、必须够实：用最不透明的一档
  panelPlate(ctx, x, y, w, h, { alpha: UI_SKIN.panelAStrong });

  ctx.textAlign = 'left';
  ctx.fillStyle = m.tier >= 3 ? UI_SKIN.hi : UI_SKIN.textStrong;
  ctx.font = `bold 14px ${FONT}`;
  // ⚠️ 2026-09-28：**灾害道具不追加档位名**。理由：道具的 `tier` 是"这套道具的第几档
  //    （1 虫 / 2 蛇 / 3 蛟）"，**不是**材料那 7 档阶梯（虫/次蛇/蛇/次蛟/蛟/次龙/龙）；
  //    而道具的档位**已经写在名字里**（避雷针·虫 / ·蛇 / ·蛟）。
  //    以前一律套 `TIER_NAME[m.tier]` → 悬停"避雷针·蛟"会显示"（蛇级）"，自相矛盾。
  const title = m.blockTool ? m.name : `${m.name}（${TIER_NAME[m.tier] || '?'}）`;
  ctx.fillText(title, x + 12, y + 24);

  const [, tagColor] = kindTag(m.kind);
  ctx.fillStyle = tagColor;
  ctx.font = `12px ${FONT}`;
  const line2 = m.kind === 'struct' ? '结构件 · 补漏位 · 完好可回收／带角标＝破损，取下即废 · 提供血量'
    : m.kind === 'func' ? '功能件 · 插槽位 · 可回收 · 不给血量'
      : '修复材料 · 不占面上的位置';
  ctx.fillText(line2, x + 12, y + 44);

  if (m.kind === 'repair') {
    const t2 = Math.round(m.repairUnits / (REPAIR.unitsPerHp[2] || 1));
    ctx.fillStyle = UI_SKIN.kindRepair;
    ctx.fillText(`修复量 ${m.repairUnits} · 用完自动消失`, x + 12, y + 64);
    ctx.fillStyle = UI_SKIN.textMid;
    ctx.fillText(`基础件 ${m.repairUnits} / 进阶件 ${t2} 点耐久`, x + 12, y + 84);
    return;
  }

  ctx.fillStyle = UI_SKIN.ok;
  ctx.fillText(m.durability > 0 ? `耐久 ${m.durability}（就是墙的血量）` : '不提供血量', x + 12, y + 64);

  // 6 个属性（高度是派生的，不在材料上）
  ctx.fillStyle = UI_SKIN.textMid;
  ctx.fillText(`强度 ${m.strength}   重量 ${m.weight}   绝缘性 ${m.insulation}`, x + 12, y + 84);
  ctx.fillText(`光滑度 ${m.smoothness}   气密性 ${m.seal}`, x + 12, y + 104);

  // 功能件里有"道具"和"增幅器"，它们的作用必须写清楚，否则玩家看不出区别
  if (m.blockTool) {
    const name = (DISASTERS[m.blockTool] && DISASTERS[m.blockTool].name) || m.blockTool;
    ctx.fillStyle = UI_SKIN.hi;
    ctx.fillText(`专治「${name}」：抵消 ${m.blockValue} 点（只算所装的那面）`, x + 12, y + 126);
  } else if (m.strengthBoost) {
    ctx.fillStyle = UI_SKIN.hi;
    ctx.fillText(`全栋强度 +${Math.round(m.strengthBoost * 100)}%`, x + 12, y + 126);
  } else if (m.damageReduce) {
    ctx.fillStyle = UI_SKIN.hi;
    ctx.fillText(`全栋受到的伤害 -${Math.round(m.damageReduce * 100)}%`, x + 12, y + 126);
  }
}

function drawDragGhost(ctx, s) {
  if (!s.drag) return;
  const m = MATERIALS[s.drag.mat];
  const size = 46;
  ctx.globalAlpha = 0.85;
  drawMaterialGlyph(ctx, s.drag.x - size / 2, s.drag.y - size / 2, size, size, s.drag.mat, { radius: 8 });
  ctx.globalAlpha = 1;
  ctx.strokeStyle = UI_SKIN.info;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#0d1117';
  ctx.font = `bold 12px ${FONT}`;
  ctx.fillText(m.name, s.drag.x, s.drag.y + 4);
  ctx.fillStyle = s.dragTarget ? (s.dragTarget.kind === 'trash' ? '#ff8a7a' : UI_SKIN.ok) : UI_SKIN.textStrong;
  ctx.font = `12px ${FONT}`;
  let sub;
  const t = s.dragTarget;
  if (!t) {
    sub = `${KIND_LABEL[m.kind]} · ${m.kind === 'repair'
      ? `可修 ${m.repairUnits}`
      : m.durability > 0 ? `耐久 ${m.durability}` : `强度 ${m.strength}`}`;
  } else if (t.kind === 'face') {
    sub = t.posIndex === -2 ? '修复材料不能贴'
      : t.posIndex < 0 ? '这个位置满了'
        : `松手 → ${s.shelter.face(t.faceId).name}${m.kind === 'struct' ? '补漏位' : '插槽位'}`;
  } else if (t.kind === 'trash') {
    sub = '松手 → 丢弃';
  } else if (t.kind === 'store') {
    sub = '松手 → 存入仓库';
  } else {
    sub = '松手 → 取出到背包';
  }
  ctx.fillText(sub, s.drag.x, s.drag.y + size / 2 + 18);
}

function drawBanner(ctx, s) {
  const b = s.banner;
  ctx.textAlign = 'center';
  panelPlate(ctx, VIEW.w / 2 - 320, 210, 640, 84, { cut: 10 });
  ctx.fillStyle = b.color || UI_SKIN.warn;
  ctx.font = `bold 26px ${FONT}`;
  ctx.fillText(b.title, VIEW.w / 2, 250);
  ctx.fillStyle = UI_SKIN.textStrong;
  ctx.font = `14px ${FONT}`;
  ctx.fillText(b.sub || '', VIEW.w / 2, 278);
}

/**
 * 结算面板 —— 通关与死亡共用，靠 endSummary.win 区分。
 * ⚠️ 底部必须是**可点的按钮**：微信小游戏在手机上按不了 R 键，
 *    以前这里只写"按 R 秒重开"，触屏玩家会卡死在结算页。
 */
function drawSummary(ctx, s) {
  const sum = s.endSummary;
  const total = s.director.elapsed;
  const endless = s.director.endless;
  const canvasHeight = typeof document !== 'undefined' ? document.getElementById('game')?.getBoundingClientRect().height : VIEW.h;
  const u = VIEW.h / (canvasHeight || VIEW.h), panelW = Math.min(680 * u, VIEW.w - 32 * u);

  // Summary geometry uses visible pixels so mobile text and hit targets stay readable.
  ctx.fillStyle = sum.win ? 'rgba(14,20,10,0.90)' : 'rgba(16,10,6,0.88)';
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  drawConsoleFrame(ctx, (VIEW.w - panelW) / 2, 20 * u, panelW, VIEW.h - 40 * u, 12 * u);
  drawEnamelPlate(ctx, VIEW.w / 2 - 120 * u, 30 * u, 240 * u, 44 * u, sum.win ? '#356b58' : '#744339');
  ctx.textAlign = 'center';

  ctx.fillStyle = UI_SKIN.textStrong;
  ctx.font = `bold ${26 * u}px ${FONT}`;
  ctx.fillText(sum.win ? '通关！' : '本局结束', VIEW.w / 2, 60 * u);

  ctx.fillStyle = UI_SKIN.textStrong;
  ctx.font = `bold ${16 * u}px ${FONT}`;
  ctx.fillText(
    sum.win ? `扛住了全部 ${sum.wave} 波灾害`
      : endless ? `无尽模式 · 撑到第 ${sum.wave} 波`
        : `撑到第 ${sum.wave} 波`,
    VIEW.w / 2, 94 * u);

  ctx.font = `${14 * u}px ${FONT}`;
  if (sum.win) {
    // 通关的"成绩"用庇护所剩余耐久 —— 它是这一局建造水平的总分
    const left = s.shelter.faces.reduce((a, f) => a + s.shelter.hpOf(f.id), 0);
    ctx.fillStyle = UI_SKIN.ok;
    ctx.fillText(`庇护所剩余耐久 ${Math.round(left)}`, VIEW.w / 2, 116 * u);
  } else {
    ctx.fillStyle = UI_SKIN.warn;
    let cause = `死因：${sum.cause}`;
    while (ctx.measureText(cause).width > panelW - 40 * u && cause.length > 2) cause = cause.slice(0, -2) + '…';
    ctx.fillText(cause, VIEW.w / 2, 116 * u);
  }

  ctx.font = `${14 * u}px ${FONT}`;
  ctx.fillStyle = UI_SKIN.textMid;
  ctx.fillText(`本局 ${total.toFixed(1)} 秒 · ${s.speed} 倍速`, VIEW.w / 2, 132 * u);

  // 逐波明细。无尽模式可以无限长，所以只显示最近 MAX_ROWS 波（再多会压到按钮上）
  const rows = s.director.waveStats;
  const MAX_ROWS = Math.min(12, Math.max(0, Math.floor((endButtonRect(0, sum.win ? 2 : 1).y - 190 * u) / (20 * u))));
  const rowLimit = rows.length > MAX_ROWS ? Math.max(0, MAX_ROWS - 1) : MAX_ROWS;
  const shown = rowLimit ? rows.slice(-rowLimit) : [];
  const x0 = (VIEW.w - panelW) / 2 + 20 * u, column = (panelW - 40 * u) / 6;
  let y = 166 * u;
  ctx.textAlign = 'left';
  ctx.font = `${13 * u}px ${FONT}`;
  ctx.fillStyle = UI_SKIN.info;
  if (MAX_ROWS > 0) {
    ctx.fillText('波次', x0, y);
    ctx.fillText('准备', x0 + column, y);
    ctx.fillText('灾害', x0 + column * 2, y);
    ctx.fillText('耗时', x0 + column * 3, y);
    ctx.fillText('受损', x0 + column * 4, y);
    ctx.fillText('累计', x0 + column * 5, y);
    y += 8 * u;
    ctx.fillStyle = withA(UI_SKIN.textMid, 0.20);
    ctx.fillRect(x0, y, panelW - 40 * u, u);
    y += 20 * u;

    // 累计要从被省略掉的那几波开始算，否则"累计"会从 0 重启
    let acc = rows.slice(0, rows.length - shown.length).reduce((a, r) => a + r.totalSeconds, 0);
    if (rows.length > shown.length) {
      ctx.fillStyle = UI_SKIN.textDim;
      ctx.fillText(`…前 ${rows.length - shown.length} 波已省略`, x0, y);
      y += 20 * u;
    }
    for (const r of shown) {
      acc += r.totalSeconds;
      ctx.fillStyle = r.wave % 2 ? '#ffffff09' : '#00000020'; ctx.fillRect(x0 - 4 * u, y - 15 * u, panelW - 32 * u, 20 * u);
      ctx.fillStyle = UI_SKIN.textStrong;
      ctx.fillText(`${r.wave}`, x0, y);
      ctx.fillText(`${r.prepSeconds}s`, x0 + column, y);
      ctx.fillText(`${r.disasterSeconds}s`, x0 + column * 2, y);
      ctx.fillText(`${r.totalSeconds}s`, x0 + column * 3, y);
      ctx.fillText(`${r.damage}`, x0 + column * 4, y);
      ctx.fillText(`${acc.toFixed(0)}s`, x0 + column * 5, y);
      y += 20 * u;
    }
  }

  // 底部按钮
  const n = sum.win ? 2 : 1;
  const labels = sum.win ? ['重新开始', '无尽挑战'] : ['再来一局'];
  const primary = sum.win ? [false, true] : [true];
  for (let i = 0; i < n; i++) {
    const r = endButtonRect(i, n);
    drawEnamelPlate(ctx, r.x, r.y, r.w, r.h, primary[i] ? '#356b58' : '#47554d', '#a8b292');
    ctx.fillStyle = UI_SKIN.textStrong;
    ctx.font = `bold ${16 * u}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(labels[i], r.x + r.w / 2, r.y + r.h / 2 + 6 * u);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = UI_SKIN.textDim;
  ctx.font = `${12 * u}px ${FONT}`;
  ctx.fillText(`目标：撑过 ${WIN_WAVE} 波`, VIEW.w / 2, VIEW.h - 10 * u);
}
