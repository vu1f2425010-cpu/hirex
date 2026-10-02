const Database = require('better-sqlite3')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')

const db = new Database('./hirex.db')
db.pragma('journal_mode = WAL')

// set up tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'recruiter'
  );

  CREATE TABLE IF NOT EXISTS assessments (
    id TEXT PRIMARY KEY,
    title TEXT,
    role TEXT,
    competencies TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    assessment_id TEXT,
    text TEXT,
    competency TEXT DEFAULT 'General',
    sequence INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    assessment_id TEXT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    dob TEXT,
    position TEXT,
    resume_text TEXT,
    hiring_status TEXT DEFAULT 'pending',
    hire_notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS interviews (
    id TEXT PRIMARY KEY,
    assessment_id TEXT,
    candidate_id TEXT,
    status TEXT DEFAULT 'in_progress',
    overall_score REAL DEFAULT 0,
    summary TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS answers (
    id TEXT PRIMARY KEY,
    interview_id TEXT,
    question_text TEXT,
    answer_text TEXT,
    score REAL DEFAULT 0,
    feedback TEXT,
    is_followup INTEGER DEFAULT 0,
    sequence INTEGER DEFAULT 1
  );
`)

// add hiring cols to older dbs
try {
  db.exec("ALTER TABLE candidates ADD COLUMN hiring_status TEXT DEFAULT 'pending'")
} catch (e) {} // already exists, ignore

try {
  db.exec("ALTER TABLE candidates ADD COLUMN hire_notes TEXT")
} catch (e) {}

// seed if fresh db
if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
  const adminHash = bcrypt.hashSync('admin123', 10)
  const recHash = bcrypt.hashSync('recruiter123', 10)
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(uuidv4(), 'Admin', 'admin@hirex.com', adminHash, 'admin')
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(uuidv4(), 'Recruiter', 'recruiter@hirex.com', recHash, 'recruiter')
}

module.exports = db
