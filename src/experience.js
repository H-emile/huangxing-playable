// 浏览器原型的可读提示与触屏入口；所有操作仍调用现有游戏动作。
import { MATERIALS, DISASTERS, SHELTER, PLAYER, RULES, HELP_LINES, KIND_LABEL, trashRect, bagPanelRect,
  VIEW, UI_LAYOUT, UI_CHROME, uiSetOffset, uiLabelRect, uiTitleBarRect, hudPanelRect, minimapRect, CAMERA, CAMERA_ANCHOR_Y,
  bagSlotRect, skipBtnRect, BAG_SLOTS } from './config.js';
import { shelterRects, atSpot } from './world.js';
import { drawMaterialGlyph } from './render.js';
import { ShelterModel } from './shelter.js';
import { WaveDirector, Phase } from './waveDirector.js';
import { canSynthesize, recipeOf } from './synthesis.js';
import { createGameAudio } from './audio.js';

const round = (n) => Math.round(n * 10) / 10;
export function forecast(s) {
  const threats = s.director.cfg.disasters.map((id) => DISASTERS[id]);
  const faces = [...new Set(threats.flatMap((d) => d.faces))];
  const weakest = faces.map((id) => s.shelter.face(id))
    .sort((a, b) => s.shelter.hpOf(a.id) - s.shelter.hpOf(b.id))[0];
  const attrs = { strength: '强度', weight: '重量', insulation: '绝缘', smoothness: '光滑', seal: '气密', totalStrength: '全栋强度' };
  return `${threats.map((d) => d.name).join('＋')} → ${faces.map((id) => s.shelter.face(id).name).join('、')}`
    + `；优先补${weakest.name}，关注${[...new Set(threats.flatMap((d) => Object.keys(d.resist)))].map((k) => attrs[k]).join('、')}`
    + (s.director.wave >= RULES.proportionalFromWave ? '。后期防护再高也有少量损耗。' : '。');
}

/** 用真实结算管线比较一击；在拷贝上运算，绝不修改本局或消耗随机数。 */
export function installationPreview(s, id, faceId) {
  const simulate = (add) => {
    const shelter = Object.assign(new ShelterModel(() => 1), JSON.parse(JSON.stringify(s.shelter)));
    shelter.rng = () => 1; // 预览不掷破损掉落，也不推进游戏随机序列
    if (add && !shelter.applyMaterial(faceId, id).ok) return null;
    const director = new WaveDirector(shelter, () => 1);
    director.wave = s.director.wave;
    return s.director.cfg.disasters.map((key) => {
      const ev = director.fire(DISASTERS[key], false);
      return { name: DISASTERS[key].name, wall: ev.damage, player: ev.playerDamage };
    });
  };
  const before = simulate(false), after = simulate(true);
  if (!after) return '这一面的对应格位已满。';
  return after.map((v, i) => `${v.name}：墙损 ${round(before[i].wall)}→${round(v.wall)}，人伤 ${round(before[i].player)}→${round(v.player)}`)
    .join('；') + '（在屋内；按本波各灾害依次一击估算，不含随机掉落）。';
}

export function createExperience(actions) {
  const bar = document.createElement('nav');
  bar.id = 'game-controls';
  bar.setAttribute('aria-label', '游戏操作');
  const cue = document.createElement('aside');
  cue.id = 'game-cue';
  const dialog = document.createElement('dialog');
  dialog.id = 'game-dialog';
  dialog.setAttribute('aria-label', '游戏面板');
  const home = document.createElement('main'); home.id = 'game-home'; home.hidden = true;
  const hand = document.createElement('canvas'); hand.id = 'game-tutorial-hand'; hand.hidden = true;
  hand.setAttribute('aria-hidden', 'true');
  Object.assign(hand.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none', zIndex: '3', background: 'transparent' });
  document.body.append(bar, cue, dialog, home, hand);
  let opened = false, wasPaused = false, lastUpdate = 0, muted = false, musicMuted = false, tutorialPage = -1;
  let storageKind = null, managementFace = 'roof';
  const audio = createGameAudio();
  const button = (label, fn, parent = bar) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.setAttribute('aria-label', label); b.title = label;
    const marks = { '开始游戏': '▶', '继续游戏': '▶', '教学体验': '?', '图标说明': '?', '教学回顾': '?',
      '新游戏': '+', '重开': '↻', '返回主界面': '⌂', '返回背包': '‹', '返回仓库': '‹',
      '墙属性': '◇', '仓库': '▦', '合成': '⚒', '开始练习': '▶', '回到练习': '▶',
      '下一组图标': '›', '上一组图标': '‹' };
    if (marks[label]) b.dataset.symbol = marks[label];
    b.addEventListener('click', (e) => { fn(e); if (!b.classList.contains('touch-control')) audio.play('click'); }); parent.append(b);
    return b;
  };
  const line = (text, parent = dialog, tag = 'p') => {
    const el = document.createElement(tag); el.textContent = text; parent.append(el); return el;
  };
  const actionRow = (parent = dialog) => {
    const row = document.createElement('div'); row.className = 'action-row'; parent.append(row); return row;
  };
  const close = () => {
    dialog.close(); opened = false; tutorialPage = -1;
    actions.state().inspectItem = null;
    actions.state().removeConfirm = null;
    actions.state().synthPanel = null;
    if (!wasPaused) actions.resume();
  };
  const returnHome = () => { wasPaused = true; close(); actions.home(); };
  const showHome = (hasSave, message) => {
    if (opened) { wasPaused = true; close(); }
    home.replaceChildren(); home.hidden = false; bar.hidden = true; cue.hidden = true;
    const panel = document.createElement('section'); panel.className = 'home-panel'; home.append(panel);
    line('荒星筑巢', panel, 'h1');
    line('在废墟中收集材料，守住风暴里的家。', panel);
    const choices = document.createElement('div'); choices.className = 'home-actions'; panel.append(choices);
    const start = button(hasSave ? '继续游戏' : '开始游戏', actions.begin, choices);
    start.id = 'start-game-button'; start.className = 'primary-action';
    const tutorial = button('教学体验', actions.tutorial, choices); tutorial.id = 'tutorial-button';
    if (hasSave) button('新游戏', restartConfirm, choices);
    line(hasSave ? '避难记录已就绪' : '第 01 波 · 等待出发', panel, 'small');
    if (message) line(message, panel);
    home.scrollTop = 0;
    start.focus({ preventScroll: true });
  };
  const open = (title, onClose = close, closeLabel = '关闭') => {
    if (!opened) { wasPaused = actions.state().paused; actions.pause(); }
    dialog.replaceChildren();
    dialog.className = '';
    const header = document.createElement('header'); dialog.append(header);
    line(title, header, 'h2');
    const dismiss = button(closeLabel, onClose, header);
    if (closeLabel === '关闭') dismiss.className = 'dialog-close';
    if (!opened) dialog.showModal();
    opened = true;
  };
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (tutorialPage >= 0) returnHome();
    else close();
  });
  const nearHome = () => actions.state().layer === 'ground'
    && Math.abs(actions.state().player.x - SHELTER.cx) < PLAYER.buildRadius;
  const materialButton = (id, label, fn, parent, badge = '') => {
    const b = button(label, fn, parent);
    b.className = 'material-item'; b.setAttribute('aria-label', label); b.title = label;
    const icon = document.createElement('canvas'); icon.width = icon.height = 48;
    icon.setAttribute('aria-hidden', 'true');
    drawMaterialGlyph(icon.getContext('2d'), 4, 4, 40, 40, id, { radius: 6 });
    b.replaceChildren(icon);
    if (badge) { const count = document.createElement('span'); count.className = 'material-count'; count.textContent = badge; b.append(count); }
    return b;
  };
  const storageItem = (id, index, parent, count) => {
    let press = null, dragged = false;
    const b = materialButton(id, MATERIALS[id].name, () => {
      if (!dragged) inspect({ mat: id, from: { type: 'store', index } });
    }, parent, `×${count}`);
    b.classList.add('storage-item');
    b.title = `${MATERIALS[id].name} · 点击查看，拖到背包取出或墙面装配`;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || press || actions.state().activePointerId !== null) return;
      dragged = false; press = { id: e.pointerId, x: e.clientX, y: e.clientY };
      actions.state().activePointerId = e.pointerId;
      b.setPointerCapture(e.pointerId);
    });
    b.addEventListener('pointermove', (e) => {
      if (!press || press.id !== e.pointerId || Math.hypot(e.clientX - press.x, e.clientY - press.y) <= UI_CHROME.dragSlop) return;
      dragged = true; press = null;
      close();
      actions.beginItemDrag({ mat: id, from: { type: 'store', index } }, e);
    });
    b.addEventListener('pointerup', (e) => {
      if (press?.id !== e.pointerId) return;
      press = null;
      if (actions.state().activePointerId === e.pointerId) actions.state().activePointerId = null;
    });
    b.addEventListener('pointercancel', (e) => {
      if (press?.id !== e.pointerId) return;
      press = null; dragged = true;
      if (actions.state().activePointerId === e.pointerId) actions.state().activePointerId = null;
    });
  };
  const inventory = () => {
    open('背包 · 点选查看与安装');
    const s = actions.state();
    if (!s.player.carry.length) line('背包空着。点击附近废墟挖掘，走开后自动收取。');
    const grid = document.createElement('div'); grid.className = 'item-grid'; dialog.append(grid);
    grid.classList.add('material-grid');
    s.player.carry.forEach((id, index) => materialButton(id, MATERIALS[id].name,
      () => inspect({ mat: id, from: { type: 'bag', index } }), grid));
    line(`负重 ${round(s.player.carryWeight)} · 走速 ${round(s.player.speed)}；拖动装配仍可在画面背包操作。`);
  };
  const inspect = (item) => {
    const s = actions.state(), m = MATERIALS[item.mat];
    open(m.name);
    const portrait = document.createElement('canvas'); portrait.width = portrait.height = 40;
    portrait.className = 'material-portrait'; portrait.setAttribute('aria-hidden', 'true');
    drawMaterialGlyph(portrait.getContext('2d'), 2, 2, 36, 36, item.mat, { radius: 4 });
    dialog.children[0].children[0].append(portrait);
    if (m.kind === 'repair') line(`修复量 ${m.repairUnits}；长按墙面自动消耗。`);
    else {
      const stats = document.createElement('div'); stats.className = 'stat-grid'; dialog.append(stats);
      for (const [label, value] of [['耐久', m.durability], ['强度', m.strength], ['重量', m.weight],
        ['绝缘', m.insulation], ['光滑', m.smoothness], ['气密', m.seal]]) line(`${label} ${value}`, stats);
    }
    if (m.kind !== 'repair' && nearHome()) {
      line('装配位置', dialog, 'h3');
      for (const f of s.shelter.faces) {
        const row = document.createElement('section'); dialog.append(row);
        const free = f.positions.some((p) => p.kind === m.kind && !p.mat);
        const b = button(`安装到${f.name}`, () => { actions.install(item, f.id); close(); }, row);
        b.disabled = !free;
        line(installationPreview(s, m.id, f.id), row);
      }
      line(`重量增加 ${m.weight}：以后地陷负担会提高${m.kind === 'func' ? '；功能件不提供墙面血量' : ''}。`);
    } else if (!nearHome()) line('回到庇护所附近才能安装或存取。');
    line(forecast(s));
    const navigation = actionRow();
    if (nearHome()) button(item.from.type === 'bag' ? '存入仓库' : '取到背包', () => { actions.transfer(item); close(); }, navigation);
    button(item.from.type === 'store' ? '返回仓库' : '返回背包',
      item.from.type === 'store' ? () => management('storage') : inventory, navigation);
  };
  const management = (section = 'attr', scrollTop = 0) => {
    const labels = { attr: '墙属性', storage: '仓库', craft: '合成' };
    open(section === 'storage' ? '庇护所仓库' : `庇护所管理 · ${labels[section]}`);
    if (!nearHome()) { line('回到庇护所附近才能管理。'); return; }
    const s = actions.state();
    const tabs = document.createElement('nav'); tabs.setAttribute('aria-label', '庇护所管理页签'); dialog.append(tabs);
    tabs.className = 'management-tabs';
    tabs.hidden = section === 'storage';
    for (const [key, label] of Object.entries(labels)) {
      const b = button(label, () => management(key), tabs);
      b.disabled = key === section;
    }
    if (section === 'craft') {
      dialog.className = 'management-dialog craft-overview';
      const heading = document.createElement('div'); heading.className = 'storage-heading'; dialog.append(heading);
      line('工作台', heading, 'h3'); line(`${s.workbenches.length} 台`, heading, 'small');
      s.workbenches.forEach((wb, i) => {
        const row = document.createElement('div'); row.className = 'bench-row'; dialog.append(row);
        const image = document.createElement('img'); image.src = 'assets/prop_workbench.png'; image.alt = ''; row.append(image);
        const detail = document.createElement('div'); row.append(detail);
        line(`工作台 ${String(i + 1).padStart(2, '0')}`, detail, 'h3');
        line(wb.busy ? `${wb.state === 'paused' ? '合成暂停' : '正在合成'} · ${Math.ceil(wb.left)} 秒`
          : wb.hasProduct ? MATERIALS[wb.product.mat].name : '空闲', detail);
        if (!wb.busy) {
          const label = wb.hasProduct ? `台 ${i + 1} · 取出${MATERIALS[wb.product.mat].name}` : `台 ${i + 1} · 选择材料合成`;
          const b = button(label, wb.hasProduct ? () => { close(); actions.takeCraft(i); } : () => { actions.openCraft(i); craft(); }, row);
          b.textContent = wb.hasProduct ? '收取' : '选择材料'; b.className = 'primary-action';
        }
      });
    }
    if (section === 'attr') {
      dialog.className = 'management-dialog wall-dialog';
      if (s.mode === 'tutorial' && s.tutorialStep === 3) s.tutorialInspected = true;
      const faces = document.createElement('nav'); faces.className = 'face-tabs'; faces.setAttribute('aria-label', '墙面选择'); dialog.append(faces);
      for (const face of s.shelter.faces) {
        const b = button(face.name, () => { managementFace = face.id; management('attr'); }, faces);
        b.disabled = face.id === managementFace;
      }
      for (const f of s.shelter.faces.filter(f => f.id === managementFace)) {
        const sm = s.shelter.summaryOf(f.id);
        const summary = document.createElement('div'); summary.className = 'wall-summary'; dialog.append(summary);
        const health = document.createElement('div'); health.className = 'wall-health'; summary.append(health);
        const heading = document.createElement('div'); heading.className = 'storage-heading'; health.append(heading);
        line(f.name, heading, 'h3'); line(sm.maxHp > 0 ? `耐久 ${round(sm.hp)}/${round(sm.maxHp)}` : '未安装结构件', heading, 'small');
        const hp = s.shelter.hpOf(f.id), maxHp = s.shelter.maxHpOf(f.id);
        const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
        const durability = document.createElement('div');
        durability.className = `durability-bar${maxHp <= 0 ? ' is-empty' : ratio <= .25 ? ' is-low' : ratio <= .6 ? ' is-worn' : ''}`;
        durability.setAttribute('role', 'meter'); durability.setAttribute('aria-label', `${f.name}耐久`);
        durability.setAttribute('aria-valuemin', '0'); durability.setAttribute('aria-valuemax', String(maxHp || 1));
        durability.setAttribute('aria-valuenow', String(hp));
        durability.setAttribute('aria-valuetext', maxHp > 0 ? `${round(hp)}/${round(maxHp)}` : '未安装结构材料');
        durability.title = maxHp > 0 ? `剩余 ${Math.round(ratio * 100)}%` : '未安装结构材料';
        const fill = document.createElement('span'); fill.style.width = `${ratio * 100}%`;
        durability.append(fill); health.append(durability);
        line(`补漏 ${sm.structUsed}/${sm.structTotal} · 插槽 ${sm.funcUsed}/${sm.funcTotal}`, health);
        const stats = document.createElement('div'); stats.className = 'stat-grid wall-stats'; summary.append(stats);
        for (const [label, value] of [['强度', sm.strength], ['重量', sm.weight], ['绝缘', sm.insulation],
          ['光滑', sm.smoothness], ['气密', sm.seal]]) line(`${label} ${value}`, stats);
        f.positions.forEach((p, index) => {
          if (p.mat) {
            const row = actionRow(); row.classList.add('material-line');
            line(`${MATERIALS[p.mat].name} · ${round(p.hp)}/${p.maxHp}`, row);
            const remove = button('拆下', () => { actions.remove(f.id, index); if (!s.removeConfirm) management(section); }, row);
            remove.className = 'danger-action'; remove.setAttribute('aria-label', `拆下${MATERIALS[p.mat].name}`);
          }
        });
      }
    }
    if (section === 'storage') {
      dialog.className = 'storage-dialog';
      dialog.scrollTop = 0;
      const kinds = ['repair', 'struct', 'func'];
      if (!storageKind) storageKind = kinds.find(kind => s.shelter.store[kind].length) || 'repair';
      const items = s.shelter.store[storageKind], counts = new Map();
      for (const id of items) counts.set(id, (counts.get(id) || 0) + 1);
      const layout = document.createElement('div'); layout.className = 'storage-layout'; dialog.append(layout);
      const warehouse = document.createElement('div'); warehouse.className = 'warehouse-pane'; layout.append(warehouse);
      const heading = document.createElement('div'); heading.className = 'storage-heading'; warehouse.append(heading);
      line(KIND_LABEL[storageKind], heading, 'h3'); line(`${items.length} 件 · ${counts.size} 种`, heading, 'small');
      const shelves = document.createElement('div'); shelves.className = 'warehouse-shelves'; warehouse.append(shelves);
      const grid = document.createElement('div'); grid.className = 'storage-grid storage-slots'; shelves.append(grid);
      const categories = document.createElement('nav'); categories.className = 'storage-categories';
      categories.setAttribute('aria-label', '仓库材料分类'); shelves.append(categories);
      for (const kind of kinds) {
        const b = button(`${KIND_LABEL[kind].slice(0, 2)} ${s.shelter.store[kind].length}`, () => { storageKind = kind; management('storage'); }, categories);
        b.disabled = kind === storageKind;
      }
      const caption = (b, id) => {
        b.classList.add('storage-cell');
        line(MATERIALS[id].name, b, 'span').className = 'material-name';
      };
      const emptySlots = (parent, total) => {
        while (parent.children.length < total) {
          const empty = document.createElement('div'); empty.className = 'storage-empty';
          empty.setAttribute('aria-hidden', 'true'); parent.append(empty);
        }
      };
      const base = kinds.slice(0, kinds.indexOf(storageKind)).reduce((n, kind) => n + s.shelter.store[kind].length, 0);
      for (const [id, count] of counts) { storageItem(id, base + items.indexOf(id), grid, count); caption(grid.children[grid.children.length - 1], id); }
      emptySlots(grid, 24);
      const backpack = document.createElement('div'); backpack.className = 'backpack-pane'; layout.append(backpack);
      const bagHeading = document.createElement('div'); bagHeading.className = 'storage-heading'; backpack.append(bagHeading);
      line('背包', bagHeading, 'h3'); line(`${s.player.carry.length}/${BAG_SLOTS}`, bagHeading, 'small');
      const depositGrid = document.createElement('div'); depositGrid.className = 'material-grid deposit-grid storage-slots'; backpack.append(depositGrid);
      s.player.carry.forEach((id, index) => {
        const b = materialButton(id, `存入${MATERIALS[id].name}`,
          () => { const top = dialog.scrollTop; actions.transfer({ mat: id, from: { type: 'bag', index } }); management('storage', top); }, depositGrid);
        caption(b, id);
      });
      emptySlots(depositGrid, BAG_SLOTS);
      const footer = document.createElement('footer'); footer.className = 'storage-footer'; dialog.append(footer);
      line(`库存 ${s.shelter.storeCount} 件`, footer, 'span'); line('容量不限', footer, 'span');
      dialog.scrollTop = scrollTop;
    }
  };
  const craft = () => {
    const s = actions.state(), p = s.synthPanel;
    if (!p) return;
    const scrollTop = dialog.classList.contains('craft-dialog') ? dialog.scrollTop : 0;
    open(`台 ${p.bench + 1} · 合成材料`);
    dialog.className = 'craft-dialog';
    const layout = document.createElement('div'); layout.className = 'craft-layout'; dialog.append(layout);
    const assembly = document.createElement('div'); assembly.className = 'craft-assembly'; layout.append(assembly);
    const slots = document.createElement('div'); slots.className = 'craft-slots'; assembly.append(slots);
    for (const key of ['slotA', 'slotB']) {
      const order = key === 'slotA' ? '第一件' : '第二件';
      const clear = () => { p[key] = null; craft(); };
      if (p[key]) {
        const b = materialButton(p[key], `${order} · ${MATERIALS[p[key]].name} · 取下`, clear, slots);
        const caption = document.createElement('span'); caption.className = 'material-order'; caption.textContent = order; b.append(caption);
      } else button(`${order} · 空`, clear, slots);
    }
    const recipe = p.slotA && p.slotB && recipeOf(p.slotA, p.slotB);
    line(recipe ? MATERIALS[recipe.ok].name : p.slotA && p.slotB ? '无匹配配方' : '等待投入', assembly, 'h3');
    if (recipe) {
      const preview = document.createElement('canvas'); preview.width = preview.height = 48; preview.className = 'craft-product'; assembly.append(preview);
      drawMaterialGlyph(preview.getContext('2d'), 4, 4, 40, 40, recipe.ok, { radius: 4 });
      line('30 秒 · 失败会降级或报废', assembly, 'small');
    }
    const candidates = document.createElement('div'); candidates.className = 'craft-candidates'; layout.append(candidates);
    const heading = document.createElement('div'); heading.className = 'storage-heading'; candidates.append(heading);
    line('结构材料', heading, 'h3'); line(`${s.synthOptions.length} 种`, heading, 'small');
    const grid = document.createElement('div'); grid.className = 'item-grid material-grid storage-slots'; candidates.append(grid);
    for (const o of s.synthOptions) {
      const rest = o.count - (p.slotA === o.id ? 1 : 0) - (p.slotB === o.id ? 1 : 0);
      const b = materialButton(o.id, `${MATERIALS[o.id].name} ×${rest}`, () => { actions.pickCraft(o.id); craft(); }, grid, `×${rest}`);
      b.classList.add('storage-cell'); line(MATERIALS[o.id].name, b, 'span').className = 'material-name';
      b.disabled = rest <= 0 || !!(p.slotA && p.slotB);
      if (p.slotA && !p.slotB && canSynthesize(p.slotA, o.id).ok && rest > 0) b.style.borderColor = '#a7c86d';
    }
    if (!s.synthOptions.length) line('暂无结构材料', candidates);
    const footer = document.createElement('footer'); footer.className = 'tutorial-footer'; dialog.append(footer);
    const start = button('开始合成', () => { actions.startCraft(); close(); }, footer); start.className = 'primary-action';
    start.disabled = !recipe;
    dialog.scrollTop = scrollTop;
  };
  const pauseMenu = () => {
    open('帮助 · 已暂停');
    dialog.className = 'pause-dialog';
    wasPaused = false; // 帮助关闭后自动继续，包括从后台暂停进入帮助。
    const controls = document.createElement('div'); controls.className = 'menu-actions'; dialog.append(controls);
    const primary = actionRow(controls);
    button('继续游戏', () => { wasPaused = false; close(); }, primary).className = 'primary-action';
    if (actions.state().mode === 'tutorial') button('查看教学说明', () => tutorialIntro(), primary);
    const settings = actionRow(controls);
    const toggle = (label, enabled, fn) => {
      const b = button(`${label}：${enabled ? '开' : '关'}`, fn, settings);
      b.className = 'setting-toggle'; b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(enabled));
    };
    toggle('灯', actions.state().flashlight, () => { actions.light(); pauseMenu(); });
    toggle('音效', !muted, () => { muted = !muted; audio.setMuted(muted); pauseMenu(); });
    toggle('音乐', !musicMuted, () => { musicMuted = !musicMuted; audio.setMusicMuted(musicMuted); pauseMenu(); });
    const navigation = actionRow(controls);
    button('重开', restartConfirm, navigation).className = 'danger-action';
    button(actions.state().mode === 'tutorial' ? '退出教学' : '返回主界面', returnHome, navigation);
    line(actions.state().mode === 'tutorial' ? '教学已暂停，练习不会写入正式存档。' : actions.state().saveStatus || '当前进度已保存。');
    line('操作说明', dialog, 'h3'); HELP_LINES.forEach((t) => line(t));
    line('点背包图标展开或收起；墙属性与仓库图标在家附近显示。点“帮助”暂停，关闭继续；灯、音乐、音效和重开在这里设置。准备期点倒计时旁“提前开波”。');
  };
  const restartConfirm = () => {
    open('重新开始？');
    dialog.className = 'confirm-dialog';
    line(actions.state().mode === 'tutorial' ? '重新开始教学，正式存档不受影响。' : '会替换当前续玩记录，重新从第 1 波开始。');
    const choices = actionRow();
    button('取消', actions.state().screen === 'home' ? close : pauseMenu, choices);
    button('确认重开', () => { wasPaused = false; actions.restart(); close(); }, choices).className = 'danger-action';
  };
  const arrowButton = (label, id, path, fn) => {
    const b = button(label, fn); b.id = id; b.className = 'touch-control';
    b.setAttribute('aria-label', label); b.title = label;
    b.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="${path}"/></svg>`;
    return b;
  };
  const held = new Map();
  const syncMovement = () => {
    actions.move(Math.sign([...held.values()].reduce((sum, dir) => sum + dir, 0)));
    leftButton.classList.toggle('is-held', [...held.values()].includes(-1));
    rightButton.classList.toggle('is-held', [...held.values()].includes(1));
  };
  const releaseMovement = () => { held.clear(); syncMovement(); };
  const leftButton = arrowButton('向左移动', 'move-left-button', 'M20 6 L10 16 L20 26 M11 16 H28', () => {});
  const rightButton = arrowButton('向右移动', 'move-right-button', 'M12 6 L22 16 L12 26 M4 16 H21', () => {});
  for (const [b, dir] of [[leftButton, -1], [rightButton, 1]]) {
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || actions.state().paused || actions.state().endSummary) return;
      e.preventDefault(); b.setPointerCapture(e.pointerId);
      held.set(e.pointerId, dir); syncMovement();
    });
    const release = (e) => { if (held.delete(e.pointerId)) syncMovement(); };
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    b.addEventListener('lostpointercapture', release);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const jumpButton = arrowButton('跳跃', 'jump-button', 'M6 20 L16 10 L26 20 M16 11 V28',
    (e) => { if (!e.detail) actions.jump(); });
  jumpButton.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); actions.jump(); } });
  const pauseButton = button('帮助', pauseMenu); pauseButton.id = 'pause-button';
  pauseButton.title = '帮助与暂停';
  const helpIcon = document.createElement('img'); helpIcon.src = 'assets/ui_help.png'; helpIcon.alt = '';
  const helpLabel = document.createElement('span'); helpLabel.textContent = '帮助';
  pauseButton.replaceChildren(helpIcon, helpLabel);
  const exitTutorial = button('退出教学', returnHome); exitTutorial.id = 'exit-tutorial-button'; exitTutorial.hidden = true;
  const reviewTutorial = button('教学回顾', () => tutorialReview()); reviewTutorial.id = 'review-tutorial-button'; reviewTutorial.hidden = true;
  const tutorialPages = [
    { title: '移动与跳跃', items: [
      ['left', '向左移动', '按住左箭头向左走，松手停止。'],
      ['right', '向右移动', '按住右箭头向右走；也可点地面，让角色走过去。'],
      ['jump', '跳跃', '点右下上箭头起跳。移动时可用另一根手指同时跳跃，用来跨地形。'],
    ] },
    { title: '状态与地图', items: [
      ['ui_status', '状态图标', '心形图标展开状态栏，查看血量、波次、倒计时、负重与当前灾害。'],
      ['ui_map', '小地图', '地图图标展开或收起附近地图，查看自己、庇护所和已探索的路线。出门先认方向，返程沿熟悉路线走。'],
      ['−', '收起与移动面板', '面板右上减号用于收起；收起后点原图标展开。背包与小地图可拖动标题条换位置。'],
    ] },
    { title: '背包与庇护所', items: [
      ['ui_bag', '背包', '点背包图标展开或收起，图标始终保留。点材料看详情，也可拖动材料装墙或存仓库。背包里的材料越重，人物移动越慢；存入仓库、装到墙上或丢弃后，负重减轻，速度会恢复。'],
      ['ui_attr', '墙属性', '盾牌图标在家附近出现。查看各面墙的耐久条、补漏位和属性；长按场景墙面消耗修复材料维修。'],
      ['ui_storage', '仓库', '箱子图标在家附近出现。背包材料可拖入仓库，仓库材料可拖到背包或墙面。教学无需来回存取，了解后继续即可。'],
    ] },
    { title: '帮助、丢弃与撤销', items: [
      ['ui_help', '帮助与暂停', '点问号暂停，关闭后继续。这里可开关灯、音乐和音效；重开需确认，也可返回主界面。'],
      ['trash', '丢弃', '先展开背包，按住要丢弃的材料，拖到右上角垃圾桶内再松手；仓库材料也可直接拖到垃圾桶。只点垃圾桶不会丢弃，拖到空白处松手也不会删除。'],
      ['↶', '撤销丢弃', '丢弃后垃圾桶下面出现撤销按钮，3 秒内可以找回；超时后材料消失。'],
    ] },
    { title: '材料与墙面格位', items: [
      ['material:t1_hard', '结构材料', '提供墙面耐久，放进实线补漏位。完好才可取回，破损时拆除会报废。'],
      ['material:rod1', '功能材料', '提供防护属性，放进虚线插槽位；不增加墙面耐久。点材料详情查看具体作用。'],
      ['material:patch_kit', '修复材料', '靠近庇护所，持续按住受损墙体，耐久修满再松手。背包或仓库里的修补浆会自动消耗，不用拖到墙上，也不用先收起背包；只有面板挡住墙面时才需移开或收起。完全打穿则要重新装结构材料。修复练习开始时会把修补浆发到背包。'],
      ['material:patch_kit', '灾难期：边修边守', '灾难进行中也能修复！留在庇护所附近，持续按住受损墙面，消耗背包或仓库里的修复材料恢复耐久，帮助墙体继续抵挡攻击。优先修正在受击的墙面；抢修不代表无敌，耐久耗尽后要重新装结构材料。'],
      ['material:t1_hard', '破损材料：可能丢失', '墙上的结构材料破损后，再次受击时可能掉落并永久丢失，越破损越容易掉；及时修满可避免这类破损掉落。破损状态下拆除也会直接报废，想回收应先修满再取下。'],
      ['+', '扩展格位', '获得空位额度后，墙上的绿色虚线加号可增加该面的补漏格位。'],
    ] },
    { title: '工作台与场景入口', items: [
      ['prop_workbench', '工作台与合成', '走近屋内工作台再点它，按顺序选两件结构材料，绿色边框表示能合成；完成后走近工作台收取。'],
      ['▶', '提前开波', '准备阶段在倒计时旁。正式局离家后解锁，提前开波能换材料奖励；先确认人在屋内、材料装好、墙已维修，再考虑奖励。教学里会单独练习。'],
      ['prop_lift', '升降台', '走到升降台上再点它，消耗一件结构材料升到上层桥。'],
      ['prop_entrance', '地穴入口', '走近入口后点它进入或离开地下；灾害开始会随机震到整张地表的有效落点，不保证在家。不要把震出当作安全返程。'],
      ['prop_tunnel', '隧道', '走近隧道后点它，可以在相连的洞口之间移动。'],
    ] },
    { title: '墙体属性与耐久', items: [
      ['material:t1_hard', '耐久：墙的血量', '结构材料提供耐久。墙完全打穿后防护失效，需要重新装结构材料；还没打穿时，长按墙面消耗修复材料维修。出门前和返家后都要检查。'],
      ['ui_attr', '强度：抵挡冲击', '强度削减陨石雨、龙卷风、兽潮和地陷的墙体伤害。陨石主要打顶盖，兽潮主要打门，地陷打地基；地基坏后还会波及其他墙。强度不能代替绝缘、光滑或气密。'],
      ['material:t4_hard', '重量：防风也有代价', '重量主要抵挡龙卷风，也辅助抵挡兽潮；但全屋越重，地陷伤害越高，功能材料的重量也算在内。不要只堆最重的材料，要看下一波灾害。'],
      ['material:t1_soft', '绝缘性：削减雷电', '雷电先由避雷针和顶盖绝缘性减伤，剩余伤害再由人物与墙体分摊。绝缘越高，剩余总量越少；不是只保人物，也能减轻墙损。'],
    ] },
    { title: '穿透防护与有效高度', items: [
      ['material:t3_gloss', '光滑度：削减光束', '死亡光束先由反光镜和光滑度减伤，再分给人物与墙体；目标是顶盖、左墙和右墙。材料强度高不等于能挡光束，要关注这些面的光滑度。'],
      ['material:t1_seal', '气密性：阻挡毒雾', '毒雾从顶盖、左墙、右墙和门渗入，不经过地基；这些面的气密性和净化器减轻人物伤害。毒雾不扣墙体耐久，墙没掉血也可能有人受伤。'],
      ['ui_attr', '高度：改变伤害分摊', '全屋已安装结构材料的平均等级越高，有效高度越低：虫级200、龙级100。雷电和光束先减伤，再分摊；高时人物70%／墙体30%，低时人物30%／墙体70%。墙体耐久不够的部分转给人物；回家并非无敌。'],
      ['material:rod1', '功能材料：对症防护', '避雷针防雷电，反光镜防光束，净化器防毒雾，平衡架防地陷，固定索防龙卷风，武器防兽潮。放在该灾害攻击面的插槽里才发挥对应抵消作用；功能件不提供墙体耐久，也不参与平均等级算高度。'],
    ] },
    { title: '时间、取舍与路线规划', items: [
      ['ui_status', '注意时间：先留返程余量', '正式局每波准备期从离开庇护所后开始计时。反复看剩余秒数，给返程、装配和维修留时间。本教学先停住计时让你练习，正式局不要照着练习节奏一直挖。'],
      ['ui_map', '规划路线：先定目标再出门', '先看下一波灾害，选需要的防护材料；再用附近地图选择熟悉的废墟、入口和返程方向。估算来回路程，负重会降低速度；不要临近开波才探索陌生深处。'],
      ['ui_bag', '不要贪心：够用就返程', '背包材料的重量会降低人物移速，不是只有装满才变慢；重材料多时要更早返程。背包接近装满、墙体需要维修或剩余时间只够返程时，就收料回家。深挖会增加坍塌或引怪风险，少挖一层也比材料留在外面、自己来不及回家好。先保命，再考虑多拿。'],
      ['▶', '返程例子：别把时间花光', '例如去程约20秒、返程约20秒，还要留20秒装配维修；只剩40秒时就优先返程，别再开一处废墟。升降、绕路和负重都可能拖慢速度，估算要留余量；提前开波奖励也别贪。'],
    ] },
  ];
  const tutorialIntro = (page = 0) => {
    const lesson = tutorialPages[page]; tutorialPage = page;
    open(`生存教学 · ${page + 1}/${tutorialPages.length} · ${lesson.title}`, returnHome, '退出教学');
    dialog.className = 'tutorial-dialog';
    const grid = document.createElement('div'); grid.className = 'tutorial-icon-grid'; dialog.append(grid);
    for (const [icon, name, description] of lesson.items) {
      const card = document.createElement('article'); card.className = 'tutorial-icon-card'; grid.append(card);
      const glyph = document.createElement('div'); glyph.className = 'tutorial-icon'; glyph.setAttribute('aria-hidden', 'true'); card.append(glyph);
      if (['left', 'right', 'jump'].includes(icon)) {
        glyph.append(({ left: leftButton, right: rightButton, jump: jumpButton })[icon].querySelector('svg').cloneNode(true));
      } else if (icon.startsWith('material:')) {
        const c = document.createElement('canvas'); c.width = c.height = 48;
        drawMaterialGlyph(c.getContext('2d'), 4, 4, 40, 40, icon.slice(9), { radius: 6 }); glyph.append(c);
      } else if (icon.startsWith('ui_') || icon.startsWith('prop_')) {
        const img = document.createElement('img'); img.src = `assets/${icon}.png`; img.alt = ''; glyph.append(img);
      } else if (icon === 'trash') {
        glyph.innerHTML = '<svg viewBox="0 0 32 32"><path d="M6 8H26M12 4H20M9 9V28H23V9M14 13V24M18 13V24"/></svg>';
      } else glyph.textContent = icon;
      const text = document.createElement('div'); card.append(text); line(name, text, 'h3'); line(description, text);
    }
    const footer = document.createElement('footer'); footer.className = 'tutorial-footer'; dialog.append(footer);
    if (page > 0) button('上一组图标', () => tutorialIntro(page - 1), footer);
    if (page + 1 < tutorialPages.length) button('下一组图标', () => tutorialIntro(page + 1), footer);
    else button(actions.state().tutorialDone ? '回到练习' : '开始练习', () => { wasPaused = false; close(); }, footer);
    dialog.scrollTop = 0;
  };
  const tutorialReview = () => {
    const s = actions.state(); s.tutorialReviewed = true;
    open('教学回顾 · 由你决定何时结束', () => { wasPaused = false; close(); }, '继续练习');
    line(`这次陨石：墙损 ${round(s.lastThreat?.damage || 0)}，人伤 ${round(s.lastThreat?.playerDamage || 0)}。`);
    line(`顶盖剩余耐久 ${round(s.shelter.hpOf('roof'))}/${round(s.shelter.maxHpOf('roof'))}。墙替你承受了攻击，受损后要及时维修。`);
    line(`修复练习已完成：长按顶盖消耗修复量 ${round(s.tutorialRepairSpent)}，恢复墙体耐久。修补浆直接从背包或仓库扣除；彻底破坏的墙要重新安装。`);
    line('灾难期也能边修边守：在庇护所附近长按受损墙体，消耗修复材料恢复耐久。破损结构材料再次受击可能永久掉落；拆除破损材料也会报废，先修满再回收。');
    line('丢弃操作：展开背包 → 按住材料 → 拖到右上垃圾桶内松手。仓库材料也能这样丢弃；误丢后点垃圾桶下方的撤销，只有 3 秒机会。');
    line('你已练习：移动与跳跃、挖掘与收取、顶盖装配、查看墙属性、提前开波、长按修复。');
    line('正式局出门前：看下一波灾害与墙体属性 → 定目标和返程路线 → 留足返程、装配、维修时间。不要贪心，材料够用就回家。');
    line('记住：重量防风却加重地陷；绝缘防雷、光滑防光束、气密防毒雾。高级结构材料降低有效高度，让雷电和光束少分给人物，但仍要及时维修墙体。');
    line('可以继续走动、打开背包、查看墙属性或仓库，熟悉图标位置。练习不会保存到正式游戏。');
    button('重新查看图标', () => tutorialIntro(), dialog);
    button('结束教学，返回主界面', returnHome, dialog);
  };
  const canvas = document.querySelector('canvas');
  const guideArea = () => {
    const inset = { left: 0, right: 0, top: 0, bottom: 0 };
    return { left: inset.left + 8, top: inset.top + 8, right: innerWidth - inset.right - 8, bottom: innerHeight - inset.bottom - 8 };
  };
  let handTarget = null;
  const bagCoversWorld = (s, x, y) => {
    if (UI_LAYOUT.bag.collapsed) return false;
    const r = bagPanelRect(), px = (x - s.camera.x) * CAMERA.zoom,
      py = (y + s.camera.y - CAMERA_ANCHOR_Y) * CAMERA.zoom + CAMERA_ANCHOR_Y;
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  };
  const bagCoversRoof = (s) => { const r = shelterRects().roof; return bagCoversWorld(s, r.x + r.w * .72, r.y + r.h / 2); };
  const updateHand = (s, now) => {
    if (hand.width !== innerWidth || hand.height !== innerHeight) {
      hand.width = innerWidth; hand.height = innerHeight;
      hand.style.width = `${innerWidth}px`; hand.style.height = `${innerHeight}px`;
    }
    const ctx = hand.getContext('2d'); ctx.clearRect(0, 0, hand.width, hand.height);
    handTarget = null; hand.hidden = true;
    if (s.screen === 'home' || s.mode !== 'tutorial' || s.tutorialDone || s.paused || s.endSummary || opened || s.synthPanel || s.drag || s.press || held.size || s.player.isBusy) return;
    const bounds = canvas.getBoundingClientRect(), scale = bounds.width / VIEW.w, scaleY = bounds.height / VIEW.h;
    const center = (r) => ({ x: bounds.left + (r.x + r.w / 2) * scale, y: bounds.top + (r.y + r.h / 2) * scaleY });
    const buttonCenter = (b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const world = (x, y) => ({ x: bounds.left + (x - s.camera.x) * CAMERA.zoom * scale,
      y: bounds.top + ((y + s.camera.y - CAMERA_ANCHOR_Y) * CAMERA.zoom + CAMERA_ANCHOR_Y) * scaleY });
    const roof = shelterRects().roof, roofPoint = world(roof.x + roof.w * .72, roof.y + roof.h / 2);
    let target, to, gesture = 'tap';
    if (s.tutorialStep === 0) {
      target = buttonCenter(s.tutorialJumped ? rightButton : Math.abs(s.player.x - SHELTER.cx) > 40 ? jumpButton : rightButton);
      if (target.x !== buttonCenter(jumpButton).x) gesture = 'hold';
    } else if (s.tutorialStep === 1) {
      const spot = s.world.loot[0];
      if (spot.pending.length) { target = buttonCenter(leftButton); gesture = 'hold'; }
      else if (!atSpot(spot, s.player.x, s.player.y)) { target = buttonCenter(s.player.x < spot.x ? rightButton : leftButton); gesture = 'hold'; }
      else target = bagCoversWorld(s, spot.x, spot.y - 18) ? center(uiLabelRect('bag')) : world(spot.x, spot.y - 18);
    } else if ([2, 3, 4, 6].includes(s.tutorialStep) && !nearHome()) {
      target = buttonCenter(s.player.x > SHELTER.cx ? leftButton : rightButton); gesture = 'hold';
    } else if (s.tutorialStep === 2) {
      const index = s.player.carry.indexOf('t1_hard');
      if (index < 0) target = center(uiLabelRect('storage'));
      else if (UI_LAYOUT.bag.collapsed) target = center(uiLabelRect('bag'));
      else { target = center(bagSlotRect(index)); to = roofPoint; gesture = 'drag'; }
    } else if (s.tutorialStep === 3) target = center(uiLabelRect('attr'));
    else if (s.tutorialStep === 4) {
      if (UI_LAYOUT.hud.collapsed) target = center(uiLabelRect('hud'));
      else target = center(skipBtnRect());
    } else if (s.tutorialStep === 6) {
      if (bagCoversRoof(s)) target = center(uiLabelRect('bag'));
      else { target = roofPoint; gesture = 'hold'; }
    }
    const area = guideArea();
    const visible = (p) => p && p.x >= area.left && p.x <= area.right && p.y >= area.top && p.y <= area.bottom;
    if (!visible(target) || (to && !visible(to))) return;
    hand.hidden = false; handTarget = target;
    hand.dataset.gesture = gesture; hand.dataset.targetX = String(target.x); hand.dataset.targetY = String(target.y);
    const phase = (now / 1800) % 1;
    let x = target.x, y = target.y;
    ctx.save(); ctx.strokeStyle = '#f6c77b'; ctx.lineWidth = 3;
    if (to) {
      ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.setLineDash([]);
      const t = Math.max(0, Math.min(1, (phase - .2) / .65)); x += (to.x - x) * t; y += (to.y - y) * t;
      ctx.beginPath(); ctx.arc(to.x, to.y, 12, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(x, y, gesture === 'hold' ? 16 : 12 + phase * 6, -.5 * Math.PI,
      gesture === 'hold' ? -.5 * Math.PI + phase * Math.PI * 2 : Math.PI * 1.5); ctx.stroke();
    const flipX = x + 42 > area.right ? -1 : 1, flipY = y + 52 > area.bottom ? -1 : 1;
    ctx.translate(x, y + (gesture === 'tap' ? Math.sin(phase * Math.PI * 2) * 3 : 0)); ctx.scale(flipX, flipY);
    ctx.fillStyle = '#fff2da'; ctx.strokeStyle = '#5d3d28'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(-5, -2, -5, 5); ctx.lineTo(-5, 25);
    ctx.lineTo(-10, 19); ctx.quadraticCurveTo(-18, 17, -16, 25); ctx.lineTo(-6, 42);
    ctx.quadraticCurveTo(-3, 48, 5, 48); ctx.lineTo(22, 48); ctx.quadraticCurveTo(29, 46, 29, 37);
    ctx.lineTo(29, 22); ctx.quadraticCurveTo(29, 16, 22, 18); ctx.quadraticCurveTo(19, 11, 13, 15);
    ctx.quadraticCurveTo(9, 9, 4, 13); ctx.lineTo(4, 5); ctx.quadraticCurveTo(4, 0, 0, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  };
  const placeCue = (s) => {
    const bounds = canvas.getBoundingClientRect(), scale = bounds.width / VIEW.w;
    const screenRect = (r) => ({ x: bounds.left + r.x * scale, y: bounds.top + r.y * scale,
      w: r.w * scale, h: r.h * scale });
    const px = bounds.left + (s.player.x - s.camera.x) * CAMERA.zoom * scale;
    const py = bounds.top + ((s.player.y + s.camera.y - CAMERA_ANCHOR_Y) * CAMERA.zoom + CAMERA_ANCHOR_Y) * scale;
    const obstacles = [screenRect(UI_LAYOUT.hud.collapsed ? uiLabelRect('hud') : hudPanelRect()),
      screenRect(UI_LAYOUT.minimap.collapsed ? uiLabelRect('minimap') : minimapRect()), screenRect(trashRect()),
      ...(nearHome() ? [screenRect(uiLabelRect('attr')), screenRect(uiLabelRect('storage'))] : []),
      screenRect(UI_LAYOUT.bag.collapsed ? uiLabelRect('bag') : bagPanelRect()),
      ...(!UI_LAYOUT.bag.collapsed ? [screenRect(uiLabelRect('bag')), screenRect(uiTitleBarRect('bag'))] : []),
      ...(handTarget ? [{ x: handTarget.x - 18, y: handTarget.y - 18, w: 64, h: 72 }] : []),
      { x: px - 28 * CAMERA.zoom * scale, y: py - 64 * CAMERA.zoom * scale,
        w: 56 * CAMERA.zoom * scale, h: 80 * CAMERA.zoom * scale },
      ...[...bar.querySelectorAll('button:not([hidden])')].map((b) => {
        const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };
      })];
    cue.hidden = false;
    const w = cue.offsetWidth, h = cue.offsetHeight, gap = 8;
    // 搜索空位；进屋新增图标或展开背包时换位置，不再直接隐藏教学。
    const area = guideArea(), candidates = [];
    const xs = [(area.left + area.right - w) / 2, area.left, area.right - w];
    for (let x = area.left; x <= area.right - w; x += 24) xs.push(x);
    if (bounds.top >= h + gap * 2) candidates.push({ x: xs[0], y: bounds.top - h - gap });
    for (let y = Math.max(area.top, bounds.top + 64); y <= area.bottom - h; y += 12) for (const x of xs) candidates.push({ x, y });
    for (let y = area.top; y <= area.bottom - h; y += 12) for (const x of xs) candidates.push({ x, y });
    const overlap = (p) => obstacles.reduce((total, o) => total
      + Math.max(0, Math.min(p.x + w, o.x + o.w) - Math.max(p.x, o.x))
      * Math.max(0, Math.min(p.y + h, o.y + o.h) - Math.max(p.y, o.y)), 0);
    let p = candidates[0], score = overlap(p);
    for (const candidate of candidates) {
      if (!score) break;
      const nextScore = overlap(candidate);
      if (nextScore < score) { p = candidate; score = nextScore; }
    }
    cue.style.left = `${p.x}px`; cue.style.top = `${p.y}px`;
  };

  return {
    pauseMenu,
    management,
    restartConfirm,
    showHome,
    hideHome: () => { home.hidden = true; bar.hidden = false; },
    tutorialIntro,
    releaseMovement,
    stopSounds: audio.stopAll,
    resetSounds: () => audio.stopAll(true),
    sound(kind, repeats = 1) {
      if (!muted) audio.play(kind, repeats);
    },
    unlockAudio: audio.unlock,
    update(now) {
      const s = actions.state();
      if (s.screen !== 'home') bar.hidden = !!s.endSummary;
      updateHand(s, now);
      if (s.screen === 'home') return;
      audio.syncMusic(s.paused || s.player.dead || s.endSummary ? null
        : s.director.phase === Phase.DISASTER ? 'disaster' : 'explore');
      audio.syncDisasters(!s.paused && !s.player.dead && !s.endSummary && s.director.phase === Phase.DISASTER
        ? s.director.active.map((d) => d.id) : []);
      if (s.endSummary) { cue.textContent = ''; cue.hidden = true; return; }
      if (s.mode === 'tutorial' && s.tutorialDone && !s.tutorialReviewed && !opened) tutorialReview();
      if (s.inspectItem && !opened) { inspect(s.inspectItem); s.inspectItem = null; }
      if (s.synthPanel && !opened) craft();
      if (s.removeConfirm && dialog.dataset.removal !== String(s.removeConfirm.at)) {
        const q = s.removeConfirm;
        open('破损结构件 · 拆除即报废');
        dialog.dataset.removal = String(q.at);
        line(`${MATERIALS[q.mat].name} 已破损。拆除会永久失去材料；想回收请先长按墙面修满。`);
        button('保留材料', close, dialog);
        button('确认拆除并报废', () => { actions.confirmRemoval(q); close(); }, dialog);
      }
      if (now - lastUpdate < 100) { if (cue.textContent) placeCue(s); return; }
      lastUpdate = now;
      // 暂停入口在垃圾桶左侧，按实际画布缩放留出间距，避免手机缩放后重叠。
      const bounds = canvas.getBoundingClientRect();
      const trash = trashRect(), scale = bounds.width / 1280;
      pauseButton.style.left = `${bounds.left + trash.x * scale - pauseButton.offsetWidth - 12}px`;
      pauseButton.style.top = `${bounds.top + trash.y * scale}px`;
      exitTutorial.hidden = s.mode !== 'tutorial';
      exitTutorial.style.left = `${parseFloat(pauseButton.style.left) - exitTutorial.offsetWidth - 8}px`;
      exitTutorial.style.top = pauseButton.style.top;
      reviewTutorial.hidden = s.mode !== 'tutorial' || !s.tutorialDone;
      const reviewAbove = bounds.top >= reviewTutorial.offsetHeight + 16;
      reviewTutorial.style.left = `${reviewAbove ? bounds.left + (bounds.width - reviewTutorial.offsetWidth) / 2
        : parseFloat(exitTutorial.style.left) - reviewTutorial.offsetWidth - 8}px`;
      reviewTutorial.style.top = `${reviewAbove ? bounds.top - reviewTutorial.offsetHeight - 8 : parseFloat(exitTutorial.style.top)}px`;
      // 底部材料条给触屏按键让位；正在拖背包时不接管玩家手势。
      if (!s.uiDrag && !s.uiPending) {
        const icon = uiLabelRect('bag'), panel = bagPanelRect();
        const bag = { left: bounds.left + icon.x * scale, top: bounds.top + Math.min(icon.y, panel.y) * scale,
          right: bounds.left + Math.max(icon.x + icon.w, panel.x + panel.w) * scale,
          bottom: bounds.top + Math.max(icon.y + icon.h, panel.y + panel.h) * scale };
        const left = leftButton.getBoundingClientRect(), right = rightButton.getBoundingClientRect(), jump = jumpButton.getBoundingClientRect();
        const overlaps = (r) => bag.left < r.right && bag.right > r.left && bag.top < r.bottom && bag.bottom > r.top;
        if ([left, right, jump].some(overlaps)) {
          const x = (right.right + 8 + jump.left - 8 - (bag.right - bag.left)) / 2;
          uiSetOffset('bag', UI_LAYOUT.bag.dx + (x - bag.left) / scale, UI_LAYOUT.bag.dy);
        }
      }
      let guide = '';
      if (!s.paused && !s.endSummary && s.leakAlert) guide = `${s.leakAlert.name}${s.leakAlert.kind === 'split' ? '分摊伤害' : '突破防护'} · 受到伤害`;
      else if (!s.paused && !s.endSummary && s.mode === 'tutorial' && !s.tutorialDone) {
        if (s.tutorialStep === 0) guide = '1/7 按左下箭头移动，再按右下箭头跳跃。手指是示范，不会替你操作。';
        else if (s.tutorialStep === 2) guide = !nearHome() ? '3/7 先按方向键回家，再把材料装到顶盖。'
          : s.shelter.store.struct.includes('t1_hard')
          ? '3/7 打开仓库，把甲壳板拖到顶盖补漏位；也可点材料选择安装。'
          : '3/7 展开背包，把甲壳板拖到顶盖补漏位；也可点材料选择安装。';
        else if (s.tutorialStep === 3) guide = '4/7 点盾牌查看耐久与属性；先看下一波，再选防护材料。';
        else if (s.tutorialStep === 4) guide = UI_LAYOUT.hud.collapsed ? '5/7 点生命图标展开状态，再点提前开波。确认顶盖装好，正式局要留返程时间。'
          : '5/7 确认已回家且顶盖装好，再点提前开波；正式局要留返程时间。';
        else if (s.tutorialStep === 5) guide = s.tutorialObserveLeft > 0
          ? '6/7 顶盖承受了陨石，观察耐久与角色血量。接下来练习修复。' : '6/7 等待陨石，观察顶盖如何保护角色。';
        else if (s.tutorialStep === 6) guide = !nearHome() ? '7/7 先回到庇护所附近，再长按顶盖修复。'
          : s.wallPocket ? '7/7 先关闭墙体收纳，再持续按住受损顶盖。修补浆自动消耗，不用拖上墙。'
          : bagCoversRoof(s) ? '7/7 背包挡住了顶盖，点背包图标收起遮挡；墙面露出即可长按修复。'
          : '7/7 持续按住受损顶盖修满。背包已有修补浆，自动消耗，不用收起背包。';
        else if (s.world.loot.some((l) => l.pending.length)) guide = '2/7 走开一步收料再回家；够用就走，不要贪心。';
        else guide = bagCoversWorld(s, s.world.loot[0].x, s.world.loot[0].y - 18) && atSpot(s.world.loot[0], s.player.x, s.player.y)
          ? '2/7 背包挡住了废墟，点背包图标收起遮挡，再点废墟挖掘。'
          : '2/7 走近绿色圈内废墟再点挖掘；先规划好回家路线。';
      }
      cue.textContent = guide;
      cue.hidden = !guide;
      if (guide) placeCue(s);
    },
  };
}
