'use strict';
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const fs        = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

// Serve sw.js with the deploy timestamp injected so every new deploy busts the cache automatically
const DEPLOY_VERSION = Date.now().toString();
const swTemplate = fs.readFileSync(path.join(__dirname, 'public', 'sw.js'), 'utf8');
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(swTemplate.replace('__DEPLOY_VERSION__', DEPLOY_VERSION));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, waiting: waitingPlayer ? 1 : 0 });
});

// ─── Game state ───────────────────────────────────────────────────────────────
const rooms          = new Map();
let   waitingPlayer  = null;

function logResult(winnerWs, loserWs) {
  const winnerName = winnerWs?.playerName || 'Unknown';
  const loserName  = loserWs?.playerName  || 'Unknown';
  console.log(`Result: ${winnerName} beat ${loserName}`);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.id      = uuidv4();
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Matchmaking ──────────────────────────────────────────────────────────
      case 'JOIN': {
        ws.playerName = msg.name || 'Anonymous';

        if (waitingPlayer && waitingPlayer !== ws && waitingPlayer.readyState === WebSocket.OPEN) {
          const roomId = uuidv4();
          const p1 = waitingPlayer;
          const p2 = ws;
          p1.roomId = roomId;
          p2.roomId = roomId;
          const firstPlayer = Math.random() < 0.5 ? 1 : 2;

          rooms.set(roomId, { p1, p2, p1Name: p1.playerName, p2Name: p2.playerName, resultRecorded: false });
          waitingPlayer = null;

          send(p1, { type: 'GAME_START', roomId, yourRole: 'p1', opponentName: p2.playerName, firstPlayer });
          send(p2, { type: 'GAME_START', roomId, yourRole: 'p2', opponentName: p1.playerName, firstPlayer });
          console.log(`Room ${roomId.slice(0, 8)}: ${p1.playerName} vs ${p2.playerName}`);
        } else {
          waitingPlayer = ws;
          send(ws, { type: 'WAITING', message: 'Looking for an opponent...' });
          console.log(`${ws.playerName} is waiting`);
        }
        break;
      }

      // ── Game actions ─────────────────────────────────────────────────────────
      case 'PLAY_CARD':
      case 'ATTACK':
      case 'END_TURN':
      case 'DRAW_CARD':
      case 'ZONE_REPLACE':
      case 'GAME_ACTION': {
        const opponent = getOpponent(ws);
        if (opponent) send(opponent, { ...msg, fromOpponent: true });
        break;
      }

      case 'CHAT': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const chatMsg = { type: 'CHAT', from: ws.playerName, text: String(msg.text).slice(0, 300), timestamp: Date.now() };
        const chatOpponent = room.p1 === ws ? room.p2 : room.p1;
        send(chatOpponent, chatMsg);
        break;
      }

      case 'GAME_OVER': {
        const room = rooms.get(ws.roomId);
        if (!room || room.resultRecorded) break;
        room.resultRecorded = true;

        const winnerWs = msg.winner === 'p1' ? room.p1 : room.p2;
        const loserWs  = msg.winner === 'p1' ? room.p2 : room.p1;
        logResult(winnerWs, loserWs);

        send(room.p1, { type: 'GAME_OVER', winner: msg.winner, winnerName: room.p1Name, loserName: room.p2Name });
        send(room.p2, { type: 'GAME_OVER', winner: msg.winner, winnerName: room.p1Name, loserName: room.p2Name });
        console.log(`Game over: ${room.p1Name} vs ${room.p2Name}, winner=${msg.winner}`);
        break;
      }

      case 'REMATCH_REQUEST': {
        const opponent = getOpponent(ws);
        if (opponent) send(opponent, { type: 'REMATCH_REQUEST', from: ws.playerName });
        break;
      }

      case 'REMATCH_ACCEPT': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        room.resultRecorded = false;
        const firstPlayer   = Math.random() < 0.5 ? 1 : 2;
        send(room.p1, { type: 'REMATCH_START', yourRole: 'p1', firstPlayer });
        send(room.p2, { type: 'REMATCH_START', yourRole: 'p2', firstPlayer });
        break;
      }

      case 'REMATCH_DECLINE': {
        const opponent = getOpponent(ws);
        if (opponent) send(opponent, { type: 'REMATCH_DECLINE' });
        rooms.delete(ws.roomId);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (waitingPlayer === ws) {
      waitingPlayer = null;
      console.log(`${ws.playerName} left the queue`);
    }

    const opponent = getOpponent(ws);
    if (opponent) {
      send(opponent, { type: 'OPPONENT_DISCONNECTED', message: `${ws.playerName} disconnected.` });
      const roomOnClose = rooms.get(ws.roomId);
      if (roomOnClose && !roomOnClose.resultRecorded) {
        roomOnClose.resultRecorded = true;
        logResult(opponent, ws);
      }
    }
    if (ws.roomId) rooms.delete(ws.roomId);
  });

  ws.on('error', (err) => {
    console.error(`WS error [${ws.playerName || ws.id}]:`, err.message);
  });
});

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getOpponent(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return null;
  return room.p1 === ws ? room.p2 : room.p1;
}

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Aqua Realms server running on port ${PORT}`);
});
