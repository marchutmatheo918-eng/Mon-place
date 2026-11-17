// Mini r/place — serveur
// Lancer : npm install && npm start  → http://localhost:3000
// Modération : définis la variable d'environnement ADMIN_PASSWORD

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { WebSocketServer } = require("ws");
const db = require("./db");

// ---- Version (à augmenter à chaque mise à jour) ----
const VERSION = "0.14";

// ---- Réglages ----
const PORT = process.env.PORT || 3000;
const WIDTH = 500;
const HEIGHT = 500;
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 1000); // délai entre deux pixels (1 s)
const CHAT_COOLDOWN_MS = 1500;                                // délai entre deux messages
const CHAT_MAX_LENGTH = 200;
const CHAT_HISTORY = 50;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";      // vide = modération désactivée

// ---- Sécurité ----
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP || 8);  // onglets ouverts en même temps par adresse IP
const MAX_MSG_BYTES = 4096;                                        // taille max d'un message WebSocket (joueurs)
const MAX_ADMIN_MSG_BYTES = 600000;                                // les modos peuvent envoyer une image (jusqu'à 500×500)
const MAX_IMAGE_PIXELS = 250000;
const MSG_PER_SEC = 25;                                            // messages par seconde avant déconnexion
// Mettre TRUST_CLOUDFLARE=1 sur Railway UNIQUEMENT quand Cloudflare est branché devant le site
const TRUST_CLOUDFLARE = process.env.TRUST_CLOUDFLARE === "1";

// 32 couleurs (celles du vrai r/place 2022). L'index 0 doit rester le blanc (couleur des cases vides).
const PALETTE = [
  "#FFFFFF", "#D4D7D9", "#898D90", "#515252", "#000000", "#6D482F", "#9C6926", "#FFB470",
  "#6D001A", "#BE0039", "#FF4500", "#FFA800", "#FFD635", "#FFF8B8", "#00A368", "#00CC78",
  "#7EED56", "#00756F", "#009EAA", "#00CCC0", "#2450A4", "#3690EA", "#51E9F4", "#493AC1",
  "#6A5CFF", "#94B3FF", "#811E9F", "#B44AC0", "#E4ABFF", "#DE107F", "#FF3881", "#FF99AA",
];
// Ancienne palette (v0.01 à v0.08) : les pixels déjà posés sont convertis une seule fois
const OLD_PALETTE = [
  "#FFFFFF", "#E4E4E4", "#888888", "#222222", "#FFA7D1", "#E50000", "#E59500", "#A06A42",
  "#E5D900", "#94E044", "#02BE01", "#00D3DD", "#0083C7", "#0000EA", "#CF6EE4", "#820080",
];
if (db.migratePalette(OLD_PALETTE, PALETTE, 32)) console.log("Pixels convertis vers la palette de 32 couleurs");

// ---- Grille en mémoire, rechargée depuis la base ----
const grid = Buffer.alloc(WIDTH * HEIGHT, 0);
function reloadGrid() {
  grid.fill(0);
  for (const p of db.allCanvas()) {
    if (p.x < WIDTH && p.y < HEIGHT) grid[p.y * WIDTH + p.x] = p.color;
  }
}
reloadGrid();

// ---- Bans en mémoire ----
let bannedIps = new Set(), bannedNames = new Set();
function reloadBans() {
  bannedIps = new Set(); bannedNames = new Set();
  for (const b of db.allBans()) {
    if (b.kind === "ip") bannedIps.add(b.value);
    else bannedNames.add(b.value.toLowerCase());
  }
}
reloadBans();
// ---- Annonce et événement (gardés dans la base) ----
let announcement = db.getSetting("announcement"); // { id, text, at } ou null
let event = db.getSetting("event");               // { title, start, end, cooldown, lock } ou null
function eventState(now = Date.now()) {
  if (!event) return "none";
  if (now < event.start) return "before";
  if (now > event.end) return "after";
  return "live";
}
function currentCooldown(now = Date.now()) {
  return eventState(now) === "live" && event.cooldown ? event.cooldown : COOLDOWN_MS;
}
// Message d'erreur si la toile est fermée, sinon null
function canvasClosed(now = Date.now()) {
  if (!event || !event.lock) return null;
  const st = eventState(now);
  if (st === "before") return `La toile ouvrira au début de l'événement « ${event.title} »`;
  if (st === "after") return `L'événement « ${event.title} » est terminé : la toile est figée`;
  return null;
}

const isBanned = (ip, name) => bannedIps.has(ip) || (name && bannedNames.has(name.toLowerCase()));

// ---- HTTP ----
const app = express();
app.disable("x-powered-by");

// Limite simple du nombre de requêtes par adresse IP (fenêtre de 10 secondes)
const hits = new Map(); // "règle|ip" -> { n, reset }
function rateLimit(name, max, windowMs = 10000) {
  return (req, res, next) => {
    const key = name + "|" + clientIp(req), now = Date.now();
    let h = hits.get(key);
    if (!h || now > h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    if (++h.n > max) {
      res.set("Retry-After", Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: "Trop de requêtes, réessaie dans quelques secondes" });
    }
    next();
  };
}
app.use(express.static(path.join(__dirname, "public")));
// index.html peut être dans "public/" ou directement à côté de server.js
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/timelapse", (req, res) => res.sendFile(path.join(__dirname, "timelapse.html")));

// Historique complet pour le timelapse (mis en cache 30 secondes, compressé)
let historyCache = { at: 0, raw: null, gz: null };
app.get("/api/history", rateLimit("history", 4, 60000), (req, res) => {
  const now = Date.now();
  if (!historyCache.raw || now - historyCache.at > 30000) {
    const raw = db.historyBinary();
    historyCache = { at: now, raw, gz: zlib.gzipSync(raw, { level: 6 }) };
  }
  res.set("Content-Type", "application/octet-stream");
  res.set("Cache-Control", "public, max-age=30");
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.set("Content-Encoding", "gzip");
    return res.send(historyCache.gz);
  }
  res.send(historyCache.raw);
});

// Classement : ?period=24h ou all, &me=pseudo
app.get("/api/leaderboard", rateLimit("leaderboard", 15), (req, res) => {
  const since = req.query.period === "24h" ? Date.now() - 24 * 3600 * 1000 : 0;
  const me = typeof req.query.me === "string" ? req.query.me.slice(0, 20) : null;
  res.json(db.leaderboard(since, me));
});

app.get("/config", (req, res) =>
  res.json({ version: VERSION, width: WIDTH, height: HEIGHT, cooldown: COOLDOWN_MS, palette: PALETTE, chatMax: CHAT_MAX_LENGTH, modEnabled: !!ADMIN_PASSWORD })
);

app.get("/pixel", rateLimit("pixel", 80), (req, res) => {
  const x = Number(req.query.x), y = Number(req.query.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return res.status(400).json({ error: "coordonnées invalides" });
  const p = db.getPixel(x, y);
  if (!p) return res.json({ x, y, empty: true });
  res.json({ x, y, color: p.color, user: p.user, placedAt: p.placed_at, userTotal: db.pixelsByUser(p.user) });
});

app.get("/stats", rateLimit("stats", 15), (req, res) => res.json(db.stats()));

const server = http.createServer(app);

// ---- WebSocket ----
const wss = new WebSocketServer({ server, maxPayload: MAX_ADMIN_MSG_BYTES });
const connCount = new Map(); // ip -> nombre de connexions ouvertes
const lastPlaced = new Map();   // ip -> timestamp
const lastChat = new Map();     // ip -> timestamp
const authFails = new Map();    // ip -> { n, until }

function clientIp(req) {
  if (TRUST_CLOUDFLARE && req.headers["cf-connecting-ip"]) return String(req.headers["cf-connecting-ip"]).trim();
  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) { const list = String(fwd).split(","); return list[list.length - 1].trim(); }
  return req.socket.remoteAddress;
}

function cleanName(name) {
  const s = String(name || "").trim().replace(/[^\p{L}\p{N}_\-. ]/gu, "").slice(0, 20);
  return s.length >= 2 ? s : null;
}

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
function broadcast(data) {
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
const broadcastJson = (obj) => broadcast(JSON.stringify(obj));
const broadcastOnline = () => broadcastJson({ type: "online", count: wss.clients.size });
const sendBans = (ws) => send(ws, { type: "bans", list: db.allBans() });

function passwordOk(given) {
  if (!ADMIN_PASSWORD) return false;
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Déconnecte proprement les clients bannis (ils peuvent encore regarder)
function notifyBanned() {
  for (const c of wss.clients) {
    if (isBanned(c.ip, c.user)) send(c, { type: "banned" });
  }
}

// ---- Dessin d'image par les modos (tâches qui tournent sur le serveur) ----
const jobs = new Map(); // id -> tâche
let nextJobId = 1;
function jobsSummary() {
  return [...jobs.values()].map(j => ({ id: j.id, label: j.label, done: j.done, total: j.total, speed: j.speed, by: j.by }));
}
function sendJobs() {
  const msg = JSON.stringify({ type: "jobs", list: jobsSummary() });
  for (const c of wss.clients) if (c.isAdmin && c.readyState === 1) c.send(msg);
}
setInterval(() => { if (jobs.size) sendJobs(); }, 1000).unref();

function writeCells(cells, ip) {
  const now = Date.now();
  db.placeBatch(cells, db.MOD_USER, ip, now);
  for (const [x, y, c] of cells) grid[y * WIDTH + x] = c;
  if (cells.length > 300) broadcast(grid);
  else for (const [x, y, c] of cells) broadcastJson({ type: "pixel", x, y, c, user: db.MOD_USER, t: now });
}
function finishJob(job, text) {
  clearInterval(job.timer);
  jobs.delete(job.id);
  db.log("drawImageEnd", { label: job.label, done: job.done, total: job.total }, job.ip);
  for (const c of wss.clients) if (c.isAdmin) send(c, { type: "notice", text });
  sendJobs();
}

// ---- Actions de modération ----
const modActions = {
  deleteChat(ws, m) {
    const id = m.id | 0;
    if (db.deleteChat(id)) {
      broadcastJson({ type: "chatDeleted", id });
      db.log("deleteChat", { id }, ws.ip);
    }
  },

  ban(ws, m) {
    const user = cleanName(m.user);
    if (!user) return send(ws, { type: "notice", text: "Pseudo invalide" });
    const reason = String(m.reason || "").slice(0, 100);
    db.addBan("name", user, user, reason);
    const ips = db.ipsOfUser(user).filter((ip) => ip !== ws.ip); // ne jamais se bannir soi-même
    for (const ip of ips) db.addBan("ip", ip, user, reason);
    reloadBans();
    if (m.deleteChat) {
      db.deleteChatOfUser(user);
      broadcastJson({ type: "chatHistory", msgs: db.recentChat(CHAT_HISTORY) });
    }
    db.log("ban", { user, reason, ips: ips.length }, ws.ip);
    notifyBanned();
    send(ws, { type: "notice", text: `${user} est banni (${ips.length} adresse${ips.length > 1 ? "s" : ""} IP)` });
    for (const c of wss.clients) if (c.isAdmin) sendBans(c);
  },

  unban(ws, m) {
    const b = db.getBan(m.id | 0);
    if (!b) return;
    // Débannir un pseudo retire aussi les IP associées
    if (b.user) db.removeBansOfUser(b.user); else db.removeBan(b.id);
    reloadBans();
    db.log("unban", { user: b.user, value: b.value }, ws.ip);
    send(ws, { type: "notice", text: `${b.user || b.value} est débanni` });
    for (const c of wss.clients) {
      if (c.isAdmin) sendBans(c);
      if (!isBanned(c.ip, c.user)) send(c, { type: "unbanned" });
    }
  },

  rollback(ws, m) {
    const user = cleanName(m.user);
    if (!user) return send(ws, { type: "notice", text: "Pseudo invalide" });
    const n = db.rollbackUser(user, ws.ip);
    reloadGrid();
    broadcast(grid);
    db.log("rollback", { user, pixels: n }, ws.ip);
    send(ws, { type: "notice", text: `${n} pixel${n > 1 ? "s" : ""} de ${user} annulé${n > 1 ? "s" : ""}` });
  },

  clearZone(ws, m) {
    let x1 = m.x1 | 0, y1 = m.y1 | 0, x2 = m.x2 | 0, y2 = m.y2 | 0;
    if (x1 > x2) [x1, x2] = [x2, x1];
    if (y1 > y2) [y1, y2] = [y2, y1];
    x1 = Math.max(0, x1); y1 = Math.max(0, y1);
    x2 = Math.min(WIDTH - 1, x2); y2 = Math.min(HEIGHT - 1, y2);
    const n = db.clearZone(x1, y1, x2, y2, ws.ip);
    reloadGrid();
    broadcast(grid);
    db.log("clearZone", { x1, y1, x2, y2, pixels: n }, ws.ip);
    send(ws, { type: "notice", text: `Zone (${x1},${y1}) → (${x2},${y2}) effacée` });
  },

  listBans(ws) { sendBans(ws); },

  // Dessine une image : data = w×h octets en base64 (index de couleur, 255 = transparent)
  drawImage(ws, m) {
    const x0 = m.x | 0, y0 = m.y | 0, w = m.w | 0, h = m.h | 0;
    if (w < 1 || h < 1 || w > WIDTH || h > HEIGHT || w * h > MAX_IMAGE_PIXELS) return send(ws, { type: "notice", text: "Image trop grande" });
    let data;
    try { data = Buffer.from(String(m.data || ""), "base64"); } catch { data = null; }
    if (!data || data.length !== w * h) return send(ws, { type: "notice", text: "Image invalide" });
    const cells = [];
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const c = data[j * w + i], x = x0 + i, y = y0 + j;
      if (c === 255 || c >= PALETTE.length || x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      if (grid[y * WIDTH + x] === c) continue; // déjà la bonne couleur
      cells.push([x, y, c]);
    }
    const label = String(m.label || "image").slice(0, 40);
    if (!cells.length) return send(ws, { type: "notice", text: "Rien à dessiner : l'image est déjà là" });
    if (m.order === "random") {
      for (let i = cells.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [cells[i], cells[k]] = [cells[k], cells[i]]; }
    }
    const speed = Math.max(0, Math.min(5000, Number(m.speed) || 0)); // pixels par seconde, 0 = d'un coup
    db.log("drawImage", { label, x: x0, y: y0, w, h, pixels: cells.length, speed }, ws.ip);
    if (!speed) {
      writeCells(cells, ws.ip);
      return send(ws, { type: "notice", text: `« ${label} » dessinée : ${cells.length} pixels` });
    }
    const job = { id: nextJobId++, label, cells, done: 0, total: cells.length, speed, by: ws.user || "modo", ip: ws.ip };
    const perTick = Math.max(1, Math.round(speed / 10));
    job.timer = setInterval(() => {
      const batch = job.cells.slice(job.done, job.done + perTick);
      writeCells(batch, job.ip);
      job.done += batch.length;
      if (job.done >= job.total) finishJob(job, `« ${job.label} » terminée (${job.total} pixels)`);
    }, 100);
    jobs.set(job.id, job);
    send(ws, { type: "notice", text: `Dessin de « ${label} » lancé : ${cells.length} pixels` });
    sendJobs();
  },

  cancelDraw(ws, m) {
    const job = jobs.get(m.id | 0);
    if (job) finishJob(job, `« ${job.label} » arrêtée à ${job.done}/${job.total} pixels`);
  },

  announce(ws, m) {
    const text = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 280);
    if (!text) return send(ws, { type: "notice", text: "L'annonce est vide" });
    announcement = { id: Date.now(), text, at: Date.now() };
    db.setSetting("announcement", announcement);
    broadcastJson({ type: "announce", a: announcement, fresh: true });
    db.log("announce", { text }, ws.ip);
    send(ws, { type: "notice", text: "Annonce publiée" });
  },

  clearAnnounce(ws) {
    announcement = null;
    db.setSetting("announcement", null);
    broadcastJson({ type: "announce", a: null });
    db.log("clearAnnounce", {}, ws.ip);
    send(ws, { type: "notice", text: "Annonce retirée" });
  },

  setEvent(ws, m) {
    const title = String(m.title || "").trim().slice(0, 60);
    const start = Number(m.start), end = Number(m.end);
    const cooldown = m.cooldown ? Math.max(0, Math.min(3600, Number(m.cooldown))) * 1000 : null;
    if (!title) return send(ws, { type: "notice", text: "Donne un nom à l'événement" });
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return send(ws, { type: "notice", text: "La fin doit être après le début" });
    }
    event = { title, start, end, cooldown, lock: !!m.lock };
    db.setSetting("event", event);
    broadcastJson({ type: "event", e: event });
    db.log("setEvent", event, ws.ip);
    send(ws, { type: "notice", text: `Événement « ${title} » programmé` });
  },

  clearEvent(ws) {
    event = null;
    db.setSetting("event", null);
    broadcastJson({ type: "event", e: null });
    db.log("clearEvent", {}, ws.ip);
    send(ws, { type: "notice", text: "Événement supprimé" });
  },
};

// ---- Connexions ----
wss.on("connection", (ws, req) => {
  ws.ip = clientIp(req);
  const open = (connCount.get(ws.ip) || 0) + 1;
  if (open > MAX_CONN_PER_IP) {
    send(ws, { type: "error", message: "Trop d'onglets ouverts sur le site depuis ta connexion" });
    return ws.close(1008, "trop de connexions");
  }
  connCount.set(ws.ip, open);
  ws.rate = { n: 0, reset: Date.now() + 1000 };
  ws.isAdmin = false;
  ws.user = null;

  ws.send(grid); // grille complète en binaire
  const wait = Math.max(0, (lastPlaced.get(ws.ip) || 0) + currentCooldown() - Date.now());
  send(ws, { type: "cooldown", wait });
  send(ws, { type: "chatHistory", msgs: db.recentChat(CHAT_HISTORY) });
  send(ws, { type: "announce", a: announcement });
  send(ws, { type: "event", e: event });
  if (isBanned(ws.ip)) send(ws, { type: "banned" });
  broadcastOnline();

  ws.on("message", (raw) => {
    // Anti-flood : trop de messages en une seconde = déconnexion
    const t = Date.now();
    if (t > ws.rate.reset) ws.rate = { n: 0, reset: t + 1000 };
    if (++ws.rate.n > MSG_PER_SEC) return ws.terminate();
    // Seuls les modos connectés ont le droit d'envoyer de gros messages
    if (raw.length > MAX_MSG_BYTES && !ws.isAdmin) return ws.terminate();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const now = Date.now();

    // ----- Connexion modérateur -----
    if (msg.type === "auth") {
      const f = authFails.get(ws.ip) || { n: 0, until: 0 };
      if (now < f.until) return send(ws, { type: "auth", ok: false, error: "Trop d'essais, attends une minute" });
      if (passwordOk(msg.password)) {
        authFails.delete(ws.ip);
        ws.isAdmin = true;
        send(ws, { type: "auth", ok: true });
        sendBans(ws);
        send(ws, { type: "jobs", list: jobsSummary() });
        db.log("login", {}, ws.ip);
      } else {
        f.n++; if (f.n >= 5) { f.n = 0; f.until = now + 60000; }
        authFails.set(ws.ip, f);
        send(ws, { type: "auth", ok: false, error: ADMIN_PASSWORD ? "Mot de passe incorrect" : "Modération désactivée (ADMIN_PASSWORD non défini)" });
      }
      return;
    }

    // ----- Actions de modération -----
    if (msg.type === "mod") {
      if (!ws.isAdmin) return;
      const fn = modActions[msg.action];
      if (fn) fn(ws, msg);
      return;
    }

    // ----- Pseudo -----
    const user = cleanName(msg.user);
    if (msg.type === "place" || msg.type === "chat") {
      if (!user) return send(ws, { type: "error", message: "Choisis un pseudo (2 caractères minimum)" });
      ws.user = user;
      if (!ws.isAdmin && isBanned(ws.ip, user)) return send(ws, { type: "banned" });
    }

    // ----- Poser un pixel -----
    if (msg.type === "place") {
      const x = msg.x | 0, y = msg.y | 0, c = msg.c | 0;
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT || c < 0 || c >= PALETTE.length) return;
      const closed = canvasClosed(now);
      if (closed && !ws.isAdmin) return send(ws, { type: "error", message: closed });
      const cd = currentCooldown(now);
      const last = lastPlaced.get(ws.ip) || 0;
      if (!ws.isAdmin && now - last < cd) {
        return send(ws, { type: "cooldown", wait: last + cd - now });
      }
      lastPlaced.set(ws.ip, now);
      grid[y * WIDTH + x] = c;
      db.placePixel(x, y, c, user, ws.ip, now);
      broadcastJson({ type: "pixel", x, y, c, user, t: now });
      send(ws, { type: "cooldown", wait: ws.isAdmin ? 0 : cd });
    }

    // ----- Message de chat -----
    if (msg.type === "chat") {
      const text = String(msg.text || "").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX_LENGTH);
      if (!text) return;
      const last = lastChat.get(ws.ip) || 0;
      if (!ws.isAdmin && now - last < CHAT_COOLDOWN_MS) {
        return send(ws, { type: "error", message: "Doucement ! Attends un peu avant d'écrire" });
      }
      lastChat.set(ws.ip, now);
      const id = Number(db.addChat(user, text, ws.ip, ws.isAdmin, now));
      broadcastJson({ type: "chat", msg: { id, user, text, is_mod: ws.isAdmin ? 1 : 0, sent_at: now } });
    }
  });

  ws.on("close", () => {
    const n = (connCount.get(ws.ip) || 1) - 1;
    if (n <= 0) connCount.delete(ws.ip); else connCount.set(ws.ip, n);
    broadcastOnline();
  });
  ws.on("error", () => {});
});

// Ménage des compteurs en mémoire (toutes les 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now > h.reset) hits.delete(k);
  for (const m of [lastPlaced, lastChat]) for (const [k, t] of m) if (now - t > 3600000) m.delete(k);
  for (const [k, f] of authFails) if (now > f.until && f.n === 0) authFails.delete(k);
}, 600000).unref();

server.listen(PORT, () => {
  console.log(`Mini r/place v${VERSION} sur http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) console.log("Modération désactivée : définis ADMIN_PASSWORD pour l'activer");
});
