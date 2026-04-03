import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';

mkdirSync('./data', { recursive: true });

const db = new Database('./data/ratphonk.db', { verbose: null });

// WAL mode for concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`

-- ── MEMBERS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id      TEXT    UNIQUE,
  discord_tag     TEXT,
  rsn             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  wom_player_id   INTEGER,
  role            TEXT    NOT NULL DEFAULT 'member'
                          CHECK(role IN ('member','officer','admin')),
  joined_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  is_verified     INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1
);

-- ── APPLICATIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS applications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  rsn             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  wom_player_id   INTEGER,
  referral        TEXT,
  playstyle       TEXT,
  notes           TEXT,
  discord_id      TEXT,
  discord_tag     TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','approved','rejected','expired')),
  submitted_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_by     INTEGER REFERENCES members(id),
  reviewed_at     INTEGER,
  reject_reason   TEXT,
  invite_code     TEXT    UNIQUE,
  invite_used     INTEGER NOT NULL DEFAULT 0
);

-- ── XP SNAPSHOTS ─────────────────────────────────────────────
-- One row per member per cron run. Deltas calculated at query time.
CREATE TABLE IF NOT EXISTS xp_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL REFERENCES members(id),
  captured_at     INTEGER NOT NULL DEFAULT (unixepoch()),

  -- Overall
  overall_xp      INTEGER NOT NULL DEFAULT 0,
  overall_level   INTEGER NOT NULL DEFAULT 0,

  -- Skills (all 23)
  attack_xp       INTEGER NOT NULL DEFAULT 0,
  defence_xp      INTEGER NOT NULL DEFAULT 0,
  strength_xp     INTEGER NOT NULL DEFAULT 0,
  hitpoints_xp    INTEGER NOT NULL DEFAULT 0,
  ranged_xp       INTEGER NOT NULL DEFAULT 0,
  prayer_xp       INTEGER NOT NULL DEFAULT 0,
  magic_xp        INTEGER NOT NULL DEFAULT 0,
  cooking_xp      INTEGER NOT NULL DEFAULT 0,
  woodcutting_xp  INTEGER NOT NULL DEFAULT 0,
  fletching_xp    INTEGER NOT NULL DEFAULT 0,
  fishing_xp      INTEGER NOT NULL DEFAULT 0,
  firemaking_xp   INTEGER NOT NULL DEFAULT 0,
  crafting_xp     INTEGER NOT NULL DEFAULT 0,
  smithing_xp     INTEGER NOT NULL DEFAULT 0,
  mining_xp       INTEGER NOT NULL DEFAULT 0,
  herblore_xp     INTEGER NOT NULL DEFAULT 0,
  agility_xp      INTEGER NOT NULL DEFAULT 0,
  thieving_xp     INTEGER NOT NULL DEFAULT 0,
  slayer_xp       INTEGER NOT NULL DEFAULT 0,
  farming_xp      INTEGER NOT NULL DEFAULT 0,
  runecraft_xp    INTEGER NOT NULL DEFAULT 0,
  hunter_xp       INTEGER NOT NULL DEFAULT 0,
  construction_xp INTEGER NOT NULL DEFAULT 0,

  -- Boss KC (top bosses — add more as needed)
  vorkath_kc      INTEGER NOT NULL DEFAULT 0,
  zulrah_kc       INTEGER NOT NULL DEFAULT 0,
  cox_kc          INTEGER NOT NULL DEFAULT 0,
  tob_kc          INTEGER NOT NULL DEFAULT 0,
  toa_kc          INTEGER NOT NULL DEFAULT 0,
  cerberus_kc     INTEGER NOT NULL DEFAULT 0,
  gauntlet_kc     INTEGER NOT NULL DEFAULT 0,
  nightmare_kc    INTEGER NOT NULL DEFAULT 0,
  corp_kc         INTEGER NOT NULL DEFAULT 0,
  graardor_kc     INTEGER NOT NULL DEFAULT 0,
  zilyana_kc      INTEGER NOT NULL DEFAULT 0,
  kreearra_kc     INTEGER NOT NULL DEFAULT 0,
  kril_kc         INTEGER NOT NULL DEFAULT 0,
  abyssal_sire_kc INTEGER NOT NULL DEFAULT 0,
  kraken_kc       INTEGER NOT NULL DEFAULT 0,
  callisto_kc     INTEGER NOT NULL DEFAULT 0,
  venenatis_kc    INTEGER NOT NULL DEFAULT 0,
  vetion_kc       INTEGER NOT NULL DEFAULT 0,

  -- Collection log
  collection_log_count INTEGER NOT NULL DEFAULT 0,

  -- WOM metadata
  wom_snapshot_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_xp_snap_member_time
  ON xp_snapshots(member_id, captured_at DESC);

-- ── LEADERBOARD PERIODS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard_periods (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  label             TEXT    NOT NULL,
  period_type       TEXT    NOT NULL CHECK(period_type IN ('weekly','monthly','custom')),
  starts_at         INTEGER NOT NULL,
  ends_at           INTEGER,
  snapshot_start_id INTEGER REFERENCES xp_snapshots(id),
  snapshot_end_id   INTEGER REFERENCES xp_snapshots(id)
);

-- ── PVP LEDGER ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pvp_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id     INTEGER NOT NULL REFERENCES members(id),
  victim_rsn      TEXT    NOT NULL,
  victim_member_id INTEGER REFERENCES members(id),
  occurred_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  location        TEXT,
  loot_gp         INTEGER NOT NULL DEFAULT 0,
  screenshot_url  TEXT,
  is_verified     INTEGER NOT NULL DEFAULT 0,
  source          TEXT    DEFAULT 'manual'
                          CHECK(source IN ('manual','discord_bot','trackscape')),
  raw_message     TEXT,
  notes           TEXT
);

-- ── DROP LEDGER ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drop_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id     INTEGER NOT NULL REFERENCES members(id),
  boss_name       TEXT    NOT NULL,
  item_name       TEXT    NOT NULL,
  item_value_gp   INTEGER NOT NULL DEFAULT 0,
  is_split        INTEGER NOT NULL DEFAULT 0,
  screenshot_url  TEXT,
  occurred_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  is_verified     INTEGER NOT NULL DEFAULT 0,
  source          TEXT    DEFAULT 'manual'
                          CHECK(source IN ('manual','discord_bot','trackscape')),
  raw_message     TEXT,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS drop_split_members (
  drop_id     INTEGER NOT NULL REFERENCES drop_ledger(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  cut_gp      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (drop_id, member_id)
);

-- ── DISCORD WEBHOOK INGEST LOG ────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  event_type      TEXT    NOT NULL,
  discord_user    TEXT,
  raw_payload     TEXT    NOT NULL,
  processed       INTEGER NOT NULL DEFAULT 0,
  processed_at    INTEGER,
  error_msg       TEXT
);

-- ── EVENTS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by      INTEGER NOT NULL REFERENCES members(id),
  title           TEXT    NOT NULL,
  description     TEXT,
  event_type      TEXT    CHECK(event_type IN ('bossing','pk_trip','skilling','social','tournament')),
  starts_at       INTEGER NOT NULL,
  ends_at         INTEGER,
  max_attendees   INTEGER,
  is_cancelled    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  status      TEXT    NOT NULL DEFAULT 'going' CHECK(status IN ('going','maybe','declined')),
  PRIMARY KEY (event_id, member_id)
);

-- ── BINGO ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bingo_boards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES members(id),
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER,
  prize_pool  TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bingo_tiles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id    INTEGER NOT NULL REFERENCES bingo_boards(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL, -- 0-24 for 5x5
  title       TEXT    NOT NULL,
  description TEXT,
  tile_type   TEXT    NOT NULL CHECK(tile_type IN ('drop','level','kc','challenge','pet','clog')),
  difficulty  TEXT    NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
  is_free     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bingo_teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id    INTEGER NOT NULL REFERENCES bingo_boards(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  color       TEXT    NOT NULL DEFAULT '#5dba4e'
);

CREATE TABLE IF NOT EXISTS bingo_team_members (
  team_id     INTEGER NOT NULL REFERENCES bingo_teams(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  PRIMARY KEY (team_id, member_id)
);

CREATE TABLE IF NOT EXISTS bingo_tile_completions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tile_id     INTEGER NOT NULL REFERENCES bingo_tiles(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES bingo_teams(id),
  member_id   INTEGER NOT NULL REFERENCES members(id),
  screenshot_url TEXT,
  submitted_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  reviewed_by    INTEGER REFERENCES members(id),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending','approved','rejected'))
);

-- ── TILE SUGGESTIONS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tile_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  suggested_by INTEGER NOT NULL REFERENCES members(id),
  title       TEXT    NOT NULL,
  tile_type   TEXT    NOT NULL,
  difficulty  TEXT    NOT NULL,
  notes       TEXT,
  submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending','approved','rejected'))
);

-- ── COMPETITIONS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by  INTEGER NOT NULL REFERENCES members(id),
  title       TEXT    NOT NULL,
  comp_type   TEXT    NOT NULL CHECK(comp_type IN ('xp','level','kc','gp','custom')),
  format      TEXT    NOT NULL CHECK(format IN ('solo','team')),
  goal        TEXT    NOT NULL,
  metric      TEXT,               -- e.g. 'slayer', 'vorkath', 'overall'
  prize       TEXT,
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER,
  wom_comp_id INTEGER,            -- if synced to WOM competitions
  is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS comp_participants (
  comp_id     INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  team_name   TEXT,               -- NULL for solo comps
  signed_up_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (comp_id, member_id)
);

`);


// ── MIGRATIONS (safe to run on existing DBs) ──────────────────
const migrations = [
  'ALTER TABLE applications ADD COLUMN discord_id TEXT',
  'ALTER TABLE applications ADD COLUMN discord_tag TEXT',
  'ALTER TABLE xp_snapshots ADD COLUMN gauntlet_kc INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE xp_snapshots ADD COLUMN nightmare_kc INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE xp_snapshots ADD COLUMN zilyana_kc INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE xp_snapshots ADD COLUMN kreearra_kc INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE xp_snapshots ADD COLUMN venenatis_kc INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE xp_snapshots ADD COLUMN vetion_kc INTEGER NOT NULL DEFAULT 0',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch(e) { /* column already exists */ }
}

export default db;