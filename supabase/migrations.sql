-- migration 1

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  name TEXT,
  tz TEXT NOT NULL DEFAULT 'Africa/Lagos',
  digest_hour INT NOT NULL DEFAULT 7,
  quiet_start INT NOT NULL DEFAULT 22,
  quiet_end INT NOT NULL DEFAULT 7,
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  tier INT NOT NULL,
  args JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome TEXT NOT NULL,
  source_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  args JSONB NOT NULL,
  echo TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  resolved TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS undo_stack (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  undo_payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_at TIMESTAMPTZ NOT NULL,
  cron TEXT,
  tz TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  last_run TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (run_at) WHERE active;

CREATE TABLE IF NOT EXISTS pushes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  cron TEXT,
  job_id INT,
  done BOOLEAN NOT NULL DEFAULT false,
  deleted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  location TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'chat',
  external_uid TEXT,
  remind_minutes INT NOT NULL DEFAULT 30,
  deleted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, external_uid)
);

CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  weekday INT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  location TEXT,
  term_end DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  class_id INT REFERENCES classes(id),
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS medications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  dose TEXT,
  times TEXT[] NOT NULL,
  days_left INT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS medication_logs (
  id SERIAL PRIMARY KEY,
  medication_id INT NOT NULL REFERENCES medications(id),
  scheduled_for TIMESTAMPTZ NOT NULL,
  taken_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS trips (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  destination TEXT NOT NULL,
  starts_on DATE,
  ends_on DATE,
  budget NUMERIC,
  currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'planning',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trip_items (
  id SERIAL PRIMARY KEY,
  trip_id INT NOT NULL REFERENCES trips(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  at TIMESTAMPTZ,
  cost NUMERIC,
  done BOOLEAN NOT NULL DEFAULT false,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS habits (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  target_per_week INT NOT NULL DEFAULT 7,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS habit_checkins (
  id SERIAL PRIMARY KEY,
  habit_id INT NOT NULL REFERENCES habits(id),
  day DATE NOT NULL,
  UNIQUE (habit_id, day)
);

CREATE TABLE IF NOT EXISTS spend (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  note TEXT,
  spent_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memories (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  fact TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  confirmed BOOLEAN NOT NULL DEFAULT false,
  risk INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hackathons (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT,
  deadline TIMESTAMPTZ,
  starts_at TIMESTAMPTZ,
  prize_usd NUMERIC,
  registrations INT,
  online BOOLEAN,
  tags TEXT[] NOT NULL DEFAULT '{}',
  quality INT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen TIMESTAMPTZ DEFAULT now(),
  last_seen TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS hackathons_deadline ON hackathons (deadline);

CREATE TABLE IF NOT EXISTS hackathon_entries (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  hackathon_id INT REFERENCES hackathons(id),
  title TEXT NOT NULL,
  url TEXT,
  deadline TIMESTAMPTZ,
  submission_url TEXT,
  status TEXT NOT NULL DEFAULT 'interested',
  outcome TEXT,
  prize TEXT,
  results_expected DATE,
  payout_expected DATE,
  payout_received DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hackathon_seen (
  user_id INT NOT NULL REFERENCES users(id),
  hackathon_id INT NOT NULL REFERENCES hackathons(id),
  PRIMARY KEY (user_id, hackathon_id)
);

CREATE TABLE IF NOT EXISTS followed_wallets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  venue TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  max_per_trade NUMERIC NOT NULL,
  max_per_day NUMERIC NOT NULL,
  mode TEXT NOT NULL DEFAULT 'shadow',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, venue, address)
);

CREATE TABLE IF NOT EXISTS shadow_trades (
  id SERIAL PRIMARY KEY,
  wallet_id INT NOT NULL REFERENCES followed_wallets(id),
  venue TEXT NOT NULL,
  leader_tx TEXT,
  market TEXT,
  side TEXT,
  leader_price NUMERIC,
  our_price NUMERIC,
  size NUMERIC,
  latency_ms INT,
  seen_at TIMESTAMPTZ DEFAULT now(),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);


-- migration 2

CREATE TABLE IF NOT EXISTS model_usage (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  input_tokens INT NOT NULL,
  output_tokens INT NOT NULL,
  usd NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  UNIQUE (user_id, chain, address)
);

CREATE TABLE IF NOT EXISTS price_alerts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  coin TEXT NOT NULL,
  op TEXT NOT NULL,
  target NUMERIC NOT NULL,
  pct_window INT,
  active BOOLEAN NOT NULL DEFAULT true,
  fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_history (
  coin TEXT NOT NULL,
  usd NUMERIC NOT NULL,
  at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_history_coin ON price_history (coin, at);

CREATE TABLE IF NOT EXISTS job_watches (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  ats TEXT NOT NULL,
  slug TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (user_id, ats, slug)
);

CREATE TABLE IF NOT EXISTS job_posts (
  id SERIAL PRIMARY KEY,
  ats TEXT NOT NULL,
  slug TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  location TEXT,
  first_seen TIMESTAMPTZ DEFAULT now(),
  UNIQUE (ats, slug, external_id)
);

CREATE TABLE IF NOT EXISTS job_seen (
  user_id INT NOT NULL REFERENCES users(id),
  post_id INT NOT NULL REFERENCES job_posts(id),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS launches (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  score INT,
  risk TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS launch_seen (
  user_id INT NOT NULL REFERENCES users(id),
  launch_id INT NOT NULL REFERENCES launches(id),
  PRIMARY KEY (user_id, launch_id)
);

CREATE TABLE IF NOT EXISTS bill_payments (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  biller_code TEXT NOT NULL,
  item_code TEXT,
  customer TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'initiated',
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;


-- migration 3

ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_channel TEXT NOT NULL DEFAULT 'telegram';

CREATE TABLE IF NOT EXISTS identities (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (channel, external_id)
);

CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  channel TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS todos (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  list TEXT NOT NULL DEFAULT 'todo',
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dates (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  on_date DATE NOT NULL,
  yearly BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS scout_results (
  id SERIAL PRIMARY KEY,
  niche TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  twitter TEXT,
  telegram TEXT,
  discord TEXT,
  github TEXT,
  founders JSONB NOT NULL DEFAULT '[]'::jsonb,
  objective TEXT,
  sources TEXT[] NOT NULL DEFAULT '{}',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen TIMESTAMPTZ DEFAULT now(),
  UNIQUE (niche, name)
);

CREATE TABLE IF NOT EXISTS scout_watches (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  niche TEXT NOT NULL,
  objective TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (user_id, niche)
);

CREATE TABLE IF NOT EXISTS scout_seen (
  user_id INT NOT NULL REFERENCES users(id),
  result_id INT NOT NULL REFERENCES scout_results(id),
  PRIMARY KEY (user_id, result_id)
);

CREATE TABLE IF NOT EXISTS business_connections (
  connection_id TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now()
);


-- migration 4

CREATE TABLE IF NOT EXISTS cycles (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  started_on DATE NOT NULL,
  ended_on DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cycles_user ON cycles(user_id, started_on);

CREATE TABLE IF NOT EXISTS cycle_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  day DATE NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cycle_logs_user ON cycle_logs(user_id, day);

CREATE TABLE IF NOT EXISTS measures (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  value NUMERIC,
  unit TEXT,
  note TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS measures_user ON measures(user_id, name, at);


