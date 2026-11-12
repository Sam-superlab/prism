import type { Metadata } from 'next';
import { FloatingFocusPet } from './FloatingFocusPet';

export const metadata: Metadata = {
  title: 'PRISM · Study companion',
};

export default function FocusPetPage() {
  return <FloatingFocusPet />;
}
