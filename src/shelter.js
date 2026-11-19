// 庇护所模型 —— 纯逻辑，不依赖任何渲染或浏览器 API
// 可被 Node 直接 import（见 tools/simulate.js）
//
// 核心模型（2026-09-25 用户要求后定稿）：
//   每个面有 4+2 个位置，分两类：
//     · 补漏位 ×4（struct）—— 只能放结构件，**墙的血量就是这些结构件的耐久之和**
//     · 插槽位 ×2（func）  —— 只能放功能件，不提供血量，只给属性
//
//   "墙的血量要与修复材料一一对应"：
//     · 结构件的耐久（durability）= 它贡献的血量上限
//     · 受击时按各自**当前血量的占比平摊**（不是从左到右依次扣）
//     · 墙没彻底坏之前，所有结构件都不单独消失、属性是定值；整面墙彻底坏了才**一起失效**
//     · 耐久没满 → 出现裂痕、变暗，可以**长按修复**（消耗修复材料，越稀有越慢）
//     · 结构件全没了 = 0 血 = 伤害透传主角，且功能件暴露（有概率被打掉）
//     · 主动取下（2026-09-26 用户要求）：结构件**完好**（没挨过打）才能取回背包；
//       破损的取下即消失，想拿回来必须先用修复材料修满 —— 判定见 canRecoverAt()

import { SHELTER, SHELTER_SLOTS, MATERIALS, RULES, WEAR_DROP, REPAIR } from './config.js';

/** 一个新的空格位 */
function newSlot(kind) {
  return { kind, mat: null, hp: 0, maxHp: 0, decay: 0 };
}

export class ShelterModel {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.faces = SHELTER.faces.map((f) => {
      // ⚠️ 补漏位是**每面的运行时状态**（会随波次成长），不是配置里的固定值。
      //    起始值来自 SHELTER_SLOTS.startStruct，之后只能靠 expandFace() 加。
      const structSlots = SHELTER_SLOTS.startStruct;
      const positions = [];
      for (let i = 0; i < structSlots; i++) positions.push(newSlot('struct'));
      for (let i = 0; i < f.funcSlots; i++) positions.push(newSlot('func'));
      return { id: f.id, name: f.name, structSlots, funcSlots: f.funcSlots, positions };
    });
    // 还没放置出去的"扩展空位"额度：撑过一波发一个，玩家自己点墙上的「+」格花掉
    this.bonusSlots = 0;     // 手头还有几个没用
    this.bonusGranted = 0;   // 累计已发出几个（用来封顶）
    // 破损掉落（见 _rollWearDrops）。
    // ⚠️ 默认给 capEarly（1 块），**不能给 0、更不能留 undefined**：
    //    · 留 undefined → `undefined <= 0` 是 false，会绕过上限判断变成"无限掉"；
    //    · 给 0 → 机制被静默关掉：任何"reset() 之后没走 startPrep()"的路径
    //      （手动重置、临时测试、将来新加的入口）都会让这条规则**悄悄失效**。
    //      实测就踩到过：测试里 reset() 完直接打伤害，上限是 0，一块都没掉，
    //      看起来像"掉落逻辑没生效"。
    //    正常流程里 WaveDirector.startPrep() 每波都会把它设成正确的值。
    this.dropCap = WEAR_DROP.capEarly;
    this.dropsThisWave = {};
    // 仓库：庇护所自带，只在庇护所范围内可交互。
    // ⚠️ 2026-09-25 用户要求：**按三个类别分区存放**（修复材料 / 结构件 / 功能件，各 8 格）
    this.store = { repair: [], struct: [], func: [] };
  }

  // ---------- 格位成长（2026-09-26 用户要求） ----------

  /**
   * 撑过一波 → 发一个"扩展空位"额度。
   * 发到 `SHELTER_SLOTS.bonusTotal` 个之后不再发（用户："第 8 波灾难后就不给了"）。
   * @returns {boolean} 这次有没有真发出去
   */
  grantBonusSlot() {
    if (this.bonusGranted >= SHELTER_SLOTS.bonusTotal) return false;
    this.bonusGranted += 1;
    this.bonusSlots += 1;
    return true;
  }

  /**
   * 把 1 个额度花在这一面：该面**补漏位 +1**（永久）。插槽位不参与成长（用户决定）。
   *
   * ⚠️ 必须维持"补漏位在前、插槽位在后"这个不变式：world.js 的 facePositionRects
   *    按这个顺序生成格位，而 positionAt 又把格位下标**直接**映射到 positions[i]。
   *    顺序一乱，"点到的格子"和"看到的格子"就不是同一个了。
   *    所以这里不是简单 push，而是把两类拆开、加完再拼回去。
   * ⚠️ 副作用：该面的插槽位下标会整体 +1。调用方（main.js）必须清掉手上缓存的
   *    posIndex（s.press / s.dragTarget），否则会有一帧指到错的位置上。
   *
   * @returns {boolean} 有没有扩成功（没额度 = false）
   */
  expandFace(id) {
    if (this.bonusSlots <= 0) return false;
    const f = this.face(id);
    if (!f) return false;
    const structs = f.positions.filter((p) => p.kind === 'struct');
    const funcs = f.positions.filter((p) => p.kind === 'func');
    f.structSlots += 1;
    structs.push(newSlot('struct'));
    f.positions = [...structs, ...funcs];
    this.bonusSlots -= 1;
    return true;
  }

  // ---------- 仓库（按类别分区，数量不限） ----------

  get storeCount() {
    return this.store.repair.length + this.store.struct.length + this.store.func.length;
  }

  storeSpaceOf(kind) {
    return this.store[kind] ? Infinity : 0;
  }

  /** 存一件。放哪由材料自身的类别决定 —— 放不进别类的格子 */
  storeAdd(matId) {
    const kind = MATERIALS[matId] && MATERIALS[matId].kind;
    if (!kind || !this.store[kind]) return false;
    this.store[kind].push(matId);
    return true;
  }

  /** 按修复、结构、功能三类的实际长度平铺，供详情和拖放核对来源。 */
  storeAtFlat(i) {
    for (const kind of ['repair', 'struct', 'func']) {
      if (i < this.store[kind].length) return this.store[kind][i] || null;
      i -= this.store[kind].length;
    }
    return null;
  }

  /** 从仓库拿走一件（按 id 找，避免索引错位） */
  storeRemoveOne(matId) {
    const kind = MATERIALS[matId] && MATERIALS[matId].kind;
    if (!kind || !this.store[kind]) return false;
    const i = this.store[kind].indexOf(matId);
    if (i < 0) return false;
    this.store[kind].splice(i, 1);
    return true;
  }

  face(id) {
    return this.faces.find((f) => f.id === id);
  }

  matsOf(id) {
    return this.face(id).positions.map((p) => p.mat);
  }

  freeSlots(id, kind) {
    return this.face(id).positions.filter((p) => p.kind === kind && p.mat === null).length;
  }

  /** 墙的血量 = 所有位置的耐久之和（功能件耐久为 0，所以实际只有结构件贡献） */
  hpOf(id) {
    return this.face(id).positions.reduce((s, p) => s + p.hp, 0);
  }

  maxHpOf(id) {
    return this.face(id).positions.reduce((s, p) => s + p.maxHp, 0);
  }

  /** 该面还有没有活着的结构件（没有 = 已打穿） */
  hasStruct(id) {
    return this.face(id).positions.some((p) => p.kind === 'struct' && p.hp > 0);
  }

  /**
   * 整面墙的血量比例（0..1）—— 血条按这个画成**一条**。
   * ⚠️ 2026-09-26 用户要求"整面墙是一体的"之后，所有结构件是**同步掉血**的，
   *    所以不再有"每个结构件各占 1/N"的分段显示 —— 分段会让玩家以为它们会分批死。
   */
  structRatio(id) {
    const max = this.maxHpOf(id);
    return max > 0 ? this.hpOf(id) / max : 0;
  }

  /** 保留给旧调用方（逐位置的耐久比例）；平摊之后这些值**全都相等** */
  structRatios(id) {
    return this.face(id).positions
      .filter((p) => p.kind === 'struct')
      .map((p) => (p.maxHp > 0 ? p.hp / p.maxHp : 0));
  }

  /** 该面能不能长按修复（有结构件、且耐久没满） */
  canRepair(id) {
    return this.face(id).positions.some((p) => p.kind === 'struct' && p.mat && p.hp < p.maxHp);
  }

  // ---------- 属性（2026-09-26 重构：从 3 个属性扩到 6 个）----------
  //
  // 材料提供 5 个属性：强度 / 重量 / 绝缘性 / 光滑度 / 气密性
  // 第 6 个"高度"由全屋已安装结构材料的平均等级派生，决定雷电和光束分摊。

  /** 某个面上某属性的总和（只统计已贴的材料；脆性衰减只削弱"强度"） */
  attrOf(faceId, key) {
    return this.face(faceId).positions.reduce((s, p) => {
      if (!p.mat) return s;
      const m = MATERIALS[p.mat];
      let v = m[key] || 0;
      if (key === 'strength' && m.brittle) v = Math.max(0, v - p.decay);
      return s + v;
    }, 0);
  }

  /** 这几个面上的某属性总和（多面灾害用，如龙卷风打 4 个面） */
  attrOfSum(faceIds, key) {
    return faceIds.reduce((s, id) => s + this.attrOf(id, key), 0);
  }

  /** 全栋某属性总和（地陷吃的是 totalWeight / totalStrength） */
  totalAttr(key) {
    return this.faces.reduce((s, f) => s + this.attrOf(f.id, key), 0);
  }

  weightOf(id) { return this.attrOf(id, 'weight'); }

  get totalWeight() { return this.totalAttr('weight'); }

  /** 全屋结构材料平均等级越高，有效高度越低；功能件不参与。 */
  get height() {
    const mats = this.faces.flatMap((f) => f.positions)
      .filter((p) => p.kind === 'struct' && p.mat && p.hp > 0)
      .map((p) => MATERIALS[p.mat]);
    const tier = mats.length ? mats.reduce((sum, m) => sum + m.tier, 0) / mats.length : 1;
    return SHELTER.heightMax - (tier - 1) / 6 * (SHELTER.heightMax - SHELTER.heightMin);
  }

  // ---------- 功能件：道具抵消值 / 全局增幅 ----------

  /** 这几个面上、专治 disasterId 的道具抵消值总和（避雷针治雷电、反光镜治光束…） */
  toolBlockOf(faceIds, disasterId) {
    let sum = 0;
    for (const id of faceIds) {
      for (const p of this.face(id).positions) {
        if (!p.mat) continue;
        const m = MATERIALS[p.mat];
        if (m.blockTool === disasterId) sum += m.blockValue || 0;
      }
    }
    return sum;
  }

  /** 吞噬器：全局伤害倍率（0.9 = 全部伤害少 10%） */
  get damageScale() {
    let pct = 0;
    for (const f of this.faces) {
      for (const p of f.positions) {
        if (p.mat && MATERIALS[p.mat].damageReduce) pct += MATERIALS[p.mat].damageReduce;
      }
    }
    return Math.max(0.1, 1 - pct);
  }

  /** 强度增幅器提供的强度加成（0.1 = 强度 +10%），只作用在"吃强度"的那部分抵消上 */
  get strengthBoost() {
    let pct = 0;
    for (const f of this.faces) {
      for (const p of f.positions) {
        if (p.mat && MATERIALS[p.mat].strengthBoost) pct += MATERIALS[p.mat].strengthBoost;
      }
    }
    return 1 + pct;
  }

  /**
   * 把 `resist` / `penalty` 表里的键解析成**实际属性值**（不含任何增幅）。
   * 键可以是 5 个属性之一（取 `faceIds` 这几个面的总和），或 `totalXxx`（取**全栋**总和）。
   *
   * ⚠️ resist 和 penalty **共用这一个解析函数** —— 免得"能吃哪些键"在两个方法里各写一套、
   *    慢慢漂移（config 的启动自检也按同一套规则校验键名）。
   */
  attrValueFor(key, faceIds) {
    const isTotal = key.startsWith('total');
    const attr = isTotal ? key.slice(5).toLowerCase() : key;
    return isTotal ? this.totalAttr(attr) : this.attrOfSum(faceIds, attr);
  }

  /**
   * 按灾害声明的 resist 算出"这一击被墙属性抵消多少"。
   * resist 形如 `{ weight: 1.0, strength: 0.4 }`，键的规则见 `attrValueFor`。
   */
  blockValueFor(disaster, faceIds) {
    let sum = 0;
    for (const key of Object.keys(disaster.resist)) {
      // ⚠️ 强度增幅器（strengthBoost）只作用在"吃强度"的那两项上：strength / totalStrength
      const attr = key.startsWith('total') ? key.slice(5).toLowerCase() : key;
      const boost = attr === 'strength' ? this.strengthBoost : 1;
      sum += this.attrValueFor(key, faceIds) * disaster.resist[key] * boost;
    }
    return sum * RULES.attrScale;
  }

  /**
   * 按灾害声明的 `penalty` 算出"这一击**额外多吃**多少伤害"。
   *
   * ⚠️ 2026-09-26 用户定："**重量改成真正的代价轴**" → 地陷的总重量从 `resist` 挪到了这里。
   *
   * ⚠️ 为什么要有独立字段，而不是把系数写成**负数**塞进 `resist`：
   *    负系数会被"减伤"的语义、`Math.min` 封顶和目视审查反复看漏 —— 上一轮
   *    `totalWeight` 就是被放在 `resist` 里变成收益、而且**不报错、看不出来**（见 docs/04）。
   *    加号还是减号必须一眼能看出来，所以两个方向用两个字段。
   *
   * 形状和 `resist` 一样（键的规则见 `attrValueFor`），但方向**相反：这里是加**。
   */
  penaltyValueFor(disaster) {
    const p = disaster.penalty;
    if (!p) return 0;
    let sum = 0;
    for (const key of Object.keys(p)) {
      sum += this.attrValueFor(key, disaster.faces) * p[key];
    }
    return sum * RULES.attrScale;
  }

  // ---------- 模型 A / C：把伤害打到面的耐久上 ----------

  /**
   * 对单个面扣 amount 点耐久（按各自血量占比**平摊**到该面所有结构件上）。
   * @returns {{dealt:number, lost:Array, dead:boolean}} dead = 这一击之后该面是否彻底被打穿
   */
  damageFace(faceId, amount, allowWearDrop = true) {
    const f = this.face(faceId);
    const structs = f.positions.filter((p) => p.kind === 'struct' && p.mat && p.hp > 0);
    if (!structs.length) return { dealt: 0, lost: [], dead: true };

    const totalHp = structs.reduce((s, p) => s + p.hp, 0);
    const dealt = Math.min(amount, totalHp);

    // ⚠️⚠️ 2026-09-26 用户要求："一面墙的总属性由几个结构材料共同组成，
    //    当墙彻底坏了，这些结构材料才失效。" 所以这里**按各自血量占比平摊**，而不是
    //    从左到右依次扣光。
    //    旧做法的隐病：最左边那块料的耐久先归零 → 它被移除 → **它的属性也跟着消失**，
    //    于是墙的属性会在挨打过程中悄悄下降，而玩家完全看不出来（血条只显示总量）。
    //    平摊之后所有结构件**同步掉血、同时归零**：属性一直保持到墙彻底坏掉那一刻，
    //    然后一起失效 —— 这正是用户要的"整面墙是一体的"。
    // ⚠️ 不要在这里做"四舍五入到 0.1" —— 单帧增量小于 0.05 时会被丢掉，
    //    结果就是"伤害在扣、耐久却不下降"。内部保留完整精度，只在 UI 层取整。
    for (const p of structs) {
      const share = (p.hp / totalHp) * dealt;
      p.hp = Math.max(0, p.hp - share);
    }

    const lost = [];
    // 整面墙彻底坏了 → 所有结构件**一起失效**（用户要求）
    if (structs.every((p) => p.hp <= 0)) {
      for (const p of f.positions) {
        if (p.kind !== 'struct' || !p.mat) continue;
        lost.push({ mat: p.mat, why: 'worn', faceId });
        p.mat = null;
        p.hp = 0;
        p.maxHp = 0;
        p.decay = 0;
      }
    } else {
      // 墙没坏 → 破损的料有概率自己掉（2026-09-26 用户要求，见 WEAR_DROP）。
      // ⚠️ 只在 else 分支判：墙已经彻底坏了的话上面已经把料全清了，再掷一次是多余的。
      if (allowWearDrop) lost.push(...this._rollWearDrops(f, faceId));
    }
    // 脆性衰减（同一波内累积，降低该材料的强度）
    // ⚠️ 2026-09-26：加**上限** `brittleDecayMaxRatio`（见 config 的 RULES 注释）。
    //    没有上限时，软料在一波之内（陨石 24 次打击）强度会**归零** → 抵消值消失 →
    //    "按比例减伤"失效、墙被磨穿。上限让它"越打越弱"但不会"直接失效"。
    for (const p of f.positions) {
      if (p.mat && MATERIALS[p.mat].brittle) {
        const m = MATERIALS[p.mat];
        const cap = m.strength * RULES.brittleDecayMaxRatio;
        p.decay = Math.min(cap, p.decay + RULES.brittleDecayPerHit);
      }
    }
    return { dealt, lost, dead: !this.hasStruct(faceId) };
  }

  /**
   * 每波开始时由 `WaveDirector.startPrep()` 调用：设定本波"同一面最多掉几块"，并清零计数。
   * 前 8 波 1 块、第 9 波起 2 块（2026-09-26 用户要求）。
   * ⚠️ 放在 waveDirector 里而不是 main.js 里 —— 这样 `tools/simulate.js`（也走 WaveDirector）
   *    拿到的规则和真游戏**完全一致**，不会出现"标定用一套、实际跑另一套"。
   */
  setWaveDropCap(wave) {
    this.dropCap = wave >= WEAR_DROP.lateFromWave ? WEAR_DROP.capLate : WEAR_DROP.capEarly;
    this.dropsThisWave = {};
  }

  /**
   * 破损掉落判定（2026-09-26 用户要求，见 config.js 的 WEAR_DROP）。
   * 对该面**每块已破损**（0 < 耐久 < 满耐久）的结构件独立掷一次，概率 = maxChance × 破损程度。
   * 同一面每波有上限，防止"一波把一面掉光"。
   * @returns {Array<{mat:string, why:string, faceId:string}>}
   */
  _rollWearDrops(f, faceId) {
    const out = [];
    if (this.dropCap <= 0) return out;
    const maxChance = WEAR_DROP.maxChance;
    for (const p of f.positions) {
      if (p.kind !== 'struct' || !p.mat || p.hp <= 0 || p.hp >= p.maxHp) continue;
      if ((this.dropsThisWave[faceId] || 0) >= this.dropCap) break;
      const wear = 1 - p.hp / p.maxHp;            // 破损程度 0..1
      if (this.rng() >= maxChance * wear) continue;
      const mid = p.mat;
      p.mat = null;
      p.hp = 0;
      p.maxHp = 0;
      p.decay = 0;
      this.dropsThisWave[faceId] = (this.dropsThisWave[faceId] || 0) + 1;
      out.push({ mat: mid, why: 'cracked', faceId });
    }
    return out;
  }

  /** 把 totalDamage **平摊**到这几个面上（多面灾害，如龙卷风打 4 个面） */
  hitFaces(faceIds, totalDamage) {
    if (!faceIds.length || totalDamage <= 0) return { damage: 0, lost: [], deadFaces: [] };
    const share = totalDamage / faceIds.length;
    let dealt = 0;
    const lost = [];
    const deadFaces = [];
    for (const id of faceIds) {
      const r = this.damageFace(id, share);
      dealt += r.dealt;
      lost.push(...r.lost);
      if (r.dead) deadFaces.push(id);
    }
    return { damage: Math.round(dealt * 10) / 10, lost, deadFaces };
  }

  /** 某面结构件全破后：每次受击有概率把它的功能件打飞（返回被打飞的 materialId 或 null） */
  knockExposedFunc(faceId) {
    if (this.hasStruct(faceId)) return null;
    if (this.rng() >= RULES.exposedKnockChance) return null;
    return this._knockFunc(this.face(faceId));
  }

  /**
   * 放一块材料。结构件会带满耐久一起进来（提供血量），功能件只贡献属性。
   * @returns {{ok:boolean, posIndex:number, addedHp:number, reason?:string}}
   */
  applyMaterial(id, materialId) {
    const m = MATERIALS[materialId];
    if (!m) return { ok: false, posIndex: -1, addedHp: 0, reason: 'unknown' };

    const f = this.face(id);
    const posIndex = f.positions.findIndex((p) => p.kind === m.kind && p.mat === null);
    if (posIndex < 0) {
      return { ok: false, posIndex: -1, addedHp: 0, reason: m.kind === 'struct' ? 'struct_full' : 'func_full' };
    }

    const p = f.positions[posIndex];
    p.mat = materialId;
    p.maxHp = m.durability || 0;
    p.hp = p.maxHp;
    p.decay = 0;
    return { ok: true, posIndex, addedHp: p.maxHp };
  }

  /**
   * 这个位置上的材料**能不能被取回背包**（2026-09-26 用户要求）。
   *
   * 规则：结构件只要**挨过打**（耐久 < 满耐久）就算破损 → 取下即消失；
   *       修满之后才能取回。功能件不参与血量（maxHp 恒为 0），永远可回收。
   *
   * ⚠️ 阈值取的是"挨过打"而不是"出现裂痕"（用户明确选的这条）。好处是规则简单到
   *    一句话能说完；代价是它**视觉上看不见** —— 掉 5% 耐久时颜色和完好完全一样
   *    （render 的 matState 到 66% 以下才画裂痕）。所以渲染层必须为此画一个
   *    "已受伤"的标记，否则玩家会以为一块完好的料取下来却凭空消失了。
   */
  canRecoverAt(id, posIndex) {
    const p = this.face(id).positions[posIndex];
    if (!p || !p.mat) return false;
    if (p.kind !== 'struct') return true;
    return p.hp >= p.maxHp;
  }

  /** 拆下指定位置的材料，返回 materialId 或 null */
  removeAt(id, posIndex) {
    const f = this.face(id);
    const p = f.positions[posIndex];
    if (!p || !p.mat) return null;
    const mid = p.mat;
    p.mat = null;
    p.hp = 0;
    p.maxHp = 0;
    p.decay = 0;
    return mid;
  }

  /**
   * 长按修复 · 第一阶段：算出"这一帧想修多少耐久"以及"要花多少修复量"。
   *
   * 定价随稀有度上升（2026-09-25 用户要求："越稀有的材料，耗的修复材料越多，时间也越长"）：
   *   tier1: 14 耐久/秒 × 1 修复量/耐久
   *   tier2:  7 耐久/秒 × 2 修复量/耐久   → 同一份修复材料只能修一半的耐久、也要双倍时间
   *
   * @returns {{units:number, items:Array<{posIndex:number, hp:number}>}}
   */
  repairPlan(id, dt) {
    const items = [];
    let units = 0;
    this.face(id).positions.forEach((p, i) => {
      if (p.kind !== 'struct' || !p.mat || p.hp >= p.maxHp) return;
      const tier = MATERIALS[p.mat].tier;
      const rate = REPAIR.perSec[tier] || 10;
      const cost = REPAIR.unitsPerHp[tier] || 1;
      const hp = Math.min(p.maxHp - p.hp, rate * dt);
      if (hp <= 1e-6) return;
      items.push({ posIndex: i, hp });
      units += hp * cost;
    });
    return { units, items };
  }

  /**
   * 长按修复 · 第二阶段：按"实际扣到的修复量 / 需要的修复量"的比例把耐久补上。
   * （修复量不够时按比例少修一点，而不是完全不修）
   */
  repairApply(id, plan, unitsGot) {
    if (!plan.items.length || plan.units <= 1e-9) return 0;
    const k = Math.min(1, unitsGot / plan.units);
    const f = this.face(id);
    let restored = 0;
    for (const it of plan.items) {
      const p = f.positions[it.posIndex];
      if (!p.mat) continue;
      const add = Math.min(it.hp * k, p.maxHp - p.hp);
      p.hp += add;   // 保留完整精度，不要每帧取整
      restored += add;
    }
    return restored;
  }

  resetDecay() {
    this.faces.forEach((f) => f.positions.forEach((p) => { p.decay = 0; }));
  }

  /** 打掉一块功能件（结构件全破之后才会发生） */
  _knockFunc(f) {
    for (let i = f.positions.length - 1; i >= 0; i--) {
      const p = f.positions[i];
      if (p.kind === 'func' && p.mat) {
        const mid = p.mat;
        p.mat = null;
        p.hp = 0;
        p.maxHp = 0;
        p.decay = 0;
        return mid;
      }
    }
    return null;
  }

  // ⚠️ 原来的 `takeHit()`（"打穿后按 35% 透传"）已在 2026-09-26 被**删除**。
  //    新模型是：结算管线放在 `waveDirector.fire()` 里，本类只提供上面那几个零件
  //    （toolBlockOf / blockValueFor / hitFaces / damageFace / knockExposedFunc）。
  //    这样"灾害的规则"和"灾害的数据"待在一起，不用在一个函数里塞 7 种分支。

  /** 给 UI 用：某面的属性汇总 */
  summaryOf(id) {
    const f = this.face(id);
    const used = (k) => f.positions.filter((p) => p.kind === k && p.mat).length;
    const total = (k) => f.positions.filter((p) => p.kind === k).length;
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      id: f.id,
      name: f.name,
      hp: Math.round(this.hpOf(id)),
      maxHp: Math.round(this.maxHpOf(id)),
      broken: !this.hasStruct(id),
      canRepair: this.canRepair(id),
      structUsed: used('struct'), structTotal: total('struct'),
      funcUsed: used('func'), funcTotal: total('func'),
      // 5 个真实属性 + 1 个派生（高度）
      strength: r1(this.attrOf(id, 'strength')),
      weight: r1(this.attrOf(id, 'weight')),
      insulation: r1(this.attrOf(id, 'insulation')),
      smoothness: r1(this.attrOf(id, 'smoothness')),
      seal: r1(this.attrOf(id, 'seal')),
    };
  }
}
