const identity: Transform = [[1, 0, 0], [0, 1, 0]];

export function worldTransform(node: BaseNode): Transform {
  const matrix = node.type === 'PAGE' ? identity : (node as SceneNode).absoluteTransform;
  if (!matrix || matrix.some(row => row.some(value => !Number.isFinite(value)))) throw new Error('Invalid node transform');
  return matrix.map(row => [...row]) as Transform;
}

export function localTransform(parent: BaseNode, world: Transform): Transform {
  const [[a, c, x], [b, d, y]] = worldTransform(parent);
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-10) throw new Error('Destination transform is not invertible');
  const [[e, g, u], [f, h, v]] = world;
  return [[(d * e - c * f) / determinant, (d * g - c * h) / determinant, (d * (u - x) - c * (v - y)) / determinant],
    [(a * f - b * e) / determinant, (a * h - b * g) / determinant, (a * (v - y) - b * (u - x)) / determinant]];
}

export function verifyWorldTransform(node: SceneNode, expected: Transform) {
  const actual = worldTransform(node);
  if (actual.some((row, r) => row.some((value, c) => Math.abs(value - expected[r][c]) > (c === 2 ? 0.01 : 0.00001)))) {
    throw new Error('Destination geometry changed; absolute transform could not be preserved');
  }
}

export function placeNodes(parent: BaseNode & ChildrenMixin, nodes: SceneNode[], requestedIndex?: number): number {
  const selected = new Set(nodes.map(node => node.id));
  const remaining = parent.children.filter(node => !selected.has(node.id));
  const index = Math.min(requestedIndex ?? remaining.length, remaining.length);
  const desired = [...remaining.slice(0, index), ...nodes, ...remaining.slice(index)];
  const current = parent.children;
  if (current.length === desired.length && current.every((node, i) => node.id === desired[i].id)) return index;
  // Make the selected nodes a suffix first. Moving that suffix left in request order
  // uses the same indices as `remaining`, and never reinserts unrelated layers.
  for (const node of nodes) parent.appendChild(node);
  if (index < remaining.length) {
    for (let i = 0; i < nodes.length; i++) parent.insertChild(index + i, nodes[i]);
  }
  const actual = parent.children;
  if (actual.length !== desired.length || actual.some((node, i) => node.id !== desired[i].id)) {
    throw new Error('Layer order verification failed');
  }
  return index;
}
