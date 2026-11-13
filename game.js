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
    { baseY: 300, scale: 0.72, alpha: 0.7, top: '#9fe6f7', mid: '#4fb6e3', bottom: '#2a76b0' },
    { baseY: 392, scale: 0.86, alpha: 0.86, top: '#6fd4f2', mid: '#2e9bd8', bottom: '#1a5a98' },
    { baseY: 478, scale: 1.0, alpha: 1.0, top: '#4cc3ef', mid: '#1f86cc', bottom: '#0a3a74' },
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

/* ---------- 绘图小工具 ---------- */

// 确定性伪随机（按世界坐标取值，避免每帧闪烁）
function hash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// 离屏精灵：把静态图形预先画好，运行时只做 drawImage
function makeSprite(w, h, draw) {
  const c = document.createElement('canvas');
  const k = 2;
  c.width = w * k;
  c.height = h * k;
  const g = c.getContext('2d');
  g.scale(k, k);
  draw(g, w, h);
  return c;
}

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function roundRect(x, y, w, h, r) {
  roundRectPath(ctx, x, y, w, h, r);
}

// 两段式肢体（带深色描边的卡通线条）
function limb(x0, y0, x1, y1, x2, y2, width, color, outline) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = outline || '#2b1a10';
  ctx.lineWidth = width + 2.6;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/* ---------- 云 / 岛屿 精灵 ---------- */

// 蓬松的云：先画偏下的阴影层，再叠白色亮层
function cloudSprite(w, h, puffs) {
  return makeSprite(w, h, (g) => {
    const layers = [
      { dy: 5, color: 'rgba(150, 190, 225, 0.55)' },
      { dy: 0, color: '#ffffff' },
    ];
    for (const ly of layers) {
      g.fillStyle = ly.color;
      g.beginPath();
      for (const [px, py, r] of puffs) g.ellipse(px, py + ly.dy, r * 1.25, r, 0, 0, Math.PI * 2);
      g.fill();
    }
    // 云底部淡蓝阴影
    g.fillStyle = 'rgba(170, 205, 235, 0.45)';
    g.beginPath();
    g.ellipse(w / 2, h - 12, w * 0.4, 7, 0, 0, Math.PI * 2);
    g.fill();
  });
}
const CLOUDS = [
  cloudSprite(200, 90, [[60, 55, 24], [100, 42, 32], [145, 52, 26], [120, 62, 22], [80, 66, 18]]),
  cloudSprite(150, 70, [[45, 42, 18], [75, 32, 24], [108, 42, 19], [80, 50, 17]]),
  cloudSprite(260, 100, [[60, 64, 24], [110, 44, 36], [160, 50, 32], [205, 62, 24], [130, 70, 26]]),
];

// 远处的岛屿（含椰树与沙滩）
function palm(g, x, y, s, lean) {
  g.strokeStyle = '#7a4a24';
  g.lineWidth = 4 * s;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x, y);
  g.quadraticCurveTo(x + lean * 8 * s, y - 22 * s, x + lean * 14 * s, y - 42 * s);
  g.stroke();
  const tx = x + lean * 14 * s;
  const ty = y - 42 * s;
  g.strokeStyle = '#2f9e52';
  g.lineWidth = 3.2 * s;
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i - 2.5) * 0.55;
    g.beginPath();
    g.moveTo(tx, ty);
    g.quadraticCurveTo(tx + Math.cos(a) * 20 * s, ty + Math.sin(a) * 20 * s - 6 * s, tx + Math.cos(a) * 26 * s, ty + Math.sin(a) * 26 * s + 10 * s);
    g.stroke();
  }
  g.fillStyle = '#6b3d1c';
  g.beginPath();
  g.arc(tx, ty + 3 * s, 3 * s, 0, Math.PI * 2);
  g.fill();
}
const ISLAND_FAR = makeSprite(520, 110, (g, w, h) => {
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#9fcfe3');
  grad.addColorStop(1, '#6fa9c7');
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, h);
  g.quadraticCurveTo(70, 70, 150, 50);
  g.quadraticCurveTo(210, 10, 290, 46);
  g.quadraticCurveTo(360, 60, 420, 40);
  g.quadraticCurveTo(480, 30, w, h);
  g.closePath();
  g.fill();
});
const ISLAND_NEAR = makeSprite(420, 150, (g, w, h) => {
  // 山体
  const grad = g.createLinearGradient(0, 20, 0, h);
  grad.addColorStop(0, '#5cc27a');
  grad.addColorStop(0.6, '#2f8f52');
  grad.addColorStop(1, '#246b40');
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(20, h - 14);
  g.quadraticCurveTo(90, 60, 170, 70);
  g.quadraticCurveTo(230, 24, 300, 66);
  g.quadraticCurveTo(360, 80, 400, h - 14);
  g.closePath();
  g.fill();
  // 山体亮面
  g.fillStyle = 'rgba(255,255,255,0.14)';
  g.beginPath();
  g.moveTo(170, 72);
  g.quadraticCurveTo(230, 28, 300, 66);
  g.lineTo(250, 80);
  g.closePath();
  g.fill();
  // 沙滩
  g.fillStyle = '#f3e3b4';
  g.beginPath();
  g.ellipse(w / 2, h - 12, 200, 9, 0, 0, Math.PI * 2);
  g.fill();
  palm(g, 110, h - 16, 1.0, 1);
  palm(g, 300, h - 18, 1.1, -1);
  palm(g, 330, h - 14, 0.8, 1);
});

/* ---------- 天空与远景 ---------- */

const HORIZON = 236;
const SUN = { x: 760, y: 78 };

function drawSky(gs) {
  const p = gs.player;
  // 天空渐变：顶部深蓝 → 地平线暖白
  const g = ctx.createLinearGradient(0, 0, 0, HORIZON);
  g.addColorStop(0, '#2a8ae6');
  g.addColorStop(0.55, '#79cbf7');
  g.addColorStop(1, '#eaf8ff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, HORIZON + 2);

  // 太阳：光晕 + 缓慢旋转的光芒
  const glow = ctx.createRadialGradient(SUN.x, SUN.y, 10, SUN.x, SUN.y, 190);
  glow.addColorStop(0, 'rgba(255, 250, 220, 0.85)');
  glow.addColorStop(0.25, 'rgba(255, 240, 190, 0.35)');
  glow.addColorStop(1, 'rgba(255, 240, 190, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, HORIZON + 2);
  ctx.save();
  ctx.translate(SUN.x, SUN.y);
  ctx.rotate(gs.time * 0.05);
  ctx.fillStyle = 'rgba(255, 250, 215, 0.10)';
  for (let i = 0; i < 10; i++) {
    ctx.rotate((Math.PI * 2) / 10);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-22, -260);
    ctx.lineTo(22, -260);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = '#fff8dc';
  ctx.beginPath();
  ctx.arc(SUN.x, SUN.y, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(SUN.x - 8, SUN.y - 8, 16, 0, Math.PI * 2);
  ctx.fill();

  // 远层云（小、淡、慢）
  const far = p.wx * 0.03 + gs.time * 6;
  ctx.globalAlpha = 0.7;
  for (let i = 0; i < 6; i++) {
    const span = W + 320;
    const x = ((i * 230 + hash01(i) * 120 - far) % span + span) % span - 160;
    const y = 24 + hash01(i + 9) * 70;
    const sp = CLOUDS[i % 3];
    const sc = 0.45 + hash01(i + 3) * 0.2;
    ctx.drawImage(sp, x, y, (sp.width / 2) * sc, (sp.height / 2) * sc);
  }
  ctx.globalAlpha = 1;

  // 远岛（雾蒙蒙）
  const fOff = ((p.wx * 0.08) % 1900 + 1900) % 1900;
  ctx.globalAlpha = 0.75;
  ctx.drawImage(ISLAND_FAR, 1100 - fOff, HORIZON - 96, 520, 110);
  ctx.drawImage(ISLAND_FAR, 1100 - fOff + 1900, HORIZON - 96, 520, 110);
  ctx.globalAlpha = 1;
  // 近岛（椰树）
  const nOff = ((p.wx * 0.15) % 2600 + 2600) % 2600;
  ctx.drawImage(ISLAND_NEAR, 1400 - nOff, HORIZON - 130, 420, 150);
  ctx.drawImage(ISLAND_NEAR, 1400 - nOff + 2600, HORIZON - 130, 420, 150);

  // 近层云（大、白、快）
  const near = p.wx * 0.07 + gs.time * 12;
  for (let i = 0; i < 4; i++) {
    const span = W + 420;
    const x = ((i * 330 + hash01(i + 20) * 150 - near) % span + span) % span - 210;
    const y = 40 + hash01(i + 30) * 90;
    const sp = CLOUDS[(i + 1) % 3];
    const sc = 0.8 + hash01(i + 40) * 0.35;
    ctx.drawImage(sp, x, y, (sp.width / 2) * sc, (sp.height / 2) * sc);
  }

  // 海鸥
  ctx.strokeStyle = 'rgba(40, 60, 90, 0.75)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const bOff = p.wx * 0.2 + gs.time * 30;
  for (let i = 0; i < 4; i++) {
    const span = W + 600;
    const x = ((i * 520 + hash01(i + 60) * 300 - bOff) % span + span) % span - 300;
    const y = 60 + hash01(i + 70) * 80 + Math.sin(gs.time * 1.5 + i) * 6;
    const flap = Math.sin(gs.time * 9 + i * 2) * 4;
    ctx.beginPath();
    ctx.moveTo(x - 10, y + flap);
    ctx.quadraticCurveTo(x - 5, y - 3, x, y);
    ctx.quadraticCurveTo(x + 5, y - 3, x + 10, y + flap);
    ctx.stroke();
  }

  // 地平线雾气
  const haze = ctx.createLinearGradient(0, HORIZON - 40, 0, HORIZON + 30);
  haze.addColorStop(0, 'rgba(255,255,255,0)');
  haze.addColorStop(0.6, 'rgba(255,255,255,0.55)');
  haze.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, HORIZON - 40, W, 70);

  // 远海 + 太阳倒影
  const sea = ctx.createLinearGradient(0, HORIZON, 0, H);
  sea.addColorStop(0, '#5fc3ea');
  sea.addColorStop(0.5, '#2f8ccb');
  sea.addColorStop(1, '#154f8a');
  ctx.fillStyle = sea;
  ctx.fillRect(0, HORIZON, W, H - HORIZON);
  ctx.fillStyle = 'rgba(255, 250, 220, 0.22)';
  for (let i = 0; i < 14; i++) {
    const y = HORIZON + 4 + i * 6;
    const wv = 30 + i * 4 + Math.sin(gs.time * 3 + i * 1.7) * 10;
    ctx.fillRect(SUN.x - wv / 2 + Math.sin(gs.time * 2 + i) * 6, y, wv, 2);
  }
}

/* ---------- 海面 ---------- */

// 某条浪道的海面路径（屏幕坐标采样点）
function sampleSurface(gs, lane) {
  const pts = [];
  const p = gs.player;
  for (let sx = -10; sx <= W + 10; sx += 6) {
    pts.push(sx, surfaceY(gs, lane, p.wx + sx - CONFIG.PLAYER_X));
  }
  return pts;
}

function surfacePath(pts, closeToBottom) {
  ctx.beginPath();
  if (closeToBottom) ctx.moveTo(pts[0], H + 10);
  for (let i = 0; i < pts.length; i += 2) {
    if (i === 0 && !closeToBottom) ctx.moveTo(pts[i], pts[i + 1]);
    else ctx.lineTo(pts[i], pts[i + 1]);
  }
  if (closeToBottom) {
    ctx.lineTo(pts[pts.length - 2], H + 10);
    ctx.closePath();
  }
}

// 浪面下一层半透明的"透光"带：越靠近水面越亮，表现阳光穿透浪壁
function drawTranslucentBands(pts, scale) {
  const bands = [[7, 0.32], [18, 0.18], [36, 0.09]];
  for (const [d, a] of bands) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) ctx.moveTo(pts[i], pts[i + 1]);
      else ctx.lineTo(pts[i], pts[i + 1]);
    }
    for (let i = pts.length - 2; i >= 0; i -= 2) ctx.lineTo(pts[i], pts[i + 1] + d * scale);
    ctx.closePath();
    ctx.fillStyle = `rgba(190, 248, 255, ${a})`;
    ctx.fill();
  }
}

function drawLaneWater(gs, lane, pts) {
  const L = CONFIG.LANES[lane];
  const p = gs.player;
  // 水体：浅青 → 深蓝
  const g = ctx.createLinearGradient(0, L.baseY - 130 * L.scale, 0, H);
  g.addColorStop(0, L.top);
  g.addColorStop(0.45, L.mid);
  g.addColorStop(1, L.bottom);
  surfacePath(pts, true);
  ctx.fillStyle = g;
  ctx.fill();

  drawTranslucentBands(pts, L.scale);

  // 波光：随水流漂动的细碎亮纹
  ctx.lineCap = 'round';
  for (let i = 0; i < 34; i++) {
    const period = 1300;
    const wxBase = i * 38 + hash01(i + lane * 100) * 60;
    const wx = p.wx - CONFIG.PLAYER_X + ((wxBase - p.wx * 0.9 * 1) % period + period) % period;
    const sx = toScreenX(gs, wx);
    if (sx < -30 || sx > W + 30) continue;
    const depth = 10 + hash01(i + 7 + lane * 31) * 70;
    const y = surfaceY(gs, lane, wx) + depth * L.scale;
    if (y > H) continue;
    const len = (8 + hash01(i + 13) * 22) * L.scale;
    const a = (0.08 + 0.14 * (0.5 + 0.5 * Math.sin(gs.time * 2.2 + i * 1.9))) * (1 - depth / 110);
    ctx.strokeStyle = `rgba(230, 252, 255, ${a.toFixed(3)})`;
    ctx.lineWidth = 2 * L.scale;
    ctx.beginPath();
    ctx.moveTo(sx - len / 2, y);
    ctx.lineTo(sx + len / 2, y);
    ctx.stroke();
  }

  // 浪面高光：柔光 + 锐利白线
  surfacePath(pts, false);
  ctx.strokeStyle = `rgba(255,255,255,${0.18 * L.scale})`;
  ctx.lineWidth = 7 * L.scale;
  ctx.stroke();
  surfacePath(pts, false);
  ctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.3 * L.scale})`;
  ctx.lineWidth = 2 * L.scale;
  ctx.stroke();

  // 陡坡处的细碎泡沫（蕾丝状）
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (let i = 2; i < pts.length - 2; i += 2) {
    const slope = (pts[i + 3] - pts[i - 1]) / 12;
    if (Math.abs(slope) < 0.42) continue;
    const wx = p.wx + pts[i] - CONFIG.PLAYER_X;
    const cell = Math.floor(wx / 9);
    const h = hash01(cell + lane * 977);
    if (h > Math.min(0.9, Math.abs(slope) * 0.9)) continue;
    const r = (1.2 + h * 2.2) * L.scale;
    const bob = Math.sin(gs.time * 5 + cell) * 1.5;
    ctx.beginPath();
    ctx.arc(pts[i] + (h - 0.5) * 8, pts[i + 1] - 2 * L.scale - h * 5 + bob, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 远景加一层雾气，强化景深
  if (lane < 2) {
    surfacePath(pts, true);
    ctx.fillStyle = `rgba(215, 242, 255, ${lane === 0 ? 0.2 : 0.09})`;
    ctx.fill();
  }
}

// 板尾尾迹：从板后向左逐渐散开、变淡的白色水痕
function drawWake(gs) {
  const p = gs.player;
  if (p.mode !== 'ride' && p.mode !== 'barrel') return;
  const lane = Math.round(p.laneF);
  const s = laneParams(p.laneF).scale;
  const len = 120 * s;
  const x0 = CONFIG.PLAYER_X - 22 * s;
  ctx.beginPath();
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const sx = x0 - t * len;
    const wx = p.wx + sx - CONFIG.PLAYER_X;
    const y = surfaceY(gs, lane, wx);
    const spread = (1 + t * 7 + Math.sin(gs.time * 14 + i) * 1.2) * s;
    if (i === 0) ctx.moveTo(sx, y - spread);
    else ctx.lineTo(sx, y - spread);
  }
  for (let i = n; i >= 0; i--) {
    const t = i / n;
    const sx = x0 - t * len;
    const wx = p.wx + sx - CONFIG.PLAYER_X;
    ctx.lineTo(sx, surfaceY(gs, lane, wx) + (2 + t * 2) * s);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(x0, 0, x0 - len, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fill();
}

// 碎浪：浪峰上翻滚的白色泡沫带（凹凸的顶边 + 两层叠加）
function drawWhitewater(gs, lane) {
  const L = CONFIG.LANES[lane];
  const s = L.scale;
  for (const w of gs.waves) {
    if (w.type !== 'break') continue;
    const [a, b] = whitewaterZone(w);
    const x0W = w.start + a * w.len;
    const x1W = w.start + b * w.len;
    const x0 = toScreenX(gs, x0W);
    const x1 = toScreenX(gs, x1W);
    if (x1 < -20 || x0 > W + 20) continue;
    const layers = [
      { lift: 1, color: 'rgba(225, 245, 255, 0.85)', k: 0 },
      { lift: 0.62, color: 'rgba(255, 255, 255, 0.95)', k: 1 },
    ];
    for (const ly of layers) {
      ctx.beginPath();
      const tops = [];
      for (let wx = x0W; wx <= x1W; wx += 9) {
        const sx = toScreenX(gs, wx);
        const u = (wx - x0W) / (x1W - x0W);
        const edge = Math.sin(u * Math.PI); // 两端收窄
        const cell = Math.floor(wx / 9);
        const bump = (4 + hash01(cell + ly.k * 500) * 9 + Math.sin(gs.time * 6 + cell * 0.7) * 2) * edge;
        const y = surfaceY(gs, lane, wx) - bump * s * ly.lift - 2 * s;
        tops.push(sx, y);
        if (wx === x0W) ctx.moveTo(sx, y);
        else ctx.lineTo(sx, y);
      }
      for (let wx = x1W; wx >= x0W; wx -= 9) {
        ctx.lineTo(toScreenX(gs, wx), surfaceY(gs, lane, wx) + 6 * s);
      }
      ctx.closePath();
      ctx.fillStyle = ly.color;
      ctx.fill();
      // 泡沫顶部圆鼓鼓的边缘
      ctx.fillStyle = ly.color;
      for (let i = 0; i < tops.length; i += 2) {
        ctx.beginPath();
        ctx.arc(tops[i], tops[i + 1], (3 + hash01(i + ly.k * 77) * 4) * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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
    grad.addColorStop(0, 'rgba(20, 70, 130, 0.25)');
    grad.addColorStop(0.5, 'rgba(6, 36, 84, 0.6)');
    grad.addColorStop(1, 'rgba(3, 20, 52, 0.85)');
    ctx.fillStyle = grad;
    ctx.fill();
    // 管壁内侧的透光亮边
    ctx.beginPath();
    ctx.moveTo(g.xt, g.yt);
    ctx.bezierCurveTo(g.inner[0], g.inner[1], g.inner[2], g.inner[3], g.innerEnd[0], g.innerEnd[1]);
    ctx.strokeStyle = 'rgba(170, 240, 255, 0.5)';
    ctx.lineWidth = 3 * CONFIG.LANES[lane].scale;
    ctx.stroke();
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
    grad.addColorStop(0, L.mid);
    grad.addColorStop(0.55, '#6fd8fb');
    grad.addColorStop(1, '#c9f4ff');
    ctx.fillStyle = grad;
    ctx.fill();
    // 浪唇外缘白边 + 柔光
    ctx.beginPath();
    ctx.moveTo(g.xc + 4, g.yc + 2);
    ctx.bezierCurveTo(g.outer[0], g.outer[1], g.outer[2], g.outer[3], g.xt, g.yt);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 7 * L.scale;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2.5 * L.scale;
    ctx.stroke();
    // 浪唇上顺着水流方向的细纹，表现翻卷的水体
    ctx.lineWidth = 1.4 * L.scale;
    for (const t of [0.3, 0.55, 0.8]) {
      ctx.strokeStyle = `rgba(255,255,255,${(0.42 - t * 0.3).toFixed(2)})`;
      ctx.beginPath();
      ctx.moveTo(lerp(g.xc + 4, g.innerEnd[0], t), lerp(g.yc + 2, g.innerEnd[1], t));
      ctx.bezierCurveTo(
        lerp(g.outer[0], g.inner[2], t), lerp(g.outer[1], g.inner[3], t),
        lerp(g.outer[2], g.inner[0], t), lerp(g.outer[3], g.inner[1], t),
        g.xt + (g.xc - g.xt) * 0.06 * t, g.yt + 2 * t * L.scale);
      ctx.stroke();
    }
    // 浪唇尖端飞溅的水沫
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 12; i++) {
      const ph = (gs.time * 1.6 + hash01(i + w.id)) % 1;
      const dx = (hash01(i * 3 + 1) - 0.7) * 40 * ph * L.scale;
      const dy = (ph * 26 - Math.sin(ph * Math.PI) * 14) * L.scale;
      ctx.globalAlpha = alphaMul * (1 - ph) * 0.9;
      ctx.beginPath();
      ctx.arc(g.xt + dx, g.yt + dy, (1.5 + hash01(i * 7) * 3) * L.scale * (1 - ph * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ---------- 障碍与道具 ---------- */

function drawRock(gs, o) {
  const L = CONFIG.LANES[o.lane];
  const s = L.scale;
  const x = toScreenX(gs, o.wx);
  const y = surfaceY(gs, o.lane, o.wx) + 6 * s;
  // 水下的暗影
  ctx.fillStyle = 'rgba(10, 40, 80, 0.35)';
  ctx.beginPath();
  ctx.ellipse(x, y + 4 * s, 30 * s, 8 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  // 主体：多面体 + 立体渐变
  const g = ctx.createLinearGradient(x - 20 * s, y - 30 * s, x + 16 * s, y);
  g.addColorStop(0, '#8d8a99');
  g.addColorStop(0.5, '#5a5566');
  g.addColorStop(1, '#3a3542');
  ctx.fillStyle = g;
  ctx.strokeStyle = '#2a2530';
  ctx.lineWidth = 2 * s;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 24 * s, y);
  ctx.lineTo(x - 18 * s, y - 16 * s);
  ctx.lineTo(x - 8 * s, y - 30 * s);
  ctx.lineTo(x + 4 * s, y - 26 * s);
  ctx.lineTo(x + 14 * s, y - 20 * s);
  ctx.lineTo(x + 24 * s, y - 6 * s);
  ctx.lineTo(x + 26 * s, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 受光面
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.moveTo(x - 18 * s, y - 16 * s);
  ctx.lineTo(x - 8 * s, y - 30 * s);
  ctx.lineTo(x + 4 * s, y - 26 * s);
  ctx.lineTo(x - 4 * s, y - 14 * s);
  ctx.closePath();
  ctx.fill();
  // 青苔
  ctx.fillStyle = '#4caf6a';
  for (const [dx, dy, r] of [[-12, -18, 3], [6, -22, 2.4], [-2, -12, 2]]) {
    ctx.beginPath();
    ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // 水线泡沫
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.ellipse(x, y - 1 * s, 30 * s, 4 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 6; i++) {
    const a = gs.time * 3 + i;
    ctx.beginPath();
    ctx.arc(x + (i - 2.5) * 11 * s, y - 3 * s + Math.sin(a) * 2 * s, 2.5 * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawJelly(gs, o) {
  const s = CONFIG.LANES[o.lane].scale;
  const b = obstacleBody(gs, o);
  const r = 14 * s;
  // 发光
  const glow = ctx.createRadialGradient(b.x, b.y, r * 0.4, b.x, b.y, r * 2.4);
  glow.addColorStop(0, 'rgba(255, 150, 255, 0.35)');
  glow.addColorStop(1, 'rgba(255, 150, 255, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(b.x, b.y, r * 2.4, 0, Math.PI * 2);
  ctx.fill();
  // 触手
  ctx.lineCap = 'round';
  for (let i = -2; i <= 2; i++) {
    const tx = b.x + i * 5 * s;
    const sway = Math.sin(o.phase + gs.time * 4 + i) * 5 * s;
    const grad = ctx.createLinearGradient(0, b.y + 4 * s, 0, b.y + 24 * s);
    grad.addColorStop(0, 'rgba(240, 150, 255, 0.9)');
    grad.addColorStop(1, 'rgba(240, 150, 255, 0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = (i === 0 ? 3 : 2.2) * s;
    ctx.beginPath();
    ctx.moveTo(tx, b.y + 4 * s);
    ctx.quadraticCurveTo(tx + sway, b.y + 14 * s, tx - sway * 0.6, b.y + 24 * s);
    ctx.stroke();
  }
  // 伞盖
  const bell = ctx.createRadialGradient(b.x - r * 0.35, b.y - r * 0.5, r * 0.1, b.x, b.y, r * 1.1);
  bell.addColorStop(0, '#ffd6ff');
  bell.addColorStop(0.5, '#e98cf5');
  bell.addColorStop(1, '#b14fd8');
  ctx.fillStyle = bell;
  ctx.strokeStyle = 'rgba(110, 40, 140, 0.8)';
  ctx.lineWidth = 1.6 * s;
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, Math.PI, 0);
  ctx.quadraticCurveTo(b.x + r * 0.7, b.y + 6 * s, b.x + r * 0.3, b.y + 4 * s);
  ctx.quadraticCurveTo(b.x, b.y + 7 * s, b.x - r * 0.3, b.y + 4 * s);
  ctx.quadraticCurveTo(b.x - r * 0.7, b.y + 6 * s, b.x - r, b.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 高光 + 眼睛
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.ellipse(b.x - r * 0.4, b.y - r * 0.5, 4 * s, 2.5 * s, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a1a4a';
  ctx.beginPath();
  ctx.arc(b.x - 4 * s, b.y - 1 * s, 1.8 * s, 0, Math.PI * 2);
  ctx.arc(b.x + 4 * s, b.y - 1 * s, 1.8 * s, 0, Math.PI * 2);
  ctx.fill();
}

function drawSharkBody(s) {
  // 以鼻尖朝左、原点在身体中心的鲨鱼
  const body = ctx.createLinearGradient(0, -16 * s, 0, 14 * s);
  body.addColorStop(0, '#5e7a92');
  body.addColorStop(0.55, '#44596c');
  body.addColorStop(0.56, '#e9f0f5');
  body.addColorStop(1, '#c9d6e0');
  ctx.fillStyle = body;
  ctx.strokeStyle = '#243240';
  ctx.lineWidth = 1.8 * s;
  ctx.lineJoin = 'round';
  // 尾鳍
  ctx.beginPath();
  ctx.moveTo(30 * s, -2 * s);
  ctx.lineTo(56 * s, -22 * s);
  ctx.lineTo(50 * s, 0);
  ctx.lineTo(54 * s, 14 * s);
  ctx.lineTo(30 * s, 4 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 背鳍
  ctx.beginPath();
  ctx.moveTo(-6 * s, -12 * s);
  ctx.quadraticCurveTo(6 * s, -34 * s, 14 * s, -30 * s);
  ctx.lineTo(18 * s, -10 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 身体
  ctx.beginPath();
  ctx.moveTo(-44 * s, 0);
  ctx.bezierCurveTo(-30 * s, -18 * s, 10 * s, -18 * s, 36 * s, -4 * s);
  ctx.bezierCurveTo(40 * s, 0, 40 * s, 2 * s, 36 * s, 5 * s);
  ctx.bezierCurveTo(10 * s, 16 * s, -30 * s, 14 * s, -44 * s, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 胸鳍
  ctx.fillStyle = '#4b6072';
  ctx.beginPath();
  ctx.moveTo(-8 * s, 8 * s);
  ctx.lineTo(4 * s, 24 * s);
  ctx.lineTo(12 * s, 8 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 鳃
  ctx.strokeStyle = 'rgba(30, 45, 60, 0.7)';
  ctx.lineWidth = 1.2 * s;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo((-20 + i * 4) * s, -6 * s);
    ctx.quadraticCurveTo((-23 + i * 4) * s, 0, (-20 + i * 4) * s, 5 * s);
    ctx.stroke();
  }
  // 嘴和牙齿
  ctx.fillStyle = '#8a1428';
  ctx.beginPath();
  ctx.moveTo(-44 * s, 1 * s);
  ctx.quadraticCurveTo(-32 * s, 4 * s, -24 * s, 3 * s);
  ctx.quadraticCurveTo(-32 * s, 12 * s, -42 * s, 8 * s);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 5; i++) {
    const tx = (-41 + i * 4) * s;
    ctx.beginPath();
    ctx.moveTo(tx, 2 * s);
    ctx.lineTo(tx + 1.6 * s, 5.5 * s);
    ctx.lineTo(tx + 3.2 * s, 2.5 * s);
    ctx.closePath();
    ctx.fill();
  }
  // 眼睛
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-30 * s, -6 * s, 3.2 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.arc(-31 * s, -6 * s, 1.8 * s, 0, Math.PI * 2);
  ctx.fill();
}

function drawShark(gs, o) {
  const L = CONFIG.LANES[o.lane];
  const s = L.scale;
  const x = toScreenX(gs, o.wx);
  const surf = surfaceY(gs, o.lane, o.wx);
  if (o.state === 'warn') {
    // 屏幕右侧的脉冲预警徽章
    const pulse = 0.5 + 0.5 * Math.sin(gs.time * 10);
    const cx = W - 34;
    const cy = surf - 18 * s;
    ctx.fillStyle = `rgba(255, 60, 60, ${0.25 * pulse})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 26 + pulse * 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff3b3b';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 20);
    ctx.lineTo(cx + 20, cy + 14);
    ctx.lineTo(cx - 20, cy + 14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    drawText('!', cx, cy + 2, 20, '#ffffff', 'center');
    // 指向鲨鱼来向的小箭头
    ctx.fillStyle = `rgba(255, 80, 80, ${0.5 + pulse * 0.5})`;
    ctx.beginPath();
    ctx.moveTo(cx - 36, cy);
    ctx.lineTo(cx - 48, cy - 8);
    ctx.lineTo(cx - 48, cy + 8);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (o.state === 'fin' || o.state === 'gone') {
    // 水下的黑影
    ctx.fillStyle = 'rgba(20, 40, 70, 0.35)';
    ctx.beginPath();
    ctx.ellipse(x + 10 * s, surf + 10 * s, 44 * s, 8 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // 背鳍
    const g = ctx.createLinearGradient(0, surf - 28 * s, 0, surf);
    g.addColorStop(0, '#5e7a92');
    g.addColorStop(1, '#2f3f4e');
    ctx.fillStyle = g;
    ctx.strokeStyle = '#1e2a36';
    ctx.lineWidth = 1.6 * s;
    ctx.beginPath();
    ctx.moveTo(x - 14 * s, surf + 2 * s);
    ctx.quadraticCurveTo(x - 4 * s, surf - 14 * s, x + 6 * s, surf - 28 * s);
    ctx.quadraticCurveTo(x + 8 * s, surf - 10 * s, x + 18 * s, surf + 2 * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // V 形尾迹
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(x - 10 * s, surf);
    ctx.quadraticCurveTo(x + 30 * s, surf - 6 * s, x + 70 * s, surf - 10 * s);
    ctx.moveTo(x - 10 * s, surf);
    ctx.quadraticCurveTo(x + 30 * s, surf + 4 * s, x + 70 * s, surf + 8 * s);
    ctx.stroke();
    return;
  }
  // 跃出水面：破水的浪花环 + 鲨鱼本体
  const arc = Math.sin((Math.PI * o.t) / 0.85) * 36 * s;
  const y = surf - 14 * s - arc;
  if (o.t < 0.5) {
    ctx.fillStyle = `rgba(255,255,255,${0.9 - o.t * 1.6})`;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const rr = (20 + o.t * 90) * s;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * rr, surf - Math.abs(Math.sin(a)) * rr * 0.6 + 2 * s, (4 - o.t * 5) * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.4 + o.t * 0.9);
  drawSharkBody(s);
  ctx.restore();
}

function drawShell(x, y, r, gold, time) {
  ctx.save();
  ctx.translate(x, y);
  if (gold) {
    const glow = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r * 2.6);
    glow.addColorStop(0, 'rgba(255, 220, 90, 0.55)');
    glow.addColorStop(1, 'rgba(255, 220, 90, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  const g = ctx.createLinearGradient(0, -r, 0, r);
  if (gold) {
    g.addColorStop(0, '#fff3a6');
    g.addColorStop(0.5, '#ffd23f');
    g.addColorStop(1, '#e09a00');
  } else {
    g.addColorStop(0, '#fff2e6');
    g.addColorStop(0.5, '#ffcfae');
    g.addColorStop(1, '#f09a6a');
  }
  ctx.fillStyle = g;
  ctx.strokeStyle = gold ? '#9a6500' : '#b9684a';
  ctx.lineWidth = r * 0.16;
  ctx.lineJoin = 'round';
  // 扇贝：下方铰合部 + 上方扇形
  ctx.beginPath();
  ctx.moveTo(0, r * 0.95);
  ctx.lineTo(-r * 0.3, r * 0.6);
  for (let i = 0; i <= 6; i++) {
    const a = Math.PI * 1.1 + (i / 6) * Math.PI * 0.8;
    const rr = i % 2 === 0 ? r : r * 0.92;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr + r * 0.25);
  }
  ctx.lineTo(r * 0.3, r * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 放射状纹路
  ctx.strokeStyle = gold ? 'rgba(154, 101, 0, 0.6)' : 'rgba(185, 104, 74, 0.55)';
  ctx.lineWidth = r * 0.1;
  ctx.beginPath();
  for (let i = -2; i <= 2; i++) {
    ctx.moveTo(0, r * 0.7);
    ctx.lineTo(i * r * 0.36, -r * 0.55 + Math.abs(i) * r * 0.12);
  }
  ctx.stroke();
  // 高光
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.ellipse(-r * 0.3, -r * 0.25, r * 0.22, r * 0.12, -0.7, 0, Math.PI * 2);
  ctx.fill();
  if (gold) {
    // 旋转的星光
    ctx.save();
    ctx.rotate(time * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.4);
      ctx.lineTo(r * 0.12, -r * 0.3);
      ctx.lineTo(-r * 0.12, -r * 0.3);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawItem(gs, it) {
  const s = CONFIG.LANES[it.lane].scale;
  const x = toScreenX(gs, it.wx);
  const y = itemY(gs, it) + Math.sin(gs.time * 4 + it.wx * 0.01) * 2.5;
  if (it.kind === 'shell' || it.kind === 'gold') {
    drawShell(x, y, 10 * s, it.kind === 'gold', gs.time + it.wx);
  } else if (it.kind === 'power') {
    // "召唤大浪"：发光的海蓝水晶球，内有一道浪
    const r = 16 * s;
    const pulse = 1 + Math.sin(gs.time * 6) * 0.08;
    const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 2.2 * pulse);
    glow.addColorStop(0, 'rgba(120, 240, 255, 0.5)');
    glow.addColorStop(1, 'rgba(120, 240, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.2 * pulse, 0, Math.PI * 2);
    ctx.fill();
    // 外环
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.25, gs.time * 3, gs.time * 3 + Math.PI * 1.3);
    ctx.stroke();
    const ball = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    ball.addColorStop(0, '#9ff3ff');
    ball.addColorStop(0.5, '#2f9cf0');
    ball.addColorStop(1, '#0d3f9c');
    ctx.fillStyle = ball;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // 球内的浪
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.8 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - r * 0.7, y + r * 0.35);
    ctx.quadraticCurveTo(x - r * 0.1, y - r * 0.9, x + r * 0.55, y - r * 0.2);
    ctx.quadraticCurveTo(x + r * 0.1, y - r * 0.15, x + r * 0.25, y + r * 0.3);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.ellipse(x - r * 0.35, y - r * 0.5, r * 0.28, r * 0.16, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ---------- 角色 ---------- */

const SKIN = '#f6c9a0';
const HAIR = '#3b2416';
const TOP = '#ff3b5c';
const SHORTS = '#1e4ed8';

// 冲浪板（鼻尖朝右，板面在 y=0）
function drawBoard(s) {
  const g = ctx.createLinearGradient(-30 * s, 0, 34 * s, 0);
  g.addColorStop(0, '#ff7a1a');
  g.addColorStop(0.5, '#ffb347');
  g.addColorStop(1, '#ffd166');
  ctx.fillStyle = g;
  ctx.strokeStyle = '#8a3d08';
  ctx.lineWidth = 1.8 * s;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-30 * s, -1 * s);
  ctx.quadraticCurveTo(0, -9 * s, 36 * s, -1 * s);
  ctx.quadraticCurveTo(0, 7 * s, -30 * s, 5 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 板面中线 + 花纹
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(-24 * s, 1.5 * s);
  ctx.lineTo(28 * s, 0.5 * s);
  ctx.stroke();
  ctx.fillStyle = '#1e4ed8';
  ctx.beginPath();
  ctx.moveTo(-18 * s, -3 * s);
  ctx.lineTo(-8 * s, -4.5 * s);
  ctx.lineTo(-12 * s, 1 * s);
  ctx.closePath();
  ctx.fill();
  // 尾鳍
  ctx.fillStyle = '#8a3d08';
  ctx.beginPath();
  ctx.moveTo(-20 * s, 5 * s);
  ctx.lineTo(-26 * s, 13 * s);
  ctx.lineTo(-14 * s, 5.5 * s);
  ctx.closePath();
  ctx.fill();
  // 板面高光
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.moveTo(-20 * s, -3 * s);
  ctx.quadraticCurveTo(0, -7 * s, 26 * s, -3 * s);
  ctx.stroke();
}

// 头部：圆脸 + 飞扬的头发 + 墨镜 + 笑容
function drawHead(x, y, s, t) {
  ctx.fillStyle = SKIN;
  ctx.strokeStyle = '#2b1a10';
  ctx.lineWidth = 1.8 * s;
  ctx.beginPath();
  ctx.arc(x, y, 9.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // 头发（向后飘）
  ctx.fillStyle = HAIR;
  ctx.beginPath();
  ctx.moveTo(x + 8 * s, y - 5 * s);
  ctx.quadraticCurveTo(x + 2 * s, y - 13 * s, x - 6 * s, y - 9 * s);
  const wig = Math.sin(t * 12) * 1.5 * s;
  ctx.lineTo(x - 14 * s, y - 12 * s + wig);
  ctx.lineTo(x - 11 * s, y - 6 * s);
  ctx.lineTo(x - 18 * s, y - 5 * s + wig);
  ctx.lineTo(x - 12 * s, y - 1 * s);
  ctx.lineTo(x - 16 * s, y + 3 * s - wig);
  ctx.lineTo(x - 9 * s, y + 1 * s);
  ctx.quadraticCurveTo(x - 4 * s, y - 6 * s, x + 8 * s, y - 5 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 墨镜
  ctx.fillStyle = '#17202b';
  roundRect(x - 1 * s, y - 4 * s, 11 * s, 6 * s, 2.5 * s);
  ctx.fill();
  ctx.fillStyle = 'rgba(140, 220, 255, 0.6)';
  ctx.beginPath();
  ctx.ellipse(x + 6 * s, y - 2 * s, 2.5 * s, 1.2 * s, -0.5, 0, Math.PI * 2);
  ctx.fill();
  // 笑容
  ctx.strokeStyle = '#7a3b2a';
  ctx.lineWidth = 1.4 * s;
  ctx.beginPath();
  ctx.arc(x + 4 * s, y + 3 * s, 3.5 * s, 0.2, Math.PI - 0.4);
  ctx.stroke();
}

// 完整的冲浪者（含板）。pose: 'ride' | 'crouch' | 'air'
function drawSurfer(s, pose, t) {
  drawBoard(s);
  const bob = Math.sin(t * 7) * 1.2 * s;
  let hip, kneeL, kneeR, shoulder, head, armL, armR;
  if (pose === 'crouch') {
    hip = [0, -13 * s + bob];
    kneeL = [-11 * s, -9 * s]; kneeR = [11 * s, -9 * s];
    shoulder = [7 * s, -26 * s + bob];
    head = [10 * s, -36 * s + bob];
    armL = [[3 * s, -24 * s], [-5 * s, -15 * s], [-12 * s, -3 * s]];     // 后手拖水
    armR = [[11 * s, -24 * s], [22 * s, -20 * s], [28 * s, -27 * s]];   // 前手前伸
  } else if (pose === 'air') {
    hip = [0, -17 * s];
    kneeL = [-7 * s, -7 * s]; kneeR = [11 * s, -7 * s];
    shoulder = [3 * s, -34 * s];
    head = [5 * s, -45 * s];
    armL = [[-2 * s, -32 * s], [-13 * s, -40 * s], [-18 * s, -52 * s]];  // 后手上举
    armR = [[8 * s, -32 * s], [15 * s, -20 * s], [17 * s, -3 * s]];     // 前手抓板
  } else {
    hip = [0, -21 * s + bob];
    kneeL = [-9 * s, -11 * s]; kneeR = [10 * s, -12 * s];
    shoulder = [2 * s, -38 * s + bob];
    head = [4 * s, -49 * s + bob];
    armL = [[-3 * s, -36 * s + bob], [-14 * s, -31 * s], [-24 * s, -38 * s - bob]];
    armR = [[7 * s, -36 * s + bob], [17 * s, -31 * s], [27 * s, -38 * s + bob]];
  }
  const footL = [-12 * s, -1 * s];
  const footR = [12 * s, -1 * s];
  // 脚绳
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.moveTo(footL[0], footL[1]);
  ctx.quadraticCurveTo(-22 * s, 6 * s, -29 * s, 2 * s);
  ctx.stroke();
  // 后臂（画在身体后面）
  limb(armL[0][0], armL[0][1], armL[1][0], armL[1][1], armL[2][0], armL[2][1], 4.2 * s, SKIN);
  // 腿：大腿穿短裤，小腿露肤色
  limb(hip[0], hip[1], kneeL[0], kneeL[1], footL[0], footL[1], 5 * s, SKIN);
  limb(hip[0], hip[1], kneeR[0], kneeR[1], footR[0], footR[1], 5 * s, SKIN);
  limb(hip[0], hip[1], (hip[0] + kneeL[0]) / 2, (hip[1] + kneeL[1]) / 2, kneeL[0], kneeL[1], 6.5 * s, SHORTS);
  limb(hip[0], hip[1], (hip[0] + kneeR[0]) / 2, (hip[1] + kneeR[1]) / 2, kneeR[0], kneeR[1], 6.5 * s, SHORTS);
  // 躯干（背心）
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hip[0], hip[1]);
  ctx.lineTo(shoulder[0], shoulder[1]);
  ctx.strokeStyle = '#2b1a10';
  ctx.lineWidth = 11.5 * s;
  ctx.stroke();
  ctx.strokeStyle = TOP;
  ctx.lineWidth = 9 * s;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.6 * s;
  ctx.beginPath();
  ctx.moveTo(hip[0] - 3 * s, hip[1] - 2 * s);
  ctx.lineTo(shoulder[0] - 3 * s, shoulder[1] + 3 * s);
  ctx.stroke();
  // 前臂
  limb(armR[0][0], armR[0][1], armR[1][0], armR[1][1], armR[2][0], armR[2][1], 4.2 * s, SKIN);
  // 脚
  ctx.fillStyle = SKIN;
  ctx.strokeStyle = '#2b1a10';
  ctx.lineWidth = 1.2 * s;
  for (const f of [footL, footR]) {
    ctx.beginPath();
    ctx.ellipse(f[0] + 1 * s, f[1] + 0.5 * s, 5 * s, 2.4 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  drawHead(head[0], head[1], s, t);
}

function drawPlayer(gs) {
  const p = gs.player;
  const s = laneParams(p.laneF).scale;
  const lane = Math.round(p.laneF);
  if (p.invulnT > 0 && Math.floor(gs.time * 12) % 2 === 0) return; // 无敌闪烁

  // 空中时投在水面上的影子
  if (p.mode === 'air') {
    const sy = surfaceY(gs, lane, p.wx);
    const k = clamp((sy - p.y) / 260, 0, 1);
    ctx.fillStyle = `rgba(5, 30, 70, ${(0.35 * (1 - k * 0.8)).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(CONFIG.PLAYER_X, sy + 2 * s, 30 * s * (1 - k * 0.5), 6 * s * (1 - k * 0.5), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.translate(CONFIG.PLAYER_X, p.y);
  if (p.mode === 'swim') {
    // 游泳：板子翻倒漂在一旁，人在水中扑腾
    const bobB = Math.sin(gs.time * 3) * 2 * s;
    ctx.save();
    ctx.translate(-34 * s, 2 * s + bobB);
    ctx.rotate(Math.PI + Math.sin(gs.time * 2) * 0.1);
    drawBoard(s * 0.9);
    ctx.restore();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1 * s;
    ctx.beginPath();
    ctx.moveTo(-6 * s, 4 * s);
    ctx.quadraticCurveTo(-18 * s, 12 * s, -34 * s, 6 * s);
    ctx.stroke();
    const sw = Math.sin(gs.time * 10);
    limb(-6 * s, 0, -14 * s, -10 * s + sw * 6 * s, -22 * s, -2 * s + sw * 8 * s, 4.2 * s, SKIN);
    limb(6 * s, 0, 14 * s, -10 * s - sw * 6 * s, 22 * s, -2 * s - sw * 8 * s, 4.2 * s, SKIN);
    ctx.beginPath();
    ctx.moveTo(0, 2 * s);
    ctx.lineTo(0, -6 * s);
    ctx.strokeStyle = '#2b1a10';
    ctx.lineWidth = 11.5 * s;
    ctx.stroke();
    ctx.strokeStyle = TOP;
    ctx.lineWidth = 9 * s;
    ctx.stroke();
    drawHead(0, -14 * s + Math.sin(gs.time * 6) * 1.5 * s, s, gs.time);
    // 水花
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 6; i++) {
      const ph = (gs.time * 2 + i / 6) % 1;
      ctx.beginPath();
      ctx.arc((i - 2.5) * 10 * s + sw * 4 * s, 2 * s - ph * 14 * s, (3 - ph * 2) * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  ctx.rotate(p.tilt + p.spin.angle);
  const crouch = p.mode === 'barrel' || (p.mode === 'ride' && p.diveT > 0);
  drawSurfer(s, crouch ? 'crouch' : p.mode === 'air' ? 'air' : 'ride', gs.time);
  ctx.restore();

  // 跳出屏幕顶部时的位置提示
  if (p.y < 20) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,40,80,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CONFIG.PLAYER_X, 6);
    ctx.lineTo(CONFIG.PLAYER_X - 10, 20);
    ctx.lineTo(CONFIG.PLAYER_X + 10, 20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

function drawParticles(gs, lane) {
  for (const pt of gs.particles) {
    if (pt.lane !== lane) continue;
    const a = 1 - pt.life / pt.max;
    ctx.fillStyle = `rgba(${pt.color},${(a * 0.9).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(toScreenX(gs, pt.wx), pt.y, pt.r * (0.6 + a * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
}

// 空中/高速时的速度线
function drawSpeedLines(gs) {
  const p = gs.player;
  const k = clamp((effectiveSpeed(gs) - 380) / 240, 0, 1) + (p.mode === 'air' ? 0.5 : 0);
  if (k <= 0) return;
  ctx.strokeStyle = `rgba(255,255,255,${(0.22 * Math.min(k, 1)).toFixed(3)})`;
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    const y = 40 + hash01(i + 300) * (H - 80);
    const span = W + 200;
    const x = ((span - ((gs.time * 1400 + hash01(i + 310) * span) % span)) + span) % span - 100;
    const len = 60 + hash01(i + 320) * 90;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.stroke();
  }
}

// 玩家是否处在某条浪道卷浪浪唇的水平范围内
function lipCoversPlayer(gs, lane) {
  const px = CONFIG.PLAYER_X;
  for (const w of gs.waves) {
    if (w.type !== 'barrel') continue;
    const g = barrelGeom(gs, w, lane);
    if (px > g.xt - 30 && px < g.xc + 10) return true;
  }
  return false;
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
    if (lane === playerLane) drawWake(gs);
    drawParticles(gs, lane);
    if (lane === playerLane) {
      ctx.save();
      ctx.globalAlpha = laneParams(p.laneF).alpha * 0.3 + 0.7;
      drawPlayer(gs);
      ctx.restore();
    }
    // 浪唇遮住玩家时变半透明，保证角色始终可见
    drawBarrelLip(gs, lane, lane === playerLane && lipCoversPlayer(gs, lane) ? 0.55 : 1);
  }
  drawSpeedLines(gs);
  // 浪管内视野受限：以玩家为中心的暗角
  if (p.mode === 'barrel') {
    const g = ctx.createRadialGradient(CONFIG.PLAYER_X, p.y - 20, 70, CONFIG.PLAYER_X, p.y - 20, 300);
    g.addColorStop(0, 'rgba(0, 20, 50, 0)');
    g.addColorStop(1, 'rgba(0, 20, 50, 0.82)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  // 轻微暗角，聚焦画面中心
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.55, W / 2, H / 2, H * 1.05);
  v.addColorStop(0, 'rgba(0, 20, 50, 0)');
  v.addColorStop(1, 'rgba(0, 20, 50, 0.3)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

/* =====================================================================
 * 9. UI 渲染
 * ===================================================================== */

const POWER_BTN = { x: W - 150, y: H - 78, w: 136, h: 62 };
const RESTART_BTN = { x: W / 2 - 110, y: H / 2 + 70, w: 220, h: 54 };
const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Hiragino Sans GB",sans-serif';

function drawText(text, x, y, size, color, align, bold, outline) {
  ctx.font = `${bold === false ? '' : 'bold '}${size}px ${FONT}`;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, size / 5.5);
  ctx.strokeStyle = outline || 'rgba(0, 30, 60, 0.7)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// 半透明玻璃面板：阴影 + 渐变 + 亮边
function panel(x, y, w, h, r) {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 10, 30, 0.45)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(18, 60, 110, 0.78)');
  g.addColorStop(1, 'rgba(6, 30, 65, 0.82)');
  ctx.fillStyle = g;
  roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(160, 220, 255, 0.35)';
  ctx.lineWidth = 1.5;
  roundRect(x, y, w, h, r);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + r, y + 1.5);
  ctx.lineTo(x + w - r, y + 1.5);
  ctx.stroke();
}

// 立体按钮
function button(b, colorA, colorB, glow) {
  ctx.save();
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = 18;
  } else {
    ctx.shadowColor = 'rgba(0, 10, 30, 0.4)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
  }
  const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
  g.addColorStop(0, colorA);
  g.addColorStop(1, colorB);
  ctx.fillStyle = g;
  roundRect(b.x, b.y, b.w, b.h, 14);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  roundRect(b.x, b.y, b.w, b.h, 14);
  ctx.stroke();
  // 顶部高光
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  roundRect(b.x + 4, b.y + 3, b.w - 8, b.h * 0.42, 10);
  ctx.fill();
}

// 小贝壳图标（用于分数面板）
function shellIcon(x, y, r) {
  drawShell(x, y, r, true, 0);
}

// 左上角：分数与状态
function drawScore(gs) {
  const p = gs.player;
  panel(12, 12, 212, 74, 12);
  shellIcon(36, 36, 11);
  drawText(`${Math.floor(gs.score)}`, 56, 36, 26, '#ffe37a');
  drawText(`距离 ${Math.floor(p.wx / 20)} m`, 24, 68, 13, '#cdeeff', 'left', false);
  drawText(`速度 ×${(effectiveSpeed(gs) / CONFIG.BASE_SPEED).toFixed(1)}`, 212, 68, 13, '#cdeeff', 'right', false);
  let status = '';
  let color = '#fff';
  if (p.mode === 'barrel') { status = `浪管中！ +${CONFIG.SCORE.barrelPerSec}/秒`; color = '#7dffb0'; }
  else if (p.mode === 'swim') { status = '游泳中…速度减半，无法吃道具'; color = '#ffb3b3'; }
  else if (p.mode === 'air' && p.spin.done + (p.spin.active ? 1 : 0) > 0) { status = `转体中 ×${p.spin.done + (p.spin.active ? 1 : 0)}`; color = '#ffd84d'; }
  if (status) drawText(status, 24, 108, 17, color);
}

// 顶部：平衡条
function drawBalance(gs) {
  const p = gs.player;
  const x = W / 2 - 150;
  const y = 18;
  const w = 300;
  const h = 20;
  drawText('平衡', x - 14, y + h / 2, 17, '#ffffff', 'right');
  // 槽
  ctx.save();
  ctx.shadowColor = 'rgba(0, 10, 30, 0.45)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = 'rgba(6, 30, 65, 0.85)';
  roundRect(x - 4, y - 4, w + 8, h + 8, 12);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(160, 220, 255, 0.35)';
  ctx.lineWidth = 1.5;
  roundRect(x - 4, y - 4, w + 8, h + 8, 12);
  ctx.stroke();
  if (p.mode === 'swim') {
    // 游泳模式：显示爬回板上的倒计时
    const t = p.swimT / CONFIG.SWIM_TIME;
    ctx.fillStyle = '#7fa2c4';
    roundRect(x, y, Math.max(8, w * (1 - t)), h, 8);
    ctx.fill();
    drawText(`游泳模式 ${p.swimT.toFixed(1)}s 后爬回板上`, x + w / 2, y + h / 2, 13, '#ffffff', 'center');
    return;
  }
  const r = p.balance / CONFIG.BALANCE_MAX;
  const [c1, c2] = r > 0.6 ? ['#a8ff8a', '#2fd36a'] : r > 0.3 ? ['#ffe98a', '#ffb02e'] : ['#ff9c8a', '#ff3b3b'];
  if (r > 0) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    roundRect(x, y, Math.max(10, w * r), h, 8);
    ctx.fill();
    // 玻璃高光
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    roundRect(x + 3, y + 2, Math.max(6, w * r - 6), h * 0.4, 5);
    ctx.fill();
  }
  // 刻度
  ctx.strokeStyle = 'rgba(0, 20, 40, 0.3)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(x + (w * i) / 4, y + 2);
    ctx.lineTo(x + (w * i) / 4, y + h - 2);
    ctx.stroke();
  }
  if (r <= 0.3 && Math.floor(gs.time * 6) % 2 === 0) {
    ctx.strokeStyle = '#ff5a4f';
    ctx.lineWidth = 2.5;
    roundRect(x - 4, y - 4, w + 8, h + 8, 12);
    ctx.stroke();
  }
  drawText(`${Math.round(p.balance)}`, x + w + 14, y + h / 2, 15, '#ffffff', 'left');
}

// 浪况预报里的缩略波形
function drawMiniWave(x, y, w, h, wave) {
  const ampN = clamp(wave.targetAmp / 175, 0.14, 1);
  ctx.save();
  roundRect(x, y, w, h, 5);
  ctx.clip();
  // 小天空
  const sky = ctx.createLinearGradient(0, y, 0, y + h);
  sky.addColorStop(0, '#5fb6f0');
  sky.addColorStop(1, '#dff4ff');
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, h);
  const base = y + h - 5;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  for (let i = 0; i <= 30; i++) {
    const u = i / 30;
    ctx.lineTo(x + u * w, base - shape01(wave.type, u) * ampN * (h - 10));
  }
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#8fe3ff');
  g.addColorStop(1, '#1a5f9c');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (wave.type === 'barrel') {
    // 卷浪：画出浪唇卷曲
    const uc = peakU('barrel');
    const xc = x + uc * w;
    const yc = base - ampN * (h - 10);
    ctx.beginPath();
    ctx.moveTo(xc, yc);
    const ut = BARREL_TIP_U;
    ctx.bezierCurveTo(xc - w * 0.12, yc - 10, x + (ut - 0.08) * w, yc - 4, x + ut * w, base - (shape01('barrel', ut) + 0.34) * ampN * (h - 10));
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
      ctx.arc(x + u * w, base - shape01('break', u) * ampN * (h - 10) - 1, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// 右上角：浪况预报（接下来 3 波浪）
function drawForecast(gs) {
  const list = upcomingWaves(gs, 3);
  const pw = 290;
  const x0 = W - pw - 12;
  const y0 = 12;
  panel(x0, y0, pw, 112, 12);
  const cur = waveAt(gs, gs.player.wx);
  drawText('浪况预报', x0 + 12, y0 + 16, 15, '#ffffff');
  if (cur) drawText(`当前：${WAVE_TYPES[cur.wave.type].name}${cur.wave.big ? '(大)' : ''}`, x0 + pw - 12, y0 + 16, 12, '#cdeeff', 'right', false);
  const eff = effectiveSpeed(gs);
  list.forEach((wave, i) => {
    const cx = x0 + 10 + i * 92;
    const cy = y0 + 32;
    const cw = 86;
    const ch = 72;
    const def = WAVE_TYPES[wave.type];
    const eta = (wave.start - gs.player.wx) / eff;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(cx, cy, cw, ch, 8);
    ctx.fill();
    // 即将到达的浪闪烁描边
    const hot = i === 0 && eta < 1 && Math.floor(gs.time * 6) % 2 === 0;
    ctx.strokeStyle = hot ? '#ffffff' : def.color;
    ctx.lineWidth = hot ? 3 : 1.5;
    roundRect(cx, cy, cw, ch, 8);
    ctx.stroke();
    drawMiniWave(cx + 4, cy + 4, cw - 8, 38, wave);
    drawText(def.name, cx + 7, cy + 53, 14, def.color);
    // ETA 胶囊
    ctx.fillStyle = 'rgba(0, 20, 50, 0.5)';
    roundRect(cx + cw - 38, cy + 45, 32, 16, 8);
    ctx.fill();
    drawText(`${eta.toFixed(1)}s`, cx + cw - 22, cy + 53, 11, '#dff4ff', 'center', false);
    if (wave.big) {
      ctx.fillStyle = '#ff5a4f';
      roundRect(cx + cw - 32, cy + 2, 30, 16, 5);
      ctx.fill();
      drawText('大浪', cx + cw - 17, cy + 10, 10, '#ffffff', 'center');
    }
    drawText(['下一波', '第二波', '第三波'][i], cx + 7, cy + 65, 10, 'rgba(255,255,255,0.7)', 'left', false);
  });
}

// 右下角："召唤大浪"按钮
function drawPowerButton(gs) {
  const b = POWER_BTN;
  const on = gs.powerCharges > 0;
  if (on) button(b, '#4fb3ff', '#1a5fd6', 'rgba(120, 220, 255, 0.8)');
  else {
    ctx.fillStyle = 'rgba(6, 30, 65, 0.6)';
    roundRect(b.x, b.y, b.w, b.h, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    roundRect(b.x, b.y, b.w, b.h, 14);
    ctx.stroke();
  }
  // 浪形图标
  ctx.strokeStyle = on ? '#ffffff' : 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(b.x + 14, b.y + 38);
  ctx.quadraticCurveTo(b.x + 24, b.y + 10, b.x + 40, b.y + 24);
  ctx.quadraticCurveTo(b.x + 32, b.y + 24, b.x + 34, b.y + 32);
  ctx.stroke();
  drawText('召唤大浪', b.x + 86, b.y + 24, 17, on ? '#ffffff' : 'rgba(255,255,255,0.5)', 'center');
  drawText('E 键 / 点按', b.x + 86, b.y + 45, 11, on ? '#dff4ff' : 'rgba(255,255,255,0.4)', 'center', false);
  // 数量徽章
  ctx.fillStyle = on ? '#ffb02e' : 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.arc(b.x + b.w - 4, b.y + 4, 13, 0, Math.PI * 2);
  ctx.fill();
  drawText(`${gs.powerCharges}`, b.x + b.w - 4, b.y + 5, 14, '#ffffff', 'center');
}

function drawTexts(gs) {
  for (const t of gs.texts) {
    ctx.save();
    const k = t.life / t.max;
    ctx.globalAlpha = 1 - k * k;
    const pop = 1 + Math.max(0, 0.25 - k) * 1.6;
    ctx.translate(t.x, t.y);
    ctx.scale(pop, pop);
    drawText(t.text, 0, 0, t.size, t.color, 'center');
    ctx.restore();
  }
}

function drawOverlayPanel(alpha) {
  ctx.fillStyle = `rgba(0, 20, 45, ${alpha == null ? 0.5 : alpha})`;
  ctx.fillRect(0, 0, W, H);
}

// 带渐变填色与厚描边的标题
function drawTitle(text, x, y, size) {
  ctx.font = `bold ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.save();
  ctx.shadowColor = 'rgba(0, 20, 60, 0.6)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  ctx.strokeStyle = '#0b3b73';
  ctx.lineWidth = size / 5;
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = size / 12;
  ctx.strokeText(text, x, y);
  const g = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.5, '#ffe36a');
  g.addColorStop(1, '#ff9f1a');
  ctx.fillStyle = g;
  ctx.fillText(text, x, y);
}

function drawMenu(gs) {
  drawOverlayPanel(0.32);
  drawTitle('浪尖酷跑', W / 2, 108, 68);
  drawText('—— 浪是活的，读浪才能活下去 ——', W / 2, 162, 18, '#dff4ff', 'center', false);
  panel(W / 2 - 300, 190, 600, 206, 14);
  const lines = [
    ['空格 / ↑ / 上滑', '跳跃（在浪峰起跳有高度加成）'],
    ['↓ / 下滑', '压板潜水（钻浪管、躲水母）'],
    ['← → / 左右滑', '切换 3 条浪道；空中按 ← → 转体花式'],
    ['E / 右下按钮', '召唤大浪（下一波浪变高，浪峰起跳吃金贝壳）'],
    ['注意', '碎浪的白色浪花必须跳过；礁石跳过；鲨鱼背鳍出现时尽快换道'],
    ['平衡', '归零会落水游泳 3 秒；看右上角"浪况预报"提前规划'],
  ];
  lines.forEach(([k, v], i) => {
    const y = 214 + i * 31;
    ctx.fillStyle = 'rgba(255, 227, 122, 0.18)';
    roundRect(W / 2 - 284, y - 11, 118, 22, 6);
    ctx.fill();
    drawText(k, W / 2 - 225, y, 13, '#ffe37a', 'center');
    drawText(v, W / 2 - 156, y, 14, '#ffffff', 'left', false);
  });
  const pulse = 1 + Math.sin(gs.time * 4) * 0.04;
  ctx.save();
  ctx.translate(W / 2, 436);
  ctx.scale(pulse, pulse);
  drawText('点击屏幕 / 按空格开始', 0, 0, 24, '#ffe066', 'center');
  ctx.restore();
  if (gs.best > 0) drawText(`最高分 ${gs.best}`, W / 2, 478, 16, '#cdeeff', 'center', false);
}

function drawGameOver(gs) {
  drawOverlayPanel(0.45);
  panel(W / 2 - 230, H / 2 - 150, 460, 300, 18);
  drawTitle(gs.overReason || '游戏结束', W / 2, H / 2 - 98, 40);
  drawText('得分', W / 2, H / 2 - 48, 16, '#cdeeff', 'center', false);
  drawText(`${Math.floor(gs.score)}`, W / 2, H / 2 - 14, 44, '#ffffff', 'center');
  drawText(gs.newBest ? '★ 新纪录！' : `最高分 ${gs.best}`, W / 2, H / 2 + 30, 18, gs.newBest ? '#ffe066' : '#cdeeff', 'center');
  const b = RESTART_BTN;
  button(b, '#ffb347', '#ff7a1a');
  drawText('重新开始', b.x + b.w / 2, b.y + b.h / 2, 22, '#ffffff', 'center');
  drawText('空格 / 回车 也可重开', W / 2, b.y + b.h + 24, 13, '#cdeeff', 'center', false);
}

function drawPause() {
  drawOverlayPanel(0.5);
  drawTitle('已暂停', W / 2, H / 2 - 10, 44);
  drawText('按 P 或点击屏幕继续', W / 2, H / 2 + 40, 16, '#cdeeff', 'center', false);
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
