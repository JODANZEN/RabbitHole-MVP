import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, Insights, Roster } from '../lib/api';
import Header from '../components/Header';
import { ComprehensionChart, TopicMasteryBars } from '../components/Charts';

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
        <div className="row-between">
          <Link to="/" className="muted small">← All courses</Link>
          <Link to={`/course/${id}/quizzes`} className="btn primary small" style={{ marginTop: 0, width: 'auto', textDecoration: 'none' }}>Manage quizzes →</Link>
        </div>

        {loading && <p className="muted">Analyzing student questions…</p>}
        {err && <p className="msg">{err}</p>}

        {data && (
          <>
            <p className="label" style={{ marginTop: 18 }}>Faculty dashboard — {data.course.name}</p>
            <h1 style={{ marginTop: 2 }}>Class cohort view</h1>

            <div className="stat-grid">
              <div className="stat-card">
                <span className="label">Class comprehension</span>
                <div className="stat-num">{data.attempt_count ? `${data.comprehension}%` : '—'}</div>
                <div className="stat-sub">{data.attempt_count} quiz attempt{data.attempt_count === 1 ? '' : 's'}</div>
              </div>
              <div className="stat-card">
                <span className="label">Most confused topic</span>
                <div className="stat-strong">{data.themes[0]?.topic || data.topic_mastery[0]?.topic || '—'}</div>
                <div className="stat-sub">
                  {data.themes[0] ? `asked ~${data.themes[0].count}× by the tutor`
                    : data.topic_mastery[0] ? `lowest quiz mastery (${data.topic_mastery[0].pct}%)` : 'gathering data…'}
                </div>
              </div>
              <div className="stat-card">
                <span className="label">Students at risk</span>
                <div className="stat-num">{data.at_risk}<small> of {data.student_count || data.attempted_count}</small></div>
                <div className="stat-sub">below {60}% mastery</div>
              </div>
            </div>

            <h2>Comprehension over time</h2>
            <div className="card"><ComprehensionChart data={data.over_time} /></div>

            {data.topic_mastery.length > 0 && (
              <>
                <h2>Topic mastery (weakest first)</h2>
                <div className="card"><TopicMasteryBars data={data.topic_mastery} /></div>
              </>
            )}

            {data.per_student.length > 0 && (
              <>
                <h2>Students</h2>
                <div className="grid">
                  {data.per_student.map((s, i) => (
                    <div key={i} className="card" style={{ padding: '12px 16px', borderColor: s.at_risk ? 'rgba(255,90,31,.4)' : undefined }}>
                      <div className="row-between">
                        <strong style={{ fontFamily: 'Outfit' }}>{s.name}</strong>
                        <span className="pill" style={s.at_risk ? { background: 'rgba(255,90,31,.12)' } : {}}>{s.pct}%</span>
                      </div>
                      {s.at_risk && <div className="stat-sub" style={{ color: 'var(--orange)' }}>at risk</div>}
                    </div>
                  ))}
                </div>
              </>
            )}

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
