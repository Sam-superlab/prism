'use client';

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { useRouter } from 'next/navigation';
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import { useResource } from '../lib/api';
import { ErrorState, Icon, Loading, Modal } from './ui';
import styles from './ConnectionGraph.module.css';

const kinds = {
  knowledge: 'Knowledge',
  project: 'Projects',
  research: 'Research objects',
  paper: 'Papers',
} as const;

type Kind = keyof typeof kinds;
type GraphNode = { id: string; label: string; kind: Kind; href?: string | null };
type GraphEdge = { source: string; target: string; kind: string };
type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean };
type Point = { x: number; y: number };
type Camera = Point & { scale: number };
type Particle = GraphNode & SimulationNodeDatum & Point;
type Spring = SimulationLinkDatum<Particle>;
type Gesture = {
  start: Point;
  origin: Camera;
  pointer: number;
  node?: Particle;
  nodeStart?: Point;
  moved: boolean;
};

const defaults = {
  query: '',
  hidden: [] as Kind[],
  orphans: true,
  color: false,
  arrows: false,
  labels: 0.95,
  nodeSize: 1,
  thickness: 1,
  center: 0.06,
  repel: 120,
  link: 0.5,
  distance: 88,
};

type Physics = Pick<typeof defaults, 'center' | 'repel' | 'link' | 'distance'>;

function createLayout(width: number, height: number, draw: () => void) {
  const springs = forceLink<Particle, Spring>().id((node) => node.id);
  const charge = forceManyBody<Particle>();
  const collide = forceCollide<Particle>();
  const x = forceX<Particle>(width / 2);
  const y = forceY<Particle>(height / 2);
  const simulation = forceSimulation<Particle>([])
    .stop()
    .alphaDecay(0.045)
    .force('link', springs)
    .force('repel', charge)
    .force('collide', collide)
    .force('x', x)
    .force('y', y)
    .on('tick', draw);
  let configured: Physics | undefined;
  function configure(physics: Physics, compact: boolean) {
    if (configured === physics) return false;
    configured = physics;
    springs.distance(physics.distance * (compact ? 0.75 : 1)).strength(physics.link);
    charge.strength(-physics.repel * (compact ? 0.65 : 1));
    x.strength(physics.center);
    y.strength(physics.center);
    return true;
  }
  return { simulation, springs, collide, configure };
}

function reducedMotion() {
  return (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.dataset.reducedMotion === 'true'
  );
}

function dotRadius(degree: number, focused: boolean) {
  return Math.min(11, 3.7 + Math.sqrt(degree) * 1.3 + (focused ? 1.8 : 0));
}

export function WorkspaceGraphPage() {
  return (
    <section className={styles.workspaceGraph} aria-label="Workspace Graph">
      <GraphExplorer />
    </section>
  );
}

export function ConnectionGraph({ focus, inset = false }: { focus: string; inset?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`${inset ? '' : 'panel'} ${styles.card}`} aria-label="Local graph">
      <div className={styles.heading}>
        <h2>Local graph</h2>
        <button
          className="icon-button"
          type="button"
          aria-label="Expand graph"
          onClick={() => setExpanded(true)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {expanded ? (
        <Modal title="Graph view" onClose={() => setExpanded(false)} wide>
          <GraphExplorer key={focus} focus={focus} onNavigate={() => setExpanded(false)} />
        </Modal>
      ) : (
        <GraphExplorer key={focus} focus={focus} compact />
      )}
    </section>
  );
}

function GraphExplorer({
  focus,
  compact = false,
  onNavigate,
}: {
  focus?: string;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const [anchor, setAnchor] = useState<string | null>(focus ?? null);
  const [depth, setDepth] = useState(2);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [options, setOptions] = useState(defaults);
  const graphOptions = useDeferredValue(options);
  const path = anchor
    ? `/graph?focus=${encodeURIComponent(anchor)}&depth=${depth}${compact ? '&limit=60' : ''}`
    : '/graph';
  return (
    <div className={styles.explorer}>
      {!compact && (
        <div className={styles.toolbar}>
          {(focus || anchor) && (
            <div className="tabs" aria-label="Graph scope" role="group">
              <button
                type="button"
                className={anchor ? 'active' : ''}
                aria-pressed={!!anchor}
                onClick={() => setAnchor(focus ?? anchor)}
              >
                Local
              </button>
              <button
                type="button"
                className={!anchor ? 'active' : ''}
                aria-pressed={!anchor}
                onClick={() => setAnchor(null)}
              >
                Workspace
              </button>
            </div>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Graph settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <Icon name="settings" size={17} />
          </button>
        </div>
      )}
      <GraphData
        key={anchor ?? 'workspace'}
        path={path}
        focus={anchor}
        compact={compact}
        options={graphOptions}
        onFocus={compact ? undefined : setAnchor}
        onNavigate={onNavigate}
      />
      {settingsOpen && !compact && (
        <div className={styles.settings} aria-label="Graph settings">
          <details open>
            <summary>Filters</summary>
            <label>
              Search nodes
              <input
                type="search"
                value={options.query}
                onChange={(event) => setOptions({ ...options, query: event.target.value })}
              />
            </label>
            {anchor && <Range name="Depth" value={depth} min={1} max={3} step={1} onChange={setDepth} />}
            {Object.entries(kinds).map(([key, label]) => {
              const kind = key as Kind;
              const shown = !options.hidden.includes(kind);
              return (
                <label className={styles.check} key={kind}>
                  {label}
                  <input
                    type="checkbox"
                    role="switch"
                    checked={shown}
                    onChange={() =>
                      setOptions({
                        ...options,
                        hidden: shown
                          ? [...options.hidden, kind]
                          : options.hidden.filter((value) => value !== kind),
                      })
                    }
                  />
                </label>
              );
            })}
            <label className={styles.check}>
              Orphans
              <input
                type="checkbox"
                role="switch"
                checked={options.orphans}
                onChange={(event) => setOptions({ ...options, orphans: event.target.checked })}
              />
            </label>
          </details>
          <details>
            <summary>Display</summary>
            <label className={styles.check}>
              Color by type
              <input
                type="checkbox"
                role="switch"
                checked={options.color}
                onChange={(event) => setOptions({ ...options, color: event.target.checked })}
              />
            </label>
            <label className={styles.check}>
              Arrows
              <input
                type="checkbox"
                role="switch"
                checked={options.arrows}
                onChange={(event) => setOptions({ ...options, arrows: event.target.checked })}
              />
            </label>
            <Range
              name="Text fade threshold"
              value={options.labels}
              min={0.3}
              max={2.5}
              step={0.1}
              onChange={(labels) => setOptions({ ...options, labels })}
            />
            <Range
              name="Node size"
              value={options.nodeSize}
              min={0.5}
              max={2}
              step={0.1}
              onChange={(nodeSize) => setOptions({ ...options, nodeSize })}
            />
            <Range
              name="Link thickness"
              value={options.thickness}
              min={0.5}
              max={3}
              step={0.1}
              onChange={(thickness) => setOptions({ ...options, thickness })}
            />
          </details>
          <details>
            <summary>Forces</summary>
            <Range
              name="Center force"
              value={options.center}
              min={0.01}
              max={0.2}
              step={0.01}
              onChange={(center) => setOptions({ ...options, center })}
            />
            <Range
              name="Repel force"
              value={options.repel}
              min={15}
              max={350}
              step={5}
              onChange={(repel) => setOptions({ ...options, repel })}
            />
            <Range
              name="Link force"
              value={options.link}
              min={0.1}
              max={1}
              step={0.1}
              onChange={(link) => setOptions({ ...options, link })}
            />
            <Range
              name="Link distance"
              value={options.distance}
              min={35}
              max={180}
              step={1}
              onChange={(distance) => setOptions({ ...options, distance })}
            />
          </details>
          <button
            className="button small"
            type="button"
            onClick={() => {
              setOptions(defaults);
              setDepth(2);
            }}
          >
            Restore defaults
          </button>
        </div>
      )}
    </div>
  );
}

function Range({
  name,
  value,
  min,
  max,
  step,
  onChange,
}: {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className={styles.range}>
      <label htmlFor={id}>{name}</label>
      <output aria-hidden="true">{value}</output>
      <input
        id={id}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    </div>
  );
}

const GraphData = memo(function GraphData({
  path,
  ...props
}: {
  path: string;
  focus: string | null;
  compact: boolean;
  options: typeof defaults;
  onFocus?: (id: string) => void;
  onNavigate?: () => void;
}) {
  const graph = useResource<Graph>(path);
  useEffect(() => {
    window.addEventListener('prism:graph-changed', graph.reload);
    return () => window.removeEventListener('prism:graph-changed', graph.reload);
  }, [graph.reload]);
  return (
    <>
      <ErrorState error={graph.error} retry={graph.reload} />
      {!graph.data && graph.loading && <Loading />}
      {graph.data && (
        <>
          <GraphScene data={graph.data} {...props} />
          {graph.data.truncated && (
            <p className={styles.caption}>
              {props.compact
                ? 'Expand the graph to see more connections.'
                : 'This graph reached its display limit. Focus a node to see its local connections.'}
            </p>
          )}
        </>
      )}
    </>
  );
});

function GraphScene({
  data,
  focus,
  compact,
  options,
  onFocus,
  onNavigate,
}: {
  data: Graph;
  focus: string | null;
  compact: boolean;
  options: typeof defaults;
  onFocus?: (id: string) => void;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const marker = useId();
  const surface = useRef<SVGSVGElement>(null);
  const graphView = useRef<SVGGElement>(null);
  const dots = useRef(new Map<string, SVGGElement>());
  const lines = useRef(new Map<GraphEdge, SVGLineElement>());
  const particles = useRef(new Map<string, Particle>());
  const knownParticles = useRef(new Map<string, Particle>());
  const layout = useRef<ReturnType<typeof createLayout> | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const fitted = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const [context, setContext] = useState<{ node: GraphNode; x: number; y: number } | null>(null);
  const camera = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const [zoomScale, setZoomScale] = useState(1);
  const width = compact ? 320 : 760;
  const height = compact ? 238 : 465;
  const { query, hidden, orphans, center, repel, link, distance, nodeSize, arrows, thickness } = options;
  const physics = useMemo(() => ({ center, repel, link, distance }), [center, repel, link, distance]);
  const physicsRef = useRef(physics);
  physicsRef.current = physics;
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const kept = new Set(
      data.nodes
        .filter(
          (node) =>
            node.id === focus || (!hidden.includes(node.kind) && node.label.toLocaleLowerCase().includes(q)),
        )
        .map(({ id }) => id),
    );
    const edges = data.edges.filter(({ source, target }) => kept.has(source) && kept.has(target));
    const neighbors = new Map<string, Set<string>>();
    for (const { source, target } of edges) {
      if (!neighbors.has(source)) neighbors.set(source, new Set());
      if (!neighbors.has(target)) neighbors.set(target, new Set());
      neighbors.get(source)!.add(target);
      neighbors.get(target)!.add(source);
    }
    const nodes = data.nodes.filter(
      ({ id }) => kept.has(id) && (orphans || id === focus || neighbors.has(id)),
    );
    return { nodes, edges, neighbors };
  }, [data, focus, query, hidden, orphans]);

  const paint = useRef({ visible, focus, nodeSize, arrows, thickness });
  const draw = useCallback(() => {
    const style = paint.current;
    for (const node of particles.current.values()) {
      dots.current.get(node.id)?.setAttribute('transform', `translate(${node.x} ${node.y})`);
    }
    for (const edge of style.visible.edges) {
      const line = lines.current.get(edge);
      const source = particles.current.get(edge.source);
      const target = particles.current.get(edge.target);
      if (!line || !source || !target) continue;
      let { x, y } = target;
      if (style.arrows) {
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const length = Math.hypot(dx, dy) || 1;
        const radius = dotRadius(
          style.visible.neighbors.get(target.id)?.size ?? 0,
          target.id === style.focus,
        );
        const inset = Math.min(length / 2, radius * style.nodeSize + 4 * style.thickness);
        x -= (dx / length) * inset;
        y -= (dy / length) * inset;
      }
      line.setAttribute('x1', String(source.x));
      line.setAttribute('y1', String(source.y));
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(y));
    }
  }, []);

  function radius(id: string) {
    return nodeSize * dotRadius(visible.neighbors.get(id)?.size ?? 0, id === focus);
  }

  function setCamera(next: Camera) {
    const changedScale = next.scale !== camera.current.scale;
    camera.current = next;
    graphView.current?.setAttribute('transform', `translate(${next.x} ${next.y}) scale(${next.scale})`);
    if (changedScale) setZoomScale(next.scale);
  }

  function fitView() {
    const nodes = [...particles.current.values()];
    if (!nodes.length) {
      setCamera({ x: 0, y: 0, scale: 1 });
      return;
    }
    const x = nodes.map((node) => node.x);
    const y = nodes.map((node) => node.y);
    const left = Math.min(...x),
      right = Math.max(...x);
    const top = Math.min(...y),
      bottom = Math.max(...y);
    const scale = Math.max(
      0.18,
      Math.min(
        compact || nodes.length < 3 ? 1 : 1.65,
        (width - 86) / (right - left || 1),
        (height - 100) / (bottom - top || 1),
      ),
    );
    setCamera({
      x: width / 2 - ((left + right) * scale) / 2,
      y: height / 2 - ((top + bottom) * scale) / 2,
      scale,
    });
  }

  useLayoutEffect(() => {
    const engine = createLayout(width, height, draw);
    engine.configure(physicsRef.current, compact);
    layout.current = engine;
    return () => {
      engine.simulation.stop();
      layout.current = null;
      gesture.current = null;
    };
  }, [width, height, draw, compact]);

  useLayoutEffect(() => {
    paint.current = { visible, focus, nodeSize, arrows, thickness };
    draw();
  }, [visible, focus, nodeSize, arrows, thickness, draw]);

  useLayoutEffect(() => {
    const engine = layout.current;
    if (!engine) return;
    const origin = { x: width / 2, y: height / 2 };
    const cache = knownParticles.current;
    const nodes = visible.nodes.map((node, index) => {
      const prior = cache.get(node.id);
      if (prior) return Object.assign(prior, node);
      const neighbors = visible.neighbors.get(node.id) ?? [];
      const seed = [...neighbors].map((id) => cache.get(id)).find(Boolean) ?? origin;
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      const spread = 10 * Math.sqrt(index + 0.5);
      return {
        ...node,
        x: seed.x + spread * Math.cos(angle),
        y: seed.y + spread * Math.sin(angle),
      } satisfies Particle;
    });
    for (const node of nodes) cache.set(node.id, node);
    particles.current = new Map(nodes.map((node) => [node.id, node]));
    const { simulation, springs, collide } = engine;
    springs.links([]);
    simulation.nodes(nodes);
    springs.links(visible.edges.map(({ source, target }) => ({ source, target })));
    collide.radius((node) => dotRadius(visible.neighbors.get(node.id)?.size ?? 0, node.id === focus) + 8);
    if (!nodes.length) {
      simulation.stop();
      return;
    }
    const reduced = reducedMotion();
    if (!fitted.current) {
      simulation.alpha(1).tick(reduced ? 100 : 32);
      fitted.current = true;
      fitView();
    } else if (reduced) simulation.alpha(0.3).stop().tick(18);
    draw();
    if (!reduced) simulation.alpha(Math.max(simulation.alpha(), 0.25)).restart();
  }, [visible, width, height, focus, draw]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const engine = layout.current;
      if (!engine?.configure(physics, compact)) return;
      const { simulation } = engine;
      if (!simulation.nodes().length) return;
      if (reducedMotion()) {
        simulation.alpha(0.28).stop().tick(16);
        draw();
      } else simulation.alpha(Math.max(simulation.alpha(), 0.28)).restart();
    });
    return () => cancelAnimationFrame(frame);
  }, [physics, compact, draw]);

  function zoom(multiplier: number, point: Point = { x: width / 2, y: height / 2 }) {
    const before = camera.current;
    const scale = Math.max(0.18, Math.min(5, before.scale * multiplier));
    const ratio = scale / before.scale;
    setCamera({
      x: point.x - (point.x - before.x) * ratio,
      y: point.y - (point.y - before.y) * ratio,
      scale,
    });
  }

  function pointAt(x: number, y: number) {
    const transform = surface.current?.getScreenCTM();
    if (!transform) return { x, y };
    return new DOMPoint(x, y).matrixTransform(transform.inverse());
  }

  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  wheel.current = (event) => {
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 14 : event.deltaMode === 2 ? 100 : 1);
    zoom(Math.exp(-Math.max(-130, Math.min(130, delta)) * 0.006), pointAt(event.clientX, event.clientY));
  };
  useEffect(() => {
    const element = surface.current;
    const handle = (event: WheelEvent) => wheel.current(event);
    element?.addEventListener('wheel', handle, { passive: false });
    return () => element?.removeEventListener('wheel', handle);
  }, []);

  function openNode(node: GraphNode) {
    if (node.href?.startsWith('/') && !node.href.startsWith('//')) {
      onNavigate?.();
      router.push(node.href);
    } else if (node.href && /^https?:\/\//i.test(node.href)) {
      window.open(node.href, '_blank', 'noopener,noreferrer');
    } else if (onFocus) {
      onFocus(node.id);
    }
  }

  function showContext(node: GraphNode, x: number, y: number) {
    const bounds = surface.current?.getBoundingClientRect();
    if (!bounds) return;
    setContext({
      node,
      x: Math.max(8, Math.min(x - bounds.left, bounds.width - 176)),
      y: Math.max(8, Math.min(y - bounds.top, bounds.height - 110)),
    });
  }

  function begin(event: PointerEvent<SVGElement>, node?: Particle) {
    if (event.button !== 0 || gesture.current) return;
    event.stopPropagation();
    setContext(null);
    gesture.current = {
      start: pointAt(event.clientX, event.clientY),
      origin: camera.current,
      pointer: event.pointerId,
      node,
      nodeStart: node && { x: node.x, y: node.y },
      moved: false,
    };
    surface.current?.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    const state = gesture.current;
    if (!state || event.pointerId !== state.pointer) return;
    const point = pointAt(event.clientX, event.clientY);
    const dx = point.x - state.start.x;
    const dy = point.y - state.start.y;
    if (!state.moved && Math.hypot(dx, dy) < 4) return;
    state.moved = true;
    if (state.node && state.nodeStart) {
      state.node.fx = state.nodeStart.x + dx / state.origin.scale;
      state.node.fy = state.nodeStart.y + dy / state.origin.scale;
      const simulation = layout.current?.simulation.alpha(0.25);
      if (reducedMotion()) {
        simulation?.stop().tick();
        draw();
      } else simulation?.alphaTarget(0.13).restart();
    } else setCamera({ ...state.origin, x: state.origin.x + dx, y: state.origin.y + dy });
  }

  function finish(event: PointerEvent<SVGSVGElement>) {
    const state = gesture.current;
    if (!state || state.pointer !== event.pointerId) return;
    gesture.current = null;
    if (state.node) {
      state.node.fx = state.node.fy = null;
      layout.current?.simulation.alphaTarget(0);
      if (!state.moved && event.type === 'pointerup') openNode(state.node);
    }
  }

  const highlighted = visible.nodes.some((node) => node.id === active) ? active : null;
  const connected = highlighted ? visible.neighbors.get(highlighted) : undefined;
  return (
    <div
      className={`${styles.viewport} ${compact ? styles.compact : ''}`}
      data-color={options.color}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !context) return;
        event.preventDefault();
        event.stopPropagation();
        setContext(null);
      }}
    >
      <svg
        ref={surface}
        viewBox={`0 0 ${width} ${height}`}
        aria-label="Interactive connection graph"
        tabIndex={0}
        className={styles.surface}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onKeyDown={(event) => {
          const shift = event.shiftKey ? 52 : 18;
          const steps: Record<string, Point> = {
            ArrowLeft: { x: shift, y: 0 },
            ArrowRight: { x: -shift, y: 0 },
            ArrowUp: { x: 0, y: shift },
            ArrowDown: { x: 0, y: -shift },
          };
          const step = steps[event.key];
          if (step)
            setCamera({ ...camera.current, x: camera.current.x + step.x, y: camera.current.y + step.y });
          else if (event.key === '+' || event.key === '=') zoom(1.22);
          else if (event.key === '-') zoom(1 / 1.22);
          else if (event.key === '0') fitView();
          else return;
          event.preventDefault();
        }}
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 8 8"
            refX="6"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M0 0 8 4 0 8Z" fill="var(--muted)" />
          </marker>
        </defs>
        <g ref={graphView}>
          <g aria-hidden="true">
            {visible.edges.map((edge) => (
              <line
                key={`${edge.source}:${edge.target}:${edge.kind}`}
                ref={(element) => {
                  if (element) lines.current.set(edge, element);
                  else lines.current.delete(edge);
                }}
                className={styles.edge}
                data-active={edge.source === highlighted || edge.target === highlighted}
                data-dim={!!highlighted && edge.source !== highlighted && edge.target !== highlighted}
                strokeWidth={thickness}
                markerEnd={arrows ? `url(#${marker})` : undefined}
              />
            ))}
          </g>
          {visible.nodes.map((node) => (
            <g
              key={node.id}
              ref={(element) => {
                if (element) dots.current.set(node.id, element);
                else dots.current.delete(node.id);
              }}
              className={styles.node}
              data-kind={node.kind}
              data-root={node.id === focus}
              data-active={node.id === highlighted}
              data-dim={!!highlighted && node.id !== highlighted && !connected?.has(node.id)}
              tabIndex={0}
              role={node.href ? 'link' : 'button'}
              aria-label={`${node.label} · ${kinds[node.kind]}`}
              onPointerEnter={() => setActive(node.id)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(node.id)}
              onBlur={() => setActive(null)}
              onPointerDown={(event) => begin(event, particles.current.get(node.id))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openNode(node);
                } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                  event.preventDefault();
                  const dot = event.currentTarget.getBoundingClientRect();
                  showContext(node, dot.left + dot.width / 2, dot.top + dot.height / 2);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                showContext(node, event.clientX, event.clientY);
              }}
            >
              <title>{node.label}</title>
              <circle r={Math.max(10, radius(node.id))} className={styles.target} />
              <circle r={radius(node.id)} className={styles.dot} />
              <text
                y={radius(node.id) + 13}
                data-show={
                  node.id === focus ||
                  node.id === highlighted ||
                  zoomScale >= options.labels * (compact && visible.nodes.length > 12 ? 1.35 : 1)
                }
              >
                {node.label.length > (compact ? 23 : 36)
                  ? `${node.label.slice(0, compact ? 23 : 36)}…`
                  : node.label}
              </text>
            </g>
          ))}
        </g>
      </svg>
      {!visible.nodes.length && <span className={styles.empty}>No nodes match your filters.</span>}
      {visible.nodes.length === 1 && !visible.edges.length && (
        <span className={styles.empty}>No connections yet.</span>
      )}
      <div className={styles.zoom}>
        <button type="button" aria-label="Zoom out" onClick={() => zoom(1 / 1.22)}>
          −
        </button>
        <button type="button" aria-label="Reset graph view" onClick={fitView}>
          {Math.round(zoomScale * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => zoom(1.22)}>
          +
        </button>
      </div>
      {context && (
        <div className={styles.context} style={{ left: context.x, top: context.y }}>
          <span>{context.node.label}</span>
          {context.node.href && (
            <button
              className="button small"
              type="button"
              onClick={() => {
                openNode(context.node);
                setContext(null);
              }}
            >
              Open
            </button>
          )}
          {onFocus && (
            <button
              className="button small"
              type="button"
              onClick={() => {
                onFocus(context.node.id);
                setContext(null);
              }}
            >
              Focus here
            </button>
          )}
          <button
            className="icon-button"
            type="button"
            aria-label="Dismiss graph actions"
            onClick={() => setContext(null)}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
