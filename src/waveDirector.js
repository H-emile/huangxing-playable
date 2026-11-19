// 波次调度 + 灾害结算 —— 纯逻辑，不依赖渲染
// 这是游戏的心脏。可以脱离引擎单独跑（见 tools/simulate.js）

import { DISASTERS, waveConfig, SHELTER, RULES, WIN_WAVE } from './config.js';

export const Phase = {
  PREP: 'prep',         // 准备期
  DISASTER: 'disaster', // 灾害期
  WIN: 'win',           // 撑过了 WIN_WAVE 波 —— 通关（2026-09-26 用户要求"抗住则胜利"）
  DEAD: 'dead',         // 本局结束
};

export class WaveDirector {
  constructor(shelter, rng = Math.random) {
    this.shelter = shelter;
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.wave = 0;
    this.phase = Phase.PREP;
    this.timer = 0;
    // ⚠️ 2026-09-29：准备期"等玩家出门"的冻结标记（见 releasePrep）。
    //    初值 false —— 真正的第 1 波会走 startPrep()，那里会置 true。
    this.prepFrozen = false;
    this.active = [];      // 本波启用的灾害定义
    this.nextFire = [];    // 每种灾害的下一次触发倒计时
    this.events = [];      // 最近一帧的打击事件
    this.waveStats = [];   // 每波统计
    this.elapsed = 0;      // 本局总时长（秒）
    this.currentWaveDamage = 0;
    this.currentWavePlayerDamage = 0;   // 本波打在**主角**身上的伤害（和"墙受损"分开统计）
    this.endless = false;  // 胜利后玩家选"继续挑战" → 波次无限外推、不再有胜利
    this._waveStartedAt = 0;
    this.startPrep();
  }

  get cfg() {
    return waveConfig(this.wave);
  }

  /** 本波灾害名列表（供 HUD 预告，也顺便验证"预兆"必要性） */
  get upcomingNames() {
    return this.cfg.disasters.map((id) => DISASTERS[id].name);
  }

  startPrep() {
    this.wave += 1;
    this.phase = Phase.PREP;
    this.active = [];
    this.nextFire = [];
    this.timer = this.cfg.prep;
    // ⚠️ 2026-09-29：准备期**默认冻结** —— 要等玩家离开庇护所才开始倒计时（用户要求）。
    //    唯一解冻入口是 releasePrep()，由 main.js 在"出门 / 挖到料"时调。
    this.prepFrozen = true;
    this.currentWaveDamage = 0;
    this.currentWavePlayerDamage = 0;
    this._waveStartedAt = this.elapsed;
    // 本波的"破损掉落"上限（前 8 波 1 块 / 第 9 波起 2 块，同一面每波）。
    // ⚠️ 放在这里而不是 main.js —— 模拟器和真游戏共用 WaveDirector，规则才一致。
    this.shelter.setWaveDropCap(this.wave);
  }

  /** 提前开波。返回提前掉的秒数（0 表示当前不在准备期） */
  skipPrep() {
    // ⚠️ 2026-09-29：**冻结期（还没出门）不许提前开波**。用户定："冻结期停用"。
    //    理由：冻结时 `timer` 一直是满额，而提前开波的奖励是按剩余时间换材料的 →
    //    不挡的话"白等"反而变成了"满额奖励"，把"时间换材料"这条设计直接架空。
    if (this.phase !== Phase.PREP || this.prepFrozen) return 0;
    const saved = this.timer;
    this.startDisaster();
    return Math.round(saved * 10) / 10;
  }

  /**
   * 解除准备期的冻结。**由 main.js 在两种情况下调**（用户 2026-09-29 定）：
   *   · 玩家离开了庇护所范围（`|x - cx| > SHELTER.shelterRange`）
   *   · 或者挖到了本波的料（兜底 —— 万一有料堆生成在近处，也不能白挖）
   * ⚠️ **一旦解除就不再冻结**（之后回庇护所也不停）—— 否则"反复进出庇护所"就能无限拖时间。
   * @returns {boolean} 是否真的解除了（不在准备期 / 已经在计时 → false）
   */
  releasePrep() {
    if (this.phase !== Phase.PREP || !this.prepFrozen) return false;
    this.prepFrozen = false;
    return true;
  }

  /** 准备期是否还在"等玩家出门"（HUD 与合成计时都用它） */
  get prepWaiting() {
    return this.phase === Phase.PREP && this.prepFrozen;
  }

  startDisaster() {
    const cfg = this.cfg;
    this.phase = Phase.DISASTER;
    this.timer = cfg.disaster;
    this.active = cfg.disasters.map((id) => DISASTERS[id]);
    this.nextFire = this.active.map((d) => Math.min(d.interval, cfg.disaster));
  }

  /**
   * 推进 dt 秒。
   * @param {number} dt
   * @param {boolean} playerOutside 主角是否在庇护所范围之外（**只影响主角侧**：
   *        破墙／毒雾在外面吃全额；雷电／光束屋内外都使用同一份减伤后预算）
   * @param {Function|null} dodge 地形躲避判定，见 fire()
   * @returns {Array} 本帧发生的打击事件
   */
  update(dt, playerOutside = false, dodge = null) {
    const out = [];
    // 已经结束的两种状态都冻结：通关了 / 死了，都不该再推进时间或结算打击
    if (this.phase === Phase.DEAD || this.phase === Phase.WIN) return out;

    this.elapsed += dt;
    // ⚠️ 2026-09-29：准备期"等出门"期间**倒计时不走** —— 玩家可以在庇护所里从容检查材料、
    //    分配合成（合成倒计时也在 main.js 里共用这个开关，见 `prepWaiting`）。
    //    ⚠️ 只冻 `timer`、不冻 `elapsed`：elapsed 是真实经过时间（统计用），
    //       而且灾害期本来就不受这个冻结影响。
    if (!this.prepWaiting) this.timer -= dt;

    if (this.phase === Phase.DISASTER) {
      for (let i = 0; i < this.active.length; i++) {
        this.nextFire[i] -= dt;
        // 用 while 保证不会因为掉帧漏掉打击
        while (this.nextFire[i] <= 0 && this.timer > 0) {
          out.push(this.fire(this.active[i], playerOutside, dodge));
          this.nextFire[i] += this.active[i].interval;
        }
      }
    }

    if (this.timer <= 0) {
      if (this.phase === Phase.PREP) {
        this.startDisaster();
      } else {
        this.endWave();
      }
    }
    return out;
  }

  /**
   * 单次打击结算 —— 7 种灾害**共用同一条管线**（2026-09-26 用户重构）。
   *
   *   ① raw = 基础伤害 × 波次强度 **+ 灾害自己的代价项 `penalty`**
   *   ② 阶段1「功能材料」：对应道具的抵消值（避雷针治雷电 / 反光镜治光束 / 净化器治毒雾 /
   *      平衡架治地陷 / 固定索治龙卷风 / 武器治兽潮）
   *   ③ 阶段2「结构材料」：按 disaster.resist 算墙属性抵消值
   *   ④ **怎么把抵消值变成减伤** —— 2026-09-26 用户要求**分两段**（见 config.js 的 RULES）：
   *      · 第 1~8 波（`proportionalFromWave` 之前）「**减法 + 悬崖**」：
   *        剩余 = 原始伤害 − 抵消值；剩余 ≤ 0 → **完全拦住**（主角 0 伤害，墙也**不掉耐久**）
   *      · 第 9~12 波「**按比例**」：减伤率 = min(上限, 抵消值 / 原始伤害)，
   *        剩余 = 原始伤害 × (1 − 减伤率) → 抵消值再高也**至少漏那 10%**，血量被稳定地磨
   *        （用户原话："前 8 波为完全免伤，后 4 波按比例减伤"。原因：全用悬崖式的话
   *          "顶配勉强通关"在数值上不存在 —— 实测 ×0.92 满血通关、×0.96 直接死，
   *          中间 4% 的区间里没有"剩几十血"这种状态）
   *   ⑤ **庇护所侧**：不管主角在哪，庇护所都照打 —— 2026-09-26 用户**取消了"安全区"规则**
   *      （原来是"主角在外面 → 庇护所一点血不掉"，现在改成"同时攻击主人公和庇护所"）。
   *      · split（雷电/光束）→ 剩余预算按全屋有效高度分摊；墙体不足的份额转给人物
   *      · pierce（毒雾）→ 不消耗墙耐久
   *      · breach（陨石/龙卷风/地陷/兽潮）→ 平摊到目标面：活着的扣耐久，
   *        已经破掉的那一份**全额漏给主角**
   *   ⑥ **主角侧**（split 已按上述预算分配；以下适用于其他灾害）：两种处境差别很大 ——
   *      · 在庇护所里 → 只吃"穿墙漏过来的"和"破面漏过来的"（庇护所的属性在保护你）
   *      · 在外面探索 → 吃**全额原始伤害**，而且**庇护所的属性救不了你**（人不在墙后面）。
   *        唯一能救你的是**地形**：陨石可以躲到岩棚下、地陷可以站高处，
   *        其余五种躲不了（2026-09-26 用户要求）。
   *
   * @param {object} d 灾害定义
   * @param {boolean} playerOutside 主角是否在庇护所范围之外
   * @param {Function|null} dodge (disaster) => 'occluder' | 'highground' | null
   *        地形躲避判定，由 main 注入（模拟器不传 = 永远躲不掉）
   */
  fire(d, playerOutside = false, dodge = null) {
    const intensity = this.cfg.intensity || 1;
    const base = d.damage * intensity;

    // ① 原始伤害不随高度放大；高度只决定雷电／光束的分摊比例。
    let raw = base;

    // ①' 代价项：灾害声明的 penalty **加**到原始伤害上（地陷：庇护所总重量 → 越重打得越疼）。
    //     2026-09-26 用户定："重量改成真正的代价轴"，见 config.js 的 DISASTERS.sinkhole。
    const penalty = this.shelter.penaltyValueFor(d);
    raw += penalty;

    // ② 阶段1「功能材料」抵消 + ③ 阶段2「结构材料」抵消（两个都算出来，后面按段选算法）
    const toolBlock = this.shelter.toolBlockOf(d.faces, d.id);
    const wallBlock = this.shelter.blockValueFor(d, d.faces);
    const blockTotal = toolBlock + wallBlock;

    // ④ 把抵消值换算成"实际漏过去多少" —— 按波次分段（见函数头的 ④ 与 config 的 RULES）
    let left;
    if (this.wave >= RULES.proportionalFromWave) {
      // 后期「按比例」：减伤率 = 抵消值 / 原始伤害，封顶 lateReduceCap。
      // ⚠️ 因为是封顶的，left **恒 > 0** → 后期永远不会出现"完全拦住"（这是刻意的：
      //    用户要"后 4 波按比例减伤"，且"把勉强挪到墙上"）。
      const reduce = Math.min(RULES.lateReduceCap, blockTotal / raw);
      left = raw * (1 - reduce) * this.shelter.damageScale;
    } else {
      // 前期「减法 + 悬崖」：道具先减，再减墙属性；减光就是完全免伤（墙也不掉耐久）
      left = (raw - toolBlock) * this.shelter.damageScale - wallBlock;
    }

    const ev = {
      disaster: d.id, name: d.name, model: d.model,
      raw: Math.round(raw * 10) / 10,
      penalty: Math.round(penalty * 10) / 10,     // 代价项（只有地陷有，>0 表示"越重越疼"生效中）
      toolBlock: Math.round(toolBlock * 10) / 10,
      wallBlock: Math.round(wallBlock * 10) / 10,
      lateMode: this.wave >= RULES.proportionalFromWave,   // true = 走的是"按比例减伤"
      hitPlayer: false, blocked: false, dodged: null,
      playerDamage: 0, damage: 0, lost: [], deadFaces: [], brokenFaces: [],
    };

    // 同一次打击的固定预算：屋内外共用，不再额外叠加一次屋外人伤。
    if (d.model === 'split') {
      const height = Math.max(SHELTER.heightMin, Math.min(SHELTER.heightMax, this.shelter.height));
      ev.playerRatio = 0.3 + 0.4 * (height - SHELTER.heightMin) / (SHELTER.heightMax - SHELTER.heightMin);
      ev.damageBudget = Math.max(0, left);
      if (left <= 0) ev.blocked = true;
      else {
        const share = left * (1 - ev.playerRatio) / d.faces.length;
        ev.brokenFaces = d.faces.filter((id) => !this.shelter.hasStruct(id));
        for (const id of d.faces) {
          // 随机掉料会额外损失整块耐久，此模型只扣分摊预算内的耐久。
          const res = this.shelter.damageFace(id, share, false);
          ev.damage += res.dealt;
          ev.lost.push(...res.lost);
          if (res.dead) ev.deadFaces.push(id);
        }
        for (const id of new Set(ev.brokenFaces.concat(ev.deadFaces))) {
          const knocked = this.shelter.knockExposedFunc(id);
          if (knocked) ev.lost.push({ mat: knocked, why: 'exposed', faceId: id });
        }
        // 墙已破或这一击耐久不足，没承受的份额转给人物，保留完整精度。
        ev.playerDamage = Math.max(0, left - ev.damage);
        ev.hitPlayer = playerOutside && ev.playerDamage > 0;
      }
      this.currentWaveDamage += ev.damage;
      this.currentWavePlayerDamage += ev.playerDamage;
      return ev;
    }

    let leak = 0;   // "已经破掉的那些面"漏给主角的那一份（只在庇护所里才轮到主角吃）

    // ---------- ④ 庇护所侧 ----------
    if (left <= 0) {
      // 完全拦住 —— 悬崖式：主角不减血，墙也不掉耐久
      ev.blocked = true;
    } else if (d.model === 'pierce') {
      // 穿墙类不消耗墙耐久，庇护所这边没有别的后果
    } else {
      const alive = d.faces.filter((f) => this.shelter.hasStruct(f));
      const broken = d.faces.filter((f) => !this.shelter.hasStruct(f));
      ev.brokenFaces = broken;
      const perFace = left / d.faces.length;
      leak = perFace * broken.length;

      if (alive.length) {
        const res = this.shelter.hitFaces(alive, perFace * alive.length);
        ev.damage = res.damage;
        ev.lost = res.lost;
        ev.deadFaces = res.deadFaces;
      }

      // 破了的面：功能件有概率被打飞
      for (const f of broken.concat(ev.deadFaces)) {
        const knocked = this.shelter.knockExposedFunc(f);
        if (knocked) ev.lost.push({ mat: knocked, why: 'exposed' });
      }

      // 地陷专属：地板彻底坏了之后，每一击还会**连带**伤其他墙
      if (d.onBreach === 'player_and_walls'
          && (broken.includes('base') || ev.deadFaces.includes('base'))) {
        const others = this.shelter.faces
          .map((f) => f.id)
          .filter((id) => id !== 'base' && this.shelter.hasStruct(id));
        if (others.length) {
          const splash = this.shelter.hitFaces(others, left * (d.breachSplash || 0.5));
          ev.damage = Math.round((ev.damage + splash.damage) * 10) / 10;
          ev.lost.push(...splash.lost);
          ev.deadFaces.push(...splash.deadFaces);
        }
      }
      this.currentWaveDamage += ev.damage;
    }

    // ---------- ⑤ 主角侧 ----------
    if (playerOutside) {
      // 在外面：庇护所救不了你（人不在墙后面），吃全额。
      // 只有"能被地形躲掉"的灾害才免伤 —— 陨石躲岩棚下、地陷站高处，其余五种躲不了。
      const saved = dodge ? dodge(d) : null;
      if (saved) {
        ev.dodged = saved;
      } else {
        ev.hitPlayer = true;
        ev.playerDamage = Math.round(base * RULES.outsidePlayerDamageScale * 10) / 10;
        this.currentWavePlayerDamage += ev.playerDamage;
      }
      return ev;
    }

    // 在庇护所里：完全拦住就是 0；否则
    //   pierce → 没抵消完的那部分穿墙打主角
    //   breach → 只有"已经破掉的那些面"的那一份漏过来
    if (left > 0) {
      const dmg = d.model === 'pierce' ? left : leak;
      if (dmg > 0) {
        ev.playerDamage = Math.round(dmg * 10) / 10;
        this.currentWavePlayerDamage += dmg;
      }
    }
    return ev;
  }

  endWave() {
    this.waveStats.push({
      wave: this.wave,
      prepSeconds: this.cfg.prep,
      disasterSeconds: this.cfg.disaster,
      totalSeconds: Math.round((this.elapsed - this._waveStartedAt) * 10) / 10,
      damage: Math.round(this.currentWaveDamage * 10) / 10,
      playerDamage: Math.round(this.currentWavePlayerDamage * 10) / 10,
    });
    this.shelter.resetDecay();  // 裂纹愈合，耐久不恢复

    // 撑过了 WIN_WAVE 波 → 通关。这是本局唯一的"好结局"（2026-09-26 用户要求）
    // ⚠️ 无尽模式下不再判胜利，否则第 13 波结束会立刻又"通关"一次。
    if (!this.endless && this.wave >= WIN_WAVE) {
      this.phase = Phase.WIN;
      return;
    }
    this.startPrep();
  }

  /** 胜利后玩家选"继续挑战" → 波次无限外推，不再有终点 */
  enterEndless() {
    this.endless = true;
    this.startPrep();
  }

  die() {
    this.phase = Phase.DEAD;
  }
}
