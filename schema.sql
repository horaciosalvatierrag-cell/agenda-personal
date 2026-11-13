PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '09:00',
  category TEXT NOT NULL DEFAULT 'Personal',
  repeat_rule TEXT NOT NULL DEFAULT 'none' CHECK(repeat_rule IN ('none','daily','weekly','monthly','yearly')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS completions (
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(activity_id, occurrence_date)
);
CREATE TABLE IF NOT EXISTS daily_notes (
  date TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  important INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);
