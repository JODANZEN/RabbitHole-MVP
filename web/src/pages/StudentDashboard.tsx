import { useEffect, useState } from 'react';
import { api, Course } from '../lib/api';
import Header from '../components/Header';

export default function StudentDashboard() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.allCourses()
      .then((r) => setCourses(r.courses))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <Header subtitle="Student" />
      <main className="container">
        <h1>Your study home</h1>
        <div className="card tip">
          <strong>💡 Tip:</strong> Install the RabbitHole extension and open any reading or lecture page.
          Pick a course and ask the tutor — by voice or text — and it answers grounded in your material.
        </div>

        <h2>Available courses</h2>
        {loading && <p className="muted">Loading…</p>}
        {err && <p className="msg">{err}</p>}
        {!loading && courses.length === 0 && <p className="muted">No courses available yet.</p>}
        <div className="grid">
          {courses.map((c) => (
            <div key={c.id} className="card course-card">
              <div className="course-name">🎓 {c.name}</div>
              <div className="muted small">{c.reading_count} readings</div>
            </div>
          ))}
        </div>

        <h2>Feedback from your teachers</h2>
        <p className="muted">Coming soon — your teachers will be able to leave notes and resources here.</p>
      </main>
    </div>
  );
}
