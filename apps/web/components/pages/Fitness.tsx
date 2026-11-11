'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { api, datetime, todayDate, useAction, useResource, uuid } from '../../lib/api';
import type { Cardio, Exercise, Page, Session, SessionExercise, Template, WorkoutSet } from '../../lib/types';
import { Badge, Empty, ErrorState, Field, Icon, Loading, Modal, Notice, label } from '../ui';

interface Progression {
  weekly_sessions: number;
  total_completed_sets: number;
  volume_kg_reps: number;
  cardio_duration_seconds: number;
  cardio_distance_meters: number;
  points: {
    exercise_id: string;
    session_id: string;
    started_at: string;
    max_weight_kg: number | null;
    max_reps: number;
    volume_kg_reps: number;
  }[];
}
export function FitnessPage({ id }: { id?: string }) {
  const templateStarts = useRef<Record<string, { id: string; template_id: string; started_at: string }>>({});
  const [tab, setTab] = useState('sessions');
  const [templateEdit, setTemplateEdit] = useState<Template | 'new' | null>(null);
  const [exerciseEdit, setExerciseEdit] = useState<Exercise | 'new' | null>(null);
  const [start, setStart] = useState(false);
  const [exerciseFilter, setExerciseFilter] = useState('');
  const sessions = useResource<Page<Session>>('/fitness/sessions?limit=100');
  const templates = useResource<Page<Template>>('/fitness/templates?limit=100');
  const exercises = useResource<Page<Exercise>>('/fitness/exercises?limit=500');
  const [range] = useState(() => ({
    from: new Date(Date.now() - 30 * 86400000).toISOString(),
    to: new Date().toISOString(),
  }));
  const progression = useResource<Progression>(
    `/fitness/progression?from=${range.from}&to=${range.to}${exerciseFilter ? `&exercise_id=${exerciseFilter}` : ''}`,
  );
  const action = useAction(() => {
    sessions.reload();
    templates.reload();
    exercises.reload();
    progression.reload();
  });
  if (id) return <SessionDetail id={id} />;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">FITNESS & PROGRESSION</span>
          <h1>Train consistently. Track honestly.</h1>
          <p>Keep a clear record of every set, recovery day, and long-term gain.</p>
        </div>
        <button className="button primary" onClick={() => setStart(true)}>
          <Icon name="plus" size={17} />
          Start workout
        </button>
      </div>
      <div className="fitness-stat-grid">
        {[
          [progression.data?.weekly_sessions ?? '—', 'Workouts this week', 'sessions'],
          [progression.data?.total_completed_sets ?? '—', 'Sets in the last 30 days', 'sets'],
          [
            progression.data ? Math.round(progression.data.volume_kg_reps).toLocaleString('en-GB') : '—',
            'Volume in the last 30 days',
            'kg·reps',
          ],
          [
            progression.data ? Math.round(progression.data.cardio_duration_seconds / 60) : '—',
            'Cardio in the last 30 days',
            'Minutes',
          ],
        ].map(([v, l, unit]) => (
          <div className="panel fitness-stat" key={l}>
            <span>{l}</span>
            <strong>
              {v}
              <small>{unit}</small>
            </strong>
          </div>
        ))}
      </div>
      <div className="collection-toolbar">
        <div className="tabs">
          {[
            ['sessions', 'Workout history'],
            ['templates', 'Templates'],
            ['exercises', 'Exercise library'],
            ['progression', 'Progress'],
          ].map(([v, l]) => (
            <button key={v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>
              {l}
            </button>
          ))}
        </div>
        {tab === 'templates' && (
          <button className="button small" onClick={() => setTemplateEdit('new')}>
            <Icon name="plus" size={15} />
            Create template
          </button>
        )}
        {tab === 'exercises' && (
          <button className="button small" onClick={() => setExerciseEdit('new')}>
            <Icon name="plus" size={15} />
            Add exercise
          </button>
        )}
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {tab === 'sessions' && (
        <>
          <ErrorState error={sessions.error} retry={sessions.reload} />
          {sessions.loading && !sessions.data && <Loading />}
          {sessions.data?.items.length === 0 && (
            <div className="panel">
              <Empty
                icon="fitness"
                title="Record your first workout"
                action={
                  <button className="button primary" onClick={() => setStart(true)}>
                    Start a workout
                  </button>
                }
              >
                Start from a template or log a workout as you go.
              </Empty>
            </div>
          )}
          <div className="session-list">
            {sessions.data?.items.map((s) => (
              <Link key={s.id} href={`/fitness/${s.id}`} className="panel session-card">
                <span className={`session-type-icon ${s.status === 'completed' ? 'completed' : ''}`}>
                  <Icon name="fitness" size={24} />
                </span>
                <div className="session-card-main">
                  <h2>{String(s.template_snapshot?.title || 'Open workout')}</h2>
                  <p>
                    {datetime(s.started_at)} · {s.exercises?.length || 0} exercises ·{' '}
                    {s.sets?.filter((x) => x.completed_at).length || 0} sets completed
                  </p>
                </div>
                <div className="session-card-stats">
                  <Badge tone={s.status === 'completed' ? 'green' : 'peach'}>{label(s.status)}</Badge>
                  <span>{Math.round(s.volume_kg_reps || 0).toLocaleString('en-GB')} kg·reps</span>
                </div>
                <Icon name="chevron" size={18} />
              </Link>
            ))}
          </div>
        </>
      )}
      {tab === 'templates' && (
        <>
          <ErrorState error={templates.error} retry={templates.reload} />
          {templates.data?.items.length === 0 && (
            <div className="panel">
              <Empty
                icon="fitness"
                title="Save your routine as a template"
                action={
                  <button className="button primary" onClick={() => setTemplateEdit('new')}>
                    Create template
                  </button>
                }
              >
                Set your exercise order, target sets, reps, and weight.
              </Empty>
            </div>
          )}
          <div className="template-grid">
            {templates.data?.items.map((t) => (
              <section className="panel template-card" key={t.id}>
                <div className="panel-heading">
                  <Badge tone="peach">{label(t.activity_type)}</Badge>
                  <button
                    className="icon-button"
                    aria-label="Edit template"
                    onClick={() => setTemplateEdit(t)}
                  >
                    <Icon name="edit" size={16} />
                  </button>
                </div>
                <h2>{t.title}</h2>
                <div className="template-exercise-list">
                  {t.exercises.map((x, i) => (
                    <div key={x.id}>
                      <span>{i + 1}</span>
                      <div>
                        <strong>
                          {exercises.data?.items.find((e) => e.id === x.exercise_id)?.name || 'Exercise'}
                        </strong>
                        <small>
                          {x.target_sets} sets{x.target_reps ? ` × ${x.target_reps} reps` : ''}
                          {x.target_weight_kg ? ` · ${x.target_weight_kg} kg` : ''}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="template-card-actions">
                  <button
                    className="button primary small"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        const s = await api<Session>('/fitness/sessions', {
                          method: 'POST',
                          body: (templateStarts.current[t.id] ||= {
                            id: uuid(),
                            template_id: t.id,
                            started_at: new Date().toISOString(),
                          }),
                        });
                        window.location.href = `/fitness/${s.id}`;
                      })
                    }
                  >
                    Start workout
                    <Icon name="arrow" size={14} />
                  </button>
                  <button
                    className="button small"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(() =>
                        api('/tasks', {
                          method: 'POST',
                          body: {
                            id: uuid(),
                            title: t.title,
                            source_type: 'workout',
                            workout_template_id: t.id,
                            estimated_minutes: 60,
                            planned_date: todayDate(),
                          },
                        }),
                      )
                    }
                  >
                    Add to today
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label="Archive template"
                    onClick={() => {
                      if (confirm('Archive this template? Workout history will be preserved.'))
                        void action.run(() =>
                          api(`/fitness/templates/${t.id}`, { method: 'DELETE', version: t.version }),
                        );
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
      {tab === 'exercises' && (
        <section className="panel">
          <ErrorState error={exercises.error} retry={exercises.reload} />
          {exercises.data?.items.length === 0 && (
            <Empty
              icon="fitness"
              title="Build your exercise library"
              action={
                <button className="button primary" onClick={() => setExerciseEdit('new')}>
                  Add exercise
                </button>
              }
            >
              Keep each exercise consistent to compare your progress over time.
            </Empty>
          )}
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Exercise</th>
                  <th>Type</th>
                  <th>Logging unit</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {exercises.data?.items.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <strong>{e.name}</strong>
                    </td>
                    <td>{label(e.exercise_type)}</td>
                    <td>{e.measurement_unit}</td>
                    <td>
                      <div className="inline-actions">
                        <button className="button small" onClick={() => setExerciseEdit(e)}>
                          Edit
                        </button>
                        <button
                          className="icon-button danger"
                          aria-label="Archive exercise"
                          onClick={() => {
                            if (confirm('Archive this exercise? Workout history will be preserved.'))
                              void action.run(() =>
                                api(`/fitness/exercises/${e.id}`, { method: 'DELETE', version: e.version }),
                              );
                          }}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === 'progression' && (
        <section className="panel content-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">LAST 30 DAYS</span>
              <h2>See your progress, exercise by exercise</h2>
            </div>
            <select
              aria-label="Compare exercise"
              value={exerciseFilter}
              onChange={(e) => setExerciseFilter(e.target.value)}
            >
              <option value="">Choose an exercise</option>
              {exercises.data?.items.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <ErrorState error={progression.error} retry={progression.reload} />
          {!exerciseFilter ? (
            <Empty icon="fitness" title="Select an exercise to compare">
              Volume is compared within the same exercise. All weights are normalized to kg.
            </Empty>
          ) : !progression.data?.points.length ? (
            <Empty icon="fitness" title="No comparable records for this exercise yet" />
          ) : (
            <>
              <ProgressChart points={progression.data.points} />
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Workout date</th>
                      <th>Maximum external weight</th>
                      <th>Maximum reps</th>
                      <th>Training volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {progression.data.points.map((p, i) => (
                      <tr key={`${p.session_id}-${i}`}>
                        <td>
                          <Link href={`/fitness/${p.session_id}`}>{datetime(p.started_at, true)}</Link>
                        </td>
                        <td>{p.max_weight_kg ?? '—'} kg</td>
                        <td>{p.max_reps}</td>
                        <td>{Math.round(p.volume_kg_reps).toLocaleString('en-GB')} kg·reps</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <Notice>
            Volume is one tracking metric, not an overall measure of training quality. Unknown external weight
            remains blank for bodyweight exercises.
          </Notice>
        </section>
      )}
      {start && <StartModal templates={templates.data?.items || []} onClose={() => setStart(false)} />}{' '}
      {templateEdit && (
        <TemplateEditor
          template={templateEdit === 'new' ? undefined : templateEdit}
          exercises={exercises.data?.items || []}
          onClose={() => setTemplateEdit(null)}
          onSaved={() => {
            setTemplateEdit(null);
            templates.reload();
          }}
        />
      )}{' '}
      {exerciseEdit && (
        <ExerciseEditor
          exercise={exerciseEdit === 'new' ? undefined : exerciseEdit}
          onClose={() => setExerciseEdit(null)}
          onSaved={() => {
            setExerciseEdit(null);
            exercises.reload();
          }}
        />
      )}
    </>
  );
}
function SessionDetail({ id }: { id: string }) {
  const session = useResource<Session>(`/fitness/sessions/${id}`);
  const library = useResource<Page<Exercise>>('/fitness/exercises?limit=500');
  const [addExercise, setAddExercise] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState('');
  const [setEdit, setSetEdit] = useState<{ exercise: SessionExercise; set?: WorkoutSet } | null>(null);
  const [cardioEdit, setCardioEdit] = useState<Cardio | 'new' | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [completeTask, setCompleteTask] = useState(true);
  const action = useAction(session.reload);
  if (!session.data)
    return (
      <>
        <ErrorState error={session.error} retry={session.reload} />
        {session.loading && <Loading />}
      </>
    );
  const s = session.data;
  const completedSets = s.sets.filter((x) => x.completed_at).length;
  return (
    <>
      <Link href="/fitness" className="back-link">
        ← Workout history
      </Link>
      <div className="page-heading detail-heading">
        <div>
          <span className="eyebrow">WORKOUT SESSION · {datetime(s.started_at)}</span>
          <h1>{String(s.template_snapshot?.title || 'Open workout')}</h1>
          <p>
            {s.exercises.length} exercises · {completedSets} sets completed ·{' '}
            {Math.round(s.volume_kg_reps || 0).toLocaleString('en-GB')} kg·reps
          </p>
        </div>
        <div className="heading-actions">
          <Badge tone={s.status === 'completed' ? 'green' : 'peach'}>{label(s.status)}</Badge>
          {s.status !== 'completed' && (
            <button
              className="button primary"
              disabled={action.busy}
              onClick={() =>
                void action.run(() =>
                  api(`/fitness/sessions/${id}/complete`, {
                    method: 'POST',
                    version: s.version,
                    body: { ended_at: new Date().toISOString(), complete_planned_task: completeTask },
                  }),
                )
              }
            >
              <Icon name="check" size={17} />
              Complete workout
            </button>
          )}
          <button
            className="icon-button danger"
            aria-label="Archive workout"
            onClick={() => {
              if (confirm('Archive this workout? Its original history will be preserved.'))
                void action.run(async () => {
                  await api(`/fitness/sessions/${id}`, { method: 'DELETE', version: s.version });
                  window.location.href = '/fitness';
                });
            }}
          >
            <Icon name="trash" size={17} />
          </button>
        </div>
      </div>
      {s.planned_task_id && s.status !== 'completed' && (
        <label className="check-label">
          <input type="checkbox" checked={completeTask} onChange={(e) => setCompleteTask(e.target.checked)} />
          Complete the linked planning task with this workout
        </label>
      )}
      {s.status === 'completed' && (
        <Notice tone="success">
          Workout saved. You can still edit exercises, sets, and notes; statistics will update.
        </Notice>
      )}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <div className="session-workspace">
        <div>
          {s.exercises.map((ex) => (
            <section className="panel session-exercise" key={ex.id}>
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">EXERCISE {ex.position + 1}</span>
                  <h2>{ex.name_snapshot}</h2>
                </div>
                <div className="inline-actions">
                  <button className="button small" onClick={() => setSetEdit({ exercise: ex })}>
                    <Icon name="plus" size={15} />
                    Add set
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label="Remove exercise from session"
                    onClick={() => {
                      if (confirm('Remove this exercise and its sets from this session?'))
                        void action.run(() =>
                          api(`/fitness/session-exercises/${ex.id}`, {
                            method: 'DELETE',
                            version: ex.version,
                          }),
                        );
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table set-table">
                  <thead>
                    <tr>
                      <th>Set</th>
                      <th>Weight</th>
                      <th>Reps</th>
                      <th>RPE / RIR</th>
                      <th>Done</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {s.sets
                      .filter((x) => x.session_exercise_id === ex.id)
                      .sort((a, b) => a.set_order - b.set_order)
                      .map((set) => (
                        <tr key={set.id} className={set.completed_at ? 'set-completed' : ''}>
                          <td>
                            <span className="set-order">{set.set_order + 1}</span>
                          </td>
                          <td>
                            {set.entered_weight === null
                              ? 'Bodyweight / unknown'
                              : `${set.entered_weight} ${set.entered_weight_unit}`}
                          </td>
                          <td>{set.reps}</td>
                          <td>
                            {set.rpe ?? '—'} / {set.rir ?? '—'}
                          </td>
                          <td>
                            <button
                              className={`task-check ${set.completed_at ? 'checked' : ''}`}
                              aria-label={set.completed_at ? 'Mark set incomplete' : 'Complete set'}
                              disabled={action.busy}
                              onClick={() =>
                                void action.run(() =>
                                  api(`/fitness/sets/${set.id}`, {
                                    method: 'PATCH',
                                    version: set.version,
                                    body: {
                                      completed_at: set.completed_at ? null : new Date().toISOString(),
                                    },
                                  }),
                                )
                              }
                            >
                              {set.completed_at && <Icon name="check" size={13} />}
                            </button>
                          </td>
                          <td>
                            <div className="inline-actions">
                              <button
                                className="icon-button"
                                aria-label="Edit set"
                                onClick={() => setSetEdit({ exercise: ex, set })}
                              >
                                <Icon name="edit" size={15} />
                              </button>
                              <button
                                className="icon-button danger"
                                aria-label="Delete set"
                                onClick={() =>
                                  void action.run(() =>
                                    api(`/fitness/sets/${set.id}`, {
                                      method: 'DELETE',
                                      version: set.version,
                                    }),
                                  )
                                }
                              >
                                <Icon name="trash" size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {s.sets.filter((x) => x.session_exercise_id === ex.id).length === 0 && (
                <p className="panel-description muted">
                  No sets yet. Log your actual weight, reps, and perceived effort.
                </p>
              )}
            </section>
          ))}
          <button className="add-block-button" onClick={() => setAddExercise(true)}>
            <Icon name="plus" />
            Add session exercise
          </button>
          <section className="panel">
            <div className="panel-heading">
              <h2>Cardio entry</h2>
              <button className="button small" onClick={() => setCardioEdit('new')}>
                <Icon name="plus" size={15} />
                Cardio
              </button>
            </div>
            {s.cardio.length === 0 ? (
              <p className="panel-description muted">
                Log your actual duration, distance, and perceived intensity.
              </p>
            ) : (
              s.cardio.map((c) => (
                <div className="cardio-row" key={c.id}>
                  <div>
                    <h3>{c.activity_type}</h3>
                    <p>
                      {Math.round(c.duration_seconds / 60)} min · {c.distance} {c.distance_unit}
                      {c.average_heart_rate ? ` · ${c.average_heart_rate} bpm` : ''}
                    </p>
                  </div>
                  <button className="icon-button" aria-label="Edit cardio" onClick={() => setCardioEdit(c)}>
                    <Icon name="edit" size={15} />
                  </button>
                  <button
                    className="icon-button danger"
                    aria-label="Delete cardio"
                    onClick={() =>
                      void action.run(() =>
                        api(`/fitness/cardio/${c.id}`, { method: 'DELETE', version: c.version }),
                      )
                    }
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              ))
            )}
          </section>
        </div>
        <aside>
          <section className="panel content-panel">
            <div className="panel-heading">
              <h2>Workout notes</h2>
            </div>
            <Field label="How it felt, adjustments, and next steps">
              <textarea
                rows={7}
                value={notes ?? s.notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="How you felt, exercise notes, or other observations…"
              />
            </Field>
            <button
              className="button full"
              disabled={notes === null || action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api(`/fitness/sessions/${id}`, {
                    method: 'PATCH',
                    version: s.version,
                    body: { notes: notes ?? s.notes },
                  });
                  setNotes(null);
                })
              }
            >
              Save notes
            </button>
          </section>
          <section className="quiet-card small">
            <span className="eyebrow">CONSISTENCY OVER INTENSITY</span>
            <p>
              Record with care.
              <br />
              Recover with care.
            </p>
            <small>PRISM tracks your plans and actual workouts. You stay in control of your training.</small>
          </section>
        </aside>
      </div>
      {addExercise && (
        <Modal title="Add a session exercise" onClose={() => setAddExercise(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                await api(`/fitness/sessions/${id}/exercises`, {
                  method: 'POST',
                  body: {
                    id: uuid(),
                    exercise_id: selectedExercise,
                    position: s.exercises.length ? Math.max(...s.exercises.map((x) => x.position)) + 1 : 0,
                  },
                });
                setAddExercise(false);
              });
            }}
          >
            <Field label="Choose an exercise">
              <select required value={selectedExercise} onChange={(e) => setSelectedExercise(e.target.value)}>
                <option value="">Choose an exercise</option>
                {library.data?.items.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            {library.data?.items.length === 0 && (
              <Notice>Your exercise library is empty. Add an exercise from the Fitness page first.</Notice>
            )}
            <div className="modal-footer">
              <button className="button primary" disabled={action.busy}>
                Add exercise
              </button>
            </div>
          </form>
        </Modal>
      )}
      {setEdit && (
        <SetEditor
          sessionId={id}
          exercise={setEdit.exercise}
          set={setEdit.set}
          nextOrder={s.sets
            .filter((x) => x.session_exercise_id === setEdit.exercise.id)
            .reduce((max, x) => Math.max(max, x.set_order + 1), 0)}
          onClose={() => setSetEdit(null)}
          onSaved={() => {
            setSetEdit(null);
            session.reload();
          }}
        />
      )}{' '}
      {cardioEdit && (
        <CardioEditor
          sessionId={id}
          entry={cardioEdit === 'new' ? undefined : cardioEdit}
          onClose={() => setCardioEdit(null)}
          onSaved={() => {
            setCardioEdit(null);
            session.reload();
          }}
        />
      )}
    </>
  );
}
function StartModal({ templates, onClose }: { templates: Template[]; onClose: () => void }) {
  const [creationId] = useState(uuid);
  const [startedAt] = useState(() => new Date().toISOString());
  const [template, setTemplate] = useState('');
  const a = useAction();
  return (
    <Modal title="Start a workout" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const s = await api<Session>('/fitness/sessions', {
              method: 'POST',
              body: { id: creationId, template_id: template || null, started_at: startedAt },
            });
            window.location.href = `/fitness/${s.id}`;
          });
        }}
      >
        <p className="modal-description">Choose a template or start a blank workout.</p>
        <Field label="Templates">
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Open workout</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </Field>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={a.busy}>
            Start logging
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ExerciseEditor({
  exercise,
  onClose,
  onSaved,
}: {
  exercise?: Exercise;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [creationId] = useState(uuid);
  const [name, setName] = useState(exercise?.name || '');
  const [type, setType] = useState(exercise?.exercise_type || 'strength');
  const [unit, setUnit] = useState(exercise?.measurement_unit || 'kg');
  const a = useAction(onSaved);
  return (
    <Modal title={exercise ? 'Edit exercise' : 'Add exercise'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api(exercise ? `/fitness/exercises/${exercise.id}` : '/fitness/exercises', {
              method: exercise ? 'PATCH' : 'POST',
              version: exercise?.version,
              body: {
                ...(exercise ? {} : { id: creationId }),
                name,
                exercise_type: type,
                measurement_unit: unit,
              },
            }),
          );
        }}
      >
        <Field label="Exercise name">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="For example: Bench Press"
          />
        </Field>
        <div className="form-grid">
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {['strength', 'cardio', 'recovery'].map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Primary unit">
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {['kg', 'lb', 'bodyweight', 'seconds', 'meters'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
        </div>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={a.busy}>
            Save exercise
          </button>
        </div>
      </form>
    </Modal>
  );
}
type TemplateRow = {
  id: string;
  exercise_id: string;
  target_sets: number;
  target_reps: number | null;
  target_weight_kg: number | null;
  rest_seconds: number | null;
};
function TemplateEditor({
  template,
  exercises,
  onClose,
  onSaved,
}: {
  template?: Template;
  exercises: Exercise[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [creationId] = useState(uuid);
  const [title, setTitle] = useState(template?.title || '');
  const [type, setType] = useState(template?.activity_type || 'strength');
  const [rows, setRows] = useState<TemplateRow[]>(
    template?.exercises.map((x) => ({
      id: x.id,
      exercise_id: x.exercise_id,
      target_sets: x.target_sets,
      target_reps: x.target_reps,
      target_weight_kg: x.target_weight_kg,
      rest_seconds: x.rest_seconds,
    })) || [],
  );
  const a = useAction(onSaved);
  const update = (i: number, field: keyof TemplateRow, value: string | number | null) =>
    setRows((x) => x.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  return (
    <Modal title={template ? 'Edit workout template' : 'Create workout template'} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api(template ? `/fitness/templates/${template.id}` : '/fitness/templates', {
              method: template ? 'PATCH' : 'POST',
              version: template?.version,
              body: {
                ...(template ? {} : { id: creationId }),
                title,
                activity_type: type,
                exercises: rows.map((r, position) => ({ ...r, position })),
              },
            }),
          );
        }}
      >
        <div className="form-grid">
          <Field label="Template name">
            <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Activity type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {['strength', 'cardio', 'recovery'].map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="template-editor-list">
          {rows.map((r, i) => (
            <div className="template-editor-row" key={r.id}>
              <Field label={`Exercise ${i + 1}`}>
                <select
                  required
                  value={r.exercise_id}
                  onChange={(e) => update(i, 'exercise_id', e.target.value)}
                >
                  <option value="">Choose an exercise</option>
                  {exercises.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Sets">
                <input
                  type="number"
                  required
                  min="1"
                  max="100"
                  value={r.target_sets}
                  onChange={(e) => update(i, 'target_sets', Number(e.target.value))}
                />
              </Field>
              <Field label="Reps">
                <input
                  type="number"
                  min="0"
                  value={r.target_reps ?? ''}
                  onChange={(e) =>
                    update(i, 'target_reps', e.target.value === '' ? null : Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Weight (kg)">
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={r.target_weight_kg ?? ''}
                  onChange={(e) =>
                    update(i, 'target_weight_kg', e.target.value === '' ? null : Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Rest (sec)">
                <input
                  type="number"
                  min="0"
                  value={r.rest_seconds ?? ''}
                  onChange={(e) =>
                    update(i, 'rest_seconds', e.target.value === '' ? null : Number(e.target.value))
                  }
                />
              </Field>
              <button
                className="icon-button"
                type="button"
                aria-label="Move exercise up"
                disabled={i === 0}
                onClick={() =>
                  setRows((x) => {
                    const n = [...x];
                    [n[i - 1], n[i]] = [n[i], n[i - 1]];
                    return n;
                  })
                }
              >
                ↑
              </button>
              <button
                className="icon-button danger"
                type="button"
                aria-label="Remove template exercise"
                onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="button small"
          type="button"
          onClick={() =>
            setRows((x) => [
              ...x,
              {
                id: uuid(),
                exercise_id: '',
                target_sets: 3,
                target_reps: 8,
                target_weight_kg: null,
                rest_seconds: 90,
              },
            ])
          }
        >
          <Icon name="plus" size={15} />
          Add exercise
        </button>
        {exercises.length === 0 && (
          <Notice>Add exercises to your library first, or save an empty template to edit later.</Notice>
        )}
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={a.busy}>
            Save template
          </button>
        </div>
      </form>
    </Modal>
  );
}
function SetEditor({
  sessionId,
  exercise,
  set,
  nextOrder,
  onClose,
  onSaved,
}: {
  sessionId: string;
  exercise: SessionExercise;
  set?: WorkoutSet;
  nextOrder: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [creationId] = useState(uuid);
  const [completionTime] = useState(() => set?.completed_at || new Date().toISOString());
  const [weight, setWeight] = useState(set?.entered_weight?.toString() || '');
  const [unit, setUnit] = useState(set?.entered_weight_unit || 'kg');
  const [reps, setReps] = useState(set?.reps || 8);
  const [rpe, setRpe] = useState(set?.rpe?.toString() || '');
  const [rir, setRir] = useState(set?.rir?.toString() || '');
  const [completed, setCompleted] = useState(Boolean(set?.completed_at) || !set);
  const a = useAction(onSaved);
  return (
    <Modal title={`${set ? 'Edit' : 'Log'} set · ${exercise.name_snapshot}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api(set ? `/fitness/sets/${set.id}` : `/fitness/sessions/${sessionId}/sets`, {
              method: set ? 'PATCH' : 'POST',
              version: set?.version,
              body: {
                ...(set ? {} : { id: creationId, session_exercise_id: exercise.id }),
                set_order: set?.set_order ?? nextOrder,
                entered_weight: weight === '' ? null : Number(weight),
                entered_weight_unit: unit,
                reps,
                rpe: rpe === '' ? null : Number(rpe),
                rir: rir === '' ? null : Number(rir),
                completed_at: completed ? completionTime : null,
              },
            }),
          );
        }}
      >
        <div className="form-grid">
          <Field label="External weight (blank for bodyweight / unknown)">
            <input
              autoFocus
              type="number"
              min="0"
              step="0.1"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </Field>
          <Field label="Weight unit">
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option>kg</option>
              <option>lb</option>
            </select>
          </Field>
        </div>
        <Field label="Repetitions">
          <input
            type="number"
            required
            min={completed ? 1 : 0}
            max="10000"
            value={reps}
            onChange={(e) => setReps(Number(e.target.value))}
          />
        </Field>
        <div className="form-grid">
          <Field label="RPE (optional, 0–10)">
            <input
              type="number"
              min="0"
              max="10"
              step="0.5"
              value={rpe}
              onChange={(e) => setRpe(e.target.value)}
            />
          </Field>
          <Field label="RIR (optional, 0–20)">
            <input
              type="number"
              min="0"
              max="20"
              step="0.5"
              value={rir}
              onChange={(e) => setRir(e.target.value)}
            />
          </Field>
        </div>
        <label className="check-label">
          <input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} />
          Set completed
        </label>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={a.busy}>
            Save set
          </button>
        </div>
      </form>
    </Modal>
  );
}
function CardioEditor({
  sessionId,
  entry,
  onClose,
  onSaved,
}: {
  sessionId: string;
  entry?: Cardio;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [creationId] = useState(uuid);
  const [type, setType] = useState(entry?.activity_type || 'Running');
  const [minutes, setMinutes] = useState(entry ? entry.duration_seconds / 60 : 20);
  const [distance, setDistance] = useState(entry?.distance || 0);
  const [unit, setUnit] = useState(entry?.distance_unit || 'km');
  const [hr, setHr] = useState(entry?.average_heart_rate?.toString() || '');
  const [intensity, setIntensity] = useState(entry?.perceived_intensity?.toString() || '');
  const a = useAction(onSaved);
  return (
    <Modal title="Cardio entry" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api(entry ? `/fitness/cardio/${entry.id}` : `/fitness/sessions/${sessionId}/cardio`, {
              method: entry ? 'PATCH' : 'POST',
              version: entry?.version,
              body: {
                ...(entry ? {} : { id: creationId }),
                activity_type: type,
                duration_seconds: Math.round(minutes * 60),
                distance,
                distance_unit: unit,
                average_heart_rate: hr ? Number(hr) : null,
                perceived_intensity: intensity ? Number(intensity) : null,
              },
            }),
          );
        }}
      >
        <Field label="Activity type">
          <input required value={type} onChange={(e) => setType(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Minutes">
            <input
              type="number"
              min="0.1"
              step="0.1"
              required
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </Field>
          <Field label="Distance">
            <input
              type="number"
              min="0"
              step="0.01"
              required
              value={distance}
              onChange={(e) => setDistance(Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Distance unit">
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option>km</option>
              <option>mi</option>
              <option>m</option>
            </select>
          </Field>
          <Field label="Average heart rate (optional)">
            <input type="number" min="20" max="300" value={hr} onChange={(e) => setHr(e.target.value)} />
          </Field>
        </div>
        <Field label="Perceived intensity (optional, 1–10)">
          <input
            type="number"
            min="1"
            max="10"
            value={intensity}
            onChange={(e) => setIntensity(e.target.value)}
          />
        </Field>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={a.busy}>
            Save cardio entry
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ProgressChart({ points }: { points: Progression['points'] }) {
  const data = [...points]
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .filter((x) => x.max_weight_kg !== null);
  if (!data.length)
    return <p className="panel-description muted">These entries have no comparable external weight.</p>;
  const max = Math.max(1, ...data.map((x) => x.max_weight_kg || 0));
  const path = data
    .map(
      (p, i) =>
        `${40 + (i / Math.max(1, data.length - 1)) * 620},${200 - ((p.max_weight_kg || 0) / max) * 150}`,
    )
    .join(' ');
  return (
    <div className="progress-chart">
      <svg viewBox="0 0 700 250" role="img" aria-label="Maximum weight progression for this exercise, in kg">
        <path d="M40 50H660M40 125H660M40 200H660" stroke="#e7e4ef" strokeDasharray="4 5" />
        <polyline points={path} fill="none" stroke="#8d7a53" strokeWidth="2.5" />
        {data.map((p, i) => (
          <g key={i}>
            <circle
              cx={40 + (i / Math.max(1, data.length - 1)) * 620}
              cy={200 - ((p.max_weight_kg || 0) / max) * 150}
              r="4"
              fill="#8d7a53"
            />
            <title>
              {datetime(p.started_at, true)}: {p.max_weight_kg} kg
            </title>
          </g>
        ))}
        <text x="5" y="55" fill="#908a9c" fontSize="11">
          {Math.round(max)}
        </text>
        <text x="10" y="205" fill="#908a9c" fontSize="11">
          0
        </text>
        <text x="40" y="232" fill="#908a9c" fontSize="11">
          {datetime(data[0].started_at, true)}
        </text>
        <text x="600" y="232" fill="#908a9c" fontSize="11">
          {datetime(data[data.length - 1].started_at, true)}
        </text>
      </svg>
    </div>
  );
}
