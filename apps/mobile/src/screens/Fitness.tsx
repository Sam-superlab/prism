import { useAppearance } from '../ui/theme';
import React, { useState } from 'react';
import { Text } from 'react-native';
import { newId, useItems, usePrism, type Item } from '../state';
import {
  Button,
  Card,
  Chip,
  DetailSheet,
  Empty,
  FormSheet,
  Heading,
  Loading,
  Row,
  Screen,
  Section,
  confirmDelete,
  dateLabel,
  humanLabel,
  type Field,
} from '../ui/components';

const setFields: Field[] = [
  {
    key: 'entered_weight',
    label: 'External weight',
    type: 'number',
    min: 0,
    help: 'Leave blank for bodyweight exercises',
  },
  {
    key: 'entered_weight_unit',
    label: 'Weight unit',
    options: [
      { value: 'kg', label: 'kg' },
      { value: 'lb', label: 'lb' },
    ],
  },
  { key: 'reps', label: 'Repetitions', type: 'number', required: true, min: 0, max: 10000 },
  { key: 'rpe', label: 'RPE (optional)', type: 'number', min: 0, max: 10 },
  { key: 'rir', label: 'RIR (optional)', type: 'number', min: 0, max: 20 },
];
export function FitnessScreen({ planned }: { planned?: Item | null }) {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const sessions = useItems('/fitness/sessions', 'workout_session');
  const templates = useItems('/fitness/templates', 'workout_template');
  const exercises = useItems('/fitness/exercises', 'exercise');
  const [session, setSession] = useState<Item | null>(null);
  const [template, setTemplate] = useState<Item | 'new' | null>(null);
  const [templateView, setTemplateView] = useState<Item | null>(null);
  const [exercise, setExercise] = useState<Item | 'new' | null>(null);
  const [library, setLibrary] = useState(false);
  const [progress, setProgress] = useState<Item | null>(null);
  const start = async (from?: Item, plannedTask?: Item) => {
    const id = newId();
    const started_at = new Date().toISOString();
    const payload = {
      id,
      started_at,
      template_id: null,
      planned_task_id: plannedTask?.id ?? null,
      notes: '',
    };
    const projected = {
      ...payload,
      version: '1',
      status: 'in_progress',
      ended_at: null,
      template_snapshot: from ?? {},
      exercises: [],
      sets: [],
      cardio: [],
      volume_kg_reps: 0,
      deleted_at: null,
    };
    const parent = await p.queue('workout.session.create', 'workout_session', id, payload, projected);
    let lastCausal = parent;
    for (const [position, planned] of (from?.exercises ?? []).entries()) {
      const exId = newId();
      const ex = exercises.items.find((e) => e.id === planned.exercise_id);
      const operation = await p.queue(
        'workout.exercise.create',
        'session_exercise',
        exId,
        { id: exId, session_id: id, exercise_id: planned.exercise_id, position },
        {
          id: exId,
          version: '1',
          session_id: id,
          exercise_id: planned.exercise_id,
          name_snapshot: ex?.name ?? 'Exercise',
          position,
          deleted_at: null,
        },
        parent,
      );
      lastCausal = operation;
      for (let i = 0; i < Number(planned.target_sets ?? 0); i++) {
        const setId = newId();
        const fields = {
          id: setId,
          session_id: id,
          session_exercise_id: exId,
          set_order: i,
          entered_weight: planned.target_weight_kg ?? null,
          entered_weight_unit: 'kg',
          reps: planned.target_reps ?? 0,
          rpe: null,
          rir: null,
          completed_at: null,
        };
        lastCausal = await p.queue(
          'workout.set.create',
          'workout_set',
          setId,
          fields,
          {
            ...fields,
            exercise_id: planned.exercise_id,
            version: '1',
            weight_kg: fields.entered_weight,
            deleted_at: null,
          },
          operation,
        );
      }
    }
    if (from) {
      await p.queue(
        'workout.session.update',
        'workout_session',
        id,
        { template_id: from.id },
        { ...projected, template_id: from.id },
        lastCausal,
      );
    }
    setTemplateView(null);
    setSession(projected);
  };
  const active = sessions.items.filter((s) => s.status === 'in_progress');
  return (
    <Screen>
      <Heading
        title="Fitness"
        subtitle="A clear record of every set."
        action={<Button label="＋ Workout" small onPress={() => start()} />}
      />
      {planned &&
      planned.status !== 'completed' &&
      !sessions.items.some((s) => s.planned_task_id === planned.id && s.status !== 'cancelled') ? (
        <Card accent={colors.orange}>
          <Chip color={colors.orange}>Today · Planned workout</Chip>
          <Text style={styles.cardTitle}>{planned.title}</Text>
          <Button
            label="Start planned workout"
            disabled={!templates.items.some((t) => t.id === planned.workout_template_id)}
            onPress={() =>
              start(
                templates.items.find((t) => t.id === planned.workout_template_id),
                planned,
              )
            }
          />
        </Card>
      ) : null}
      {active.map((s) => (
        <Card key={s.id} accent={colors.orange} onPress={() => setSession(s)}>
          <Chip color={colors.orange}>In progress</Chip>
          <Text style={styles.cardTitle}>{s.template_snapshot?.title ?? 'Free workout'}</Text>
          <Text style={styles.body}>{dateLabel(s.started_at)} · Tap to continue logging</Text>
        </Card>
      ))}
      <Row>
        <Button label="Exercise library" tone="quiet" onPress={() => setLibrary(true)} />
        <Button label="＋ Workout template" tone="quiet" onPress={() => setTemplate('new')} />
      </Row>
      <Section title="Workout templates">
        {templates.items.map((t) => (
          <Card key={t.id} onPress={() => setTemplateView(t)}>
            <Row>
              <Chip color={colors.orange}>{humanLabel(t.activity_type)}</Chip>
              <Text style={styles.help}>{t.exercises?.length ?? 0} exercises</Text>
            </Row>
            <Text style={styles.cardTitle}>{t.title}</Text>
            <Button label="Start workout" onPress={() => start(t)} />
          </Card>
        ))}
        {!templates.items.length ? (
          <Empty
            title="Start with a free workout"
            detail="Create a template to keep exercises, target reps and rest times together."
          />
        ) : null}
      </Section>
      <Section title="Workout history">
        <Loading loading={sessions.loading} error={sessions.error} />
        {sessions.items
          .filter((s) => s.status !== 'in_progress')
          .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
          .map((s) => (
            <Card key={s.id} onPress={() => setSession(s)}>
              <Row>
                <Chip color={colors.teal}>{humanLabel(s.status)}</Chip>
                <Text style={styles.help}>{dateLabel(s.started_at)}</Text>
              </Row>
              <Text style={styles.cardTitle}>{s.template_snapshot?.title ?? 'Free workout'}</Text>
              <Text style={styles.body}>
                {s.sets?.filter((x: Item) => x.completed_at).length ?? 0} completed sets ·{' '}
                {Number(s.volume_kg_reps ?? 0).toFixed(0)} kg·reps
              </Text>
            </Card>
          ))}
      </Section>
      {session ? (
        <SessionDetail
          initial={session}
          current={sessions.items.find((s) => s.id === session.id)}
          exercises={exercises.items}
          close={() => setSession(null)}
        />
      ) : null}
      {template ? (
        <FormSheet
          title={template === 'new' ? 'New workout template' : 'Edit workout template'}
          fields={[
            { key: 'title', label: 'Template name', required: true },
            {
              key: 'activity_type',
              label: 'Activity type',
              options: ['strength', 'cardio', 'recovery'].map((value) => ({
                value,
                label: humanLabel(value),
              })),
            },
          ]}
          initial={template === 'new' ? { activity_type: 'strength' } : template}
          close={() => setTemplate(null)}
          submit={(values) =>
            template === 'new'
              ? p.mutate(
                  '/fitness/templates',
                  'POST',
                  { id: newId(), ...values, exercises: [] },
                  undefined,
                  'workout_template',
                )
              : p.mutate(`/fitness/templates/${template.id}`, 'PATCH', values, template, 'workout_template')
          }
        />
      ) : null}
      {templateView ? (
        <TemplateDetail
          template={templates.items.find((t) => t.id === templateView.id) ?? templateView}
          exercises={exercises.items}
          close={() => setTemplateView(null)}
          start={start}
          edit={() => {
            setTemplate(templateView);
            setTemplateView(null);
          }}
        />
      ) : null}
      {library ? (
        <DetailSheet title="Exercise library" visible close={() => setLibrary(false)}>
          <Button label="＋ New exercise" onPress={() => setExercise('new')} />
          {exercises.items.map((e) => (
            <Card key={e.id}>
              <Text style={styles.cardTitle}>{e.name}</Text>
              <Row>
                <Chip>{humanLabel(e.exercise_type)}</Chip>
                <Chip color={colors.orange}>{e.measurement_unit}</Chip>
              </Row>
              <Row>
                <Button label="Progress" small tone="quiet" onPress={() => setProgress(e)} />
                <Button label="Edit" small tone="quiet" onPress={() => setExercise(e)} />
                <Button
                  label="Archive"
                  small
                  tone="danger"
                  onPress={() =>
                    confirmDelete(
                      e.name,
                      () => p.mutate(`/fitness/exercises/${e.id}`, 'DELETE', undefined, e, 'exercise'),
                      p.report,
                    )
                  }
                />
              </Row>
            </Card>
          ))}
        </DetailSheet>
      ) : null}
      {exercise ? (
        <FormSheet
          title={exercise === 'new' ? 'New exercise' : 'Edit exercise'}
          fields={[
            { key: 'name', label: 'Exercise name', required: true },
            {
              key: 'exercise_type',
              label: 'Type',
              options: ['strength', 'cardio', 'recovery'].map((value) => ({
                value,
                label: humanLabel(value),
              })),
            },
            {
              key: 'measurement_unit',
              label: 'Primary measurement unit',
              options: ['kg', 'lb', 'bodyweight', 'seconds', 'meters'].map((value) => ({
                value,
                label: humanLabel(value),
              })),
            },
          ]}
          initial={exercise === 'new' ? { exercise_type: 'strength', measurement_unit: 'kg' } : exercise}
          close={() => setExercise(null)}
          submit={(values) =>
            exercise === 'new'
              ? p.mutate('/fitness/exercises', 'POST', { id: newId(), ...values }, undefined, 'exercise')
              : p.mutate(`/fitness/exercises/${exercise.id}`, 'PATCH', values, exercise, 'exercise')
          }
        />
      ) : null}
      {progress ? <Progression exercise={progress} close={() => setProgress(null)} /> : null}
    </Screen>
  );
}
function TemplateDetail({
  template,
  exercises,
  close,
  start,
  edit,
}: {
  template: Item;
  exercises: Item[];
  close: () => void;
  start: (t: Item) => Promise<void>;
  edit: () => void;
}) {
  const { styles } = useAppearance();
  const p = usePrism();
  const [form, setForm] = useState<Item | 'new' | null>(null);
  const [plan, setPlan] = useState(false);
  const saveExercises = (next: Item[]) =>
    p.mutate(
      `/fitness/templates/${template.id}`,
      'PATCH',
      {
        exercises: next.map((ex, position) => ({
          id: ex.id,
          exercise_id: ex.exercise_id,
          position,
          target_sets: ex.target_sets,
          target_reps: ex.target_reps ?? null,
          target_weight_kg: ex.target_weight_kg ?? null,
          rest_seconds: ex.rest_seconds ?? null,
        })),
      },
      template,
      'workout_template',
    );
  return (
    <DetailSheet title={template.title} visible close={close}>
      <Button label="Start workout" onPress={() => start(template)} />
      <Button label="Add to daily plan" tone="quiet" onPress={() => setPlan(true)} />
      <Row>
        <Button label="Edit template" tone="quiet" onPress={edit} />
        <Button
          label="Archive template"
          tone="danger"
          onPress={() =>
            confirmDelete(
              template.title,
              async () => {
                await p.mutate(
                  `/fitness/templates/${template.id}`,
                  'DELETE',
                  undefined,
                  template,
                  'workout_template',
                );
                close();
              },
              p.report,
            )
          }
        />
      </Row>
      <Button
        label="＋ Add planned exercise"
        tone="quiet"
        disabled={!exercises.length}
        onPress={() => setForm('new')}
      />
      {!exercises.length ? (
        <Text style={styles.body}>Add an exercise to the library before creating a plan.</Text>
      ) : null}
      {(template.exercises ?? []).map((ex: Item, index: number) => (
        <Card key={ex.id}>
          <Text style={styles.cardTitle}>
            {index + 1}. {exercises.find((e) => e.id === ex.exercise_id)?.name ?? 'Archived exercise'}
          </Text>
          <Text style={styles.body}>
            {ex.target_sets} sets × {ex.target_reps ?? '—'} reps · {ex.target_weight_kg ?? '—'} kg · Rest{' '}
            {ex.rest_seconds ?? '—'} sec
          </Text>
          <Row>
            <Button label="Edit" tone="quiet" small onPress={() => setForm(ex)} />
            {index > 0 ? (
              <Button
                label="Move up"
                tone="quiet"
                small
                onPress={() => {
                  const next = [...template.exercises];
                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                  return saveExercises(next);
                }}
              />
            ) : null}
            <Button
              label="Remove"
              tone="danger"
              small
              onPress={() => saveExercises(template.exercises.filter((e: Item) => e.id !== ex.id))}
            />
          </Row>
        </Card>
      ))}
      {plan ? (
        <FormSheet
          title="Schedule workout"
          fields={[
            { key: 'title', label: 'Workout task', required: true },
            { key: 'planned_date', label: 'Planned date YYYY-MM-DD', required: true },
            {
              key: 'estimated_minutes',
              label: 'Estimated minutes',
              type: 'number',
              required: true,
              min: 1,
              max: 1440,
            },
          ]}
          initial={{ title: template.title, estimated_minutes: 60 }}
          close={() => setPlan(false)}
          submit={async (values) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(values.planned_date))
              throw new Error('Use YYYY-MM-DD for the date.');
            const id = newId();
            const now = new Date().toISOString();
            return p.queue(
              'task.create',
              'task',
              id,
              { id, source_type: 'workout', workout_template_id: template.id, ...values },
              {
                id,
                version: '1',
                source_type: 'workout',
                workout_template_id: template.id,
                status: 'ready',
                priority: 3,
                pinned: false,
                due_at: null,
                hard_deadline: false,
                created_at: now,
                updated_at: now,
                deleted_at: null,
                ...values,
              },
            );
          }}
        />
      ) : null}
      {form ? (
        <FormSheet
          title="Planned exercise"
          fields={[
            {
              key: 'exercise_id',
              label: 'Exercise',
              required: true,
              options: exercises.map((e) => ({ value: e.id, label: e.name })),
            },
            { key: 'target_sets', label: 'Planned sets', required: true, type: 'number', min: 1, max: 100 },
            { key: 'target_reps', label: 'Target reps', type: 'number', min: 0, max: 10000 },
            { key: 'target_weight_kg', label: 'Target weight (kg)', type: 'number', min: 0 },
            { key: 'rest_seconds', label: 'Rest (seconds)', type: 'number', min: 0, max: 3600 },
          ]}
          initial={form === 'new' ? { target_sets: 3, target_reps: 8, rest_seconds: 120 } : form}
          close={() => setForm(null)}
          submit={(values) => {
            const id = form === 'new' ? newId() : form.id;
            const next = { id, ...values } as Item;
            return saveExercises(
              form === 'new'
                ? [...template.exercises, next]
                : template.exercises.map((e: Item) => (e.id === id ? next : e)),
            );
          }}
        />
      ) : null}
    </DetailSheet>
  );
}
function SessionDetail({
  initial,
  current,
  exercises,
  close,
}: {
  initial: Item;
  current?: Item;
  exercises: Item[];
  close: () => void;
}) {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const session = current ?? initial;
  const [addExercise, setAddExercise] = useState(false);
  const [setForm, setSetForm] = useState<{ exercise: Item; set?: Item } | null>(null);
  const [cardioForm, setCardioForm] = useState<Item | 'new' | null>(null);
  const [notes, setNotes] = useState(false);
  const [sessionExercises, setSessionExercises] = useState<Item[]>([]);
  const [sets, setSets] = useState<Item[]>([]);
  const [cardio, setCardio] = useState<Item[]>([]);
  React.useEffect(() => {
    let active = true;
    const load = async () => {
      if (!p.runtime) return;
      const [a, b, c] = await Promise.all([
        p.runtime.store.list('session_exercise'),
        p.runtime.store.list('workout_set'),
        p.runtime.store.list('cardio_entry'),
      ]);
      if (active) {
        setSessionExercises(
          (a as Item[]).filter((e) => e.session_id === session.id).sort((x, y) => x.position - y.position),
        );
        setSets((b as Item[]).filter((e) => e.session_id === session.id));
        setCardio((c as Item[]).filter((e) => e.session_id === session.id));
      }
    };
    void load().catch(p.report);
    return () => {
      active = false;
    };
  }, [p.runtime, p.revision, session.id]);
  const volume = sets
    .filter((s) => s.completed_at && s.entered_weight !== null)
    .reduce(
      (sum, s) =>
        sum + Number(s.entered_weight) * (s.entered_weight_unit === 'lb' ? 0.45359237 : 1) * Number(s.reps),
      0,
    );
  const dependent = async (type: string, id: string) => p.runtime?.store.lastOperation(type, id);
  const finish = async () => {
    if (!p.runtime) return;
    const freshExercises = (await p.runtime.store.list('session_exercise')).filter(
      (x) => x.session_id === session.id,
    ) as Item[];
    const freshSets = (await p.runtime.store.list('workout_set')).filter(
      (x) => x.session_id === session.id,
    ) as Item[];
    const freshCardio = (await p.runtime.store.list('cardio_entry')).filter(
      (x) => x.session_id === session.id,
    ) as Item[];
    const ids = new Set([
      session.id,
      ...freshExercises.map((x) => x.id),
      ...freshSets.map((x) => x.id),
      ...freshCardio.map((x) => x.id),
    ]);
    const unresolved = await p.runtime.store.outbox();
    if (unresolved.some((x) => ids.has(x.entity_id) && ['conflict', 'rejected'].includes(x.status)))
      throw new Error(
        'This workout has unresolved conflicts. Review them in Settings first. Original records remain preserved.',
      );
    const pending = await p.runtime.store.pending();
    const last = pending.filter((x) => ids.has(x.entity_id)).at(-1)?.client_operation_id;
    const ended = new Date().toISOString();
    const freshVolume = freshSets
      .filter((s) => s.completed_at && s.entered_weight !== null)
      .reduce(
        (sum, s) =>
          sum + Number(s.entered_weight) * (s.entered_weight_unit === 'lb' ? 0.45359237 : 1) * Number(s.reps),
        0,
      );
    await p.queue(
      'workout.session.complete',
      'workout_session',
      session.id,
      { ended_at: ended, complete_planned_task: Boolean(session.planned_task_id) },
      {
        ...session,
        status: 'completed',
        ended_at: ended,
        exercises: freshExercises,
        sets: freshSets,
        cardio: freshCardio,
        volume_kg_reps: freshVolume,
      },
      last,
    );
  };
  return (
    <DetailSheet title={session.template_snapshot?.title ?? 'Free workout'} visible close={close}>
      <Row>
        <Chip color={colors.orange}>{humanLabel(session.status)}</Chip>
        <Chip color={colors.teal}>{sets.filter((s) => s.completed_at).length} completed sets</Chip>
      </Row>
      <Text style={styles.body}>
        {dateLabel(session.started_at)} · {volume.toFixed(0)} kg·reps
      </Text>
      <Text style={styles.help}>
        Volume is one logging metric, not a measure of training quality. Edits to completed workouts retain
        history and recalculate totals.
      </Text>
      <Row>
        <Button
          label="＋ Exercise"
          tone="quiet"
          disabled={!exercises.length}
          onPress={() => setAddExercise(true)}
        />
        <Button label="＋ Cardio" tone="quiet" onPress={() => setCardioForm('new')} />
        <Button label="Workout notes" tone="quiet" onPress={() => setNotes(true)} />
      </Row>
      {!exercises.length ? (
        <Text style={styles.body}>
          Create strength exercises in the library. Cardio can be logged directly offline.
        </Text>
      ) : null}
      {session.notes ? (
        <Card>
          <Text style={styles.body}>{session.notes}</Text>
        </Card>
      ) : null}
      {sessionExercises.map((ex) => (
        <Section
          key={ex.id}
          title={ex.name_snapshot ?? exercises.find((e) => e.id === ex.exercise_id)?.name ?? 'Exercise'}
        >
          {sets
            .filter((s) => s.session_exercise_id === ex.id)
            .sort((a, b) => a.set_order - b.set_order)
            .map((set) => (
              <Card key={set.id}>
                <Row>
                  <Chip color={set.completed_at ? colors.teal : colors.orange}>
                    {set.completed_at ? '✓ Completed' : 'Planned set'} {set.set_order + 1}
                  </Chip>
                  <Text style={styles.cardTitle}>
                    {set.entered_weight ?? 'Bodyweight'}{' '}
                    {set.entered_weight !== null ? set.entered_weight_unit : ''} × {set.reps}
                  </Text>
                </Row>
                <Row>
                  {!set.completed_at ? (
                    <Button
                      label="Complete set"
                      small
                      disabled={Number(set.reps) <= 0}
                      onPress={() =>
                        p.queue(
                          'workout.set.update',
                          'workout_set',
                          set.id,
                          { completed_at: new Date().toISOString() },
                          { ...set, completed_at: new Date().toISOString() },
                        )
                      }
                    />
                  ) : null}
                  <Button label="Edit" small tone="quiet" onPress={() => setSetForm({ exercise: ex, set })} />
                  <Button
                    label="Delete set"
                    small
                    tone="danger"
                    onPress={() =>
                      confirmDelete(
                        'this set',
                        () =>
                          p.queue(
                            'workout.set.delete',
                            'workout_set',
                            set.id,
                            {},
                            { ...set, deleted_at: new Date().toISOString() },
                          ),
                        p.report,
                      )
                    }
                  />
                </Row>
              </Card>
            ))}
          <Button label="＋ Add set" tone="quiet" onPress={() => setSetForm({ exercise: ex })} />
        </Section>
      ))}
      {cardio.map((entry) => (
        <Card key={entry.id}>
          <Chip color={colors.teal}>Cardio</Chip>
          <Text style={styles.cardTitle}>
            {humanLabel(entry.activity_type)} · {Math.round(entry.duration_seconds / 60)} min
          </Text>
          <Text style={styles.body}>
            {entry.distance} {entry.distance_unit}{' '}
            {entry.average_heart_rate ? `· Average heart rate ${entry.average_heart_rate}` : ''}
          </Text>
          <Row>
            <Button label="Edit" tone="quiet" small onPress={() => setCardioForm(entry)} />
            <Button
              label="Delete"
              tone="danger"
              small
              onPress={() =>
                confirmDelete(
                  entry.activity_type,
                  () =>
                    p.queue(
                      'workout.cardio.delete',
                      'cardio_entry',
                      entry.id,
                      {},
                      { ...entry, deleted_at: new Date().toISOString() },
                    ),
                  p.report,
                )
              }
            />
          </Row>
        </Card>
      ))}
      {session.status === 'in_progress' ? (
        <Button
          label={session.planned_task_id ? 'Finish workout and linked task' : 'Finish workout'}
          onPress={finish}
        />
      ) : (
        <Button
          label="Archive workout"
          tone="danger"
          onPress={() =>
            confirmDelete(
              'this workout',
              async () => {
                await p.mutate(
                  `/fitness/sessions/${session.id}`,
                  'DELETE',
                  undefined,
                  session,
                  'workout_session',
                );
                close();
              },
              p.report,
            )
          }
        />
      )}
      {addExercise ? (
        <FormSheet
          title="Add actual exercise"
          fields={[
            {
              key: 'exercise_id',
              label: 'Exercise',
              required: true,
              options: exercises.map((e) => ({ value: e.id, label: e.name })),
            },
          ]}
          close={() => setAddExercise(false)}
          submit={async (values) => {
            const id = newId();
            const ex = exercises.find((e) => e.id === values.exercise_id);
            return p.queue(
              'workout.exercise.create',
              'session_exercise',
              id,
              {
                id,
                session_id: session.id,
                exercise_id: values.exercise_id,
                position: Math.max(-1, ...sessionExercises.map((e) => Number(e.position))) + 1,
              },
              {
                id,
                version: '1',
                session_id: session.id,
                exercise_id: values.exercise_id,
                name_snapshot: ex?.name ?? 'Exercise',
                position: Math.max(-1, ...sessionExercises.map((e) => Number(e.position))) + 1,
              },
              await dependent('workout_session', session.id),
            );
          }}
        />
      ) : null}
      {setForm ? (
        <FormSheet
          title={setForm.set ? 'Edit set' : 'Add set'}
          fields={setFields}
          initial={setForm.set ?? { entered_weight_unit: 'kg', reps: 8 }}
          close={() => setSetForm(null)}
          submit={async (values) => {
            if (setForm.set?.completed_at && Number(values.reps) <= 0)
              throw new Error('Completed sets must have at least one rep.');
            const id = setForm.set?.id ?? newId();
            const base = {
              session_id: session.id,
              session_exercise_id: setForm.exercise.id,
              exercise_id: setForm.exercise.exercise_id,
              set_order:
                Math.max(
                  -1,
                  ...sets
                    .filter((s) => s.session_exercise_id === setForm.exercise.id)
                    .map((s) => Number(s.set_order)),
                ) + 1,
              completed_at: null,
            };
            if (setForm.set)
              return p.queue('workout.set.update', 'workout_set', id, values, { ...setForm.set, ...values });
            const payload = {
              id,
              session_id: session.id,
              session_exercise_id: setForm.exercise.id,
              set_order: base.set_order,
              ...values,
              completed_at: null,
            };
            return p.queue(
              'workout.set.create',
              'workout_set',
              id,
              payload,
              { id, version: '1', ...base, ...values },
              await dependent('session_exercise', setForm.exercise.id),
            );
          }}
        />
      ) : null}
      {cardioForm ? (
        <FormSheet
          title="Cardio entry"
          fields={[
            { key: 'activity_type', label: 'Activity', required: true },
            { key: 'minutes', label: 'min', type: 'number', min: 1, required: true },
            { key: 'distance', label: 'Distance', type: 'number', min: 0, required: true },
            {
              key: 'distance_unit',
              label: 'Distance unit',
              options: ['km', 'm', 'mi'].map((value) => ({ value, label: humanLabel(value) })),
            },
            { key: 'average_heart_rate', label: 'Average heart rate', type: 'number', min: 20, max: 300 },
            {
              key: 'perceived_intensity',
              label: 'Perceived intensity 1–10',
              type: 'number',
              min: 1,
              max: 10,
            },
          ]}
          initial={
            cardioForm === 'new'
              ? { distance: 0, distance_unit: 'km', minutes: 20 }
              : { ...cardioForm, minutes: cardioForm.duration_seconds / 60 }
          }
          close={() => setCardioForm(null)}
          submit={async (values) => {
            const { minutes, ...rest } = values;
            const payload = { ...rest, duration_seconds: Math.round(Number(minutes) * 60) };
            const id = cardioForm === 'new' ? newId() : cardioForm.id;
            return cardioForm === 'new'
              ? p.queue(
                  'workout.cardio.create',
                  'cardio_entry',
                  id,
                  { id, session_id: session.id, ...payload },
                  { id, version: '1', session_id: session.id, ...payload },
                  await dependent('workout_session', session.id),
                )
              : p.queue('workout.cardio.update', 'cardio_entry', id, payload, { ...cardioForm, ...payload });
          }}
        />
      ) : null}
      {notes ? (
        <FormSheet
          title="Workout notes"
          fields={[{ key: 'notes', label: 'Notes', multiline: true }]}
          initial={session}
          close={() => setNotes(false)}
          submit={(values) =>
            p.queue('workout.session.update', 'workout_session', session.id, values, {
              ...session,
              ...values,
            })
          }
        />
      ) : null}
    </DetailSheet>
  );
}
function Progression({ exercise, close }: { exercise: Item; close: () => void }) {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  React.useEffect(() => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 90 * 86400000).toISOString();
    void p
      .get(
        `/fitness/progression?exercise_id=${exercise.id}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      )
      .then(setData)
      .catch((e) => setError(e.message));
  }, [exercise.id, p.get, p.revision]);
  return (
    <DetailSheet visible title={`${exercise.name} · Last 90 days`} close={close}>
      <Loading loading={!data && !error} error={error} />
      {data ? (
        <>
          <Row>
            <Chip>{data.total_completed_sets} completed sets</Chip>
            <Chip color={colors.teal}>{data.weekly_sessions} sessions this week</Chip>
          </Row>
          <Text style={styles.body}>Comparisons use the same exercise and weights normalized to kg.</Text>
          {(data.points ?? []).map((point: any, index: number) => (
            <Card key={`${point.session_id}-${index}`}>
              <Text style={styles.cardTitle}>
                {point.max_weight_kg == null ? 'Bodyweight' : `${point.max_weight_kg} kg`} · {point.max_reps}{' '}
                reps
              </Text>
              <Text style={styles.body}>
                {dateLabel(point.started_at)} · {Number(point.volume_kg_reps).toFixed(0)} kg·reps
              </Text>
            </Card>
          ))}
        </>
      ) : null}
    </DetailSheet>
  );
}
