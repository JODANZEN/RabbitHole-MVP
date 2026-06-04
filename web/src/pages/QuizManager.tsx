import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, Course, Quiz, QuizSummary, QuizQuestion } from '../lib/api';
import Header from '../components/Header';
import { useAuth } from '../auth/AuthContext';

export default function QuizManager() {
  const { id } = useParams();
  const { profile } = useAuth();
  const isTeacher = profile?.role === 'teacher';
  const backTo = isTeacher ? `/course/${id}` : `/class/${id}`;
  const [course, setCourse] = useState<Course | null>(null);
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [editing, setEditing] = useState<Quiz | null>(null);
  const [topic, setTopic] = useState('');
  const [week, setWeek] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [matTitle, setMatTitle] = useState('');
  const [matText, setMatText] = useState('');

  async function load() {
    if (!id) return;
    try {
      const [c, q] = await Promise.all([api.getCourse(id), api.listQuizzes(id)]);
      setCourse(c); setQuizzes(q.quizzes);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [id]);

  const weeks = (course?.processed?.weeks || []) as { week: number; topic: string }[];

  async function generate() {
    if (!id || topic.trim().length < 3) { setErr('Pick a topic to generate from.'); return; }
    setBusy('gen'); setErr('');
    try {
      const quiz = await api.genQuiz(id, topic.trim(), week, 5);
      setTopic(''); setWeek(null);
      await load();
      setEditing(quiz);   // jump straight into review
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(''); }
  }

  async function openEditor(quizId: string) {
    setErr('');
    try { setEditing(await api.getQuiz(quizId)); }
    catch (e: any) { setErr(e.message); }
  }

  function patchQ(i: number, patch: Partial<QuizQuestion>) {
    if (!editing) return;
    const qs = editing.questions.map((q, idx) => idx === i ? { ...q, ...patch } : q);
    setEditing({ ...editing, questions: qs });
  }
  function patchOption(i: number, oi: number, val: string) {
    if (!editing) return;
    const qs = editing.questions.map((q, idx) => {
      if (idx !== i) return q;
      const options = q.options.map((o, k) => k === oi ? val : o);
      return { ...q, options };
    });
    setEditing({ ...editing, questions: qs });
  }
  function addQuestion() {
    if (!editing) return;
    setEditing({ ...editing, questions: [...editing.questions, { prompt: '', options: ['', '', '', ''], correct_index: 0, explanation: '' }] });
  }
  function removeQuestion(i: number) {
    if (!editing) return;
    setEditing({ ...editing, questions: editing.questions.filter((_, idx) => idx !== i) });
  }

  async function save(status?: string) {
    if (!editing) return;
    setBusy('save'); setErr('');
    try {
      await api.updateQuiz(editing.id, editing.questions, status);
      setEditing(null);
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(''); }
  }

  async function removeQuiz(quizId: string) {
    if (!confirm('Delete this quiz?')) return;
    try { await api.deleteQuiz(quizId); await load(); }
    catch (e: any) { setErr(e.message); }
  }

  async function addMaterial(e: React.FormEvent) {
    e.preventDefault();
    if (!id || matText.trim().length < 50) { setErr('Paste at least a paragraph of material.'); return; }
    setBusy('mat'); setErr('');
    try {
      const r = await api.addReading(id, matTitle.trim() || 'Untitled', matText);
      setMatTitle(''); setMatText('');
      setErr(''); alert(`Added (${r.chunks} chunks embedded). New quizzes will draw on it.`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(''); }
  }

  // ── Editor view ──
  if (editing) {
    return (
      <div className="page">
        <Header subtitle={isTeacher ? 'Teacher' : 'Student'} />
        <main className="container">
          <a className="muted small" onClick={() => setEditing(null)}>← Back to quizzes</a>
          <div className="row-between">
            <h1>Review · {editing.topic}</h1>
            <span className="pill">{editing.status}</span>
          </div>
          <p className="muted small">Edit anything below, then publish to make it visible to students.</p>

          {editing.questions.map((q, i) => (
            <div key={i} className="card">
              <div className="row-between">
                <span className="label">Question {i + 1}</span>
                <a className="muted small" onClick={() => removeQuestion(i)}>Remove</a>
              </div>
              <textarea rows={2} value={q.prompt} onChange={(e) => patchQ(i, { prompt: e.target.value })} placeholder="Question prompt" />
              {q.options.map((o, oi) => (
                <div key={oi} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <input type="radio" name={`correct-${i}`} checked={q.correct_index === oi} onChange={() => patchQ(i, { correct_index: oi })} title="Mark correct" />
                  <input value={o} onChange={(e) => patchOption(i, oi, e.target.value)} placeholder={`Option ${oi + 1}`} style={{ flex: 1 }} />
                </div>
              ))}
              <label>Explanation</label>
              <input value={q.explanation} onChange={(e) => patchQ(i, { explanation: e.target.value })} placeholder="Why the answer is correct" />
            </div>
          ))}

          <button className="btn ghost" onClick={addQuestion} style={{ marginRight: 8 }}>+ Add question</button>
          {err && <p className="msg">{err}</p>}
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn ghost" disabled={!!busy} onClick={() => save('draft')}>Save draft</button>
            <button className="btn primary" disabled={!!busy} style={{ marginTop: 0, width: 'auto' }} onClick={() => save('published')}>
              {busy === 'save' ? 'Saving…' : 'Publish to students'}
            </button>
          </div>
        </main>
      </div>
    );
  }

  // ── List + generate view ──
  return (
    <div className="page">
      <Header subtitle="Teacher" />
      <main className="container">
        <Link to={backTo} className="muted small">← {course?.name || 'Course'}</Link>
        <h1>Quizzes</h1>

        <div className="card">
          <span className="label">Generate a quiz</span>
          {weeks.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
              {weeks.map((w) => (
                <button key={w.week} className="btn ghost small"
                  onClick={() => { setTopic(w.topic); setWeek(w.week); }}>
                  Wk {w.week}: {w.topic.slice(0, 28)}
                </button>
              ))}
            </div>
          )}
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic (e.g. Entropy and the Second Law)" />
          <button className="btn primary" disabled={busy === 'gen'} onClick={generate} style={{ width: 'auto' }}>
            {busy === 'gen' ? 'Generating…' : 'Generate draft quiz'}
          </button>
          <p className="muted small" style={{ marginTop: 8 }}>Questions are drawn from this course's material. Review before publishing.</p>
        </div>

        {err && <p className="msg">{err}</p>}

        <h2>Your quizzes</h2>
        {quizzes.length === 0 ? <p className="muted">No quizzes yet. Generate one above.</p> : (
          quizzes.map((q) => (
            <div key={q.id} className="card row-between" style={{ padding: '14px 18px' }}>
              <div>
                <strong style={{ fontFamily: 'Outfit' }}>{q.topic}</strong>
                <div className="muted small">{q.question_count} questions · <span className="pill">{q.status}</span></div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost small" onClick={() => openEditor(q.id)}>Edit</button>
                <button className="btn ghost small" onClick={() => removeQuiz(q.id)}>Delete</button>
              </div>
            </div>
          ))
        )}

        <h2>Upload extra material</h2>
        <form className="card" onSubmit={addMaterial}>
          <p className="muted small" style={{ marginTop: 0 }}>Paste lecture notes, a reading, anything. It improves both quizzes and the tutor.</p>
          <input value={matTitle} onChange={(e) => setMatTitle(e.target.value)} placeholder="Title (optional)" />
          <textarea rows={5} value={matText} onChange={(e) => setMatText(e.target.value)} placeholder="Paste material…" />
          <button className="btn primary" disabled={busy === 'mat'} type="submit" style={{ width: 'auto' }}>
            {busy === 'mat' ? 'Embedding…' : 'Add material'}
          </button>
        </form>
      </main>
    </div>
  );
}
