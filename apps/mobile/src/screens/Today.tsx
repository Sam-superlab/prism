import { useAppearance } from '../ui/theme';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { newId, useItems, usePrism, useValue, type Item } from '../state';
import {
  Button,
  Card,
  Chip,
  DetailSheet,
  FormSheet,
  Heading,
  Loading,
  Row,
  Screen,
  Section,
  dateLabel,
  humanLabel,
} from '../ui/components';
import { taskFields } from './Research';
export function localToday(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day'].map((key) => parts.find((p) => p.type === key)?.value).join('-');
}
export function TodayScreen({ review, fitness }: { review: () => void; fitness: (task?: Item) => void }) {
  const { colors, styles, font } = useAppearance();
  const p = usePrism();
  const profile = useValue('/me');
  const timezone = profile.value?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = localToday(timezone);
  const today = useValue(`/today?date=${date}`);
  const tasks = useItems('/tasks', 'task');
  const inbox = useItems('/inbox', 'inbox_entry');
  const [capacity, setCapacity] = useState(false);
  const [taskForm, setTaskForm] = useState<Item | 'new' | null>(null);
  const [allTasks, setAllTasks] = useState(false);
  const [inboxView, setInboxView] = useState(false);
  const [shutdown, setShutdown] = useState(false);
  const [classify, setClassify] = useState<Item | null>(null);
  const plan = today.value?.plan as Item | null;
  const planItems: Item[] = [...(plan?.items ?? [])].sort((a, b) => a.position - b.position);
  const pending = planItems.filter(
    (i) =>
      i.status === 'planned' &&
      (!i.task_id || tasks.items.find((t) => t.id === i.task_id)?.status !== 'completed'),
  );
  const deferred = planItems.filter((i) => ['deferred', 'skipped'].includes(i.status));
  const generate = (minutes: number) =>
    p.mutate('/daily-plans/generate', 'POST', {
      plan_date: date,
      timezone,
      capacity_minutes: minutes,
      override_manual: false,
    });
  const complete = (task: Item) => {
    const time = new Date().toISOString();
    return p.queue(
      'task.complete',
      'task',
      task.id,
      { completed_at: time },
      { ...task, status: 'completed', completed_at: time },
    );
  };
  const moveUp = (item: Item) => {
    if (!plan) return;
    const index = planItems.findIndex((i) => i.id === item.id);
    if (index <= 0) return;
    const order = planItems.map((i) => i.id);
    [order[index - 1], order[index]] = [order[index], order[index - 1]];
    return p.mutate(`/daily-plans/${plan.id}/reorder`, 'POST', { item_ids: order }, plan);
  };
  return (
    <Screen>
      <Heading
        title="Today"
        subtitle={`${date} · ${timezone}`}
        action={<Button label="Inbox" small tone="quiet" onPress={() => setInboxView(true)} />}
      />
      <Loading loading={today.loading} error={today.error} />
      <Row>
        {[
          { label: 'Reviews due', value: today.value?.reviews_due_now, color: colors.purple, action: review },
          {
            label: 'Research tasks',
            value: today.value?.research_tasks_due,
            color: colors.teal,
            action: () => setAllTasks(true),
          },
          {
            label: 'Planned workout',
            value: today.value?.planned_workout ? '1' : today.value ? '—' : undefined,
            color: colors.orange,
            action: () => fitness(today.value?.planned_workout),
          },
          {
            label: 'Saved papers',
            value: today.value?.saved_papers,
            color: colors.ink,
            action: () => setAllTasks(true),
          },
        ].map((stat) => (
          <View key={stat.label} style={{ width: '48%', flexGrow: 1 }}>
            <Card onPress={stat.action}>
              <Text style={styles.help}>{stat.label}</Text>
              <Text style={[styles.h1, { color: stat.color }]}>{stat.value ?? '—'}</Text>
            </Card>
          </View>
        ))}
      </Row>
      <Card accent={colors.purple}>
        <Row>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Daily capacity</Text>
            <Text style={styles.body}>
              {today.value?.capacity_minutes ?? '—'} minutes available · Remaining:{' '}
              {today.value?.estimated_remaining_minutes ?? '—'} min
            </Text>
          </View>
          <Button label="Adjust" tone="quiet" small onPress={() => setCapacity(true)} />
        </Row>
        {Number(plan?.overload_minutes) > 0 ? (
          <Text style={{ color: colors.red, lineHeight: font(22) }}>
            Pinned and deadline tasks exceed capacity by {plan?.overload_minutes} minutes. Adjust the plan to
            make room.
          </Text>
        ) : null}
        <Button
          label={plan ? 'Replan · Keep manual choices' : 'Plan my day'}
          onPress={() => generate(Number(today.value?.capacity_minutes ?? 180))}
        />
      </Card>
      <Section title="Your priorities">
        {!pending.length ? (
          <Card>
            <Text style={styles.cardTitle}>{plan ? 'Your queue is clear' : 'Your day is ready to plan'}</Text>
            <Text style={styles.body}>Add tasks, review cards or a workout, then generate your plan.</Text>
          </Card>
        ) : null}
        {pending.map((item) => {
          const task = tasks.items.find((t) => t.id === item.task_id);
          return (
            <Card key={item.id} accent={item.item_type === 'review' ? colors.purple : colors.teal}>
              <Row>
                <Chip>
                  {item.item_type === 'review' ? 'Review session' : humanLabel(task?.source_type ?? 'Task')}
                </Chip>
                <Text style={styles.help}>
                  {item.scheduled_minutes} min {item.pinned ? '· Pinned' : ''}
                </Text>
              </Row>
              <Text style={styles.cardTitle}>{item.title_snapshot}</Text>
              <Text style={styles.body}>{item.priority_reason}</Text>
              {item.next_available_at && Date.parse(item.next_available_at) > Date.now() ? (
                <Text style={styles.help}>Available later: {dateLabel(item.next_available_at)}</Text>
              ) : null}
              <Row>
                {item.item_type === 'review' ? (
                  <Button label="Start review" small onPress={review} />
                ) : task ? (
                  <>
                    <Button
                      label={task.status === 'in_progress' ? 'In progress' : 'Start'}
                      tone="quiet"
                      small
                      onPress={() =>
                        p.queue(
                          'task.update',
                          'task',
                          task.id,
                          { status: 'in_progress' },
                          { ...task, status: 'in_progress' },
                        )
                      }
                    />
                    <Button label="Complete" small onPress={() => complete(task)} />
                  </>
                ) : null}
                <Button
                  label={item.pinned ? 'Unpin' : 'Pin'}
                  tone="quiet"
                  small
                  onPress={() =>
                    p.mutate(
                      `/daily-plans/${plan!.id}/items/${item.id}`,
                      'PATCH',
                      { pinned: !item.pinned },
                      item,
                    )
                  }
                />
                <Button
                  label="Move up"
                  tone="quiet"
                  small
                  disabled={item.position === 0}
                  onPress={() => moveUp(item)}
                />
                <Button
                  label="Defer"
                  tone="quiet"
                  small
                  onPress={() =>
                    p.mutate(
                      `/daily-plans/${plan!.id}/items/${item.id}`,
                      'PATCH',
                      { status: 'deferred', deferred_reason: 'Deferred manually for a later plan' },
                      item,
                    )
                  }
                />
                <Button
                  label="Skip today"
                  tone="quiet"
                  small
                  onPress={() =>
                    p.mutate(
                      `/daily-plans/${plan!.id}/items/${item.id}`,
                      'PATCH',
                      { status: 'skipped' },
                      item,
                    )
                  }
                />
              </Row>
            </Card>
          );
        })}
      </Section>
      {deferred.length ? (
        <Section title="Deferred items">
          {deferred.map((item) => (
            <Card key={item.id}>
              <Text style={styles.cardTitle}>{item.title_snapshot}</Text>
              <Text style={styles.body}>
                {item.deferred_reason ?? 'Skipped today. The task remains available.'}
              </Text>
              <Button
                label="Return to today"
                tone="quiet"
                small
                onPress={() =>
                  p.mutate(
                    `/daily-plans/${plan!.id}/items/${item.id}`,
                    'PATCH',
                    { status: 'planned', deferred_reason: null },
                    item,
                  )
                }
              />
            </Card>
          ))}
        </Section>
      ) : null}
      <Row>
        <Button label="All tasks" tone="quiet" onPress={() => setAllTasks(true)} />
        <Button label="＋ New task" tone="quiet" onPress={() => setTaskForm('new')} />
        <Button label="Daily reflection" tone="quiet" onPress={() => setShutdown(true)} />
      </Row>
      {capacity ? (
        <FormSheet
          title="Set daily capacity"
          fields={[
            { key: 'minutes', label: 'Available minutes', required: true, type: 'number', min: 0, max: 1440 },
          ]}
          initial={{ minutes: today.value?.capacity_minutes ?? 180 }}
          close={() => setCapacity(false)}
          submit={(values) => generate(Number(values.minutes))}
        />
      ) : null}
      {allTasks ? (
        <DetailSheet visible title="All tasks" close={() => setAllTasks(false)}>
          <Button label="＋ New task" onPress={() => setTaskForm('new')} />
          {tasks.items.map((task) => (
            <Card key={task.id}>
              <Row>
                <Chip color={task.status === 'completed' ? colors.teal : colors.purple}>
                  {humanLabel(task.status)}
                </Chip>
                <Text style={styles.help}>
                  {task.estimated_minutes} min · P{task.priority}
                </Text>
              </Row>
              <Text style={styles.cardTitle}>{task.title}</Text>
              <Text style={styles.body}>{task.description}</Text>
              {task.due_at ? (
                <Text style={styles.help}>
                  {task.hard_deadline ? 'Hard deadline' : 'Due'} {dateLabel(task.due_at)}
                </Text>
              ) : null}
              <Row>
                {task.status !== 'completed' ? (
                  <Button label="Complete" small onPress={() => complete(task)} />
                ) : null}
                <Button label="Edit / reschedule" tone="quiet" small onPress={() => setTaskForm(task)} />
              </Row>
            </Card>
          ))}
        </DetailSheet>
      ) : null}
      {taskForm ? (
        <FormSheet
          title={taskForm === 'new' ? 'New task' : 'Edit task'}
          fields={[
            ...taskFields,
            {
              key: 'planned_date',
              label: 'Planned date',
              placeholder: 'YYYY-MM-DD',
              help: 'Leave blank for flexible scheduling. Deadlines stay unchanged.',
            },
          ]}
          initial={taskForm === 'new' ? { estimated_minutes: 30, priority: 3 } : taskForm}
          close={() => setTaskForm(null)}
          submit={async (values) => {
            if (values.hard_deadline && !values.due_at) throw new Error('Enter a hard deadline.');
            if (values.planned_date && !/^\d{4}-\d{2}-\d{2}$/.test(values.planned_date))
              throw new Error('Use YYYY-MM-DD for the planned date.');
            values.planned_date ||= null;
            const now = new Date().toISOString();
            if (taskForm === 'new') {
              const id = newId();
              return p.queue(
                'task.create',
                'task',
                id,
                { id, source_type: 'general', ...values },
                {
                  id,
                  version: '1',
                  source_type: 'general',
                  status: 'ready',
                  ...values,
                  created_at: now,
                  updated_at: now,
                  deleted_at: null,
                },
              );
            }
            return p.queue('task.update', 'task', taskForm.id, values, { ...taskForm, ...values });
          }}
        />
      ) : null}
      {inboxView ? (
        <DetailSheet visible title="Capture inbox" close={() => setInboxView(false)}>
          <Text style={styles.body}>Keep unclassified ideas here and organize them later.</Text>
          {inbox.items
            .filter((i) => !i.classified_task_id && !i.classified_knowledge_id)
            .map((entry) => (
              <Card key={entry.id}>
                <Text style={styles.body}>{entry.content}</Text>
                <Button
                  label="Organize as knowledge / task"
                  tone="quiet"
                  onPress={() => setClassify(entry)}
                />
              </Card>
            ))}
        </DetailSheet>
      ) : null}
      {classify ? (
        <FormSheet
          title="Organize inbox"
          fields={[
            {
              key: 'destination',
              label: 'Save to',
              options: [
                { value: 'knowledge', label: 'Knowledge note' },
                { value: 'task', label: 'General task' },
              ],
            },
            { key: 'title', label: 'Title', required: true },
            { key: 'estimated_minutes', label: 'Estimated task minutes', type: 'number', min: 1, max: 1440 },
          ]}
          initial={{ title: String(classify.content).slice(0, 100), estimated_minutes: 30 }}
          close={() => setClassify(null)}
          submit={(values) =>
            p.mutate(
              `/inbox/${classify.id}/classify`,
              'POST',
              {
                destination: values.destination,
                item:
                  values.destination === 'knowledge'
                    ? { id: newId(), title: values.title, type: 'note', content: classify.content }
                    : {
                        id: newId(),
                        title: values.title,
                        description: classify.content,
                        source_type: 'general',
                        estimated_minutes: values.estimated_minutes,
                      },
              },
              classify,
              'inbox_entry',
            )
          }
        />
      ) : null}
      {shutdown ? <Shutdown date={date} plan={plan} close={() => setShutdown(false)} /> : null}
    </Screen>
  );
}
function Shutdown({ date, plan, close }: { date: string; plan: Item | null; close: () => void }) {
  const { styles } = useAppearance();
  const p = usePrism();
  const summary = useValue(`/today/shutdown?date=${date}`);
  const [form, setForm] = useState(false);
  return (
    <DetailSheet visible title="Daily reflection" close={close}>
      <Loading loading={summary.loading} error={summary.error} />
      {summary.value ? (
        <>
          <Card>
            <Text style={styles.cardTitle}>Today in review</Text>
            <Text style={styles.body}>
              {summary.value.completed_task_ids?.length ?? 0} tasks · {summary.value.review_count} review
              cards · {summary.value.workout_count} workouts
            </Text>
            <Text style={styles.body}>
              {summary.value.research_event_count} research updates ·{' '}
              {summary.value.deferred_item_ids?.length ?? 0} deferred items
            </Text>
          </Card>
          <Row>
            {Object.entries(summary.value.rating_counts ?? {}).map(([rating, count]) => (
              <Chip key={rating}>
                {rating} {String(count)}
              </Chip>
            ))}
          </Row>
          <Text style={styles.body}>{summary.value.note}</Text>
        </>
      ) : null}
      <Button label="Save reflection" disabled={!plan} onPress={() => setForm(true)} />
      {!plan ? <Text style={styles.help}>Create a daily plan before saving a reflection.</Text> : null}
      {form ? (
        <FormSheet
          title="Finish the day"
          fields={[{ key: 'note', label: 'Progress, learning and priorities for tomorrow', multiline: true }]}
          close={() => setForm(false)}
          submit={(values) => p.mutate(`/daily-plans/${plan!.id}/shutdown`, 'POST', values)}
        />
      ) : null}
    </DetailSheet>
  );
}
