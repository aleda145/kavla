import type { ELK, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

export type LayoutConnection = { from: string; to: string };
export type LayoutDirection = "RIGHT" | "LEFT" | "DOWN" | "UP";

type PlacedNode = ElkNode & { x: number; y: number; width: number; height: number };

function requirePosition(node: ElkNode): asserts node is PlacedNode {
  if (
    ![node.x, node.y, node.width, node.height].every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    throw new Error("Layout returned an invalid branch position.");
  }
}

export async function layoutQueryBranches(
  elk: ELK,
  graph: ElkNode,
  connections: LayoutConnection[],
  shapeTypes: Map<string, string>,
  makeGroupNode: (id: string, direction: LayoutDirection) => ElkNode
): Promise<ElkNode> {
  const children = graph.children ?? [];
  const queryIds = new Set(
    children.filter((node) => shapeTypes.get(node.id) === "sql-text-area").map((node) => node.id)
  );
  const neighbors = new Map([...queryIds].map((id) => [id, new Set<string>()]));
  for (const { from, to } of connections) {
    if (!queryIds.has(from) || !queryIds.has(to)) continue;
    neighbors.get(from)!.add(to);
    neighbors.get(to)!.add(from);
  }

  // Shared inputs don't make two analyses one branch. Query dependencies do:
  // walking in both directions also keeps branches that merge downstream together.
  const branchByGroup = new Map<string, string>();
  for (const id of queryIds) {
    if (branchByGroup.has(id)) continue;
    const branchId = `branch:${id}`;
    const pending = [id];
    branchByGroup.set(id, branchId);
    for (let index = 0; index < pending.length; index++) {
      for (const next of neighbors.get(pending[index])!) {
        if (branchByGroup.has(next)) continue;
        branchByGroup.set(next, branchId);
        pending.push(next);
      }
    }
  }

  let hasSharedInput = false;
  for (const node of children) {
    if (!["data-source", "knob"].includes(shapeTypes.get(node.id) ?? "")) continue;
    const downstreamBranches = new Set(
      connections.filter(({ from, to }) => from === node.id && queryIds.has(to)).map(({ to }) => branchByGroup.get(to)!)
    );
    if (downstreamBranches.size === 1) {
      // An input used by just one branch belongs in that branch's internal layout.
      branchByGroup.set(node.id, [...downstreamBranches][0]);
    } else if (downstreamBranches.size > 1) {
      hasSharedInput = true;
    }
  }
  for (const node of children) {
    if (!branchByGroup.has(node.id)) branchByGroup.set(node.id, `standalone:${node.id}`);
  }
  if (!hasSharedInput) return elk.layout(graph);

  const branchMembers = new Map<string, ElkNode[]>();
  for (const node of children) {
    const branchId = branchByGroup.get(node.id)!;
    const members = branchMembers.get(branchId) ?? [];
    members.push(node);
    branchMembers.set(branchId, members);
  }
  const layouts = new Map<string, ElkNode>();
  const branchNodes: ElkNode[] = [];
  const arrangeBranch = async (id: string, members: ElkNode[], direction: LayoutDirection): Promise<ElkNode> => {
    const oriented = members.map((node) => makeGroupNode(node.id, direction));
    const ids = new Set(members.map((node) => node.id));
    const internalEdges: ElkExtendedEdge[] = connections
      .filter(({ from, to }) => ids.has(from) && ids.has(to))
      .map(({ from, to }) => ({ id: JSON.stringify([from, to]), sources: [from], targets: [to] }));
    const layout: ElkNode =
      oriented.length === 1
        ? { id, width: oriented[0].width, height: oriented[0].height, children: [{ ...oriented[0], x: 0, y: 0 }] }
        : await elk.layout({
            ...graph,
            id,
            children: oriented,
            edges: internalEdges,
            layoutOptions: { ...graph.layoutOptions, "elk.direction": direction },
          });
    requirePosition({ ...layout, x: 0, y: 0 });
    return layout;
  };
  for (const [id, members] of branchMembers) {
    const layout = await arrangeBranch(id, members, "RIGHT");
    layouts.set(id, layout);
    branchNodes.push({ id, width: layout.width, height: layout.height });
  }

  const branchEdges = new Map<string, ElkExtendedEdge>();
  for (const { from, to } of connections) {
    const source = branchByGroup.get(from)!;
    const target = branchByGroup.get(to)!;
    if (source === target) continue;
    const id = JSON.stringify([source, target]);
    branchEdges.set(id, { id, sources: [source], targets: [target] });
  }

  // First find a side for each branch around the shared inputs. Internal query
  // flow and the chart/table sides are oriented to that side below.
  const typicalSize =
    branchNodes.reduce((sum, node) => sum + Math.max(node.width!, node.height!), 0) / branchNodes.length;
  const spread = await elk.layout({
    id: "kavla-branches",
    layoutOptions: {
      "elk.algorithm": "stress",
      "elk.randomSeed": "1",
      "elk.stress.desiredEdgeLength": String(Math.max(400, typicalSize)),
      "elk.stress.iterationLimit": "200",
      "elk.spacing.componentComponent": "160",
    },
    children: branchNodes,
    edges: [...branchEdges.values()],
  });
  const packed = await elk.layout({
    ...spread,
    layoutOptions: {
      "elk.algorithm": "sporeOverlap",
      "elk.spacing.nodeNode": "160",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
  });
  const initial = new Map<string, PlacedNode>();
  for (const branch of packed.children ?? []) {
    requirePosition(branch);
    initial.set(branch.id, branch);
  }
  const isQueryBranch = (id: string) => branchMembers.get(id)!.some((node) => queryIds.has(node.id));
  // Shared sources remain fixed while complete query branches are placed.
  const positioned = [...initial.values()].filter((branch) => !isQueryBranch(branch.id));
  const gap = 160;
  const overlaps = (a: PlacedNode, b: PlacedNode) =>
    a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
  for (const original of initial.values()) {
    if (!isQueryBranch(original.id)) continue;
    const inputIds = new Set(
      connections
        .filter(
          ({ from, to }) =>
            branchByGroup.get(to) === original.id &&
            branchByGroup.get(from) !== original.id &&
            ["data-source", "knob"].includes(shapeTypes.get(from) ?? "")
        )
        .map(({ from }) => branchByGroup.get(from)!)
    );
    const inputs = [...inputIds].map((id) => initial.get(id)!);
    let direction: LayoutDirection = "RIGHT";
    if (inputs.length) {
      const sourceX = inputs.reduce((sum, node) => sum + node.x + node.width / 2, 0) / inputs.length;
      const sourceY = inputs.reduce((sum, node) => sum + node.y + node.height / 2, 0) / inputs.length;
      const dx = original.x + original.width / 2 - sourceX;
      const dy = original.y + original.height / 2 - sourceY;
      direction = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "RIGHT" : "LEFT") : dy >= 0 ? "DOWN" : "UP";
    }
    const inner = await arrangeBranch(original.id, branchMembers.get(original.id)!, direction);
    layouts.set(original.id, inner);
    const branch = {
      ...original,
      width: inner.width!,
      height: inner.height!,
      x: original.x + (original.width - inner.width!) / 2,
      y: original.y + (original.height - inner.height!) / 2,
    };
    // Keep the entire branch beyond its inputs. Later queries can only progress
    // farther out, never back across the source, even after overlap removal.
    for (const input of inputs) {
      if (direction === "RIGHT") branch.x = Math.max(branch.x, input.x + input.width + gap);
      if (direction === "LEFT") branch.x = Math.min(branch.x, input.x - branch.width - gap);
      if (direction === "DOWN") branch.y = Math.max(branch.y, input.y + input.height + gap);
      if (direction === "UP") branch.y = Math.min(branch.y, input.y - branch.height - gap);
    }
    const vertical = direction === "DOWN" || direction === "UP";
    const candidates = [
      branch,
      ...positioned.flatMap((other) =>
        vertical
          ? [
              { ...branch, x: other.x - branch.width - gap },
              { ...branch, x: other.x + other.width + gap },
            ]
          : [
              { ...branch, y: other.y - branch.height - gap },
              { ...branch, y: other.y + other.height + gap },
            ]
      ),
    ];
    candidates.sort((a, b) => Math.hypot(a.x - branch.x, a.y - branch.y) - Math.hypot(b.x - branch.x, b.y - branch.y));
    const free = candidates.find((candidate) => positioned.every((other) => !overlaps(candidate, other)));
    if (!free) throw new Error("Could not find space for a query branch.");
    positioned.push(free);
  }
  const originX = Math.min(...positioned.map((node) => node.x));
  const originY = Math.min(...positioned.map((node) => node.y));
  const placed: ElkNode[] = [];
  for (const branch of positioned) {
    const inner = layouts.get(branch.id);
    if (!inner) throw new Error("Layout returned an unknown branch.");
    for (const node of inner.children ?? []) {
      requirePosition(node);
      placed.push({ ...node, x: branch.x + node.x - originX, y: branch.y + node.y - originY });
    }
  }
  if (placed.length !== children.length) throw new Error("Layout did not return every branch node.");
  return { ...graph, children: placed };
}
