import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePrism } from '../state';
import { MathView } from './MathView';
import { useAppearance } from './theme';
import { configuredTimezone, inputInstant } from '../services/locale';

export const humanLabel = (value: unknown) =>
  ['kg', 'lb', 'km', 'm', 'mi'].includes(String(value))
    ? String(value)
    : String(value ?? '')
        .replace(/[_.]+/g, ' ')
        .replace(/^./, (c) => c.toUpperCase());
export const textOf = (value: unknown, fallback = '') => (value == null ? fallback : String(value));
export const dateLabel = (value: unknown) =>
  value
    ? new Date(String(value)).toLocaleString('en-GB', {
        timeZone: configuredTimezone(),
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Not set';
export function Button({
  label,
  onPress,
  tone = 'primary',
  disabled = false,
  small = false,
}: {
  label: string;
  onPress: () => void | Promise<unknown>;
  tone?: 'primary' | 'quiet' | 'danger';
  disabled?: boolean;
  small?: boolean;
}) {
  const { colors, styles } = useAppearance();
  const p = usePrism();
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={() => {
        setBusy(true);
        Promise.resolve()
          .then(onPress)
          .catch(p.report)
          .finally(() => setBusy(false));
      }}
      style={({ pressed }) => [
        styles.button,
        small && styles.smallButton,
        tone === 'quiet' && styles.quietButton,
        tone === 'danger' && styles.dangerButton,
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tone === 'quiet' ? colors.purple : colors.onAccent} />
      ) : (
        <Text style={[styles.buttonText, tone === 'quiet' && { color: colors.ink }]}>{label}</Text>
      )}
    </Pressable>
  );
}
export function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  const { colors, styles } = useAppearance();
  return (
    <View style={[styles.chip, { backgroundColor: `${color ?? colors.purple}18` }]}>
      <Text style={[styles.chipText, { color: color ?? colors.purple }]}>{children}</Text>
    </View>
  );
}
export function Card({
  children,
  onPress,
  accent,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  accent?: string;
}) {
  const { styles } = useAppearance();
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.card, accent ? { borderLeftWidth: 3, borderLeftColor: accent } : null]}
    >
      {children}
    </Pressable>
  ) : (
    <View style={[styles.card, accent ? { borderLeftWidth: 3, borderLeftColor: accent } : null]}>
      {children}
    </View>
  );
}
export function Heading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  const { styles } = useAppearance();
  return (
    <View style={styles.heading}>
      <View style={{ flex: 1 }}>
        <Text style={styles.kicker}>PRISM / PERSONAL WORKSPACE</Text>
        <Text style={styles.h1}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}
export function Empty({ title, detail }: { title: string; detail?: string }) {
  const { styles } = useAppearance();
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyMark}>◇</Text>
      <Text style={styles.cardTitle}>{title}</Text>
      {detail ? <Text style={[styles.body, { textAlign: 'center' }]}>{detail}</Text> : null}
    </View>
  );
}
export function Loading({
  loading,
  error,
  empty,
}: {
  loading: boolean;
  error?: string | null;
  empty?: boolean;
}) {
  const { colors, styles } = useAppearance();
  return loading ? (
    <ActivityIndicator color={colors.purple} style={{ margin: 25 }} />
  ) : error ? (
    <Card>
      <Text style={{ color: colors.red }}>{error}</Text>
      <Text style={styles.body}>
        Reconnect and tap the sync status to retry. Unsynced records remain on this device.
      </Text>
    </Card>
  ) : empty ? (
    <Empty title="Nothing here yet" detail="Create your first item or sync an existing workspace." />
  ) : null;
}
export function Row({ children }: { children: React.ReactNode }) {
  const { styles } = useAppearance();
  return <View style={styles.row}>{children}</View>;
}
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { styles } = useAppearance();
  return (
    <View style={{ gap: 10, marginTop: 12 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}
export function Screen({ children }: { children: React.ReactNode }) {
  const { styles } = useAppearance();
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}
export function DetailSheet({
  title,
  visible,
  close,
  children,
}: {
  title: string;
  visible: boolean;
  close: () => void;
  children: React.ReactNode;
}) {
  const { colors, styles, reduceMotion, font } = useAppearance();
  return (
    <Modal
      visible={visible}
      animationType={reduceMotion ? 'none' : 'slide'}
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
        <View style={styles.sheetHeader}>
          <Text style={[styles.cardTitle, { flex: 1 }]} numberOfLines={2}>
            {title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={close}
            style={{ padding: 12 }}
          >
            <Text style={{ fontSize: font(22), color: colors.muted }}>×</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
export type Field = {
  key: string;
  label: string;
  required?: boolean;
  multiline?: boolean;
  type?: 'number' | 'toggle' | 'date';
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
};
export function FormSheet({
  title,
  fields,
  initial = {},
  close,
  submit,
  label = 'Save',
}: {
  title: string;
  fields: Field[];
  initial?: Record<string, any>;
  close: () => void;
  submit: (values: Record<string, any>) => Promise<unknown>;
  label?: string;
}) {
  const { colors, styles, reduceMotion } = useAppearance();
  const [values, setValues] = useState<Record<string, any>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.key,
        initial[f.key] ?? (f.type === 'toggle' ? false : (f.options?.[0]?.value ?? '')),
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Record<string, boolean>>({});
  const save = async () => {
    setError(null);
    const result: Record<string, any> = {};
    for (const f of fields) {
      const value = values[f.key];
      if (f.required && (value === '' || value === undefined || value === null)) {
        setError(`Please enter ${f.label}`);
        return;
      }
      if (f.type === 'number') {
        const n = value === '' ? null : Number(value);
        if (
          n !== null &&
          (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max))
        ) {
          setError(`${f.label} must be a number from ${f.min ?? 0} to ${f.max ?? 'a valid maximum'}.`);
          return;
        }
        result[f.key] = n;
      } else if (f.type === 'date') {
        try {
          result[f.key] = value ? inputInstant(value) : null;
        } catch {
          setError(
            `${f.label} must be an ISO date or time. Values without an offset use ${configuredTimezone()}.`,
          );
          return;
        }
      } else result[f.key] = value;
    }
    setBusy(true);
    try {
      await submit(result);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      visible
      animationType={reduceMotion ? 'none' : 'slide'}
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.sheetHeader}>
            <Text style={[styles.cardTitle, { flex: 1 }]}>{title}</Text>
            <Button label="Cancel" tone="quiet" small onPress={close} />
          </View>
          <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
            {fields.map((f) => (
              <View key={f.key} style={{ gap: 8 }}>
                <Text style={styles.label}>
                  {f.label}
                  {f.required ? ' *' : ''}
                </Text>
                {f.type === 'toggle' ? (
                  <Row>
                    {[
                      { value: true, label: 'On' },
                      { value: false, label: 'Off' },
                    ].map((v) => (
                      <Pressable
                        key={String(v.value)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: values[f.key] === v.value }}
                        onPress={() => setValues({ ...values, [f.key]: v.value })}
                        style={[styles.option, values[f.key] === v.value && styles.selectedOption]}
                      >
                        <Text style={values[f.key] === v.value ? styles.selectedText : styles.body}>
                          {v.label}
                        </Text>
                      </Pressable>
                    ))}
                  </Row>
                ) : f.options ? (
                  <Row>
                    {f.options.map((v) => (
                      <Pressable
                        key={v.value}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: values[f.key] === v.value }}
                        onPress={() => setValues({ ...values, [f.key]: v.value })}
                        style={[styles.option, values[f.key] === v.value && styles.selectedOption]}
                      >
                        <Text style={values[f.key] === v.value ? styles.selectedText : styles.body}>
                          {v.label}
                        </Text>
                      </Pressable>
                    ))}
                  </Row>
                ) : (
                  <TextInput
                    accessibilityLabel={f.label}
                    value={String(values[f.key] ?? '')}
                    onChangeText={(v) => setValues({ ...values, [f.key]: v })}
                    placeholder={f.placeholder}
                    placeholderTextColor={colors.muted}
                    multiline={f.multiline}
                    keyboardType={f.type === 'number' ? 'decimal-pad' : 'default'}
                    autoCapitalize="none"
                    style={[styles.input, f.multiline && { minHeight: 130, textAlignVertical: 'top' }]}
                  />
                )}
                {['content', 'proof_content', 'prompt', 'answer'].includes(f.key) && values[f.key] ? (
                  <>
                    <Button
                      label={preview[f.key] ? 'Hide math preview' : 'Preview LaTeX'}
                      tone="quiet"
                      small
                      onPress={() => setPreview({ ...preview, [f.key]: !preview[f.key] })}
                    />
                    {preview[f.key] ? (
                      <Card>
                        <MathView content={String(values[f.key])} />
                      </Card>
                    ) : null}
                  </>
                ) : null}
                {f.type === 'date' ? (
                  <Text style={styles.help}>
                    Time zone: {configuredTimezone()}. Times without an offset are converted to UTC using this
                    zone.
                  </Text>
                ) : null}
                {f.help ? <Text style={styles.help}>{f.help}</Text> : null}
              </View>
            ))}
            {error ? (
              <Text accessibilityRole="alert" style={{ color: colors.red }}>
                {error}
              </Text>
            ) : null}
            <Button label={busy ? 'Saving…' : label} disabled={busy} onPress={save} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
export function confirmDelete(title: string, action: () => Promise<unknown>, report: (err: unknown) => void) {
  Alert.alert('Archive record', `Archive “${title}”? Existing history will be retained.`, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Archive',
      style: 'destructive',
      onPress: () => {
        void action().catch(report);
      },
    },
  ]);
}
