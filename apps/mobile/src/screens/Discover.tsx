import { useAppearance } from '../ui/theme';
import React, { useState } from 'react';
import { Linking, Text, TextInput } from 'react-native';
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
export function DiscoverScreen() {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const feed = useItems('/arxiv/feed', 'user_paper');
  const subscriptions = useItems('/arxiv/subscriptions', 'arxiv_subscription');
  const projects = useItems('/research/projects', 'research_project');
  const [filter, setFilter] = useState('unread');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const [subs, setSubs] = useState(false);
  const [subForm, setSubForm] = useState<Item | 'new' | null>(null);
  const [task, setTask] = useState<Item | null>(null);
  const [link, setLink] = useState<Item | null>(null);
  const filtered = feed.items
    .filter(
      (i) =>
        (filter === 'saved' ? i.is_saved : filter === 'all' || i.status === filter) &&
        `${i.paper?.title} ${i.paper?.abstract} ${(i.paper?.authors ?? []).join(' ')}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => Number(b.relevance_score) - Number(a.relevance_score));
  const paper = selected ? (feed.items.find((x) => x.id === selected.id) ?? selected) : null;
  const sf: Field[] = [
    {
      key: 'subscription_type',
      label: 'Subscription type',
      options: ['category', 'keyword', 'author', 'topic'].map((value) => ({
        value,
        label: humanLabel(value),
      })),
    },
    {
      key: 'subscription_value',
      label: 'Subscription value',
      required: true,
      help: 'For example, math.AC, a full author name, or a keyword',
    },
    { key: 'weight', label: 'Match weight 1–10', type: 'number', min: 1, max: 10, required: true },
    { key: 'enabled', label: 'Subscription enabled', type: 'toggle' },
  ];
  const openSource = (url: string) => {
    if (!/^https:\/\/arxiv\.org\//.test(url)) throw new Error('This link is not a valid arXiv source.');
    return Linking.openURL(url);
  };
  return (
    <Screen>
      <Heading
        title="Discover"
        subtitle="New papers. New questions."
        action={<Button label="Subscriptions" tone="quiet" small onPress={() => setSubs(true)} />}
      />
      <TextInput
        accessibilityLabel="Search papers"
        value={search}
        onChangeText={setSearch}
        placeholder="Title, author or abstract keywords"
        style={styles.input}
      />
      <Row>
        {[
          { value: 'unread', label: 'Unread' },
          { value: 'saved', label: 'Saved' },
          { value: 'read', label: 'Read' },
          { value: 'all', label: 'All' },
        ].map((f) => (
          <Button
            key={f.value}
            label={f.label}
            tone={filter === f.value ? 'primary' : 'quiet'}
            small
            onPress={() => setFilter(f.value)}
          />
        ))}
      </Row>
      <Loading loading={feed.loading} error={feed.error} empty={!filtered.length} />
      {filtered.map((item) => (
        <Card key={item.id} onPress={() => setSelected(item)}>
          <Row>
            <Chip color={colors.teal}>{item.paper?.categories?.[0] ?? 'arXiv'}</Chip>
            <Chip>v{item.paper?.latest_version ?? 1}</Chip>
            {item.is_saved ? <Chip color={colors.orange}>Saved</Chip> : null}
          </Row>
          <Text style={styles.cardTitle}>{item.paper?.title ?? 'Paper metadata awaiting sync'}</Text>
          <Text style={styles.help}>{(item.paper?.authors ?? []).join(', ')}</Text>
          <Text style={styles.body} numberOfLines={3}>
            {item.paper?.abstract}
          </Text>
          <Text style={styles.help}>
            {dateLabel(item.paper?.updated_at)} · Match {Number(item.relevance_score ?? 0).toFixed(0)}
          </Text>
        </Card>
      ))}
      {paper ? (
        <DetailSheet visible title={paper.paper?.title ?? 'Paper'} close={() => setSelected(null)}>
          <Text style={styles.body}>{(paper.paper?.authors ?? []).join(', ')}</Text>
          <Row>
            {(paper.paper?.categories ?? []).map((c: string) => (
              <Chip key={c} color={colors.teal}>
                {c}
              </Chip>
            ))}
          </Row>
          <Card>
            <MathView content={paper.paper?.abstract ?? ''} />
          </Card>
          <Section title="Why this paper matched">
            {(paper.match_reasons ?? []).map((reason: any, index: number) => (
              <Text key={index} style={styles.body}>
                {typeof reason === 'string' ? reason : JSON.stringify(reason)}
              </Text>
            ))}
          </Section>
          <Row>
            <Button
              label={paper.is_saved ? 'Unsave paper' : 'Saved papers'}
              onPress={() =>
                paper.is_saved
                  ? p.mutate(
                      `/arxiv/papers/${paper.paper_id}/state`,
                      'PATCH',
                      { is_saved: false },
                      paper,
                      'user_paper',
                    )
                  : p.mutate(
                      `/arxiv/papers/${paper.paper_id}/save`,
                      'POST',
                      undefined,
                      undefined,
                      'user_paper',
                    )
              }
            />
            <Button
              label={paper.status === 'read' ? 'Mark unread' : 'Mark read'}
              tone="quiet"
              onPress={() =>
                paper.status === 'read'
                  ? p.mutate(
                      `/arxiv/papers/${paper.paper_id}/state`,
                      'PATCH',
                      { status: 'unread' },
                      paper,
                      'user_paper',
                    )
                  : p.mutate(
                      `/arxiv/papers/${paper.paper_id}/mark-read`,
                      'POST',
                      undefined,
                      undefined,
                      'user_paper',
                    )
              }
            />
            <Button
              label="Not relevant"
              tone="quiet"
              onPress={() =>
                p.mutate(
                  `/arxiv/papers/${paper.paper_id}/state`,
                  'PATCH',
                  { status: 'not_relevant' },
                  paper,
                  'user_paper',
                )
              }
            />
          </Row>
          <Button label="Create reading task" tone="quiet" onPress={() => setTask(paper)} />
          <Button
            label="Link research project"
            tone="quiet"
            disabled={!projects.items.length}
            onPress={() => setLink(paper)}
          />
          <Row>
            <Button label="Open arXiv" tone="quiet" onPress={() => openSource(paper.paper?.source_url)} />
            <Button label="Open PDF" tone="quiet" onPress={() => openSource(paper.paper?.pdf_url)} />
          </Row>
          <Section title="Versions">
            {(paper.paper?.versions ?? []).map((v: any) => (
              <Text key={v.version} style={styles.body}>
                v{v.version} · {dateLabel(v.updated_at)}
              </Text>
            ))}
          </Section>
        </DetailSheet>
      ) : null}
      {subs ? (
        <DetailSheet visible title="arXiv subscriptions" close={() => setSubs(false)}>
          <Text style={styles.body}>One daily digest, with clear category, keyword and author matches.</Text>
          <Button label="＋ New subscription" onPress={() => setSubForm('new')} />
          {subscriptions.items.map((sub) => (
            <Card key={sub.id}>
              <Row>
                <Chip>{humanLabel(sub.subscription_type)}</Chip>
                <Chip color={sub.enabled ? colors.teal : colors.orange}>
                  {sub.enabled ? 'Enable' : 'Pause'}
                </Chip>
              </Row>
              <Text style={styles.cardTitle}>{sub.subscription_value}</Text>
              <Row>
                <Button
                  label={sub.enabled ? 'Pause' : 'Enable'}
                  tone="quiet"
                  small
                  onPress={() =>
                    p.mutate(
                      `/arxiv/subscriptions/${sub.id}`,
                      'PATCH',
                      { enabled: !sub.enabled },
                      sub,
                      'arxiv_subscription',
                    )
                  }
                />
                <Button label="Edit" tone="quiet" small onPress={() => setSubForm(sub)} />
                <Button
                  label="Remove"
                  tone="danger"
                  small
                  onPress={() =>
                    confirmDelete(
                      sub.subscription_value,
                      () =>
                        p.mutate(
                          `/arxiv/subscriptions/${sub.id}`,
                          'DELETE',
                          undefined,
                          sub,
                          'arxiv_subscription',
                        ),
                      p.report,
                    )
                  }
                />
              </Row>
            </Card>
          ))}
        </DetailSheet>
      ) : null}
      {subForm ? (
        <FormSheet
          title={subForm === 'new' ? 'New subscription' : 'Edit subscription'}
          fields={sf}
          initial={
            subForm === 'new'
              ? { subscription_type: 'category', subscription_value: 'math.AC', enabled: true, weight: 1 }
              : subForm
          }
          close={() => setSubForm(null)}
          submit={(values) =>
            subForm === 'new'
              ? p.mutate(
                  '/arxiv/subscriptions',
                  'POST',
                  { id: newId(), ...values },
                  undefined,
                  'arxiv_subscription',
                )
              : p.mutate(`/arxiv/subscriptions/${subForm.id}`, 'PATCH', values, subForm, 'arxiv_subscription')
          }
        />
      ) : null}
      {task ? (
        <FormSheet
          title="Paper reading task"
          fields={[
            { key: 'title', label: 'Task title', required: true },
            {
              key: 'estimated_minutes',
              label: 'Estimated minutes',
              type: 'number',
              required: true,
              min: 1,
              max: 1440,
            },
            { key: 'due_at', label: 'Due time', type: 'date' },
          ]}
          initial={{ title: `Read: ${task.paper?.title}`, estimated_minutes: 30 }}
          close={() => setTask(null)}
          submit={(values) =>
            p.mutate(
              `/arxiv/papers/${task.paper_id}/create-task`,
              'POST',
              { id: newId(), ...values },
              undefined,
              'task',
            )
          }
        />
      ) : null}
      {link ? (
        <FormSheet
          title="Link research project"
          fields={[
            {
              key: 'project_id',
              label: 'Research project',
              required: true,
              options: projects.items.map((pr) => ({ value: pr.id, label: pr.title })),
            },
          ]}
          close={() => setLink(null)}
          submit={(values) =>
            p.mutate(
              '/research/paper-links',
              'POST',
              { id: newId(), paper_id: link.paper_id, ...values },
              undefined,
              'research_paper_link',
            )
          }
        />
      ) : null}
    </Screen>
  );
}
