import { useAppearance } from '../ui/theme';
import React, { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, Share, Switch, Text, View } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { newId, useItems, usePrism, useValue, type Item } from '../state';
import { saveTokens, verifyLoginAccount } from '../services/session';
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
import type { RecoverySummary } from '../offline/store';
WebBrowser.maybeCompleteAuthSession();

export function SettingsScreen({ close }: { close: () => void }) {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const profile = useValue(p.authenticated ? '/me' : null);
  const preferences = useValue(p.authenticated ? '/me/preferences' : null);
  const conflicts = useItems(p.authenticated ? '/sync/conflicts' : null, 'conflict');
  const [form, setForm] = useState<'connection' | 'profile' | 'preferences' | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [merge, setMerge] = useState(false);
  const [outbox, setOutbox] = useState<any[]>([]);
  const [exportJob, setExportJob] = useState<any>(null);
  const [jobs, setJobs] = useState(false);
  const [recoveries, setRecoveries] = useState<RecoverySummary[]>([]);
  useEffect(() => {
    if (!p.authenticated) {
      setOutbox([]);
      return;
    }
    void p.runtime?.store.outbox().then(setOutbox);
  }, [p.runtime, p.revision, p.authenticated]);
  useEffect(() => {
    if (!p.authenticated) {
      setRecoveries([]);
      return;
    }
    void p.runtime?.store.recoveryCopies().then(setRecoveries);
  }, [p.runtime, p.revision, p.authenticated]);
  useEffect(() => {
    if (!exportJob || !['pending', 'running'].includes(exportJob.status)) return;
    const timer = setInterval(() => {
      void p.runtime?.api.request(`/exports/${exportJob.id}`).then(setExportJob).catch(p.report);
    }, 2000);
    return () => clearInterval(timer);
  }, [exportJob?.id, exportJob?.status, p.runtime, p.report]);
  const resolve = async (resolution: string, payload?: any) => {
    if (!selected) return;
    const entityVersion = selected.server_payload?.version ?? selected.server_payload?.data?.version;
    if (!entityVersion) throw new Error('This conflict has no target version. Sync and reopen it first.');
    await p.mutate(
      `/sync/conflicts/${selected.id}/resolve`,
      'POST',
      {
        resolution,
        current_entity_version: String(entityVersion),
        ...(payload ? { merged_payload: payload } : {}),
      },
      selected,
      'conflict',
    );
    await p.runtime?.store.markConflictResolved(selected.client_operation_id);
    setSelected(null);
    await p.synchronize();
  };
  const requestNotifications = async () => {
    if (!p.runtime) return;
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted)
      throw new Error('Notifications are disabled. Digests remain available in the app.');
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId)
      throw new Error('Set the EAS project ID for this build before registering push notifications.');
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    const device = await p.runtime.api.request<Item>(`/devices/${p.runtime.deviceId}`);
    await p.mutate(`/devices/${device.id}`, 'PATCH', { push_token: token.data }, device);
    Alert.alert(
      'Notifications registered',
      'Delivery respects your notification preferences and quiet hours.',
    );
  };
  const createExport = async () => {
    const job = await p.mutate('/exports', 'POST', { formats: ['json', 'markdown'] });
    setExportJob(job);
  };
  const shareRecovery = async (id: string) => {
    if (!p.authenticated || !p.runtime) throw new Error('Sign in to the original workspace first.');
    const recovery = await p.runtime.store.recoveryCopy(id);
    const FileSystem = await import('expo-file-system');
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync()))
      throw new Error('File sharing is unavailable. Recovery copies remain on this device.');
    const file = new FileSystem.File(FileSystem.Paths.cache, `PRISM-recovery-${id}.json`);
    file.create({ overwrite: true });
    file.write(JSON.stringify(recovery, null, 2));
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json' });
  };
  const rebase = async (id: string) => {
    await p.synchronize();
    if (!p.runtime) return;
    await p.runtime.store.rebaseBlocked(id, newId(), new Date().toISOString());
    p.refresh();
    await p.synchronize();
  };
  const download = async () => {
    if (!p.runtime || !exportJob) return;
    // The private download requires the same authenticated session; use an explicit user share of its signed/authorized URL only when provided.
    const manifest = exportJob.manifest;
    const token = await p.runtime.api.accessToken();
    const response = await fetch(`${p.runtime.connection.apiUrl}/exports/${exportJob.id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const FileSystem = await import('expo-file-system');
    const file = new FileSystem.File(FileSystem.Paths.cache, `PRISM-${exportJob.id}.zip`);
    file.create({ overwrite: true });
    file.write(bytes);
    const Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync()))
      throw new Error('File sharing is unavailable. Download the same export on the web.');
    await Sharing.shareAsync(file.uri, { mimeType: 'application/zip', UTI: 'public.zip-archive' });
    if (manifest) p.refresh();
  };
  if (!p.authenticated)
    return (
      <Screen>
        <Heading
          title="Connect your workspace"
          subtitle="Sign in to unlock private records on this device."
        />
        <Card>
          <Text style={styles.body}>{p.connection?.apiUrl}</Text>
          <Button label="Connection settings" tone="quiet" onPress={() => setForm('connection')} />
        </Card>
        <AuthPanel />
        <AppearanceSettings />
        {form === 'connection' ? (
          <FormSheet
            title="PRISM connection"
            fields={[
              {
                key: 'apiUrl',
                label: 'HTTPS API address',
                required: true,
                help: 'Include /api/v1. Simulator development: http://127.0.0.1:4000/api/v1.',
              },
              ...(__DEV__
                ? [{ key: 'development', label: 'Simulator development mode', type: 'toggle' as const }]
                : []),
            ]}
            initial={p.connection ?? { apiUrl: 'https://', development: false }}
            close={() => setForm(null)}
            submit={(values) =>
              p.connect({
                apiUrl: String(values.apiUrl),
                development: __DEV__ && values.development === true,
              })
            }
          />
        ) : null}
      </Screen>
    );
  return (
    <Screen>
      <Heading
        title="Settings"
        subtitle="Make your workspace feel right for you."
        action={<Button label="Back" small tone="quiet" onPress={close} />}
      />
      <Card>
        <Text style={styles.cardTitle}>{profile.value?.display_name ?? 'PRISM Personal'}</Text>
        <Text style={styles.body}>{profile.value?.email ?? 'Connect your API'}</Text>
        <Text style={styles.help}>{profile.value?.timezone}</Text>
        <Row>
          <Button label="Edit profile" tone="quiet" small onPress={() => setForm('profile')} />
          <Button label="Connection settings" tone="quiet" small onPress={() => setForm('connection')} />
        </Row>
      </Card>
      <AuthPanel />
      <AppearanceSettings />
      <Section title="Sync status">
        <Card>
          <Text style={styles.cardTitle}>{p.syncText}</Text>
          <Text style={styles.body}>
            {p.pending} pending operations · {p.conflicts} conflicts to review
          </Text>
          <Button label="Sync now" onPress={p.synchronize} />
          <Text style={styles.help}>
            Each server address has separate local storage. Offline operations remain with their original
            server and resume when you reconnect to it.
          </Text>
        </Card>
      </Section>
      <Section title="Review and notifications">
        <Button
          label="Review, capacity and digest preferences"
          tone="quiet"
          onPress={() => setForm('preferences')}
        />
        <Button label="Enable push notifications" tone="quiet" onPress={requestNotifications} />
        <Button label="Automation history" tone="quiet" onPress={() => setJobs(true)} />
      </Section>
      {recoveries.length ? (
        <Section title="Device recovery copies">
          <Text style={styles.body}>
            Before replacing its local snapshot, the device saved all canonical and provisional records and
            original operations, including acknowledged history. These copies are not automatically replayed.
            Review and export them for manual recovery.
          </Text>
          {recoveries.map((copy) => (
            <Card key={copy.id}>
              <Row>
                <Chip color={colors.orange}>
                  {copy.reason === 'STREAM_RESET' ? 'Sync stream reset' : 'Server records rolled back'}
                </Chip>
                <Text style={styles.help}>{dateLabel(copy.created_at)}</Text>
              </Row>
              <Text style={styles.body}>
                {copy.record_count} local records · {copy.operation_count} retained operations
              </Text>
              <Button label="Export recovery JSON" onPress={() => shareRecovery(copy.id)} />
              {!copy.acknowledged_at ? (
                <Button
                  label="Acknowledge this recovery notice"
                  tone="quiet"
                  small
                  onPress={() => p.acknowledgeRecovery(copy.id)}
                />
              ) : (
                <Text style={styles.help}>Notice acknowledged. The copy is retained.</Text>
              )}
            </Card>
          ))}
        </Section>
      ) : null}
      <Section title="Your data">
        <Button label="Export JSON and Markdown" onPress={createExport} />
        {exportJob ? (
          <Card>
            <Chip color={exportJob.status === 'ready' ? colors.teal : colors.orange}>
              {humanLabel(exportJob.status)}
            </Chip>
            <Text style={styles.body}>
              {exportJob.error_message ?? 'Creating a consistent server snapshot.'}
            </Text>
            {exportJob.status === 'ready' ? (
              <Button label="Download and save ZIP" onPress={download} />
            ) : null}
          </Card>
        ) : null}
        <Button
          label="Share pending device operations"
          tone="quiet"
          disabled={!outbox.length}
          onPress={() =>
            Share.share({
              message: JSON.stringify(
                outbox.map((x) => ({ command: JSON.parse(x.command), status: x.status, error: x.error })),
                null,
                2,
              ),
              title: 'PRISM pending operations',
            })
          }
        />
      </Section>
      <Section title="Preserved sync conflicts">
        {conflicts.items
          .filter((c) => !c.resolution)
          .map((conflict) => (
            <Card key={conflict.id} onPress={() => setSelected(conflict)}>
              <Row>
                <Chip color={colors.orange}>{humanLabel(conflict.conflict_type)}</Chip>
                <Text style={styles.help}>{humanLabel(conflict.entity_type)}</Text>
              </Row>
              <Text style={styles.cardTitle}>Original edit preserved for review</Text>
              <Text style={styles.body}>{dateLabel(conflict.created_at)}</Text>
            </Card>
          ))}
        {outbox
          .filter((x) => ['blocked', 'rejected'].includes(x.status))
          .map((op) => (
            <Card key={op.operation_id}>
              <Chip color={colors.orange}>{humanLabel(op.status)}</Chip>
              <Text style={styles.body}>{JSON.parse(op.command).operation}</Text>
              <Text style={styles.help}>
                {op.error ??
                  'A required operation has not been applied. The original content remains on this device.'}
              </Text>
              {op.status === 'blocked' && JSON.parse(op.command).operation !== 'review.rate' ? (
                <>
                  <Text style={styles.help}>
                    Resubmitting validates the edit against the current server version. The original operation
                    is retained.
                  </Text>
                  <Button
                    label="Resubmit against current version"
                    tone="quiet"
                    small
                    onPress={() => rebase(op.operation_id)}
                  />
                </>
              ) : null}
              <Button
                label="Share original operation"
                tone="quiet"
                small
                onPress={() => Share.share({ message: JSON.stringify(JSON.parse(op.command), null, 2) })}
              />
            </Card>
          ))}
      </Section>
      {p.authenticated ? <Button label="Sign out" tone="quiet" onPress={p.logout} /> : null}
      {form === 'connection' ? (
        <FormSheet
          title="Connect your PRISM API"
          fields={[
            {
              key: 'apiUrl',
              label: 'API address',
              required: true,
              help: 'For example, https://prism.example/api/v1. iOS Simulator can use http://127.0.0.1:4000/api/v1.',
            },
            ...(__DEV__
              ? [
                  {
                    key: 'development',
                    label: 'Simulator development mode (development builds only)',
                    type: 'toggle' as const,
                  },
                ]
              : []),
          ]}
          initial={p.connection ?? { apiUrl: 'https://', development: false }}
          close={() => setForm(null)}
          submit={(values) =>
            p.connect({
              apiUrl: String(values.apiUrl).replace(/\/$/, ''),
              development: __DEV__ && values.development === true,
            })
          }
        />
      ) : null}
      {form === 'profile' ? (
        <FormSheet
          title="Profile"
          fields={[
            { key: 'display_name', label: 'Display name', required: true },
            {
              key: 'timezone',
              label: 'IANA time zone',
              required: true,
              help: 'For example, Europe/Budapest. Historical review times stay unchanged.',
            },
          ]}
          initial={profile.value ?? { timezone: 'Europe/Budapest' }}
          close={() => setForm(null)}
          submit={(values) => p.mutate('/me', 'PATCH', values, profile.value)}
        />
      ) : null}
      {form === 'preferences' ? (
        <FormSheet
          title="Review and automation preferences"
          fields={[
            {
              key: 'desired_retention',
              label: 'Desired retention 0.70–0.99',
              type: 'number',
              min: 0.7,
              max: 0.99,
              required: true,
            },
            {
              key: 'daily_review_limit',
              label: 'Daily card limit',
              type: 'number',
              min: 0,
              max: 1000,
              required: true,
            },
            {
              key: 'default_study_capacity_minutes',
              label: 'Default daily capacity (minutes)',
              type: 'number',
              min: 0,
              max: 1440,
              required: true,
            },
            { key: 'push_enabled', label: 'Push notifications', type: 'toggle' },
            { key: 'quiet_start', label: 'Quiet hours start (HH:mm)', required: true },
            { key: 'quiet_end', label: 'Quiet hours end (HH:mm)', required: true },
            { key: 'digest_enabled', label: 'Daily digest', type: 'toggle' },
            { key: 'digest_time', label: 'Daily digest time (HH:mm)', required: true },
          ]}
          initial={{
            desired_retention: preferences.value?.desired_retention ?? 0.9,
            daily_review_limit: preferences.value?.daily_review_limit ?? 100,
            default_study_capacity_minutes: preferences.value?.default_study_capacity_minutes ?? 180,
            push_enabled: preferences.value?.notification_preferences?.push_enabled ?? false,
            quiet_start: preferences.value?.notification_preferences?.quiet_start ?? '22:00',
            quiet_end: preferences.value?.notification_preferences?.quiet_end ?? '08:00',
            digest_enabled: preferences.value?.digest_preferences?.enabled ?? true,
            digest_time: preferences.value?.digest_preferences?.time ?? '08:00',
          }}
          close={() => setForm(null)}
          submit={(values) => {
            for (const key of ['quiet_start', 'quiet_end', 'digest_time'])
              if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values[key])) throw new Error('Use HH:mm for times.');
            return p.mutate(
              '/me/preferences',
              'PATCH',
              {
                desired_retention: values.desired_retention,
                daily_review_limit: values.daily_review_limit,
                default_study_capacity_minutes: values.default_study_capacity_minutes,
                notification_preferences: {
                  push_enabled: values.push_enabled,
                  quiet_start: values.quiet_start,
                  quiet_end: values.quiet_end,
                },
                digest_preferences: { enabled: values.digest_enabled, time: values.digest_time },
              },
              preferences.value,
            );
          }}
        />
      ) : null}
      {selected ? (
        <DetailSheet visible title="Preserved concurrent edits" close={() => setSelected(null)}>
          <Text style={styles.body}>
            Original operations remain preserved. Resolving a conflict validates the current server version
            and adds an audit record.
          </Text>
          <Section title="Device edit">
            <Card>
              <Text selectable style={styles.body}>
                {JSON.stringify(selected.client_payload, null, 2)}
              </Text>
            </Card>
          </Section>
          <Section title="Server version">
            <Card>
              <Text selectable style={styles.body}>
                {JSON.stringify(selected.server_payload, null, 2)}
              </Text>
            </Card>
          </Section>
          <Button label="Keep server version" onPress={() => resolve('keep_server')} />
          {selected.entity_type === 'review_card' || selected.entity_type === 'review' ? (
            <Button
              label="Require fresh recall (discard old rating)"
              tone="quiet"
              onPress={() => resolve('review_again')}
            />
          ) : (
            <>
              <Button
                label="Validate and apply device edit"
                tone="quiet"
                onPress={() => resolve('apply_client')}
              />
              <Button label="Merge mathematical content" tone="quiet" onPress={() => setMerge(true)} />
            </>
          )}
          {merge ? (
            <FormSheet
              title="Merge content"
              fields={[
                { key: 'content', label: 'Merged content', required: true, multiline: true },
                { key: 'proof_content', label: 'Merged proof', multiline: true },
              ]}
              initial={{
                content: selected.client_payload?.content ?? selected.client_payload?.payload?.content ?? '',
                proof_content: selected.client_payload?.proof_content ?? '',
              }}
              close={() => setMerge(false)}
              submit={(values) =>
                resolve('merged', {
                  ...values,
                  base_snapshot: selected.server_payload?.data ?? selected.server_payload,
                })
              }
            />
          ) : null}
        </DetailSheet>
      ) : null}
      {jobs ? <Jobs close={() => setJobs(false)} /> : null}
    </Screen>
  );
}
function AuthPanel() {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const auth = useValue('/auth/config');
  const config = auth.value;
  const redirectUri =
    config?.mobile_redirect_uri ?? AuthSession.makeRedirectUri({ scheme: 'prism', path: 'oauth' });
  const discovery = config
    ? { authorizationEndpoint: config.authorization_endpoint, tokenEndpoint: config.token_endpoint }
    : null;
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: config?.mobile_client_id ?? 'unconfigured',
      redirectUri,
      scopes: config?.scopes ?? ['openid', 'profile', 'email', 'offline_access'],
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
    },
    discovery,
  );
  useEffect(() => {
    if (response?.type !== 'success' || !config || !request?.codeVerifier) return;
    const exchange = async () => {
      const tokens = await AuthSession.exchangeCodeAsync(
        {
          clientId: config.mobile_client_id,
          code: response.params.code!,
          redirectUri,
          extraParams: { code_verifier: request.codeVerifier! },
        },
        { tokenEndpoint: config.token_endpoint },
      );
      const bound = await p.runtime?.store.accountId();
      const account = await verifyLoginAccount(p.connection!.apiUrl, tokens.accessToken, bound);
      if (!bound && (await p.runtime?.store.hasUserData()))
        throw new Error(
          'Legacy records are not bound to a verified account. They remain locked to prevent account mixing. Restore the original identity before accessing them.',
        );
      await saveTokens(tokens, {
        clientId: config.mobile_client_id,
        issuer: config.issuer,
        tokenEndpoint: config.token_endpoint,
        apiUrl: p.connection!.apiUrl,
        accountId: account.id,
      });
      await p.runtime?.store.setMeta('account_id', account.id);
      await p.sessionChanged();
    };
    void exchange().catch(p.report);
  }, [response]);
  if (p.connection?.development)
    return (
      <Card>
        <Chip color={colors.orange}>Simulator development only</Chip>
        <Text style={styles.body}>
          Development API access is limited to loopback. Devices and release builds require HTTPS and OIDC
          sign-in.
        </Text>
      </Card>
    );
  return (
    <Card>
      <Text style={styles.cardTitle}>{p.authenticated ? 'Secure session' : 'Sign in to your workspace'}</Text>
      <Text style={styles.body}>
        Sign in through the system browser with PKCE. Credentials are stored in the device Keychain.
      </Text>
      <Button
        label={p.authenticated ? 'Sign in again' : 'Sign in with OIDC'}
        disabled={!request || !config}
        onPress={() => promptAsync()}
      />
      {auth.error ? <Text style={styles.help}>{auth.error}</Text> : null}
    </Card>
  );
}
function Jobs({ close }: { close: () => void }) {
  const { colors, styles } = useAppearance();
  const jobs = useItems('/automation/jobs', 'automation_job');
  return (
    <DetailSheet visible title="Automation history" close={close}>
      <Loading loading={jobs.loading} error={jobs.error} empty={!jobs.items.length} />
      {jobs.items
        .sort((a, b) => String(b.scheduled_at).localeCompare(String(a.scheduled_at)))
        .map((job) => (
          <Card key={job.id}>
            <Row>
              <Chip color={job.status === 'succeeded' ? colors.teal : colors.orange}>
                {humanLabel(job.status)}
              </Chip>
              <Text style={styles.cardTitle}>{humanLabel(job.job_type)}</Text>
            </Row>
            <Text style={styles.body}>
              {dateLabel(job.scheduled_at)} · {job.attempts} attempts
            </Text>
            {job.error_message ? <Text style={{ color: colors.red }}>{job.error_message}</Text> : null}
          </Card>
        ))}
    </DetailSheet>
  );
}

function AppearanceSettings() {
  const { colors, styles, preferences, update, reduceMotion } = useAppearance();
  const p = usePrism();
  return (
    <Section title="Appearance">
      <Card>
        <Text style={styles.label}>Theme</Text>
        <Row>
          {(['system', 'light', 'dark'] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityLabel={`${value[0].toUpperCase()}${value.slice(1)} theme`}
              accessibilityState={{ checked: preferences.theme === value }}
              onPress={() => {
                void update({ theme: value }).catch(p.report);
              }}
              style={[styles.option, preferences.theme === value && styles.selectedOption]}
            >
              <Text style={preferences.theme === value ? styles.selectedText : styles.body}>
                {value[0].toUpperCase()}
                {value.slice(1)}
              </Text>
            </Pressable>
          ))}
        </Row>
        <Text style={styles.label}>Text size</Text>
        <Row>
          {[
            { value: 0.9, label: 'Small' },
            { value: 1, label: 'Default' },
            { value: 1.15, label: 'Large' },
            { value: 1.3, label: 'Extra large' },
          ].map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={`${option.label} text size`}
              accessibilityState={{ checked: preferences.textScale === option.value }}
              onPress={() => {
                void update({ textScale: option.value }).catch(p.report);
              }}
              style={[styles.option, preferences.textScale === option.value && styles.selectedOption]}
            >
              <Text style={preferences.textScale === option.value ? styles.selectedText : styles.body}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </Row>
        <Text style={styles.help}>
          Works together with your device text-size setting. Mathematics scales too.
        </Text>
        <View style={[styles.row, { justifyContent: 'space-between' }]}>
          <Text style={[styles.label, { flex: 1 }]}>Reduce motion</Text>
          <Switch
            accessibilityLabel="Reduce motion"
            value={preferences.reduceMotion}
            trackColor={{ true: colors.purple }}
            onValueChange={(value) => {
              void update({ reduceMotion: value }).catch(p.report);
            }}
          />
        </View>
        <Text style={styles.help}>
          {reduceMotion
            ? 'Reduced motion is active. Your device accessibility preference is always respected.'
            : 'Turns off sheet transitions. Your device accessibility preference is always respected.'}
        </Text>
        <Text style={styles.help}>Appearance preferences stay on this device.</Text>
      </Card>
    </Section>
  );
}
