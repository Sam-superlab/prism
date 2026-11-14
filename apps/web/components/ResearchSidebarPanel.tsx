'use client';

import { useId, type ReactNode, type Ref } from 'react';
import { Icon } from './ui';
import styles from './ResearchSidebarPanel.module.css';

export function ResearchSidebarPanel({ title, count, open, onToggle, action, children, sectionRef }: {
  title: string;
  count?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  action?: ReactNode;
  sectionRef?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section ref={sectionRef} tabIndex={sectionRef ? -1 : undefined} className={`panel ${styles.sidebarPanel}`} aria-labelledby={`${id}-title`} data-open={open}>
      <h2 id={`${id}-title`} className={styles.sidebarHeading}>
        <button type="button" className={styles.sidebarToggle} aria-expanded={open}
          aria-describedby={count === undefined ? undefined : `${id}-count`}
          aria-controls={`${id}-body`} onClick={() => onToggle(!open)}>
          <span>{title}</span>
          {count !== undefined && <span id={`${id}-count`} className={styles.sidebarCount} aria-hidden="true">{count}</span>}
          <Icon name="chevron" size={16} className={styles.sidebarChevron} />
        </button>
      </h2>
      <div id={`${id}-body`} className={styles.sidebarReveal} inert={!open}>
        <div className={styles.sidebarClip}>
          <div className={styles.sidebarBody}>
            {action && <div className={styles.sidebarActions}>{action}</div>}
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

export function visibleCount(count: number, hasMore: boolean) {
  return hasMore ? (count > 0 ? `${count}+` : undefined) : String(count);
}
