/* =====================================================================
 * 浪尖酷跑 —— 冲浪版跑酷原型（Canvas + 原生 JavaScript，无需构建）
 *
 * 核心差异点："浪是活的"。海面由多层正弦波叠加 + 每一波浪的隆起轮廓组成，
 * 浪面高度即"地面"，玩家需要读浪、预判、借浪起跳。
 *
 * 模块划分：
 *   1. 配置与工具函数
 *   2. 游戏状态（gameState，所有可变状态集中于此）
 *   3. 浪面生成（浪型队列、浪面采样、大浪道具）
 *   4. 障碍物与道具（按浪型生成内容、鲨鱼突袭）
 *   5. 玩家控制（输入、跳跃、潜水、换道、转体、平衡/游泳模式）
 *   6. 碰撞检测（圆形近似）
 *   7. 粒子与飘字
 *   8. 场景渲染（天空、浪面、浪管、障碍、角色）
 *   9. UI 渲染（平衡条、浪况预报、按钮、菜单/结算）
 *  10. 输入绑定（键盘 + 触屏/鼠标滑动）
 *  11. 主循环（requestAnimationFrame + 固定时间步长）
 * ===================================================================== */
'use strict';

/* =====================================================================
 * 1. 配置与工具函数
 * ===================================================================== */

// 逻辑分辨率（画布按比例缩放适配屏幕）
const W = 960;
const H = 540;

const CONFIG = {
  STEP: 1 / 60,            // 固定逻辑步长（秒）
  PLAYER_X: 220,           // 玩家在屏幕上的固定 x 坐标
  // 3 条浪道：0 = 远景（后），1 = 中景，2 = 近景（前）。用缩放和透明度表现远近
  LANES: [
    { baseY: 300, scale: 0.72, alpha: 0.7, top: '#8fd8f2', bottom: '#2f78ad' },
    { baseY: 392, scale: 0.86, alpha: 0.86, top: '#62c3ea', bottom: '#1d5a92' },
    { baseY: 478, scale: 1.0, alpha: 1.0, top: '#45afe2', bottom: '#0a3567' },
  ],
  BASE_SPEED: 300,         // 初始滑行速度（像素/秒）
  MAX_SPEED: 620,          // 最高速度
  SPEED_GAIN: 3.5,         // 每秒提速
  GRAVITY: 1600,           // 重力（会乘以浪道缩放，保证各浪道滞空时间一致）
  JUMP_H: 105,             // 普通跳跃高度
  CREST_BONUS_MAX: 130,    // 浪峰起跳最大额外高度
  LANE_SWITCH_TIME: 0.16,  // 换道耗时
  DIVE_TIME: 0.6,          // 一次压板潜水持续时间
  SPIN_TIME: 0.42,         // 一次 360° 转体耗时
  SWIM_TIME: 3,            // 游泳模式持续时间
  BALANCE_MAX: 100,
  COST: {                  // 平衡消耗
    jump: 12,
    barrelEnter: 8,
    barrelPerSec: 8,
    spin: 8,
    badLanding: 25,
    jelly: 30,
    whitewaterPerSec: 55,
  },
  RECOVER_PER_SEC: 6,      // 平稳滑行时每秒恢复的平衡
  SCORE: {
    distPerPx: 0.05,       // 基础滑行分
    barrelPerSec: 120,     // 浪管内每秒加分
    barrelExit: 200,       // 成功出管基础奖励
    crestJump: 30,
    shell: 50,
    gold: 100,
    spin: 200,
  },
  SHARK_SPEED: 160,        // 鲨鱼相对海面的冲刺速度
  MAX_POWER: 3,            // "召唤大浪"最多储存数量
};

// 三种浪型的参数。skew 控制浪峰位置（>1 浪峰靠后、前坡平缓；<1 浪峰靠前）
const WAVE_TYPES = {
  flat:   { name: '平浪', len: [520, 680], amp: [16, 26],  skew: 1.0,  color: '#5fd1b5' },
  barrel: { name: '卷浪', len: [800, 940], amp: [96, 112], skew: 1.3,  color: '#3d8bff' },
  break:  { name: '碎浪', len: [540, 660], amp: [55, 68],  skew: 0.85, color: '#ffffff' },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* =====================================================================
 * 2. 游戏状态 —— 所有可变状态集中在 gameState 对象
 * ===================================================================== */

function loadBest() {
  try { return Number(localStorage.getItem('surf_runner_best')) || 0; } catch (e) { return 0; }
}
function saveBest(v) {
  try { localStorage.setItem('surf_runner_best', String(v)); } catch (e) { /* 忽略 */ }
}

function createGameState(phase) {
  return {
    phase,                 // 'menu' | 'playing' | 'paused' | 'over'
    time: 0,               // 全局时间（驱动浪面细碎起伏）
    elapsed: 0,            // 本局游戏时长
    speed: CONFIG.BASE_SPEED,
    score: 0,
    best: loadBest(),
    overReason: '',
    // 浪面
    waves: [],             // 按顺序首尾相接的浪队列
    nextWaveX: -W,         // 下一波浪的起始世界坐标
    waveCount: 0,
    waveId: 0,
    // 场景对象
    obstacles: [],         // 礁石 / 水母 / 鲨鱼
    items: [],             // 贝壳 / 金贝壳 / 召唤大浪
    particles: [],
    texts: [],
    sharkTimer: 9,         // 距离下一次鲨鱼突袭的秒数
    powerCharges: 0,       // 已收集的"召唤大浪"数量
    shake: 0,              // 屏幕震动强度
    flash: 0,              // 屏幕闪白
    // 玩家
    player: {
      wx: 0,               // 世界坐标 x（随滑行不断增加）
      lane: 1,             // 目标浪道
      laneF: 1,            // 当前浪道（浮点，用于换道补间）
      y: 0,                // 屏幕 y（脚底/板面位置）
      vy: 0,
      g: CONFIG.GRAVITY,   // 起跳时按浪道缩放后的重力
      mode: 'ride',        // 'ride' 滑行 | 'air' 空中 | 'barrel' 浪管 | 'swim' 游泳
      diveT: 0,            // 压板剩余时间
      balance: CONFIG.BALANCE_MAX,
      swimT: 0,
      invulnT: 0,
      barrelWave: null,
      barrelTime: 0,
      spin: { active: false, t: 0, dir: 1, queue: 0, done: 0, angle: 0 },
      tilt: 0,
      msgCooldown: 0,
    },
    // 输入：离散动作队列 + 按住状态
    input: { queue: [], downHeld: false },
  };
}

let gameState = createGameState('menu');

/* =====================================================================
 * 3. 浪面生成
 * ===================================================================== */

// 浪道参数（支持浮点浪道，用于换道时插值）
function laneParams(lf) {
  const L = CONFIG.LANES;
  const i = clamp(Math.floor(lf), 0, L.length - 1);
  const j = clamp(i + 1, 0, L.length - 1);
  const f = clamp(lf - i, 0, 1);
  return {
    baseY: lerp(L[i].baseY, L[j].baseY, f),
    scale: lerp(L[i].scale, L[j].scale, f),
    alpha: lerp(L[i].alpha, L[j].alpha, f),
  };
}

// 浪型轮廓：u ∈ [0,1] 为在本波浪中的相对位置，返回 0~1 的高度
function shape01(type, u) {
  const uu = Math.pow(clamp(u, 0, 1), WAVE_TYPES[type].skew);
  const s = Math.sin(Math.PI * uu);
  return s * s;
}

// 浪峰所在的相对位置
function peakU(type) {
  return Math.pow(0.5, 1 / WAVE_TYPES[type].skew);
}

// 借浪起跳窗口（浪峰附近）
function crestWindow(type) {
  const p = peakU(type);
  return [p - 0.15, p + 0.12];
}

// 碎浪的白色浪花区域
function whitewaterZone(wave) {
  return [0.36, 0.66];
}

// 选择下一波浪的类型：开局固定节奏便于熟悉，之后加权随机且避免连续 3 波相同
function chooseWaveType(gs) {
  const intro = ['flat', 'flat', 'barrel', 'flat', 'break', 'flat'];
  if (gs.waveCount < intro.length) return intro[gs.waveCount];
  const last = gs.waves.slice(-2).map((w) => w.type);
  let type;
  do {
    const r = Math.random();
    type = r < 0.38 ? 'flat' : r < 0.69 ? 'barrel' : 'break';
  } while (last.length === 2 && last[0] === type && last[1] === type);
  return type;
}

function pushWave(gs) {
  const type = chooseWaveType(gs);
  const def = WAVE_TYPES[type];
  const amp = rand(def.amp[0], def.amp[1]);
  const wave = {
    id: gs.waveId++,
    type,
    start: gs.nextWaveX,
    len: rand(def.len[0], def.len[1]),
    amp,                 // 当前振幅（大浪时会平滑增长）
    targetAmp: amp,      // 目标振幅
    big: false,
  };
  gs.nextWaveX += wave.len;
  gs.waves.push(wave);
  gs.waveCount++;
  populateWave(gs, wave);
  return wave;
}

// 保证玩家前方始终有足够的浪（预报需要至少 3 波）
function ensureWaves(gs) {
  while (gs.nextWaveX < gs.player.wx + W * 3) pushWave(gs);
}

// 查找世界坐标 wx 处的浪及相对位置 u
function waveAt(gs, wx) {
  const ws = gs.waves;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (wx >= w.start && wx < w.start + w.len) return { wave: w, u: (wx - w.start) / w.len };
  }
  return null;
}

// 浪的隆起高度（未缩放）
function waveHeight(gs, wx) {
  const info = waveAt(gs, wx);
  return info ? info.wave.amp * shape01(info.wave.type, info.u) : 0;
}

// 多个不同频率/振幅的正弦波叠加，形成持续起伏的细碎浪面
function chop(gs, wx, lf) {
  const t = gs.time;
  return (
    6 * Math.sin(wx * 0.012 - t * 1.6 + lf * 1.3) +
    3.5 * Math.sin(wx * 0.031 + t * 2.3 + lf * 2.1) +
    2 * Math.sin(wx * 0.071 - t * 3.1 + lf)
  );
}

// 浪面高度采样：返回某浪道在世界坐标 wx 处的海面屏幕 y（即"地面"）
function surfaceY(gs, lf, wx) {
  const p = laneParams(lf);
  return p.baseY - p.scale * (waveHeight(gs, wx) + chop(gs, wx, lf));
}

// 世界坐标 → 屏幕坐标
function toScreenX(gs, wx) {
  return CONFIG.PLAYER_X + (wx - gs.player.wx);
}

function updateWaves(gs, dt) {
  for (const w of gs.waves) {
    // 大浪振幅平滑增长，玩家能看到浪"涨起来"
    w.amp += (w.targetAmp - w.amp) * Math.min(1, dt * 2.5);
  }
  // 清理已经完全离开屏幕左侧的浪
  const leftEdge = gs.player.wx - CONFIG.PLAYER_X - 100;
  while (gs.waves.length && gs.waves[0].start + gs.waves[0].len < leftEdge) gs.waves.shift();
  ensureWaves(gs);
}

// 即将到来的浪（不含玩家脚下正在经过的浪）
function upcomingWaves(gs, n) {
  const res = [];
  for (const w of gs.waves) {
    if (w.start > gs.player.wx) res.push(w);
    if (res.length >= n) break;
  }
  return res;
}

// "召唤大浪"：让下一波浪变高，清空其上障碍，并在高空生成金贝壳高分路线
function useBigWave(gs) {
  const p = gs.player;
  if (gs.powerCharges <= 0 || gs.phase !== 'playing') return;
  const wave = gs.waves.find((w) => w.start > p.wx + 30 && !w.big);
  if (!wave) return;
  gs.powerCharges--;
  wave.big = true;
  wave.targetAmp = Math.max(wave.targetAmp * 1.6, 165);
  // 清空这波浪上的礁石和水母，让玩家专心借浪
  gs.obstacles = gs.obstacles.filter(
    (o) => o.kind === 'shark' || o.wx < wave.start - 40 || o.wx > wave.start + wave.len + 40
  );
  // 高空金贝壳路线：只有在浪峰起跳（获得高度加成）才能吃到
  const startX = wave.start + peakU(wave.type) * wave.len + 40;
  for (let lane = 0; lane < 3; lane++) {
    for (let i = 0; i < 8; i++) {
      gs.items.push({
        kind: 'gold', lane, wx: startX + i * 50,
        hOff: wave.targetAmp + 95 + 75 * Math.sin((Math.PI * i) / 7),
        abs: true, taken: false,
      });
    }
  }
  addText(gs, '大浪来袭！在浪峰起跳！', W / 2, 150, '#ffe066', 28);
  gs.flash = 0.35;
}

/* =====================================================================
 * 4. 障碍物与道具
 * ===================================================================== */

function addShellLine(gs, lane, wave, u0, u1, n, hOff) {
  for (let i = 0; i < n; i++) {
    const u = lerp(u0, u1, n === 1 ? 0.5 : i / (n - 1));
    gs.items.push({ kind: 'shell', lane, wx: wave.start + u * wave.len, hOff, abs: false, taken: false });
  }
}

// 根据浪型为每一波浪生成内容（障碍与道具），保证同一位置不会三道全堵
function populateWave(gs, wave) {
  if (gs.waveCount <= 3) return; // 开局几波浪留给玩家熟悉操作
  const d = clamp(wave.start / 30000, 0, 1); // 难度系数随距离上升
  const lanes = [0, 1, 2];
  const at = (u) => wave.start + u * wave.len;

  if (wave.type === 'flat') {
    // 平浪：礁石主场，配合贝壳与道具
    let rockLane = -1;
    if (Math.random() < 0.5 + 0.35 * d) {
      rockLane = pick(lanes);
      gs.obstacles.push({ kind: 'rock', lane: rockLane, wx: at(0.5), seed: Math.random() });
      if (d > 0.4 && Math.random() < 0.5) {
        const l2 = pick(lanes.filter((l) => l !== rockLane));
        gs.obstacles.push({ kind: 'rock', lane: l2, wx: at(0.88), seed: Math.random() });
      }
    }
    if (Math.random() < 0.65) {
      const sl = pick(lanes.filter((l) => l !== rockLane));
      addShellLine(gs, sl, wave, 0.15, 0.85, 6, 26);
    }
    if (Math.random() < 0.3 + 0.3 * d) {
      gs.obstacles.push({ kind: 'jelly', lane: pick(lanes), wx: at(0.18), phase: Math.random() * 6 });
    }
    if (Math.random() < 0.2) {
      const pl = pick(lanes.filter((l) => l !== rockLane));
      gs.items.push({ kind: 'power', lane: pl, wx: at(0.72), hOff: 36, abs: false, taken: false });
    }
  } else if (wave.type === 'barrel') {
    // 卷浪：浪管内部放一排贝壳，奖励钻管
    addShellLine(gs, pick(lanes), wave, 0.25, 0.55, 6, 14);
    if (Math.random() < 0.25 + 0.2 * d) {
      gs.obstacles.push({ kind: 'jelly', lane: pick(lanes), wx: at(0.9), phase: Math.random() * 6 });
    }
  } else {
    // 碎浪：浪花上方的弧形贝壳，奖励跳跃；浪前可能有水母
    const sl = pick(lanes);
    for (let i = 0; i < 6; i++) {
      const u = lerp(0.36, 0.7, i / 5);
      gs.items.push({
        kind: 'shell', lane: sl, wx: at(u),
        hOff: 50 + 45 * Math.sin((Math.PI * i) / 5), abs: false, taken: false,
      });
    }
    if (Math.random() < 0.3 + 0.2 * d) {
      gs.obstacles.push({ kind: 'jelly', lane: pick(lanes), wx: at(0.08), phase: Math.random() * 6 });
    }
  }
}

// 鲨鱼突袭：先在屏幕右侧闪烁预警，再露出背鳍逼近，靠近后跃出水面
function spawnShark(gs) {
  const p = gs.player;
  gs.obstacles.push({
    kind: 'shark', lane: randInt(0, 2), wx: p.wx + W, state: 'warn', t: 0,
  });
  addText(gs, '鲨鱼预警！', W - 140, 130, '#ff5a5a', 22);
}

function updateObstacles(gs, dt) {
  const p = gs.player;
  // 鲨鱼计时
  if (gs.phase === 'playing' && gs.elapsed > 8) {
    gs.sharkTimer -= dt;
    if (gs.sharkTimer <= 0) {
      spawnShark(gs);
      const d = clamp(gs.elapsed / 120, 0, 1);
      gs.sharkTimer = rand(7, 12) - 3 * d;
    }
  }
  for (const o of gs.obstacles) {
    if (o.kind === 'jelly') o.phase += dt * 3;
    if (o.kind !== 'shark') continue;
    o.t += dt;
    if (o.state === 'warn') {
      o.wx = p.wx + (W - CONFIG.PLAYER_X) + 40; // 预警期间停在屏幕外
      if (o.t > 0.9) { o.state = 'fin'; o.t = 0; }
    } else if (o.state === 'fin') {
      o.wx -= CONFIG.SHARK_SPEED * dt;
      if (toScreenX(gs, o.wx) - CONFIG.PLAYER_X < 230) { o.state = 'lunge'; o.t = 0; }
    } else if (o.state === 'lunge') {
      o.wx -= CONFIG.SHARK_SPEED * 1.4 * dt;
      if (o.t > 0.85) { o.state = 'gone'; o.t = 0; }
    } else if (o.state === 'gone') {
      o.wx -= CONFIG.SHARK_SPEED * dt;
    }
  }
  // 清理屏幕左侧之外的对象
  const left = p.wx - CONFIG.PLAYER_X - 80;
  gs.obstacles = gs.obstacles.filter((o) => o.wx > left && !(o.kind === 'shark' && o.state === 'gone' && o.t > 1));
  gs.items = gs.items.filter((it) => it.wx > left && !it.taken);
}

// 道具/障碍的屏幕 y
function itemY(gs, it) {
  const lp = CONFIG.LANES[it.lane];
  return it.abs ? lp.baseY - lp.scale * it.hOff : surfaceY(gs, it.lane, it.wx) - lp.scale * it.hOff;
}

/* =====================================================================
 * 5. 玩家控制
 * ===================================================================== */

function effectiveSpeed(gs) {
  const base = gs.phase === 'menu' ? 220 : gs.speed;
  return gs.player.mode === 'swim' ? base * 0.5 : base;
}

function handleAction(gs, action) {
  const p = gs.player;
  if (action === 'power') { useBigWave(gs); return; }
  if (action === 'jump') {
    if (p.mode === 'ride' || p.mode === 'barrel') doJump(gs);
  } else if (action === 'dive') {
    if (p.mode === 'ride') p.diveT = CONFIG.DIVE_TIME;
    else if (p.mode === 'air') p.vy = Math.max(p.vy, 700 * laneParams(p.laneF).scale); // 空中压板加速下落
  } else if (action === 'left' || action === 'right') {
    const dir = action === 'left' ? -1 : 1;
    if (p.mode === 'air') {
      startSpin(gs, dir); // 空中按方向键：转体花式
    } else {
      const nl = clamp(p.lane + (action === 'left' ? -1 : 1), 0, 2);
      // ←/左滑 = 去远景（上方浪道），→/右滑 = 来近景（下方浪道）
      if (nl !== p.lane) {
        if (p.mode === 'barrel') exitBarrel(gs, false);
        p.lane = nl;
      }
    }
  }
}

function doJump(gs) {
  const p = gs.player;
  const lp = laneParams(p.laneF);
  const info = waveAt(gs, p.wx);
  let bonus = 0;
  if (info && info.wave.amp >= 40) {
    const [a, b] = crestWindow(info.wave.type);
    if (info.u >= a && info.u <= b) bonus = Math.min(info.wave.amp * 0.85, CONFIG.CREST_BONUS_MAX);
  }
  if (p.mode === 'barrel') exitBarrel(gs, true);
  const h = (CONFIG.JUMP_H + bonus) * lp.scale;
  p.g = CONFIG.GRAVITY * lp.scale;
  p.vy = -Math.sqrt(2 * p.g * h);
  p.mode = 'air';
  p.diveT = 0;
  p.balance -= CONFIG.COST.jump;
  p.spin = { active: false, t: 0, dir: 1, queue: 0, done: 0, angle: 0 };
  if (bonus > 0) {
    gs.score += CONFIG.SCORE.crestJump;
    addText(gs, '借浪起跳！', CONFIG.PLAYER_X, p.y - 70 * lp.scale, '#9ff7ff', 20);
  }
  splash(gs, p.wx, p.y, Math.round(p.laneF), 10, lp.scale);
}

function startSpin(gs, dir) {
  const p = gs.player;
  if (!p.spin.active) {
    p.spin.active = true;
    p.spin.t = 0;
    p.spin.dir = dir;
    p.balance -= CONFIG.COST.spin;
  } else if (p.spin.queue < 3) {
    p.spin.queue++; // 连续按方向键可叠加多圈
  }
}

function updateSpin(gs, dt) {
  const s = gs.player.spin;
  if (!s.active) return;
  s.t += dt / CONFIG.SPIN_TIME;
  if (s.t >= 1) {
    s.done++;
    if (s.queue > 0) {
      s.queue--;
      s.t -= 1;
      gs.player.balance -= CONFIG.COST.spin;
    } else {
      s.active = false;
      s.t = 0;
    }
  }
  s.angle = s.active ? s.dir * Math.PI * 2 * s.t : 0;
}

function land(gs, surf) {
  const p = gs.player;
  const lp = laneParams(p.laneF);
  p.y = surf;
  p.vy = 0;
  p.mode = 'ride';
  const s = p.spin;
  if (s.active) {
    // 转体没转完就落地 = 失败
    p.balance -= CONFIG.COST.badLanding;
    addText(gs, '落地失败！', CONFIG.PLAYER_X, p.y - 60 * lp.scale, '#ff7a7a', 22);
    gs.shake = 0.25;
  } else if (s.done > 0) {
    const pts = CONFIG.SCORE.spin * s.done * s.done;
    gs.score += pts;
    addText(gs, `转体 ×${s.done}  +${pts}`, CONFIG.PLAYER_X, p.y - 60 * lp.scale, '#ffd84d', 24);
  }
  p.spin = { active: false, t: 0, dir: 1, queue: 0, done: 0, angle: 0 };
  splash(gs, p.wx, p.y, Math.round(p.laneF), 14, lp.scale);
}

function enterBarrel(gs, wave) {
  const p = gs.player;
  p.mode = 'barrel';
  p.barrelWave = wave;
  p.barrelTime = 0;
  p.balance -= CONFIG.COST.barrelEnter;
  addText(gs, '钻入浪管！', CONFIG.PLAYER_X + 30, p.y - 60, '#9fe6ff', 22);
}

function exitBarrel(gs, success) {
  const p = gs.player;
  if (success) {
    const pts = Math.round(CONFIG.SCORE.barrelExit + 150 * p.barrelTime);
    gs.score += pts;
    addText(gs, `完美出管 +${pts}`, CONFIG.PLAYER_X + 20, p.y - 70, '#7dffb0', 24);
  }
  p.mode = 'ride';
  p.barrelWave = null;
  p.diveT = 0;
}

function enterSwim(gs) {
  const p = gs.player;
  if (p.mode === 'barrel') exitBarrel(gs, false);
  p.mode = 'swim';
  p.swimT = CONFIG.SWIM_TIME;
  p.balance = 0;
  p.diveT = 0;
  p.spin = { active: false, t: 0, dir: 1, queue: 0, done: 0, angle: 0 };
  addText(gs, '失去平衡！游泳模式', W / 2, 170, '#ffb3b3', 26);
  splash(gs, p.wx, p.y, Math.round(p.laneF), 24, laneParams(p.laneF).scale);
}

function updatePlayer(gs, dt) {
  const p = gs.player;
  // 处理输入动作
  while (gs.input.queue.length) handleAction(gs, gs.input.queue.shift());
  if (gs.input.downHeld && p.mode === 'ride') p.diveT = Math.max(p.diveT, 0.1); // 按住 ↓ 持续压板
  // 平衡归零 → 游泳模式（空中归零则落水时触发）
  if (p.balance <= 0 && (p.mode === 'ride' || p.mode === 'barrel')) enterSwim(gs);

  const eff = effectiveSpeed(gs);
  p.wx += eff * dt;

  // 换道补间
  const ls = 1 / CONFIG.LANE_SWITCH_TIME;
  if (p.laneF < p.lane) p.laneF = Math.min(p.lane, p.laneF + ls * dt);
  else if (p.laneF > p.lane) p.laneF = Math.max(p.lane, p.laneF - ls * dt);

  p.invulnT = Math.max(0, p.invulnT - dt);
  p.diveT = Math.max(0, p.diveT - dt);
  p.msgCooldown = Math.max(0, p.msgCooldown - dt);

  const surf = surfaceY(gs, p.laneF, p.wx);
  const info = waveAt(gs, p.wx);
  const lp = laneParams(p.laneF);
  // 板面倾角跟随浪面坡度
  const slope = (surfaceY(gs, p.laneF, p.wx + 10) - surfaceY(gs, p.laneF, p.wx - 10)) / 20;
  const targetTilt = Math.atan(slope) * 0.9;

  if (p.mode === 'ride') {
    p.y = surf;
    p.tilt = lerp(p.tilt, targetTilt, Math.min(1, dt * 12));
    let calm = p.diveT <= 0;
    if (info) {
      // 压板时进入卷浪的浪管区域 → 钻管
      if (p.diveT > 0 && info.wave.type === 'barrel' && info.u >= 0.1 && info.u <= 0.45) {
        enterBarrel(gs, info.wave);
      }
      // 碎浪浪花区域：持续扣平衡
      const [a, b] = whitewaterZone(info.wave);
      if (info.wave.type === 'break' && info.u >= a && info.u <= b && p.mode === 'ride') {
        calm = false;
        p.balance -= CONFIG.COST.whitewaterPerSec * dt;
        gs.shake = Math.max(gs.shake, 0.08);
        if (Math.random() < 0.6) splash(gs, p.wx, p.y - 10 * lp.scale, Math.round(p.laneF), 1, lp.scale);
        if (p.msgCooldown <= 0) {
          addText(gs, '被碎浪冲击！', CONFIG.PLAYER_X, p.y - 70 * lp.scale, '#ffffff', 20);
          p.msgCooldown = 1.2;
        }
      }
    }
    if (calm && p.mode === 'ride') p.balance += CONFIG.RECOVER_PER_SEC * dt;
    // 板尾水花
    if (Math.random() < 0.5) spray(gs, p.wx - 20 * lp.scale, p.y, Math.round(p.laneF), lp.scale);
  } else if (p.mode === 'barrel') {
    p.y = surf;
    p.tilt = lerp(p.tilt, targetTilt, Math.min(1, dt * 12));
    p.barrelTime += dt;
    gs.score += CONFIG.SCORE.barrelPerSec * dt;
    p.balance -= CONFIG.COST.barrelPerSec * dt;
    if (!info || info.wave !== p.barrelWave || info.u > peakU('barrel') + 0.02) exitBarrel(gs, true);
    if (Math.random() < 0.6) spray(gs, p.wx - 20 * lp.scale, p.y, Math.round(p.laneF), lp.scale);
  } else if (p.mode === 'air') {
    p.vy += p.g * dt;
    p.y += p.vy * dt;
    p.tilt = lerp(p.tilt, 0, Math.min(1, dt * 4));
    updateSpin(gs, dt);
    if (p.vy > 0 && p.y >= surf) land(gs, surf);
  } else if (p.mode === 'swim') {
    p.y = surf + 4 * lp.scale;
    p.tilt = 0;
    p.swimT -= dt;
    if (Math.random() < 0.15) splash(gs, p.wx, p.y, Math.round(p.laneF), 1, lp.scale);
    if (p.swimT <= 0) {
      // 自动爬回板上
      p.mode = 'ride';
      p.balance = 45;
      p.invulnT = 1.2;
      addText(gs, '爬回板上！', CONFIG.PLAYER_X, p.y - 60 * lp.scale, '#b8ffcf', 22);
    }
  }

  p.balance = clamp(p.balance, 0, CONFIG.BALANCE_MAX);
  if (p.balance <= 0 && (p.mode === 'ride' || p.mode === 'barrel')) enterSwim(gs);
}

/* =====================================================================
 * 6. 碰撞检测（圆形近似）
 * ===================================================================== */

// 玩家碰撞圆：滑行/空中为身体中心，潜水/浪管时压低缩小，游泳时只剩头部
function playerBody(gs) {
  const p = gs.player;
  const s = laneParams(p.laneF).scale;
  if (p.mode === 'swim') return { x: CONFIG.PLAYER_X, y: p.y - 2 * s, r: 9 * s };
  if (p.mode === 'barrel' || (p.mode === 'ride' && p.diveT > 0)) return { x: CONFIG.PLAYER_X, y: p.y - 11 * s, r: 10 * s };
  return { x: CONFIG.PLAYER_X, y: p.y - 22 * s, r: 14 * s };
}

function circleHit(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = a.r + b.r;
  return dx * dx + dy * dy < r * r;
}

// 障碍物碰撞圆
function obstacleBody(gs, o) {
  const s = CONFIG.LANES[o.lane].scale;
  const x = toScreenX(gs, o.wx);
  const surf = surfaceY(gs, o.lane, o.wx);
  if (o.kind === 'rock') return { x, y: surf - 8 * s, r: 17 * s };
  if (o.kind === 'jelly') return { x, y: surf - (52 + 5 * Math.sin(o.phase)) * s, r: 13 * s };
  if (o.kind === 'shark') {
    if (o.state !== 'lunge' || o.t < 0.05 || o.t > 0.8) return null;
    const arc = Math.sin((Math.PI * o.t) / 0.85) * 36 * s;
    return { x, y: surf - 14 * s - arc, r: 24 * s };
  }
  return null;
}

function checkCollisions(gs) {
  const p = gs.player;
  const pb = playerBody(gs);
  for (const o of gs.obstacles) {
    if (Math.abs(p.laneF - o.lane) > 0.4) continue;
    const ob = obstacleBody(gs, o);
    if (!ob || !circleHit(pb, ob)) continue;
    if (o.kind === 'jelly') {
      if (p.invulnT > 0 || o.hit) continue;
      o.hit = true;
      p.balance -= CONFIG.COST.jelly;
      p.invulnT = 1.0;
      gs.shake = 0.3;
      addText(gs, '被水母蜇了！-平衡', CONFIG.PLAYER_X, pb.y - 50, '#e59bff', 22);
      if (p.balance <= 0 && p.mode !== 'air') enterSwim(gs);
    } else {
      if (p.invulnT > 0) continue;
      gameOver(gs, o.kind === 'rock' ? '撞上礁石！' : '被鲨鱼咬到了！');
      return;
    }
  }
  if (p.mode === 'swim') return; // 游泳模式无法吃道具
  for (const it of gs.items) {
    if (it.taken || Math.abs(p.laneF - it.lane) > 0.4) continue;
    const s = CONFIG.LANES[it.lane].scale;
    const ib = { x: toScreenX(gs, it.wx), y: itemY(gs, it), r: (it.kind === 'power' ? 16 : 10) * s + 4 };
    if (!circleHit(pb, ib)) continue;
    it.taken = true;
    if (it.kind === 'shell') {
      gs.score += CONFIG.SCORE.shell;
      sparkle(gs, it, '#fff2c4');
    } else if (it.kind === 'gold') {
      gs.score += CONFIG.SCORE.gold;
      sparkle(gs, it, '#ffd84d');
      addText(gs, `+${CONFIG.SCORE.gold}`, ib.x, ib.y - 16, '#ffd84d', 18);
    } else if (it.kind === 'power') {
      if (gs.powerCharges < CONFIG.MAX_POWER) gs.powerCharges++;
      addText(gs, '获得【召唤大浪】按 E 使用', W / 2, 200, '#8ff0ff', 24);
      sparkle(gs, it, '#8ff0ff');
    }
  }
}

function gameOver(gs, reason) {
  gs.phase = 'over';
  gs.overReason = reason;
  gs.score = Math.floor(gs.score);
  if (gs.score > gs.best) {
    gs.best = gs.score;
    saveBest(gs.best);
    gs.newBest = true;
  }
  gs.shake = 0.6;
  const p = gs.player;
  splash(gs, p.wx, p.y, Math.round(p.laneF), 40, laneParams(p.laneF).scale);
}

/* =====================================================================
 * 7. 粒子与飘字
 * ===================================================================== */

function addParticle(gs, pt) {
  if (gs.particles.length < 700) gs.particles.push(pt);
}

// 落水/起跳的水花
function splash(gs, wx, y, lane, n, s) {
  for (let i = 0; i < n; i++) {
    addParticle(gs, {
      wx, y, lane, vx: rand(-120, 80), vy: rand(-260, -60) * s, g: 700,
      r: rand(2, 4.5) * s, life: 0, max: rand(0.4, 0.8), color: '255,255,255',
    });
  }
}

// 板尾拖出的浪花
function spray(gs, wx, y, lane, s) {
  addParticle(gs, {
    wx, y, lane, vx: rand(-90, -30), vy: rand(-140, -40) * s, g: 600,
    r: rand(1.5, 3.5) * s, life: 0, max: rand(0.3, 0.55), color: '235,250,255',
  });
}

// 吃到道具的闪光
function sparkle(gs, it, color) {
  const c = color === '#ffd84d' ? '255,216,77' : color === '#8ff0ff' ? '143,240,255' : '255,242,196';
  const y = itemY(gs, it);
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8;
    addParticle(gs, {
      wx: it.wx, y, lane: it.lane, vx: Math.cos(a) * 120, vy: Math.sin(a) * 120, g: 0,
      r: 2.5, life: 0, max: 0.4, color: c,
    });
  }
}

// 碎浪的白色浪花粒子（持续生成）
function spawnFoam(gs) {
  const p = gs.player;
  const viewL = p.wx - CONFIG.PLAYER_X;
  const viewR = viewL + W;
  for (const w of gs.waves) {
    if (w.type !== 'break') continue;
    const [a, b] = whitewaterZone(w);
    const x0 = w.start + a * w.len;
    const x1 = w.start + b * w.len;
    if (x1 < viewL || x0 > viewR) continue;
    for (let lane = 0; lane < 3; lane++) {
      const s = CONFIG.LANES[lane].scale;
      for (let k = 0; k < 2; k++) {
        const wx = rand(x0, x1);
        addParticle(gs, {
          wx, y: surfaceY(gs, lane, wx) - rand(0, 10) * s, lane,
          vx: rand(-60, 20), vy: rand(-70, -10) * s, g: 120,
          r: rand(2, 5) * s, life: 0, max: rand(0.5, 0.9), color: '255,255,255',
        });
      }
    }
  }
}

function updateParticles(gs, dt) {
  for (const pt of gs.particles) {
    pt.life += dt;
    pt.wx += pt.vx * dt;
    pt.vy += pt.g * dt;
    pt.y += pt.vy * dt;
  }
  gs.particles = gs.particles.filter((pt) => pt.life < pt.max);
  for (const t of gs.texts) {
    t.life += dt;
    t.y -= 30 * dt;
  }
  gs.texts = gs.texts.filter((t) => t.life < t.max);
}

function addText(gs, text, x, y, color, size) {
  if (gs.phase === 'menu') return; // 菜单演示时不弹提示文字
  gs.texts.push({ text, x, y, color, size: size || 20, life: 0, max: 1.3 });
}

/* =====================================================================
 * 8. 场景渲染
 * ===================================================================== */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let cssScale = 1;

// 画布自适应窗口（保持 16:9，处理高清屏）
function resize() {
  const dpr = window.devicePixelRatio || 1;
  cssScale = Math.min(window.innerWidth / W, window.innerHeight / H);
  canvas.style.width = `${Math.floor(W * cssScale)}px`;
  canvas.style.height = `${Math.floor(H * cssScale)}px`;
  canvas.width = Math.floor(W * cssScale * dpr);
  canvas.height = Math.floor(H * cssScale * dpr);
}
window.addEventListener('resize', resize);
resize();

function drawSky(gs) {
  const g = ctx.createLinearGradient(0, 0, 0, 260);
  g.addColorStop(0, '#5bb8f0');
  g.addColorStop(1, '#d9f3ff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 太阳
  ctx.fillStyle = 'rgba(255, 244, 200, 0.9)';
  ctx.beginPath();
  ctx.arc(760, 70, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 244, 200, 0.25)';
  ctx.beginPath();
  ctx.arc(760, 70, 56, 0, Math.PI * 2);
  ctx.fill();
  // 云（视差滚动）
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  const off = gs.player.wx * 0.05 + gs.time * 8;
  for (let i = 0; i < 5; i++) {
    const x = ((i * 260 - off) % (W + 300) + W + 300) % (W + 300) - 150;
    const y = 50 + (i % 3) * 38;
    ctx.beginPath();
    ctx.ellipse(x, y, 46, 16, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 30, y - 10, 30, 16, 0, 0, Math.PI * 2);
    ctx.ellipse(x - 28, y - 4, 26, 12, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 远处的岛屿剪影
  const iOff = ((gs.player.wx * 0.12) % 1400 + 1400) % 1400;
  ctx.fillStyle = '#6fa7b8';
  for (let k = 0; k < 2; k++) {
    const x = 900 - iOff + k * 1400;
    ctx.beginPath();
    ctx.moveTo(x - 140, 236);
    ctx.quadraticCurveTo(x - 60, 180, x, 200);
    ctx.quadraticCurveTo(x + 60, 170, x + 150, 236);
    ctx.fill();
  }
  // 远海
  const sea = ctx.createLinearGradient(0, 232, 0, H);
  sea.addColorStop(0, '#5aa9d6');
  sea.addColorStop(1, '#1f5f93');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 232, W, H - 232);
}

// 某条浪道的海面路径（屏幕坐标采样点）
function sampleSurface(gs, lane) {
  const pts = [];
  const p = gs.player;
  for (let sx = -10; sx <= W + 10; sx += 6) {
    pts.push(sx, surfaceY(gs, lane, p.wx + sx - CONFIG.PLAYER_X));
  }
  return pts;
}

function drawLaneWater(gs, lane, pts) {
  const L = CONFIG.LANES[lane];
  // 浪面填充：深蓝到浅蓝渐变
  const g = ctx.createLinearGradient(0, L.baseY - 140 * L.scale, 0, H);
  g.addColorStop(0, L.top);
  g.addColorStop(1, L.bottom);
  ctx.beginPath();
  ctx.moveTo(pts[0], H);
  for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.lineTo(pts[pts.length - 2], H);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  // 浪面高光线
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    if (i === 0) ctx.moveTo(pts[i], pts[i + 1]);
    else ctx.lineTo(pts[i], pts[i + 1]);
  }
  ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.25 * L.scale})`;
  ctx.lineWidth = 2.5 * L.scale;
  ctx.stroke();
  // 远景加一层雾气，强化景深
  if (lane < 2) {
    ctx.fillStyle = `rgba(210,240,255,${lane === 0 ? 0.18 : 0.08})`;
    ctx.beginPath();
    ctx.moveTo(pts[0], H);
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.lineTo(pts[pts.length - 2], H);
    ctx.fill();
  }
}

// 碎浪：沿浪峰画一条白色浪花带
function drawWhitewater(gs, lane) {
  const L = CONFIG.LANES[lane];
  for (const w of gs.waves) {
    if (w.type !== 'break') continue;
    const [a, b] = whitewaterZone(w);
    const x0 = toScreenX(gs, w.start + a * w.len);
    const x1 = toScreenX(gs, w.start + b * w.len);
    if (x1 < -20 || x0 > W + 20) continue;
    ctx.beginPath();
    for (let sx = x0; sx <= x1; sx += 5) {
      const wx = gs.player.wx + sx - CONFIG.PLAYER_X;
      const y = surfaceY(gs, lane, wx) - 3 * L.scale;
      if (sx === x0) ctx.moveTo(sx, y);
      else ctx.lineTo(sx, y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 9 * L.scale;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
}

// 卷浪几何：浪峰点、浪唇尖端及两条贝塞尔曲线的控制点
const BARREL_TIP_U = 0.25;
function barrelGeom(gs, w, lane) {
  const L = CONFIG.LANES[lane];
  const xcW = w.start + peakU('barrel') * w.len;
  const xtW = w.start + BARREL_TIP_U * w.len;
  const xc = toScreenX(gs, xcW);
  const xt = toScreenX(gs, xtW);
  const yc = surfaceY(gs, lane, xcW);
  const a = w.amp * L.scale;
  const yt = surfaceY(gs, lane, xtW) - a * 0.34; // 浪唇尖端悬在浪面上方，留出管口
  const d = xc - xt;
  return {
    xc, yc, xt, yt, a, xcW, xtW,
    // 外缘：从浪峰向前上方抛出，再向下卷回尖端（钩状）
    outer: [xc - d * 0.3, yc - a * 0.5, xt - d * 0.28, yc - a * 0.3],
    // 内缘：从尖端回到浪峰下方，内缘以下即为浪管空腔
    inner: [xt + d * 0.05, yt - a * 0.32, xc - d * 0.2, yc + a * 0.02],
    innerEnd: [xc - d * 0.04, yc + a * 0.14],
  };
}

// 浪管内部的暗色空腔（画在角色之前）
function drawBarrelInside(gs, lane) {
  for (const w of gs.waves) {
    if (w.type !== 'barrel') continue;
    const g = barrelGeom(gs, w, lane);
    if (g.xc < -50 || g.xt > W + 80) continue;
    ctx.beginPath();
    ctx.moveTo(g.xt, g.yt);
    ctx.bezierCurveTo(g.inner[0], g.inner[1], g.inner[2], g.inner[3], g.innerEnd[0], g.innerEnd[1]);
    for (let wx = g.xcW; wx >= g.xtW; wx -= 8) ctx.lineTo(toScreenX(gs, wx), surfaceY(gs, lane, wx));
    ctx.closePath();
    const grad = ctx.createLinearGradient(g.xt, 0, g.xc, 0);
    grad.addColorStop(0, 'rgba(8, 40, 90, 0.25)');
    grad.addColorStop(1, 'rgba(4, 25, 60, 0.6)');
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

// 浪唇（覆盖在角色前方，形成"钻进浪管"的效果）
function drawBarrelLip(gs, lane, alphaMul) {
  const L = CONFIG.LANES[lane];
  for (const w of gs.waves) {
    if (w.type !== 'barrel') continue;
    const g = barrelGeom(gs, w, lane);
    if (g.xc < -50 || g.xt > W + 80) continue;
    ctx.save();
    ctx.globalAlpha *= alphaMul;
    ctx.beginPath();
    ctx.moveTo(g.xc + 4, g.yc + 2);
    ctx.bezierCurveTo(g.outer[0], g.outer[1], g.outer[2], g.outer[3], g.xt, g.yt);
    ctx.bezierCurveTo(g.inner[0], g.inner[1], g.inner[2], g.inner[3], g.innerEnd[0], g.innerEnd[1]);
    ctx.closePath();
    const grad = ctx.createLinearGradient(g.xc, g.yc, g.xt, g.yt);
    grad.addColorStop(0, L.top);
    grad.addColorStop(1, '#d8f7ff');
    ctx.fillStyle = grad;
    ctx.fill();
    // 浪唇白边
    ctx.beginPath();
    ctx.moveTo(g.xc + 4, g.yc + 2);
    ctx.bezierCurveTo(g.outer[0], g.outer[1], g.outer[2], g.outer[3], g.xt, g.yt);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3 * L.scale;
    ctx.stroke();
    // 浪唇尖端的飞沫
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 6; i++) {
      const ang = gs.time * 4 + i * 1.1;
      ctx.beginPath();
      ctx.arc(g.xt + Math.cos(ang) * 6 * L.scale, g.yt + 6 * L.scale + Math.abs(Math.sin(ang)) * 10 * L.scale, 2.5 * L.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawRock(gs, o) {
  const L = CONFIG.LANES[o.lane];
  const s = L.scale;
  const x = toScreenX(gs, o.wx);
  const y = surfaceY(gs, o.lane, o.wx) + 6 * s;
  ctx.fillStyle = '#5b5560';
  ctx.beginPath();
  ctx.moveTo(x - 22 * s, y);
  ctx.lineTo(x - 15 * s, y - 18 * s);
  ctx.lineTo(x - 4 * s, y - 28 * s);
  ctx.lineTo(x + 10 * s, y - 22 * s);
  ctx.lineTo(x + 21 * s, y - 6 * s);
  ctx.lineTo(x + 23 * s, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#87808c';
  ctx.beginPath();
  ctx.moveTo(x - 12 * s, y - 17 * s);
  ctx.lineTo(x - 4 * s, y - 26 * s);
  ctx.lineTo(x + 4 * s, y - 18 * s);
  ctx.closePath();
  ctx.fill();
  // 礁石底部的白沫
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillRect(x - 24 * s, y - 3 * s, 48 * s, 3 * s);
}

function drawJelly(gs, o) {
  const s = CONFIG.LANES[o.lane].scale;
  const b = obstacleBody(gs, o);
  ctx.fillStyle = 'rgba(230, 140, 255, 0.85)';
  ctx.beginPath();
  ctx.arc(b.x, b.y, 13 * s, Math.PI, 0);
  ctx.quadraticCurveTo(b.x + 13 * s, b.y + 5 * s, b.x, b.y + 4 * s);
  ctx.quadraticCurveTo(b.x - 13 * s, b.y + 5 * s, b.x - 13 * s, b.y);
  ctx.fill();
  ctx.strokeStyle = 'rgba(230, 140, 255, 0.8)';
  ctx.lineWidth = 2 * s;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    const tx = b.x + i * 4.5 * s;
    ctx.moveTo(tx, b.y + 4 * s);
    ctx.quadraticCurveTo(tx + Math.sin(o.phase + i) * 4 * s, b.y + 10 * s, tx, b.y + 15 * s);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.arc(b.x - 4 * s, b.y - 5 * s, 3 * s, 0, Math.PI * 2);
  ctx.fill();
}

function drawShark(gs, o) {
  const L = CONFIG.LANES[o.lane];
  const s = L.scale;
  const x = toScreenX(gs, o.wx);
  const surf = surfaceY(gs, o.lane, o.wx);
  if (o.state === 'warn') {
    // 屏幕右侧闪烁的预警标记
    if (Math.floor(gs.time * 8) % 2 === 0) {
      ctx.fillStyle = '#ff3b3b';
      ctx.beginPath();
      ctx.moveTo(W - 14, surf - 30 * s);
      ctx.lineTo(W - 40, surf - 14 * s);
      ctx.lineTo(W - 14, surf + 2 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(18 * s)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('!', W - 24, surf - 8 * s);
    }
    return;
  }
  if (o.state === 'fin' || o.state === 'gone') {
    // 背鳍预兆 + 尾迹
    ctx.fillStyle = '#3c4a57';
    ctx.beginPath();
    ctx.moveTo(x - 12 * s, surf + 2 * s);
    ctx.quadraticCurveTo(x - 2 * s, surf - 12 * s, x + 6 * s, surf - 26 * s);
    ctx.quadraticCurveTo(x + 8 * s, surf - 10 * s, x + 16 * s, surf + 2 * s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(x + 16 * s, surf + 1);
    ctx.lineTo(x + 50 * s, surf - 2);
    ctx.stroke();
    return;
  }
  // 跃出水面的鲨鱼
  const arc = Math.sin((Math.PI * o.t) / 0.85) * 36 * s;
  const y = surf - 14 * s - arc;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.4 + o.t * 0.9);
  ctx.fillStyle = '#4b5d6e';
  ctx.beginPath();
  ctx.ellipse(0, 0, 40 * s, 15 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath(); // 背鳍
  ctx.moveTo(-2 * s, -12 * s);
  ctx.lineTo(8 * s, -30 * s);
  ctx.lineTo(16 * s, -10 * s);
  ctx.fill();
  ctx.beginPath(); // 尾巴
  ctx.moveTo(34 * s, 0);
  ctx.lineTo(54 * s, -16 * s);
  ctx.lineTo(50 * s, 0);
  ctx.lineTo(54 * s, 14 * s);
  ctx.fill();
  ctx.fillStyle = '#dfe7ee'; // 肚皮
  ctx.beginPath();
  ctx.ellipse(-4 * s, 6 * s, 30 * s, 7 * s, 0, 0, Math.PI);
  ctx.fill();
  ctx.fillStyle = '#7a1020'; // 张开的嘴
  ctx.beginPath();
  ctx.moveTo(-40 * s, 0);
  ctx.lineTo(-24 * s, 2 * s);
  ctx.lineTo(-38 * s, 8 * s);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(-26 * s, -5 * s, 2.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawItem(gs, it) {
  const s = CONFIG.LANES[it.lane].scale;
  const x = toScreenX(gs, it.wx);
  const y = itemY(gs, it) + Math.sin(gs.time * 4 + it.wx * 0.01) * 2;
  if (it.kind === 'shell' || it.kind === 'gold') {
    const r = 9 * s;
    ctx.fillStyle = it.kind === 'gold' ? '#ffd84d' : '#ffe3c8';
    ctx.strokeStyle = it.kind === 'gold' ? '#c48a00' : '#d9906b';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.8);
    ctx.arc(x, y + r * 0.2, r, Math.PI * 1.15, Math.PI * 1.85);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    for (let i = -2; i <= 2; i++) {
      ctx.moveTo(x, y + r * 0.8);
      ctx.lineTo(x + i * r * 0.35, y - r * 0.6);
    }
    ctx.stroke();
  } else if (it.kind === 'power') {
    // "召唤大浪"道具：发光圆球内画一道浪
    const r = 15 * s;
    const pulse = 1 + Math.sin(gs.time * 6) * 0.08;
    ctx.fillStyle = 'rgba(120, 240, 255, 0.35)';
    ctx.beginPath();
    ctx.arc(x, y, r * 1.5 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a73d9';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5 * s;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.7, y + r * 0.3);
    ctx.quadraticCurveTo(x - r * 0.1, y - r * 0.9, x + r * 0.5, y - r * 0.2);
    ctx.quadraticCurveTo(x + r * 0.1, y - r * 0.15, x + r * 0.2, y + r * 0.3);
    ctx.stroke();
  }
}

// 角色：圆头 + 三角板的几何占位
function drawPlayer(gs) {
  const p = gs.player;
  const s = laneParams(p.laneF).scale;
  if (p.invulnT > 0 && Math.floor(gs.time * 12) % 2 === 0) return; // 无敌闪烁
  ctx.save();
  ctx.translate(CONFIG.PLAYER_X, p.y);

  if (p.mode === 'swim') {
    // 游泳：板子漂在一旁，人只露出头和手臂
    ctx.fillStyle = '#ff9a3c';
    ctx.beginPath();
    ctx.moveTo(-60 * s, -2 * s);
    ctx.lineTo(-10 * s - 26 * s, -4 * s);
    ctx.lineTo(-60 * s, 3 * s);
    ctx.fill();
    ctx.strokeStyle = '#f2c79d';
    ctx.lineWidth = 3 * s;
    const sw = Math.sin(gs.time * 10) * 8 * s;
    ctx.beginPath();
    ctx.moveTo(-6 * s, 0);
    ctx.lineTo(-14 * s, -8 * s + sw);
    ctx.moveTo(6 * s, 0);
    ctx.lineTo(14 * s, -8 * s - sw);
    ctx.stroke();
    ctx.fillStyle = '#f2c79d';
    ctx.beginPath();
    ctx.arc(0, -4 * s, 8 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.rotate(p.tilt + p.spin.angle);
  const crouch = p.mode === 'barrel' || (p.mode === 'ride' && p.diveT > 0);
  // 冲浪板（三角形）
  ctx.fillStyle = '#ff9a3c';
  ctx.strokeStyle = '#b85a10';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.moveTo(-26 * s, -3 * s);
  ctx.lineTo(30 * s, 0);
  ctx.lineTo(-26 * s, 4 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 身体
  const hipY = crouch ? -8 * s : -14 * s;
  const shoulderY = crouch ? -20 * s : -32 * s;
  const headY = crouch ? -28 * s : -42 * s;
  const lean = crouch ? 6 * s : 2 * s;
  ctx.strokeStyle = '#1f3b70';
  ctx.lineWidth = 4 * s;
  ctx.lineCap = 'round';
  ctx.beginPath(); // 腿
  ctx.moveTo(-9 * s, -2 * s);
  ctx.lineTo(0, hipY);
  ctx.lineTo(9 * s, -2 * s);
  ctx.stroke();
  ctx.strokeStyle = '#e8473c';
  ctx.lineWidth = 6 * s;
  ctx.beginPath(); // 躯干
  ctx.moveTo(0, hipY);
  ctx.lineTo(lean, shoulderY);
  ctx.stroke();
  ctx.strokeStyle = '#f2c79d';
  ctx.lineWidth = 3 * s;
  ctx.beginPath(); // 手臂张开保持平衡
  ctx.moveTo(lean - 13 * s, shoulderY + 4 * s);
  ctx.lineTo(lean, shoulderY + 2 * s);
  ctx.lineTo(lean + 13 * s, shoulderY + 6 * s);
  ctx.stroke();
  ctx.fillStyle = '#f2c79d'; // 圆头
  ctx.beginPath();
  ctx.arc(lean + 1 * s, headY, 8 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a2a1a';
  ctx.beginPath();
  ctx.arc(lean + 1 * s, headY - 2 * s, 8 * s, Math.PI * 1.05, Math.PI * 1.95);
  ctx.fill();
  ctx.lineCap = 'butt';
  ctx.restore();

  // 跳出屏幕顶部时的位置提示
  if (p.y < 20) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(CONFIG.PLAYER_X, 6);
    ctx.lineTo(CONFIG.PLAYER_X - 8, 18);
    ctx.lineTo(CONFIG.PLAYER_X + 8, 18);
    ctx.fill();
  }
}

function drawParticles(gs, lane) {
  for (const pt of gs.particles) {
    if (pt.lane !== lane) continue;
    const a = 1 - pt.life / pt.max;
    ctx.fillStyle = `rgba(${pt.color},${(a * 0.85).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(toScreenX(gs, pt.wx), pt.y, pt.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 场景主绘制：从远到近逐条浪道绘制（海面 → 浪管内部 → 对象 → 角色 → 浪唇）
function drawWorld(gs) {
  drawSky(gs);
  const p = gs.player;
  const playerLane = Math.round(p.laneF);
  const viewL = -60;
  const viewR = W + 60;
  for (let lane = 0; lane < 3; lane++) {
    const L = CONFIG.LANES[lane];
    const pts = sampleSurface(gs, lane);
    drawLaneWater(gs, lane, pts);
    drawBarrelInside(gs, lane);
    drawWhitewater(gs, lane);
    ctx.save();
    ctx.globalAlpha = L.alpha;
    for (const it of gs.items) {
      if (it.lane !== lane) continue;
      const x = toScreenX(gs, it.wx);
      if (x > viewL && x < viewR) drawItem(gs, it);
    }
    for (const o of gs.obstacles) {
      if (o.lane !== lane) continue;
      const x = toScreenX(gs, o.wx);
      if (o.kind !== 'shark' && (x < viewL || x > viewR)) continue;
      if (o.kind === 'rock') drawRock(gs, o);
      else if (o.kind === 'jelly') drawJelly(gs, o);
      else drawShark(gs, o);
    }
    ctx.restore();
    drawParticles(gs, lane);
    if (lane === playerLane) {
      ctx.save();
      ctx.globalAlpha = laneParams(p.laneF).alpha * 0.3 + 0.7;
      drawPlayer(gs);
      ctx.restore();
    }
    // 玩家所在浪道的浪唇半透明，便于看到管内的自己
    drawBarrelLip(gs, lane, lane === playerLane && p.mode === 'barrel' ? 0.78 : 1);
  }
  // 浪管内视野受限：以玩家为中心的暗角
  if (p.mode === 'barrel') {
    const g = ctx.createRadialGradient(CONFIG.PLAYER_X, p.y - 20, 70, CONFIG.PLAYER_X, p.y - 20, 300);
    g.addColorStop(0, 'rgba(0, 20, 50, 0)');
    g.addColorStop(1, 'rgba(0, 20, 50, 0.82)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

/* =====================================================================
 * 9. UI 渲染
 * ===================================================================== */

const POWER_BTN = { x: W - 140, y: H - 72, w: 126, h: 56 };
const RESTART_BTN = { x: W / 2 - 100, y: H / 2 + 62, w: 200, h: 52 };

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawText(text, x, y, size, color, align, bold) {
  ctx.font = `${bold === false ? '' : 'bold '}${size}px "PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, size / 6);
  ctx.strokeStyle = 'rgba(0, 30, 60, 0.6)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// 左上角：分数与状态
function drawScore(gs) {
  const p = gs.player;
  ctx.fillStyle = 'rgba(0, 30, 60, 0.35)';
  roundRect(10, 10, 200, 70, 10);
  ctx.fill();
  drawText(`分数 ${Math.floor(gs.score)}`, 22, 30, 20, '#ffffff');
  drawText(`距离 ${Math.floor(p.wx / 20)}m   速度 ×${(effectiveSpeed(gs) / CONFIG.BASE_SPEED).toFixed(1)}`, 22, 58, 14, '#cdeeff', 'left', false);
  let status = '';
  let color = '#fff';
  if (p.mode === 'barrel') { status = `浪管中！ +${CONFIG.SCORE.barrelPerSec}/秒`; color = '#7dffb0'; }
  else if (p.mode === 'swim') { status = '游泳中…速度减半，无法吃道具'; color = '#ffb3b3'; }
  else if (p.mode === 'air' && p.spin.done + (p.spin.active ? 1 : 0) > 0) { status = `转体中 ×${p.spin.done + (p.spin.active ? 1 : 0)}`; color = '#ffd84d'; }
  if (status) drawText(status, 22, 98, 16, color);
}

// 顶部：平衡条
function drawBalance(gs) {
  const p = gs.player;
  const x = W / 2 - 180;
  const y = 16;
  const w = 290;
  const h = 18;
  drawText('平衡', x - 10, y + h / 2, 16, '#ffffff', 'right');
  ctx.fillStyle = 'rgba(0, 30, 60, 0.5)';
  roundRect(x - 3, y - 3, w + 6, h + 6, 8);
  ctx.fill();
  if (p.mode === 'swim') {
    // 游泳模式：显示爬回板上的倒计时
    const t = p.swimT / CONFIG.SWIM_TIME;
    ctx.fillStyle = '#8aa6bf';
    roundRect(x, y, w * (1 - t), h, 6);
    ctx.fill();
    drawText(`游泳模式 ${p.swimT.toFixed(1)}s 后爬回板上`, x + w / 2, y + h / 2, 13, '#ffffff', 'center');
    return;
  }
  const r = p.balance / CONFIG.BALANCE_MAX;
  const color = r > 0.6 ? '#4ee38a' : r > 0.3 ? '#ffd23f' : '#ff5a4f';
  if (r > 0) {
    ctx.fillStyle = color;
    roundRect(x, y, Math.max(8, w * r), h, 6);
    ctx.fill();
  }
  if (r <= 0.3 && Math.floor(gs.time * 6) % 2 === 0) {
    ctx.strokeStyle = '#ff5a4f';
    ctx.lineWidth = 2;
    roundRect(x - 3, y - 3, w + 6, h + 6, 8);
    ctx.stroke();
  }
  drawText(`${Math.round(p.balance)}`, x + w + 10, y + h / 2, 14, '#ffffff', 'left');
}

// 浪况预报里的缩略波形
function drawMiniWave(x, y, w, h, wave) {
  const ampN = clamp(wave.targetAmp / 175, 0.14, 1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const base = y + h - 4;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  for (let i = 0; i <= 30; i++) {
    const u = i / 30;
    ctx.lineTo(x + u * w, base - shape01(wave.type, u) * ampN * (h - 8));
  }
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#7fd6ff');
  g.addColorStop(1, '#15508a');
  ctx.fillStyle = g;
  ctx.fill();
  if (wave.type === 'barrel') {
    // 卷浪：画出浪唇卷曲
    const uc = peakU('barrel');
    const xc = x + uc * w;
    const yc = base - ampN * (h - 8);
    ctx.beginPath();
    ctx.moveTo(xc, yc);
    const ut = BARREL_TIP_U;
    ctx.bezierCurveTo(xc - w * 0.12, yc - 10, x + (ut - 0.08) * w, yc - 4, x + ut * w, base - (shape01('barrel', ut) + 0.34) * ampN * (h - 8));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
  } else if (wave.type === 'break') {
    // 碎浪：浪峰上的白色浪花点
    const [a, b] = whitewaterZone(wave);
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i <= 6; i++) {
      const u = lerp(a, b, i / 6);
      ctx.beginPath();
      ctx.arc(x + u * w, base - shape01('break', u) * ampN * (h - 8) - 1, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// 右上角：浪况预报（接下来 3 波浪）
function drawForecast(gs) {
  const list = upcomingWaves(gs, 3);
  const pw = 282;
  const x0 = W - pw - 10;
  const y0 = 10;
  ctx.fillStyle = 'rgba(0, 30, 60, 0.45)';
  roundRect(x0, y0, pw, 104, 10);
  ctx.fill();
  const cur = waveAt(gs, gs.player.wx);
  drawText('浪况预报', x0 + 10, y0 + 14, 14, '#ffffff');
  if (cur) drawText(`当前：${WAVE_TYPES[cur.wave.type].name}${cur.wave.big ? '(大)' : ''}`, x0 + pw - 10, y0 + 14, 12, '#cdeeff', 'right', false);
  const eff = effectiveSpeed(gs);
  list.forEach((wave, i) => {
    const cx = x0 + 10 + i * 90;
    const cy = y0 + 28;
    const cw = 82;
    const ch = 70;
    const def = WAVE_TYPES[wave.type];
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(cx, cy, cw, ch, 6);
    ctx.fill();
    const eta = (wave.start - gs.player.wx) / eff;
    // 即将到达的浪闪烁描边
    ctx.strokeStyle = def.color;
    ctx.lineWidth = i === 0 && eta < 1 && Math.floor(gs.time * 6) % 2 === 0 ? 3 : 1.5;
    roundRect(cx, cy, cw, ch, 6);
    ctx.stroke();
    drawMiniWave(cx + 4, cy + 4, cw - 8, 36, wave);
    drawText(def.name, cx + 6, cy + 51, 13, def.color === '#ffffff' ? '#ffffff' : def.color, 'left');
    drawText(`${eta.toFixed(1)}s`, cx + cw - 6, cy + 51, 11, '#cdeeff', 'right', false);
    if (wave.big) {
      ctx.fillStyle = '#ff5a4f';
      roundRect(cx + cw - 30, cy + 2, 28, 15, 4);
      ctx.fill();
      drawText('大浪', cx + cw - 16, cy + 10, 10, '#ffffff', 'center');
    }
    drawText(['下一波', '第二波', '第三波'][i], cx + 6, cy + 63, 10, 'rgba(255,255,255,0.65)', 'left', false);
  });
}

// 右下角："召唤大浪"按钮
function drawPowerButton(gs) {
  const b = POWER_BTN;
  const on = gs.powerCharges > 0;
  ctx.fillStyle = on ? 'rgba(26, 115, 217, 0.85)' : 'rgba(0, 30, 60, 0.35)';
  roundRect(b.x, b.y, b.w, b.h, 12);
  ctx.fill();
  ctx.strokeStyle = on ? '#8ff0ff' : 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  ctx.stroke();
  drawText('召唤大浪', b.x + b.w / 2, b.y + 20, 16, on ? '#ffffff' : 'rgba(255,255,255,0.5)', 'center');
  drawText(`×${gs.powerCharges}  [E / 点按]`, b.x + b.w / 2, b.y + 41, 11, on ? '#cdeeff' : 'rgba(255,255,255,0.4)', 'center', false);
}

function drawTexts(gs) {
  for (const t of gs.texts) {
    ctx.save();
    ctx.globalAlpha = 1 - (t.life / t.max) ** 2;
    drawText(t.text, t.x, t.y, t.size, t.color, 'center');
    ctx.restore();
  }
}

function drawOverlayPanel() {
  ctx.fillStyle = 'rgba(0, 20, 45, 0.55)';
  ctx.fillRect(0, 0, W, H);
}

function drawMenu(gs) {
  drawOverlayPanel();
  drawText('浪尖酷跑', W / 2, 120, 56, '#ffffff', 'center');
  drawText('—— 浪是活的，读浪才能活下去 ——', W / 2, 172, 18, '#bfe9ff', 'center', false);
  const lines = [
    '空格 / ↑ / 上滑：跳跃（在浪峰起跳有高度加成）',
    '↓ / 下滑：压板潜水（钻浪管、躲水母）',
    '← → / 左右滑：切换 3 条浪道；空中按 ← → 转体花式',
    'E / 点按右下按钮：召唤大浪（下一波浪变高，浪峰起跳吃金贝壳）',
    '碎浪的白色浪花必须跳过；礁石跳过；鲨鱼背鳍出现时尽快换道',
    '平衡归零会落水游泳 3 秒；看右上角"浪况预报"提前规划',
  ];
  lines.forEach((l, i) => drawText(l, W / 2, 222 + i * 30, 16, '#ffffff', 'center', false));
  if (Math.floor(gs.time * 2) % 2 === 0) drawText('点击屏幕 / 按空格开始', W / 2, 425, 24, '#ffe066', 'center');
  if (gs.best > 0) drawText(`最高分 ${gs.best}`, W / 2, 465, 16, '#cdeeff', 'center', false);
}

function drawGameOver(gs) {
  drawOverlayPanel();
  drawText(gs.overReason || '游戏结束', W / 2, H / 2 - 90, 40, '#ff8a7a', 'center');
  drawText(`得分 ${Math.floor(gs.score)}`, W / 2, H / 2 - 30, 34, '#ffffff', 'center');
  drawText(gs.newBest ? '新纪录！' : `最高分 ${gs.best}`, W / 2, H / 2 + 14, 18, gs.newBest ? '#ffe066' : '#cdeeff', 'center');
  const b = RESTART_BTN;
  ctx.fillStyle = '#ff9a3c';
  roundRect(b.x, b.y, b.w, b.h, 14);
  ctx.fill();
  drawText('重新开始', b.x + b.w / 2, b.y + b.h / 2, 22, '#ffffff', 'center');
  drawText('空格 / 回车 也可重开', W / 2, b.y + b.h + 22, 13, '#cdeeff', 'center', false);
}

function drawPause() {
  drawOverlayPanel();
  drawText('已暂停', W / 2, H / 2 - 10, 40, '#ffffff', 'center');
  drawText('按 P 或点击屏幕继续', W / 2, H / 2 + 36, 16, '#cdeeff', 'center', false);
}

function render() {
  const gs = gameState;
  const k = canvas.width / W;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.save();
  if (gs.shake > 0) ctx.translate(rand(-1, 1) * gs.shake * 14, rand(-1, 1) * gs.shake * 14);
  drawWorld(gs);
  drawTexts(gs);
  ctx.restore();
  if (gs.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${gs.flash})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (gs.phase === 'menu') {
    drawForecast(gs);
    drawMenu(gs);
    return;
  }
  drawScore(gs);
  drawBalance(gs);
  drawForecast(gs);
  drawPowerButton(gs);
  if (gs.phase === 'over') drawGameOver(gs);
  else if (gs.phase === 'paused') drawPause();
}

/* =====================================================================
 * 10. 输入绑定（键盘 + 触屏/鼠标滑动）
 * ===================================================================== */

function startGame() {
  gameState = createGameState('playing');
  ensureWaves(gameState);
}

function pushAction(action) {
  const gs = gameState;
  if (gs.phase === 'menu') {
    if (action === 'jump' || action === 'tap' || action === 'enter') startGame();
    return;
  }
  if (gs.phase === 'over') {
    if (action === 'jump' || action === 'enter') startGame();
    return;
  }
  if (gs.phase === 'paused') {
    if (action === 'tap' || action === 'pause') gs.phase = 'playing';
    return;
  }
  if (action === 'pause') { gs.phase = 'paused'; return; }
  if (action === 'tap') action = 'jump'; // 轻点屏幕也视为跳跃
  if (action === 'enter') return;
  gs.input.queue.push(action);
}

const KEY_MAP = {
  Space: 'jump', ArrowUp: 'jump', KeyW: 'jump',
  ArrowDown: 'dive', KeyS: 'dive',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  KeyE: 'power', KeyQ: 'power',
  KeyP: 'pause', Escape: 'pause',
  Enter: 'enter', NumpadEnter: 'enter', KeyR: 'enter',
};

window.addEventListener('keydown', (e) => {
  const action = KEY_MAP[e.code];
  if (!action) return;
  e.preventDefault();
  if (action === 'dive') gameState.input.downHeld = true;
  if (e.repeat) return;
  pushAction(action);
});
window.addEventListener('keyup', (e) => {
  if (KEY_MAP[e.code] === 'dive') gameState.input.downHeld = false;
});

// 指针坐标 → 逻辑坐标
function toLogical(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}
const inRect = (pt, b) => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h;

// 滑动识别：移动超过阈值立即触发（响应更快），否则抬起时视为轻点
const SWIPE_MIN = 28;
let pointer = null;
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  pointer = { id: e.pointerId, start: toLogical(e), fired: false };
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointer || pointer.id !== e.pointerId || pointer.fired) return;
  const pt = toLogical(e);
  const dx = pt.x - pointer.start.x;
  const dy = pt.y - pointer.start.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN) return;
  pointer.fired = true;
  if (Math.abs(dx) > Math.abs(dy)) pushAction(dx > 0 ? 'right' : 'left');
  else pushAction(dy < 0 ? 'jump' : 'dive');
});
canvas.addEventListener('pointerup', (e) => {
  if (!pointer || pointer.id !== e.pointerId) return;
  const fired = pointer.fired;
  pointer = null;
  if (fired) return;
  const pt = toLogical(e);
  const gs = gameState;
  if (gs.phase === 'over') {
    if (inRect(pt, RESTART_BTN)) startGame();
    return;
  }
  if (gs.phase === 'playing' && inRect(pt, POWER_BTN)) {
    pushAction('power');
    return;
  }
  pushAction('tap');
});
canvas.addEventListener('pointercancel', () => { pointer = null; });

// 切到后台自动暂停
document.addEventListener('visibilitychange', () => {
  if (document.hidden && gameState.phase === 'playing') gameState.phase = 'paused';
});

/* =====================================================================
 * 11. 主循环：requestAnimationFrame + 固定时间步长
 * ===================================================================== */

function update(dt) {
  const gs = gameState;
  if (gs.phase === 'paused') return;
  gs.time += dt;
  gs.shake = Math.max(0, gs.shake - dt);
  gs.flash = Math.max(0, gs.flash - dt);
  updateParticles(gs, dt);
  if (gs.phase === 'over') return;

  if (gs.phase === 'menu') {
    // 菜单界面：角色自动滑行作为背景演示
    gs.input.queue.length = 0;
    gs.player.balance = CONFIG.BALANCE_MAX;
    updatePlayer(gs, dt);
    updateWaves(gs, dt);
    spawnFoam(gs);
    return;
  }

  gs.elapsed += dt;
  gs.speed = Math.min(CONFIG.MAX_SPEED, CONFIG.BASE_SPEED + gs.elapsed * CONFIG.SPEED_GAIN);
  const before = gs.player.wx;
  updatePlayer(gs, dt);
  gs.score += (gs.player.wx - before) * CONFIG.SCORE.distPerPx;
  updateWaves(gs, dt);
  updateObstacles(gs, dt);
  spawnFoam(gs);
  checkCollisions(gs);
}

let lastTime = performance.now();
let accumulator = 0;
function frame(now) {
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.25) dt = 0.25; // 防止切回标签页时一次性补算过多
  accumulator += dt;
  while (accumulator >= CONFIG.STEP) {
    update(CONFIG.STEP);
    accumulator -= CONFIG.STEP;
  }
  render();
  requestAnimationFrame(frame);
}

ensureWaves(gameState);
requestAnimationFrame(frame);

// 暴露给调试/自动化测试
window.__surf = { get state() { return gameState; }, startGame, useBigWave: () => useBigWave(gameState) };
