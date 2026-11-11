import type { ExpoConfig } from 'expo/config';

if (process.env.EAS_BUILD === 'true' && process.env.EAS_BUILD_PROFILE !== 'development') {
  const address = process.env.EXPO_PUBLIC_API_URL;
  const parsed = address ? new URL(address) : undefined;
  if (
    !parsed ||
    parsed.protocol !== 'https:' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'iPhone preview/production builds require a reachable HTTPS EXPO_PUBLIC_API_URL ending in /api/v1.',
    );
  }
  if (!parsed.pathname.replace(/\/$/, '').endsWith('/api/v1'))
    throw new Error('EXPO_PUBLIC_API_URL must include /api/v1.');
}

const config: ExpoConfig = {
  name: 'PRISM',
  icon: './assets/icon.png',
  slug: 'prism-personal',
  version: '0.2.0',
  scheme: 'prism',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'app.prism.personal',
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: { package: 'app.prism.personal' },
  plugins: ['expo-sqlite', 'expo-secure-store', 'expo-web-browser', 'expo-notifications'],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:4000/api/v1',
    developmentAuth: process.env.EXPO_PUBLIC_DEV_AUTH === '1',
  },
};
export default config;
