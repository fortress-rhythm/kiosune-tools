// @ts-check
/* Runs inside the webview. The SVG itself is rendered by the extension (src/svg.js);
   this only adds pan, zoom, filtering and the jump back into the editor. */
(function () {
  const vscode = acquireVsCodeApi();
  const stage = document.getElementById('stage');
  const search = /** @type {HTMLInputElement} */ (document.getElementById('search'));
  const toggleFall = /** @type {HTMLInputElement} */ (document.getElementById('toggle-fall'));
  const toggleHub = /** @type {HTMLInputElement} */ (document.getElementById('toggle-hub'));
  const toggleStage = /** @type {HTMLInputElement} */ (document.getElementById('toggle-stage'));

  let first = true;
  let view = { x: 20, y: 20, k: 0.85 };
  const saved = vscode.getState();
  if (saved && saved.view) view = saved.view;

  function svg() {
    return stage.querySelector('svg');
  }

  function applyView() {
    const el = svg();
    if (el) el.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    vscode.setState({ view });
  }

  function fit() {
    const el = svg();
    if (!el) return;
    const width = Number(el.getAttribute('width')) || 1;
    const height = Number(el.getAttribute('height')) || 1;
    const box = stage.getBoundingClientRect();
    view.k = Math.min(box.width / width, box.height / height, 1);
    view.x = (box.width - width * view.k) / 2;
    view.y = 12;
    applyView();
  }

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const box = stage.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const next = Math.min(3, Math.max(0.08, view.k * factor));
    view.x = px - (px - view.x) * (next / view.k);
    view.y = py - (py - view.y) * (next / view.k);
    view.k = next;
    applyView();
  }, { passive: false });

  let drag = null;
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX - view.x, y: event.clientY - view.y, moved: false };
    stage.classList.add('dragging');
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag) return;
    view.x = event.clientX - drag.x;
    view.y = event.clientY - drag.y;
    drag.moved = true;
    applyView();
  });
  stage.addEventListener('pointerup', (event) => {
    const wasDrag = drag && drag.moved;
    drag = null;
    stage.classList.remove('dragging');
    if (wasDrag) return;
    const node = event.target instanceof Element ? event.target.closest('.kio-node') : null;
    if (node) vscode.postMessage({ type: 'reveal', line: Number(node.dataset.line) });
  });
  stage.addEventListener('dblclick', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.kio-node')) fit();
  });

  document.getElementById('fit').addEventListener('click', fit);
  document.getElementById('export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
  document.addEventListener('keydown', (event) => {
    if (event.target === search) return;
    if (event.key === '0') fit();
    if (event.key === '+' || event.key === '=') { view.k = Math.min(3, view.k * 1.2); applyView(); }
    if (event.key === '-') { view.k = Math.max(0.08, view.k / 1.2); applyView(); }
  });

  function hoverWiring() {
    const el = svg();
    if (!el) return;
    for (const node of el.querySelectorAll('.kio-node')) {
      node.addEventListener('pointerenter', () => spotlight(node.dataset.id));
      node.addEventListener('pointerleave', () => spotlight(null));
    }
  }

  /** Light up one block and everything it touches. */
  function spotlight(id) {
    const el = svg();
    if (!el) return;
    const nodes = el.querySelectorAll('.kio-node');
    const edges = el.querySelectorAll('.kio-edge');
    if (!id) {
      nodes.forEach((n) => n.classList.remove('dim', 'hot'));
      edges.forEach((e) => e.classList.remove('dim', 'hot'));
      applyFilter();
      return;
    }
    const near = new Set([id]);
    edges.forEach((edge) => {
      const on = edge.dataset.from === id || edge.dataset.to === id;
      edge.classList.toggle('hot', on);
      edge.classList.toggle('dim', !on);
      if (on) { near.add(edge.dataset.from); near.add(edge.dataset.to); }
    });
    nodes.forEach((node) => {
      const on = near.has(node.dataset.id);
      node.classList.toggle('hot', node.dataset.id === id);
      node.classList.toggle('dim', !on);
    });
  }

  function applyFilter() {
    const el = svg();
    if (!el) return;
    const term = search.value.trim().toLowerCase();
    const hideFall = !toggleFall.checked;
    const hideHub = !toggleHub.checked;
    el.classList.toggle('show-stage', toggleStage.checked);
    el.querySelectorAll('.kio-node').forEach((node) => {
      const hay = `${node.dataset.id} ${node.dataset.scene} ${node.dataset.stage || ''}`.toLowerCase();
      node.classList.toggle('dim', Boolean(term) && !hay.includes(term));
    });
    el.querySelectorAll('.kio-edge').forEach((edge) => {
      const isFall = edge.classList.contains('kind-fall');
      const isHubReturn = edge.classList.contains('back') && Number(edge.dataset.incoming || 0) >= 6;
      edge.style.display = (hideFall && isFall) || (hideHub && isHubReturn) ? 'none' : '';
    });
  }

  search.addEventListener('input', applyFilter);
  toggleFall.addEventListener('change', applyFilter);
  toggleHub.addEventListener('change', applyFilter);
  toggleStage.addEventListener('change', applyFilter);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'render') {
      if (first && message.showFallthrough === false) toggleFall.checked = false;
      first = false;
      stage.innerHTML = message.svg;
      const el = svg();
      if (el) {
        // Edges need to know how busy their target is before "hide hub returns" can work.
        const incoming = new Map();
        el.querySelectorAll('.kio-node').forEach((n) => incoming.set(n.dataset.id, Number(n.dataset.incoming || 0)));
        el.querySelectorAll('.kio-edge').forEach((e) => { e.dataset.incoming = String(incoming.get(e.dataset.to) || 0); });
      }
      hoverWiring();
      applyFilter();
      applyView();
      if (message.fit) fit();
      document.getElementById('summary').textContent = message.summary || '';
    }
    if (message.type === 'highlight') {
      const el = svg();
      if (!el) return;
      el.querySelectorAll('.kio-node.cursor').forEach((n) => n.classList.remove('cursor', 'hot'));
      const node = message.id ? el.querySelector(`.kio-node[data-id="${CSS.escape(message.id)}"]`) : null;
      if (node) node.classList.add('cursor', 'hot');
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
