import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, Course, Quiz, QuizSummary, AttemptResult } from '../lib/api';
import Header from '../components/Header';

export default function StudentClass() {
  const { id } = useParams();
  const [course, setCourse] = useState<Course | null>(null);
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [taking, setTaking] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<number[]>([]);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!id) return;
    Promise.all([api.getCourse(id), api.listQuizzes(id)])
      .then(([c, q]) => { setCourse(c); setQuizzes(q.quizzes); })
      .catch((e) => setErr(e.message));
  }, [id]);

  async function startQuiz(quizId: string) {
    setErr(''); setResult(null);
    try {
      const q = await api.takeQuiz(quizId);
      setTaking(q);
      setAnswers(new Array(q.questions.length).fill(-1));
    } catch (e: any) { setErr(e.message); }
  }

  async function submit() {
    if (!taking) return;
    if (answers.some((a) => a < 0)) { setErr('Answer every question first.'); return; }
    setBusy(true); setErr('');
    try {
      const res = await api.submitAttempt(taking.id, answers);
      setResult(res);
      setTaking(null);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  // ── Result view ──
  if (result) {
    const pct = Math.round((result.score / Math.max(result.total, 1)) * 100);
    return (
      <div className="page">
        <Header subtitle="Student" />
        <main className="container">
          <a className="muted small" onClick={() => setResult(null)}>← Back to {course?.name}</a>
          <h1>{result.topic}</h1>
          <div className="stat-card" style={{ maxWidth: 260 }}>
            <span className="label">Your score</span>
            <div className="stat-num">{pct}<small>%</small></div>
            <div className="stat-sub">{result.score} of {result.total} correct</div>
          </div>

          {result.results.map((r, i) => (
            <div key={i} className="card">
              <div className="row-between">
                <span className="label">Question {i + 1}</span>
                <span className="pill" style={r.correct ? {} : { background: 'rgba(255,90,31,.12)' }}>
                  {r.correct ? '✓ correct' : '✗ incorrect'}
                </span>
              </div>
              <p style={{ fontWeight: 600, marginTop: 6 }}>{r.prompt}</p>
              {r.options.map((o, oi) => {
                const isCorrect = oi === r.correct_index;
                const isYours = oi === r.your_index;
                const bg = isCorrect ? 'rgba(76,175,80,.12)' : (isYours ? 'rgba(255,90,31,.12)' : 'transparent');
                const border = isCorrect ? '#3a9d4d' : (isYours ? 'var(--orange)' : 'var(--line)');
                return (
                  <div key={oi} style={{ padding: '7px 11px', border: `1px solid ${border}`, background: bg, borderRadius: 9, marginBottom: 6, fontSize: 13 }}>
                    {o} {isCorrect && <strong style={{ color: '#5bbf6a' }}>✓</strong>} {isYours && !isCorrect && <span className="muted">— your answer</span>}
                  </div>
                );
              })}
              {r.explanation && <p className="muted small" style={{ marginTop: 6 }}>{r.explanation}</p>}
            </div>
          ))}
        </main>
      </div>
    );
  }

  // ── Taking view ──
  if (taking) {
    return (
      <div className="page">
        <Header subtitle="Student" />
        <main className="container">
          <a className="muted small" onClick={() => setTaking(null)}>← Cancel</a>
          <h1>{taking.topic}</h1>
          {taking.questions.map((q, i) => (
            <div key={i} className="card">
              <span className="label">Question {i + 1}</span>
              <p style={{ fontWeight: 600, marginTop: 6 }}>{q.prompt}</p>
              {q.options.map((o, oi) => (
                <label key={oi} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', cursor: 'pointer', fontWeight: 400, margin: 0 }}>
                  <input type="radio" name={`q-${i}`} checked={answers[i] === oi}
                    onChange={() => setAnswers(answers.map((a, k) => k === i ? oi : a))} />
                  <span style={{ fontSize: 13 }}>{o}</span>
                </label>
              ))}
            </div>
          ))}
          {err && <p className="msg">{err}</p>}
          <button className="btn primary" disabled={busy} onClick={submit} style={{ width: 'auto' }}>
            {busy ? 'Grading…' : 'Submit answers'}
          </button>
        </main>
      </div>
    );
  }

  // ── Quiz list ──
  return (
    <div className="page">
      <Header subtitle="Student" />
      <main className="container">
        <Link to="/" className="muted small">← My classes</Link>
        <h1>{course?.name || 'Class'}</h1>

        <div className="card tip">
          <strong>💡</strong> Ask the tutor about this course any time in the RabbitHole extension — by voice or text.
        </div>

        <h2>Quizzes</h2>
        {err && <p className="msg">{err}</p>}
        {quizzes.length === 0 ? (
          <p className="muted">No quizzes published yet. Check back soon.</p>
        ) : (
          quizzes.map((q) => (
            <div key={q.id} className="card row-between" style={{ padding: '14px 18px' }}>
              <div>
                <strong style={{ fontFamily: 'Outfit' }}>{q.topic}</strong>
                <div className="muted small">{q.question_count} questions</div>
              </div>
              <button className="btn primary small" style={{ marginTop: 0, width: 'auto' }} onClick={() => startQuiz(q.id)}>Take quiz</button>
            </div>
          ))
        )}
      </main>
    </div>
  );
}
