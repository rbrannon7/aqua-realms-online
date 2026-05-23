const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;
const LEADERBOARD_PATH = path.join(__dirname, 'data', 'leaderboard.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

function loadLeaderboard() {
  try {
    if (!fs.existsSync(LEADERBOARD_PATH)) return {};
    return JSON.parse(fs.readFileSync(LEADERBOARD_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveLeaderboard(data) {
  try {
    fs.mkdirSync(path.dirname(LEADERBOARD_PATH), { recursive: true });
    fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Leaderboard save error:', err.message);
  }
}

function recordResult(winnerName, loserName) {
  const board = loadLeaderboard();
  [winnerName, loserName].forEach(name => {
    if (!board[name]) board[name] = { name, wins: 0, losses: 0, games: 0 };
  });
  board[winnerName].wins++;
  board[winnerName].games++;
  board[loserName].losses++;
  board[loserName].games++;
  saveLeaderboard(board);
}

app.get('/api/leaderboard', (req, res) => {
  const board = loadLeaderboard();
  const sorted = Object.values(board)
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses)
    .slice(0, 20);
  res.json(sorted);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, waiting: waitingPlayer ? 1 : 0 });
});

const rooms = new Map();
let waitingPlayer = null;

wss.on('connection', (ws) => {
  ws.id = uuidv4();
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {

      case 'JOIN': {
        ws.playerName = msg.name || 'Anonymous';

        if (waitingPlayer && waitingPlayer.readyState === WebSocket.OPEN) {
          const roomId = uuidv4();
          const p1 = waitingPlayer;
          const p2 = ws;

          p1.roomId = roomId;
          p2.roomId = roomId;

          const firstPlayer = Math.random() < 0.5 ? 1 : 2;

          rooms.set(roomId, {
            p1, p2,
            p1Name: p1.playerName,
            p2Name: p2.playerName,
          });

          waitingPlayer = null;

          send(p1, {
            type: 'GAME_START',
            roomId,
            yourRole: 'p1',
            opponentName: p2.playerName,
            firstPlayer,
          });

          send(p2, {
            type: 'GAME_START',
            roomId,
            yourRole: 'p2',
            opponentName: p1.playerName,
            firstPlayer,
          });

          console.log(`Room ${roomId.slice(0, 8)}: ${p1.playerName} vs ${p2.playerName}`);

        } else {
          waitingPlayer = ws;
          send(ws, { type: 'WAITING', message: 'Looking for an opponent...' });
          console.log(`${ws.playerName} is waiting for a match`);
        }
        break;
      }

      case 'PLAY_CARD':
      case 'ATTACK':
      case 'END_TURN':
      case 'DRAW_CARD':
      case 'ZONE_REPLACE':
      case 'GAME_ACTION': {
        const opponent = getOpponent(ws);
        if (opponent) {
          send(opponent, { ...msg, fromOpponent: true });
        }
        break;
      }

      case 'CHAT': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const chatMsg = {
          type: 'CHAT',
          from: ws.playerName,
          text: String(msg.text).slice(0, 300),
          timestamp: Date.now(),
        };
        send(room.p1, chatMsg);
        send(room.p2, chatMsg);
        break;
      }

      case 'GAME_OVER': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const winnerName = msg.winner === 'p1' ? room.p1Name : room.p2Name;
        const loserName  = msg.winner === 'p1' ? room.p2Name : room.p1Name;
        recordResult(winnerName, loserName);
        const result = {
          type: 'GAME_OVER',
          winner: msg.winner,
          winnerName,
          loserName,
        };
        send(room.p1, result);
        send(room.p2, result);
        rooms.delete(ws.roomId);
        console.log(`Game over: ${winnerName} beat ${loserName}`);
        break;
      }

      case 'REMATCH_REQUEST': {
        const opponent = getOpponent(ws);
        if (opponent) {
          send(opponent, { type: 'REMATCH_REQUEST', from: ws.playerName });
        }
        break;
      }

      case 'REMATCH_ACCEPT': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const firstPlayer = Math.random() < 0.5 ? 1 : 2;
        send(room.p1, { type: 'REMATCH_START', yourRole: 'p1', firstPlayer });
        send(room.p2, { type: 'REMATCH_START', yourRole: 'p2', firstPlayer });
        break;
      }

      case 'REMATCH_DECLINE': {
        const opponent = getOpponent(ws);
        if (opponent) {
          send(opponent, { type: 'REMATCH_DECLINE' });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (waitingPlayer === ws) {
      waitingPlayer = null;
      console.log(`${ws.playerName} left the queue`);
      return;
    }
    const opponent = getOpponent(ws);
    if (opponent) {
      send(opponent, {
        type: 'OPPONENT_DISCONNECTED',
        message: `${ws.playerName} disconnected.`,
      });
      recordResult(opponent.playerName, ws.playerName);
    }
    if (ws.roomId) {
      rooms.delete(ws.roomId);
      console.log(`Room ${ws.roomId.slice(0, 8)} closed (disconnect)`);
    }
  });

  ws.on('error', (err) => {
    console.error(`WS error for ${ws.playerName}:`, err.message);
  });
});

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getOpponent(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return null;
  return room.p1 === ws ? room.p2 : room.p1;
}

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Aqua Realms server running on port ${PORT}`);
});