const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  path: '/api/socket.io',
  cors: { origin: '*' }
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ─── 게임 상수 ───────────────────────────────────────────────────────────────
const VIEW_W = 900, FLOOR_Y = 430;
const PLAYER_W = 44, PLAYER_H = 80;
const MAX_HP_BASE = 170;
const GRAVITY = 0.85;
const JUMP_FORCE = -19;
const MOVE_SPEED = 6;

const ULT_GAUGE_MAX = 100;
const GAUGE_PER_HIT = 14;
// 맞는 쪽도 소량의 궁극기 게이지를 얻는다("고통 게이지"). 일방적으로 두들겨 맞는 쪽이
// 아무 보상도 없이 계속 손해만 보는 걸 완화해서, 역전의 여지를 조금이라도 남겨준다.
const PAIN_GAUGE_PER_HIT = 5;

const MAP_SELECT_TIME = 60 * 15;   // 15초
const CHAR_SELECT_TIME = 60 * 20;  // 20초

const PROJECTILE_HIT_RATIO = 0.68;

// ─── CC 저항 (스턴 디미니싱 리턴) ────────────────────────────────────────────
// 짧은 시간 안에 스턴을 연속으로 맞으면 지속시간이 점점 줄어든다. 한쪽이 스턴을
// 계속 이어붙여서 상대가 아무것도 못 하고 일방적으로 두들겨 맞는(스턴락) 상황을 막는다.
// STUN_CHAIN_RESET 프레임(약 3.3초) 동안 스턴 없이 지나가면 저항이 초기화된다.
const STUN_CHAIN_RESET = 200;
const STUN_DR_MUL = [1, 0.65, 0.4, 0.25];

// ─── 가드 / 저스트가드(패링) ─────────────────────────────────────────────────
const GUARD_DMG_REDUCTION = 0.65;   // 일반 가드 시 피해 경감률
const JUST_GUARD_WINDOW = 10;       // 가드를 든 직후 이 프레임 안에 맞으면 "저스트가드"(완전 무효화 + 반격 경직)

// ─── 재접속 유예시간 ─────────────────────────────────────────────────────────
const RECONNECT_GRACE_MS = 15000;   // 대전 도중 연결이 끊기면 이 시간만큼 재접속을 기다린다

// 모든 클래스 공통 동작 길이 / 판정 시점 (프레임, 60fps 기준)
// 평타(attack)는 더 이상 고정 길이가 아니라 4단 콤보 테이블(COMBO_ATK)을 사용한다.
const ATK_DUR = { skill_e: 18, skill_r: 12, skill_f: 20, skill_t: 16, skill_x: 30 };
const TRIGGER = { skill_e: 9, skill_r: 6, skill_f: 10, skill_t: 8, skill_x: 16 };

// ─── 평타 4단 콤보 테이블 ────────────────────────────────────────────────────
// dur: 이 타격의 총 모션 길이(프레임) / trigger: 판정이 발생하는 프레임
// recovery: 판정 이후 다음 평타를 낼 수 있기까지의 추가 딜레이(타격감을 위한 후딜)
// dmgMul: 콤보 단수별 데미지 배율 (뒤로 갈수록 강해짐, 4단은 마무리 강타)
const COMBO_ATK = [
  { dur: 12, trigger: 6,  recovery: 18, dmgMul: 1.00 }, // 1타
  { dur: 13, trigger: 6,  recovery: 20, dmgMul: 1.08 }, // 2타
  { dur: 14, trigger: 7,  recovery: 22, dmgMul: 1.18 }, // 3타
  { dur: 20, trigger: 10, recovery: 30, dmgMul: 1.50 }  // 4타(마무리, 넉백 강화)
];
// 콤보를 이어가려면 이 여유 프레임(회복시간 이후) 안에 다음 평타를 입력해야 한다.
const COMBO_CHAIN_GRACE = 26;
// 4단(마무리) 평타까지 전부 쓰고 나면, 곧바로 다시 평타를 낼 수 있는 게 아니라
// 이 시간만큼 완전히 쉬어야 한다 (5초, 60fps 기준).
const COMBO_FINISHER_CD = 300;
// 명중 시 상대에게 거는 스턴 = "내가 다음 평타를 낼 수 있을 때까지"의 시간 + 핑/입력지연 여유분
const COMBO_STUN_BUFFER = 10;
function comboStunFrames(step) {
  const cur = COMBO_ATK[step];
  const next = COMBO_ATK[(step + 1) % COMBO_ATK.length];
  const remainingActive = cur.dur - cur.trigger;
  return remainingActive + cur.recovery + next.trigger + COMBO_STUN_BUFFER;
}
function resetCombo(p) {
  p.comboStep = 0; p.atkRecoveryTimer = 0; p.comboWindowTimer = 0;
}

// 클래스별 쿨타임 (프레임) — E/R/T/F 스킬용. 평타는 위 콤보 테이블이 담당한다.
const CLASS_CD = {
  saber:     { e: 60 * 3.5, r: 60 * 3,   t: 60 * 7,  f: 60 * 8 },
  lancer:    { e: 60 * 4,   r: 60 * 3.2, t: 60 * 7.5, f: 60 * 8.7 },
  archer:    { e: 60 * 4.3, r: 60 * 3.7, t: 60 * 7.2, f: 60 * 8.7 },
  berserker: { e: 60 * 4.7, r: 60 * 4.3, t: 60 * 8,  f: 60 * 9.3 },
  caster:    { e: 60 * 3.7, r: 60 * 2.8, t: 60 * 7.3, f: 60 * 9 },
  rider:     { e: 60 * 3.8, r: 60 * 3.3, t: 60 * 7,  f: 60 * 8.7 },
  assassin:  { e: 60 * 3,   r: 60 * 2.7, t: 60 * 6.7, f: 60 * 8 }
};

// ─── 맵 ─────────────────────────────────────────────────────────────────────
const MAPS = [
  { id: 'colosseum',      name: '콜로세움',    width: 1500, floorY: FLOOR_Y, platforms: [
    { x1: 620, x2: 880, y: 300 }
  ] },
  { id: 'frozen_canyon',  name: '빙하 협곡',   width: 1750, floorY: FLOOR_Y, platforms: [
    { x1: 280, x2: 460, y: 340 }, { x1: 720, x2: 940, y: 260 }, { x1: 1230, x2: 1420, y: 340 }
  ] },
  { id: 'volcanic_field', name: '화산 지대',   width: 1350, floorY: FLOOR_Y, platforms: [
    { x1: 480, x2: 630, y: 290 }, { x1: 750, x2: 900, y: 290 }
  ] },
  { id: 'ruined_temple',  name: '폐허 신전',   width: 1650, floorY: FLOOR_Y, platforms: [
    { x1: 230, x2: 400, y: 330 }, { x1: 620, x2: 820, y: 260 }, { x1: 1000, x2: 1170, y: 330 }, { x1: 1300, x2: 1450, y: 220 }
  ] },
  { id: 'twilight_bridge', name: '황혼의 다리', width: 1900, floorY: FLOOR_Y, platforms: [
    { x1: 840, x2: 1060, y: 320 }
  ] }
];

// ─── 캐릭터 (7클래스 x 2인, 총 14인) — 역사/신화/서사시 속 인물 ────────────────
const CHARACTERS = [
  { id: 'saber_musashi',    class: 'saber',     name: '미야모토 무사시', title: '이천일류의 검성', color: '#8fd8ff',
    mods: { dmg: 0.85, cd: 0.82, spd: 1.12, hp: 0.92 }, outfit: 'musashi',
    ultLine: '두 자루의 검, 하나의 마음.' },
  { id: 'saber_arthur',     class: 'saber',     name: '아서 펜드래곤', title: '브리튼의 왕, 성검의 주인', color: '#f2d675',
    mods: { dmg: 1.00, cd: 1.00, spd: 1.00, hp: 1.05 }, outfit: 'arthur',
    ultLine: '엑스칼리버, 나를 승리로 이끌어라!' },
  { id: 'lancer_guanyu',    class: 'lancer',    name: '관우',        title: '오호대장의 청룡언월', color: '#ff5533',
    mods: { dmg: 1.05, cd: 1.00, spd: 1.00, hp: 1.05 }, outfit: 'guanyu',
    ultLine: '천하에 나를 막을 자, 없다!' },
  { id: 'lancer_achilles',  class: 'lancer',    name: '아킬레우스',  title: '불사의 영웅', color: '#ff8855',
    mods: { dmg: 0.90, cd: 0.90, spd: 1.06, hp: 0.95 }, outfit: 'achilles',
    ultLine: '나의 창끝에 승리가 있다!' },
  { id: 'archer_artemis',   class: 'archer',    name: '아르테미스',  title: '사냥과 달의 여신', color: '#33cc88',
    mods: { dmg: 0.92, cd: 0.95, spd: 1.00, hp: 0.90 }, outfit: 'artemis',
    ultLine: '달빛이 과녁을 밝히리라.' },
  { id: 'archer_jumong',    class: 'archer',    name: '주몽',        title: '고구려의 시조', color: '#66ffaa',
    mods: { dmg: 0.80, cd: 0.78, spd: 1.08, hp: 0.85 }, outfit: 'jumong',
    ultLine: '백 발 백 중, 하늘이 내린 활!' },
  { id: 'berserker_hercules', class: 'berserker', name: '헤라클레스', title: '열두 과업의 반신', color: '#aa3333',
    mods: { dmg: 1.30, cd: 1.15, spd: 0.85, hp: 1.28 }, outfit: 'hercules',
    ultLine: '이것이 신의 힘이다!!' },
  { id: 'berserker_ragnar', class: 'berserker', name: '라그나르 로드브로크', title: '북해의 전설, 바이킹의 왕', color: '#cc6622',
    mods: { dmg: 1.18, cd: 1.05, spd: 0.95, hp: 1.10 }, outfit: 'ragnar',
    ultLine: '발할라가 나를 기다린다!' },
  { id: 'caster_merlin',    class: 'caster',    name: '멀린',        title: '아발론의 대마도사', color: '#aa55ff',
    mods: { dmg: 1.00, cd: 0.95, spd: 0.90, hp: 0.85 }, outfit: 'merlin',
    ultLine: '운명은 이미 정해졌노라.' },
  { id: 'caster_circe',     class: 'caster',    name: '키르케',      title: '아이아이에의 마녀', color: '#c86edc',
    mods: { dmg: 0.95, cd: 0.88, spd: 0.95, hp: 0.88 }, outfit: 'circe',
    ultLine: '너는 이제 짐승이 되리라.' },
  { id: 'caster_ph',        class: 'caster',    name: 'PH',          title: '카드와 환영의 마술사', color: '#f0b93a',
    mods: { dmg: 0.95, cd: 0.92, spd: 0.98, hp: 0.87 }, outfit: 'ph',
    ultLine: '자, 이 옷은 이제 제가 가져가겠습니다.' },
  { id: 'rider_yisunsin',   class: 'rider',     name: '이순신',      title: '조선의 명장, 삼도수군통제사', color: '#ffaa22',
    mods: { dmg: 1.10, cd: 1.05, spd: 1.10, hp: 1.05 }, outfit: 'yisunsin',
    ultLine: '나의 죽음을 적에게 알리지 마라... 거북선, 돌격하라!' },
  { id: 'rider_khan',       class: 'rider',     name: '칭기즈칸',    title: '대몽골의 초원 정복자', color: '#7799ff',
    mods: { dmg: 1.05, cd: 0.95, spd: 1.20, hp: 1.00 }, outfit: 'khan',
    ultLine: '초원의 모든 것이 나의 것이다!' },
  { id: 'assassin_hanzo',   class: 'assassin',  name: '핫토리 한조', title: '전국시대의 그림자', color: '#8888aa',
    mods: { dmg: 0.85, cd: 0.72, spd: 1.20, hp: 0.80 }, outfit: 'hanzo',
    ultLine: '그림자 속에 죽음이 있다.' },
  { id: 'assassin_jingke',  class: 'assassin',  name: '형가',        title: '진왕을 노린 자객', color: '#993355',
    mods: { dmg: 0.95, cd: 0.80, spd: 1.05, hp: 0.85 }, outfit: 'jingke',
    ultLine: '지도가 다하면, 비수가 드러난다.' }
];

// ─── 게임 상태 ───────────────────────────────────────────────────────────────
let sockets = [null, null];
let gameState = createInitialState();
let reconnectTimers = [null, null]; // 재접속 유예시간 타이머 (인덱스별)

function createInitialState() {
  return {
    phase: 'waiting', // waiting, map_select, char_select, countdown, playing, game_over
    countdown: 3,
    winner: null,
    mapPick: { bans: [null, null], timer: MAP_SELECT_TIME },
    charSelect: { picks: [null, null], ready: [false, false], timer: CHAR_SELECT_TIME },
    mapId: null,
    map: null,
    players: [],
    projectiles: [],
    effects: [],
    hazards: [],
    hitStop: 0,
    disconnectedIndex: null,   // 대전 도중 연결이 끊긴 플레이어의 인덱스 (재접속 대기 중)
    reconnectDeadline: null    // 재접속 유예 마감 시각(Date.now() 기준 ms)
  };
}

function resetForNewMatch() {
  gameState.phase = 'map_select';
  gameState.mapPick = { bans: [null, null], timer: MAP_SELECT_TIME };
  gameState.charSelect = { picks: [null, null], ready: [false, false], timer: CHAR_SELECT_TIME };
  gameState.mapId = null;
  gameState.map = null;
  gameState.players = [];
  gameState.projectiles = [];
  gameState.effects = [];
  gameState.hazards = [];
  gameState.hitStop = 0;
  gameState.winner = null;
  gameState.disconnectedIndex = null;
  gameState.reconnectDeadline = null;
}

function createPlayer(index, charId, x) {
  const cdef = CHARACTERS.find(c => c.id === charId) || CHARACTERS[0];
  const maxHp = Math.round(MAX_HP_BASE * cdef.mods.hp);
  return {
    index, charId, class: cdef.class, color: cdef.color,
    dmgMult: cdef.mods.dmg, cdMult: cdef.mods.cd, speed: MOVE_SPEED * cdef.mods.spd,
    x, y: FLOOR_Y, vy: 0,
    facing: index === 0 ? 1 : -1,
    isGrounded: true,
    maxHp, hp: maxHp,
    action: 'idle', actionTimer: 0,
    cooldowns: { e: 0, r: 0, f: 0, t: 0 },
    comboStep: 0, attackStep: 0, atkRecoveryTimer: 0, comboWindowTimer: 0,
    invincible: 0, trapped: 0, dmgVulnTimer: 0,
    poison: null, speedBuffTimer: 0,
    guardTimer: 0, stunChainCount: 0, stunChainWindow: 0,
    ultGauge: 0,
    input: { left: false, right: false, jump: false, down: false, attack: false, guard: false, skill_e: false, skill_r: false, skill_f: false, skill_t: false, skill_x: false }
  };
}

// ─── Socket 처리 ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let myIndex = -1;
  if (!sockets[0]) myIndex = 0;
  else if (!sockets[1]) myIndex = 1;

  if (myIndex === -1) {
    socket.emit('full');
    socket.disconnect();
    return;
  }

  sockets[myIndex] = socket;
  socket.emit('welcome', { index: myIndex, characters: CHARACTERS, maps: MAPS });

  if (sockets[0] && sockets[1] && gameState.phase === 'waiting') {
    resetForNewMatch();
  }

  // 재접속: 방금 비었던 자리(myIndex)로 돌아왔다면, 매치를 초기화하지 않고
  // 진행 중이던 상태 그대로 이어간다. 대기 중이던 재접속 타이머도 취소한다.
  if (gameState.disconnectedIndex === myIndex) {
    clearTimeout(reconnectTimers[myIndex]);
    reconnectTimers[myIndex] = null;
    gameState.disconnectedIndex = null;
    gameState.reconnectDeadline = null;
  }

  socket.on('input', (inpData) => {
    const p = gameState.players[myIndex];
    if (p && inpData && typeof inpData === 'object') p.input = { ...p.input, ...inpData };
  });

  socket.on('banMap', (data) => {
    if (gameState.phase !== 'map_select') return;
    const mapId = data && data.mapId;
    if (!MAPS.find(m => m.id === mapId)) return;
    if (gameState.mapPick.bans[myIndex]) return;
    gameState.mapPick.bans[myIndex] = mapId;
    tryResolveMapSelect(false);
  });

  socket.on('pickCharacter', (data) => {
    if (gameState.phase !== 'char_select') return;
    const charId = data && data.charId;
    if (!CHARACTERS.find(c => c.id === charId)) return;
    gameState.charSelect.picks[myIndex] = charId;
    gameState.charSelect.ready[myIndex] = false;
  });

  socket.on('toggleReady', () => {
    if (gameState.phase !== 'char_select') return;
    if (!gameState.charSelect.picks[myIndex]) return;
    gameState.charSelect.ready[myIndex] = !gameState.charSelect.ready[myIndex];
    tryResolveCharSelect(false);
  });

  socket.on('disconnect', () => {
    sockets[myIndex] = null;

    // 매치가 아직 시작 전(대기/게임오버)이라면 예전처럼 바로 초기화한다.
    if (gameState.phase === 'waiting' || gameState.phase === 'game_over') {
      gameState = createInitialState();
      return;
    }

    // 대전(또는 맵/캐릭터 선택) 도중 끊긴 경우: 곧바로 매치를 날리지 않고
    // 재접속 유예시간을 준다. 그동안 게임 루프는 일시정지되어, 남은 플레이어가
    // 연결 끊긴 상대를 일방적으로 두들겨 패는 불공정한 상황을 막는다.
    gameState.disconnectedIndex = myIndex;
    gameState.reconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
    clearTimeout(reconnectTimers[myIndex]);
    reconnectTimers[myIndex] = setTimeout(() => {
      if (sockets[myIndex]) return; // 유예시간 안에 이미 재접속함
      if (gameState.phase === 'playing' || gameState.phase === 'countdown') {
        // 대전 중이었다면 상대의 몰수승 처리
        gameState.phase = 'game_over';
        gameState.winner = myIndex === 0 ? 1 : 0;
        gameState.disconnectedIndex = null;
        gameState.reconnectDeadline = null;
        setTimeout(() => {
          if (gameState.phase === 'game_over') gameState = createInitialState();
        }, 5000);
      } else {
        // 맵/캐릭터 선택 단계였다면 그냥 매치를 초기화
        gameState = createInitialState();
      }
    }, RECONNECT_GRACE_MS);
  });
});

function tryResolveMapSelect(force) {
  if (force) {
    for (let i = 0; i < 2; i++) {
      if (!gameState.mapPick.bans[i]) gameState.mapPick.bans[i] = MAPS[Math.floor(Math.random() * MAPS.length)].id;
    }
  }
  const bans = gameState.mapPick.bans;
  if (bans[0] && bans[1]) {
    let available = MAPS.filter(m => !bans.includes(m.id));
    if (available.length === 0) available = MAPS;
    const chosen = available[Math.floor(Math.random() * available.length)];
    gameState.mapId = chosen.id;
    gameState.map = chosen;
    gameState.phase = 'char_select';
  }
}

function tryResolveCharSelect(force) {
  const cs = gameState.charSelect;
  if (force) {
    for (let i = 0; i < 2; i++) {
      if (!cs.picks[i]) cs.picks[i] = CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id;
      cs.ready[i] = true;
    }
  }
  if (cs.picks[0] && cs.picks[1] && cs.ready[0] && cs.ready[1]) {
    const mw = gameState.map.width;
    gameState.players = [
      createPlayer(0, cs.picks[0], Math.round(mw * 0.15)),
      createPlayer(1, cs.picks[1], Math.round(mw * 0.85))
    ];
    gameState.phase = 'countdown';
    gameState.countdown = 3;
    startCountdown();
  }
}

function startCountdown() {
  gameState.countdown = 3;
  const timer = setInterval(() => {
    if (gameState.phase !== 'countdown') { clearInterval(timer); return; }
    gameState.countdown--;
    if (gameState.countdown <= 0) {
      clearInterval(timer);
      gameState.phase = 'playing';
    }
  }, 1000);
}

// ─── 게임 루프 (60 FPS) ──────────────────────────────────────────────────────
setInterval(() => {
  const waitingReconnect = gameState.disconnectedIndex !== null;
  if (waitingReconnect) {
    // 상대가 재접속하길 기다리는 동안에는 타이머/물리/전투를 전부 멈춘다.
    // (연결 끊긴 플레이어를 일방적으로 두들겨 패거나, 선택 타이머가 흘러버리는 걸 방지)
    io.emit('gameState', gameState);
    return;
  }
  if (gameState.phase === 'map_select') {
    gameState.mapPick.timer--;
    if (gameState.mapPick.timer <= 0) tryResolveMapSelect(true);
  } else if (gameState.phase === 'char_select') {
    gameState.charSelect.timer--;
    if (gameState.charSelect.timer <= 0) tryResolveCharSelect(true);
  } else if (gameState.phase === 'playing') {
    if (gameState.hitStop > 0) {
      gameState.hitStop--;
    } else {
      updatePhysics();
      updateSkillsAndCombat();
      updateProjectiles();
      updateHazards();
    }
    updateEffects();
    checkGameOver();
  }
  io.emit('gameState', gameState);
}, 1000 / 60);

// ─── 지형 판정 ──────────────────────────────────────────────────────────────
function mapWidth() { return gameState.map ? gameState.map.width : VIEW_W; }
function clampX(x) { const mw = mapWidth(); return Math.max(26, Math.min(mw - 26, x)); }

function getGroundY(x, prevY) {
  const map = gameState.map;
  if (!map) return FLOOR_Y;
  let best = map.floorY;
  for (const pl of map.platforms) {
    if (x >= pl.x1 && x <= pl.x2 && prevY <= pl.y + 1 && pl.y < best) best = pl.y;
  }
  return best;
}

// ─── 물리 및 이동 연산 ──────────────────────────────────────────────────────
function updatePhysics() {
  const mw = mapWidth();
  for (const p of gameState.players) {
    if (p.action === 'dead') continue;

    for (const k in p.cooldowns) if (p.cooldowns[k] > 0) p.cooldowns[k]--;
    if (p.invincible > 0) p.invincible--;
    if (p.trapped > 0) p.trapped--;
    if (p.dmgVulnTimer > 0) p.dmgVulnTimer--;
    if (p.speedBuffTimer > 0) p.speedBuffTimer--;
    if (p.stunChainWindow > 0) p.stunChainWindow--;
    tickPoison(p);

    if (p.actionTimer > 0) {
      p.actionTimer--;
      if (p.actionTimer === 0 && p.action !== 'dead') {
        // 평타 모션이 끝나면 곧바로 다음 평타를 낼 수 있는 게 아니라
        // 콤보 단수별 회복시간(recovery)만큼 살짝 딜레이를 준다 (타격감).
        if (p.action === 'attack') {
          const cfg = COMBO_ATK[p.attackStep] || COMBO_ATK[0];
          const isFinisher = p.attackStep === COMBO_ATK.length - 1;
          p.atkRecoveryTimer = isFinisher ? COMBO_FINISHER_CD : cfg.recovery;
          p.comboWindowTimer = isFinisher ? 0 : (cfg.recovery + COMBO_CHAIN_GRACE);
          p.comboStep = (p.attackStep + 1) % COMBO_ATK.length;
        }
        p.action = 'idle';
      }
    }
    if (p.atkRecoveryTimer > 0) p.atkRecoveryTimer--;
    if (p.comboWindowTimer > 0) {
      p.comboWindowTimer--;
      if (p.comboWindowTimer === 0 && p.action !== 'attack') p.comboStep = 0;
    }

    // ─ 가드: 다른 어떤 동작에도 묶여있지 않고 땅에 있을 때 버튼을 누르고 있는 동안 유지된다.
    // guardTimer는 "가드를 든 지 몇 프레임째인지"를 세는데, 이 값이 JUST_GUARD_WINDOW 이하일
    // 때 맞으면 저스트가드(완전 무효화+반격)가 된다 (applyDamage에서 판정).
    const freeToGuard = !(['attack', 'skill_e', 'skill_r', 'skill_f', 'skill_t', 'skill_x', 'hurt', 'stunned'].includes(p.action) && p.actionTimer > 0) && p.trapped <= 0;
    if (p.input.guard && freeToGuard && p.isGrounded) {
      p.guardTimer = p.action === 'guard' ? p.guardTimer + 1 : 0;
      p.action = 'guard';
    } else if (p.action === 'guard') {
      p.action = 'idle';
      p.guardTimer = 0;
    }

    const isLocked = (['attack', 'skill_e', 'skill_r', 'skill_f', 'skill_t', 'skill_x', 'hurt', 'stunned'].includes(p.action) && p.actionTimer > 0) || p.trapped > 0 || p.action === 'guard';

    if (!isLocked) {
      let vx = 0;
      const moveSpd = p.speedBuffTimer > 0 ? p.speed * 1.35 : p.speed;
      if (p.input.left) { vx = -moveSpd; p.facing = -1; }
      if (p.input.right) { vx = moveSpd; p.facing = 1; }
      p.x = Math.max(26, Math.min(mw - 26, p.x + vx));

      if (p.input.jump && p.isGrounded) { p.vy = JUMP_FORCE; p.isGrounded = false; }

      if (!p.isGrounded) p.action = p.vy < 0 ? 'jump' : 'fall';
      else p.action = vx !== 0 ? 'run' : 'idle';
    }

    const prevY = p.y;
    p.vy += GRAVITY;
    p.y += p.vy;
    const groundY = getGroundY(p.x, prevY);
    if (p.y >= groundY) { p.y = groundY; p.vy = 0; p.isGrounded = true; }
    else p.isGrounded = false;
  }
}

// ─── 스킬 및 전투 연산 ──────────────────────────────────────────────────────
function updateSkillsAndCombat() {
  for (const p of gameState.players) {
    if (p.action === 'dead' || p.action === 'stunned') continue;
    const enemy = gameState.players.find(e => e.index !== p.index);
    const locked = (['attack', 'skill_e', 'skill_r', 'skill_f', 'skill_t', 'skill_x', 'hurt'].includes(p.action) && p.actionTimer > 0) || p.trapped > 0 || p.action === 'guard';

    if (!locked) {
      const cd = CLASS_CD[p.class];
      // 평타: 콤보 회복시간(atkRecoveryTimer)이 끝나야 다음 타격을 낼 수 있다.
      if (p.input.attack && p.atkRecoveryTimer === 0) {
        const step = p.comboStep || 0;
        const cfg = COMBO_ATK[step];
        p.action = 'attack'; p.actionTimer = cfg.dur; p.attackStep = step;
      } else if (p.input.skill_e && p.cooldowns.e === 0) {
        resetCombo(p);
        p.action = 'skill_e'; p.actionTimer = ATK_DUR.skill_e; p.cooldowns.e = Math.round(cd.e * p.cdMult);
      } else if (p.input.skill_r && p.cooldowns.r === 0) {
        resetCombo(p);
        p.action = 'skill_r'; p.actionTimer = ATK_DUR.skill_r; p.cooldowns.r = Math.round(cd.r * p.cdMult);
      } else if (p.input.skill_f && p.cooldowns.f === 0) {
        resetCombo(p);
        p.action = 'skill_f'; p.actionTimer = ATK_DUR.skill_f; p.cooldowns.f = Math.round(cd.f * p.cdMult);
      } else if (p.input.skill_t && p.cooldowns.t === 0) {
        resetCombo(p);
        p.action = 'skill_t'; p.actionTimer = ATK_DUR.skill_t; p.cooldowns.t = Math.round(cd.t * p.cdMult);
      } else if (p.input.skill_x && p.ultGauge >= ULT_GAUGE_MAX) {
        resetCombo(p);
        const dur = ULT_DUR[p.charId] || 70;
        p.action = 'skill_x'; p.actionTimer = dur; p.ultTotal = dur; p.ultGauge = 0;
      }
    }

    if (p.action === 'skill_x') {
      resolveUltimateTick(p, enemy);
    } else if (p.action === 'attack') {
      const cfg = COMBO_ATK[p.attackStep] || COMBO_ATK[0];
      if (p.actionTimer === cfg.trigger) resolveActionEffect(p, enemy);
    } else if (p.actionTimer === TRIGGER[p.action]) {
      resolveActionEffect(p, enemy);
    }
  }
}

function D(p, base) { return Math.round(base * p.dmgMult); }
function meleeHit(p, enemy, range, heightRange) {
  if (heightRange === undefined) heightRange = 60;
  return !!enemy && Math.abs(p.x - enemy.x) < range && Math.abs(p.y - enemy.y) < heightRange;
}
function facingEnemy(p, enemy) {
  return !!enemy && ((p.facing === 1 && enemy.x > p.x) || (p.facing === -1 && enemy.x < p.x));
}
function applyStun(target, frames) {
  if (target.hp <= 0) return;

  // CC 저항(디미니싱 리턴): 짧은 시간 안에 스턴을 연속으로 맞을수록 지속시간이 줄어든다.
  // 스턴 없이 STUN_CHAIN_RESET 프레임이 지나면 저항 단계가 초기화된다.
  target.stunChainCount = target.stunChainWindow > 0 ? Math.min(target.stunChainCount + 1, STUN_DR_MUL.length - 1) : 0;
  target.stunChainWindow = STUN_CHAIN_RESET;
  const effFrames = Math.max(8, Math.round(frames * STUN_DR_MUL[target.stunChainCount]));

  // 이미 스턴 중이 아니었을 때만 "스턴 시작" 이펙트를 띄운다 (스턴 중 재차 스턴이 걸려도
  // 이펙트가 중복 폭발하지 않도록). 이 함수 내부에서 항상 이펙트를 발생시키므로,
  // 개별 스킬 코드에서 이펙트를 깜빡 잊고 안 넣어도 스턴 연출이 절대 누락되지 않는다.
  if (target.action !== 'stunned') {
    gameState.effects.push({ type: 'stun_hit', x: target.x, y: target.y - 78, life: 26, maxLife: 26 });
  }
  if (target.stunChainCount > 0) {
    gameState.effects.push({ type: 'stun_resist', x: target.x, y: target.y - 96, life: 30, maxLife: 30 });
  }
  target.action = 'stunned'; target.actionTimer = effFrames; target.trapped = effFrames;
}
// ─── 독(포이즌) 상태이상 (한조 전용 — 즉발 피해 없이 시간에 걸쳐 계속 갉아먹는다) ──
function applyPoison(target, attackerIndex, dmgPerTick, ticks, interval) {
  if (!target || target.hp <= 0) return;
  target.poison = { attackerIndex, dmgPerTick, ticksLeft: ticks, tickTimer: interval, interval };
}
function tickPoison(p) {
  if (!p.poison || p.action === 'dead') return;
  p.poison.tickTimer--;
  if (p.poison.tickTimer > 0) return;
  p.poison.tickTimer = p.poison.interval;
  p.hp = Math.max(0, p.hp - p.poison.dmgPerTick);
  gameState.effects.push({ type: 'poison_tick', x: p.x, y: p.y - 40, life: 18, maxLife: 18, color: '#5fd45f' });
  const attacker = gameState.players.find(a => a.index === p.poison.attackerIndex);
  if (attacker && attacker.index !== p.index) attacker.ultGauge = Math.min(ULT_GAUGE_MAX, attacker.ultGauge + 4);
  p.poison.ticksLeft--;
  if (p.poison.ticksLeft <= 0 || p.hp <= 0) p.poison = null;
  if (p.hp <= 0 && p.action !== 'dead') p.action = 'dead';
}
function makeProjectile(type, p, opts) {
  return Object.assign({ type, x: p.x + p.facing * 30, y: p.y - 40, index: p.index, facing: p.facing }, opts);
}
function spawnRain(caster, enemy, count, spread, dmgEach, type) {
  if (!enemy) return;
  for (let i = 0; i < count; i++) {
    const offset = count === 1 ? 0 : (-spread / 2 + spread * i / (count - 1));
    gameState.projectiles.push({
      type, x: enemy.x + offset, y: enemy.y - 240,
      vx: (type === 'arrow' || type === 'meteor') ? (Math.random() - 0.5) * 1.5 : 0,
      vy: type === 'meteor' ? 9 : 8,
      index: caster.index, facing: caster.facing, damage: dmgEach,
      spawnDelay: 14 + i * 5, launchEffect: true
    });
  }
}

function resolveActionEffect(p, enemy) {
  if (p.action === 'attack') { resolveComboAttack(p, enemy); return; }
  resolveCharSkill(p, enemy);
}

// 피격 시 knockback을 살짝 더 주는 헬퍼 (콤보 4타 마무리용)
function extraKnockback(p, enemy, amt) {
  if (!enemy || enemy.hp <= 0) return;
  const dir = enemy.x >= p.x ? 1 : -1;
  enemy.x = clampX(enemy.x + dir * amt);
}

// ─── 평타 4단 콤보 (클래스 공통 메커니즘, 명중 시 콤보 스턴 적용) ─────────────
function resolveComboAttack(p, enemy) {
  const step = p.attackStep || 0;
  const cfg = COMBO_ATK[step];
  const finisher = step === COMBO_ATK.length - 1;
  const stun = comboStunFrames(step);

  function meleeCombo(range, baseDmg, knockback) {
    if (meleeHit(p, enemy, range)) {
      applyDamage(p, enemy, D(p, baseDmg * cfg.dmgMul));
      if (enemy.hp > 0) applyStun(enemy, stun);
      if (finisher) { gameState.hitStop = Math.max(gameState.hitStop, 9); extraKnockback(p, enemy, knockback || 14); }
    }
  }
  function rangedCombo(type, spd, baseDmg) {
    gameState.projectiles.push(makeProjectile(type, p, {
      vx: p.facing * spd, vy: 0, damage: D(p, baseDmg * cfg.dmgMul),
      comboStun: stun, finisher
    }));
  }

  switch (p.class) {
    case 'saber':     meleeCombo(finisher ? 82 : 75, 9, 16); break;
    case 'lancer':    meleeCombo(finisher ? 96 : 88, 8, 16); break;
    case 'berserker': meleeCombo(finisher ? 80 : 72, 11, 20); break;
    case 'rider':     meleeCombo(finisher ? 86 : 78, 8, 16); break;
    case 'assassin':  meleeCombo(finisher ? 66 : 60, 6, 12); break;
    case 'archer':    rangedCombo('arrow', 14, 7); break;
    case 'caster':    rangedCombo('bolt', 13, 7); break;
  }
}

// ─── 캐릭터별 스킬(E/R/T/F) — 14인 전원이 서로 겹치지 않도록 개별 설계 ─────────
// 규칙: E(K키)는 모든 영웅이 "원거리 공격"을 갖되, 투사체의 궤적/개수/방식이
// 서로 겹치지 않도록 한다(수렴형, 관통형, 포물선, 연사, 부메랑, 분열, 곡사 등).
function resolveCharSkill(p, enemy) {
  switch (p.charId) {

    // ── 세이버 ──────────────────────────────────────────────────────────
    case 'saber_musashi': switch (p.action) {
      case 'skill_e': { // 이도류 십자검기: 위/아래에서 교차하며 나아가는 두 줄기 검기
        gameState.projectiles.push({ type: 'sword_wave', x: p.x + p.facing * 30, y: p.y - 62, vx: p.facing * 11, vy: 1.6, index: p.index, facing: p.facing, damage: D(p, 7) });
        gameState.projectiles.push({ type: 'sword_wave', x: p.x + p.facing * 30, y: p.y - 18, vx: p.facing * 11, vy: -1.6, index: p.index, facing: p.facing, damage: D(p, 7) });
        break;
      }
      case 'skill_r': // 돌진베기: 잔영처럼 파고드는 짧은 무적 프레임이 실린 근접 대시
        p.invincible = Math.max(p.invincible, 10);
        p.x = clampX(p.x + p.facing * 90);
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        if (meleeHit(p, enemy, 85)) applyDamage(p, enemy, D(p, 11));
        break;
      case 'skill_t':
        if (meleeHit(p, enemy, 82)) applyDamage(p, enemy, D(p, 17));
        gameState.effects.push({ type: 'counter', x: p.x + p.facing * 40, y: p.y - 45, life: 16, maxLife: 16, color: p.color });
        break;
      case 'skill_f':
        if (meleeHit(p, enemy, 105, 70)) applyDamage(p, enemy, D(p, 21));
        gameState.effects.push({ type: 'whirl', x: p.x, y: p.y - 40, life: 20, maxLife: 20, color: p.color });
        break;
    } break;

    case 'saber_arthur': switch (p.action) {
      case 'skill_e': // 엑스칼리버 참격: 관통하는 직선 광파 (한 번만 명중 판정 후 계속 날아감)
        gameState.projectiles.push({ type: 'sword_wave', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 9, vy: 0, index: p.index, facing: p.facing, damage: D(p, 16), pierce: true });
        gameState.effects.push({ type: 'sword_launch', x: p.x + p.facing * 30, y: p.y - 40, life: 20, maxLife: 20, extra: p.facing, color: p.color });
        break;
      case 'skill_r': // 왕의 돌격: 정면으로 밀어붙이는 묵직한 돌격, 명중 시 잠깐 더 버티는 왕의 위엄(피격 무적)이 실린다
        p.x = clampX(p.x + p.facing * 100);
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        if (meleeHit(p, enemy, 90)) { applyDamage(p, enemy, D(p, 10)); p.invincible = Math.max(p.invincible, 12); }
        break;
      case 'skill_t': // 수호의 검: 짧은 무적 뒤 반격
        p.invincible = Math.max(p.invincible, 6);
        if (meleeHit(p, enemy, 85)) applyDamage(p, enemy, D(p, 16));
        gameState.effects.push({ type: 'counter', x: p.x + p.facing * 40, y: p.y - 45, life: 16, maxLife: 16, color: p.color });
        break;
      case 'skill_f':
        if (meleeHit(p, enemy, 118, 75)) applyDamage(p, enemy, D(p, 20));
        gameState.effects.push({ type: 'whirl', x: p.x, y: p.y - 40, life: 22, maxLife: 22, color: p.color });
        break;
    } break;

    // ── 랜서 ────────────────────────────────────────────────────────────
    case 'lancer_guanyu': switch (p.action) {
      case 'skill_e': // 청룡언월 관통투창: 무겁고 느리지만 관통하는 단발 창
        gameState.projectiles.push(makeProjectile('spear', p, { vx: p.facing * 10, vy: 0, damage: D(p, 17), pierce: true }));
        break;
      case 'skill_r': { // 갈고리 당기기: 청룡언월도 특유의 갈고리날로 적을 걸어 끌어당긴 뒤 짧게 제압한다
        p.x = clampX(p.x + p.facing * 80);
        if (meleeHit(p, enemy, 92)) {
          applyDamage(p, enemy, D(p, 8));
          if (enemy.hp > 0) {
            const dir = enemy.x >= p.x ? 1 : -1;
            enemy.x = clampX(p.x + dir * 40);
            applyStun(enemy, 22);
            gameState.effects.push({ type: 'hook_pull', x: enemy.x, y: enemy.y - 40, life: 16, maxLife: 16, color: p.color });
          }
        }
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        break;
      }
      case 'skill_t': { // 파랑삼첩: 3연 창 파편
        const angles = [-0.22, 0, 0.22];
        angles.forEach(a => gameState.projectiles.push({ type: 'shard', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 11 * Math.cos(a), vy: 11 * Math.sin(a), index: p.index, damage: D(p, 6) }));
        break;
      }
      case 'skill_f':
        spawnRain(p, enemy, 5, 140, D(p, 5), 'spear');
        break;
    } break;

    case 'lancer_achilles': switch (p.action) {
      case 'skill_e': { // 트리플 창던지기: 좁은 부채꼴로 3연발
        const angles = [-0.12, 0, 0.12];
        angles.forEach(a => gameState.projectiles.push({ type: 'spear', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 13 * Math.cos(a), vy: 13 * Math.sin(a), index: p.index, facing: p.facing, damage: D(p, 7) }));
        break;
      }
      case 'skill_r': // 신속의 돌진: 찌르고 지나가며 잠시 발이 빨라진다 (아킬레우스의 준족)
        p.x = clampX(p.x + p.facing * 95);
        if (meleeHit(p, enemy, 88)) applyDamage(p, enemy, D(p, 8));
        p.speedBuffTimer = 100;
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        gameState.effects.push({ type: 'speed_buff', x: p.x, y: p.y - 30, life: 20, maxLife: 20, color: p.color });
        break;
      case 'skill_t': // 관통찌르기: 적을 꿰뚫고 뒤로 빠져나가는 돌진
        if (enemy && Math.abs(p.x - enemy.x) < 200) { p.x = clampX(enemy.x + enemy.facing * 30); }
        if (meleeHit(p, enemy, 90)) { applyDamage(p, enemy, D(p, 15)); applyStun(enemy, 30); }
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        break;
      case 'skill_f': // 분노의 창격: 넓은 범위 강타 (관우의 창비와 달리 근접 광역)
        if (meleeHit(p, enemy, 110, 80)) applyDamage(p, enemy, D(p, 22));
        gameState.effects.push({ type: 'whirl', x: p.x, y: p.y - 30, life: 20, maxLife: 20, color: p.color });
        break;
    } break;

    // ── 아처 ────────────────────────────────────────────────────────────
    case 'archer_artemis': switch (p.action) {
      case 'skill_e': // 달빛 포물선: 중력의 영향을 받아 곡선으로 떨어지는 화살
        gameState.projectiles.push(makeProjectile('moon_arrow', p, { vx: p.facing * 10, vy: -7, damage: D(p, 15), gravity: 0.5 }));
        break;
      case 'skill_r': // 회피: 뒤로 빠지며 무적
        p.invincible = 30;
        p.x = clampX(p.x - p.facing * 70);
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        break;
      case 'skill_t': // 포박 사격: 광역 속박
        if (meleeHit(p, enemy, 150, 70)) {
          gameState.effects.push({ type: 'barrier', x: enemy.x, y: enemy.y - 40, life: 80, maxLife: 80, color: p.color });
          applyDamage(p, enemy, D(p, 10));
          if (enemy.hp > 0) applyStun(enemy, 70);
        }
        break;
      case 'skill_f':
        spawnRain(p, enemy, 5, 140, D(p, 5), 'arrow');
        break;
    } break;

    case 'archer_jumong': switch (p.action) {
      case 'skill_e': // 연사 이중사격: 두 발을 짧은 간격으로 연속 발사
        gameState.projectiles.push(makeProjectile('arrow', p, { vx: p.facing * 16, vy: 0, damage: D(p, 8) }));
        gameState.projectiles.push({ type: 'arrow', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 16, vy: 0, index: p.index, facing: p.facing, damage: D(p, 8), spawnDelay: 6 });
        break;
      case 'skill_r': // 전진 회피: 앞으로 파고들며 무적
        p.invincible = 26;
        p.x = clampX(p.x + p.facing * 60);
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        break;
      case 'skill_t': // 관통 저격: 초고속 관통 저격
        gameState.projectiles.push(makeProjectile('giant_arrow', p, { vx: p.facing * 22, vy: 0, damage: D(p, 19), pierce: true }));
        break;
      case 'skill_f': { // 백발백중 연환사: 지상에서 부채꼴로 직접 쏘는 5연발
        const angles = [-0.18, -0.09, 0, 0.09, 0.18];
        angles.forEach(a => gameState.projectiles.push({ type: 'arrow', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 13 * Math.cos(a), vy: 13 * Math.sin(a), index: p.index, facing: p.facing, damage: D(p, 5) }));
        break;
      }
    } break;

    // ── 버서커 ──────────────────────────────────────────────────────────
    case 'berserker_hercules': switch (p.action) {
      case 'skill_e': // 네메아 투석: 바닥에 두 번 튕기는 거대한 돌
        gameState.projectiles.push(makeProjectile('boulder', p, { vx: p.facing * 8, vy: -3, damage: D(p, 14), gravity: 0.3, bounce: true, bouncesLeft: 2 }));
        break;
      case 'skill_r': // 돌진강타: 공중에 뜬 적은 붙잡기 쉬운 법 — 상대가 공중에 있으면 추가 피해
        p.x = clampX(p.x + p.facing * 110);
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 16, maxLife: 16, color: p.color });
        if (meleeHit(p, enemy, 95)) {
          const airBonus = !enemy.isGrounded ? 8 : 0;
          applyDamage(p, enemy, D(p, 14) + airBonus);
          applyStun(enemy, 40);
        }
        break;
      case 'skill_t':
        if (meleeHit(p, enemy, 115, 75)) { applyDamage(p, enemy, D(p, 18)); applyStun(enemy, 40); }
        gameState.effects.push({ type: 'whirl', x: p.x, y: p.y - 10, life: 22, maxLife: 22, color: p.color });
        break;
      case 'skill_f':
        if (meleeHit(p, enemy, 92)) applyDamage(p, enemy, D(p, 24));
        break;
    } break;

    case 'berserker_ragnar': switch (p.action) {
      case 'skill_e': // 회전 도끼: 날아갔다가 되돌아오는 부메랑
        gameState.projectiles.push(makeProjectile('shard', p, { vx: p.facing * 12, vy: 0, damage: D(p, 13), boomerang: true, boomOut: 22 }));
        break;
      case 'skill_r': // 돌진강타: 헤라클레스처럼 붙잡아두는 게 아니라, 그냥 힘으로 멀리 날려버리는 거친 강타
        p.x = clampX(p.x + p.facing * 120);
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 16, maxLife: 16, color: p.color });
        if (meleeHit(p, enemy, 90)) {
          applyDamage(p, enemy, D(p, 15));
          extraKnockback(p, enemy, 46);
          gameState.hitStop = Math.max(gameState.hitStop, 8);
          gameState.effects.push({ type: 'ground_crack', x: enemy ? enemy.x : p.x, y: p.y, life: 18, maxLife: 18, color: p.color });
        }
        break;
      case 'skill_t': // 광폭화 도약강타: 짧게 도약해 내리찍기
        p.x = clampX(p.x + p.facing * 60);
        if (meleeHit(p, enemy, 100, 80)) { applyDamage(p, enemy, D(p, 19)); applyStun(enemy, 30); }
        gameState.effects.push({ type: 'whirl', x: p.x, y: p.y - 10, life: 20, maxLife: 20, color: p.color });
        break;
      case 'skill_f': // 폭풍연격: 관통하며 지나가는 돌진 타격
        p.x = clampX(p.x + p.facing * 90);
        if (meleeHit(p, enemy, 95)) applyDamage(p, enemy, D(p, 23));
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 18, maxLife: 18, color: p.color });
        break;
    } break;

    // ── 캐스터 ──────────────────────────────────────────────────────────
    case 'caster_merlin': switch (p.action) {
      case 'skill_e': // 유도 마력구: 적을 따라가는 유도탄
        gameState.projectiles.push(makeProjectile('orb', p, { vx: p.facing * 9, vy: 0, damage: D(p, 12), homing: true }));
        break;
      case 'skill_r': // 블링크 (전방 순간이동 + 무적)
        p.invincible = 18;
        p.x = clampX(p.x + p.facing * 130);
        gameState.effects.push({ type: 'transform_out', x: p.x, y: p.y - 40, life: 20, maxLife: 20, color: p.color });
        break;
      case 'skill_t':
        if (meleeHit(p, enemy, 160, 90)) {
          gameState.effects.push({ type: 'barrier', x: enemy.x, y: enemy.y - 40, life: 90, maxLife: 90, color: p.color });
          applyDamage(p, enemy, D(p, 11));
          if (enemy.hp > 0) applyStun(enemy, 80);
        }
        break;
      case 'skill_f':
        spawnRain(p, enemy, 5, 160, D(p, 5), 'meteor');
        break;
    } break;

    case 'caster_circe': switch (p.action) {
      case 'skill_e': // 분열하는 저주구: 절반쯤 날아가다 두 갈래로 갈라짐
        gameState.projectiles.push(makeProjectile('orb', p, { vx: p.facing * 8, vy: 0, damage: D(p, 10), splitAt: 22 }));
        break;
      case 'skill_r': // 순간이동 (후방, 멀린보다 짧게)
        p.invincible = 16;
        p.x = clampX(p.x - p.facing * 90);
        gameState.effects.push({ type: 'transform_out', x: p.x, y: p.y - 40, life: 18, maxLife: 18, color: p.color });
        break;
      case 'skill_t': // 짐승화 저주: 근접 저주 일격 (변신 스턴)
        if (meleeHit(p, enemy, 90, 80)) {
          applyDamage(p, enemy, D(p, 12));
          if (enemy.hp > 0) { applyStun(enemy, 85); gameState.effects.push({ type: 'polymorph', x: enemy.x, y: enemy.y - 40, life: 70, maxLife: 70, color: p.color }); }
        }
        break;
      case 'skill_f': // 저주의 비: 명중 시 저주(변신) 효과가 있는 독 항아리 비
        if (!enemy) break;
        for (let i = 0; i < 5; i++) {
          const offset = -80 + 160 * i / 4;
          gameState.projectiles.push({ type: 'curse_potion', x: enemy.x + offset, y: enemy.y - 240, vx: (Math.random() - 0.5) * 1.2, vy: 8, index: p.index, facing: p.facing, damage: D(p, 4), curse: true, spawnDelay: 14 + i * 5, launchEffect: true });
        }
        break;
    } break;

    case 'caster_ph': switch (p.action) {
      case 'skill_e': { // 매직 카드 난사: 부채꼴로 카드 3장을 빠르게 던진다
        const angles = [-0.12, 0, 0.12];
        angles.forEach(a => gameState.projectiles.push({ type: 'ph_card', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 15 * Math.cos(a), vy: 15 * Math.sin(a), index: p.index, facing: p.facing, damage: D(p, 7) }));
        break;
      }
      case 'skill_r': // 사라지는 마술: 짧게 사라져(무적) 상대의 공격을 흘리고 곧바로 반격한다
        p.invincible = Math.max(p.invincible, 16);
        gameState.effects.push({ type: 'transform_out', x: p.x, y: p.y - 40, life: 16, maxLife: 16, color: p.color });
        if (meleeHit(p, enemy, 78)) { applyDamage(p, enemy, D(p, 12)); if (enemy.hp > 0) applyStun(enemy, 24); }
        gameState.effects.push({ type: 'counter', x: p.x + p.facing * 40, y: p.y - 45, life: 16, maxLife: 16, color: p.color });
        break;
      case 'skill_t': { // 손안의 마술: 주위에 카드 5장을 펼쳐 5초간 남겨두고, 상대가 닿으면 데미지
        const n = 5, r = 85;
        for (let i = 0; i < n; i++) {
          const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
          gameState.hazards.push({
            type: 'ph_card', ownerIndex: p.index,
            x: clampX(p.x + Math.cos(ang) * r), y: (p.y - 40) + Math.sin(ang) * r * 0.6,
            life: 300, damage: D(p, 9)
          });
        }
        gameState.effects.push({ type: 'ult_charge', x: p.x, y: p.y - 40, life: 18, maxLife: 18, color: p.color });
        break;
      }
      case 'skill_f': // 관통 마술: 상대의 위치로 순간이동한 뒤 송곳으로 찔러 데미지를 준다
        if (enemy && Math.abs(p.x - enemy.x) < 260) {
          p.x = clampX(enemy.x - enemy.facing * 34);
          p.facing = enemy.x >= p.x ? 1 : -1;
        } else {
          p.x = clampX(p.x + p.facing * 90);
        }
        gameState.effects.push({ type: 'transform_out', x: p.x, y: p.y - 40, life: 14, maxLife: 14, color: p.color });
        if (meleeHit(p, enemy, 76, 60)) { applyDamage(p, enemy, D(p, 18)); if (enemy.hp > 0) applyStun(enemy, 28); }
        gameState.effects.push({ type: 'hit', x: enemy ? enemy.x : p.x, y: p.y - 40, life: 10, maxLife: 10 });
        break;
    } break;

    // ── 라이더 ──────────────────────────────────────────────────────────
    case 'rider_yisunsin': switch (p.action) {
      case 'skill_e': // 함포 연속사격: 포물선을 그리며 떨어지는 포탄 3발
        for (let i = 0; i < 3; i++) {
          gameState.projectiles.push({ type: 'meteor', x: p.x + p.facing * (40 + i * 26), y: p.y - 120, vx: p.facing * 4, vy: -4, index: p.index, facing: p.facing, damage: D(p, 9), gravity: 0.45, spawnDelay: i * 8 });
        }
        break;
      case 'skill_r': // 돌격 (근접 대시)
        p.x = clampX(p.x + p.facing * 140);
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 16, maxLife: 16, color: p.color });
        if (meleeHit(p, enemy, 100)) applyDamage(p, enemy, D(p, 13));
        break;
      case 'skill_t':
        p.x = clampX(p.x + p.facing * 70);
        if (meleeHit(p, enemy, 95)) applyDamage(p, enemy, D(p, 17));
        break;
      case 'skill_f':
        if (meleeHit(p, enemy, 110)) applyDamage(p, enemy, D(p, 23));
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 18, maxLife: 18, color: p.color });
        break;
    } break;

    case 'rider_khan': switch (p.action) {
      case 'skill_e': // 연환 기사궁술: 말 위에서 뒤돌아보지 않고 같은 궤도로 빠르게 쏘아붙이는 3연사 (파르티안 사법)
        for (let i = 0; i < 3; i++) {
          gameState.projectiles.push({ type: 'arrow', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 17, vy: 0, index: p.index, facing: p.facing, damage: D(p, 6), spawnDelay: i * 5 });
        }
        break;
      case 'skill_r': // 몸으로 밀어붙이는 돌격: 질풍돌파(T)·초원의 질주(F)와 달리 이건 파고들며 버티는 용도 — 짧은 무적이 실린 저위험 돌격
        p.invincible = Math.max(p.invincible, 18);
        p.x = clampX(p.x + p.facing * 150);
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 16, maxLife: 16, color: p.color });
        if (meleeHit(p, enemy, 90)) applyDamage(p, enemy, D(p, 6));
        break;
      case 'skill_t': // 질풍돌파: 적을 관통하듯 지나치는 돌진
        if (enemy && Math.abs(p.x - enemy.x) < 260) p.x = clampX(enemy.x + enemy.facing * 40);
        if (meleeHit(p, enemy, 90)) { applyDamage(p, enemy, D(p, 16)); applyStun(enemy, 25); }
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        break;
      case 'skill_f': // 초원의 질주: 장거리 가속 돌진 강타
        p.x = clampX(p.x + p.facing * 130);
        if (meleeHit(p, enemy, 115)) applyDamage(p, enemy, D(p, 22));
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 20, maxLife: 20, color: p.color });
        break;
    } break;

    // ── 어쌔신 ──────────────────────────────────────────────────────────
    case 'assassin_hanzo': switch (p.action) {
      case 'skill_e': // 곡사 수리검: S자로 휘어지며 날아가는 수리검
        gameState.projectiles.push(makeProjectile('dagger', p, { vx: p.facing * 13, vy: 0, damage: D(p, 9), wave: true, waveAmp: 3.6, waveFreq: 0.24 }));
        break;
      case 'skill_r': // 그림자 이동 (적 배후로 순간이동)
        if (enemy && Math.abs(p.x - enemy.x) < 220) {
          p.x = clampX(enemy.x - enemy.facing * 40);
          p.facing = enemy.x >= p.x ? 1 : -1;
        } else {
          p.x = clampX(p.x + p.facing * 90);
        }
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        if (meleeHit(p, enemy, 72)) applyDamage(p, enemy, D(p, 10));
        break;
      case 'skill_t': { // 단검난무: 5연발 부채꼴
        const angles = [-0.3, -0.15, 0, 0.15, 0.3];
        angles.forEach(a => gameState.projectiles.push({ type: 'dagger', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 11 * Math.cos(a), vy: 11 * Math.sin(a), index: p.index, damage: D(p, 4) }));
        break;
      }
      case 'skill_f': // 독날림: 맹독을 바른 표창을 던져, 명중 시 즉시 피해 + 시간에 걸친 중독 피해
        gameState.projectiles.push(makeProjectile('poison_dart', p, {
          vx: p.facing * 15, vy: 0, damage: D(p, 8), poisonDart: true, poisonDmg: D(p, 5)
        }));
        break;
    } break;

    case 'assassin_jingke': switch (p.action) {
      case 'skill_e': // 은닉 비수: 잠깐 숨겼다가 초고속으로 던지는 단발 비수
        gameState.projectiles.push({ type: 'dagger', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 21, vy: 0, index: p.index, facing: p.facing, damage: D(p, 17), spawnDelay: 12, launchEffect: true });
        break;
      case 'skill_r': // 접근 (한조보다 짧은 사거리, 더 낮은 피해)
        if (enemy && Math.abs(p.x - enemy.x) < 200) {
          p.x = clampX(enemy.x - enemy.facing * 36);
          p.facing = enemy.x >= p.x ? 1 : -1;
        } else {
          p.x = clampX(p.x + p.facing * 85);
        }
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 14, maxLife: 14, color: p.color });
        if (meleeHit(p, enemy, 70)) applyDamage(p, enemy, D(p, 9));
        break;
      case 'skill_t': { // 쌍비수 투척: 좁은 2연발
        const angles = [-0.1, 0.1];
        angles.forEach(a => gameState.projectiles.push({ type: 'dagger', x: p.x + p.facing * 30, y: p.y - 40, vx: p.facing * 14 * Math.cos(a), vy: 14 * Math.sin(a), index: p.index, damage: D(p, 7) }));
        break;
      }
      case 'skill_f': { // 결정타: 적 체력이 낮을수록 추가 피해
        if (meleeHit(p, enemy, 82)) {
          const bonus = enemy && enemy.hp <= enemy.maxHp * 0.35 ? 12 : 0;
          applyDamage(p, enemy, D(p, 18) + bonus);
        }
        break;
      }
    } break;
  }
}

// ─── 궁극기(필살기) 전용 시스템 ───────────────────────────────────────────────
// 클래스 공통이 아니라 "캐릭터 개인" 단위로 완전히 다른 연출/판정을 갖는다.
// ULT_DUR = 캐릭터별 궁극기 총 지속 프레임(락 시간, 60fps 기준). 시전 시간을
// 늘려 묵직한 한 방으로 느껴지도록 구성했다. resolveUltimateTick은 skill_x
// 액션이 유지되는 동안 "매 프레임" 호출되어, 특정 프레임 구간에서 이동/판정/
// 이펙트를 순차적으로 발생시킨다 (한 번에 툭 터지는 게 아니라 진행감 있게).
const ULT_DUR = {
  saber_musashi:      108,
  saber_arthur:        150,
  lancer_guanyu:       118,
  lancer_achilles:     120,
  archer_artemis:      130,
  archer_jumong:       110,
  berserker_hercules:  130,
  berserker_ragnar:    130,
  caster_merlin:       150,
  caster_circe:        130,
  caster_ph:            70,
  rider_yisunsin:      240,
  rider_khan:          140,
  assassin_hanzo:      116,
  assassin_jingke:     130
};

function resolveUltimateTick(p, enemy) {
  const total = p.ultTotal || ULT_DUR[p.charId] || 70;
  const frame = total - p.actionTimer;
  const f = p.facing;

  switch (p.charId) {

    // 미야모토 무사시 — 이도류 십자참 (길게 기를 모으고, 잔상 스텝으로 파고든 뒤 X자로 두 번 베어 지나간다)
    case 'saber_musashi':
      if (frame === 0) gameState.effects.push({ type: 'ult_charge', x: p.x, y: p.y - 40, life: 30, maxLife: 30, color: p.color });
      if (frame === 30) gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 12, maxLife: 12, color: p.color }); // 파고드는 잔상 스텝
      if (frame === 40) {
        p.x = clampX(p.x + f * 150);
        if (meleeHit(p, enemy, 130, 70)) applyDamage(p, enemy, D(p, 20));
        gameState.effects.push({ type: 'cross_slash', x: p.x, y: p.y - 40, life: 20, maxLife: 20, color: p.color, extra: 1 });
      }
      if (frame === 56) gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 10, maxLife: 10, color: p.color }); // 공중에서 자세 전환
      if (frame === 72) {
        p.facing = -p.facing;
        p.x = clampX(p.x + p.facing * 150);
        if (meleeHit(p, enemy, 130, 70)) applyDamage(p, enemy, D(p, 20));
        gameState.effects.push({ type: 'cross_slash', x: p.x, y: p.y - 40, life: 20, maxLife: 20, color: p.color, extra: -1 });
      }
      if (frame === 96) gameState.effects.push({ type: 'ultimate', x: p.x, y: p.y - 40, life: 26, maxLife: 26, color: p.color }); // X자 완성 - 검광 폭발
      if (frame === total - 4 && enemy) p.facing = enemy.x >= p.x ? 1 : -1;
      break;

    // 아서 펜드래곤 — 엑스칼리버 강림 (텔레포트 없이 제자리에서 하늘로 검을 치켜들어 힘을 모은 뒤,
    // 대성검을 크게 내려 휘둘러 거대한 검기를 뿜어낸다. 근접 판정 + 관통하는 대형 검기로 구성된다)
    case 'saber_arthur':
      if (frame === 0) gameState.effects.push({ type: 'excalibur_charge', x: p.x, y: p.y - 50, life: 90, maxLife: 90, color: p.color });
      if (frame === 90) {
        gameState.effects.push({ type: 'excalibur_descend', x: p.x, y: p.y - 110, life: 16, maxLife: 16, color: p.color });
      }
      if (frame === 96) {
        if (meleeHit(p, enemy, 130, 90)) { applyDamage(p, enemy, D(p, 28)); applyStun(enemy, 55); }
        gameState.effects.push({ type: 'excalibur_strike', x: p.x + p.facing * 50, y: p.y, life: 30, maxLife: 30, color: p.color });
        gameState.projectiles.push(makeProjectile('excalibur_wave', p, { vx: p.facing * 12, vy: 0, damage: D(p, 24), pierce: true, finisher: true }));
      }
      if (frame === 122) gameState.effects.push({ type: 'ultimate', x: p.x, y: p.y - 40, life: 26, maxLife: 26, color: p.color }); // 검광이 지면을 타고 퍼지는 여운
      break;

    // 관우 — 청룡언월 파랑삼첩 (제자리에서 청룡의 기운을 두른 뒤, 초승달 형상의 기파를 세 번 웅장하게 날린다)
    case 'lancer_guanyu':
      if (frame === 0) gameState.effects.push({ type: 'dragon_aura', x: p.x, y: p.y - 40, life: 100, maxLife: 100, color: p.color });
      if (frame === 32 || frame === 56 || frame === 80) {
        gameState.projectiles.push(makeProjectile('dragon_crescent', p, { vx: f * 10, vy: 0, damage: D(p, 14) }));
        gameState.effects.push({ type: 'sword_launch', x: p.x + f * 30, y: p.y - 40, life: 18, maxLife: 18, extra: f, color: p.color });
      }
      if (frame === 104) gameState.effects.push({ type: 'ultimate', x: p.x, y: p.y - 40, life: 22, maxLife: 22, color: p.color });
      break;

    // 아킬레우스 — 성난 질풍의 창 (연속 찌르기 4연타 후 마지막 관통 돌진, 간격을 늘려 타격 하나하나가 확실히 보이도록)
    case 'lancer_achilles':
      if (frame === 0) gameState.effects.push({ type: 'ult_charge', x: p.x, y: p.y - 30, life: 20, maxLife: 20, color: p.color });
      if ([26, 38, 50, 62].includes(frame)) {
        if (meleeHit(p, enemy, 100, 60)) applyDamage(p, enemy, D(p, 9));
        gameState.effects.push({ type: 'hit', x: enemy ? enemy.x : p.x + f * 80, y: p.y - 40, life: 8, maxLife: 8 });
      }
      if (frame === 86) {
        p.x = clampX(p.x + f * 160);
        if (meleeHit(p, enemy, 150, 70)) { applyDamage(p, enemy, D(p, 22)); applyStun(enemy, 40); }
        gameState.effects.push({ type: 'ultimate', x: p.x, y: p.y - 40, life: 22, maxLife: 22, color: p.color });
      }
      break;

    // 아르테미스 — 달빛의 사냥 (넓은 범위에 달빛 화살비를 오래 예고한 뒤 하늘 가득 퍼붓는다)
    case 'archer_artemis':
      if (frame === 0 && enemy) gameState.effects.push({ type: 'moon_telegraph', x: enemy.x, y: enemy.y - 40, life: 110, maxLife: 110, color: p.color });
      if (frame === 40 && enemy) gameState.effects.push({ type: 'bow_charge', x: p.x, y: p.y - 40, life: 40, maxLife: 40, color: p.color }); // 활을 당기는 예비 동작
      if (frame === 80) spawnRain(p, enemy, 9, 260, D(p, 9), 'moon_arrow');
      break;

    // 주몽 — 백발백중 관통의 화살 (길게, 눈에 보일 만큼 오래 조준한 뒤 거대한 화살 한 발을 꿰뚫는다)
    case 'archer_jumong':
      if (frame === 0) gameState.effects.push({ type: 'bow_charge', x: p.x, y: p.y - 40, life: 80, maxLife: 80, color: p.color });
      if (frame === 80) {
        gameState.projectiles.push(makeProjectile('giant_arrow', p, { vx: f * 22, vy: 0, damage: D(p, 42), pierce: true, finisher: true }));
        gameState.effects.push({ type: 'sword_launch', x: p.x + f * 30, y: p.y - 40, life: 22, maxLife: 22, extra: f, color: p.color });
      }
      break;

    // 헤라클레스 — 네메아의 사자, 대지 강타 (붙잡아 하늘 높이 들어 휘두른 뒤 착지 지점을 내려찍는다)
    case 'berserker_hercules':
      if (frame === 0) gameState.effects.push({ type: 'ult_charge', x: p.x, y: p.y - 40, life: 40, maxLife: 40, color: p.color });
      if (frame === 40 && enemy && meleeHit(p, enemy, 110, 80)) {
        p._grabbed = true;
        enemy.x = clampX(p.x + f * 40);
        enemy.trapped = 90;
        applyDamage(p, enemy, D(p, 10));
        gameState.effects.push({ type: 'counter', x: enemy.x, y: enemy.y - 40, life: 20, maxLife: 20, color: p.color });
      }
      if (p._grabbed && (frame === 55 || frame === 70) && enemy) {
        enemy.x = clampX(p.x + f * (frame === 55 ? 30 : -30)); // 머리 위로 휘두르는 동안 좌우로 흔들림
        gameState.effects.push({ type: 'whirl', x: p.x, y: p.y - 60, life: 14, maxLife: 14, color: p.color });
      }
      if (frame === 100 && p._grabbed && enemy) {
        enemy.x = clampX(p.x + f * 260);
        applyDamage(p, enemy, D(p, 34));
        applyStun(enemy, 50);
        gameState.effects.push({ type: 'ultimate', x: enemy.x, y: enemy.y - 40, life: 26, maxLife: 26, color: p.color });
        p._grabbed = false;
      }
      break;

    // 라그나르 로드브로크 — 발할라의 폭풍 도끼 (제자리에서 폭풍처럼 회전하며 여러 번 베어낸 뒤 마지막에 크게 내려찍는다)
    case 'berserker_ragnar':
      if (frame === 0) gameState.effects.push({ type: 'storm_ring', x: p.x, y: p.y - 30, life: 116, maxLife: 116, color: p.color });
      if ([20, 32, 44, 56, 68, 80, 92].includes(frame)) {
        if (meleeHit(p, enemy, 120, 90)) applyDamage(p, enemy, D(p, 8));
        gameState.effects.push({ type: 'whirl', x: p.x, y: p.y - 30, life: 16, maxLife: 16, color: p.color });
      }
      if (frame === 110) {
        if (meleeHit(p, enemy, 120, 90)) { applyDamage(p, enemy, D(p, 12)); applyStun(enemy, 30); }
        gameState.effects.push({ type: 'ultimate', x: p.x, y: p.y - 30, life: 24, maxLife: 24, color: p.color });
      }
      break;

    // 멀린 — 예정된 운명, 심판의 빛 (적의 현재 위치에 표식을 남기고 오래 기다린 뒤 그 자리를 하늘에서 심판한다)
    case 'caster_merlin':
      if (frame === 0 && enemy) { p._ultMarkX = enemy.x; gameState.effects.push({ type: 'rune_mark', x: enemy.x, y: enemy.y - 10, life: 130, maxLife: 130, color: p.color }); }
      if (frame === 130) {
        const mx = p._ultMarkX !== undefined ? p._ultMarkX : (enemy ? enemy.x : p.x);
        [-40, 0, 40].forEach(o => gameState.effects.push({ type: 'judgment_beam', x: mx + o, y: p.y - 40, life: 28, maxLife: 28, color: p.color }));
        if (enemy && Math.abs(enemy.x - mx) < 90) { applyDamage(p, enemy, D(p, 44)); applyStun(enemy, 60); }
      }
      break;

    // 키르케 — 짐승으로 (마력을 끌어모아 저주의 물약을 던져 명중 시 변신+속박)
    case 'caster_circe':
      if (frame === 0) gameState.effects.push({ type: 'ult_charge', x: p.x, y: p.y - 40, life: 20, maxLife: 20, color: p.color });
      if (frame === 20) gameState.effects.push({ type: 'ult_charge', x: p.x, y: p.y - 40, life: 20, maxLife: 20, color: p.color }); // 두 겹으로 힘을 모으는 연출
      if (frame === 40) {
        gameState.projectiles.push(makeProjectile('curse_potion', p, { vx: f * 7, vy: -2, damage: D(p, 14), curse: true }));
        gameState.effects.push({ type: 'transform_out', x: p.x + f * 30, y: p.y - 40, life: 16, maxLife: 16, color: p.color });
      }
      break;

    // PH — 선녀와 나무꾼 (앞으로 대쉬하여 상대의 옷(갑옷·투구)을 훔친다.
    // 옷을 빼앗긴 상대는 20초간 받는 피해가 2배가 된다)
    case 'caster_ph':
      if (frame === 0) gameState.effects.push({ type: 'ult_charge', x: p.x, y: p.y - 40, life: 20, maxLife: 20, color: p.color });
      if (frame === 20) {
        p.x = clampX(p.x + f * 170);
        gameState.effects.push({ type: 'dash', x: p.x, y: p.y - 30, life: 16, maxLife: 16, color: p.color });
      }
      if (frame === 30) {
        if (meleeHit(p, enemy, 95, 90)) {
          applyDamage(p, enemy, D(p, 12));
          enemy.dmgVulnTimer = 20 * 60; // 20초간 피해 2배 디버프 (옷을 빼앗김)
          gameState.effects.push({ type: 'polymorph', x: enemy.x, y: enemy.y - 40, life: 70, maxLife: 70, color: p.color });
        }
        gameState.effects.push({ type: 'ultimate', x: p.x, y: p.y - 40, life: 22, maxLife: 22, color: p.color });
      }
      break;

    // ── 이순신 — 불멸의 이순신 ──────────────────────────────────────────
    // 하늘을 향해 포효하면 이순신의 살짝 앞쪽 상공에서 거대한 거북선이 천천히
    // 떨어져 내리고, 착지와 동시에 이순신이 그 위로 뛰어올라 탑승한다.
    // 이후 눈에 보일 정도로 느리지만 확실한 속도로 거북선을 몰아 전진 돌격하며
    // 그 사이 이순신은 완전한 불사(무적)의 상태가 된다. 마지막엔 배에서 뛰어
    // 내려와 결정타를 꽂는다.
    case 'rider_yisunsin': {
      const floorY = gameState.map ? gameState.map.floorY : FLOOR_Y;

      if (frame === 0) {
        p.invincible = Math.max(p.invincible, total - 6); // 불멸 — 궁극기 내내 무적
        p._turtleLandX = clampX(p.x + f * 150); // 이순신의 "살짝 앞쪽"
        gameState.effects.push({ type: 'ult_charge', x: p.x, y: p.y - 20, life: 26, maxLife: 26, color: p.color }); // 하늘을 향한 포효
        gameState.effects.push({ type: 'turtle_sky_shadow', x: p._turtleLandX, y: floorY, life: 50, maxLife: 50, color: p.color }); // 낙하 예고 그림자
        gameState.effects.push({ type: 'turtle_falling', x: p._turtleLandX, y: floorY, life: 50, maxLife: 50, color: p.color, extra: f }); // 하늘에서 떨어지는 거북선
      }

      // 거북선 착지 — 충격파와 함께 땅이 흔들린다
      if (frame === 50) {
        gameState.effects.push({ type: 'turtle_land_impact', x: p._turtleLandX, y: floorY, life: 24, maxLife: 24, color: p.color });
        if (enemy && Math.abs(enemy.x - p._turtleLandX) < 140) {
          applyDamage(p, enemy, D(p, 14));
          if (enemy.hp > 0) applyStun(enemy, 34);
        }
      }

      // 착지한 거북선 위로 도약해 올라탄다 (탑승 모션)
      if (frame > 50 && frame < 68) {
        const k = (frame - 50) / 18;
        p.x = clampX(p.x + (p._turtleLandX - p.x) * 0.3);
        p.y = floorY - Math.sin(Math.PI * k) * 30; // 뛰어오르는 포물선 모션
        p.isGrounded = false;
        if (frame === 52) gameState.effects.push({ type: 'yisunsin_mount', x: p.x, y: floorY, life: 18, maxLife: 18, color: p.color });
      }

      // 거북선 갑판 위에 확실히 올라선다
      if (frame === 68) {
        p._deckY = floorY - 36;
        p.y = p._deckY;
        p._rideEndX = clampX(p.x + f * 430);
        gameState.effects.push({ type: 'turtle_ride', x: p.x, y: floorY, endX: p._rideEndX, life: (total - 16) - 68, maxLife: (total - 16) - 68, color: p.color, extra: f });
      }

      // 천천히, 그러나 눈에 보일 정도의 확실한 속도로 거북선을 몰아 전진 돌격한다
      if (frame > 68 && frame < total - 16) {
        p.isGrounded = false;
        p.x = clampX(p.x + f * 1.85);
        p.y = p._deckY + Math.sin(frame * 0.14) * 2; // 파도에 흔들리는 미세한 승선감
        if (enemy && meleeHit(p, enemy, 105, 95)) {
          enemy.x = clampX(enemy.x + f * 1.85);
          if (frame % 16 === 0) applyDamage(p, enemy, D(p, 7));
        }
        if (frame % 20 === 0) gameState.effects.push({ type: 'turtle_cannon', x: p.x + f * 36, y: p.y - 34, life: 14, maxLife: 14, color: p.color, extra: f });
      }

      // 거북선에서 뛰어내려 마지막 일격으로 마무리한다
      if (frame >= total - 16 && frame < total) {
        const k = (frame - (total - 16)) / 16;
        p.isGrounded = false;
        p.y = p._deckY + (floorY - p._deckY) * Math.min(1, k * 1.3);
        if (frame === total - 6) {
          p.y = floorY; p.isGrounded = true;
          if (meleeHit(p, enemy, 115, 90)) applyDamage(p, enemy, D(p, 18));
          gameState.effects.push({ type: 'ultimate', x: p.x, y: p.y - 40, life: 28, maxLife: 28, color: p.color });
        }
      }
      break;
    }

    // 칭기즈칸 — 초원의 기마 돌격 (빠르게 한 번 짓밟고, 방향을 틀어 다시 한 번 짓밟는다)
    case 'rider_khan':
      if (frame === 0) gameState.effects.push({ type: 'ult_charge', x: p.x, y: p.y - 30, life: 25, maxLife: 25, color: p.color });
      if (frame === 25) {
        p.x = clampX(p.x + f * 220);
        if (meleeHit(p, enemy, 160, 70)) { applyDamage(p, enemy, D(p, 16)); applyStun(enemy, 20); }
        gameState.effects.push({ type: 'khan_charge', x: p.x, y: p.y, life: 22, maxLife: 22, color: p.color, extra: f });
      }
      if (frame === 65) p.facing = -p.facing;
      if (frame === 100) {
        p.x = clampX(p.x + p.facing * 220);
        if (meleeHit(p, enemy, 160, 70)) applyDamage(p, enemy, D(p, 20));
        gameState.effects.push({ type: 'khan_charge', x: p.x, y: p.y, life: 22, maxLife: 22, color: p.color, extra: p.facing });
      }
      if (frame === 122) gameState.effects.push({ type: 'ultimate', x: p.x, y: p.y - 30, life: 22, maxLife: 22, color: p.color });
      if (frame === total - 4 && enemy) p.facing = enemy.x >= p.x ? 1 : -1;
      break;

    // 핫토리 한조 — 그림자 분신 난도질 (좌우로 순간이동하며 세 번 베어낸다)
    case 'assassin_hanzo':
      if (frame === 0) { p.invincible = 20; gameState.effects.push({ type: 'shadow_clone', x: p.x, y: p.y - 40, life: 16, maxLife: 16, color: p.color }); }
      if (frame === 46 && enemy) {
        p.x = clampX(enemy.x - enemy.facing * 40); p.facing = enemy.x >= p.x ? 1 : -1;
        if (meleeHit(p, enemy, 80, 60)) applyDamage(p, enemy, D(p, 14));
        gameState.effects.push({ type: 'shadow_clone', x: p.x, y: p.y - 40, life: 16, maxLife: 16, color: p.color });
      }
      if (frame === 66 && enemy) {
        p.x = clampX(enemy.x + enemy.facing * 40); p.facing = enemy.x >= p.x ? 1 : -1;
        if (meleeHit(p, enemy, 80, 60)) applyDamage(p, enemy, D(p, 14));
        gameState.effects.push({ type: 'shadow_clone', x: p.x, y: p.y - 40, life: 16, maxLife: 16, color: p.color });
      }
      if (frame === 86 && enemy) {
        p.x = clampX(enemy.x - p.facing * 34);
        if (meleeHit(p, enemy, 78, 60)) { applyDamage(p, enemy, D(p, 18)); applyStun(enemy, 30); }
        gameState.effects.push({ type: 'ultimate', x: enemy.x, y: p.y - 40, life: 22, maxLife: 22, color: p.color });
      }
      break;

    // 형가 — 필살의 일격 (지도 속에 숨긴 비수, 오래 숨죽인 뒤 단 한 번의 암살)
    case 'assassin_jingke':
      if (frame === 0) { p.invincible = 20; gameState.effects.push({ type: 'jingke_scroll', x: p.x, y: p.y - 30, life: 100, maxLife: 100, color: p.color }); }
      if (frame === 100 && enemy) {
        if (Math.abs(p.x - enemy.x) < 340) p.x = clampX(enemy.x - enemy.facing * 30);
        if (meleeHit(p, enemy, 82, 70)) {
          const bonus = enemy.hp <= enemy.maxHp * 0.35 ? 20 : 0;
          applyDamage(p, enemy, D(p, 30) + bonus);
          gameState.effects.push({ type: 'assassinate', x: enemy.x, y: enemy.y - 40, life: 22, maxLife: 22, color: p.color });
        }
      }
      break;
  }
}

// ─── 투사체 연산 ────────────────────────────────────────────────────────────
function updateProjectiles() {
  const mw = mapWidth();
  const floorY = gameState.map ? gameState.map.floorY : FLOOR_Y;

  for (let i = gameState.projectiles.length - 1; i >= 0; i--) {
    const proj = gameState.projectiles[i];

    if (proj.spawnDelay > 0) {
      proj.spawnDelay--;
      if (proj.spawnDelay === 0 && proj.launchEffect) {
        gameState.effects.push({ type: 'sword_launch', x: proj.x, y: proj.y, life: 22, maxLife: 22, extra: proj.facing || 1 });
      }
      continue;
    }

    proj.framesAlive = (proj.framesAlive || 0) + 1;

    if (proj.homing) {
      const enemy = gameState.players.find(pl => pl.index !== proj.index);
      if (enemy) {
        const dy = (enemy.y - 40) - proj.y;
        proj.vy += Math.max(-0.35, Math.min(0.35, dy * 0.01));
      }
    }

    // 부메랑: 일정 시간 뒤 진행 방향을 반전시켜 던진 사람 쪽으로 되돌아온다.
    if (proj.boomerang) {
      proj.boomFrames = (proj.boomFrames || 0) + 1;
      if (!proj.returning && proj.boomFrames >= (proj.boomOut || 24)) {
        proj.returning = true;
        proj.vx = -proj.vx;
      }
    }
    // 곡사(S자) 궤도: 사인파를 그리며 상하로 흔들린다.
    if (proj.wave) {
      proj.waveT = (proj.waveT || 0) + 1;
      proj.vy = Math.sin(proj.waveT * (proj.waveFreq || 0.22)) * (proj.waveAmp || 3.5);
    }
    // 중력 투사체(포물선 사격): 시간이 지날수록 아래로 떨어진다.
    if (proj.gravity) proj.vy = (proj.vy || 0) + proj.gravity;

    proj.x += proj.vx;
    proj.y += proj.vy;

    const enemy = gameState.players.find(p => p.index !== proj.index);
    const attacker = gameState.players.find(p => p.index === proj.index);
    let hit = false;

    if (enemy && enemy.action !== 'dead' && !proj.hitOnce) {
      const hitX = Math.abs(proj.x - enemy.x) < PLAYER_W * PROJECTILE_HIT_RATIO;
      const hitY = proj.y >= enemy.y - PLAYER_H && proj.y <= enemy.y;
      if (hitX && hitY && enemy.invincible <= 0) {
        applyDamage(attacker, enemy, proj.damage);
        if (proj.comboStun && enemy.hp > 0) applyStun(enemy, proj.comboStun);
        if (proj.finisher) gameState.hitStop = Math.max(gameState.hitStop, 9);
        if (proj.curse && enemy.hp > 0) {
          applyStun(enemy, 90);
          gameState.effects.push({ type: 'polymorph', x: enemy.x, y: enemy.y - 40, life: 70, maxLife: 70, color: attacker ? attacker.color : '#c86edc' });
        }
        if (proj.poisonDart && enemy.hp > 0) {
          applyPoison(enemy, proj.index, proj.poisonDmg, 4, 26);
          gameState.effects.push({ type: 'poison_hit', x: enemy.x, y: enemy.y - 40, life: 24, maxLife: 24, color: '#5fd45f' });
        }
        if (proj.pierce) proj.hitOnce = true; // 관통: 사라지지 않고 계속 날아간다
        else hit = true;
      }
    }

    // 분열: 절반쯤 날아가면 위/아래로 갈라지는 두 개의 자탄을 생성한다.
    if (!hit && proj.splitAt && proj.framesAlive >= proj.splitAt) {
      gameState.projectiles.push(Object.assign({}, proj, { vy: (proj.vy || 0) - 2.4, splitAt: null, framesAlive: 0, hitOnce: false }));
      gameState.projectiles.push(Object.assign({}, proj, { vy: (proj.vy || 0) + 2.4, splitAt: null, framesAlive: 0, hitOnce: false }));
      gameState.effects.push({ type: 'hit', x: proj.x, y: proj.y, life: 8, maxLife: 8 });
      gameState.projectiles.splice(i, 1);
      continue;
    }

    // 바운스: 바닥에 닿으면 사라지는 대신 튕겨오른다 (남은 횟수만큼).
    if (!hit && proj.bounce && proj.y >= floorY && (proj.bouncesLeft || 0) > 0) {
      proj.y = floorY;
      proj.vy = -Math.abs(proj.vy || 6) * 0.55;
      proj.bouncesLeft--;
      gameState.effects.push({ type: 'hit', x: proj.x, y: floorY - 6, life: 8, maxLife: 8 });
      continue;
    }

    if (proj.y >= floorY || proj.x < 0 || proj.x > mw || hit) {
      gameState.effects.push({ type: 'hit', x: proj.x, y: Math.min(proj.y, floorY - 10), life: 10, maxLife: 10 });
      gameState.projectiles.splice(i, 1);
    }
  }
}

// ─── 장판형 함정 연산 (PH의 카드 함정처럼, 스킬 시전 후에도 일정 시간 남아있는 판정) ──
function updateHazards() {
  for (let i = gameState.hazards.length - 1; i >= 0; i--) {
    const hz = gameState.hazards[i];
    hz.life--;
    if (hz.life <= 0) { gameState.hazards.splice(i, 1); continue; }

    for (const pl of gameState.players) {
      if (!pl || pl.index === hz.ownerIndex || pl.action === 'dead' || pl.invincible > 0) continue;
      if (Math.abs(pl.x - hz.x) < 32 && Math.abs((pl.y - 40) - hz.y) < 48) {
        const owner = gameState.players.find(o => o.index === hz.ownerIndex);
        if (owner) applyDamage(owner, pl, hz.damage);
        gameState.hazards.splice(i, 1);
        break;
      }
    }
  }
}

// ─── 데미지 적용 (타격감: 넉백 + 히트스탑 + 이펙트 + 경직) ───────────────────
function applyDamage(attacker, target, amount) {
  if (!attacker || target.invincible > 0 || target.action === 'dead') return;

  // ─ 가드 판정: 방어 중이면 피해를 대폭 경감하고, 가드를 든 직후(저스트가드 타이밍)
  // 맞으면 피해를 완전히 무효화하며 오히려 공격자를 짧게 경직시킨다(패링).
  if (target.action === 'guard') {
    const justGuard = target.guardTimer <= JUST_GUARD_WINDOW;
    if (justGuard) {
      gameState.effects.push({ type: 'parry', x: target.x, y: target.y - 45, life: 20, maxLife: 20, color: '#8be0ff' });
      gameState.hitStop = Math.max(gameState.hitStop, 10);
      target.ultGauge = Math.min(ULT_GAUGE_MAX, target.ultGauge + 10);
      if (attacker.hp > 0 && attacker.index !== target.index) applyStun(attacker, 26);
      return; // 피해 없음
    }
    amount = Math.round(amount * (1 - GUARD_DMG_REDUCTION));
    target.hp = Math.max(0, target.hp - amount);
    const gdir = target.x >= attacker.x ? 1 : -1;
    target.x = clampX(target.x + gdir * 5); // 가드 중엔 넉백을 살짝만 받는다
    gameState.effects.push({ type: 'guard_block', x: target.x, y: target.y - 45, life: 14, maxLife: 14, color: '#8be0ff' });
    gameState.hitStop = Math.max(gameState.hitStop, 3);
    if (attacker.index !== target.index) attacker.ultGauge = Math.min(ULT_GAUGE_MAX, attacker.ultGauge + Math.round(GAUGE_PER_HIT * 0.4));
    if (target.hp <= 0) target.action = 'dead';
    return;
  }

  if (target.dmgVulnTimer > 0) amount = Math.round(amount * 2); // 옷을 빼앗겨 피해 2배

  target.hp = Math.max(0, target.hp - amount);
  resetCombo(target); // 피격당하면 상대의 평타 콤보는 끊긴다

  const dir = target.x >= attacker.x ? 1 : -1;
  target.x = clampX(target.x + dir * 14);

  // 데미지 비중에 비례해 타격감(이펙트 크기 / 히트스탑)을 자동으로 스케일링한다.
  // 이렇게 하면 개별 스킬이 이펙트를 따로 안 챙겨도 "센 스킬은 세게, 약한 잽은 가볍게"
  // 느껴지고, 평타 콤보 초반 타격들이 과도한 히트스탑으로 답답해지는 것도 완화된다.
  const power = Math.max(0.5, Math.min(1.6, amount / (target.maxHp * 0.14)));
  gameState.effects.push({ type: 'impact', x: target.x, y: target.y - 45, life: 16, maxLife: 16, power });
  gameState.hitStop = Math.max(gameState.hitStop, Math.round(2 + power * 3));

  if (attacker.index !== target.index) {
    attacker.ultGauge = Math.min(ULT_GAUGE_MAX, attacker.ultGauge + GAUGE_PER_HIT);
    // 맞는 쪽도 소량의 게이지를 얻는다("고통 게이지"). 일방적으로 두들겨 맞는 쪽이
    // 아무 보상도 없이 계속 손해만 보는 걸 완화해서, 역전의 여지를 조금이라도 남겨준다.
    target.ultGauge = Math.min(ULT_GAUGE_MAX, target.ultGauge + PAIN_GAUGE_PER_HIT);
  }

  if (target.hp <= 0) {
    target.action = 'dead';
  } else if (target.action !== 'stunned') {
    target.action = 'hurt';
    target.actionTimer = 16;
  }
}

// ─── 이펙트 관리 ────────────────────────────────────────────────────────────
function updateEffects() {
  for (let i = gameState.effects.length - 1; i >= 0; i--) {
    const fx = gameState.effects[i];
    fx.life--;
    if (fx.life <= 0) gameState.effects.splice(i, 1);
  }
}

// ─── 게임 종료 확인 ─────────────────────────────────────────────────────────
function checkGameOver() {
  if (gameState.players.length < 2) return;
  const p0Dead = gameState.players[0].hp <= 0;
  const p1Dead = gameState.players[1].hp <= 0;

  if (p0Dead || p1Dead) {
    gameState.phase = 'game_over';
    gameState.winner = p0Dead && p1Dead ? null : p0Dead ? 1 : 0;

    setTimeout(() => {
      if (gameState.phase === 'game_over') {
        if (sockets[0] && sockets[1]) resetForNewMatch();
        else gameState = createInitialState();
      }
    }, 5000);
  }
}

// ─── 서버 실행 ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
