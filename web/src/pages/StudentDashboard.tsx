import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Enrollment, Course } from '../lib/api';
import Header from '../components/Header';

export default function StudentDashboard() {
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [ownCourses, setOwnCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [joining, setJoining] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [cName, setCName] = useState('');
  const [cSyllabus, setCSyllabus] = useState('');
  const [creating, setCreating] = useState(false);

  async function load() {
    try { setEnrollments((await api.myEnrollments()).enrollments); }
    catch { /* ignore */ }
    try { setOwnCourses((await api.myCourses()).courses); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (code.trim().length < 4) { setMsg('Enter the join code from your teacher.'); return; }
    setJoining(true); setMsg('');
    try {
      const res = await api.enroll(code.trim().toUpperCase());
      setMsg(res.status === 'active'
        ? `Joined ${res.course.name}!`
        : `Request sent to ${res.course.name} — waiting for your teacher to accept.`);
      setCode('');
      await load();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setJoining(false);
    }
  }

  async function createPersonal(e: React.FormEvent) {
    e.preventDefault();
    if (cSyllabus.trim().length < 100) { setMsg('Paste a bit more of your syllabus (a few sentences).'); return; }
    setCreating(true); setMsg('');
    try {
      await api.createCourse(cName.trim(), cSyllabus);
      setCName(''); setCSyllabus(''); setShowCreate(false);
      await load();
    } catch (e: any) { setMsg(e.message); }
    finally { setCreating(false); }
  }

  const active = enrollments.filter((e) => e.status === 'active');
  const pending = enrollments.filter((e) => e.status === 'pending');

  return (
    <div className="page">
      <Header subtitle="Student" />
      <main className="container">
        <h1>Your classes</h1>

        <form className="card" onSubmit={join} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label>Join a class</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Enter join code (e.g. 7KQ2WP)"
              style={{ letterSpacing: '0.1em', fontFamily: 'Outfit' }}
            />
          </div>
          <button className="btn primary" disabled={joining} type="submit" style={{ marginTop: 0, width: 'auto' }}>
            {joining ? 'Joining…' : 'Join'}
          </button>
        </form>
        {msg && <p className="msg">{msg}</p>}

        {loading ? <p className="muted">Loading…</p> : (
          <>
            {active.length > 0 && (
              <>
                <h2>Enrolled</h2>
                <div className="grid">
                  {active.map((e) => (
                    <Link key={e.enrollment_id} to={`/class/${e.course.id}`} className="card course-card">
                      <div className="course-name">🎓 {e.course.name}</div>
                      <div className="muted small">{e.course.reading_count} readings · quizzes + tutor →</div>
                    </Link>
                  ))}
                </div>
              </>
            )}

            {pending.length > 0 && (
              <>
                <h2>Awaiting approval</h2>
                <div className="grid">
                  {pending.map((e) => (
                    <div key={e.enrollment_id} className="card course-card" style={{ opacity: 0.7 }}>
                      <div className="course-name">🎓 {e.course.name}</div>
                      <div className="muted small">⏳ waiting for your teacher to accept</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {active.length === 0 && pending.length === 0 && (
              <p className="muted">You haven't joined any classes yet. Enter a join code above, or create your own study course in the extension.</p>
            )}

            <div className="row-between" style={{ marginTop: 28 }}>
              <h2 style={{ margin: 0 }}>My study courses <span className="muted small" style={{ fontWeight: 400 }}>(no teacher — just you)</span></h2>
              <button className="btn primary small" style={{ marginTop: 0, width: 'auto' }} onClick={() => setShowCreate(!showCreate)}>
                {showCreate ? 'Cancel' : '+ New personal course'}
              </button>
            </div>

            {showCreate && (
              <form className="card" onSubmit={createPersonal} style={{ marginTop: 12 }}>
                <label>Course name</label>
                <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="e.g. My Calculus Review" required />
                <label>Syllabus</label>
                <textarea rows={6} value={cSyllabus} onChange={(e) => setCSyllabus(e.target.value)} placeholder="Paste your syllabus — RabbitHole builds your topics, quizzes, and reading recs from it." />
                <button className="btn primary" disabled={creating} type="submit">
                  {creating ? 'Processing…' : 'Create course'}
                </button>
              </form>
            )}

            {ownCourses.length > 0 ? (
              <div className="grid" style={{ marginTop: 12 }}>
                {ownCourses.map((c) => (
                  <Link key={c.id} to={`/class/${c.id}`} className="card course-card">
                    <div className="course-name">📘 {c.name}</div>
                    <div className="muted small">{c.reading_count} readings · quizzes, progress & readings →</div>
                  </Link>
                ))}
              </div>
            ) : (
              !showCreate && <p className="muted" style={{ marginTop: 8 }}>None yet. Create one from your syllabus, or make one in the extension.</p>
            )}
          </>
        )}

        <div className="card tip" style={{ marginTop: 24 }}>
          <strong>💡 Tip:</strong> Open any reading or lecture page with the RabbitHole extension,
          pick your class, and ask the tutor — by voice or text. It answers grounded in your course.
        </div>

        <h2>Feedback from your teachers</h2>
        <p className="muted">Coming soon — notes and resources from your teachers will appear here.</p>
      </main>
    </div>
  );
}
