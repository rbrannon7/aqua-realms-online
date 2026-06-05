'use strict';
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const fs        = require('fs');
const Database  = require('better-sqlite3');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT       = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'aqua-realms-dev-secret-changeme-in-production';
const JWT_EXPIRY = '30d';

// ─── Database ─────────────────────────────────────────────────────────────────
// On Render, use the mounted persistent disk at /data; locally use ./data
const DB_DIR = process.env.RENDER ? '/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'aqua-realms.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    email          TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password_hash  TEXT    NOT NULL,
    created_at     TEXT    DEFAULT (datetime('now')),
    wins           INTEGER DEFAULT 0,
    losses         INTEGER DEFAULT 0,
    games_played   INTEGER DEFAULT 0,
    win_streak     INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    last_seen      TEXT
  );
  CREATE TABLE IF NOT EXISTS game_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER REFERENCES users(id),
    opponent_username TEXT,
    result            TEXT CHECK(result IN ('win','loss')),
    played_at         TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS match_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id         TEXT    UNIQUE NOT NULL,
    p1_id            INTEGER REFERENCES users(id),
    p2_id            INTEGER REFERENCES users(id),
    winner_id        INTEGER REFERENCES users(id),
    loser_id         INTEGER REFERENCES users(id),
    p1_rating_before INTEGER DEFAULT 1000,
    p2_rating_before INTEGER DEFAULT 1000,
    p1_rating_after  INTEGER DEFAULT 1000,
    p2_rating_after  INTEGER DEFAULT 1000,
    played_at        TEXT    DEFAULT (datetime('now')),
    is_ranked        INTEGER DEFAULT 1
  );
`);
// Migrate existing databases
try { db.exec('ALTER TABLE users ADD COLUMN rating INTEGER DEFAULT 1000'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN saved_deck TEXT'); } catch {}

// ─── Splash visit counter (flat file — avoids SQLite migration issues) ────────
const COUNTER_FILE = path.join(DB_DIR, 'splash-visits.txt');
const VISIT_SEED = 20;
function readVisitCount() {
  try { return Math.max(VISIT_SEED, parseInt(fs.readFileSync(COUNTER_FILE, 'utf8'), 10) || 0); } catch { return VISIT_SEED; }
}
function writeVisitCount(n) {
  try { fs.writeFileSync(COUNTER_FILE, String(n)); } catch {}
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function verifyToken(req) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  try { return jwt.verify(h.slice(7), JWT_SECRET); } catch { return null; }
}

// ─── Auth endpoints ───────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username: 3–20 chars, letters/numbers/_/-' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash   = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'
    ).run(username, email.toLowerCase(), hash);

    const user  = db.prepare(
      'SELECT id, username, email, wins, losses, games_played, win_streak, longest_streak, rating FROM users WHERE id = ?'
    ).get(result.lastInsertRowid);
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, user });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
      return res.status(409).json({ error: emailExists ? 'Email already in use' : 'Username already taken' });
    }
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password)
    return res.status(400).json({ error: 'All fields required' });

  const user = db.prepare(
    'SELECT * FROM users WHERE email = ? OR username = ?'
  ).get(identifier.toLowerCase(), identifier);

  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });

  db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(user.id);
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  const { password_hash, ...userData } = user;
  res.json({ token, user: userData });
});

app.get('/api/auth/me', (req, res) => {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare(
    'SELECT id, username, email, wins, losses, games_played, win_streak, longest_streak, rating, created_at FROM users WHERE id = ?'
  ).get(payload.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// ─── Leaderboard & stats ──────────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT username, rating, wins, losses, games_played, longest_streak,
           CASE WHEN games_played > 0 THEN ROUND(wins * 100.0 / games_played) ELSE 0 END AS win_rate
    FROM users
    WHERE games_played >= 10
    ORDER BY rating DESC,
             ROUND(wins * 100.0 / games_played) DESC,
             wins DESC,
             games_played DESC
    LIMIT 20
  `).all();
  res.json(rows);
});

app.get('/api/stats/:username', (req, res) => {
  const user = db.prepare(`
    SELECT username, rating, wins, losses, games_played, win_streak, longest_streak, created_at,
           CASE WHEN games_played > 0 THEN ROUND(wins * 100.0 / games_played) ELSE 0 END AS win_rate,
           CASE WHEN games_played < 10 THEN 1 ELSE 0 END AS provisional,
           CASE WHEN games_played < 10 THEN (10 - games_played) ELSE 0 END AS games_until_ranked
    FROM users WHERE username = ?
  `).get(req.params.username);
  if (!user) return res.status(404).json({ error: 'Player not found' });

  let rank = null;
  if (!user.provisional) {
    const rankRow = db.prepare(`
      SELECT COUNT(*) + 1 AS rank FROM users
      WHERE games_played >= 10 AND (
        rating > ? OR
        (rating = ? AND ROUND(wins * 100.0 / games_played) > ?) OR
        (rating = ? AND ROUND(wins * 100.0 / games_played) = ? AND wins > ?) OR
        (rating = ? AND ROUND(wins * 100.0 / games_played) = ? AND wins = ? AND games_played > ?)
      )
    `).get(user.rating,
           user.rating, user.win_rate,
           user.rating, user.win_rate, user.wins,
           user.rating, user.win_rate, user.wins, user.games_played);
    rank = rankRow?.rank ?? null;
  }

  res.json({ ...user, rank });
});

app.get('/api/saved-deck', (req, res) => {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT saved_deck FROM users WHERE id = ?').get(payload.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ deck: user.saved_deck ? JSON.parse(user.saved_deck) : null });
});

app.post('/api/saved-deck', (req, res) => {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  const { deck } = req.body || {};
  if (!Array.isArray(deck) || deck.length !== 20)
    return res.status(400).json({ error: 'Deck must be exactly 20 cards' });
  db.prepare('UPDATE users SET saved_deck = ? WHERE id = ?').run(JSON.stringify(deck), payload.userId);
  res.json({ ok: true });
});

app.post('/api/splash-visit', (req, res) => {
  const n = readVisitCount() + 1;
  writeVisitCount(n);
  res.json({ count: n });
});

app.get('/api/splash-visit', (req, res) => {
  res.json({ count: readVisitCount() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, waiting: waitingPlayer ? 1 : 0, lobby: lobbyPlayers.size });
});

// ─── Game state ───────────────────────────────────────────────────────────────
const rooms          = new Map();
let   waitingPlayer  = null;
const lobbyPlayers   = new Map();      // username → ws
const pendingChallenges = new Map();   // challengerUsername → { targetUsername, targetWs, timer }

function broadcastLobbyState() {
  const players = [];
  lobbyPlayers.forEach((ws, username) => {
    players.push({ username, status: ws.lobbyStatus || 'lobby' });
  });
  const msg = JSON.stringify({ type: 'LOBBY_STATE', players });
  lobbyPlayers.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function recordResult(winnerWs, loserWs) {
  const winnerName = winnerWs?.playerName || 'Unknown';
  const loserName  = loserWs?.playerName  || 'Unknown';

  if (winnerWs?.authUserId && loserWs?.authUserId) {
    // Both logged in — rated match with Elo
    const winner = db.prepare('SELECT rating, games_played, win_streak FROM users WHERE id = ?').get(winnerWs.authUserId);
    const loser  = db.prepare('SELECT rating, games_played, win_streak FROM users WHERE id = ?').get(loserWs.authUserId);

    // Farming protection: max 5 ranked matches per day between the same two players
    const todayCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM match_history
      WHERE is_ranked = 1 AND date(played_at) = date('now')
        AND ((p1_id = ? AND p2_id = ?) OR (p1_id = ? AND p2_id = ?))
    `).get(winnerWs.authUserId, loserWs.authUserId, loserWs.authUserId, winnerWs.authUserId).cnt;

    const isRanked = todayCount < 5;

    const winnerRatingBefore = winner.rating ?? 1000;
    const loserRatingBefore  = loser.rating  ?? 1000;
    let   winnerRatingAfter  = winnerRatingBefore;
    let   loserRatingAfter   = loserRatingBefore;

    if (isRanked) {
      const winnerK   = winner.games_played < 10 ? 40 : 24;
      const loserK    = loser.games_played  < 10 ? 40 : 24;
      const winnerExp = 1 / (1 + Math.pow(10, (loserRatingBefore - winnerRatingBefore) / 400));
      winnerRatingAfter = Math.round(winnerRatingBefore + winnerK * (1 - winnerExp));
      loserRatingAfter  = Math.round(loserRatingBefore  + loserK  * (0 - (1 - winnerExp)));
    }

    const newStreak = (winner.win_streak ?? 0) + 1;
    db.prepare(`UPDATE users SET wins = wins + 1, games_played = games_played + 1,
      win_streak = ?, longest_streak = MAX(longest_streak, ?), rating = ? WHERE id = ?`)
      .run(newStreak, newStreak, winnerRatingAfter, winnerWs.authUserId);

    db.prepare(`UPDATE users SET losses = losses + 1, games_played = games_played + 1,
      win_streak = 0, rating = ? WHERE id = ?`)
      .run(loserRatingAfter, loserWs.authUserId);

    db.prepare(`INSERT INTO match_history
      (match_id, p1_id, p2_id, winner_id, loser_id, p1_rating_before, p2_rating_before, p1_rating_after, p2_rating_after, is_ranked)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(uuidv4(), winnerWs.authUserId, loserWs.authUserId,
           winnerWs.authUserId, loserWs.authUserId,
           winnerRatingBefore, loserRatingBefore, winnerRatingAfter, loserRatingAfter,
           isRanked ? 1 : 0);

    console.log(`Result: ${winnerName} (${winnerRatingBefore}→${winnerRatingAfter}) beat ${loserName} (${loserRatingBefore}→${loserRatingAfter})${isRanked ? '' : ' [unranked]'}`);
  } else {
    // At least one guest — update basic stats only, no rating change
    if (winnerWs?.authUserId) {
      const cur = db.prepare('SELECT win_streak FROM users WHERE id = ?').get(winnerWs.authUserId);
      const newStreak = (cur?.win_streak ?? 0) + 1;
      db.prepare(`UPDATE users SET wins = wins + 1, games_played = games_played + 1,
        win_streak = ?, longest_streak = MAX(longest_streak, ?) WHERE id = ?`)
        .run(newStreak, newStreak, winnerWs.authUserId);
    }
    if (loserWs?.authUserId) {
      db.prepare('UPDATE users SET losses = losses + 1, games_played = games_played + 1, win_streak = 0 WHERE id = ?')
        .run(loserWs.authUserId);
    }
    console.log(`Result: ${winnerName} beat ${loserName} (unrated — guest player)`);
  }

  if (winnerWs?.authUserId)
    db.prepare('INSERT INTO game_history (user_id, opponent_username, result) VALUES (?,?,?)').run(winnerWs.authUserId, loserName, 'win');
  if (loserWs?.authUserId)
    db.prepare('INSERT INTO game_history (user_id, opponent_username, result) VALUES (?,?,?)').run(loserWs.authUserId, winnerName, 'loss');
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

      // ── Auth ────────────────────────────────────────────────────────────────
      case 'AUTH': {
        try {
          const payload = jwt.verify(msg.token, JWT_SECRET);
          const user    = db.prepare(
            'SELECT id, username, wins, losses, games_played, rating FROM users WHERE id = ?'
          ).get(payload.userId);
          if (!user) { send(ws, { type: 'AUTH_ERROR', error: 'User not found' }); break; }
          ws.authUserId   = user.id;
          ws.authUsername = user.username;
          ws.playerName   = user.username;
          db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(user.id);
          send(ws, { type: 'AUTH_OK', user });
        } catch {
          send(ws, { type: 'AUTH_ERROR', error: 'Invalid token' });
        }
        break;
      }

      // ── Lobby ────────────────────────────────────────────────────────────────
      case 'LOBBY_ENTER': {
        if (!ws.authUsername) { send(ws, { type: 'ERROR', error: 'Must authenticate first' }); break; }
        ws.lobbyStatus = 'lobby';
        lobbyPlayers.set(ws.authUsername, ws);
        broadcastLobbyState();
        break;
      }

      case 'LOBBY_LEAVE': {
        if (ws.authUsername) {
          lobbyPlayers.delete(ws.authUsername);
          broadcastLobbyState();
        }
        break;
      }

      // ── Matchmaking ──────────────────────────────────────────────────────────
      case 'JOIN': {
        ws.playerName = msg.name || ws.authUsername || 'Anonymous';

        if (ws.authUsername && lobbyPlayers.has(ws.authUsername)) {
          ws.lobbyStatus = 'queued';
          broadcastLobbyState();
        }

        if (waitingPlayer && waitingPlayer !== ws && waitingPlayer.readyState === WebSocket.OPEN) {
          const roomId = uuidv4();
          const p1 = waitingPlayer;
          const p2 = ws;
          p1.roomId = roomId;
          p2.roomId = roomId;
          const firstPlayer = Math.random() < 0.5 ? 1 : 2;

          rooms.set(roomId, { p1, p2, p1Name: p1.playerName, p2Name: p2.playerName, resultRecorded: false });
          waitingPlayer = null;

          if (p1.authUsername) { p1.lobbyStatus = 'in_game'; }
          if (p2.authUsername) { p2.lobbyStatus = 'in_game'; }
          broadcastLobbyState();

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

      // ── Challenge ────────────────────────────────────────────────────────────
      case 'CHALLENGE': {
        if (!ws.authUsername) { send(ws, { type: 'ERROR', error: 'Must be authenticated' }); break; }
        const targetWs = lobbyPlayers.get(msg.targetUsername);
        if (!targetWs || targetWs.readyState !== WebSocket.OPEN || targetWs.lobbyStatus !== 'lobby') {
          send(ws, { type: 'CHALLENGE_RESULT', accepted: false, reason: 'Player is not available' });
          break;
        }
        if (pendingChallenges.has(ws.authUsername)) {
          clearTimeout(pendingChallenges.get(ws.authUsername).timer);
        }
        const timer = setTimeout(() => {
          if (pendingChallenges.has(ws.authUsername)) {
            pendingChallenges.delete(ws.authUsername);
            send(ws, { type: 'CHALLENGE_RESULT', accepted: false, reason: 'Challenge timed out' });
          }
        }, 30000);
        pendingChallenges.set(ws.authUsername, { targetUsername: msg.targetUsername, targetWs, timer });
        send(targetWs, { type: 'CHALLENGE_RECEIVED', fromUsername: ws.authUsername });
        break;
      }

      case 'CHALLENGE_RESPONSE': {
        if (!ws.authUsername) break;
        let challengerUsername = null;
        let challengeData      = null;
        for (const [cUser, cData] of pendingChallenges.entries()) {
          if (cData.targetUsername === ws.authUsername) {
            challengerUsername = cUser;
            challengeData      = cData;
            break;
          }
        }
        if (!challengerUsername) { send(ws, { type: 'ERROR', error: 'No pending challenge' }); break; }

        clearTimeout(challengeData.timer);
        pendingChallenges.delete(challengerUsername);

        const challengerWs = lobbyPlayers.get(challengerUsername);

        if (!msg.accepted) {
          if (challengerWs) send(challengerWs, { type: 'CHALLENGE_RESULT', accepted: false, reason: `${ws.authUsername} declined` });
          break;
        }
        if (!challengerWs || challengerWs.readyState !== WebSocket.OPEN) {
          send(ws, { type: 'ERROR', error: 'Challenger disconnected' });
          break;
        }

        const roomId      = uuidv4();
        challengerWs.roomId = roomId;
        ws.roomId           = roomId;
        const firstPlayer   = Math.random() < 0.5 ? 1 : 2;

        rooms.set(roomId, {
          p1: challengerWs, p2: ws,
          p1Name: challengerWs.playerName, p2Name: ws.playerName,
          resultRecorded: false,
        });
        challengerWs.lobbyStatus = 'in_game';
        ws.lobbyStatus           = 'in_game';
        broadcastLobbyState();

        send(challengerWs, { type: 'GAME_START', roomId, yourRole: 'p1', opponentName: ws.playerName, firstPlayer });
        send(ws,           { type: 'GAME_START', roomId, yourRole: 'p2', opponentName: challengerWs.playerName, firstPlayer });
        console.log(`Challenge game: ${challengerWs.playerName} vs ${ws.playerName}`);
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
        recordResult(winnerWs, loserWs);

        send(room.p1, { type: 'GAME_OVER', winner: msg.winner, winnerName: room.p1Name, loserName: room.p2Name });
        send(room.p2, { type: 'GAME_OVER', winner: msg.winner, winnerName: room.p1Name, loserName: room.p2Name });

        // Keep room alive for potential rematch; return players to lobby state
        [room.p1, room.p2].forEach(p => {
          if (p.authUsername && lobbyPlayers.has(p.authUsername)) p.lobbyStatus = 'lobby';
        });
        broadcastLobbyState();
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
        [room.p1, room.p2].forEach(p => {
          if (p.authUsername && lobbyPlayers.has(p.authUsername)) p.lobbyStatus = 'in_game';
        });
        broadcastLobbyState();
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

    if (ws.authUsername) {
      lobbyPlayers.delete(ws.authUsername);
      // Cancel challenges from this player
      if (pendingChallenges.has(ws.authUsername)) {
        clearTimeout(pendingChallenges.get(ws.authUsername).timer);
        pendingChallenges.delete(ws.authUsername);
      }
      // Cancel challenges targeting this player
      for (const [k, v] of pendingChallenges.entries()) {
        if (v.targetUsername === ws.authUsername) {
          clearTimeout(v.timer);
          pendingChallenges.delete(k);
          const challenger = lobbyPlayers.get(k);
          if (challenger) send(challenger, { type: 'CHALLENGE_RESULT', accepted: false, reason: 'Player disconnected' });
        }
      }
      broadcastLobbyState();
    }

    const opponent = getOpponent(ws);
    if (opponent) {
      send(opponent, { type: 'OPPONENT_DISCONNECTED', message: `${ws.playerName} disconnected.` });
      const roomOnClose = rooms.get(ws.roomId);
      if (roomOnClose && !roomOnClose.resultRecorded) {
        roomOnClose.resultRecorded = true;
        recordResult(opponent, ws);
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
