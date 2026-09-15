CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  display_name VARCHAR(80) NOT NULL,
  email VARCHAR(320) UNIQUE NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS fantasy_teams (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  sport VARCHAR(40) NOT NULL,
  budget NUMERIC(10,2) NOT NULL DEFAULT 100.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fantasy_teams_user_id_idx ON fantasy_teams(user_id);

CREATE TABLE IF NOT EXISTS fantasy_team_players (
  fantasy_team_id UUID NOT NULL REFERENCES fantasy_teams(id) ON DELETE CASCADE,
  provider_player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  team_name TEXT,
  league_name TEXT,
  position TEXT,
  price NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (fantasy_team_id, provider_player_id)
);

CREATE TABLE IF NOT EXISTS leagues (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  sport VARCHAR(40) NOT NULL,
  invite_code VARCHAR(20) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS league_members (
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_points NUMERIC(12,2) NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (league_id, user_id)
);

ALTER TABLE league_members ADD COLUMN IF NOT EXISTS total_points NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE league_members ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE league_members ADD COLUMN IF NOT EXISTS matches_played INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS league_members_leaderboard_idx ON league_members(league_id, total_points DESC, wins DESC);
