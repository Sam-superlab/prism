import type { Sql } from '@prism/database';
import type { ArxivResearchContext } from './arxiv-for-you';

export async function arxivResearchContext(sql: Sql, userId: string): Promise<ArxivResearchContext[]> {
  const { rows } = await sql.query<ArxivResearchContext>(
    `WITH active_projects AS (
       SELECT id,title,research_area,description
       FROM research_projects
       WHERE user_id=$1 AND status='active' AND deleted_at IS NULL
       ORDER BY updated_at DESC,id LIMIT 20
     )
     SELECT project.title AS project_title, ARRAY[project.title,project.research_area] AS headings,
            ARRAY[left(project.description,1200)] AS excerpts, NULL::uuid AS paper_id
     FROM active_projects project
     UNION ALL
     SELECT project.title, ARRAY[note.title,note.subject] || note.tags[1:8],
            ARRAY[left(note.content,1200)], NULL::uuid
     FROM active_projects project
     CROSS JOIN LATERAL (
       SELECT note.id,note.title,note.subject,note.tags,note.content
       FROM research_knowledge_links link
       LEFT JOIN research_objects object ON object.id=link.research_object_id AND object.user_id=link.user_id
         AND object.deleted_at IS NULL
       JOIN knowledge_items note ON note.id=link.knowledge_item_id AND note.user_id=link.user_id
         AND note.deleted_at IS NULL
       WHERE link.user_id=$1 AND link.deleted_at IS NULL
         AND COALESCE(link.project_id,object.project_id)=project.id
       GROUP BY note.id
       ORDER BY max(link.updated_at) DESC,note.id LIMIT 12
     ) note
     UNION ALL
     SELECT project.title, ARRAY[paper.title], ARRAY[left(paper.abstract,1200)], paper.id
     FROM active_projects project
     CROSS JOIN LATERAL (
       SELECT paper.id,paper.title,paper.abstract
       FROM research_paper_links link
       JOIN arxiv_papers paper ON paper.id=link.paper_id
       LEFT JOIN user_papers reaction ON reaction.user_id=link.user_id AND reaction.paper_id=paper.id
         AND reaction.deleted_at IS NULL
       WHERE link.user_id=$1 AND link.project_id=project.id AND link.deleted_at IS NULL
         AND reaction.status IS DISTINCT FROM 'not_relevant'
         AND reaction.for_you_reaction IS DISTINCT FROM 'not_interested'
       ORDER BY link.updated_at DESC,link.id LIMIT 12
     ) paper`,
    [userId],
  );
  return rows;
}
