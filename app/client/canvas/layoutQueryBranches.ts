import type { ELK, ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

export type LayoutConnection = { from: string; to: string };

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
  shapeTypes: Map<string, string>
): Promise<{ layout: ElkNode; branchByGroup: Map<string, string> }> {
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
      // An input used by just one branch belongs in that branch's left-to-right layout.
      branchByGroup.set(node.id, [...downstreamBranches][0]);
    } else if (downstreamBranches.size > 1) {
      hasSharedInput = true;
    }
  }
  for (const node of children) {
    if (!branchByGroup.has(node.id)) branchByGroup.set(node.id, `standalone:${node.id}`);
  }
  if (!hasSharedInput) return { layout: await elk.layout(graph), branchByGroup };

  const branchMembers = new Map<string, ElkNode[]>();
  for (const node of children) {
    const branchId = branchByGroup.get(node.id)!;
    const members = branchMembers.get(branchId) ?? [];
    members.push(node);
    branchMembers.set(branchId, members);
  }
  const layouts = new Map<string, ElkNode>();
  const branchNodes: ElkNode[] = [];
  for (const [id, members] of branchMembers) {
    const ids = new Set(members.map((node) => node.id));
    const internalEdges: ElkExtendedEdge[] = connections
      .filter(({ from, to }) => ids.has(from) && ids.has(to))
      .map(({ from, to }) => ({ id: JSON.stringify([from, to]), sources: [`${from}:out`], targets: [`${to}:in`] }));
    const layout: ElkNode =
      members.length === 1
        ? { id, width: members[0].width, height: members[0].height, children: [{ ...members[0], x: 0, y: 0 }] }
        : await elk.layout({ ...graph, id, children: members, edges: internalEdges });
    requirePosition({ ...layout, x: 0, y: 0 });
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

  // Arrange complete branches around shared inputs, without imposing a common
  // query rank. Then separate their full rectangles, including charts and tables.
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
  const placed: ElkNode[] = [];
  for (const branch of packed.children ?? []) {
    requirePosition(branch);
    const inner = layouts.get(branch.id);
    if (!inner) throw new Error("Layout returned an unknown branch.");
    for (const node of inner.children ?? []) {
      requirePosition(node);
      placed.push({ ...node, x: branch.x + node.x, y: branch.y + node.y });
    }
  }
  if (placed.length !== children.length) throw new Error("Layout did not return every branch node.");
  return { layout: { ...graph, children: placed }, branchByGroup };
}
