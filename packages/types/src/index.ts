export type { components, paths, operations } from './api';

export type Rating = 'again' | 'hard' | 'good' | 'easy';
export type Version = string;
export type Entity = {
  id: string;
  version: Version;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};
export type SyncOutcome = 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'blocked';
