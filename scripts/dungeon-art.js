/**
 * Draw a dungeon model (from dungeon-geom.js) as an SVG battlemap.
 *
 * PURE — no Foundry globals. See settle-render.js for the rule.
 *
 * This is why we never download Watabou's own picture: the geometry alone is enough to
 * draw the map, so the art is generated from the same numbers that become the walls. They
 * cannot drift apart, there is nothing to trace, and the styling is ours to change.
 */
(function (root) {
  const ART = (root.SSVDUNART = root.SSVDUNART || {});

  /** Two looks. "vellum" is the ink-on-paper one; "scan" is the ship's sensor readout. */
  const THEMES = {
    // Watabou's own palette, read off the generator's Style dialog, so a map we draw and a
    // handout exported from the generator sit on the same paper.
    dungeon: {
      page: "#ede0ce", floor: "#f7eede", grid: "#ddd0ba", ink: "#000000",
      door: "#f7eede", label: "#000000", labelBg: "#f7eede", accent: "#7d4a2e",
      speckle: "#c9c1b1", water: "#b2aa9d", hatch: true,
    },
    scan: {                                      // the Gull's sensors picking out a derelict
      page: "#04121c", floor: "#0e2634", grid: "#163a4a", ink: "#5fd0c4",
      door: "#0e2634", label: "#d7f2ee", labelBg: "#04121c", accent: "#e8a13c",
      speckle: "#17414f", hatch: true,
    },
  };
  THEMES.vellum = THEMES.dungeon;                // old name, kept working
  ART.THEMES = THEMES;

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function toSvg(m, opts = {}) {
    const t = THEMES[opts.theme] || THEMES.dungeon;
    const g = m.gridSize;
    const wallW = Math.max(3, Math.round(g * 0.10));
    const band = g * 0.44;                 // how far the shading reaches out from a wall
    const sp = Math.max(4, g * 0.105);     // hatch spacing
    const p = [];

    p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}" viewBox="0 0 ${m.width} ${m.height}">`);

    const cellRects = [];
    for (const k of m.cells) {
      const [cx, cy] = k.split(",").map(Number);
      cellRects.push(`<rect x="${(cx + m.offset.x) * g}" y="${(cy + m.offset.y) * g}" width="${g}" height="${g}"/>`);
    }
    const wallPath = m.walls.map(([x0, y0, x1, y1]) => `M${x0} ${y0}L${x1} ${y1}`).join("");

    // The hatching is masked to everything that is NOT floor, then painted as a fat stroke
    // along the wall lines — so it hugs the outside of the rooms and stops dead at the
    // floor edge, which is exactly how a hand-drawn dungeon reads.
    p.push(`<defs>`);
    p.push(`<clipPath id="floor">${cellRects.join("")}</clipPath>`);
    p.push(`<mask id="outside"><rect width="${m.width}" height="${m.height}" fill="#fff"/>` +
           `<g fill="#000">${cellRects.join("")}</g></mask>`);
    p.push(`</defs>`);

    // Page, floor, grid.
    p.push(`<rect width="${m.width}" height="${m.height}" fill="${t.page}"/>`);
    p.push(`<g mask="url(#outside)" stroke="${t.ink}" stroke-linecap="round" opacity=".9">${hatch(m, g, band)}</g>`);
    p.push(`<g fill="${t.floor}">${cellRects.join("")}</g>`);

    if (opts.grid !== false) {
      const lines = [];
      for (let x = 0; x <= m.width; x += g) lines.push(`M${x} 0V${m.height}`);
      for (let y = 0; y <= m.height; y += g) lines.push(`M0 ${y}H${m.width}`);
      p.push(`<path d="${lines.join("")}" stroke="${t.grid}" stroke-width="1" fill="none" clip-path="url(#floor)"/>`);
    }

    // Flagstone speckle — deterministic, so the same dungeon always draws the same.
    const dots = [];
    for (const k of m.cells) {
      const [cx, cy] = k.split(",").map(Number);
      let h = ((cx * 73856093) ^ (cy * 19349663)) >>> 0;
      const n = h % 3;
      for (let i = 0; i < n; i++) {
        h = (h * 1664525 + 1013904223) >>> 0;
        const fx = ((h >>> 8) % 100) / 100;
        h = (h * 1664525 + 1013904223) >>> 0;
        const fy = ((h >>> 8) % 100) / 100;
        dots.push(`<circle cx="${((cx + m.offset.x) + fx) * g}" cy="${((cy + m.offset.y) + fy) * g}" r="${g * 0.018}"/>`);
      }
    }
    p.push(`<g fill="${t.speckle}" opacity=".8">${dots.join("")}</g>`);

    for (const w of m.water || []) {
      p.push(`<rect x="${w.x}" y="${w.y}" width="${w.w}" height="${w.h}" fill="${t.water || t.accent}" opacity=".55"/>`);
    }

    // Walls, drawn over the hatching.
    p.push(`<path d="${wallPath}" stroke="${t.ink}" stroke-width="${wallW}" stroke-linecap="square" fill="none"/>`);

    for (const c of m.columns || []) {
      p.push(`<circle cx="${c.x}" cy="${c.y}" r="${g * 0.17}" fill="${t.ink}"/>`);
    }

    for (const d of m.doors) p.push(doorMark(d, t, g, wallW));
    for (const s of m.spawns || []) p.push(stairs(s, t, g, wallW, false));
    for (const s of m.exits || []) p.push(stairs(s, t, g, wallW, true));

    for (const r of m.rooms) {
      for (const n of r.notes) {
        p.push(`<circle cx="${n.at.x}" cy="${n.at.y}" r="${g * 0.33}" fill="${t.labelBg}" stroke="${t.ink}" stroke-width="${Math.max(2, g * 0.035)}"/>`);
        p.push(`<text x="${n.at.x}" y="${n.at.y + g * 0.145}" font-family="Georgia,'Times New Roman',serif" font-size="${g * 0.42}" font-weight="bold" fill="${t.label}" text-anchor="middle">${esc(n.ref)}</text>`);
      }
    }

    p.push(`</svg>`);
    return p.join("\n");
  }
  ART.toSvg = toSvg;

  /**
   * Scratchy shading running outward from every wall.
   *
   * Strokes are perpendicular to their own wall segment — that is what separates a
   * hand-drawn dungeon from an architectural drawing, where a uniform 45-degree field
   * reads as a section cut. Jitter is hashed off the coordinates so a given dungeon
   * always draws identically.
   */
  function hatch(m, g, band) {
    const out = [];
    const w = Math.max(1, g * 0.026);
    for (const e of m.edges || []) {
      const dx = e.x1 - e.x0, dy = e.y1 - e.y0;
      let h = ((e.x0 * 73856093) ^ (e.y0 * 19349663) ^ ((e.nx + 2) * 83492791)) >>> 0;
      const n = 5;
      for (let i = 0; i < n; i++) {
        h = (h * 1664525 + 1013904223) >>> 0;
        const jitter = (((h >>> 9) % 100) / 100 - 0.5) * 0.22;
        h = (h * 1664525 + 1013904223) >>> 0;
        const len = band * (0.35 + ((h >>> 11) % 100) / 100 * 0.62);
        const f = (i + 0.5) / n + jitter;
        const bx = e.x0 + dx * f, by = e.y0 + dy * f;
        // lean each stroke along the wall a little so it does not look combed
        h = (h * 1664525 + 1013904223) >>> 0;
        const lean = (((h >>> 13) % 100) / 100 - 0.5) * 0.5;
        const ex = bx + e.nx * len + dx * lean;
        const ey = by + e.ny * len + dy * lean;
        out.push(`<path d="M${bx.toFixed(1)} ${by.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}" stroke-width="${w.toFixed(2)}"/>`);
      }
    }
    return out.join("");
  }

  function doorMark(d, t, g, wallW) {
    const [x0, y0, x1, y1] = d.seg;
    const vertical = x0 === x1;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    if (d.kind === "secret") {
      return `<path d="M${x0} ${y0}L${x1} ${y1}" stroke="${t.ink}" stroke-width="${wallW}" fill="none"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${g * 0.2}" fill="${t.floor}" stroke="${t.ink}" stroke-width="${wallW * 0.7}"/>` +
        `<text x="${cx}" y="${cy + g * 0.1}" font-family="Georgia,serif" font-size="${g * 0.28}" font-weight="bold" fill="${t.ink}" text-anchor="middle">S</text>`;
    }
    if (d.kind === "barred" || d.kind === "portcullis") {
      let out = `<path d="M${x0} ${y0}L${x1} ${y1}" stroke="${t.ink}" stroke-width="${wallW}" fill="none"/>`;
      for (let i = 1; i <= 3; i++) {
        const f = i / 4;
        const bx = x0 + (x1 - x0) * f, by = y0 + (y1 - y0) * f;
        const ex = vertical ? g * 0.15 : 0, ey = vertical ? 0 : g * 0.15;
        out += `<path d="M${bx - ex} ${by - ey}L${bx + ex} ${by + ey}" stroke="${t.ink}" stroke-width="${wallW * 0.8}"/>`;
      }
      return out;
    }
    // A plain door: the jambs either side, then the leaf across the gap.
    const leafL = g * 0.62, leafT = g * 0.2;
    const w = vertical ? leafT : leafL, h = vertical ? leafL : leafT;
    let out = `<path d="M${x0} ${y0}L${x1} ${y1}" stroke="${t.ink}" stroke-width="${wallW * 0.6}" fill="none"/>`;
    out += `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" fill="${t.door}" stroke="${t.ink}" stroke-width="${wallW * 0.9}"/>`;
    if (d.kind === "locked") out += `<circle cx="${cx}" cy="${cy}" r="${g * 0.075}" fill="${t.ink}"/>`;
    return out;
  }

  /** Real steps rather than an icon — drawn across the passage, like a dungeon map. */
  function stairs(s, t, g, wallW, isExit) {
    const across = s.dir && s.dir.x !== 0;      // travel is east-west → steps run north-south
    const ink = isExit ? t.ink : t.accent;
    const half = g * 0.34;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const f = -0.3 + i * 0.2;
      const x = across ? s.x + f * g : s.x - half;
      const y = across ? s.y - half : s.y + f * g;
      const x2 = across ? x : s.x + half;
      const y2 = across ? s.y + half : y;
      out.push(`<path d="M${x} ${y}L${x2} ${y2}" stroke="${ink}" stroke-width="${wallW * 0.8}" stroke-linecap="round"/>`);
    }
    return `<g opacity=".95">${out.join("")}</g>`;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = ART;
})(typeof globalThis !== "undefined" ? globalThis : this);
