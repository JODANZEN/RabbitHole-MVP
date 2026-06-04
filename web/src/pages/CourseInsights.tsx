import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, Insights } from '../lib/api';
import Header from '../components/Header';

export default function CourseInsights() {
  const { id } = useParams();
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.insights(id)
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="page">
      <Header subtitle="Teacher" />
      <main className="container">
        <Link to="/" className="muted small">← All courses</Link>

        {loading && <p className="muted">Analyzing student questions…</p>}
        {err && <p className="msg">{err}</p>}

        {data && (
          <>
            <h1>{data.course.name}</h1>
            <p className="muted">{data.question_count} student question{data.question_count === 1 ? '' : 's'} logged from the tutor.</p>

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
      </main>
    </div>
  );
}
