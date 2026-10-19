(function (root) {
  'use strict';
  // Pixel geometry shared by the renderer and headless tests. The graph has
  // exactly three columns; long labels do not change edge attachment points.
  function layoutGraph(incoming, current, outgoing, viewportWidth = 720) {
    const padding = 16, gap = 38, height = 44, rowGap = 8, top = 34;
    const width = Math.max(560, Math.min(800, viewportWidth));
    const nodeWidth = (width - 2 * padding - 2 * gap) / 3;
    const slots = Math.max(1, incoming.length, outgoing.length);
    const contentHeight = slots * (height + rowGap) - rowGap;
    const nodes = [];
    const column = (items, col) => items.forEach((item, index) => nodes.push({
      id: item.id, column: col, x: padding + col * (nodeWidth + gap),
      y: top + (contentHeight - (items.length * (height + rowGap) - rowGap)) / 2 + index * (height + rowGap),
      width: nodeWidth, height, item
    }));
    column(incoming, 0); column(current ? [current] : [], 1); column(outgoing, 2);
    const center = nodes.find(node => node.column === 1);
    const edges = center ? nodes.filter(node => node.column !== 1 && node.item.type === 'relation').map(node => {
      const from = node.column === 0 ? node : center, to = node.column === 0 ? center : node;
      const x1 = from.x + from.width, y1 = from.y + height / 2, x2 = to.x, y2 = to.y + height / 2;
      const middle = (x1 + x2) / 2;
      return { from: from.id, to: to.id, d: `M ${x1} ${y1} H ${middle} V ${y2} H ${x2 - 3}` };
    }) : [];
    return { width, height: top + contentHeight + padding, nodes, edges, center,
      columns: [0, 1, 2].map(col => padding + col * (nodeWidth + gap)) };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { layoutGraph };
  else root.SourceInsightInspiredRelationLayout = { layoutGraph };
})(typeof window === 'undefined' ? globalThis : window);
