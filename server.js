const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const MAX_PLAYERS = 4;

function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeBoard() {
  return shuffle(Array.from({ length: 25 }, (_, i) => i + 1));
}

const LINES = [
  [0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
  [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
  [0,6,12,18,24],[4,8,12,16,20]
];

function countLines(mark) {
  return LINES.filter(l => l.every(i => mark[i])).length;
}

function broadcast(room, msg) {
  room.players.forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  });
}

// 初始化房間遊戲狀態
function initGame(room) {
  room.players.forEach(p => {
    room.boards[p.role] = makeBoard();
    room.marks[p.role]  = Array(25).fill(false);
  });
  room.called   = new Set();
  room.turnIdx  = 0; // 輪到 players[turnIdx]
  room.gameOver = false;
  room.rematch  = new Set();
}

// 送給每個玩家各自視角的 start 訊息
function broadcastStart(room) {
  const roles = room.players.map(p => p.role);
  const names = Object.fromEntries(room.players.map(p => [p.role, p.name]));
  room.players.forEach(p => {
    p.ws.send(JSON.stringify({
      type:    'start',
      role:    p.role,
      myBoard: room.boards[p.role],
      turn:    room.players[room.turnIdx].role,
      scores:  room.scores,
      roles,
      names,
    }));
  });
}

wss.on('connection', ws => {
  let myRoom = null;
  let myRole = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── join ──────────────────────────────────────────────
    if (msg.type === 'join') {
      const code = msg.code.toUpperCase().trim();
      if (!rooms[code]) {
        rooms[code] = {
          players: [],
          called:  new Set(),
          turnIdx: 0,
          boards:  {},
          marks:   {},
          scores:  {},
          gameOver: false,
          started:  false,
          rematch:  new Set(),
        };
      }
      const room = rooms[code];
      if (room.started) {
        ws.send(JSON.stringify({ type: 'error', msg: '遊戲已開始，無法加入' }));
        return;
      }
      if (room.players.length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', msg: '房間已滿（最多 4 人）' }));
        return;
      }

      myRole = `p${room.players.length + 1}`; // p1, p2, p3, p4
      myRoom = code;
      const defaultName = `P${room.players.length + 1}`;
      room.players.push({ ws, role: myRole, name: defaultName });
      room.scores[myRole] = 0;

      ws.send(JSON.stringify({
        type:     'joined',
        role:     myRole,
        code,
        isHost:   myRole === 'p1',
        players:  room.players.length,
        names:    Object.fromEntries(room.players.map(p => [p.role, p.name])),
      }));

      // 通知其他人有新玩家加入
      broadcast(room, {
        type:    'room_update',
        players: room.players.length,
        roles:   room.players.map(p => p.role),
        names:   Object.fromEntries(room.players.map(p => [p.role, p.name])),
      });
    }

    // ── set_name ──────────────────────────────────────────
    if (msg.type === 'set_name') {
      const room = rooms[myRoom];
      if (!room || room.started) return;
      const name = String(msg.name || '').trim().slice(0, 10) || myRole.toUpperCase();
      const player = room.players.find(p => p.role === myRole);
      if (player) player.name = name;
      broadcast(room, {
        type:  'name_update',
        role:  myRole,
        name,
        names: Object.fromEntries(room.players.map(p => [p.role, p.name])),
      });
    }

    // ── host 按開始 ───────────────────────────────────────
    if (msg.type === 'start_game') {
      const room = rooms[myRoom];
      if (!room || myRole !== 'p1') return;          // 只有房主能開始
      if (room.players.length < 2) {
        ws.send(JSON.stringify({ type: 'error', msg: '至少需要 2 人' }));
        return;
      }
      room.started = true;
      initGame(room);
      broadcastStart(room);
    }

    // ── call ──────────────────────────────────────────────
    if (msg.type === 'call') {
      const room = rooms[myRoom];
      if (!room || room.gameOver) return;
      if (room.players[room.turnIdx].role !== myRole) return; // 不是你的回合
      const num = msg.num;
      if (room.called.has(num)) return;

      room.called.add(num);

      // 更新所有人的 mark
      room.players.forEach(p => {
        const idx = room.boards[p.role].indexOf(num);
        if (idx !== -1) room.marks[p.role][idx] = true;
      });

      // 計算各人連線數
      const lines = {};
      room.players.forEach(p => { lines[p.role] = countLines(room.marks[p.role]); });

      // 勝負判斷：達到 5 條的玩家
      const winners = room.players.filter(p => lines[p.role] >= 5).map(p => p.role);
      let winner = null;
      if (winners.length > 0) {
        room.gameOver = true;
        winner = winners.length === room.players.length ? 'draw' : winners;
        if (winner !== 'draw') {
          winners.forEach(r => { room.scores[r]++; });
        }
      }

      // 輪到下一位
      room.turnIdx = (room.turnIdx + 1) % room.players.length;

      broadcast(room, {
        type:   'update',
        num,
        caller: myRole,
        marks:  room.marks,
        lines,
        turn:   room.players[room.turnIdx].role,
        winner,           // null | 'draw' | ['p1', ...] (得勝角色陣列)
        scores: room.scores,
        names:  Object.fromEntries(room.players.map(p => [p.role, p.name])),
      });
    }

    // ── rematch ───────────────────────────────────────────
    if (msg.type === 'rematch') {
      const room = rooms[myRoom];
      if (!room) return;
      room.rematch.add(myRole);

      if (room.rematch.size === room.players.length) {
        // 所有人同意，重新開局
        initGame(room);
        broadcastStart(room);
      } else {
        broadcast(room, {
          type:    'rematch_waiting',
          ready:   room.rematch.size,
          total:   room.players.length,
        });
      }
    }
  });

  ws.on('close', () => {
    if (!myRoom || !rooms[myRoom]) return;
    const room = rooms[myRoom];
    room.players = room.players.filter(p => p.ws !== ws);
    if (room.players.length === 0) {
      delete rooms[myRoom];
    } else {
      broadcast(room, { type: 'player_left', role: myRole, remaining: room.players.length, names: Object.fromEntries(room.players.map(p => [p.role, p.name])) });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
