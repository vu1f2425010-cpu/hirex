import os, sys, json, uuid, sqlite3
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from dotenv import load_dotenv

load_dotenv()

# fix for windows console encoding weirdness
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except:
        pass

PORT = int(os.getenv("PORT", 5000))
API_KEY = os.getenv("GROQ_API_KEY", "")
DB = "./hirex.db"

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# db helpers
def db_conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def setup_db():
    conn = db_conn()
    c = conn.cursor()

    c.execute("""CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'recruiter'
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS assessments (
        id TEXT PRIMARY KEY,
        title TEXT,
        role TEXT,
        competencies TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        assessment_id TEXT,
        text TEXT,
        competency TEXT DEFAULT 'General',
        sequence INTEGER DEFAULT 1
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS candidates (
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
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS interviews (
        id TEXT PRIMARY KEY,
        assessment_id TEXT,
        candidate_id TEXT,
        status TEXT DEFAULT 'in_progress',
        overall_score REAL DEFAULT 0,
        summary TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY,
        interview_id TEXT,
        question_text TEXT,
        answer_text TEXT,
        score REAL DEFAULT 0,
        feedback TEXT,
        is_followup INTEGER DEFAULT 0,
        sequence INTEGER DEFAULT 1
    )""")

    # migration for old dbs that dont have hiring cols yet
    existing_cols = [r[1] for r in c.execute("PRAGMA table_info(candidates)").fetchall()]
    if "hiring_status" not in existing_cols:
        c.execute("ALTER TABLE candidates ADD COLUMN hiring_status TEXT DEFAULT 'pending'")
    if "hire_notes" not in existing_cols:
        c.execute("ALTER TABLE candidates ADD COLUMN hire_notes TEXT")

    # add default admin/recruiter if first run
    if not c.execute("SELECT id FROM users LIMIT 1").fetchone():
        c.execute("INSERT INTO users VALUES (?,?,?,?,?)",
            (str(uuid.uuid4()), "Admin", "admin@hirex.com", "admin123", "admin"))
        c.execute("INSERT INTO users VALUES (?,?,?,?,?)",
            (str(uuid.uuid4()), "Recruiter", "recruiter@hirex.com", "recruiter123", "recruiter"))

    conn.commit()
    conn.close()

setup_db()


# groq api call - tries a few models and falls back if one fails
def ask_groq(msgs, use_json=True):
    try:
        from groq import Groq
        g = Groq(api_key=API_KEY)
        model_list = [
            "llama-3.3-70b-versatile",
            "llama3-70b-8192",
            "llama-3.1-8b-instant"
        ]
        for m in model_list:
            try:
                kw = {"model": m, "messages": msgs, "temperature": 0.7, "max_tokens": 700}
                if use_json:
                    kw["response_format"] = {"type": "json_object"}
                resp = g.chat.completions.create(**kw)
                return resp.choices[0].message.content
            except Exception:
                continue  # try next model
    except Exception as err:
        print("groq error:", err)
    return None


def make_questions(role, resume=None):
    bg = resume[:2000] if resume else "no resume provided, applying for " + role
    prompt = (
        f"You are a technical interviewer. The candidate is applying for: {role}.\n"
        f"Their background: {bg}\n\n"
        "Write 3 interview questions tailored to their experience and this role.\n"
        "Return JSON only: {\"questions\": [{\"text\": \"...\", \"competency\": \"...\"}, ...]}"
    )
    raw = ask_groq([{"role": "user", "content": prompt}])
    if raw:
        try:
            parsed = json.loads(raw)
            qs = parsed.get("questions", [])
            if qs:
                return qs
        except:
            pass
    # fallback
    return [
        {"text": f"Tell me about yourself and your most relevant experience for the {role} role.", "competency": "Background"},
        {"text": "What's the hardest technical problem you've solved? How did you approach it?", "competency": "Problem Solving"},
        {"text": "How do you handle code reviews and maintain quality in your team?", "competency": "Collaboration"},
    ]


def score_answer(q, ans, role):
    prompt = (
        f"Interviewer role: {role}\n"
        f"Question asked: {q}\n"
        f"Candidate said: {ans}\n\n"
        "Rate this answer 1-10 and give brief feedback. Should there be a follow-up?\n"
        "Return JSON: {\"score\": 7, \"feedback\": \"...\", \"should_follow_up\": true, \"follow_up_question\": \"...\"}"
    )
    raw = ask_groq([{"role": "user", "content": prompt}])
    if raw:
        try:
            d = json.loads(raw)
            score = float(d.get("score") or 7)
            fb = d.get("feedback") or "Decent answer overall."
            fu = bool(d.get("should_follow_up") and d.get("follow_up_question"))
            fuq = d.get("follow_up_question") or ""
            return {"score": score, "feedback": fb, "should_follow_up": fu, "follow_up_question": fuq}
        except:
            pass
    # groq failed, return neutral
    return {"score": 7.0, "feedback": "Answer noted.", "should_follow_up": False, "follow_up_question": ""}


# request models
class StartReq(BaseModel):
    name: str
    email: Optional[str] = None
    dob: Optional[str] = None
    position: str
    resume_text: Optional[str] = None

class AnswerReq(BaseModel):
    question_text: str
    answer_text: str
    is_followup: Optional[bool] = False

class LoginReq(BaseModel):
    email: str
    password: str

class HireReq(BaseModel):
    status: str = "hired"
    notes: Optional[str] = None


# --- routes ---

@app.post("/api/candidate/start")
def start_interview(req: StartReq):
    name = req.name.strip()
    pos = req.position.strip()
    if not name or not pos:
        raise HTTPException(400, "Name and position required")

    email = req.email.strip() if req.email else name.lower().replace(" ", "") + "@example.com"

    conn = db_conn()
    c = conn.cursor()

    # create assessment record
    aid = str(uuid.uuid4())
    c.execute("INSERT INTO assessments (id, title, role, competencies) VALUES (?,?,?,?)",
              (aid, pos + " Interview", pos, "Technical, Problem Solving, Comm"))

    # generate questions via groq
    qs = make_questions(pos, req.resume_text)
    for i, q in enumerate(qs):
        c.execute("INSERT INTO questions (id, assessment_id, text, competency, sequence) VALUES (?,?,?,?,?)",
                  (str(uuid.uuid4()), aid, q["text"], q.get("competency", "Core"), i+1))

    cid = str(uuid.uuid4())
    c.execute("INSERT INTO candidates (id, assessment_id, name, email, dob, position, resume_text) VALUES (?,?,?,?,?,?,?)",
              (cid, aid, name, email, req.dob, pos, req.resume_text))

    iid = str(uuid.uuid4())
    c.execute("INSERT INTO interviews (id, assessment_id, candidate_id) VALUES (?,?,?)", (iid, aid, cid))

    conn.commit()
    conn.close()

    first_q = qs[0]["text"] if qs else "Tell me about yourself."
    return {
        "interviewId": iid,
        "candidateId": cid,
        "assessmentId": aid,
        "name": name,
        "position": pos,
        "question": first_q
    }


@app.get("/api/interview/{iid}")
def get_interview(iid: str):
    conn = db_conn()
    c = conn.cursor()
    row = c.execute("""
        SELECT i.*, c.name as candidate_name, c.position, a.title as assessment_title
        FROM interviews i
        JOIN candidates c ON i.candidate_id = c.id
        JOIN assessments a ON i.assessment_id = a.id
        WHERE i.id = ?
    """, (iid,)).fetchone()

    if not row:
        conn.close()
        raise HTTPException(404, "Interview not found")

    answers = c.execute("SELECT * FROM answers WHERE interview_id=? ORDER BY sequence", (iid,)).fetchall()
    questions = c.execute("SELECT * FROM questions WHERE assessment_id=? ORDER BY sequence", (row["assessment_id"],)).fetchall()
    conn.close()

    return {
        "interview": dict(row),
        "answers": [dict(a) for a in answers],
        "questions": [dict(q) for q in questions]
    }


@app.post("/api/interview/{iid}/answer")
def post_answer(iid: str, req: AnswerReq):
    ans = req.answer_text.strip()
    if not ans:
        raise HTTPException(400, "Answer can't be empty")

    conn = db_conn()
    c = conn.cursor()
    interview = c.execute("""
        SELECT i.*, c.position FROM interviews i
        JOIN candidates c ON i.candidate_id = c.id
        WHERE i.id = ?
    """, (iid,)).fetchone()

    if not interview:
        conn.close()
        raise HTTPException(404, "Interview not found")

    result = score_answer(req.question_text, ans, interview["position"])

    seq = (c.execute("SELECT COUNT(*) FROM answers WHERE interview_id=?", (iid,)).fetchone()[0] or 0) + 1
    c.execute("INSERT INTO answers (id, interview_id, question_text, answer_text, score, feedback, is_followup, sequence) VALUES (?,?,?,?,?,?,?,?)",
              (str(uuid.uuid4()), iid, req.question_text, ans,
               result["score"], result["feedback"], 1 if req.is_followup else 0, seq))

    if result["should_follow_up"] and not req.is_followup:
        conn.commit()
        conn.close()
        return {
            "hasFollowUp": True,
            "question": result["follow_up_question"],
            "score": result["score"],
            "feedback": result["feedback"]
        }

    all_qs = c.execute("SELECT * FROM questions WHERE assessment_id=? ORDER BY sequence", (interview["assessment_id"],)).fetchall()
    main_done = c.execute("SELECT COUNT(*) FROM answers WHERE interview_id=? AND is_followup=0", (iid,)).fetchone()[0]

    if main_done < len(all_qs):
        nq = all_qs[main_done]["text"]
        conn.commit()
        conn.close()
        return {"hasFollowUp": False, "nextQuestion": nq, "score": result["score"], "feedback": result["feedback"]}

    # done - compute final score
    all_scores = [r[0] for r in c.execute("SELECT score FROM answers WHERE interview_id=?", (iid,)).fetchall() if r[0]]
    avg = round(sum(all_scores)/len(all_scores), 1) if all_scores else 7.0

    c.execute("UPDATE interviews SET status='completed', overall_score=?, summary=? WHERE id=?",
              (avg, f"Interview done. Avg score: {avg}/10", iid))
    conn.commit()
    conn.close()

    return {"completed": True, "overallScore": avg, "message": "Interview completed!"}


@app.get("/api/interview/{iid}/report")
def get_report(iid: str):
    conn = db_conn()
    c = conn.cursor()
    row = c.execute("""
        SELECT i.*, c.name as candidate_name, c.email as candidate_email, c.position
        FROM interviews i
        JOIN candidates c ON i.candidate_id = c.id
        WHERE i.id = ?
    """, (iid,)).fetchone()

    if not row:
        conn.close()
        raise HTTPException(404, "Not found")

    ans = c.execute("SELECT * FROM answers WHERE interview_id=? ORDER BY sequence", (iid,)).fetchall()
    conn.close()
    return {"report": dict(row), "answers": [dict(a) for a in ans]}


@app.post("/api/auth/login")
def login(req: LoginReq):
    conn = db_conn()
    c = conn.cursor()
    usr = c.execute("SELECT * FROM users WHERE LOWER(email)=LOWER(?)", (req.email.strip(),)).fetchone()
    conn.close()

    if not usr:
        raise HTTPException(401, "Wrong email or password")

    # check plain text (dev mode) or bcrypt hash
    pw_hash = usr["password_hash"]
    if pw_hash.startswith("$2"):
        # bcrypt hash
        import bcrypt as _bcrypt
        ok = _bcrypt.checkpw(req.password.encode(), pw_hash.encode())
    else:
        # plain text (seeded by python)
        ok = pw_hash == req.password

    if not ok:
        raise HTTPException(401, "Wrong email or password")

    tok = "tok-" + uuid.uuid4().hex[:16]
    return {"token": tok, "user": {"id": usr["id"], "name": usr["name"], "email": usr["email"], "role": usr["role"]}}



@app.get("/api/recruiter/data")
def dashboard_data():
    conn = db_conn()
    c = conn.cursor()
    cands = c.execute("""
        SELECT c.*, i.id as interview_id, i.status, i.overall_score
        FROM candidates c
        LEFT JOIN interviews i ON i.candidate_id = c.id
        ORDER BY c.created_at DESC
    """).fetchall()
    roles = c.execute("""
        SELECT a.*, COUNT(c.id) as candidate_count
        FROM assessments a
        LEFT JOIN candidates c ON c.assessment_id = a.id
        GROUP BY a.id ORDER BY a.created_at DESC
    """).fetchall()
    conn.close()
    return {"candidates": [dict(x) for x in cands], "assessments": [dict(x) for x in roles]}


# admin: mark candidate as hired/rejected/etc
@app.post("/api/candidate/{cid}/hire")
def hire_candidate(cid: str, req: HireReq):
    s = req.status.lower().strip()
    valid_statuses = ["hired", "rejected", "pending", "shortlisted"]
    if s not in valid_statuses:
        raise HTTPException(400, "Status must be one of: " + ", ".join(valid_statuses))

    conn = db_conn()
    c = conn.cursor()
    cand = c.execute("SELECT * FROM candidates WHERE id=?", (cid,)).fetchone()
    if not cand:
        conn.close()
        raise HTTPException(404, "Candidate not found")

    # update status and notes
    c.execute("UPDATE candidates SET hiring_status=?, hire_notes=? WHERE id=?",
              (s, req.notes, cid))
    conn.commit()

    updated = c.execute("SELECT * FROM candidates WHERE id=?", (cid,)).fetchone()
    conn.close()

    return {
        "success": True,
        "message": updated["name"] + " marked as " + s.upper(),
        "candidate": dict(updated)
    }


@app.get("/health")
def health_check():
    return {"status": "ok"}


# serve static files (the HTML/CSS/JS frontend)
pub = os.path.join(os.path.dirname(__file__), "public")
if os.path.exists(pub):
    app.mount("/", StaticFiles(directory=pub, html=True), name="frontend")

if __name__ == "__main__":
    d = os.path.dirname(os.path.abspath(__file__))
    if d not in sys.path:
        sys.path.insert(0, d)
    print("Starting server on port", PORT)
    uvicorn.run(app, host="0.0.0.0", port=PORT)
