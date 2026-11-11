import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import './globals.css';
import './appearance.css';
import { APPEARANCE_BOOTSTRAP } from '../lib/appearance';

export const metadata: Metadata = {
  title: 'PRISM · Personal Research',
  description: 'A focused home for learning, research, training, and daily progress.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Extensions such as Dark Reader add attributes to this node before React starts.
    // This escape hatch is one level deep; page content keeps normal hydration checks.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script id="prism-appearance" dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
