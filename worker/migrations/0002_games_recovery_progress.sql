-- Sub-games (multiplication now, others later), recovery words, saved progress, and
-- each player's share of right answers.

-- Times are now kept per game. SQLite can't change a primary key in place, so the table
-- is rebuilt; every existing time becomes a multiplication time.
CREATE TABLE times_new (
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game       TEXT NOT NULL DEFAULT 'mul',
  cell       TEXT NOT NULL,
  ms         INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  since      INTEGER NOT NULL,
  PRIMARY KEY (player_id, game, cell)
);
INSERT INTO times_new (player_id, game, cell, ms, at, since)
  SELECT player_id, 'mul', cell, ms, at, since FROM times;
DROP TABLE times;
ALTER TABLE times_new RENAME TO times;
CREATE INDEX times_game_at ON times(game, at);

-- Recovery: a hash of the player's two recovery words, and a limit on wrong guesses.
ALTER TABLE players ADD COLUMN recovery_hash TEXT;
ALTER TABLE players ADD COLUMN rec_fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN rec_lock_until INTEGER NOT NULL DEFAULT 0;

-- Right answers out of the player's last (up to) 100, per game.
CREATE TABLE stats (
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game        TEXT NOT NULL,
  acc_right   INTEGER NOT NULL,
  acc_total   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (player_id, game)
);

-- The player's whole saved game (all sub-games), so recovery can bring it to a new device.
CREATE TABLE progress (
  player_id   TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
