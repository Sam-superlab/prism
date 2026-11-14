import type { Row, Sql } from '@prism/database';

const duplicateLimit = 50;
const groupLimit = 21;

export async function referenceDuplicateGroups(sql: Sql, userId: string) {
  const { rows } = await sql.query(
    `WITH standalone AS (
       SELECT id,doi,arxiv_id,
         lower(regexp_replace(trim(title),'[[:space:]]+',' ','g')) AS title_key,
         lower(regexp_replace(trim(authors[1]),'[[:space:]]+',' ','g')) AS author_key,year
       FROM research_references WHERE user_id=$1 AND project_id IS NULL AND deleted_at IS NULL
     ), candidates AS (
       SELECT id,'doi' AS matched_by,lower(doi) AS value,0 AS priority FROM standalone WHERE doi IS NOT NULL
       UNION ALL
       SELECT id,'arxiv_id',regexp_replace(lower(arxiv_id),'v[1-9][0-9]*$',''),1 FROM standalone WHERE arxiv_id IS NOT NULL
       UNION ALL
       SELECT id,'title_author_year',concat_ws(' · ',title_key,author_key,year),2
         FROM standalone WHERE title_key<>'' AND author_key<>'' AND year IS NOT NULL
     ), grouped AS (
       SELECT matched_by,value,priority,array_agg(id ORDER BY id) AS ids
       FROM candidates GROUP BY matched_by,value,priority HAVING count(*)>1
     )
     SELECT matched_by,value,ids[1:$3] AS ids,cardinality(ids)>$3 AS truncated FROM grouped g
     WHERE NOT EXISTS(SELECT 1 FROM grouped h WHERE h.priority<g.priority AND h.ids=g.ids)
     ORDER BY priority,value LIMIT $2`,
    [userId, duplicateLimit + 1, groupLimit],
  );
  return {
    groups: rows.slice(0, duplicateLimit) as {
      matched_by: 'doi' | 'arxiv_id' | 'title_author_year'; value: string; ids: string[]; truncated: boolean;
    }[],
    truncated: rows.length > duplicateLimit || rows.some((row) => row.truncated),
  };
}

export function referenceIdentity(record: Row) {
  return {
    doi: record.doi?.toLowerCase() as string | undefined,
    arxiv: record.arxiv_id?.toLowerCase().replace(/v[1-9][0-9]*$/, '') as string | undefined,
  };
}
