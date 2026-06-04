import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, Insights, Roster } from '../lib/api';
import Header from '../components/Header';

export default function CourseInsights() {
  const { id } = useParams();
  const [data, setData] = useState<Insights | null>(null);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  function loadRoster() {
    if (id) api.roster(id).then(setRoster).catch(() => {});
  }

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.insights(id)
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
    loadRoster();
  }, [id]);

  async function decide(enrollmentId: string, status: 'active' | 'rejected') {
    try { await api.decide(enrollmentId, status); loadRoster(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="page">
      <Header subtitle="Teacher" />
      <main className="container">
        <Link to="/" className="muted small">← All courses</Link>

        {loading && <p className="muted">Analyzing student questions…</p>}
        {err && <p className="msg">{err}</p>}

        {data && (
          <>
            <p className="label" style={{ marginTop: 18 }}>Faculty dashboard — {data.course.name}</p>
            <h1 style={{ marginTop: 2 }}>Class cohort view</h1>

            <div className="stat-grid">
              <div className="stat-card">
                <span className="label">Tutor questions</span>
                <div className="stat-num">{data.question_count}</div>
                <div className="stat-sub">logged from the AI tutor</div>
              </div>
              <div className="stat-card">
                <span className="label">Most confused topic</span>
                <div className="stat-strong">{data.themes[0]?.topic || '—'}</div>
                <div className="stat-sub">
                  {data.themes[0] ? `asked ~${data.themes[0].count}× this period` : 'gathering data…'}
                </div>
              </div>
              <div className="stat-card">
                <span className="label">Confusion areas</span>
                <div className="stat-num">{data.themes.length}</div>
                <div className="stat-sub">distinct struggle themes</div>
              </div>
            </div>

            <h2>Where the class is struggling</h2>
            {data.themes.length === 0 ? (
              <p className="muted">
                Not enough questions yet. As students use the tutor in the extension, common
                confusion points will surface here.
              </p>
            ) : (
              <div className="grid">
                {data.themes.map((t, i) => (
                  <div key={i} className="card theme-card">
                    <div className="row-between">
                      <strong>{t.topic}</strong>
                      <span className="pill">{t.count}×</span>
                    </div>
                    <div className="muted small">{t.why}</div>
                  </div>
                ))}
              </div>
            )}

            <h2>Recent questions</h2>
            {data.recent.length === 0 ? (
              <p className="muted">No questions logged yet.</p>
            ) : (
              <ul className="q-list">
                {data.recent.map((q, i) => (
                  <li key={i}><span>{q.question}</span></li>
                ))}
              </ul>
            )}
          </>
        )}

        {roster && (
          <>
            <h2>Class roster</h2>
            <div className="card" style={{ marginBottom: 18 }}>
              <span className="label">Share this join code with students</span>
              <div style={{ fontFamily: 'Outfit', fontSize: 30, fontWeight: 800, letterSpacing: '0.12em', margin: '6px 0' }}>
                {roster.course.join_code}
              </div>
              <div className="muted small">Students enter it in their dashboard to request to join.</div>
            </div>

            {roster.pending.length > 0 && (
              <>
                <p className="label" style={{ marginBottom: 8 }}>Pending requests ({roster.pending.length})</p>
                {roster.pending.map((m) => (
                  <div key={m.enrollment_id} className="card row-between" style={{ padding: '12px 16px' }}>
                    <div>
                      <strong style={{ fontFamily: 'Outfit' }}>{m.student.name}</strong>
                      <div className="muted small">{m.student.email}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn primary small" style={{ marginTop: 0, width: 'auto' }} onClick={() => decide(m.enrollment_id, 'active')}>Accept</button>
                      <button className="btn ghost small" onClick={() => decide(m.enrollment_id, 'rejected')}>Decline</button>
                    </div>
                  </div>
                ))}
              </>
            )}

            <p className="label" style={{ margin: '18px 0 8px' }}>Students ({roster.active.length})</p>
            {roster.active.length === 0 ? (
              <p className="muted small">No students yet. Share the join code above.</p>
            ) : (
              <div className="grid">
                {roster.active.map((m) => (
                  <div key={m.enrollment_id} className="card" style={{ padding: '12px 16px' }}>
                    <strong style={{ fontFamily: 'Outfit' }}>{m.student.name}</strong>
                    <div className="muted small">{m.student.email}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
