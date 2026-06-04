import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Enrollment } from '../lib/api';
import Header from '../components/Header';

export default function StudentDashboard() {
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [joining, setJoining] = useState(false);

  async function load() {
    try { setEnrollments((await api.myEnrollments()).enrollments); }
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
