# HIREX - Hiring & Interview System

Simple hiring and interview platform built with **Python**, **HTML**, **CSS**, and **Vanilla JavaScript**.

No `node_modules` or npm dependencies required — all backend logic runs through Python and serves the static frontend directly.

---

## What It Does

- **Candidate Interviews**: Candidates enter their details, pick a role, and take an interview with customizable questions and instant answer reviews.
- **Admin Dashboard**:
  - View all candidates and their assessment scores.
  - **Hire Candidates**: 1-click quick hire button or custom decision modal (Hire, Shortlist, Reject, Keep Pending).
  - Add admin feedback/hiring notes that show up directly in the candidate list.
  - Filter candidates by status (`All`, `Hired`, `Shortlisted`, `Pending`, `Rejected`).
- **Voice-to-Text Support**: Built-in speech recognition for verbal answers during interviews.
- **SQLite Database**: Lightweight SQLite DB (`hirex.db`) tracking candidates, questions, answers, and recruiter accounts.

---

## Tech Stack

- **Backend**: Python 3 (FastAPI, Uvicorn, SQLite3, bcrypt)
- **Frontend**: Plain HTML5, CSS3, Vanilla JavaScript (located in `public/`)
- **No Node Modules**: Runs 100% dependency-free on the Node side.

---

## How to Run

### Option 1: Double click `start.bat`
Just run `start.bat` on Windows.

### Option 2: Run via Terminal
```bash
python server.py
```

Then open your browser at:
```
http://localhost:5000
```

---

## Default Admin Credentials

- **Email**: `admin@hirex.com`
- **Password**: `admin123`

---

## Project Structure

```
hirex/
├── server.py           # Main backend API and static file server (Python)
├── hirex.db            # SQLite database file
├── start.bat           # 1-click launch script
├── public/             # Frontend files (no build step needed)
│   ├── index.html      # Landing & candidate registration page
│   ├── interview.html  # Live interview room with speech input
│   ├── dashboard.html  # Admin & recruiter dashboard with hiring tools
│   ├── style.css       # Clean stylesheet
│   └── app.js          # Client-side scripts & API integrations
└── README.md
```
