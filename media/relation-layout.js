(function (root) {
  'use strict';
  // Pixel geometry shared by the renderer and headless tests. The graph has
  // exactly three columns; long labels do not change edge attachment points.
  function layoutGraph(incoming, current, outgoing, viewportWidth = 720, fontSize = 13) {
    const headHeight = Math.max(24, Math.ceil(fontSize * 1.6)), siteHeight = Math.max(18, Math.ceil(fontSize * 1.4));
    const padding = 16, gap = 38, rowGap = 8, top = Math.max(34, headHeight + 10);
    const width = Math.max(560, Math.min(800, viewportWidth));
    const nodeWidth = (width - 2 * padding - 2 * gap) / 3;
    const nodeHeight = item => headHeight + 2 + (item.siteCount ? Math.max(1, Math.min(3, item.siteLines?.length || 0)) * siteHeight + (item.siteCount > 3 ? siteHeight : 0) : 0);
    const columnHeight = items => items.reduce((total, item) => total + nodeHeight(item) + rowGap, -rowGap);
    const contentHeight = Math.max(26, columnHeight(incoming), columnHeight(current ? [current] : []), columnHeight(outgoing));
    const nodes = [];
    const column = (items, col) => {
      let y = top + (contentHeight - columnHeight(items)) / 2;
      for (const item of items) {
        const height = nodeHeight(item);
        nodes.push({ id: item.id, column: col, x: padding + col * (nodeWidth + gap), y, width: nodeWidth, height, item });
        y += height + rowGap;
      }
    };
    column(incoming, 0); column(current ? [current] : [], 1); column(outgoing, 2);
    const center = nodes.find(node => node.column === 1);
    const edges = center ? nodes.filter(node => node.column !== 1 && node.item.type === 'relation').map(node => {
      const from = node.column === 0 ? node : center, to = node.column === 0 ? center : node;
      const x1 = from.x + from.width, y1 = from.y + headHeight / 2 + 1, x2 = to.x, y2 = to.y + headHeight / 2 + 1;
      const middle = (x1 + x2) / 2;
      return { from: from.id, to: to.id, d: `M ${x1} ${y1} H ${middle} V ${y2} H ${x2 - 3}` };
    }) : [];
    return { width, height: top + contentHeight + padding, headHeight, siteHeight, nodes, edges, center,
      columns: [0, 1, 2].map(col => padding + col * (nodeWidth + gap)) };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { layoutGraph };
  else root.SourceInsightReaderRelationLayout = { layoutGraph };
})(typeof window === 'undefined' ? globalThis : window);
