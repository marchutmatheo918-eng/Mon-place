// Base de données SQLite (fichier place.db)
// - pixels  : historique complet, une ligne par pixel posé
// - canvas  : état actuel, une ligne par case
// - chat    : messages du chat
// - bans    : pseudos et adresses IP bannis
// - mod_log : journal des actions de modération

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
    kind TEXT NOT NULL,            -- 'ip' ou 'name'
    value TEXT NOT NULL,
    user TEXT,                     -- pseudo concerné (pour l'affichage)
    reason TEXT,
    banned_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mod_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL, details TEXT, ip TEXT, at INTEGER NOT NULL
  );
`);

// ---------- Pixels ----------
const insertHistory = db.prepare("INSERT INTO pixels (x, y, color, user, ip, placed_at) VALUES (?, ?, ?, ?, ?, ?)");
const upsertCanvas = db.prepare(`
  INSERT INTO canvas (x, y, color, user, placed_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (x, y) DO UPDATE SET color = excluded.color, user = excluded.user, placed_at = excluded.placed_at
`);
const deleteCanvas = db.prepare("DELETE FROM canvas WHERE x = ? AND y = ?");
const placePixel = db.transaction((x, y, color, user, ip, ts) => {
  insertHistory.run(x, y, color, user, ip, ts);
  upsertCanvas.run(x, y, color, user, ts);
});

const getPixel = db.prepare("SELECT color, user, placed_at FROM canvas WHERE x = ? AND y = ?");
const allCanvas = db.prepare("SELECT x, y, color FROM canvas");
const countUser = db.prepare("SELECT COUNT(*) AS n FROM pixels WHERE user = ?");
const stats = db.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT user) AS players FROM pixels");

// Annule tous les pixels encore visibles d'un pseudo : chaque case reprend
// la couleur qu'elle avait avant (dernier pixel posé par quelqu'un d'autre).
const cellsOfUser = db.prepare("SELECT x, y FROM canvas WHERE user = ?");
const previousPixel = db.prepare(
  "SELECT color, user, placed_at FROM pixels WHERE x = ? AND y = ? AND user != ? ORDER BY id DESC LIMIT 1"
);
const rollbackUser = db.transaction((user) => {
  const cells = cellsOfUser.all(user);
  const changes = [];
  for (const { x, y } of cells) {
    const prev = previousPixel.get(x, y, user);
    if (prev) upsertCanvas.run(x, y, prev.color, prev.user, prev.placed_at);
    else deleteCanvas.run(x, y);
    changes.push({ x, y, color: prev ? prev.color : 0 });
  }
  return changes;
});

// Efface une zone rectangulaire (remet en blanc)
const clearZoneStmt = db.prepare("DELETE FROM canvas WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ?");
const clearZone = (x1, y1, x2, y2) => clearZoneStmt.run(x1, x2, y1, y2).changes;

// ---------- Chat ----------
const insertChat = db.prepare("INSERT INTO chat (user, text, ip, is_mod, sent_at) VALUES (?, ?, ?, ?, ?)");
const recentChat = db.prepare(
  "SELECT id, user, text, is_mod, sent_at FROM (SELECT * FROM chat ORDER BY id DESC LIMIT ?) ORDER BY id ASC"
);
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

// ---------- Journal ----------
const insertLog = db.prepare("INSERT INTO mod_log (action, details, ip, at) VALUES (?, ?, ?, ?)");

module.exports = {
  placePixel,
  getPixel: (x, y) => getPixel.get(x, y),
  allCanvas: () => allCanvas.all(),
  pixelsByUser: (user) => countUser.get(user).n,
  stats: () => stats.get(),
  rollbackUser,
  clearZone,

  addChat: (user, text, ip, isMod, ts) => insertChat.run(user, text, ip, isMod ? 1 : 0, ts).lastInsertRowid,
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

  log: (action, details, ip) => insertLog.run(action, JSON.stringify(details), ip, Date.now()),
};
