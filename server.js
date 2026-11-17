// Mini r/place — serveur
// Lancer : npm install && npm start  → http://localhost:3000

const express = require("express");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const db = require("./db");

// ---- Réglages ----
const PORT = process.env.PORT || 3000;
const WIDTH = 500;
const HEIGHT = 500;
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 5000); // délai entre deux pixels

// 16 couleurs (index 0..15)
const PALETTE = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222",
  "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD",
  "#0083C7", "#0000EA", "#CF6EE4", "#820080",
];

// ---- Grille en mémoire, rechargée depuis la base au démarrage ----
const grid = Buffer.alloc(WIDTH * HEIGHT, 0);
for (const p of db.allCanvas()) {
  if (p.x < WIDTH && p.y < HEIGHT) grid[p.y * WIDTH + p.x] = p.color;
}

// ---- HTTP ----
const app = express();
app.use(express.static(path.join(__dirname, "public")));
// index.html peut être dans "public/" ou directement à côté de server.js
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/config", (req, res) =>
  res.json({ width: WIDTH, height: HEIGHT, cooldown: COOLDOWN_MS, palette: PALETTE })
);

// Qui a posé ce pixel ?
app.get("/pixel", (req, res) => {
  const x = Number(req.query.x), y = Number(req.query.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ error: "coordonnées invalides" });
  const p = db.getPixel(x, y);
  if (!p) return res.json({ x, y, empty: true });
  res.json({ x, y, color: p.color, user: p.user, placedAt: p.placed_at, userTotal: db.pixelsByUser(p.user) });
});

app.get("/stats", (req, res) => res.json(db.stats()));

const server = http.createServer(app);

// ---- WebSocket ----
const wss = new WebSocketServer({ server });
const lastPlaced = new Map(); // ip -> timestamp

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? fwd.split(",")[0] : req.socket.remoteAddress).trim();
}

function cleanName(name) {
  const s = String(name || "").trim().replace(/[^\p{L}\p{N}_\-. ]/gu, "").slice(0, 20);
  return s.length >= 2 ? s : null;
}

function broadcast(data) {
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function broadcastOnline() {
  broadcast(JSON.stringify({ type: "online", count: wss.clients.size }));
}

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);

  ws.send(grid); // grille complète en binaire
  const wait = Math.max(0, (lastPlaced.get(ip) || 0) + COOLDOWN_MS - Date.now());
  ws.send(JSON.stringify({ type: "cooldown", wait }));
  broadcastOnline();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== "place") return;

    const x = msg.x | 0, y = msg.y | 0, c = msg.c | 0;
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT || c < 0 || c >= PALETTE.length) return;

    const user = cleanName(msg.user);
    if (!user) {
      ws.send(JSON.stringify({ type: "error", message: "Choisis un pseudo (2 caractères minimum)" }));
      return;
    }

    const now = Date.now();
    const last = lastPlaced.get(ip) || 0;
    if (now - last < COOLDOWN_MS) {
      ws.send(JSON.stringify({ type: "cooldown", wait: last + COOLDOWN_MS - now }));
      return;
    }

    lastPlaced.set(ip, now);
    grid[y * WIDTH + x] = c;
    db.placePixel(x, y, c, user, ip, now);

    broadcast(JSON.stringify({ type: "pixel", x, y, c, user, t: now }));
    ws.send(JSON.stringify({ type: "cooldown", wait: COOLDOWN_MS }));
  });

  ws.on("close", broadcastOnline);
});

server.listen(PORT, () => console.log(`Mini r/place sur http://localhost:${PORT}`));
