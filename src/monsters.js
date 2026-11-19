// 废墟怪物 —— 不能打，只能躲
// 它是"探索中会死"的主要来源，只在深区/中区出没（越远越危险）
//
// 2026-09-25 新增：**会被"引怪型"废墟的挖掘声吸引**。
// 这让风险第一次落在"挖掘"这个核心动作上（原先危险全在"路上"）。
//
// ⚠️ 2026-09-27：**分成地面 / 地下两套**（用户选"分清地面、地下"）。
//    做法照抄 world.js 的 `setLayer`：本类持有两套名单，用**一个指针**指向当前层 ——
//    于是 update / attract / touching / nearestDistance / 渲染**全都不用改**，
//    它们读的本来就是"当前生效的那份名单"。

import { MONSTERS, WORLD, LURE, SIEGE } from './config.js';
import { terrainY } from './world.js';   // ← 2026-09-29 加：判定"玩家离地多高"要用地形高度

/**
 * 玩家脚底比"脚下地形"高出不超过 `reachY` → 这一层的怪够得着。
 *
 * ⚠️ 为什么用"离地高度"而不是"怪物的 y"：怪物是**纯一维**的（只有 x，贴 `terrainY` 走，
 *    没有平台概念，见 config 的 `PLATFORMS` 注释），它压根没有 y 字段。
 * ⚠️ 判据只用**玩家自己脚下的地形**：怪与玩家水平距离 < contactRadius(34)，
 *    这么短的距离内地形是连续的，两者的脚下高度可以认为是同一个。
 * ⚠️ 跳跃最高只有 63.8 < `reachY` 70，所以**跳起来照样被咬**（用户 2026-09-29 定："跳只用来跨地形"）。
 */
function canReach(playerY, playerX, reachY) {
  return playerY >= terrainY(playerX) - reachY;
}

/** 地面这一套的完整数值（地下只覆盖它改动的字段，其余继承这里） */
const GROUND = {
  speed: MONSTERS.speed,
  damagePerSec: MONSTERS.damagePerSec,
  contactRadius: MONSTERS.contactRadius,
  attackRange: MONSTERS.attackRange,       // ⚠️ 新加的字段**必须列进这张白名单** ——
  attackSeconds: MONSTERS.attackSeconds,   //    `profile` 是显式挑字段拼的，漏了就是 undefined
  reachY: MONSTERS.reachY,                 //    （`|dx| < undefined` 恒 false = 攻击状态静默不生效）
  warnRadius: MONSTERS.warnRadius,
  spawns: MONSTERS.spawns,
};
const UNDER = { ...GROUND, ...(MONSTERS.under || {}) };

export class Monster {
  constructor(spawn, profile) {
    this.profile = profile;   // ← 速度/接触半径/伤害都跟着"层"走，不在别处读全局
    this.homeX = spawn.home;
    this.range = spawn.range;
    this.x = spawn.home;
    this.dir = 1;
    this.lureX = null;   // 被吸引时奔向的目标
    this.lureT = 0;      // 还剩多少秒被吸引
    // 攻击动画已经播了多少秒（0 = 没在攻击，渲染据此选"走路帧 / 挥拳帧"）。
    // ⚠️ 它是**纯表现**：不参与任何伤害计算（见 `_attack`）。
    this.atkT = 0;
  }

  get left() { return this.homeX - this.range; }
  get right() { return this.homeX + this.range; }

  /** 听到挖掘声（在半径内才理会）。返回是否被吸引 */
  attract(soundX, radius) {
    if (Math.abs(this.x - soundX) > radius) return false;
    this.lureX = soundX;
    this.lureT = Math.max(LURE.seconds, Math.abs(this.x - soundX) / (this.profile.speed * LURE.speedMult) + LURE.seconds);
    return true;
  }

  /**
   * 攻击状态（2026-10-05 用户："把怪物吸引过来后的怪物攻击动画"）。
   *
   * **纯表现** —— 只驱动"挥拳"那条动画，**不碰伤害**（伤害仍是 `touching()` 的接触持续掉血）。
   * 触发：与玩家的水平距离 < `profile.attackRange`(56) **且够得着**（`canReach`，免得隔着岩桥空挥）。
   * ⚠️ 在范围内**循环播**（一轮 `profile.attackSeconds` = 1 秒），一离开就回到走路帧。
   * ⚠️ 为什么需要"够得着"这一条：它和 `touching()` 同一套判据 —— 玩家站在上层岩桥/石台上时，
   *    正下方的怪不该对着空气挥拳（本项目 2026-09-29 修过一次"隔层被咬"，别再开一条反向的口子）。
   * ⚠️ `playerX === undefined`（老的调用方 / 纯逻辑测试）→ 直接不动 `atkT`，保持走路。
   */
  _attack(dt, playerX, playerY) {
    if (playerX === undefined) return;
    const near = Math.abs(this.x - playerX) < this.profile.attackRange
      && canReach(playerY, playerX, this.profile.reachY);
    if (!near) { this.atkT = 0; return; }
    this.atkT += dt;
    if (this.atkT >= this.profile.attackSeconds) this.atkT -= this.profile.attackSeconds;
  }

  update(dt, playerX, playerY) {
    this._attack(dt, playerX, playerY);
    if (this.lureT > 0) {
      // 被吸引：脱离巡逻区间，直奔声源。
      // 速度 ×1.35 —— 明显更快，但仍慢于主角的 150，所以还跑得掉。
      this.lureT -= dt;
      const d = this.lureX - this.x;
      if (Math.abs(d) < 6) { this.lureT = 0; return; }
      this.dir = d > 0 ? 1 : -1;
      this.x += this.dir * this.profile.speed * LURE.speedMult * dt;
      return;
    }
    // 没被吸引：先走回自己的巡逻区间，再在区间内来回
    if (this.x < this.left || this.x > this.right) {
      this.dir = this.x < this.left ? 1 : -1;
      this.x += this.dir * this.profile.speed * dt;
      return;
    }
    this.x += this.dir * this.profile.speed * dt;
    if (this.x < this.left) { this.x = this.left; this.dir = 1; }
    if (this.x > this.right) { this.x = this.right; this.dir = -1; }
  }

  /**
   * 是否正在接触玩家。
   * ⚠️ 2026-09-29 加**高度判定**：原来只比 `|Δx|`、完全不看 y → 玩家站在上层岩桥/石台上时，
   *    正下方的怪也能咬到他（"我在高空，血却在掉"，只能当成 bug）。判据见 `canReach`。
   */
  touching(playerX, playerY) {
    if (Math.abs(this.x - playerX) >= this.profile.contactRadius) return false;
    return canReach(playerY, playerX, this.profile.reachY);
  }

  /** 与玩家的距离（用于预警显示） */
  distanceTo(playerX) {
    return Math.abs(this.x - playerX);
  }
}

/**
 * 生成**某一层**的怪物列表。
 * ⚠️ `MONSTERS.enabled` 关掉时返回**空列表** —— 这是唯一的开关点：
 *    列表一空，`update` 不掉血、`attract` 不引怪、`nearestDistance` 返回 Infinity
 *    （HUD 不报警）、渲染也不画。所以"关掉怪物"只需要改 config 的一个字段。
 */
function spawnAll(profile) {
  return MONSTERS.enabled ? profile.spawns.map((s) => new Monster(s, profile)) : [];
}

export class MonsterPack {
  constructor() {
    this.profiles = { ground: GROUND, under: UNDER };
    this.layer = 'ground';
    this.byLayer = { ground: [], under: [] };
    this.list = this.byLayer.ground;
    this.contactTimer = 0;
    this.reset();
  }

  /**
   * 切"当前生效的层"。⚠️ 与 `world.js` 的 `setLayer` 是配套的，**必须一起调** ——
   *    否则会出现"人在地下、被地面那套怪咬"这种错位（跑得掉、查不出来）。
   *    唯一入口是 main.js 的 `switchLayer()`。
   */
  setLayer(name) {
    this.layer = name === 'under' ? 'under' : 'ground';
    this.list = this.byLayer[this.layer];
  }

  /** 当前层的数值（速度/伤害/接触半径/预警半径） */
  get profile() { return this.profiles[this.layer]; }

  /** 当前层的预警半径（渲染与 HUD 用 —— 别再去读全局的 MONSTERS.warnRadius） */
  get warnRadius() { return this.profile.warnRadius; }

  reset() {
    this.byLayer = { ground: spawnAll(GROUND), under: spawnAll(UNDER) };
    this.list = this.byLayer[this.layer];   // 保持当前层
    this.contactTimer = 0;
  }

  /** 挖掘声：把 radius 内的怪物吸引过来，返回被吸引的只数（只算**当前层**的） */
  attract(soundX, radius) {
    let n = 0;
    for (const m of this.list) if (m.attract(soundX, radius)) n += 1;
    if (!n && this.list.length) {
      const nearest = this.list.reduce((a, b) => Math.abs(a.x - soundX) <= Math.abs(b.x - soundX) ? a : b);
      nearest.attract(soundX, Infinity);
      n = 1;
    }
    return n;
  }

  /** 有没有怪物正在被吸引（HUD 提示用） */
  get luredCount() {
    return this.list.filter((m) => m.lureT > 0).length;
  }

  /**
   * 推进 dt，返回本帧应该对主角造成的伤害
   * 用"持续接触伤害"而不是"每一次碰撞一次伤害"，避免高帧率下被瞬秒
   */
  update(dt, playerX, playerY, playerDead) {
    // ⚠️ 把玩家位置传进每只怪 —— 攻击状态要用（纯表现，不影响下面的伤害计算）
    for (const m of this.list) m.update(dt, playerX, playerY);
    if (playerDead) return 0;
    // 玩家在高处（岩桥/石台）→ 这一层的怪一只都够不着，连循环都省了
    if (!canReach(playerY, playerX, this.profile.reachY)) return 0;

    let hurt = 0;
    for (const m of this.list) {
      if (m.touching(playerX, playerY)) hurt += this.profile.damagePerSec * dt;
    }
    return hurt;
  }

  /**
   * 最近的怪物距玩家多远（HUD 预警用）。
   * ⚠️ 2026-09-29：**够不着的怪不算威胁** → 返回 Infinity，否则玩家站在岩桥上会看到
   *    一直响的"怪物很近"预警，而实际上咬不到（修了伤害却留个假警报，比不修还糟）。
   */
  nearestDistance(playerX, playerY) {
    if (!canReach(playerY, playerX, this.profile.reachY)) return Infinity;
    let best = Infinity;
    for (const m of this.list) best = Math.min(best, m.distanceTo(playerX));
    return best;
  }

  /** 是否有怪物正在接触玩家（渲染提示"被怪物咬住！"用） */
  isTouching(playerX, playerY) {
    if (!canReach(playerY, playerX, this.profile.reachY)) return false;
    return this.list.some((m) => m.touching(playerX, playerY));
  }

  clampAll() {
    for (const m of this.list) {
      m.x = Math.max(20, Math.min(WORLD.width - 20, m.x));
    }
  }
}

// ============================================================
// 兽潮围攻（2026-10-04）—— `beasts` 灾害的**专职表现**
// ============================================================
// 用户原话："兽潮改为怪物围攻"。背景：`beasts` 原来是**纯抽象**的 —— 每 2.8s 按门的公式扣一次血，
//   画面上除了全屏染色什么都没有，所以"兽潮"这个名字一直是空的（也正因如此，
//   素材清单里那张 `fx_beasts` 没必要出：**用游戏里真的怪物来表现围攻**）。
//
// ⚠️⚠️ 它和 `MonsterPack` 是**两套，别合并**：
//   · `MonsterPack` = **探索压力**：6 只、各有巡逻区间、参与引怪、地下另有一套、永远不靠近庇护所。
//   · `SiegePack`   = **灾害表现**：5 只、没有巡逻区间、目标就是门外那一点、灾害结束就撤。
//   合并会串味成"围攻怪被挖掘声引走"或"巡逻怪突然全跑去砸门"。
// ⚠️ **纯视觉**（用户 2026-10-04 定）：它**不掉门的血** —— 门的伤害仍走 `DISASTERS.beasts`
//   的老管线（interval 2.8 / damage 24），所以数值平衡一个字没动，`simulate.js` 也不用重跑
//   （它本来就不碰怪物）。但它**会咬玩家**（用户同日定），复用地面那套接触伤害。
// ⚠️ 只在**地面层**存在：庇护所只在地面，而灾害期地穴入口是关的（跑不到地下去）。
//   所以这里不做 `setLayer` —— 调用方按 `s.layer === 'ground'` 把关（见 main.js / render.js）。
// ⚠️ 它们不参与引怪（没有 `attract`）：围攻是灾害的一部分，不该被玩家的挖掘声改变行为。

/** 一只围攻怪：**没有巡逻区间**，只有一个"要走到哪"的目标点。 */
class Sieger {
  constructor(x, targetX) {
    this.x = x;
    this.targetX = targetX;
    // 攻击动画已播秒数（>0 = 出拳中）—— 与 `Monster` 同一口径，渲染同一个入口
    this.atkT = 0;
  }
  /** 朝目标点走（到了就停）。`speed` 由调用方给（撤离时想更快就传大一点）。 */
  step(dt, speed) {
    const d = this.targetX - this.x;
    if (Math.abs(d) <= 2) return;
    this.x += Math.sign(d) * speed * dt;
    if (Math.abs(this.targetX - this.x) < 2) this.x = this.targetX;
  }
  /** 到位了没 —— 用它判"站在门前砸门"那个攻击状态（见 `SiegePack.update`） */
  get arrived() { return Math.abs(this.targetX - this.x) <= 2; }
}

export class SiegePack {
  constructor() {
    this.list = [];          // 非空 = 正在围攻（渲染与伤害都看这个）
    this.leaving = false;    // 灾害已结束、正在撤离（这段时间还会咬人，但不该再"压上来"）
    this.leaveT = 0;
    this.profile = GROUND;   // 围攻只在地面发生 → 固定用地面那套数值
  }

  restore(data) {
    this.leaving = data.leaving;
    this.leaveT = data.leaveT;
    this.list = data.list.map((g) => Object.assign(new Sieger(g.x, g.targetX), g));
  }

  /** 灾害期开始：在门外聚一群。`doorOuterX` = 门的**外沿**世界 x（= `shelterRects().door.x`）。
   *  @param {() => number} [rng] 出发点抖动的随机源（默认 `Math.random`；传种子可复现） */
  start(doorOuterX, rng = Math.random) {
    if (this.list.length) return;          // 已经在围攻 → 不叠加（灾害可能连续几波都抽到 beasts）
    this.leaving = false;
    this.leaveT = 0;
    this.list = [];
    for (let i = 0; i < SIEGE.n; i++) {
      const d = SIEGE.gap[0] + rng() * (SIEGE.gap[1] - SIEGE.gap[0]);
      this.list.push(new Sieger(
        doorOuterX - d,
        // 到门前**逐只**错开（怪宽 30、没有碰撞，间隔小于 30 就会完全叠在一起看不见）
        doorOuterX - SIEGE.standoff - i * SIEGE.rank,
      ));
    }
  }

  /** 灾害期结束：改成"往左撤"，`SIEGE.leave` 秒后清空。 */
  end() {
    if (!this.list.length || this.leaving) return;
    this.leaving = true;
    this.leaveT = SIEGE.leave;
    for (const g of this.list) g.targetX = g.x - 420;
  }

  /** 推进 dt，返回本帧这群怪对主角造成的伤害（与 `MonsterPack.update` 同一套口径）。 */
  update(dt, playerX, playerY, playerDead) {
    if (!this.list.length) return 0;
    if (this.leaving) {
      this.leaveT -= dt;
      if (this.leaveT <= 0) { this.list = []; this.leaving = false; return 0; }
    }
    for (const g of this.list) g.step(dt, SIEGE.speed);
    // 攻击状态（2026-10-05 用户："把兽潮围攻怪也换成这套攻击动画"）—— 与巡逻怪**同一套**：
    // ⚠️ 但触发口多一个"**到位**"：它们的目标是**门**（不是玩家），而围攻期间玩家多半躲在屋里
    //    → 只按"够得着玩家"判的话，这套动画在整场围攻里**一次都不会播**（用户会以为没生效）。
    //    所以：**站在门前 = 砸门**（`arrived`）也算"在打" ✓ 读起来正是"它们在砸门"。
    // ⚠️ **纯表现**：不碰任何伤害 —— 门的伤害仍走 `DISASTERS.beasts` 那条老管线（interval/damage），
    //    玩家的仍走 `contactRadius`。撤离时 `targetX` 在 420px 外 → `arrived` 为假 → 自动回到走路帧 ✓。
    const reachP = canReach(playerY, playerX, this.profile.reachY);
    for (const g of this.list) {
      const acting = g.arrived || (reachP && Math.abs(g.x - playerX) < this.profile.attackRange);
      if (!acting) { g.atkT = 0; continue; }
      g.atkT += dt;
      if (g.atkT >= this.profile.attackSeconds) g.atkT -= this.profile.attackSeconds;
    }
    if (playerDead) return 0;
    if (!canReach(playerY, playerX, this.profile.reachY)) return 0;
    let hurt = 0;
    for (const g of this.list) {
      if (Math.abs(g.x - playerX) < this.profile.contactRadius) hurt += this.profile.damagePerSec * dt;
    }
    return hurt;
  }

  /** 有没有围攻怪正咬着玩家（渲染提示"被怪物咬住！"用） */
  isTouching(playerX, playerY) {
    if (!this.list.length) return false;
    if (!canReach(playerY, playerX, this.profile.reachY)) return false;
    return this.list.some((g) => Math.abs(g.x - playerX) < this.profile.contactRadius);
  }

  get warnRadius() { return this.profile.warnRadius; }
}
