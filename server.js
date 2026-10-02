// hirex backend setup - handles interviews and candidate stuff
// started this project to learn fastapi but switched to node lol, then back to python

const express = require('express')
const path = require('path')
const db = require('./database')
const { v4: uuidv4 } = require('uuid')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

require('dotenv').config()

const app = express()
const PORT = process.env.PORT || 5000
const SECRET = process.env.JWT_SECRET || 'hirex_dev_key'
const GROQ_KEY = process.env.GROQ_API_KEY

app.use(require('cors')())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))


// helper to call groq - copied this pattern from their docs
async function callGroq(messages, wantJson) {
  const models = ['llama-3.3-70b-versatile', 'llama3-70b-8192']

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    try {
      const body = {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 700
      }
      if (wantJson) body.response_format = { type: 'json_object' }

      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + GROQ_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      })

      if (!r.ok) continue
      const data = await r.json()
      const txt = data?.choices?.[0]?.message?.content
      if (txt) return txt
    } catch (e) {
      // try next model
      console.log('model', model, 'failed:', e.message)
    }
  }
  return null
}


async function generateQuestions(position, resumeText) {
  const bg = resumeText ? resumeText.slice(0, 2000) : 'no resume - applying for ' + position
  const prompt = `You are doing a technical interview for: ${position}
Candidate background: ${bg}

Write 3 interview questions for this candidate based on their background.
JSON format: {"questions": [{"text": "...", "competency": "..."}, ...]}`

  const raw = await callGroq([{ role: 'user', content: prompt }], true)
  if (raw) {
    try {
      const p = JSON.parse(raw)
      if (p.questions && p.questions.length) return p.questions
    } catch (e) {}
  }

  // fallback if groq is down
  return [
    { text: `Walk me through your background and how it's relevant to the ${position} role.`, competency: 'Experience' },
    { text: 'What was the most challenging technical problem you faced recently?', competency: 'Problem Solving' },
    { text: 'How do you make sure your code stays maintainable long term?', competency: 'Code Quality' }
  ]
}


async function gradeAnswer(question, answer, position) {
  const prompt = `Role being interviewed for: ${position}
Question: "${question}"
Answer: "${answer}"

Give a score from 1-10 and feedback. Should there be a follow-up?
JSON: {"score": 7, "feedback": "...", "should_follow_up": false, "follow_up_question": ""}`

  const raw = await callGroq([{ role: 'user', content: prompt }], true)
  if (raw) {
    try {
      const d = JSON.parse(raw)
      return {
        score: Number(d.score) || 7,
        feedback: d.feedback || 'Good answer.',
        should_follow_up: !!(d.should_follow_up && d.follow_up_question),
        follow_up_question: d.follow_up_question || ''
      }
    } catch (e) {}
  }

  return { score: 7, feedback: 'Answer received.', should_follow_up: false, follow_up_question: '' }
}


// candidate registers and starts interview (no login needed for them)
app.post('/api/candidate/start', async (req, res) => {
  const { name, email, dob, position, resume_text } = req.body

  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' })
  if (!position || !position.trim()) return res.status(400).json({ error: 'position required' })

  const n = name.trim()
  const p = position.trim()
  const em = email?.trim() || n.toLowerCase().replace(/\s+/g, '') + '@example.com'

  try {
    const aid = uuidv4()
    db.prepare('INSERT INTO assessments (id, title, role, competencies) VALUES (?,?,?,?)')
      .run(aid, p + ' Interview', p, 'Technical, Problem Solving, Communication')

    const questions = await generateQuestions(p, resume_text)
    const insertQ = db.prepare('INSERT INTO questions (id, assessment_id, text, competency, sequence) VALUES (?,?,?,?,?)')
    questions.forEach((q, idx) => insertQ.run(uuidv4(), aid, q.text, q.competency || 'Core', idx + 1))

    const cid = uuidv4()
    db.prepare('INSERT INTO candidates (id, assessment_id, name, email, dob, position, resume_text) VALUES (?,?,?,?,?,?,?)')
      .run(cid, aid, n, em, dob || null, p, resume_text || null)

    const iid = uuidv4()
    db.prepare('INSERT INTO interviews (id, assessment_id, candidate_id, status) VALUES (?,?,?,?)')
      .run(iid, aid, cid, 'in_progress')

    const firstQ = questions[0]?.text || 'Tell me about yourself.'

    res.json({ interviewId: iid, candidateId: cid, assessmentId: aid, name: n, position: p, question: firstQ })
  } catch (err) {
    console.error('start interview error:', err)
    res.status(500).json({ error: 'something went wrong' })
  }
})


app.get('/api/interview/:id', (req, res) => {
  const interview = db.prepare(`
    SELECT i.*, c.name as candidate_name, c.position, a.title as assessment_title
    FROM interviews i
    JOIN candidates c ON i.candidate_id = c.id
    JOIN assessments a ON i.assessment_id = a.id
    WHERE i.id = ?
  `).get(req.params.id)

  if (!interview) return res.status(404).json({ error: 'not found' })

  const answers = db.prepare('SELECT * FROM answers WHERE interview_id=? ORDER BY sequence').all(req.params.id)
  const questions = db.prepare('SELECT * FROM questions WHERE assessment_id=? ORDER BY sequence').all(interview.assessment_id)

  res.json({ interview, answers, questions })
})


app.post('/api/interview/:id/answer', async (req, res) => {
  const { question_text, answer_text, is_followup } = req.body
  const iid = req.params.id

  if (!answer_text?.trim()) return res.status(400).json({ error: 'answer required' })

  const interview = db.prepare(`
    SELECT i.*, c.position, c.name FROM interviews i
    JOIN candidates c ON i.candidate_id = c.id WHERE i.id = ?
  `).get(iid)

  if (!interview) return res.status(404).json({ error: 'not found' })

  try {
    const result = await gradeAnswer(question_text, answer_text.trim(), interview.position)

    const seq = (db.prepare('SELECT COUNT(*) as n FROM answers WHERE interview_id=?').get(iid)?.n || 0) + 1
    db.prepare('INSERT INTO answers (id, interview_id, question_text, answer_text, score, feedback, is_followup, sequence) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuidv4(), iid, question_text, answer_text.trim(), result.score, result.feedback, is_followup ? 1 : 0, seq)

    if (result.should_follow_up && !is_followup) {
      return res.json({
        hasFollowUp: true,
        question: result.follow_up_question,
        score: result.score,
        feedback: result.feedback
      })
    }

    const qs = db.prepare('SELECT * FROM questions WHERE assessment_id=? ORDER BY sequence').all(interview.assessment_id)
    const mainDone = db.prepare('SELECT COUNT(*) as n FROM answers WHERE interview_id=? AND is_followup=0').get(iid)?.n || 0

    if (mainDone < qs.length) {
      return res.json({
        hasFollowUp: false,
        nextQuestion: qs[mainDone].text,
        score: result.score,
        feedback: result.feedback
      })
    }

    // all done
    const scores = db.prepare('SELECT score FROM answers WHERE interview_id=?').all(iid)
    const total = scores.reduce((s, a) => s + (a.score || 0), 0)
    const avg = scores.length ? Math.round(total / scores.length * 10) / 10 : 7.0

    db.prepare("UPDATE interviews SET status='completed', overall_score=?, summary=? WHERE id=?")
      .run(avg, `Done. Avg score: ${avg}/10`, iid)

    res.json({ completed: true, overallScore: avg, message: 'Interview complete!' })
  } catch (err) {
    console.error('answer error:', err)
    res.status(500).json({ error: 'evaluation failed' })
  }
})


app.get('/api/interview/:id/report', (req, res) => {
  const interview = db.prepare(`
    SELECT i.*, c.name as candidate_name, c.email as candidate_email, c.position
    FROM interviews i JOIN candidates c ON i.candidate_id = c.id WHERE i.id = ?
  `).get(req.params.id)

  if (!interview) return res.status(404).json({ error: 'not found' })

  const answers = db.prepare('SELECT * FROM answers WHERE interview_id=? ORDER BY sequence').all(req.params.id)
  res.json({ report: interview, answers })
})


app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'email and password needed' })

  const user = db.prepare('SELECT * FROM users WHERE LOWER(email)=?').get(email.toLowerCase().trim())
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'bad credentials' })
  }

  const tok = jwt.sign({ id: user.id, name: user.name, role: user.role }, SECRET, { expiresIn: '7d' })
  res.json({ token: tok, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})


app.get('/api/recruiter/data', (req, res) => {
  const cands = db.prepare(`
    SELECT c.*, i.id as interview_id, i.status, i.overall_score
    FROM candidates c
    LEFT JOIN interviews i ON i.candidate_id = c.id
    ORDER BY c.created_at DESC
  `).all()

  const roles = db.prepare(`
    SELECT a.*, COUNT(c.id) as candidate_count
    FROM assessments a
    LEFT JOIN candidates c ON c.assessment_id = a.id
    GROUP BY a.id ORDER BY a.created_at DESC
  `).all()

  res.json({ candidates: cands, assessments: roles })
})


// admin can mark someone as hired/rejected etc
app.post('/api/candidate/:id/hire', (req, res) => {
  const { status, notes } = req.body
  const validStatuses = ['hired', 'rejected', 'pending', 'shortlisted']

  if (!validStatuses.includes(status?.toLowerCase())) {
    return res.status(400).json({ error: 'invalid status' })
  }

  const s = status.toLowerCase()
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(req.params.id)
  if (!cand) return res.status(404).json({ error: 'candidate not found' })

  db.prepare('UPDATE candidates SET hiring_status=?, hire_notes=? WHERE id=?')
    .run(s, notes || cand.hire_notes, req.params.id)

  const updated = db.prepare('SELECT * FROM candidates WHERE id=?').get(req.params.id)
  res.json({
    success: true,
    message: updated.name + ' marked as ' + s.toUpperCase(),
    candidate: updated
  })
})


app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => {
  console.log('server running on port', PORT)
})
