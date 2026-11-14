import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  assertLocalWorkspaceBackupSize, createLocalWorkspaceBackup, validateLocalWorkspaceBackupArchive,
  type LocalWorkspaceBackup,
} from './local-workspace-backup';
export { localWorkspaceBackupFormat, maximumLocalWorkspaceBackupBytes, type LocalWorkspaceBackup } from './local-workspace-backup';
// Calendar dates are not instants. Keep PostgreSQL DATE values identical to PGlite/JSON.
pg.types.setTypeParser(1082, (value) => value);

export type Row = Record<string, any>;
export interface Sql {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
function serialSql(run: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>): Sql {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const result = tail.then(() => run(sql, params)) as Promise<{ rows: T[] }>;
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
export interface DatabaseOptions {
  url?: string;
  dataDir?: string;
  memory?: boolean;
  production?: boolean;
  schemaPath?: string;
}
export class Database implements Sql {
  readonly kind: 'postgres' | 'pglite';
  private pool?: pg.Pool;
  private lite?: PGlite;
  private localDataDir?: string;
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly options: DatabaseOptions = {}) {
    this.kind = options.url ? 'postgres' : 'pglite';
    if (options.url) this.pool = new pg.Pool({ connectionString: options.url, max: 10 });
    else {
      const dir = options.memory ? undefined : resolve(options.dataDir ?? '.data/prism');
      if (dir) mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
      this.localDataDir = dir;
      this.lite = new PGlite(dir);
    }
  }
  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (this.pool) return { rows: (await this.pool.query(sql, params)).rows as T[] };
    return this.exclusive(async () => ({ rows: (await this.lite!.query<T>(sql, params)).rows }));
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  private async applyIncrementalMigration(ddl: string): Promise<void> {
    if (!this.pool) {
      await this.exclusive(() => this.lite!.transaction((tx) => tx.exec(ddl)));
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(ddl);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async initialize(): Promise<void> {
    const exists = await this.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='prism' AND table_name='users') present",
    );
    if (!exists.rows[0]?.present) {
      if (this.options.production)
        throw new Error(
          'Database schema is missing. Run the controlled migration command before production startup.',
        );
      const ddl = await readFile(
        this.options.schemaPath ?? new URL('../../../database/schema.sql', import.meta.url),
        'utf8',
      );
      if (this.pool) await this.pool.query(ddl);
      else await this.lite!.exec(ddl);
    }
    const forYou = await this.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='prism' AND table_name='user_papers' AND column_name='for_you_day') present",
    );
    if (!forYou.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the arXiv For You migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/002_arxiv_for_you.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const forYouRounds = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns
        WHERE table_schema='prism' AND table_name='user_papers' AND column_name='for_you_round')
        AND to_regclass('prism.user_papers_for_you_deck_round') IS NOT NULL
        AND to_regclass('prism.user_papers_for_you_deck') IS NULL present`,
    );
    if (!forYouRounds.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the arXiv For You rounds migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/003_arxiv_for_you_rounds.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const aiDrafts = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='prism'
        AND table_name='ai_review_drafts' AND column_name='resuming') present`,
    );
    if (!aiDrafts.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the AI review drafts migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/004_ai_review_drafts.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const proofRecall = await this.query<{ present: boolean }>(
      `SELECT count(*) = 2 AS present FROM information_schema.columns WHERE table_schema='prism'
        AND (table_name,column_name) IN (('review_cards','proof_steps'), ('review_events','proof_stuck_steps'))`,
    );
    if (!proofRecall.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the Proof Recall migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/005_proof_recall.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const projectKnowledge = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_project_knowledge_active') IS NOT NULL AS present",
    );
    if (!projectKnowledge.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the research project knowledge migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/006_research_project_knowledge.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const researchReferences = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_references') IS NOT NULL AS present",
    );
    if (!researchReferences.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the research references migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/007_research_references.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const referenceArxivIdentifiers = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='prism'
          AND table_name='research_references' AND column_name='arxiv_id')
        AND to_regclass('prism.research_references_arxiv') IS NOT NULL present`,
    );
    if (!referenceArxivIdentifiers.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the reference arXiv identifiers migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/008_reference_arxiv_identifiers.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const standaloneReferences = await this.query<{ present: boolean }>(
      `SELECT to_regclass('prism.research_references_citation_key') IS NOT NULL
          AND to_regclass('prism.research_references_standalone_arxiv') IS NOT NULL AS present`,
    );
    if (!standaloneReferences.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the standalone references migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/009_standalone_references.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const projectReferenceLinks = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_reference_links') IS NOT NULL AS present",
    );
    if (!projectReferenceLinks.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the project reference links migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/010_project_reference_links.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const literatureCollections = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.literature_collection_memberships') IS NOT NULL AS present",
    );
    if (!literatureCollections.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the literature collections migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/011_literature_collections.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const referenceMerge = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='research_reference_merge_tombstone'
          AND conrelid='prism.research_references'::regclass) AS present`,
    );
    if (!referenceMerge.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the reference merge migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/012_reference_merge.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const literatureSavedSearches = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.literature_saved_searches') IS NOT NULL AS present",
    );
    if (!literatureSavedSearches.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the literature saved searches migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/013_literature_saved_searches.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const referencePdfs = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_reference_pdf_chunks') IS NOT NULL AS present",
    );
    if (!referencePdfs.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the reference PDF migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/014_reference_pdfs.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const pdfAnnotations = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_pdf_annotations') IS NOT NULL AS present",
    );
    if (!pdfAnnotations.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the PDF annotations migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/015_pdf_annotations.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const pdfTextIndex = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_pdf_page_text') IS NOT NULL AS present",
    );
    if (!pdfTextIndex.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the PDF text index migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/016_pdf_text_index.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const referenceRelations = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_reference_relations') IS NOT NULL AS present",
    );
    if (!referenceRelations.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the reference relations migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/017_reference_relations.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const pdfReadingPositions = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_pdf_reading_positions') IS NOT NULL AS present",
    );
    if (!pdfReadingPositions.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the PDF reading positions migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/018_pdf_reading_positions.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const pdfStickyNotes = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='research_pdf_annotations_note_shape'
          AND conrelid='prism.research_pdf_annotations'::regclass) AS present`,
    );
    if (!pdfStickyNotes.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the PDF sticky notes migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/019_pdf_sticky_notes.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const attachmentFormats = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='prism'
          AND table_name='research_reference_pdfs' AND column_name='format') AS present`,
    );
    if (!attachmentFormats.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the attachment formats migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/020_attachment_formats.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const webpageSnapshots = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='research_reference_webpage_size_check'
          AND conrelid='prism.research_reference_pdfs'::regclass) AS present`,
    );
    if (!webpageSnapshots.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the webpage snapshots migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/021_webpage_snapshots.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const referenceKnowledgeLinks = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_reference_knowledge_links') IS NOT NULL AS present",
    );
    if (!referenceKnowledgeLinks.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the reference knowledge links migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/022_reference_knowledge_links.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const literatureSearchConditions = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='prism'
          AND table_name='literature_saved_searches' AND column_name='conditions') AS present`,
    );
    if (!literatureSearchConditions.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the literature search conditions migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/023_literature_search_conditions.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const pdfAreaAnnotations = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='research_pdf_annotations_area_shape'
          AND conrelid='prism.research_pdf_annotations'::regclass) AS present`,
    );
    if (!pdfAreaAnnotations.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the PDF area annotations migration with pnpm db:migrate.');
      const ddl = await readFile(
        new URL('../../../database/migrations/024_pdf_area_annotations.sql', import.meta.url),
        'utf8',
      );
      await this.applyIncrementalMigration(ddl);
    }
    const literatureFeeds = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.literature_feed_entries') IS NOT NULL AS present",
    );
    if (!literatureFeeds.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the literature feeds migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/025_literature_feeds.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const literatureFeedSchedule = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.literature_feeds_due') IS NOT NULL AS present",
    );
    if (!literatureFeedSchedule.rows[0]?.present) {
      if (this.options.production)
        throw new Error('Apply the literature feed schedule migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/026_literature_feed_schedule.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const pdfInkAnnotations = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='research_pdf_annotations_ink_shape'
        AND conrelid='prism.research_pdf_annotations'::regclass) AS present`,
    );
    if (!pdfInkAnnotations.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the PDF ink annotations migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/027_pdf_ink_annotations.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const teamLibraries = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.team_libraries') IS NOT NULL AS present",
    );
    if (!teamLibraries.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the private team libraries migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/028_private_team_libraries.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const annotationTags = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='research_pdf_annotations_tags_count'
        AND conrelid='prism.research_pdf_annotations'::regclass) AS present`,
    );
    if (!annotationTags.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the PDF annotation tags migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/029_pdf_annotation_tags.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const teamVisibility = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.team_libraries_public') IS NOT NULL AS present",
    );
    if (!teamVisibility.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the team library visibility migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/030_team_library_visibility.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const teamAttachments = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.team_library_attachments') IS NOT NULL AS present",
    );
    if (!teamAttachments.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the team library attachments migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/031_team_library_attachments.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const teamNotes = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.team_library_notes') IS NOT NULL AS present",
    );
    if (!teamNotes.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the team library notes migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/032_team_library_notes.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const teamAnnotations = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.team_pdf_annotations') IS NOT NULL AS present",
    );
    if (!teamAnnotations.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the team PDF annotations migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/033_team_pdf_annotations.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const developerLiterature = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.developer_literature_tokens') IS NOT NULL AS present",
    );
    if (!developerLiterature.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the developer literature API migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/034_developer_literature_tokens.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const indexMode = await this.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='prism.research_pdf_text_indexes'::regclass AND attname='text_mode' AND NOT attisdropped) AS present",
    );
    if (!indexMode.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the PDF text indexing mode migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/035_pdf_text_index_mode.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const textAnnotations = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_text_annotations') IS NOT NULL AS present",
    );
    if (!textAnnotations.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the text attachment annotations migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/036_text_attachment_annotations.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const referenceCreators = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='prism'
        AND table_name='research_references' AND column_name='creators') AS present`,
    );
    if (!referenceCreators.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the reference creators migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/037_reference_creators.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const exportAttachments = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='prism.exports'::regclass
        AND conname='exports_formats_check' AND pg_get_constraintdef(oid) LIKE '%attachments%') AS present`,
    );
    if (!exportAttachments.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the attachment export option migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/038_export_attachment_option.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const referenceImportSource = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='prism'
        AND table_name='research_references' AND column_name='import_source') AS present`,
    );
    if (!referenceImportSource.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the reference import provenance migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/039_reference_import_source.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const developerLiteratureScopes = await this.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='prism.developer_literature_tokens'::regclass AND attname='scope' AND NOT attisdropped) AS present",
    );
    if (!developerLiteratureScopes.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the developer literature scopes migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/040_developer_literature_scopes.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    const researchQuestions = await this.query<{ present: boolean }>(
      "SELECT to_regclass('prism.research_question_links') IS NOT NULL AS present",
    );
    if (!researchQuestions.rows[0]?.present) {
      if (this.options.production) throw new Error('Apply the research questions migration with pnpm db:migrate.');
      const ddl = await readFile(new URL('../../../database/migrations/041_research_questions.sql', import.meta.url), 'utf8');
      await this.applyIncrementalMigration(ddl);
    }
    if (this.options.production) {
      const result = await this.query<{ unsafe: boolean }>(
        "SELECT r.rolsuper OR r.rolbypassrls OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='prism' AND tableowner=current_user) unsafe FROM pg_roles r WHERE r.rolname=current_user",
      );
      if (result.rows[0]?.unsafe)
        throw new Error('Production runtime database role must be a non-owner without superuser/BYPASSRLS.');
    }
  }
  async transaction<T>(
    userId: string | undefined,
    fn: (sql: Sql) => Promise<T>,
    isolation: 'read committed' | 'repeatable read' = 'read committed',
  ): Promise<T> {
    const execute = async (sql: Sql) => {
      await sql.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
      try {
        await sql.query('SET LOCAL search_path=prism,public');
        if (userId) await sql.query("SELECT set_config('app.user_id',$1,true)", [userId]);
        const result = await fn(sql);
        await sql.query('COMMIT');
        return result;
      } catch (error) {
        await sql.query('ROLLBACK');
        throw error;
      }
    };
    if (this.pool) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const client = await this.pool.connect();
        try {
          return await execute(serialSql(async (q, p) => ({ rows: (await client.query(q, p)).rows })));
        } catch (error) {
          if (!['40001', '40P01'].includes((error as any).code) || attempt === 2) throw error;
        } finally {
          client.release();
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
      throw new Error('Transaction retries exhausted');
    }
    return this.exclusive(() =>
      execute(serialSql(async (q, p) => ({ rows: (await this.lite!.query(q, p)).rows }))),
    );
  }
  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
    else await this.exclusive(() => this.lite!.close());
  }

  async snapshotLocalWorkspace(trustedLocalBackupKey: Uint8Array): Promise<LocalWorkspaceBackup> {
    const lite = this.lite;
    const dataDir = this.localDataDir;
    if (!lite || !dataDir)
      throw new Error('Workspace backup requires a persistent local PGlite database.');
    if (trustedLocalBackupKey.byteLength !== 32) throw new Error('A 32-byte local workspace backup key is required.');
    const data = await this.exclusive(async () => {
      await lite.exec('CHECKPOINT');
      assertLocalWorkspaceBackupSize(dataDir);
      return lite.dumpDataDir('none');
    });
    return createLocalWorkspaceBackup(data, trustedLocalBackupKey);
  }
}
export async function createDatabase(options: DatabaseOptions = {}): Promise<Database> {
  const db = new Database(options);
  await db.initialize();
  return db;
}

export async function validateLocalWorkspaceBackup(backup: LocalWorkspaceBackup, trustedLocalBackupKey: Uint8Array): Promise<{
  knowledgeItems: number;
  attachments: number;
}> {
  const data = await validateLocalWorkspaceBackupArchive(backup, trustedLocalBackupKey);
  const isolated = await PGlite.create({ loadDataDir: data });
  try {
    const { rows: [counts] } = await isolated.query<{ knowledgeItems: number; attachments: number }>(`
      SELECT
        (SELECT count(*)::int FROM prism.knowledge_items WHERE deleted_at IS NULL) AS "knowledgeItems",
        (SELECT count(*)::int FROM prism.research_reference_pdfs WHERE status='ready' AND deleted_at IS NULL) AS attachments
    `);
    return counts;
  } finally {
    await isolated.close();
  }
}

export async function restoreLocalWorkspaceBackupAsCopy(
  backup: LocalWorkspaceBackup, trustedLocalBackupKey: Uint8Array, directory: string, userId: string,
) {
  const data = await validateLocalWorkspaceBackupArchive(backup, trustedLocalBackupKey);
  mkdirSync(directory, { mode: 0o700 });
  const restored = await PGlite.create(directory, { loadDataDir: data });
  try {
    await restored.transaction(async (tx) => {
      const stream = await tx.query('SELECT id FROM prism.user_sync_state WHERE user_id=$1', [userId]);
      if (stream.rows.length !== 1) throw new Error('The backup does not contain this workspace.');
      await tx.query('UPDATE prism.user_sync_state SET id=gen_random_uuid(), updated_at=now(), version=version+1 WHERE user_id=$1', [userId]);
      await tx.query(`UPDATE prism.exports SET status='expired', updated_at=now(), version=version+1
        WHERE user_id=$1 AND status IN('pending','running','ready')`, [userId]);
      await tx.query(`UPDATE prism.automation_jobs SET status='dead', error_message='Derived export invalidated after workspace recovery',
        payload=payload-'run_id', lease_expires_at=NULL, updated_at=now(), version=version+1
        WHERE user_id=$1 AND job_type='export' AND status IN('pending','running','failed')`, [userId]);
    });
  } finally { await restored.close(); }
}
