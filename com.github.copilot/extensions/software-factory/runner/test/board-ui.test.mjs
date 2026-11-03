// Tests del espejo de UI (ui.mjs): derivación del tablero/grafo en el navegador y
// renderizado seguro (solo textContent, enlaces https, SVG vía createElementNS).
// La fuente canónica es runner/lib/graph.mjs; aquí se valida que el mirror coincide.
import test from "node:test";
import assert from "node:assert/strict";

import { deriveBoard, graphLayout, renderState } from "../../ui.mjs";

class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this.attrs = {};
    this._text = "";
    this.innerHTMLSet = false;
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(_v) { this.innerHTMLSet = true; }
  appendChild(c) { this.children.push(c); }
  replaceChildren() { this.children = []; this._text = ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
}
function fakeDoc() {
  const els = {};
  return {
    els,
    getElementById(id) { return (els[id] ||= new El("div")); },
    createElement(tag) { return new El(tag); },
    createElementNS(ns, tag) { const e = new El(tag); e.ns = ns; return e; },
  };
}
const walk = (el, out = []) => { out.push(el); el.children.forEach((c) => walk(c, out)); return out; };

const state = {
  phase: "implement",
  round: 1,
  tasks: [
    { id: "t1", phase: "implement", title: "Implementar A", status: "done", issue: { number: 1 } },
    { id: "t2", phase: "implement", title: "Implementar B", status: "awaiting_agent", issue: { number: 2 } },
  ],
  issues: [
    { number: 1, title: "A", wave: 0, depends_on: [], url: "https://github.com/o/r/issues/1" },
    { number: 2, title: "B", wave: 1, depends_on: [1], url: "https://github.com/o/r/issues/2" },
    { number: 3, title: "C", wave: 1, depends_on: [1], url: "javascript:alert(1)" },
    { number: 4, title: "<img src=x onerror=alert(1)>", wave: 2, depends_on: [3], url: "" },
  ],
};

test("deriveBoard (mirror UI) coincide con las columnas del runner", () => {
  const board = deriveBoard(state, null);
  const col = (k) => board.columns.find((c) => c.key === k).cards.map((i) => i.number);
  assert.deepEqual(col("in_review"), [1]);
  assert.deepEqual(col("in_progress"), [2]);
  assert.deepEqual(col("ready"), [3]);
  assert.deepEqual(col("backlog"), [4]);
  assert.deepEqual(col("done"), []);
  assert.deepEqual(deriveBoard(state, new Set([3])).columns.find((c) => c.key === "done").cards.map((i) => i.number), [3]);
});

test("graphLayout: olas de arriba a abajo con coordenadas estables", () => {
  const layout = graphLayout(state);
  assert.equal(layout.waves, 3); // olas 0,1,2
  const byNum = new Map(layout.nodes.map((n) => [n.number, n]));
  assert.equal(byNum.get(1).y, 20); // ola 0 arriba
  assert.equal(byNum.get(2).y, 20 + 46 + 90); // ola 1
  assert.equal(byNum.get(3).x, 220); // dentro de la ola, ordenado por número (2→col0, 3→col1)
  assert.equal(byNum.get(4).y, 20 + 2 * (46 + 90)); // ola 2 abajo
  assert.deepEqual(layout.edges, [
    { from: 1, to: 2 }, { from: 1, to: 3 }, { from: 3, to: 4 },
  ]);
  assert.ok(layout.width >= 170 && layout.height >= 3 * 46 + 2 * 90);
});

test("renderState pinta tablero, grafo SVG y orden sin innerHTML", () => {
  const doc = fakeDoc();
  renderState(state, doc, null);
  const board = doc.els.board;
  assert.equal(board.children.length, 5); // 5 columnas
  assert.match(board.textContent, /Backlog \(1\)/);
  assert.match(board.textContent, /In Review \(1\)/);
  const all = [...walk(board), ...walk(doc.els.graph), ...walk(doc.els.order), ...walk(doc.els.issues)];
  assert.ok(all.every((e) => !e.innerHTMLSet), "solo textContent");
  // Título malicioso llega como texto literal, no como HTML.
  assert.ok(board.textContent.includes("<img src=x onerror=alert(1)>"));
  // URL javascript: no se enlaza.
  const cardC = board.children[1].children.find((c) => c.textContent.includes("#3"));
  assert.equal(cardC.children[0].tag, "span");
  // Grafo SVG real con namespaces y clases de ola.
  const svg = doc.els.graph.children[0];
  assert.equal(svg.tag, "svg");
  assert.equal(svg.ns, "http://www.w3.org/2000/svg");
  assert.equal(svg.attrs.class, "dag");
  const groups = walk(svg).filter((e) => e.tag === "g");
  assert.equal(groups.length, 4);
  assert.equal(groups[0].attrs.class, "dagNode wave0");
  assert.match(groups[0].textContent, /#1 · ola 0/);
  const paths = walk(svg).filter((e) => e.tag === "path");
  assert.equal(paths.length, 3);
  // Orden de merge: bloques por ola, #1 primero.
  assert.match(doc.els.order.textContent, /Ola 0/);
  assert.match(doc.els.order.textContent, /Ola 2/);
  // Chips de ola/dep en la lista de issues del pipeline.
  assert.match(doc.els.issues.textContent, /W1/);
  assert.match(doc.els.issues.textContent, /←#1/);
});

test("renderState con doc sin createElementNS omite el grafo sin reventar", () => {
  const doc = fakeDoc();
  delete doc.createElementNS;
  assert.doesNotThrow(() => renderState(state, doc, null));
  assert.equal(doc.els.graph.children.length, 0);
});
