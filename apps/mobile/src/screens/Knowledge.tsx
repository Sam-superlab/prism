import { useAppearance } from '../ui/theme';
import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
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

const types = [
  'definition',
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'proof',
  'example',
  'counterexample',
  'exercise',
  'note',
];
const kfields: Field[] = [
  { key: 'title', label: 'Title', required: true },
  { key: 'type', label: 'Type', options: types.map((value) => ({ value, label: humanLabel(value) })) },
  { key: 'subject', label: 'Subject / course' },
  { key: 'tags', label: 'Tags', help: 'Separate with commas' },
  {
    key: 'content',
    label: 'Mathematical content',
    multiline: true,
    required: true,
    help: 'Supports $...$ and $$...$$ LaTeX',
  },
  { key: 'proof_content', label: 'Proof / explanation', multiline: true },
  { key: 'source_reference', label: 'Source' },
  {
    key: 'verification_status',
    label: 'Verification status',
    options: [
      { value: 'unverified', label: 'Unverified' },
      { value: 'user_verified', label: 'User verified' },
      { value: 'source_verified', label: 'Source verified' },
    ],
  },
];
export function KnowledgeScreen() {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const list = useItems('/knowledge-items', 'knowledge_item');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const [edit, setEdit] = useState<Item | 'new' | null>(null);
  const [review, setReview] = useState(false);
  const filtered = list.items.filter((i) =>
    `${i.title} ${i.subject} ${(i.tags ?? []).join(' ')}`.toLowerCase().includes(query.toLowerCase()),
  );
  const save = async (values: Record<string, any>) => {
    const current = edit && edit !== 'new' ? edit : null;
    const id = current?.id ?? newId();
    const now = new Date().toISOString();
    const payload = {
      ...values,
      tags: String(values.tags)
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean),
      proof_content: values.proof_content || null,
      source_reference: values.source_reference || null,
    };
    if (current) {
      await p.queue(
        'knowledge.update',
        'knowledge_item',
        id,
        { ...payload, base_snapshot: current },
        { ...current, ...payload },
      );
    } else
      await p.queue(
        'knowledge.create',
        'knowledge_item',
        id,
        { id, ...payload },
        { id, version: '1', created_at: now, updated_at: now, deleted_at: null, ...payload },
      );
    setSelected(null);
  };
  if (review) return <ReviewScreen close={() => setReview(false)} />;
  return (
    <Screen>
      <Heading
        title="Knowledge"
        subtitle="Understand. Recall. Connect."
        action={<Button label="＋ New" small onPress={() => setEdit('new')} />}
      />
      <Card accent={colors.purple}>
        <Text style={styles.cardTitle}>Make understanding last</Text>
        <Text style={styles.body}>
          Review statements, proofs and applications independently, with a history of every recall.
        </Text>
        <Button label="Start review" onPress={() => setReview(true)} />
      </Card>
      <TextInput
        accessibilityLabel="Search knowledge"
        style={styles.input}
        placeholder="Search titles, subjects and tags"
        value={query}
        onChangeText={setQuery}
      />
      <Loading loading={list.loading} error={list.error} empty={!filtered.length} />
      {filtered.map((item) => (
        <Card key={item.id} onPress={() => setSelected(item)}>
          <Row>
            <Chip>{humanLabel(item.type)}</Chip>
            {item.subject ? <Chip color={colors.teal}>{item.subject}</Chip> : null}
          </Row>
          <Text style={styles.cardTitle}>{item.title}</Text>
          <Text style={styles.body} numberOfLines={2}>
            {item.content}
          </Text>
          <Text style={styles.help}>
            {item.verification_status === 'unverified' ? '○ Unverified' : '✓ Verified'} ·{' '}
            {dateLabel(item.updated_at)}
          </Text>
        </Card>
      ))}
      {edit ? (
        <FormSheet
          title={edit === 'new' ? 'New knowledge item' : 'Edit knowledge item'}
          fields={kfields}
          initial={
            edit === 'new'
              ? { type: 'theorem', verification_status: 'unverified' }
              : { ...edit, tags: (edit.tags ?? []).join(', ') }
          }
          close={() => setEdit(null)}
          submit={save}
        />
      ) : null}
      {selected ? (
        <KnowledgeDetail
          item={list.items.find((i) => i.id === selected.id) ?? selected}
          all={list.items}
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
function KnowledgeDetail({
  item,
  all,
  close,
  edit,
}: {
  item: Item;
  all: Item[];
  close: () => void;
  edit: () => void;
}) {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const cards = useItems(`/knowledge-items/${item.id}/cards`, 'review_card');
  const relations = useItems('/knowledge-relations', 'knowledge_relation');
  const [newCard, setNewCard] = useState(false);
  const [editCard, setEditCard] = useState<Item | null>(null);
  const [history, setHistory] = useState<Item | null>(null);
  const [link, setLink] = useState(false);
  const cardFields: Field[] = [
    {
      key: 'card_type',
      label: 'Independent review objective',
      options: ['statement', 'hypotheses', 'proof', 'example', 'counterexample', 'application', 'custom'].map(
        (value) => ({ value, label: humanLabel(value) }),
      ),
    },
    { key: 'prompt', label: 'Prompt', multiline: true, required: true },
    { key: 'answer', label: 'Reference answer', multiline: true, required: true },
  ];
  return (
    <DetailSheet visible title={item.title} close={close}>
      <Row>
        <Chip>{humanLabel(item.type)}</Chip>
        <Chip color={colors.teal}>{humanLabel(item.verification_status)}</Chip>
      </Row>
      <Card>
        <MathView content={item.content ?? ''} />
      </Card>
      {item.proof_content ? (
        <Section title="Proof / explanation">
          <Card>
            <MathView content={item.proof_content} />
          </Card>
        </Section>
      ) : null}
      {item.source_reference ? <Text style={styles.body}>Source: {item.source_reference}</Text> : null}
      <Row>
        <Button label="Edit" tone="quiet" onPress={edit} />
        <Button
          label="Archive"
          tone="danger"
          onPress={() =>
            confirmDelete(
              item.title,
              async () => {
                await p.queue(
                  'knowledge.delete',
                  'knowledge_item',
                  item.id,
                  {},
                  { ...item, deleted_at: new Date().toISOString() },
                );
                close();
              },
              p.report,
            )
          }
        />
      </Row>
      <Section title="Independent review cards">
        <Button label="＋ Add review card" tone="quiet" onPress={() => setNewCard(true)} />
        {cards.items
          .filter((c) => c.knowledge_item_id === item.id)
          .map((card) => (
            <Card key={card.id}>
              <Row>
                <Chip>{humanLabel(card.card_type)}</Chip>
                <Chip color={card.suspended ? colors.orange : colors.teal}>
                  {card.suspended ? 'Suspended' : 'Active'}
                </Chip>
              </Row>
              <Text style={styles.cardTitle}>{card.prompt}</Text>
              <Text style={styles.help}>
                Due {dateLabel(card.due_at)} · {card.review_count ?? 0} reviews
              </Text>
              <Row>
                <Button label="Edit" tone="quiet" small onPress={() => setEditCard(card)} />
                <Button
                  label={card.suspended ? 'Resume' : 'Pause'}
                  tone="quiet"
                  small
                  onPress={() =>
                    p.mutate(
                      `/review/cards/${card.id}`,
                      'PATCH',
                      { suspended: !card.suspended },
                      card,
                      'review_card',
                    )
                  }
                />
                <Button label="History" tone="quiet" small onPress={() => setHistory(card)} />
                <Button
                  label="Archive"
                  tone="danger"
                  small
                  onPress={() =>
                    confirmDelete(
                      card.prompt,
                      () => p.mutate(`/review/cards/${card.id}`, 'DELETE', undefined, card, 'review_card'),
                      p.report,
                    )
                  }
                />
              </Row>
            </Card>
          ))}
      </Section>
      <Section title="Linked knowledge">
        <Button label="＋ Add link" tone="quiet" disabled={all.length < 2} onPress={() => setLink(true)} />
        {relations.items
          .filter((r) => r.source_item_id === item.id)
          .map((r) => (
            <Card key={r.id}>
              <Text style={styles.body}>
                {r.relation_type} →{' '}
                {all.find((k) => k.id === r.target_item_id)?.title ?? 'Archived knowledge item'}
              </Text>
              <Button
                label="Remove link"
                tone="quiet"
                small
                onPress={() =>
                  p.mutate(`/knowledge-relations/${r.id}`, 'DELETE', undefined, r, 'knowledge_relation')
                }
              />
            </Card>
          ))}
      </Section>
      {newCard || editCard ? (
        <FormSheet
          title={editCard ? 'Edit review card' : 'New independent review card'}
          fields={cardFields}
          initial={editCard ?? { card_type: 'statement' }}
          close={() => {
            setNewCard(false);
            setEditCard(null);
          }}
          submit={(values) =>
            editCard
              ? p.mutate(`/review/cards/${editCard.id}`, 'PATCH', values, editCard, 'review_card')
              : p.mutate(
                  `/knowledge-items/${item.id}/cards`,
                  'POST',
                  { id: newId(), ...values },
                  undefined,
                  'review_card',
                )
          }
        />
      ) : null}
      {history ? <ReviewHistory card={history} close={() => setHistory(null)} /> : null}
      {link ? (
        <FormSheet
          title="Linked knowledge"
          fields={[
            {
              key: 'target_item_id',
              label: 'Target item',
              required: true,
              options: all.filter((k) => k.id !== item.id).map((k) => ({ value: k.id, label: k.title })),
            },
            {
              key: 'relation_type',
              label: 'Relation',
              options: ['related', 'depends_on', 'example_of', 'proof_of'].map((value) => ({
                value,
                label: humanLabel(value),
              })),
            },
          ]}
          close={() => setLink(false)}
          submit={(values) =>
            p.mutate(
              '/knowledge-relations',
              'POST',
              { id: newId(), source_item_id: item.id, ...values },
              undefined,
              'knowledge_relation',
            )
          }
        />
      ) : null}
    </DetailSheet>
  );
}
function ReviewHistory({ card, close }: { card: Item; close: () => void }) {
  const { styles } = useAppearance();
  const history = useItems(`/review/history?card_id=${card.id}`, 'review_event');
  return (
    <DetailSheet title="Review history" visible close={close}>
      <Loading loading={history.loading} error={history.error} empty={!history.items.length} />
      {history.items
        .filter((h) => h.card_id === card.id)
        .sort((a, b) => String(b.reviewed_at).localeCompare(String(a.reviewed_at)))
        .map((event) => (
          <Card key={event.id}>
            <Row>
              <Chip>{humanLabel(event.rating)}</Chip>
              <Text style={styles.body}>{dateLabel(event.reviewed_at)}</Text>
            </Row>
            <Text style={styles.help}>
              Time spent: {Math.round(Number(event.duration_ms) / 1000)} sec · State version{' '}
              {event.card_version_before} → {event.card_version_after}
            </Text>
          </Card>
        ))}
    </DetailSheet>
  );
}
export function ReviewScreen({ close }: { close: () => void }) {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const due = useItems('/review/queue', 'review_card');
  const [deck, setDeck] = useState<Item[] | null>(null);
  const [index, setIndex] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [started, setStarted] = useState(performance.now());
  const [ratings, setRatings] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const eligible = due.items.filter(
    (c) => !c.suspended && !c.pending_review && Date.parse(c.due_at) <= Date.now(),
  );
  const card = deck?.[index];
  const rate = async (rating: string) => {
    if (!card || !p.runtime) return;
    const duration = Math.round(performance.now() - started);
    const id = newId();
    await p.queue(
      'review.rate',
      'review_card',
      card.id,
      {
        card_id: card.id,
        device_id: p.runtime.deviceId,
        rating,
        reviewed_at: new Date().toISOString(),
        duration_ms: Math.max(0, Math.min(duration, 86400000)),
        base_version: String(card.version ?? '1'),
        idempotency_key: id,
      },
      { ...card, pending_review: true },
    );
    setRatings([...ratings, rating]);
    setElapsed(elapsed + duration);
    setIndex(index + 1);
    setReveal(false);
    setStarted(performance.now());
  };
  return (
    <Screen>
      <Heading
        title="Review"
        subtitle="Try to recall before revealing the answer."
        action={<Button label="Back" tone="quiet" small onPress={close} />}
      />
      {!deck ? (
        <>
          <Loading loading={due.loading} error={due.error} />
          <Card>
            <Text style={[styles.h1, { color: colors.purple }]}>{eligible.length}</Text>
            <Text style={styles.body}>
              cards are due now. Offline ratings stay on this device; the server calculates the next review
              after sync.
            </Text>
            <Button
              label="Start session"
              disabled={!eligible.length}
              onPress={() => {
                setDeck([...eligible]);
                setStarted(performance.now());
              }}
            />
          </Card>
        </>
      ) : card ? (
        <>
          <Row>
            <Chip>
              Card {index + 1} of {deck.length}
            </Chip>
            <Chip color={colors.teal}>{humanLabel(card.card_type)}</Chip>
          </Row>
          <Card>
            <MathView content={card.prompt} />
          </Card>
          {reveal ? (
            <>
              <Section title="Reference answer">
                <Card>
                  <MathView content={card.answer} />
                </Card>
              </Section>
              <Row>
                {[
                  { value: 'again', label: 'Again' },
                  { value: 'hard', label: 'Hard' },
                  { value: 'good', label: 'Good' },
                  { value: 'easy', label: 'Easy' },
                ].map((r) => (
                  <View key={r.value} style={{ flex: 1, minWidth: '45%' }}>
                    <Button
                      label={r.label}
                      tone={r.value === 'good' ? 'primary' : 'quiet'}
                      onPress={() => rate(r.value)}
                    />
                  </View>
                ))}
              </Row>
            </>
          ) : (
            <Button label="Reveal answer" onPress={() => setReveal(true)} />
          )}
        </>
      ) : (
        <Card accent={colors.teal}>
          <Text style={styles.h1}>Session complete</Text>
          <Text style={styles.body}>
            {ratings.length} cards · {Math.round(elapsed / 60000)} min
          </Text>
          <Row>
            {['again', 'hard', 'good', 'easy'].map((r) => (
              <Chip key={r}>
                {r} {ratings.filter((x) => x === r).length}
              </Chip>
            ))}
          </Row>
          <Text style={styles.body}>
            {ratings.filter((x) => x === 'again').length} cards need relearning. Pending ratings are
            preserved; the next due time is confirmed by the server.
          </Text>
          <Button label="Sync next review dates" onPress={p.synchronize} />
          <Button label="Back to Knowledge" tone="quiet" onPress={close} />
        </Card>
      )}
    </Screen>
  );
}
