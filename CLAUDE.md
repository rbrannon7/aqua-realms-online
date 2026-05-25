# Aqua Realms Online — Claude Code Instructions

## Project Overview
Browser-based online card game. Node.js + Express + WebSocket server (`server.js`), single-page frontend (`public/index.html`, ~5,700 lines). Deployed on Render with auto-deploy from GitHub.

## Stack
- **Runtime:** Node.js (CommonJS)
- **Server:** Express 5 + `ws` WebSocket library
- **Database:** `better-sqlite3` — SQLite at `./data/aqua-realms.db` (local) or `/data/aqua-realms.db` (Render)
- **Auth:** `bcryptjs` (password hashing) + `jsonwebtoken` (30-day JWTs, stored in `localStorage` as `arAuthToken`)
- **Deployment:** Render — persistent disk mounted at `/data`, `JWT_SECRET` set as env var

## Architecture Notes
- `arLobbyWs` and `arWs` are **separate** WebSocket connections — lobby presence vs. active game
- Challenge games transfer `arLobbyWs` → `arWs`; `_pendingChallenge` stores the GAME_START msg until deck is built
- `_arPendingJoin`: AUTH sent first on game WS; JOIN sent only after `AUTH_OK` to ensure server associates user before matchmaking
- `window.setPhase`, `window.arEnableMyTurn`, `window.arDisableMyTurn`, `window.arShowResult` are overridden in the auth/lobby JS block to hook into game events without editing the core game code

## After Every Code Change
Always prompt the user to commit and push to GitHub — don't wait for them to ask.

## Style Preferences
- Minimal comments — only when the WHY is non-obvious
- No unnecessary abstractions or future-proofing
- No trailing summaries in responses — keep it concise
