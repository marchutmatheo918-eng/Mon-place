// Base de données SQLite (fichier place.db)
// - pixels   : historique complet (sert aussi au timelapse et au classement)
// - canvas   : état actuel, une ligne par case
// - chat     : messages du chat
// - bans     : pseudos et adresses IP bannis
// - mod_log  : journal des actions de modération
// - settings : réglages (annonce en cours, événement, version de la palette)

const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(process.env.DB_FILE || path.join(__dirname, "place.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS pixels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x INTEGER NOT NULL, y INTEGER NOT NULL, color INTEGER NOT NULL,
    user TEXT NOT NULL, ip TEXT, placed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pixels_xy   ON pixels (x, y);
  CREATE INDEX IF NOT EXISTS idx_pixels_user ON pixels (user);
  CREATE INDEX IF NOT EXISTS idx_pixels_time ON pixels (placed_at);

  CREATE TABLE IF NOT EXISTS canvas (
    x INTEGER NOT NULL, y INTEGER NOT NULL, color INTEGER NOT NULL,
    user TEXT NOT NULL, placed_at INTEGER NOT NULL,
    PRIMARY KEY (x, y)
  );

  CREATE TABLE IF NOT EXISTS chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL, text TEXT NOT NULL, ip TEXT,
    is_mod INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_user ON chat (user);

  CREATE TABLE IF NOT EXISTS bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, value TEXT NOT NULL, user TEXT, reason TEXT, banned_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mod_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL, details TEXT, ip TEXT, at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT
  );
`);

// v0.16 : identifiant unique du joueur (pid) sur les pixels, les cases et le chat
for (const table of ["pixels", "canvas", "chat"]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes("pid")) db.exec(`ALTER TABLE ${table} ADD COLUMN pid TEXT`);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_pixels_pid ON pixels (pid)");

// Les actions de modération sont aussi écrites dans l'historique (pour le timelapse)
// sous ce nom, qu'aucun joueur ne peut prendre (les crochets sont interdits dans les pseudos).
const MOD_USER = "[modération]";

// ---------- Réglages ----------
const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const setSettingStmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
function getSetting(key) {
  const r = getSettingStmt.get(key);
  if (!r || r.value == null) return null;
  try { return JSON.parse(r.value); } catch { return null; }
}
const setSetting = (key, value) => setSettingStmt.run(key, value == null ? null : JSON.stringify(value));

// ---------- Passage de 16 à 32 couleurs (une seule fois) ----------
// Chaque ancienne couleur est remplacée par la plus proche de la nouvelle palette.
function migratePalette(oldPalette, newPalette, version) {
  if (getSetting("palette_version") === version) return 0;
  const hasPixels = db.prepare("SELECT COUNT(*) AS n FROM pixels").get().n > 0;
  if (hasPixels && getSetting("palette_version") == null) {
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const nearest = oldPalette.map((h) => {
      const a = rgb(h);
      let best = 0, bestD = Infinity;
      newPalette.forEach((n, j) => {
        const b = rgb(n);
        const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
        if (d < bestD) { bestD = d; best = j; }
      });
      return best;
    });
    const cases = nearest.map((n, i) => `WHEN ${i} THEN ${n}`).join(" ");
    db.transaction(() => {
      db.exec(`UPDATE pixels SET color = CASE color ${cases} ELSE color END`);
      db.exec(`UPDATE canvas SET color = CASE color ${cases} ELSE color END`);
    })();
  }
  setSetting("palette_version", version);
  return hasPixels ? 1 : 0;
}

// ---------- Pixels ----------
const insertHistoryStmt = db.prepare("INSERT INTO pixels (x, y, color, user, ip, placed_at, pid) VALUES (?, ?, ?, ?, ?, ?, ?)");
const upsertCanvasStmt = db.prepare(`
  INSERT INTO canvas (x, y, color, user, placed_at, pid) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (x, y) DO UPDATE SET color = excluded.color, user = excluded.user, placed_at = excluded.placed_at, pid = excluded.pid
`);
const insertHistory = { run: (x, y, c, user, ip, ts, pid = null) => insertHistoryStmt.run(x, y, c, user, ip, ts, pid) };
const upsertCanvas = { run: (x, y, c, user, ts, pid = null) => upsertCanvasStmt.run(x, y, c, user, ts, pid) };
const deleteCanvas = db.prepare("DELETE FROM canvas WHERE x = ? AND y = ?");
const placePixel = db.transaction((x, y, color, user, ip, ts, pid) => {
  insertHistory.run(x, y, color, user, ip, ts, pid);
  upsertCanvas.run(x, y, color, user, ts, pid);
});

// Pose de plusieurs pixels d'un coup (outil image des modos)
const placeBatch = db.transaction((cells, user, ip, ts) => {
  for (const [x, y, c] of cells) {
    insertHistory.run(x, y, c, user, ip, ts);
    upsertCanvas.run(x, y, c, user, ts);
  }
});

const getPixel = db.prepare("SELECT color, user, placed_at, pid FROM canvas WHERE x = ? AND y = ?");
const allCanvas = db.prepare("SELECT x, y, color FROM canvas");
const deleteOutsideStmt = db.prepare("DELETE FROM canvas WHERE x >= ? OR y >= ?");
const countUser = db.prepare("SELECT COUNT(*) AS n FROM pixels WHERE user = ?");
const stats = db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT user) AS players FROM pixels WHERE user NOT LIKE '[%'`);

// Annule les pixels encore visibles d'un pseudo (ou d'un identifiant #XXXXXX) :
// chaque case reprend sa couleur d'avant
const cellsOfUser = db.prepare("SELECT x, y FROM canvas WHERE user = ?");
const cellsOfPid = db.prepare("SELECT x, y FROM canvas WHERE pid = ?");
const previousPixel = db.prepare(
  "SELECT color, user, placed_at, pid FROM pixels WHERE x = ? AND y = ? AND user != ? ORDER BY id DESC LIMIT 1"
);
const previousPixelPid = db.prepare(
  "SELECT color, user, placed_at, pid FROM pixels WHERE x = ? AND y = ? AND (pid IS NULL OR pid != ?) ORDER BY id DESC LIMIT 1"
);
const rollback = db.transaction((who, ip, byPid) => {
  const now = Date.now();
  const cells = (byPid ? cellsOfPid : cellsOfUser).all(who);
  for (const { x, y } of cells) {
    const prev = (byPid ? previousPixelPid : previousPixel).get(x, y, who);
    if (prev) upsertCanvas.run(x, y, prev.color, prev.user, prev.placed_at, prev.pid);
    else deleteCanvas.run(x, y);
    insertHistory.run(x, y, prev ? prev.color : 0, MOD_USER, ip, now);
  }
  return cells.length;
});
const rollbackUser = (user, ip) => rollback(user, ip, false);
const rollbackPid = (pid, ip) => rollback(pid, ip, true);

// Efface une zone (remise en blanc)
const cellsInZone = db.prepare("SELECT x, y FROM canvas WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ?");
const clearZoneStmt = db.prepare("DELETE FROM canvas WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ?");
const clearZone = db.transaction((x1, y1, x2, y2, ip) => {
  const now = Date.now();
  const cells = cellsInZone.all(x1, x2, y1, y2);
  for (const { x, y } of cells) insertHistory.run(x, y, 0, MOD_USER, ip, now);
  clearZoneStmt.run(x1, x2, y1, y2);
  return cells.length;
});

// ---------- Timelapse : tout l'historique en binaire (9 octets par pixel) ----------
// x (2 octets), y (2 octets), couleur (1 octet), date en secondes (4 octets)
const historyCount = db.prepare("SELECT COUNT(*) AS n FROM pixels");
const historyAll = db.prepare("SELECT x, y, color, placed_at FROM pixels ORDER BY id");
function historyBinary() {
  const n = historyCount.get().n;
  const buf = Buffer.alloc(n * 9);
  let o = 0;
  for (const r of historyAll.iterate()) {
    if (o + 9 > buf.length) break;
    buf.writeUInt16LE(r.x, o); buf.writeUInt16LE(r.y, o + 2); buf.writeUInt8(r.color, o + 4);
    buf.writeUInt32LE(Math.floor(r.placed_at / 1000), o + 5);
    o += 9;
  }
  return buf.subarray(0, o);
}

// ---------- Classement ----------
const topSince = db.prepare(`
  SELECT user, COUNT(*) AS n FROM pixels
  WHERE placed_at >= ? AND user NOT LIKE '[%'
  GROUP BY user ORDER BY n DESC, MIN(id) ASC LIMIT ?
`);
const countSince = db.prepare("SELECT COUNT(*) AS n FROM pixels WHERE user = ? AND placed_at >= ?");
const rankSince = db.prepare(`
  SELECT COUNT(*) + 1 AS r FROM (
    SELECT COUNT(*) AS n FROM pixels WHERE placed_at >= ? AND user NOT LIKE '[%' GROUP BY user
  ) WHERE n > ?
`);
const playersSince = db.prepare(`SELECT COUNT(DISTINCT user) AS n FROM pixels WHERE placed_at >= ? AND user NOT LIKE '[%'`);
function leaderboard(since, me, limit = 20) {
  since = Math.max(since, Number(getSetting("leaderboard_since")) || 0);
  const top = topSince.all(since, limit);
  let mine = null;
  if (me) {
    const n = countSince.get(me, since).n;
    if (n > 0) mine = { user: me, n, rank: rankSince.get(since, n).r };
  }
  return { top, me: mine, players: playersSince.get(since).n };
}

// ---------- Chat ----------
const insertChat = db.prepare("INSERT INTO chat (user, text, ip, is_mod, sent_at, pid) VALUES (?, ?, ?, ?, ?, ?)");
const recentChat = db.prepare(
  "SELECT id, user, text, is_mod, sent_at, pid FROM (SELECT * FROM chat ORDER BY id DESC LIMIT ?) ORDER BY id ASC"
);
const deleteChatOfPid = db.prepare("DELETE FROM chat WHERE pid = ?");
const getChat = db.prepare("SELECT id, user, ip FROM chat WHERE id = ?");
const deleteChat = db.prepare("DELETE FROM chat WHERE id = ?");
const deleteChatOfUser = db.prepare("DELETE FROM chat WHERE user = ?");

// ---------- Bans ----------
const insertBan = db.prepare("INSERT INTO bans (kind, value, user, reason, banned_at) VALUES (?, ?, ?, ?, ?)");
const allBans = db.prepare("SELECT * FROM bans ORDER BY id DESC");
const banById = db.prepare("SELECT * FROM bans WHERE id = ?");
const deleteBan = db.prepare("DELETE FROM bans WHERE id = ?");
const deleteBansOfUser = db.prepare("DELETE FROM bans WHERE user = ?");
const ipsOfUser = db.prepare(`
  SELECT DISTINCT ip FROM (
    SELECT ip FROM pixels WHERE user = ? AND ip IS NOT NULL
    UNION SELECT ip FROM chat WHERE user = ? AND ip IS NOT NULL
  )
`);

const pidsOfUser = db.prepare(`
  SELECT DISTINCT pid FROM (
    SELECT pid FROM pixels WHERE user = ? AND pid IS NOT NULL
    UNION SELECT pid FROM chat WHERE user = ? AND pid IS NOT NULL
  )
`);
const ipsOfPid = db.prepare(`
  SELECT DISTINCT ip FROM (
    SELECT ip FROM pixels WHERE pid = ? AND ip IS NOT NULL
    UNION SELECT ip FROM chat WHERE pid = ? AND ip IS NOT NULL
  )
`);
const lastNameOfPid = db.prepare(`
  SELECT user FROM (
    SELECT user, placed_at AS t FROM pixels WHERE pid = ?
    UNION ALL SELECT user, sent_at AS t FROM chat WHERE pid = ?
  ) ORDER BY t DESC LIMIT 1
`);

// ---------- Journal ----------
const insertLog = db.prepare("INSERT INTO mod_log (action, details, ip, at) VALUES (?, ?, ?, ?)");

module.exports = {
  MOD_USER,
  getSetting, setSetting, migratePalette,

  placePixel,
  placeBatch,
  getPixel: (x, y) => getPixel.get(x, y),
  allCanvas: () => allCanvas.all(),
  deleteOutside: (w, h) => deleteOutsideStmt.run(w, h).changes,
  pixelsByUser: (user) => countUser.get(user).n,
  stats: () => stats.get(),
  rollbackUser,
  rollbackPid,
  clearZone,
  historyBinary,
  leaderboard,

  addChat: (user, text, ip, isMod, ts, pid = null) => insertChat.run(user, text, ip, isMod ? 1 : 0, ts, pid).lastInsertRowid,
  deleteChatOfPid: (pid) => deleteChatOfPid.run(pid).changes,
  recentChat: (n = 50) => recentChat.all(n),
  getChat: (id) => getChat.get(id),
  deleteChat: (id) => deleteChat.run(id).changes,
  deleteChatOfUser: (user) => deleteChatOfUser.run(user).changes,

  addBan: (kind, value, user, reason) => insertBan.run(kind, value, user, reason, Date.now()),
  allBans: () => allBans.all(),
  getBan: (id) => banById.get(id),
  removeBan: (id) => deleteBan.run(id).changes,
  removeBansOfUser: (user) => deleteBansOfUser.run(user).changes,
  ipsOfUser: (user) => ipsOfUser.all(user, user).map((r) => r.ip),
  pidsOfUser: (user) => pidsOfUser.all(user, user).map((r) => r.pid),
  ipsOfPid: (pid) => ipsOfPid.all(pid, pid).map((r) => r.ip),
  lastNameOfPid: (pid) => (lastNameOfPid.get(pid, pid) || {}).user || null,

  log: (action, details, ip) => insertLog.run(action, JSON.stringify(details), ip, Date.now()),
};
