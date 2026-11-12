import type { Sql } from '@prism/database';
import { notFound, validation } from './errors';

const nodeIdPattern =
  /^(knowledge|project|research|paper|reference):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arxivIdPattern = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v[1-9]\d*)?$/i;
const doiPattern = /^10\.[0-9]{4,9}\/[^\s]+$/i;
const maxEdges = 1500;

type NodeKind = 'knowledge' | 'project' | 'research' | 'paper';
type EdgeKind =
  | 'related'
  | 'depends_on'
  | 'example_of'
  | 'proof_of'
  | 'project_object'
  | 'project_knowledge'
  | 'object_knowledge'
  | 'project_paper'
  | 'project_reference';
type GraphEdge = { source: string; target: string; kind: EdgeKind };
type GraphNodeRow = {
  id: string;
  kind: NodeKind;
  label: string;
  project_id: string | null;
  url: string | null;
  arxiv_id: string | null;
  doi: string | null;
};

function hrefForNode(node: GraphNodeRow): string | undefined {
  const id = node.id.slice(node.id.indexOf(':') + 1);
  if (node.kind === 'knowledge') return `/knowledge/${id}`;
  if (node.kind === 'project') return `/research/${id}`;
  if (node.kind === 'research') return `/research/${node.project_id}?object=${id}`;
  if (node.url) {
    try {
      const url = new URL(node.url);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch {
      // Older references can still have a usable identifier.
    }
  }
  if (node.arxiv_id && arxivIdPattern.test(node.arxiv_id)) return `https://arxiv.org/abs/${node.arxiv_id}`;
  if (node.doi && doiPattern.test(node.doi))
    return `https://doi.org/${node.doi.split('/').map(encodeURIComponent).join('/')}`;
  if (node.id.startsWith('reference:') && node.project_id)
    return `/research/${node.project_id}#reference-${id}`;
}

export async function workspaceGraph(
  sql: Sql,
  userId: string,
  { focus, depth = 2, limit = 350 }: { focus?: string; depth?: number; limit?: number },
) {
  if (focus !== undefined && (typeof focus !== 'string' || !nodeIdPattern.test(focus)))
    throw validation('Choose a valid graph node.');
  if (!Number.isInteger(depth) || depth < 1 || depth > 3)
    throw validation('Graph depth must be between 1 and 3.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw validation('Graph limit must be between 1 and 500.');
  const { rows } = await sql.query<{ nodes: GraphNodeRow[]; edges: GraphEdge[]; truncated: boolean }>(
    `WITH RECURSIVE
      projects AS (
        SELECT id, title, updated_at FROM research_projects WHERE user_id=$1 AND deleted_at IS NULL
      ),
      objects AS (
        SELECT o.id, o.project_id, o.title, o.updated_at
        FROM research_objects o JOIN projects p ON p.id=o.project_id
        WHERE o.user_id=$1 AND o.deleted_at IS NULL
      ),
      paper_links AS (
        SELECT l.project_id, l.paper_id
        FROM research_paper_links l JOIN projects p ON p.id=l.project_id
        WHERE l.user_id=$1 AND l.deleted_at IS NULL
      ),
      references_in_projects AS (
        SELECT r.id, r.project_id, r.title, r.url, r.arxiv_id, r.doi, r.updated_at
        FROM research_references r JOIN projects p ON p.id=r.project_id
        WHERE r.user_id=$1 AND r.deleted_at IS NULL
      ),
      selected_papers AS (
        SELECT paper_id FROM paper_links
        UNION
        SELECT paper_id FROM user_papers WHERE user_id=$1 AND deleted_at IS NULL
          AND (is_saved OR for_you_reaction IN ('interested','liked'))
      ),
      graph_nodes(id, kind, label, project_id, url, arxiv_id, doi, updated_at) AS (
        SELECT 'knowledge:' || id, 'knowledge', title, NULL::text, NULL::text, NULL::text, NULL::text, updated_at
          FROM knowledge_items WHERE user_id=$1 AND deleted_at IS NULL
        UNION ALL
        SELECT 'project:' || id, 'project', title, NULL, NULL, NULL, NULL, updated_at FROM projects
        UNION ALL
        SELECT 'research:' || id, 'research', title, project_id::text, NULL, NULL, NULL, updated_at FROM objects
        UNION ALL
        SELECT 'paper:' || p.id, 'paper', p.title, NULL, NULL, p.arxiv_id, NULL, p.updated_at
          FROM arxiv_papers p JOIN selected_papers s ON s.paper_id=p.id
        UNION ALL
        SELECT 'reference:' || r.id, 'paper', r.title, r.project_id::text, r.url, r.arxiv_id, r.doi, r.updated_at
          FROM references_in_projects r
      ),
      graph_edges(source, target, kind) AS (
        SELECT 'knowledge:' || source_item_id, 'knowledge:' || target_item_id, relation_type
          FROM knowledge_relations WHERE user_id=$1 AND deleted_at IS NULL
        UNION ALL
        SELECT 'project:' || project_id, 'research:' || id, 'project_object' FROM objects
        UNION ALL
        SELECT 'project:' || project_id, 'knowledge:' || knowledge_item_id, 'project_knowledge'
          FROM research_knowledge_links WHERE user_id=$1 AND deleted_at IS NULL AND project_id IS NOT NULL
        UNION ALL
        SELECT 'research:' || research_object_id, 'knowledge:' || knowledge_item_id, 'object_knowledge'
          FROM research_knowledge_links WHERE user_id=$1 AND deleted_at IS NULL AND research_object_id IS NOT NULL
        UNION ALL
        SELECT 'project:' || project_id, 'paper:' || paper_id, 'project_paper' FROM paper_links
        UNION ALL
        SELECT 'project:' || project_id, 'reference:' || id, 'project_reference' FROM references_in_projects
      ),
      active_edges AS (
        SELECT DISTINCT e.source,e.target,e.kind
          FROM graph_edges e JOIN graph_nodes s ON s.id=e.source JOIN graph_nodes t ON t.id=e.target
      ),
      adjacent AS (
        SELECT source,target FROM active_edges
        UNION SELECT target,source FROM active_edges
      ),
      connected AS (SELECT DISTINCT source FROM adjacent),
      reachable(id, distance) AS (
        SELECT id, 0 FROM graph_nodes WHERE id=$2::text
        UNION
        SELECT a.target, r.distance+1 FROM reachable r JOIN adjacent a ON a.source=r.id
          WHERE r.distance<$3::integer
      ),
      nearest AS (SELECT id,min(distance) AS distance FROM reachable GROUP BY id),
      candidates AS (
        SELECT n.*, f.distance, c.source IS NOT NULL AS linked,
          row_number() OVER (PARTITION BY n.kind ORDER BY c.source IS NOT NULL DESC, n.updated_at DESC,n.id) AS kind_rank
        FROM graph_nodes n LEFT JOIN nearest f ON f.id=n.id LEFT JOIN connected c ON c.source=n.id
        WHERE $2::text IS NULL OR f.id IS NOT NULL
      ),
      page AS (
        SELECT *, row_number() OVER (
          ORDER BY distance NULLS LAST, linked DESC, kind_rank, updated_at DESC, id
        ) AS position
        FROM candidates
        ORDER BY position LIMIT ($4::integer+1)
      ),
      visible AS (SELECT * FROM page WHERE position<=$4::integer),
      edge_page AS (
        SELECT e.*, row_number() OVER (ORDER BY e.source,e.target,e.kind) AS position
          FROM active_edges e JOIN visible s ON s.id=e.source JOIN visible t ON t.id=e.target
        ORDER BY position LIMIT ($5::integer+1)
      )
      SELECT
        COALESCE((SELECT jsonb_agg(to_jsonb(v)-'updated_at'-'distance'-'linked'-'kind_rank'-'position'
          ORDER BY v.position) FROM visible v),'[]'::jsonb) AS nodes,
        COALESCE((SELECT jsonb_agg(to_jsonb(e)-'position' ORDER BY e.position)
          FROM edge_page e WHERE e.position<=$5::integer),'[]'::jsonb) AS edges,
        (SELECT count(*)>$4::integer FROM page) OR (SELECT count(*)>$5::integer FROM edge_page) AS truncated`,
    [userId, focus?.toLowerCase() ?? null, depth, limit, maxEdges],
  );
  const { nodes, edges, truncated } = rows[0]!;
  if (focus && !nodes.length) throw notFound();
  return {
    nodes: nodes.map((node) => {
      const href = hrefForNode(node);
      return { id: node.id, kind: node.kind, label: node.label, ...(href ? { href } : {}) };
    }),
    edges,
    truncated,
  };
}
