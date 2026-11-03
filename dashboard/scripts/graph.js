// Ancestry lanes are independent of row order: chronological rows interleave
// branches, and clock skew may place a parent above its child.
export function layoutGraph(commits, { refs = [], head = '' } = {}) {
  const index = new Map(commits.map((commit, row) => [commit.hash, row]));
  const byHash = new Map(commits.map(commit => [commit.hash, commit]));
  const columns = new Map(), laneKeys = [];
  function assignChain(hash, key) {
    if (!byHash.has(hash) || columns.has(hash)) return;
    const column = laneKeys.length;
    laneKeys.push(key);
    while (byHash.has(hash) && !columns.has(hash)) {
      columns.set(hash, column);
      hash = byHash.get(hash).parents[0];
    }
  }
  const main = refs.find(r => r.name === 'refs/heads/main') || refs.find(r => r.name === 'refs/heads/master');
  if (main) assignChain(main.hash, main.name);
  assignChain(head, 'HEAD');
  refs.filter(r => r.kind === 'branch').sort((a,b) => a.name.localeCompare(b.name)).forEach(r => assignChain(r.hash, r.name));
  refs.filter(r => r.kind === 'remote').sort((a,b) => a.name.localeCompare(b.name)).forEach(r => assignChain(r.hash, r.name));
  commits.filter(c => !c.virtual).forEach(c => assignChain(c.hash, c.hash));
  for (const c of commits.filter(c => c.virtual)) columns.set(c.hash, columns.get(c.parents[0]) ?? 0);
  const rows = commits.map(c => ({ hash: c.hash, column: columns.get(c.hash) ?? 0, virtual: !!c.virtual, color: (columns.get(c.hash) ?? 0) % 8 }));
  let maxLanes = Math.max(1, laneKeys.length);
  const edges = [];
  commits.forEach((commit, from) => {
    for (const parent of commit.parents) {
      const to = index.has(parent) ? index.get(parent) : commits.length;
      const fromColumn = rows[from].column;
      const toColumn = index.has(parent) ? rows[to].column : fromColumn;
      const low = Math.min(from, to), high = Math.max(from, to);
      const crossesNode = fromColumn === toColumn && rows.some((r,i) => i > low && i < high && r.column === fromColumn);
      const railColumn = crossesNode ? maxLanes++ : null;
      edges.push({ child: commit.hash, parent, from, to, fromColumn, toColumn, railColumn, color: rows[from].color, dashed: !!commit.virtual || !index.has(parent), upward: to < from });
    }
  });
  return { rows, edges, maxLanes };
}

export function historyNodes(data) {
  const head = data.status.head;
  return [{ hash: 'WORKTREE', parents: head && head !== '(initial)' ? [head] : [], virtual: true }, ...data.commits];
}
