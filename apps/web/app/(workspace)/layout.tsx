import { Suspense, type ReactNode } from 'react';
import Workspace from '../../components/Workspace';

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Suspense>
        <Workspace />
      </Suspense>
    </>
  );
}
