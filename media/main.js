/* CompilerViz webview.
 * State is always rebuilt by replaying events[0..step), so scrubbing
 * backwards and forwards is trivial and can never get out of sync. */

const NS = 'http://www.w3.org/2000/svg';
const X_GAP = 120;
const Y_GAP = 70;
const PAD = 40;

// ---------- pure logic (also used by tests) ----------

function replay(events, step) {
  const nodes = new Map();
  const edges = [];
  const tac = [];
  for (let i = 0; i < step && i < events.length; i++) {
    const e = events[i];
    if (e.type === 'NODE') nodes.set(e.id, { id: e.id, label: e.label, line: e.line });
    else if (e.type === 'EDGE') edges.push({ parent: e.parent, child: e.child, label: e.label });
    else if (e.type === 'TAC') tac.push(e);
  }
  return { nodes, edges, tac };
}

// Bottom-up parsers create children before parents, so mid-run the picture
// is a forest. Lay out every root side by side.
function layout(nodes, edges) {
  const kids = new Map();
  const hasParent = new Set();
  for (const e of edges) {
    if (!nodes.has(e.parent) || !nodes.has(e.child)) continue;
    if (!kids.has(e.parent)) kids.set(e.parent, []);
    kids.get(e.parent).push(e.child);
    hasParent.add(e.child);
  }
  const pos = new Map();
  let nextX = 0;
  const seen = new Set();

  function place(id, depth) {
    if (seen.has(id)) return pos.get(id).x;
    seen.add(id);
    pos.set(id, { x: 0, y: depth });
    const ch = (kids.get(id) || []).filter(c => !seen.has(c));
    let x;
    if (ch.length === 0) {
      x = nextX++;
    } else {
      const xs = ch.map(c => place(c, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    pos.get(id).x = x;
    return x;
  }

  for (const id of nodes.keys()) {
    if (!hasParent.has(id)) place(id, 0);
  }
  for (const id of nodes.keys()) place(id, 0); // anything left (cycles)
  return pos;
}

// ---------- DOM ----------

if (typeof document !== 'undefined' && typeof acquireVsCodeApi !== 'undefined') {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const svg = $('tree');
  const tacBody = document.querySelector('#tac tbody');

  let events = [];
  let step = 0;
  let playing = true;
  let timer = null;
  let finished = false;

  function el(name, attrs, text) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function short(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }

  function render() {
    const { nodes, edges, tac } = replay(events, step);
    const pos = layout(nodes, edges);
    const last = step > 0 ? events[step - 1] : null;

    // tree
    svg.textContent = '';
    let maxX = 0, maxY = 0;
    for (const p of pos.values()) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const W = Math.max(maxX * X_GAP + PAD * 2, 300);
    const H = Math.max(maxY * Y_GAP + PAD * 2, 120);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    const px = id => PAD + pos.get(id).x * X_GAP;
    const py = id => PAD + pos.get(id).y * Y_GAP;

    for (const e of edges) {
      if (!pos.has(e.parent) || !pos.has(e.child)) continue;
      const isNew = last && last.type === 'EDGE' && last.parent === e.parent && last.child === e.child;
      svg.appendChild(el('line', {
        x1: px(e.parent), y1: py(e.parent), x2: px(e.child), y2: py(e.child),
        class: isNew ? 'edge new' : 'edge'
      }));
      if (e.label) {
        svg.appendChild(el('text', {
          x: (px(e.parent) + px(e.child)) / 2 + 4,
          y: (py(e.parent) + py(e.child)) / 2 - 2,
          class: 'edgelabel'
        }, e.label));
      }
    }
    for (const n of nodes.values()) {
      if (!pos.has(n.id)) continue;
      const isNew = last && last.type === 'NODE' && last.id === n.id;
      const txt = short(n.label, 18);
      const w = Math.max(40, txt.length * 7.5 + 16);
      const g = el('g', { class: isNew ? 'node new' : 'node' });
      g.appendChild(el('title', {}, n.label + (n.line ? '  (line ' + n.line + ')' : '')));
      g.appendChild(el('rect', { x: px(n.id) - w / 2, y: py(n.id) - 14, width: w, height: 28, rx: 6 }));
      g.appendChild(el('text', { x: px(n.id), y: py(n.id) + 4, 'text-anchor': 'middle' }, txt));
      if (n.line) g.addEventListener('click', () => vscode.postMessage({ command: 'reveal', line: n.line }));
      svg.appendChild(g);
    }

    // TAC table
    tacBody.textContent = '';
    tac.forEach((t, i) => {
      const tr = document.createElement('tr');
      if (i === tac.length - 1 && last && last.type === 'TAC') tr.className = 'new';
      [t.idx, t.op, t.a1, t.a2, t.res].forEach(v => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      if (t.line) tr.addEventListener('click', () => vscode.postMessage({ command: 'reveal', line: t.line }));
      tacBody.appendChild(tr);
    });

    // controls
    $('slider').max = events.length;
    $('slider').value = step;
    $('count').textContent = step + ' / ' + events.length;
    $('play').innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';

    // follow along in the source file
    if (last && last.line) vscode.postMessage({ command: 'reveal', line: last.line });
  }

  function delay() {
    return 1100 - Number($('speed').value) * 100; // speed 1..10 -> 1000..100 ms
  }

  function tick() {
    timer = null;
    if (playing && step < events.length) {
      step++;
      render();
    }
    schedule();
  }

  function schedule() {
    if (timer) return;
    if (playing && (step < events.length || !finished)) timer = setTimeout(tick, delay());
  }

  function setStep(n) {
    step = Math.max(0, Math.min(events.length, n));
    render();
  }

  $('back').onclick = () => { playing = false; setStep(step - 1); };
  $('fwd').onclick = () => { playing = false; setStep(step + 1); };
  $('play').onclick = () => {
    playing = !playing;
    if (playing && step >= events.length) step = 0;
    render();
    schedule();
  };
  $('slider').oninput = e => { playing = false; setStep(Number(e.target.value)); };

  window.addEventListener('message', ({ data }) => {
    if (data.command === 'reset') {
      events = []; step = 0; playing = true; finished = false;
      if (timer) { clearTimeout(timer); timer = null; }
      $('status').textContent = 'running\u2026';
      render();
    } else if (data.command === 'event') {
      events.push(data.ev);
      $('slider').max = events.length;
      $('count').textContent = step + ' / ' + events.length;
      schedule();
    } else if (data.command === 'done') {
      finished = true;
      $('status').textContent = events.length === 0
        ? 'no @VIZ events received (exit ' + data.code + ') - see Output > CompilerViz'
        : 'finished (exit ' + data.code + ')';
    }
  });

  render();
}

if (typeof module !== 'undefined') module.exports = { replay, layout };
