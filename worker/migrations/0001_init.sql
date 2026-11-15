-- Players who chose to be on the public leaderboard.
-- Only a hash of each player's secret key is stored.
CREATE TABLE players (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL,
  emoji       TEXT NOT NULL UNIQUE,
  nickname    TEXT NOT NULL,
  nick_norm   TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Each player's current time on each fact ("7x8" means 7 × 8).
-- ms:    recent-weighted answer time, rounded to 0.1 s
-- at:    when the player last improved or changed that time (used for the 2-week window)
-- since: when this player first had this exact time (earlier wins a tie)
CREATE TABLE times (
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  cell       TEXT NOT NULL,
  ms         INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  since      INTEGER NOT NULL,
  PRIMARY KEY (player_id, cell)
);

CREATE INDEX times_at ON times(at);
