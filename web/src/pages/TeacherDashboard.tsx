import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Course } from '../lib/api';
import Header from '../components/Header';

export default function TeacherDashboard() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [syllabus, setSyllabus] = useState('');
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true); setErr('');
    try { setCourses((await api.myCourses()).courses); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (syllabus.trim().length < 100) { setErr('Paste more of the syllabus (a few sentences).'); return; }
    setCreating(true); setErr('');
    try {
      await api.createCourse(name.trim(), syllabus);
      setName(''); setSyllabus(''); setShowForm(false);
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setCreating(false); }
  }

  return (
    <div className="page">
      <Header subtitle="Teacher" />
      <main className="container">
        <div className="row-between">
          <h1>Your courses</h1>
          <button className="btn primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : '+ New course'}
          </button>
        </div>

        {showForm && (
          <form className="card" onSubmit={create}>
            <label>Course name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. PHY 252 — Physics 3" required />
            <label>Syllabus</label>
            <textarea rows={7} value={syllabus} onChange={(e) => setSyllabus(e.target.value)} placeholder="Paste the full syllabus…" />
            <button className="btn primary" disabled={creating} type="submit">
              {creating ? 'Processing…' : 'Create course'}
            </button>
          </form>
        )}

        {err && <p className="msg">{err}</p>}
        {loading ? <p className="muted">Loading…</p> : (
          courses.length === 0 ? (
            <p className="muted">No courses yet. Create one to start seeing where students struggle.</p>
          ) : (
            <div className="grid">
              {courses.map((c) => (
                <Link key={c.id} to={`/course/${c.id}`} className="card course-card">
                  <div className="course-name">🎓 {c.name}</div>
                  <div className="muted small" style={{ marginBottom: 8 }}>{c.reading_count} readings · view insights →</div>
                  {c.join_code && (
                    <div className="small">
                      <span className="muted">Join code </span>
                      <span className="pill">{c.join_code}</span>
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
}
