// 主角 —— 纯逻辑

import { PLAYER, MATERIALS, WORLD, BAG_SLOTS, JUMP, RULES, SHELTER, TERRAIN } from './config.js';
import { surfaceAt, crossedSurface, terrainY, steepFaceDownhillEdge } from './world.js';

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export class Player {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = SHELTER.cx;   // 从庇护所中心出发（2026-09-27：世界加宽后不能再写死 1000）
    this.hp = PLAYER.maxHp;
    this.carry = [];       // material id 数组（背包）
    this.dead = false;
    this.stunT = 0;        // 被塌方埋住的剩余秒数，>0 时不能移动
    this.busyT = 0;        // 挖掘忙时，>0 时不能移动也不能再挖
    // 挖掘**专属**的剩余秒数（2026-10-05）：只给渲染层选"挖掘"那条动画用。
    // ⚠️ 为什么不直接读 `busyT`：隧道传送（1.5s）/ 换层过渡（0.8s）**也占 busyT** ——
    //    那两种不该播挖地的动作。两者同生同灭（都在挖掘起手时设成 `DIG.tapSeconds`）。
    this.digT = 0;
    this.targetX = null;   // 点击移动的目标点
    this.hurtFlash = 0;    // 受击闪烁计时（纯表现）
    // 垂直（2026-09-26 加地形与跳跃）：y = 脚底的世界坐标
    this.y = WORLD.groundY;
    this.vy = 0;
    this.onGround = true;
    this.jumpCd = 0;
    // 乘升降台上升中（2026-09-27）：期间**不能移动/跳跃/挖掘** —— 见 startLift
    this.lifting = null;
  }

  get isBusy() {
    return this.busyT > 0;
  }

  get carryWeight() {
    return this.carry.reduce((s, id) => s + MATERIALS[id].weight, 0);
  }

  get speed() {
    const w = this.carryWeight;
    return Math.max(PLAYER.speedMin, PLAYER.speedBase * (1 - w * PLAYER.speedPerWeight));
  }

  get isFull() {
    return this.carry.length >= BAG_SLOTS;
  }

  get isStunned() {
    return this.stunT > 0;
  }

  /** 被废墟塌方埋住 */
  stun(sec) {
    this.stunT = Math.max(this.stunT, sec);
  }

  move(dir, dt) {
    if (this.dead) return;

    // 乘升降台上升中：只沿轨迹走，别的什么都不做。
    // ⚠️ 这个分支必须在 `_vertical` **之前** —— 否则重力会和上升路径打架。
    if (this.lifting) {
      const L = this.lifting;
      L.t += dt;
      const k = Math.min(1, L.t / L.dur);
      const e = k * k * (3 - 2 * k);            // smoothstep：起停不那么生硬
      this.x = L.from.x + (L.to.x - L.from.x) * e;
      this.y = L.from.y + (L.to.y - L.from.y) * e;
      if (k >= 1) {
        this.x = L.to.x;
        this.y = L.to.y;
        this.vy = 0;
        this.onGround = true;
        this.lifting = null;
      }
      return;
    }

    // ⚠️ 垂直**永远先算**：否则"跳到半空被塌方埋住"会一直悬在空中
    this._vertical(dt);
    if (this.stunT > 0) {
      this.stunT = Math.max(0, this.stunT - dt);
      return;
    }
    // 挖掘忙时站着不动 —— 这是"多点几下"的时间代价
    if (this.busyT > 0) {
      this.busyT = Math.max(0, this.busyT - dt);
      this.digT = Math.max(0, this.digT - dt);   // 和 busyT 同步走（见 reset 里那段注释）
      return;
    }

    // 这一帧想去哪：键盘方向优先；没有按键时朝点击的目标点走
    let nx = this.x;
    let arriving = false;
    if (dir !== 0) {
      this.targetX = null;
      nx = clamp(this.x + dir * this.speed * dt, 40, WORLD.width - 40);
    } else if (this.targetX !== null) {
      const d = this.targetX - this.x;
      const step = this.speed * dt;
      if (Math.abs(d) <= step) { nx = clamp(this.targetX, 40, WORLD.width - 40); arriving = true; }
      else nx = clamp(this.x + Math.sign(d) * step, 40, WORLD.width - 40);
    } else {
      return;
    }

    // ⚠️ 坡度检查（2026-10-03 改，原来是"台阶检查"）：站在地上时，**太陡的坡走不上去**，必须跳。
    //    原来判的是"前方一阶的落差 > `RULES.stepUp`" —— 地形从"阶跃"改成**斜坡**之后那套失效了
    //    （贴地吸附每帧只升 1~2px，永远小于 stepUp），所以改成**量坡度**。
    //    ⚠️⚠️ 这里必须量 **`terrainY`（地形本身）**，**不能用 `surfaceAt`** ——
    //       `surfaceAt` 内部有一条 `c < y - RULES.stepUp → continue`（"比脚高过 26px 的面
    //       不算脚下的面"）。48px 高的坎顶正好被它过滤掉 → `best` 为 null → 兜底返回**你脚底
    //       正下方**的地面 → 落差恒为 0 → **判定永远不触发**（静默失效）。
    //       实测症状：角色径直走上坎，然后被 `_vertical` 的贴地吸附**一帧吸上去 48px**
    //       —— 用户原话"陡坡没有阻拦人物，而是自动跳了上去"。
    //    ⚠️ 用量的是**地形**、不含岩桥：桥面本来就是平的，不需要这条判定；而且玩家在桥上时
    //       `terrainY` 远低于脚底 → 差值为负 → 不挡。✓
    //    ⚠️ 只挡**上坡**（前方更高）—— 下坡随便走。
    //    ⚠️ 被挡住时**不放弃 targetX**：玩家跳过去之后会继续朝目标走（否则点一下就废了）。
    // ⚠️⚠️ 2026-10-05：这条检查**不再豁免"上升中"**（原来是 `if (this.vy >= 0) { … }`）。
    //    豁免的后果是一条链：起跳后能水平**走进坎的 x 范围** → 那一瞬间脚底比坡面低 ⇒
    //    `_vertical` 的防穿透兜底把人**吸附到坡面上、并把 `vy` 清零**（跳跃被截断）→
    //    坡度检查又不让继续往右 ⇒ **人卡在坎面半腰**（用户报的"没跳上陡坡会掉下来，不是卡在那里"）。
    //    实测（临时脚本扫"起跳余量"）：空手余量 4px / 负重满余量 36、40px 三种都会停在坎面内
    //    （比坎脚高 27.0 / 29.7 / 14.4px，落差 48px），且都伴随"上升被截断"。
    //    去掉豁免后语义更直白：**脚底比前方的地面低，就不许往那边走**（不许走进比脚高的地里）。
    //    于是"能水平移动"的前提变成"已经跳到接近那道坎的顶（差 ≤ `probe × maxSlope` = 12px）"。
    //    ⚠️ 跳跃本身不受影响：跳跃高度 63.8 > 坎高 48，实测**各种起跳余量都能上坎顶** ✓。
    //    ⚠️ 这条检查只对"坎"生效（坡段最高 0.53 < `maxSlope` 2.0）：斜坡、平地上永远算不出"前方更高"，
    //       所以"边走边跳"的手感一个字节没变。
    //    ⚠️ 用的是 `terrainY`（地形本身），不含岩桥 —— 见上面那条注释。
    {
      const probe = TERRAIN.slopeProbe;
      // ⚠️⚠️ 必须按**移动方向**探测。原来死写 `this.x + probe`（**永远看右边**），
      //    于是"左边有坎、人往左走"会被**身后那道坎**判成"前方太陡"而挡住
      //    —— 用户原话："向右走时陡坡会自动攀升，向左时却直接卡住"。
      //    ⚠️ 这个方向不对称从第一版就在，一直被掩盖：我所有用例都是**朝右走**的。
      //    （"向右攀升"正是它的另一面：朝右时探测的是前方的坡、落差不到阈值 → 放行。）
      const dirX = nx >= this.x ? 1 : -1;
      const ahead = terrainY(this.x + dirX * probe);
      if (this.y - ahead > probe * TERRAIN.maxSlope) return;   // 正 = 前方更高
    }
    this.x = nx;
    if (arriving) this.targetX = null;
  }

  /**
   * 重力与落地。
   * ⚠️ 2026-09-27：脚下的面不再只有地形，还有**可站立平台**（上层岩桥）。
   *    单向平台 = 上升时穿过去、下落时踩住 —— 靠"只判定这一帧**跨过**的面"实现。
   */
  _vertical(dt) {
    this.jumpCd = Math.max(0, this.jumpCd - dt);

    // ⚠️⚠️ 2026-10-05：**不许"站在坎面里"**（坎 = 坡度 > `maxSlope` 的那 8px 陡面）。
    //    这是"没跳上陡坡会卡在半腰"的最后一道保险 —— 玩家可能从三条路落到坎面上：
    //      ① 跨面判定（`crossedSurface`）直接落上去；② 防穿透兜底把脚贴上去；③ 贴地吸附。
    //    而一旦落在上面，`move()` 的坡度检查就会挡住"继续往上"，人**既不上去也不掉下来**
    //    （用户报的"没跳上陡坡会掉下来，不是卡在那里"）。
    //    → 每帧先做一次校正：脚底只要已贴到/低于坎面，就把 x 推到**下坡那一侧的边缘**（坎脚），
    //      并清掉 `onGround`，交给重力把人摔下去；`vy` **不动**（上升中被推进来的也会继续上升）。
    //    实测（临时脚本）：负重满（速度 55）起跳余量 36 / 40px 这两种原本停在坎面半腰
    //    （比坎脚高 29.7 / 14.4px），现在都掉回坎脚 ✓。
    {
      const edge = steepFaceDownhillEdge(this.x);
      if (edge !== null && this.y >= terrainY(this.x) - 1) {
        this.x = clamp(edge, 40, WORLD.width - 40);
        this.onGround = false;
      }
    }

    // 贴地行走：跟着脚下的面上下（含在岩桥上走动）
    if (this.onGround && this.vy === 0) {
      const s = surfaceAt(this.x, this.y);
      // ⚠️⚠️ 吸附必须**双向**有界：`s <= this.y + 6`（别往下瞬移）**加上** `s >= this.y - RULES.stepUp`（别往上瞬移）。
      //    少了上限这一条，角色会**一帧爬上任意高的坎** —— `surfaceAt` 在"面的高度超过 stepUp"时
      //    会把它过滤掉、然后**兜底 `return terrainY(x)`**（正是那个高面），于是吸附照旧把他拉上去。
      //    这就是用户报的"陡坡没有阻拦人物，而是自动跳了上去"（那不是跳，是吸附）。
      //    ⚠️ 两个门槛缺一不可：坡度判定（`move()`）负责"提前拦住"，这条负责"拽不上去"。
      if (s <= this.y + 6 && s >= this.y - RULES.stepUp) { this.y = s; return; }
      // 脚下的面突然比脚底低很多 → 走出了平台边缘 → 转为下落（**不要瞬移下去**）
      this.onGround = false;
    }

    const prevY = this.y;
    this.vy += JUMP.gravity * dt;
    this.y += this.vy * dt;

    // 只在下落时判定落点（上升时穿过平台，所以不会"从下面被顶住"）
    if (this.vy > 0) {
      const land = crossedSurface(this.x, prevY, this.y);
      if (land !== null) {
        this.y = land;
        this.vy = 0;
        this.onGround = true;
        return;
      }
    }

    // ⚠️ 防穿透兜底（2026-09-27）：跳跃过程中水平越过了台地的**垂直岩壁**时，可能出现
    //    "脚底比地形还低"（人已经在地里了）。此时上面的"跨面"判定永远不成立
    //    （地形面在起点**之上**、不在这一帧跨过的区间里）→ 会一直往下掉、掉出世界。
    //    所以这里兜一道：只要脚底低于地形，就直接吸附到地形表面。
    // ⚠️⚠️ 这道兜底**只在空中（`vy !== 0`）时生效 —— 走路时绝不能走这条路**。
    //    它没有高度限制（`this.y > gy` 就把人整段拉平到地形），所以在"贴地行走"时，
    //    只要 `move()` 的坡度判定漏掉某一帧，玩家**水平踏进岩壁的 x 范围**就会被这里
    //    **一帧拉到壁顶** —— 这正是用户报的"自动攀升"（上一轮我只堵了上面的贴地吸附，
    //    没注意这里是**另一条独立的路**）。
    //    空中确实需要它：跳跃水平越过垂直岩壁时会"人在土里"，而上面的"跨面"判定不成立。
    //    ⚠️ 贴地时若真陷进地形（塌方把地形抬高）：重力会让 `vy !== 0`，下一帧照样救得出来。
    if (this.vy !== 0) {
      const gy = terrainY(this.x);
      if (this.y > gy) {
        this.y = gy;
        this.vy = 0;
        this.onGround = true;
        return;
      }
    }
    this.onGround = false;
  }

  /** 起跳。返回是否真的跳了（忙碌 / 昏迷 / 上升中 / 已在空中 / 冷却中都不行） */
  jump() {
    if (this.dead || this.isBusy || this.isStunned || this.lifting) return false;
    if (!this.onGround || this.jumpCd > 0) return false;
    this.vy = -JUMP.speed;
    this.onGround = false;
    this.jumpCd = JUMP.minInterval;
    return true;
  }

  get isLifting() { return !!this.lifting; }

  /**
   * 乘升降台上升（2026-09-27 用户选定："通过特殊的方式把人物带到更高的地方去探索"）。
   *
   * ⚠️ 上升路径由 player **自己按时间插值**（而不是靠重力 + 碰撞）：
   *    这样"一定能到达指定的落点"是确定的，不会出现"升到一半被平台边缘卡住 / 落点悬空
   *    掉回地面"这种难查的边界问题。期间 `move()` 会直接接管并屏蔽其它操作。
   *
   * @param {{x:number,y:number}} to 落点，**必须是某块平台的顶面**（见 config 的 LIFTS）
   */
  startLift(to, seconds) {
    if (this.dead || this.lifting || this.isBusy || this.isStunned) return false;
    this.lifting = {
      from: { x: this.x, y: this.y },
      to: { x: to.x, y: to.y },
      t: 0,
      dur: seconds,
    };
    this.vy = 0;
    this.onGround = false;
    this.targetX = null;
    return true;
  }

  tick(rawDt) {
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - rawDt);
  }

  takeDamage(n) {
    if (this.dead || n <= 0) return;
    this.hp = Math.max(0, this.hp - n);
    if (this.hp <= 0) this.dead = true;
  }

  /** 拾取，成功返回 material id */
  pick(materialId) {
    if (this.isFull) return null;
    this.carry.push(materialId);
    return materialId;
  }

  /** 取出一件（用于安装/修复） */
  take() {
    return this.carry.length ? this.carry.pop() : null;
  }

  /** 塞回一件（拆下来的材料） */
  putBack(materialId) {
    if (this.isFull) return false;
    this.carry.push(materialId);
    return true;
  }
}
