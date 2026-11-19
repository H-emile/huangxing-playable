// 合成系统 —— 纯逻辑，不依赖任何渲染或浏览器 API
// 可被 Node 直接 import（配方查询、掷骰、工作台状态机都能脱离浏览器验证）
//
// 分工：
//   · 本文件只管"规则与时间"：查配方 → 掷骰 → 出什么
//   · 容器的增删、UI、暂停/报废的**触发条件**在 main.js（配合 waveDirector 的灾害事件）
//   · 数值全部来自 config.js 的 SYNTH / SYNTH_RECIPES —— 调参不要改这里

import { SYNTH, SYNTH_RECIPES, MATERIALS } from './config.js';

export const SYNTH_STATE = { IDLE: 'idle', RUNNING: 'running', PAUSED: 'paused' };

/** 按 id 找配方。**有序**：recipeOf(a,b) 与 recipeOf(b,a) 可能是两条不同配方 */
export function recipeOf(a, b) {
  return SYNTH_RECIPES.find((r) => r.a === a && r.b === b) || null;
}

/**
 * 这两件能不能合。返回 `{ ok, reason }`：
 *   · 'not_struct' 功能件 / 修复材料不能合成（用户规则）
 *   · 'no_recipe'  这个组合不在配方表里 —— "只有特定组合能合"（蛇级/蛟级尤其明显）
 */
export function canSynthesize(a, b) {
  const ma = MATERIALS[a];
  const mb = MATERIALS[b];
  if (!ma || !mb) return { ok: false, reason: 'unknown' };
  if (ma.kind !== 'struct' || mb.kind !== 'struct') return { ok: false, reason: 'not_struct' };
  if (!recipeOf(a, b)) return { ok: false, reason: 'no_recipe' };
  return { ok: true, reason: null };
}

/**
 * 这一档的成功率 / 报废占比。
 * ⚠️ 查不到**必须抛错**，不能返回默认值 —— 返回 undefined 会让 `rng() < rate` 恒为 false，
 *    即"成功率静默变成 0、每次合成必失败"，这是本项目最怕的静默失效（见 docs/04）。
 *    config 的配方自检已经断言过所有档位都声明了，这里是第二道闸。
 */
function ratesOf(tier) {
  const rate = SYNTH.successRate[tier];
  const scrap = SYNTH.scrapShare[tier];
  if (rate === undefined || scrap === undefined) {
    throw new Error(`合成：档位 ${tier} 没有在 config 的 SYNTH.successRate / scrapShare 里声明`);
  }
  return { rate, scrap };
}

/**
 * 掷出这次合成的结果。
 * @returns {{success:boolean, mat:string|null, scrap:boolean, rate:number}}
 *   success=true  → mat = 高两档的产物
 *   success=false → scrap=true 表示彻底报废（mat=null）；否则 mat = "次X级"
 */
export function rollOutcome(recipe, rng = Math.random) {
  const tier = MATERIALS[recipe.a].tier;
  const { rate, scrap } = ratesOf(tier);
  if (rng() < rate) return { success: true, mat: recipe.ok, scrap: false, rate };
  // 失败 → 再掷一次决定"降级"还是"彻底报废"（用户：失败有两种结果）
  if (rng() < scrap) return { success: false, mat: null, scrap: true, rate };
  return { success: false, mat: recipe.fail, scrap: false, rate };
}

/**
 * 工作台（2026-09-27 用户选定：庇护所工作台 + **后台 30 秒倒计时**）。
 *
 * 状态机：idle → running →（完成）idle
 *                  ↘ paused（庇护所被打穿）↗（墙补好自动恢复）
 *
 * ⚠️ 投入的材料在 `start()` 的**同一帧**就离开了容器（由 main.js 扣），本类只记 id ——
 *    所以"被打穿 → 投入损失"只是清空状态，不需要回滚容器。
 * ⚠️ 故意**不提供取消**：材料投进去之后，玩家只能在"修好墙等它做完"和"墙一直破着"
 *    之间选 —— 这是用户要的"补回风险感"（文档 7.3）。
 */
export class Workbench {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.state = SYNTH_STATE.IDLE;
    this.a = null;
    this.b = null;
    this.recipe = null;
    this.left = 0;                 // 剩余秒数
    this.total = SYNTH.seconds;
    this.pausedReason = null;
    // ⚠️ 2026-09-29（用户要求）：**产物先留在台子上等玩家来取**，不再直接落袋。
    //    它必须活在 reset() 里 —— 而 update() 的"完成"路径要**先把产物存下再 reset**
    //    （见那里的注释；顺序反了会被这一行清掉）。
    //    `collapse()`（台子被打穿）也会清它 —— 用户定："产出跟着毁掉"。
    this.product = null;
  }

  get busy() { return this.state !== SYNTH_STATE.IDLE; }

  /**
   * 台子上有没有"做好但还没取走"的东西。
   * 两个用处：渲染画待取标记；`tapWorkbench` 决定"这一下是取货还是开面板"。
   */
  get hasProduct() { return this.product !== null; }

  /** 进度 0..1（渲染进度条用） */
  get progress() {
    if (!this.total) return 0;
    return Math.min(1, Math.max(0, 1 - this.left / this.total));
  }

  /** 开始合成。返回 `{ok, reason}`，reason 同 canSynthesize */
  start(a, b) {
    if (this.busy) return { ok: false, reason: 'busy' };
    // ⚠️ 2026-09-29：台子上有**没取走的产物**时不能开新的一炉 —— 否则产物会被这轮 reset 清掉。
    //    （正常流程走不到这里：`tapWorkbench` 看到产物会直接去取货、不会开面板。这是第二道闸。）
    if (this.product) return { ok: false, reason: 'has_product' };
    const chk = canSynthesize(a, b);
    if (!chk.ok) return chk;
    this.a = a;
    this.b = b;
    this.recipe = recipeOf(a, b);
    this.total = SYNTH.seconds;
    this.left = SYNTH.seconds;
    this.state = SYNTH_STATE.RUNNING;
    this.pausedReason = null;
    return { ok: true, reason: null };
  }

  /**
   * 推进倒计时（每帧调用；**只有 running 才走**，暂停就是不推进）。
   * @returns {null | {success, mat, scrap, rate, recipe}} 完成时返回结果，其余时候 null
   */
  update(dt) {
    if (this.state !== SYNTH_STATE.RUNNING) return null;
    this.left -= dt;
    if (this.left > 0) return null;
    const recipe = this.recipe;
    const out = rollOutcome(recipe, this.rng);
    this.reset();
    // ⚠️⚠️ 顺序不能反：`reset()` 会把 `product` 清成 null，所以产物必须在它**之后**写回去。
    //    这是用户 2026-09-29 要的："合成成功后先暂存在工作台里，等玩家点击工作台再收"。
    //    ⚠️ 彻底报废（scrap）**没有产物** —— 玩家不需要来取，由 banner 告知即可。
    if (!out.scrap) this.product = { mat: out.mat, success: out.success };
    return { ...out, recipe };
  }

  /** 庇护所被打穿 → 进度暂停（**不清零**） */
  pause(reason = 'wall_broken') {
    if (this.state !== SYNTH_STATE.RUNNING) return false;
    this.state = SYNTH_STATE.PAUSED;
    this.pausedReason = reason;
    return true;
  }

  /** 墙补好 → 接着走 */
  resume() {
    if (this.state !== SYNTH_STATE.PAUSED) return false;
    this.state = SYNTH_STATE.RUNNING;
    this.pausedReason = null;
    return true;
  }

  /**
   * 工作台被打穿 → 投入的材料损失 + **台子上已做好的产物也一起毁**。
   * ⚠️ 2026-09-29：产物一起毁是用户定的（"跟着毁掉"）—— 和"正在合成的投入"一个待遇，
   *    风险一致、好理解；它同时保住了"抢修"这条压力（否则合成一做完就安全了、不用管台子）。
   * ⚠️ 光看 `busy` 不够：**空闲但台子上有产物**时 `busy` 是 false，原来会直接 return null
   *    → 产物永远毁不掉。所以判定必须连 `product` 一起看。
   * @returns {null | {a, b, product}} 被毁掉的东西（没在做、台子上也没有产物 → null）
   */
  collapse() {
    if (!this.busy && !this.product) return null;
    const lost = { a: this.a, b: this.b, product: this.product };
    this.reset();
    return lost;
  }
}
