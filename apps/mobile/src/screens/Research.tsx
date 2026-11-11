import { useAppearance } from '../ui/theme';
import React, { useState } from 'react';
import { Text } from 'react-native';
import { newId, useItems, usePrism, type Item } from '../state';
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
  confirmDelete,
  dateLabel,
  humanLabel,
  type Field,
} from '../ui/components';
import { MathView } from '../ui/MathView';
export const taskFields: Field[] = [
  { key: 'title', label: 'Task title', required: true },
  { key: 'description', label: 'Description', multiline: true },
  { key: 'estimated_minutes', label: 'Estimated minutes', type: 'number', min: 1, max: 1440, required: true },
  { key: 'priority', label: 'Priority 1–5', type: 'number', min: 1, max: 5, required: true },
  { key: 'due_at', label: 'Due time', type: 'date', help: 'Optional. Example: 2026-11-09T18:00:00+01:00' },
  { key: 'hard_deadline', label: 'Hard deadline', type: 'toggle' },
  { key: 'pinned', label: 'Pin to plan', type: 'toggle' },
];
export function ResearchScreen() {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const projects = useItems('/research/projects', 'research_project');
  const [edit, setEdit] = useState<Item | 'new' | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const fields: Field[] = [
    { key: 'title', label: 'Project name', required: true },
    { key: 'description', label: 'Research question', multiline: true },
    { key: 'research_area', label: 'Research area' },
    {
      key: 'status',
      label: 'Project status',
      options: ['active', 'paused', 'completed', 'archived'].map((value) => ({
        value,
        label: humanLabel(value),
      })),
    },
    { key: 'importance', label: 'Importance 1–5', type: 'number', min: 1, max: 5, required: true },
    { key: 'deadline', label: 'Due time', type: 'date' },
    { key: 'notes', label: 'Project notes', multiline: true },
    {
      key: 'source_code_locations',
      label: 'Code / resource locations',
      multiline: true,
      help: 'One URL or path per line',
    },
  ];
  return (
    <Screen>
      <Heading
        title="Research"
        subtitle="Questions, evidence and the next step."
        action={<Button label="＋ Project" small onPress={() => setEdit('new')} />}
      />
      <Loading loading={projects.loading} error={projects.error} empty={!projects.items.length} />
      {projects.items.map((project) => (
        <Card key={project.id} onPress={() => setSelected(project)} accent={colors.teal}>
          <Row>
            <Chip color={colors.teal}>{humanLabel(project.status)}</Chip>
            {project.research_area ? <Chip>{project.research_area}</Chip> : null}
          </Row>
          <Text style={styles.cardTitle}>{project.title}</Text>
          <Text style={styles.body} numberOfLines={3}>
            {project.description || 'Add questions, conjectures and evidence to this project.'}
          </Text>
          <Text style={styles.help}>
            Importance {project.importance} ·{' '}
            {project.deadline ? `Due ${dateLabel(project.deadline)}` : 'No hard deadline'}
          </Text>
        </Card>
      ))}
      {edit ? (
        <FormSheet
          title={edit === 'new' ? 'New research project' : 'Edit research project'}
          fields={fields}
          initial={
            edit === 'new'
              ? { status: 'active', importance: 3 }
              : { ...edit, source_code_locations: (edit.source_code_locations ?? []).join('\n') }
          }
          close={() => setEdit(null)}
          submit={(values) => {
            const payload = {
              ...values,
              source_code_locations: String(values.source_code_locations)
                .split('\n')
                .map((x) => x.trim())
                .filter(Boolean),
            };
            return edit === 'new'
              ? p.mutate(
                  '/research/projects',
                  'POST',
                  { id: newId(), ...payload },
                  undefined,
                  'research_project',
                )
              : p.mutate(`/research/projects/${edit.id}`, 'PATCH', payload, edit, 'research_project');
          }}
        />
      ) : null}
      {selected ? (
        <ProjectDetail
          project={projects.items.find((i) => i.id === selected.id) ?? selected}
          close={() => setSelected(null)}
          edit={() => {
            setEdit(selected);
            setSelected(null);
          }}
        />
      ) : null}
    </Screen>
  );
}
function ProjectDetail({ project, close, edit }: { project: Item; close: () => void; edit: () => void }) {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const objects = useItems(`/research/projects/${project.id}/objects`, 'research_object');
  const tasks = useItems(`/tasks?project_id=${project.id}`, 'task');
  const timeline = useItems(`/research/projects/${project.id}/timeline`, 'research_event');
  const knowledge = useItems('/knowledge-items', 'knowledge_item');
  const links = useItems('/research/knowledge-links', 'research_knowledge_link');
  const [objectForm, setObjectForm] = useState<Item | 'new' | null>(null);
  const [object, setObject] = useState<Item | null>(null);
  const [taskForm, setTaskForm] = useState<Item | 'new' | null>(null);
  const [linkObject, setLinkObject] = useState<Item | null>(null);
  const ofields: Field[] = [
    { key: 'title', label: 'Object title', required: true },
    {
      key: 'object_type',
      label: 'Object type',
      options: [
        'question',
        'conjecture',
        'theorem',
        'lemma',
        'proof_attempt',
        'counterexample',
        'experiment',
        'observation',
        'literature_note',
      ].map((value) => ({ value, label: humanLabel(value) })),
    },
    { key: 'content', label: 'Mathematical content', multiline: true, required: true },
    {
      key: 'claim_status',
      label: 'Mathematical claim status',
      options: ['needs_verification', 'conjecture', 'computationally_verified', 'proved', 'disproved'].map(
        (value) => ({ value, label: humanLabel(value) }),
      ),
    },
    { key: 'proof_content', label: 'Proof text', multiline: true },
    { key: 'evidence_reference', label: 'Proof / experiment reference' },
    {
      key: 'scope',
      label: 'Computational verification scope',
      help: 'Required for computational verification, for example n≤100',
    },
    { key: 'result', label: 'Computational evidence / result', multiline: true },
  ];
  const scopedObjects = objects.items.filter((i) => i.project_id === project.id);
  const scopedTasks = tasks.items.filter((i) => i.project_id === project.id);
  const taskSave = async (values: Record<string, any>) => {
    if (values.hard_deadline && !values.due_at) throw new Error('Enter a hard deadline.');
    const current = taskForm !== 'new' ? taskForm : null;
    const id = current?.id ?? newId();
    const now = new Date().toISOString();
    const payload = { ...values, project_id: project.id };
    if (current) await p.queue('task.update', 'task', id, payload, { ...current, ...payload });
    else
      await p.queue(
        'task.create',
        'task',
        id,
        { id, source_type: 'research', status: 'ready', ...payload },
        {
          id,
          version: '1',
          created_at: now,
          updated_at: now,
          deleted_at: null,
          source_type: 'research',
          status: 'ready',
          ...payload,
        },
      );
  };
  return (
    <DetailSheet title={project.title} visible close={close}>
      <Row>
        <Chip color={colors.teal}>{humanLabel(project.status)}</Chip>
        <Chip>{project.research_area || 'Research'}</Chip>
      </Row>
      <Text style={styles.body}>{project.description}</Text>
      {project.notes ? (
        <Card>
          <MathView content={project.notes} />
        </Card>
      ) : null}
      <Row>
        <Button label="Edit project" tone="quiet" onPress={edit} />
        <Button
          label="Archive project"
          tone="danger"
          onPress={() =>
            confirmDelete(
              project.title,
              async () => {
                await p.mutate(
                  `/research/projects/${project.id}`,
                  'DELETE',
                  undefined,
                  project,
                  'research_project',
                );
                close();
              },
              p.report,
            )
          }
        />
      </Row>
      <Section title="Questions, conjectures and evidence">
        <Button label="＋ Research object" tone="quiet" onPress={() => setObjectForm('new')} />
        <Loading loading={objects.loading} error={objects.error} />
        {scopedObjects.map((item) => (
          <Card key={item.id} onPress={() => setObject(item)}>
            <Row>
              <Chip color={item.claim_status === 'proved' ? colors.teal : colors.orange}>
                {humanLabel(item.claim_status)}
              </Chip>
              <Chip>{humanLabel(item.object_type)}</Chip>
            </Row>
            <Text style={styles.cardTitle}>{item.title}</Text>
            <Text style={styles.body} numberOfLines={2}>
              {item.content}
            </Text>
          </Card>
        ))}
      </Section>
      <Section title="Next tasks">
        <Button label="＋ Research task" tone="quiet" onPress={() => setTaskForm('new')} />
        {scopedTasks.map((task) => (
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
            <Row>
              {task.status !== 'completed' ? (
                <Button
                  label="Complete task"
                  small
                  onPress={() =>
                    p.queue(
                      'task.complete',
                      'task',
                      task.id,
                      { completed_at: new Date().toISOString() },
                      { ...task, status: 'completed', completed_at: new Date().toISOString() },
                    )
                  }
                />
              ) : null}
              <Button label="Edit" tone="quiet" small onPress={() => setTaskForm(task)} />
              <Button
                label="Archive"
                tone="quiet"
                small
                onPress={() =>
                  confirmDelete(
                    task.title,
                    () => p.mutate(`/tasks/${task.id}`, 'DELETE', undefined, task, 'task'),
                    p.report,
                  )
                }
              />
            </Row>
          </Card>
        ))}
      </Section>
      <Section title="Research timeline">
        {timeline.items
          .filter((i) => i.project_id === project.id)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, 30)
          .map((event) => (
            <Card key={event.id}>
              <Text style={styles.cardTitle}>{humanLabel(event.event_type)}</Text>
              <Text style={styles.body}>{dateLabel(event.created_at)}</Text>
              <Text style={styles.help}>{JSON.stringify(event.event_payload)}</Text>
            </Card>
          ))}
      </Section>
      {objectForm ? (
        <FormSheet
          title={objectForm === 'new' ? 'New research object' : 'Edit research object'}
          fields={ofields}
          initial={
            objectForm === 'new'
              ? { object_type: 'conjecture', claim_status: 'conjecture' }
              : {
                  ...objectForm,
                  scope: objectForm.evidence_metadata?.scope ?? '',
                  result: objectForm.evidence_metadata?.result ?? '',
                }
          }
          close={() => setObjectForm(null)}
          submit={(values) => {
            const { scope, result, ...rest } = values;
            if (rest.claim_status === 'computationally_verified' && (!scope || !result))
              throw new Error('Computational verification requires a scope and result.');
            if (rest.claim_status === 'proved' && !rest.proof_content && !rest.evidence_reference)
              throw new Error('A proved claim requires proof text or a reference.');
            const payload = {
              ...rest,
              evidence_metadata: { scope, result },
              proof_content: rest.proof_content || null,
              evidence_reference: rest.evidence_reference || null,
            };
            return objectForm === 'new'
              ? p.mutate(
                  `/research/projects/${project.id}/objects`,
                  'POST',
                  { id: newId(), ...payload },
                  undefined,
                  'research_object',
                )
              : p.mutate(
                  `/research/objects/${objectForm.id}`,
                  'PATCH',
                  { ...payload, base_snapshot: objectForm },
                  objectForm,
                  'research_object',
                );
          }}
        />
      ) : null}
      {taskForm ? (
        <FormSheet
          title={taskForm === 'new' ? 'New research task' : 'Edit task'}
          fields={taskFields}
          initial={taskForm === 'new' ? { estimated_minutes: 30, priority: 3 } : taskForm}
          close={() => setTaskForm(null)}
          submit={taskSave}
        />
      ) : null}
      {object ? (
        <DetailSheet title={object.title} visible close={() => setObject(null)}>
          <Chip color={colors.orange}>{humanLabel(object.claim_status)}</Chip>
          <Card>
            <MathView content={object.content ?? ''} />
          </Card>
          {object.proof_content ? (
            <Section title="Proof text">
              <Card>
                <MathView content={object.proof_content} />
              </Card>
            </Section>
          ) : null}
          {object.evidence_reference ? (
            <Text style={styles.body}>Evidence: {object.evidence_reference}</Text>
          ) : null}
          {object.evidence_metadata?.scope ? (
            <Card>
              <Text style={styles.body}>Computational scope: {object.evidence_metadata.scope}</Text>
              <Text style={styles.body}>{object.evidence_metadata.result}</Text>
            </Card>
          ) : null}
          <Row>
            <Button
              label="Edit / change status"
              tone="quiet"
              onPress={() => {
                setObjectForm(object);
                setObject(null);
              }}
            />
            <Button
              label="Linked knowledge"
              tone="quiet"
              disabled={!knowledge.items.length}
              onPress={() => setLinkObject(object)}
            />
            <Button
              label="Archive"
              tone="danger"
              onPress={() =>
                confirmDelete(
                  object.title,
                  async () => {
                    await p.mutate(
                      `/research/objects/${object.id}`,
                      'DELETE',
                      undefined,
                      object,
                      'research_object',
                    );
                    setObject(null);
                  },
                  p.report,
                )
              }
            />
          </Row>
          {links.items
            .filter((l) => l.research_object_id === object.id)
            .map((link) => (
              <Card key={link.id}>
                <Text style={styles.body}>
                  {knowledge.items.find((k) => k.id === link.knowledge_item_id)?.title ?? 'Knowledge item'}
                </Text>
                <Button
                  label="Remove link"
                  tone="quiet"
                  small
                  onPress={() =>
                    p.mutate(
                      `/research/knowledge-links/${link.id}`,
                      'DELETE',
                      undefined,
                      link,
                      'research_knowledge_link',
                    )
                  }
                />
              </Card>
            ))}
        </DetailSheet>
      ) : null}
      {linkObject ? (
        <FormSheet
          title="Link knowledge"
          fields={[
            {
              key: 'knowledge_item_id',
              label: 'Knowledge item',
              required: true,
              options: knowledge.items.map((k) => ({ value: k.id, label: k.title })),
            },
          ]}
          close={() => setLinkObject(null)}
          submit={(values) =>
            p.mutate(
              '/research/knowledge-links',
              'POST',
              { id: newId(), research_object_id: linkObject.id, ...values },
              undefined,
              'research_knowledge_link',
            )
          }
        />
      ) : null}
    </DetailSheet>
  );
}
