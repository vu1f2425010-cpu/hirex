// app.js - frontend logic for hirex
// handles the interview flow, dashboard, and admin hiring stuff

let currentQuestion = ''
let isFollowup = false
let isRecording = false
let recog = null
let allCands = []
let activeFilter = 'all'


// index page tab switch
function switchTab(tab) {
  const cForm = document.getElementById('candidate-form')
  const rForm = document.getElementById('recruiter-form')
  const cBtn = document.getElementById('tab-candidate-btn')
  const rBtn = document.getElementById('tab-recruiter-btn')
  const alert = document.getElementById('alert-box')

  if (alert) alert.style.display = 'none'

  if (tab === 'candidate') {
    cForm && (cForm.style.display = 'block')
    rForm && (rForm.style.display = 'none')
    cBtn && cBtn.classList.add('active')
    rBtn && rBtn.classList.remove('active')
  } else {
    cForm && (cForm.style.display = 'none')
    rForm && (rForm.style.display = 'block')
    cBtn && cBtn.classList.remove('active')
    rBtn && rBtn.classList.add('active')
  }
}

function fillDemo(email, pw) {
  document.getElementById('rec-email').value = email
  document.getElementById('rec-password').value = pw
}

function showAlert(msg) {
  const box = document.getElementById('alert-box')
  if (box) {
    box.innerText = msg
    box.style.display = 'block'
  } else {
    alert(msg)
  }
}


// candidate submits their info and starts the interview
async function handleCandidateSubmit(e) {
  e.preventDefault()

  const name = document.getElementById('cand-name').value.trim()
  const email = document.getElementById('cand-email').value.trim()
  const dob = document.getElementById('cand-dob').value
  const pos = document.getElementById('cand-pos').value.trim()
  const resume = document.getElementById('cand-resume').value.trim()

  if (!name || !pos) {
    showAlert('Fill in your name and the position you want.')
    return
  }

  const btn = document.getElementById('cand-submit-btn')
  btn.disabled = true
  btn.innerText = 'Generating questions...'

  try {
    const r = await fetch('/api/candidate/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, dob, position: pos, resume_text: resume })
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.detail || data.error || 'Failed to start.')

    localStorage.setItem('hirex_interview_id', data.interviewId)
    localStorage.setItem('hirex_cand_name', data.name)
    localStorage.setItem('hirex_pos', data.position)

    window.location.href = '/interview.html?id=' + data.interviewId
  } catch (err) {
    showAlert(err.message)
    btn.disabled = false
    btn.innerText = 'Start AI Interview'
  }
}


async function handleRecruiterLogin(e) {
  e.preventDefault()
  const email = document.getElementById('rec-email').value.trim()
  const pw = document.getElementById('rec-password').value
  const btn = document.getElementById('rec-submit-btn')

  btn.disabled = true
  btn.innerText = 'Signing in...'

  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pw })
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.detail || data.error || 'Login failed.')

    localStorage.setItem('hirex_token', data.token)
    localStorage.setItem('hirex_user', JSON.stringify(data.user))
    window.location.href = '/dashboard.html'
  } catch (err) {
    showAlert(err.message)
    btn.disabled = false
    btn.innerText = 'Sign In to Dashboard'
  }
}


// ---- interview page ----

async function initInterviewPage() {
  const params = new URLSearchParams(window.location.search)
  const iid = params.get('id') || localStorage.getItem('hirex_interview_id')

  if (!iid) { window.location.href = '/'; return }

  try {
    const r = await fetch('/api/interview/' + iid)
    const data = await r.json()
    if (!r.ok) throw new Error(data.detail || data.error || 'Couldnt load interview')

    document.getElementById('cand-display-name').innerText = data.interview.candidate_name + "'s Interview"
    document.getElementById('cand-display-pos').innerText = 'Applying for: ' + data.interview.position

    const chatBox = document.getElementById('chat-box')
    chatBox.innerHTML = ''

    if (data.interview.status === 'completed') {
      showCompleted(data.interview, data.answers)
      return
    }

    // show previous answers if rejoining
    if (data.answers && data.answers.length > 0) {
      data.answers.forEach((a, i) => {
        addBubble('ai', a.question_text, a.is_followup ? 'Follow-Up' : 'Q' + (i+1))
        addBubble('user', a.answer_text, 'You')
      })
    }

    const done = data.answers ? data.answers.filter(a => !a.is_followup).length : 0
    if (data.questions && data.questions[done]) {
      const q = data.questions[done]
      currentQuestion = q.text
      isFollowup = false
      addBubble('ai', q.text, 'Question ' + (done+1))
    } else if (data.questions && data.questions.length) {
      showCompleted(data.interview, data.answers)
    }
  } catch (err) {
    alert(err.message)
  }
}


function addBubble(who, text, label) {
  const box = document.getElementById('chat-box')
  const el = document.createElement('div')
  el.className = who === 'ai' ? 'bubble bubble-ai' : 'bubble bubble-user'

  if (label) {
    const lbl = document.createElement('div')
    lbl.style.cssText = 'font-size:0.75rem;font-weight:700;margin-bottom:4px;'
    lbl.style.color = who === 'ai' ? 'var(--primary)' : '#fff'
    lbl.innerText = label
    el.appendChild(lbl)
  }

  const txt = document.createElement('div')
  txt.innerText = text
  el.appendChild(txt)

  box.appendChild(el)
  el.scrollIntoView({ behavior: 'smooth' })
}


async function handleAnswerSubmit(e) {
  e.preventDefault()

  const input = document.getElementById('answer-input')
  const ans = input.value.trim()
  if (!ans) return

  const params = new URLSearchParams(window.location.search)
  const iid = params.get('id') || localStorage.getItem('hirex_interview_id')

  const btn = document.getElementById('submit-answer-btn')
  const loading = document.getElementById('ai-loading')

  addBubble('user', ans, 'You')
  input.value = ''
  btn.disabled = true
  loading.style.display = 'flex'

  if (isRecording && recog) {
    recog.stop()
    isRecording = false
    document.getElementById('voice-btn').innerText = 'Speak Answer'
  }

  try {
    const r = await fetch('/api/interview/' + iid + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question_text: currentQuestion,
        answer_text: ans,
        is_followup: isFollowup
      })
    })
    const data = await r.json()
    loading.style.display = 'none'
    btn.disabled = false

    if (!r.ok) throw new Error(data.detail || data.error || 'Error evaluating answer')

    if (data.hasFollowUp) {
      currentQuestion = data.question
      isFollowup = true
      addBubble('ai', data.question, 'Follow-Up')
    } else if (data.nextQuestion) {
      currentQuestion = data.nextQuestion
      isFollowup = false
      addBubble('ai', data.nextQuestion, 'Next Question')
    } else if (data.completed) {
      const rr = await fetch('/api/interview/' + iid + '/report')
      const rd = await rr.json()
      showCompleted(rd.report, rd.answers)
    }
  } catch (err) {
    loading.style.display = 'none'
    btn.disabled = false
    alert(err.message)
  }
}


function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) { alert('Voice not supported in this browser'); return }

  const vBtn = document.getElementById('voice-btn')
  const inp = document.getElementById('answer-input')

  if (isRecording) {
    recog.stop()
    isRecording = false
    vBtn.innerText = 'Speak Answer'
    return
  }

  recog = new SR()
  recog.continuous = true
  recog.interimResults = true
  recog.onresult = ev => {
    let t = ''
    for (let i = ev.resultIndex; i < ev.results.length; i++) t += ev.results[i][0].transcript
    inp.value = inp.value ? inp.value + ' ' + t : t
  }
  recog.onend = () => {
    isRecording = false
    vBtn.innerText = 'Speak Answer'
  }
  recog.start()
  isRecording = true
  vBtn.innerText = 'Recording... (click to stop)'
}


function showCompleted(report, answers) {
  document.getElementById('interview-active-view').style.display = 'none'
  document.getElementById('interview-report-view').style.display = 'block'
  document.getElementById('interview-badge').innerText = 'Done'
  document.getElementById('interview-badge').className = 'badge badge-green'
  document.getElementById('final-score').innerText = (report.overall_score || 0) + ' / 10'

  const list = document.getElementById('transcript-list')
  list.innerHTML = ''

  ;(answers || []).forEach((item, i) => {
    const d = document.createElement('div')
    d.style.cssText = 'background:var(--bg);padding:14px;border-radius:var(--radius);border:1px solid var(--border);margin-bottom:10px;'
    d.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="font-weight:700;color:var(--primary)">Q${i+1} ${item.is_followup ? '(follow-up)' : ''}</span>
        <span class="badge badge-orange">${item.score}/10</span>
      </div>
      <div style="font-weight:600;margin-bottom:5px">${item.question_text}</div>
      <div style="background:#fff;padding:8px;border-radius:5px;font-size:0.9rem;border:1px solid var(--border);margin-bottom:5px">
        <b>Answer:</b> ${item.answer_text}
      </div>
      <div style="font-size:0.85rem;color:var(--muted);font-style:italic">
        AI Feedback: ${item.feedback || 'Good job.'}
      </div>
    `
    list.appendChild(d)
  })
}


// ---- dashboard page ----

async function initDashboardPage() {
  const user = JSON.parse(localStorage.getItem('hirex_user') || '{}')
  if (user.name) {
    document.getElementById('user-greeting').innerText = user.name + ' (' + (user.role || 'admin').toUpperCase() + ')'
  }
  await loadData()
}


async function loadData() {
  try {
    const r = await fetch('/api/recruiter/data')
    const data = await r.json()
    if (!r.ok) throw new Error('Failed to load')

    allCands = data.candidates || []

    document.getElementById('total-candidates').innerText = allCands.length
    document.getElementById('total-assessments').innerText = data.assessments?.length || 0
    document.getElementById('completed-interviews').innerText = allCands.filter(c => c.status === 'completed').length

    const hiredEl = document.getElementById('total-hired')
    if (hiredEl) hiredEl.innerText = allCands.filter(c => c.hiring_status === 'hired').length

    renderTable()
  } catch (err) {
    alert(err.message)
  }
}


function setCandidateFilter(f) {
  activeFilter = f
  document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'))
  event.target.classList.add('active')
  renderTable()
}


function renderTable() {
  const tbody = document.getElementById('candidates-tbody')
  tbody.innerHTML = ''

  let list = allCands
  if (activeFilter === 'hired') list = allCands.filter(c => c.hiring_status === 'hired')
  else if (activeFilter === 'shortlisted') list = allCands.filter(c => c.hiring_status === 'shortlisted')
  else if (activeFilter === 'pending') list = allCands.filter(c => !c.hiring_status || c.hiring_status === 'pending')
  else if (activeFilter === 'rejected') list = allCands.filter(c => c.hiring_status === 'rejected')

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted)">Nothing here yet</td></tr>'
    return
  }

  list.forEach(c => {
    const hs = c.hiring_status || 'pending'
    let badge = '<span class="badge badge-pending">Pending</span>'
    if (hs === 'hired') badge = '<span class="badge badge-hired">Hired</span>'
    else if (hs === 'shortlisted') badge = '<span class="badge badge-shortlisted">Shortlisted</span>'
    else if (hs === 'rejected') badge = '<span class="badge badge-rejected">Rejected</span>'

    let actions = ''
    if (hs === 'hired') {
      actions = `<div style="display:flex;gap:6px;">
        <button class="btn btn-secondary btn-sm" onclick="openModal('${c.id}')">Edit</button>
        ${c.interview_id ? '<a href="/interview.html?id=' + c.interview_id + '" class="btn btn-secondary btn-sm">Report</a>' : ''}
      </div>`
    } else {
      actions = `<div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn-hire" onclick="quickHire('${c.id}', '${c.name.replace(/'/g, "\\'")}')">Hire</button>
        <button class="btn btn-secondary btn-sm" onclick="openModal('${c.id}')">Decision</button>
        ${c.interview_id ? '<a href="/interview.html?id=' + c.interview_id + '" class="btn btn-secondary btn-sm">Report</a>' : ''}
      </div>`
    }

    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>
        <strong>${c.name}</strong><br>
        <span style="font-size:0.8rem;color:var(--muted)">${c.email}</span>
        ${c.hire_notes ? '<div style="font-size:0.75rem;color:#047857;margin-top:2px">' + c.hire_notes + '</div>' : ''}
      </td>
      <td><span class="badge badge-orange">${c.position}</span></td>
      <td><strong>${c.overall_score ? c.overall_score + '/10' : '-'}</strong></td>
      <td><span class="badge ${c.status === 'completed' ? 'badge-green' : 'badge-orange'}">${c.status || 'pending'}</span></td>
      <td>${badge}</td>
      <td>${actions}</td>
    `
    tbody.appendChild(tr)
  })
}


// quick 1-click hire
async function quickHire(cid, cname) {
  if (!confirm('Hire ' + cname + '?')) return
  try {
    const r = await fetch('/api/candidate/' + cid + '/hire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'hired', notes: 'Hired via dashboard' })
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.detail || d.error || 'Failed')
    await loadData()
  } catch (err) {
    alert(err.message)
  }
}


function openModal(cid) {
  const c = allCands.find(x => x.id === cid)
  if (!c) return

  document.getElementById('modal-cand-id').value = c.id
  document.getElementById('modal-cand-name').innerText = c.name
  document.getElementById('modal-cand-pos').innerText = c.position + ' — ' + c.email
  document.getElementById('modal-cand-score').innerText = c.overall_score ? c.overall_score + '/10' : 'not scored yet'
  document.getElementById('modal-status-select').value = c.hiring_status || 'hired'
  document.getElementById('modal-hire-notes').value = c.hire_notes || ''
  document.getElementById('hire-modal').style.display = 'flex'
}

function closeHireModal() {
  document.getElementById('hire-modal').style.display = 'none'
}

async function handleHireModalSubmit(e) {
  e.preventDefault()
  const cid = document.getElementById('modal-cand-id').value
  const status = document.getElementById('modal-status-select').value
  const notes = document.getElementById('modal-hire-notes').value.trim()

  try {
    const r = await fetch('/api/candidate/' + cid + '/hire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, notes })
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.detail || d.error || 'Failed')
    closeHireModal()
    await loadData()
  } catch (err) {
    alert(err.message)
  }
}


function logoutRecruiter() {
  localStorage.removeItem('hirex_token')
  localStorage.removeItem('hirex_user')
  window.location.href = '/'
}
