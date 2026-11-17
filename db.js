// Base de données SQLite (fichier place.db)
// - table "pixels"  : historique complet, une ligne par pixel posé
// - table "canvas"  : état actuel, une ligne par case (dernier pixel posé)

const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(process.env.DB_FILE || path.join(__dirname, "place.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS pixels (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    x       INTEGER NOT NULL,
    y       INTEGER NOT NULL,
    color   INTEGER NOT NULL,
    user    TEXT    NOT NULL,
    ip      TEXT,
    placed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pixels_xy   ON pixels (x, y);
  CREATE INDEX IF NOT EXISTS idx_pixels_user ON pixels (user);

  CREATE TABLE IF NOT EXISTS canvas (
    x       INTEGER NOT NULL,
    y       INTEGER NOT NULL,
    color   INTEGER NOT NULL,
    user    TEXT    NOT NULL,
    placed_at INTEGER NOT NULL,
    PRIMARY KEY (x, y)
  );
`);

const insertHistory = db.prepare(
  "INSERT INTO pixels (x, y, color, user, ip, placed_at) VALUES (?, ?, ?, ?, ?, ?)"
);
const upsertCanvas = db.prepare(`
  INSERT INTO canvas (x, y, color, user, placed_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (x, y) DO UPDATE SET color = excluded.color, user = excluded.user, placed_at = excluded.placed_at
`);

const placePixel = db.transaction((x, y, color, user, ip, ts) => {
  insertHistory.run(x, y, color, user, ip, ts);
  upsertCanvas.run(x, y, color, user, ts);
});

const getPixel = db.prepare("SELECT color, user, placed_at FROM canvas WHERE x = ? AND y = ?");
const allCanvas = db.prepare("SELECT x, y, color FROM canvas");
const countUser = db.prepare("SELECT COUNT(*) AS n FROM pixels WHERE user = ?");
const stats = db.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT user) AS players FROM pixels");

module.exports = {
  placePixel,
  getPixel: (x, y) => getPixel.get(x, y),
  allCanvas: () => allCanvas.all(),
  pixelsByUser: (user) => countUser.get(user).n,
  stats: () => stats.get(),
};
