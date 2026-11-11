import { useAppearance, AppearanceProvider } from './ui/theme';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { MobileProvider, newId, useItems, usePrism, type Item } from './state';
import { TodayScreen } from './screens/Today';
import { KnowledgeScreen, ReviewScreen } from './screens/Knowledge';
import { ResearchScreen, taskFields } from './screens/Research';
import { FitnessScreen } from './screens/Fitness';
import { DiscoverScreen } from './screens/Discover';
import { SettingsScreen } from './screens/Settings';
import { Button, Card, DetailSheet, FormSheet, type Field } from './ui/components';

const tabs = [
  { key: 'today', label: 'Today', mark: '▦' },
  { key: 'learn', label: 'Learn', mark: '◇' },
  { key: 'research', label: 'Research', mark: '⌘' },
  { key: 'fitness', label: 'Fitness', mark: '↗' },
  { key: 'discover', label: 'Discover', mark: '◉' },
];
export default function App() {
  return (
    <SafeAreaProvider>
      <MobileProvider>
        <AppearanceProvider>
          <Shell />
        </AppearanceProvider>
      </MobileProvider>
    </SafeAreaProvider>
  );
}
function Shell() {
  const { colors, styles, font, isDark } = useAppearance();
  const shell = createShell(colors, font);
  const p = usePrism();
  const [tab, setTab] = useState('today');
  const [navigationHeight, setNavigationHeight] = useState(90);
  const [settings, setSettings] = useState(false);
  const [capture, setCapture] = useState(false);
  const [review, setReview] = useState(false);
  const [plannedWorkout, setPlannedWorkout] = useState<Item | null>(null);
  const chooseTab = (key: string) => {
    setTab(key);
    setReview(false);
    setSettings(false);
  };
  const openFitness = (task?: Item) => {
    setPlannedWorkout(task ?? null);
    chooseTab('fitness');
  };
  useEffect(() => {
    const store = p.runtime?.store;
    if (!store) return;
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const id = String(
          notification.request.content.data?.notification_id ?? notification.request.identifier,
        );
        const duplicate = await store.meta(`notification:${id}`);
        if (!duplicate) await store.setMeta(`notification:${id}`, new Date().toISOString());
        return {
          shouldShowBanner: !duplicate,
          shouldShowList: !duplicate,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      },
    });
    const listener = Notifications.addNotificationResponseReceivedListener((response) => {
      const type = String(response.notification.request.content.data?.notification_type ?? '');
      chooseTab(
        type.includes('digest')
          ? 'discover'
          : type.includes('review')
            ? 'learn'
            : type.includes('workout')
              ? 'fitness'
              : 'today',
      );
    });
    return () => {
      listener.remove();
      Notifications.setNotificationHandler(null);
    };
  }, [p.runtime]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <SafeAreaView edges={['top']} style={{ backgroundColor: colors.paper }}>
        <View style={shell.header}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, marginRight: 12 }}>
            <View style={shell.mark}>
              <Text style={{ color: colors.purple, fontSize: font(24) }}>◇</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={shell.logo}>PRISM</Text>
              <Text style={shell.tagline}>YOUR PERSONAL WORKSPACE</Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open profile and settings"
            onPress={() => {
              setSettings(true);
              setReview(false);
            }}
            style={shell.profile}
          >
            <Text style={{ color: colors.purple, fontSize: font(13) }}>Me</Text>
          </Pressable>
        </View>
      </SafeAreaView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sync now"
        onPress={() => {
          void p.synchronize().catch(p.report);
        }}
        style={shell.sync}
      >
        <View
          style={[
            shell.dot,
            { backgroundColor: p.conflicts ? colors.orange : p.pending ? colors.purple : colors.teal },
          ]}
        />
        <Text style={shell.syncLabel}>{p.syncText}</Text>
        {p.authenticated && p.pending ? <Text style={shell.syncCount}>{p.pending} pending</Text> : null}
        {p.authenticated && p.conflicts ? (
          <Text style={[shell.syncCount, { color: colors.orange }]}>{p.conflicts} conflicts</Text>
        ) : null}
      </Pressable>
      {p.authenticated && p.recoveries > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View device recovery copies"
          onPress={() => setSettings(true)}
          style={[shell.error, { backgroundColor: colors.warning }]}
        >
          <Text style={{ color: colors.orange, fontSize: font(12), lineHeight: font(19) }}>
            After server recovery, the device kept {p.recoveries} recovery copies. Review or export them in
            Settings. Previously acknowledged operations were not replayed.
          </Text>
        </Pressable>
      ) : null}
      {p.error ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
          onPress={() => p.report(null)}
          style={shell.error}
        >
          <Text style={{ color: colors.red, fontSize: font(12), flex: 1, lineHeight: font(18) }}>
            {p.error}
          </Text>
          <Text style={{ color: colors.red }}>×</Text>
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }}>
        {!p.ready ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 15 }}>
            <ActivityIndicator color={colors.purple} />
            <Text style={styles.body}>Opening your local workspace</Text>
          </View>
        ) : settings || !p.authenticated ? (
          <SettingsScreen close={() => setSettings(false)} />
        ) : review ? (
          <ReviewScreen close={() => setReview(false)} />
        ) : tab === 'today' ? (
          <TodayScreen
            review={() => {
              setTab('learn');
              setReview(true);
            }}
            fitness={openFitness}
          />
        ) : tab === 'learn' ? (
          <KnowledgeScreen />
        ) : tab === 'research' ? (
          <ResearchScreen />
        ) : tab === 'fitness' ? (
          <FitnessScreen planned={plannedWorkout} />
        ) : (
          <DiscoverScreen />
        )}
      </View>
      {p.ready && p.authenticated && !settings && !review ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Quick capture"
          onPress={() => setCapture(true)}
          style={({ pressed }) => [shell.fab, { bottom: navigationHeight + 16 }, pressed && { opacity: 0.8 }]}
        >
          <Text style={{ color: '#FFF', fontSize: font(28), lineHeight: font(32) }}>＋</Text>
        </Pressable>
      ) : null}
      <SafeAreaView
        edges={['bottom']}
        style={shell.nav}
        onLayout={(event) => setNavigationHeight(event.nativeEvent.layout.height)}
      >
        <View style={{ flexDirection: 'row' }}>
          {tabs.map((t) => (
            <Pressable
              key={t.key}
              accessibilityRole="tab"
              accessibilityLabel={t.label}
              accessibilityState={{ selected: tab === t.key && !settings }}
              onPress={() => chooseTab(t.key)}
              style={shell.tab}
            >
              <View style={[shell.tabMark, tab === t.key && !settings && { backgroundColor: colors.pale }]}>
                <Text
                  style={{
                    fontSize: font(21),
                    color: tab === t.key && !settings ? colors.purple : colors.muted,
                  }}
                >
                  {t.mark}
                </Text>
              </View>
              <Text
                style={{
                  fontSize: font(10),
                  fontWeight: tab === t.key && !settings ? '600' : '400',
                  color: tab === t.key && !settings ? colors.purple : colors.muted,
                }}
              >
                {t.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
      {capture ? (
        <QuickCapture
          close={() => setCapture(false)}
          fitness={() => {
            openFitness();
            setCapture(false);
          }}
        />
      ) : null}
    </View>
  );
}
function QuickCapture({ close, fitness }: { close: () => void; fitness: () => void }) {
  const { styles } = useAppearance();
  const p = usePrism();
  const projects = useItems('/research/projects', 'research_project');
  const [kind, setKind] = useState<string | null>(null);
  const fields: Field[] =
    kind === 'inbox'
      ? [{ key: 'content', label: 'Quick note', required: true, multiline: true }]
      : kind === 'task'
        ? taskFields
        : [
            { key: 'title', label: 'Title', required: true },
            { key: 'content', label: 'Content', required: true, multiline: true },
            ...(kind === 'research'
              ? [
                  {
                    key: 'project_id',
                    label: 'Research project',
                    required: true,
                    options: projects.items.map((pr) => ({ value: pr.id, label: pr.title })),
                  },
                ]
              : [{ key: 'subject', label: 'Subject / course' }]),
          ];
  return (
    <DetailSheet visible title="Quick capture" close={close}>
      <Text style={styles.body}>Capture an idea and get back to your work.</Text>
      {[
        { key: 'inbox', title: 'Inbox · Organize later', detail: 'Save an idea, even offline' },
        {
          key: 'knowledge',
          title: 'Knowledge note',
          detail: 'Capture mathematics and create review cards later',
        },
        { key: 'task', title: 'Task · Next step', detail: 'A general task, available offline' },
        {
          key: 'research',
          title: 'Research note',
          detail: 'Link to an existing project. Connection required.',
        },
      ].map((option) => (
        <Card key={option.key} onPress={() => setKind(option.key)}>
          <Text style={styles.cardTitle}>{option.title}</Text>
          <Text style={styles.body}>{option.detail}</Text>
        </Card>
      ))}
      <Button label="Log a workout" tone="quiet" onPress={fitness} />
      {kind ? (
        <FormSheet
          title="Quick save"
          fields={fields}
          initial={kind === 'task' ? { estimated_minutes: 30, priority: 3 } : {}}
          close={() => setKind(null)}
          submit={async (values) => {
            const id = newId();
            const now = new Date().toISOString();
            const meta = { id, version: '1', created_at: now, updated_at: now, deleted_at: null };
            if (kind === 'inbox')
              await p.queue(
                'inbox.create',
                'inbox_entry',
                id,
                { id, content: values.content },
                { ...meta, content: values.content, classified_task_id: null, classified_knowledge_id: null },
              );
            else if (kind === 'knowledge') {
              const fields = {
                ...values,
                type: 'note',
                tags: [],
                proof_content: null,
                source_reference: null,
                verification_status: 'unverified',
              };
              await p.queue(
                'knowledge.create',
                'knowledge_item',
                id,
                { id, ...fields },
                { ...meta, ...fields },
              );
            } else if (kind === 'task') {
              if (values.hard_deadline && !values.due_at) throw new Error('Enter a hard deadline.');
              await p.queue(
                'task.create',
                'task',
                id,
                { id, source_type: 'general', ...values },
                { ...meta, source_type: 'general', status: 'ready', ...values },
              );
            } else {
              const { project_id, ...rest } = values;
              if (!project_id) throw new Error('Create and select a research project first.');
              await p.mutate(
                `/research/projects/${project_id}/objects`,
                'POST',
                { id, ...rest, object_type: 'literature_note', claim_status: 'needs_verification' },
                undefined,
                'research_object',
              );
            }
            close();
          }}
        />
      ) : null}
    </DetailSheet>
  );
}
const createShell = (colors: ReturnType<typeof useAppearance>['colors'], font: (n: number) => number) =>
  StyleSheet.create({
    header: {
      minHeight: 76,
      paddingVertical: 10,
      paddingHorizontal: 21,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    logo: { color: colors.ink, letterSpacing: 2.8, fontWeight: '600', fontSize: font(20) },
    tagline: { color: colors.muted, fontSize: font(8), letterSpacing: 1.2, marginTop: 5 },
    mark: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 11,
      backgroundColor: colors.pale,
    },
    profile: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.pale,
      justifyContent: 'center',
      alignItems: 'center',
    },
    sync: {
      minHeight: 44,
      paddingHorizontal: 22,
      paddingVertical: 7,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      borderBottomWidth: 1,
      borderColor: colors.line,
    },
    dot: { width: 5, height: 5, borderRadius: 3 },
    syncLabel: { color: colors.muted, fontSize: font(11), flex: 1 },
    syncCount: { color: colors.purple, fontSize: font(11) },
    error: { padding: 12, backgroundColor: colors.error, flexDirection: 'row', gap: 10 },
    nav: { backgroundColor: colors.paper, borderTopWidth: 1, borderColor: colors.line },
    tab: { flex: 1, alignItems: 'center', paddingTop: 8, paddingBottom: 5, minHeight: 60, gap: 3 },
    tabMark: { width: 43, height: 28, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    fab: {
      position: 'absolute',
      right: 21,
      width: 54,
      height: 54,
      borderRadius: 22,
      backgroundColor: colors.purple,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000000',
      shadowOpacity: 0.2,
      shadowRadius: 9,
      shadowOffset: { width: 0, height: 5 },
      elevation: 4,
    },
  });
