import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, Course, Quiz, QuizSummary, AttemptResult, Progress, Recommendations } from '../lib/api';
import Header from '../components/Header';
import { ComprehensionChart, TopicMasteryBars } from '../components/Charts';
import { useAuth } from '../auth/AuthContext';

export default function StudentClass() {
  const { id } = useParams();
  const { profile } = useAuth();
  const [course, setCourse] = useState<Course | null>(null);
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [taking, setTaking] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<number[]>([]);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [recsLoading, setRecsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function loadProgress() {
    if (id) api.myProgress(id).then(setProgress).catch(() => {});
  }
  function loadRecs(topic?: string) {
    if (!id) return;
    setRecsLoading(true);
    api.recommendations(id, topic).then(setRecs).catch(() => {}).finally(() => setRecsLoading(false));
  }
  useEffect(() => {
    if (!id) return;
    Promise.all([api.getCourse(id), api.listQuizzes(id)])
      .then(([c, q]) => { setCourse(c); setQuizzes(q.quizzes); })
      .catch((e) => setErr(e.message));
    loadProgress();
    loadRecs();
  }, [id]);

  const weeks = (course?.processed?.weeks || []) as any[];

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
      loadProgress();   // refresh my stats after the attempt
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
              {q.options.map((o, oi) => {
                const sel = answers[i] === oi;
                return (
                  <label key={oi} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginTop: 8,
                    cursor: 'pointer', fontWeight: 400, border: `1.5px solid ${sel ? 'var(--orange)' : 'var(--line)'}`,
                    borderRadius: 10, background: sel ? 'rgba(255,90,31,.08)' : 'transparent',
                  }}>
                    <input type="radio" name={`q-${i}`} checked={sel}
                      onChange={() => setAnswers(answers.map((a, k) => k === i ? oi : a))} />
                    <span style={{ fontSize: 13 }}>{o}</span>
                  </label>
                );
              })}
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
        <div className="row-between">
          <Link to="/" className="muted small">← My classes</Link>
          {course && profile && course.owner_id === profile.id && (
            <Link to={`/course/${id}/quizzes`} className="btn primary small" style={{ marginTop: 0, width: 'auto', textDecoration: 'none' }}>
              Manage quizzes →
            </Link>
          )}
        </div>
        <h1>{course?.name || 'Class'}</h1>

        <div className="card tip">
          <strong>💡</strong> Ask the tutor about this course any time in the RabbitHole extension — by voice or text.
        </div>

        {progress && progress.attempt_count > 0 && (
          <>
            <h2>My progress</h2>
            <div className="stat-grid">
              <div className="stat-card">
                <span className="label">My comprehension</span>
                <div className="stat-num">{progress.comprehension}<small>%</small></div>
                <div className="stat-sub">across {progress.attempt_count} quiz attempt{progress.attempt_count === 1 ? '' : 's'}</div>
              </div>
              {progress.weakest_topic && (
                <div className="stat-card">
                  <span className="label">Focus next on</span>
                  <div className="stat-strong">{progress.weakest_topic.topic}</div>
                  <div className="stat-sub">your weakest topic ({progress.weakest_topic.pct}%)</div>
                </div>
              )}
            </div>
            <div className="card"><ComprehensionChart data={progress.over_time} /></div>
            {progress.topic_mastery.length > 0 && (
              <div className="card"><TopicMasteryBars data={progress.topic_mastery} /></div>
            )}
          </>
        )}

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

        <h2>Recommended readings</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Sources from Semantic Scholar, matched to your syllabus. Pick a topic to refine.</p>
        {weeks.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 14px' }}>
            <button className="btn ghost small" onClick={() => loadRecs()}>Whole course</button>
            {weeks.map((w: any) => (
              <button key={w.week} className="btn ghost small" onClick={() => loadRecs(w.topic)}>
                Wk {w.week}: {String(w.topic).slice(0, 24)}
              </button>
            ))}
          </div>
        )}
        {recsLoading && <p className="muted">Finding readings…</p>}
        {recs && !recsLoading && (
          <>
            <p className="label">{recs.topic}</p>
            {recs.papers.length === 0 ? (
              <p className="muted small">No readings found — try a different topic.</p>
            ) : (
              <div className="grid">
                {recs.papers.map((p, i) => (
                  <a key={i} href={p.url || '#'} target="_blank" rel="noreferrer" className="card course-card">
                    <div style={{ fontFamily: 'Outfit', fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{p.title}</div>
                    <div className="muted small" style={{ marginBottom: 6 }}>
                      {p.year || '—'} · {p.citations || 0} citations
                    </div>
                    {p.abstract && <div className="muted small" style={{ lineHeight: 1.5 }}>{p.abstract}</div>}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
