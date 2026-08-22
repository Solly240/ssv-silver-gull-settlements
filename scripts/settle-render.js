/* SSV Silver Gull — Settlements : pure renderer + geometry.
 *
 * This file must never touch Foundry globals (game/ui/Hooks/canvas). Everything here is
 * plain data in, DOM/objects out, so that `../../preview.html` can drive it in a bare
 * browser and `node` can run the geometry self-test. All Foundry wiring lives in
 * settlements.js. See MAINTAINING.md §1.
 */
(function () {
  "use strict";

  const SSVSET = {};

  /* ------------------------------------------------------------------ *
   * 0. Small helpers
   * ------------------------------------------------------------------ */

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  SSVSET.esc = esc;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  SSVSET.clamp = clamp;

  /* ------------------------------------------------------------------ *
   * 1. Floorplan geometry
   * ------------------------------------------------------------------ *
   *
   * An interior is authored as an ASCII grid. Walls, doors, lights, spawn points, exit
   * zones, NPC posts and wander waypoints are all derived from that one grid, so the
   * battlemap art (rendered from the same grid by tools/gen_maps.py) can never drift out
   * of alignment with the geometry.
   *
   *   #   solid wall            blocks movement + sight
   *   =   counter / crate       blocks movement, sight passes over
   *   '   window                blocks movement, sight passes through
   *   +   door                  passable, hinged door
   *   /   locked door           passable once unlocked
   *   .   floor
   *   ,   street / outdoor floor
   *   ~   difficult terrain     (art only)
   *   L   bright light          l  dim light
   *   S   party spawn           X  exit zone (walk here to return to the hub)
   *   1-9 NPC post              a-z wander waypoint
   *
   * Anything not listed is treated as plain floor.
   */

  // Foundry wall-restriction constants, inlined so this file stays Foundry-free.
  const SENSE_NONE = 0;
  const SENSE_NORMAL = 20;
  const DOOR_NONE = 0;
  const DOOR_DOOR = 1;
  const DOOR_SECRET = 2;
  const DS_CLOSED = 0;
  const DS_LOCKED = 2;

  const CELL = {
    "#": { kind: "wall", blocksMove: true, blocksSight: true },
    "=": { kind: "counter", blocksMove: true, blocksSight: false },
    "'": { kind: "window", blocksMove: true, blocksSight: false, thin: true },
    "+": { kind: "door", blocksMove: false, door: "door" },
    "/": { kind: "door", blocksMove: false, door: "locked" },
  };

  const isPost = (ch) => ch >= "1" && ch <= "9";
  const isWaypoint = (ch) => ch >= "a" && ch <= "z";
  const cellInfo = (ch) => CELL[ch] || null;
  const blocksMove = (ch) => !!(CELL[ch] && CELL[ch].blocksMove);

  /** Normalise a plan into a padded rectangular array of characters. */
  function readPlan(plan) {
    const rows = (Array.isArray(plan) ? plan : String(plan).split("\n")).map((r) =>
      String(r).replace(/\s+$/, "")
    );
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    return {
      rows: rows.length,
      cols,
      at(r, c) {
        if (r < 0 || c < 0 || r >= rows.length || c >= cols) return null; // outside the map
        return rows[r][c] ?? " ";
      },
    };
  }

  /**
   * Merge unit wall segments into the longest possible collinear runs. Segments only merge
   * when every restriction property matches, so a counter never fuses into a solid wall.
   */
  function mergeSegments(segs) {
    const buckets = new Map();
    for (const s of segs) {
      const horiz = s.a[1] === s.b[1];
      const fixed = horiz ? s.a[1] : s.a[0];
      const k = `${horiz ? "H" : "V"}|${fixed}|${JSON.stringify(s.props)}`;
      if (!buckets.has(k)) buckets.set(k, { horiz, fixed, props: s.props, spans: [] });
      const lo = horiz ? Math.min(s.a[0], s.b[0]) : Math.min(s.a[1], s.b[1]);
      const hi = horiz ? Math.max(s.a[0], s.b[0]) : Math.max(s.a[1], s.b[1]);
      buckets.get(k).spans.push([lo, hi]);
    }
    const out = [];
    for (const b of buckets.values()) {
      b.spans.sort((x, y) => x[0] - y[0]);
      const runs = [];
      let cur = null;
      for (const [lo, hi] of b.spans) {
        if (cur && lo <= cur[1]) cur[1] = Math.max(cur[1], hi);
        else {
          if (cur) runs.push(cur);
          cur = [lo, hi];
        }
      }
      if (cur) runs.push(cur);
      for (const [lo, hi] of runs) {
        out.push({
          c: b.horiz ? [lo, b.fixed, hi, b.fixed] : [b.fixed, lo, b.fixed, hi],
          ...b.props,
        });
      }
    }
    return out;
  }

  const WALL_PROPS = {
    wall: { move: SENSE_NORMAL, sight: SENSE_NORMAL, light: SENSE_NORMAL, sound: SENSE_NORMAL, door: DOOR_NONE, ds: DS_CLOSED },
    counter: { move: SENSE_NORMAL, sight: SENSE_NONE, light: SENSE_NONE, sound: SENSE_NONE, door: DOOR_NONE, ds: DS_CLOSED },
    window: { move: SENSE_NORMAL, sight: SENSE_NONE, light: SENSE_NONE, sound: SENSE_NORMAL, door: DOOR_NONE, ds: DS_CLOSED },
    door: { move: SENSE_NORMAL, sight: SENSE_NORMAL, light: SENSE_NORMAL, sound: SENSE_NORMAL, door: DOOR_DOOR, ds: DS_CLOSED },
    locked: { move: SENSE_NORMAL, sight: SENSE_NORMAL, light: SENSE_NORMAL, sound: SENSE_NORMAL, door: DOOR_DOOR, ds: DS_LOCKED },
    secret: { move: SENSE_NORMAL, sight: SENSE_NORMAL, light: SENSE_NORMAL, sound: SENSE_NORMAL, door: DOOR_SECRET, ds: DS_CLOSED },
  };

  const DEFAULT_LIGHT = { L: { dim: 30, bright: 12, color: "#ffcf9a", alpha: 0.28 }, l: { dim: 16, bright: 0, color: "#8fd8ff", alpha: 0.2 } };

  /**
   * Which cells a token can stand in and step between, worked out from wall segments
   * rather than a cell grid. Needed by the wander engine on analysed maps, where there is
   * no ASCII floorplan to read passability from.
   */
  function passableFromWalls(walls, cols, rows, g) {
    const crosses = (x0, y0, x1, y1) => walls.some((w) => segmentsCross(x0, y0, x1, y1, w.c[0], w.c[1], w.c[2], w.c[3]));
    const grid = [];
    for (let r = 0; r < rows; r++) {
      grid.push([]);
      for (let c = 0; c < cols; c++) grid[r].push(true);
    }
    return { grid, crosses };
  }

  function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
    const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
    return t > 0 && t < 1 && u > 0 && u < 1;
  }
  SSVSET.segmentsCross = segmentsCross;

  /**
   * Geometry read off a finished battlemap by tools/analyze_map.py.
   *
   * The art is generated free-form and nothing is drawn onto it; the walls, doors and
   * lights are found afterwards and live only as Foundry documents. Coordinates are image
   * pixels, so they need no grid snapping — which is the whole point, since illustrated
   * maps never line up with a cell grid.
   */
  function geometryFromAnalysis(interior) {
    const a = interior.geometry || {};
    const g = Number(interior.gridSize) || 100;
    const [width, height] = a.size || [0, 0];
    const cols = Math.max(1, Math.round(width / g));
    const rows = Math.max(1, Math.round(height / g));

    const walls = (a.walls || []).map((c) => ({ c, ...WALL_PROPS.wall }));
    for (const c of a.doors || []) walls.push({ c, ...WALL_PROPS.door });
    for (const c of a.lockedDoors || []) walls.push({ c, ...WALL_PROPS.locked });
    for (const c of a.windows || []) walls.push({ c, ...WALL_PROPS.window });

    const lights = (a.lights || []).map((l) => ({
      x: l.x, y: l.y,
      dim: l.dim ?? 30, bright: l.bright ?? 10,
      color: l.color ?? "#ffcf9a", alpha: l.alpha ?? 0.3,
      animation: l.animation || null,
    }));

    const cellOf = (p) => ({ x: p.x, y: p.y, col: Math.floor(p.x / g), row: Math.floor(p.y / g) });
    const spawns = (a.spawns || []).map(cellOf);
    const waypoints = (a.waypoints || []).map((w, i) => ({ tag: w.tag || String(i), ...cellOf(w) }));
    const posts = {};
    for (const [k, v] of Object.entries(a.posts || {})) posts[k] = cellOf(v);

    // Cells a token may occupy: start open, then let the wander engine's step check reject
    // moves that would cross a wall.
    const { grid } = passableFromWalls(walls, cols, rows, g);

    return {
      gridSize: g, cols, rows, width, height,
      walls, lights, spawns, waypoints, posts,
      exits: a.exits || [],
      passable: grid,
      wallSegments: walls.map((w) => w.c),
      fromAnalysis: true,
    };
  }
  SSVSET.geometryFromAnalysis = geometryFromAnalysis;

  /**
   * Derive every piece of Foundry geometry from an interior definition.
   *
   * Two kinds of interior: one analysed off a finished piece of map art (preferred — the
   * art stays untouched), and one derived from an authored ASCII floorplan (used for
   * placeholder maps and for anything hand-laid).
   * Pure: returns plain objects, creates nothing.
   */
  function deriveGeometry(interior) {
    if (interior?.geometry) return geometryFromAnalysis(interior);
    const g = Number(interior?.gridSize) || 100;
    const plan = readPlan(interior?.plan || []);
    const { rows, cols } = plan;
    const px = (c) => c * g;

    const segs = [];
    const lights = [];
    const spawns = [];
    const exits = [];
    const posts = {};
    const waypoints = [];
    const passable = [];

    const pushSeg = (a, b, kind) => segs.push({ a, b, props: WALL_PROPS[kind] });

    for (let r = 0; r < rows; r++) {
      passable.push([]);
      for (let c = 0; c < cols; c++) {
        const ch = plan.at(r, c);
        const info = cellInfo(ch);
        passable[r][c] = !blocksMove(ch);

        if (info && info.blocksMove) {
          // Emit each edge this blocking cell shares with something passable (or with the
          // outside of the map). Edges between two blocking cells are skipped, so a wall
          // several cells thick still yields a single line per face.
          const kind = info.kind === "wall" ? "wall" : info.kind;
          const nbr = [
            [r - 1, c, [px(c), px(r)], [px(c + 1), px(r)]],       // north
            [r + 1, c, [px(c), px(r + 1)], [px(c + 1), px(r + 1)]], // south
            [r, c - 1, [px(c), px(r)], [px(c), px(r + 1)]],       // west
            [r, c + 1, [px(c + 1), px(r)], [px(c + 1), px(r + 1)]], // east
          ];
          for (const [nr, nc, a, b] of nbr) {
            const nch = plan.at(nr, nc);
            if (nch === null || !blocksMove(nch)) pushSeg(a, b, kind);
          }
          continue;
        }

        if (info && info.door) {
          // The neighbouring solid cells have already emitted this cell's side edges as
          // jambs, so all that is missing is one leaf across the opening.
          const vertPassage = blocksMove(plan.at(r, c - 1)) && blocksMove(plan.at(r, c + 1));
          const horizPassage = blocksMove(plan.at(r - 1, c)) && blocksMove(plan.at(r + 1, c));
          const kind = info.door === "locked" ? "locked" : "door";
          if (vertPassage || !horizPassage) {
            const y = px(r) + g / 2;
            pushSeg([px(c), y], [px(c + 1), y], kind);
          } else {
            const x = px(c) + g / 2;
            pushSeg([x, px(r)], [x, px(r + 1)], kind);
          }
          continue;
        }

        // Passable markers.
        const cx = px(c) + g / 2;
        const cy = px(r) + g / 2;
        if (ch === "L" || ch === "l") {
          const cfg = { ...(DEFAULT_LIGHT[ch] || DEFAULT_LIGHT.L), ...((interior?.lights || {})[ch] || {}) };
          lights.push({ x: cx, y: cy, dim: cfg.dim, bright: cfg.bright, color: cfg.color, alpha: cfg.alpha, animation: cfg.animation || null });
        } else if (ch === "S") {
          spawns.push({ x: cx, y: cy, col: c, row: r });
        } else if (ch === "X") {
          exits.push({ x: px(c), y: px(r), w: g, h: g, col: c, row: r });
        } else if (isPost(ch)) {
          posts[ch] = { x: cx, y: cy, col: c, row: r };
        } else if (isWaypoint(ch)) {
          waypoints.push({ tag: ch, x: cx, y: cy, col: c, row: r });
        }
      }
    }

    const mergedWalls = mergeSegments(segs);
    return {
      gridSize: g,
      cols,
      rows,
      width: cols * g,
      height: rows * g,
      walls: mergedWalls,
      wallSegments: mergedWalls.map((w) => w.c),
      lights,
      spawns,
      exits: mergeExits(exits, g),
      posts,
      waypoints,
      passable,
    };
  }
  SSVSET.deriveGeometry = deriveGeometry;

  /** Merge orthogonally adjacent exit cells into as few rectangles as possible. */
  function mergeExits(cells, g) {
    if (!cells.length) return [];
    const byRow = new Map();
    for (const e of cells) {
      if (!byRow.has(e.row)) byRow.set(e.row, []);
      byRow.get(e.row).push(e);
    }
    const strips = [];
    for (const [row, list] of byRow) {
      list.sort((a, b) => a.col - b.col);
      let cur = null;
      for (const e of list) {
        if (cur && e.col === cur.col + cur.cells) cur.cells++;
        else {
          if (cur) strips.push(cur);
          cur = { row, col: e.col, cells: 1 };
        }
      }
      if (cur) strips.push(cur);
    }
    // Fuse vertically stacked strips of identical horizontal extent.
    strips.sort((a, b) => a.col - b.col || a.cells - b.cells || a.row - b.row);
    const out = [];
    let cur = null;
    for (const s of strips) {
      if (cur && s.col === cur.col && s.cells === cur.cells && s.row === cur.row + cur.high) cur.high++;
      else {
        if (cur) out.push(cur);
        cur = { ...s, high: 1 };
      }
    }
    if (cur) out.push(cur);
    return out.map((s) => ({ x: s.col * g, y: s.row * g, w: s.cells * g, h: s.high * g }));
  }

  /** Breadth-first reachability over passable cells, from one cell. */
  function floodFill(passable, start) {
    const rows = passable.length;
    const cols = rows ? passable[0].length : 0;
    const seen = new Set();
    if (!rows || !cols) return seen;
    const q = [[start.row, start.col]];
    seen.add(`${start.row},${start.col}`);
    while (q.length) {
      const [r, c] = q.shift();
      for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const k = `${nr},${nc}`;
        if (seen.has(k) || !passable[nr][nc]) continue;
        seen.add(k);
        q.push([nr, nc]);
      }
    }
    return seen;
  }
  SSVSET.floodFill = floodFill;

  /** Shortest path between two cells over passable ground. Returns [] when unreachable. */
  function pathfind(passable, from, to) {
    const rows = passable.length;
    const cols = rows ? passable[0].length : 0;
    if (!rows || !cols) return [];
    if (from.row === to.row && from.col === to.col) return [];
    if (!passable[to.row]?.[to.col]) return [];
    const prev = new Map();
    const q = [[from.row, from.col]];
    prev.set(`${from.row},${from.col}`, null);
    while (q.length) {
      const [r, c] = q.shift();
      if (r === to.row && c === to.col) break;
      for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const k = `${nr},${nc}`;
        if (prev.has(k) || !passable[nr][nc]) continue;
        prev.set(k, [r, c]);
        q.push([nr, nc]);
      }
    }
    const goal = `${to.row},${to.col}`;
    if (!prev.has(goal)) return [];
    const path = [];
    let cur = [to.row, to.col];
    while (cur) {
      path.unshift({ row: cur[0], col: cur[1] });
      cur = prev.get(`${cur[0]},${cur[1]}`);
    }
    return path.slice(1);
  }
  SSVSET.pathfind = pathfind;

  /* ------------------------------------------------------------------ *
   * 2. Self-test — run with `node scripts/settle-render.js --selftest`
   * ------------------------------------------------------------------ */

  function selftest() {
    const fails = [];
    const ok = (cond, msg) => { if (!cond) fails.push(msg); };

    // A plain sealed room with one door, one window, a counter, a light, spawn and exit.
    const geo = deriveGeometry({
      gridSize: 100,
      plan: [
        "#####+####",
        "#........#",
        "#..==....#",
        "#..=1....#",
        "#.....a..#",
        "#...S....#",
        "#####X####",
      ],
    });

    ok(geo.cols === 10 && geo.rows === 7, `grid should be 10x7, got ${geo.cols}x${geo.rows}`);
    ok(geo.width === 1000 && geo.height === 700, "pixel size should follow gridSize");

    const doors = geo.walls.filter((w) => w.door === DOOR_DOOR);
    ok(doors.length === 1, `expected exactly 1 door leaf, got ${doors.length}`);
    ok(doors[0] && doors[0].c[1] === doors[0].c[3], "a door in a horizontal wall run should be a horizontal leaf");
    ok(doors[0] && doors[0].c[0] === 500 && doors[0].c[2] === 600, "door leaf should span its own cell");

    // The jambs either side of the doorway must exist, or players walk through the frame.
    const vertAt500 = geo.walls.filter((w) => w.c[0] === 500 && w.c[2] === 500);
    const vertAt600 = geo.walls.filter((w) => w.c[0] === 600 && w.c[2] === 600);
    ok(vertAt500.length > 0 && vertAt600.length > 0, "doorway jambs are missing");

    ok(geo.spawns.length === 1 && geo.spawns[0].x === 450 && geo.spawns[0].y === 550, "spawn should sit at the centre of its cell");
    ok(geo.exits.length === 1 && geo.exits[0].w === 100, "exit rect should cover the single X cell");
    ok(geo.posts["1"] && geo.posts["1"].col === 4, "NPC post 1 should be found");
    ok(geo.waypoints.length === 1 && geo.waypoints[0].tag === "a", "waypoint a should be found");
    ok(geo.lights.length === 0, "this plan has no lights");

    const counters = geo.walls.filter((w) => w.sight === SENSE_NONE && w.move === SENSE_NORMAL);
    ok(counters.length > 0, "counter should emit sight-passing walls");

    // Collinear merging: the top wall run is broken only by the door, so the northern
    // face should be two runs (cols 0-5 and 6-10), not ten unit segments.
    const north = geo.walls.filter((w) => w.c[1] === 0 && w.c[3] === 0 && w.door === DOOR_NONE);
    ok(north.length === 2, `north face should merge to 2 runs, got ${north.length}`);

    // Reachability: spawn must reach the exit, the door and every waypoint.
    const reach = floodFill(geo.passable, geo.spawns[0]);
    ok(reach.has("6,5"), "spawn cannot reach the exit cell");
    ok(reach.has("0,5"), "spawn cannot reach the doorway");
    for (const w of geo.waypoints) ok(reach.has(`${w.row},${w.col}`), `waypoint ${w.tag} is walled off`);
    for (const p of Object.values(geo.posts)) ok(reach.has(`${p.row},${p.col}`), "an NPC post is walled off");

    // No duplicate wall segments anywhere.
    const seen = new Set();
    for (const w of geo.walls) {
      const k = w.c.join(",");
      ok(!seen.has(k), `duplicate wall segment at ${k}`);
      seen.add(k);
    }

    // A door in a vertical wall run should produce a vertical leaf.
    const vgeo = deriveGeometry({ gridSize: 100, plan: ["####", "#..#", "+..#", "#..#", "####"] });
    const vdoor = vgeo.walls.filter((w) => w.door === DOOR_DOOR)[0];
    ok(vdoor && vdoor.c[0] === vdoor.c[2], "a door in a vertical wall run should be a vertical leaf");

    // A locked door carries the locked door state.
    const lgeo = deriveGeometry({ gridSize: 100, plan: ["##/##", "#...#", "#####"] });
    ok(lgeo.walls.some((w) => w.ds === DS_LOCKED), "locked door should set ds=2");

    // Windows pass sight but block movement.
    const wgeo = deriveGeometry({ gridSize: 100, plan: ["##'##", "#...#", "#####"] });
    ok(wgeo.walls.some((w) => w.move === SENSE_NORMAL && w.sight === SENSE_NONE), "window should pass sight");

    // Pathfinding round-trips.
    const path = pathfind(geo.passable, geo.spawns[0], { row: 1, col: 8 });
    ok(path.length > 0, "pathfinder failed on an open room");
    const blocked = pathfind(deriveGeometry({ gridSize: 100, plan: ["###", "#.#", "###", "#.#", "###"] }).passable, { row: 1, col: 1 }, { row: 3, col: 1 });
    ok(blocked.length === 0, "pathfinder should refuse to cross a solid wall");

    return fails;
  }
  SSVSET.selftest = selftest;

  /* ------------------------------------------------------------------ *
   * 3. Styles
   * ------------------------------------------------------------------ */

  const STYLE_ID = "ssvset-styles";
  const CSS = `
.sgset{--bg:#04080f;--panel:rgba(12,28,42,.62);--panel2:rgba(8,20,31,.86);--edge:#12455a;
  --edge2:#1d6a86;--teal:#38e1c4;--amber:#f2b03d;--red:#e0454d;--ink:#cfeef0;--muted:#6f97a6;
  --warm:#ffb066;
  position:fixed;inset:0;z-index:70;display:flex;color:var(--ink);
  font-family:'Courier New',monospace;background:var(--bg);}
.sgset *{box-sizing:border-box;}
/* Foundry's own button and typography rules leak in, and inline spans inside a flex button
   collapse on top of one another. Everything below is a defence against that. */
.sgset button{font-family:inherit;color:inherit;cursor:pointer;background:none;border:none;
  margin:0;line-height:1.35;text-align:left;white-space:normal;text-shadow:none;
  box-shadow:none;border-radius:0;height:auto;min-height:0;width:auto;}
.sgset button:hover,.sgset button:focus{box-shadow:none;outline:none;}
.sgset .sgset-loc .body,.sgset .sgset-loc .blurb,
.sgset .sgset-loc .sgset-tags,.sgset .sgset-loc .sgset-who{display:block;}
.sgset .sgset-loc .glyph{display:flex;}

/* ---- stage (the settlement artwork) ---- */
.sgset-stage{position:relative;flex:1 1 auto;overflow:hidden;display:flex;
  align-items:center;justify-content:center;
  background:radial-gradient(circle at 50% 45%,#0a1a26 0,#020509 75%);}
/* The artwork sizes the frame and the frame shrink-wraps it, so a hotspot authored at
   0.41/0.62 sits on the same building no matter how the window is shaped. Letterboxing
   is deliberate: with object-fit:cover the edges of the settlement would be cropped away
   at some window shapes and the hotspots would drift off their buildings. */
.sgset-frame{position:relative;display:block;line-height:0;max-width:100%;max-height:100%;}
.sgset-art{display:block;width:auto;height:auto;max-width:100%;max-height:100%;
  transition:filter .6s ease, opacity .6s ease;}
.sgset-art.is-dusk{filter:saturate(.9) brightness(.78) hue-rotate(-8deg);}
.sgset-art.is-night{filter:saturate(.72) brightness(.5) hue-rotate(200deg) contrast(1.1);}
.sgset-art.is-dawn{filter:saturate(.95) brightness(.86) hue-rotate(12deg);}
.sgset-frame::after{content:"";position:absolute;inset:0;pointer-events:none;
  box-shadow:0 0 90px 30px rgba(2,5,9,.9) inset;}
.sgset-scrim{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(120% 90% at 50% 40%,transparent 35%,rgba(2,6,12,.78) 100%),
             linear-gradient(to bottom,rgba(2,6,12,.72) 0,transparent 22%);}
.sgset-noart{position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center;
  color:var(--muted);letter-spacing:.28em;text-transform:uppercase;font-size:12px;
  background:radial-gradient(circle at 50% 45%,#0b2434 0,#04080f 70%);}

/* ---- header strip ---- */
.sgset-head{position:absolute;top:0;left:0;right:0;z-index:3;padding:14px 18px;display:flex;
  align-items:flex-start;gap:16px;}
.sgset-title{font-size:24px;letter-spacing:.18em;text-transform:uppercase;
  text-shadow:0 0 14px rgba(56,225,196,.45);margin:0;}
.sgset-sub{font-size:11px;color:var(--muted);letter-spacing:.16em;text-transform:uppercase;
  margin-top:4px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;}
.sgset-head .sgset-spacer{flex:1 1 auto;}
.sgset-chip{border:1px solid var(--edge);background:var(--panel);border-radius:8px;
  padding:4px 9px;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink);}
.sgset-chip.good{border-color:#1f7a5e;color:var(--teal);}
.sgset-chip.bad{border-color:#7a2731;color:var(--red);}
.sgset-iconbtn{border:1px solid var(--edge);background:var(--panel);border-radius:8px;
  padding:6px 11px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;
  transition:border-color .15s,box-shadow .15s,color .15s;}
.sgset-iconbtn:hover{border-color:var(--edge2);color:var(--teal);box-shadow:0 0 12px rgba(56,225,196,.22);}

/* ---- hotspots ---- */
.sgset-hot{position:absolute;transform:translate(-50%,-50%);display:flex;flex-direction:column;
  align-items:center;gap:6px;padding:0;}
.sgset-hot .ring{position:relative;width:34px;height:34px;border-radius:50%;
  border:1px solid var(--edge2);background:rgba(6,20,30,.72);display:flex;align-items:center;
  justify-content:center;font-size:15px;color:var(--teal);
  box-shadow:0 0 0 0 rgba(56,225,196,.5);transition:transform .18s,box-shadow .18s,border-color .18s;}
.sgset-hot .ring::after{content:"";position:absolute;inset:-6px;border-radius:50%;
  border:1px solid rgba(56,225,196,.45);animation:sgset-pulse 2.6s ease-out infinite;}
@keyframes sgset-pulse{0%{transform:scale(.85);opacity:.75}70%{transform:scale(1.35);opacity:0}100%{opacity:0}}
.sgset-hot:hover .ring{transform:scale(1.18);border-color:var(--teal);
  box-shadow:0 0 18px rgba(56,225,196,.55);}
.sgset-hot .tag{font-size:10px;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;
  padding:3px 8px;border-radius:6px;background:rgba(3,10,16,.85);border:1px solid var(--edge);
  opacity:0;transform:translateY(-3px);transition:opacity .18s,transform .18s;}
.sgset-hot:hover .tag,.sgset-hot.is-active .tag{opacity:1;transform:translateY(0);}
.sgset-hot.is-locked .ring{border-color:#7a5a27;color:var(--amber);}
.sgset-hot.is-locked .ring::after{animation:none;border-color:rgba(242,176,61,.3);}
.sgset-hot.is-shut .ring{opacity:.45;}
.sgset-hot.is-gmonly .ring{border-style:dashed;color:var(--muted);}
.sgset-hot.is-gmonly .ring::after{animation:none;opacity:.2;}
.sgset-hot .here{position:absolute;top:-7px;right:-9px;min-width:16px;height:16px;padding:0 4px;
  border-radius:9px;background:var(--teal);color:#02141a;font-size:9px;font-weight:bold;
  display:flex;align-items:center;justify-content:center;box-shadow:0 0 10px rgba(56,225,196,.6);}

/* ---- side panel ---- */
.sgset-side{flex:0 0 372px;max-width:42vw;background:var(--panel2);border-left:1px solid var(--edge);
  display:flex;flex-direction:column;box-shadow:-18px 0 40px rgba(0,0,0,.55);}
.sgset-sidehead{padding:14px 16px 10px;border-bottom:1px solid var(--edge);}
.sgset-sidehead h3{margin:0 0 9px;font-size:12px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--muted);}
.sgset-search{width:100%;background:rgba(4,12,19,.9);border:1px solid var(--edge);border-radius:8px;
  padding:7px 10px;color:var(--ink);font-family:inherit;font-size:12px;}
.sgset-search:focus{outline:none;border-color:var(--edge2);box-shadow:0 0 10px rgba(56,225,196,.2);}
.sgset-list{flex:1 1 auto;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:7px;}
.sgset-loc{border:1px solid var(--edge);border-radius:10px;background:rgba(9,24,36,.72);
  padding:10px 11px;display:flex;gap:11px;align-items:flex-start;text-align:left;width:100%;
  transition:border-color .15s,background .15s,transform .12s;}
.sgset-loc:hover{border-color:var(--edge2);background:rgba(14,38,54,.82);transform:translateX(-2px);}
.sgset-loc.is-blocked{cursor:default;opacity:.62;}
.sgset-loc.is-blocked:hover{border-color:var(--edge);background:rgba(9,24,36,.72);transform:none;}
.sgset-loc .glyph{flex:0 0 30px;height:30px;border-radius:8px;border:1px solid var(--edge2);
  display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--teal);
  background:rgba(4,14,22,.8);}
.sgset-loc.is-blocked .glyph{color:var(--amber);border-color:#5c4520;}
.sgset-loc .body{flex:1 1 auto;min-width:0;display:block;}
.sgset-loc .name{font-size:13px;letter-spacing:.1em;text-transform:uppercase;
  display:flex;align-items:center;gap:7px;}
.sgset-loc .blurb{display:block;font-size:11px;color:var(--muted);line-height:1.45;margin-top:4px;}
.sgset-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;}
.sgset-tag,.sgset-pip{display:inline-block;}
.sgset-tag{font-size:9px;letter-spacing:.12em;text-transform:uppercase;padding:2px 6px;
  border-radius:5px;border:1px solid var(--edge);color:var(--muted);}
.sgset-tag.shop{border-color:#1f7a5e;color:var(--teal);}
.sgset-tag.quest{border-color:#7a5a27;color:var(--amber);}
.sgset-tag.shut{border-color:#3a4750;}
.sgset-tag.locked{border-color:#7a2731;color:var(--red);}
.sgset-tag.gm{border-color:#5b3a7a;color:#c69bec;}
.sgset-who{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px;}
.sgset-loc .name{display:flex;}
.sgset-pip{font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;
  border-radius:9px;background:rgba(56,225,196,.14);border:1px solid rgba(56,225,196,.4);
  color:var(--teal);}
.sgset-empty{color:var(--muted);font-size:11px;text-align:center;padding:24px 10px;
  letter-spacing:.14em;text-transform:uppercase;}
.sgset-sidefoot{border-top:1px solid var(--edge);padding:10px 14px;display:flex;gap:8px;
  align-items:center;flex-wrap:wrap;font-size:10px;color:var(--muted);letter-spacing:.12em;
  text-transform:uppercase;}

/* ---- GM cog panel ---- */
.sgset-gm{position:absolute;z-index:4;top:62px;right:14px;width:330px;max-height:calc(100% - 90px);
  overflow-y:auto;background:var(--panel2);border:1px solid #5b3a7a;border-radius:12px;
  padding:12px;box-shadow:0 18px 44px rgba(0,0,0,.6);}
.sgset-gm h4{margin:0 0 8px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;
  color:#c69bec;}
.sgset-gm .grp{border-top:1px solid var(--edge);margin-top:10px;padding-top:9px;}
.sgset-gm label{display:block;font-size:10px;color:var(--muted);letter-spacing:.14em;
  text-transform:uppercase;margin-bottom:5px;}
.sgset-gm select{width:100%;background:rgba(4,12,19,.9);border:1px solid var(--edge);
  border-radius:7px;padding:6px 8px;color:var(--ink);font-family:inherit;font-size:11px;}
.sgset-row{display:flex;gap:6px;flex-wrap:wrap;}
.sgset-mini{border:1px solid var(--edge);border-radius:7px;padding:4px 8px;font-size:10px;
  letter-spacing:.1em;text-transform:uppercase;background:rgba(6,18,28,.8);}
.sgset-mini:hover{border-color:var(--edge2);color:var(--teal);}
.sgset-mini.on{border-color:var(--teal);color:var(--teal);box-shadow:0 0 9px rgba(56,225,196,.25);}
.sgset-mini.warn:hover{border-color:var(--red);color:var(--red);}
.sgset-gmloc{border:1px solid var(--edge);border-radius:8px;padding:7px 8px;margin-bottom:6px;
  background:rgba(6,18,28,.6);}
.sgset-gmloc .nm{font-size:11px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px;}

/* ---- NPC card ---- */
.sgset-cardwrap{position:fixed;inset:0;z-index:72;display:flex;align-items:center;
  justify-content:center;background:rgba(2,5,10,.62);backdrop-filter:blur(3px);}
.sgset-card{width:min(560px,92vw);max-height:86vh;overflow-y:auto;background:var(--panel2);
  border:1px solid var(--edge2);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.7);
  color:var(--ink);font-family:'Courier New',monospace;}
.sgset-card .top{display:flex;gap:14px;padding:16px;border-bottom:1px solid var(--edge);}
.sgset-card .port{flex:0 0 96px;height:96px;border-radius:10px;border:1px solid var(--edge);
  object-fit:cover;background:#071620;}
.sgset-card .portfallback{flex:0 0 96px;height:96px;border-radius:10px;border:1px solid var(--edge);
  display:flex;align-items:center;justify-content:center;font-size:32px;color:var(--edge2);
  background:#071620;}
.sgset-card h3{margin:0;font-size:19px;letter-spacing:.14em;text-transform:uppercase;
  text-shadow:0 0 12px rgba(56,225,196,.35);}
.sgset-card .role{font-size:11px;color:var(--amber);letter-spacing:.16em;text-transform:uppercase;
  margin-top:4px;}
.sgset-card .blurb{font-size:12px;color:var(--muted);line-height:1.55;margin-top:8px;}
.sgset-card .sect{padding:12px 16px;border-bottom:1px solid var(--edge);}
.sgset-card .sect h5{margin:0 0 8px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--muted);}
.sgset-line{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;}
.sgset-line .txt{flex:1 1 auto;font-size:12px;line-height:1.5;}
.sgset-card .acts{padding:14px 16px;display:flex;gap:9px;flex-wrap:wrap;}
.sgset-btn{border:1px solid var(--edge2);border-radius:9px;padding:9px 16px;font-size:12px;
  letter-spacing:.14em;text-transform:uppercase;background:rgba(6,20,30,.85);
  transition:border-color .15s,box-shadow .15s,color .15s;}
.sgset-btn:hover{border-color:var(--teal);color:var(--teal);box-shadow:0 0 16px rgba(56,225,196,.3);}
.sgset-btn.primary{border-color:var(--teal);color:var(--teal);}
.sgset-btn.ghost{border-color:var(--edge);color:var(--muted);}

/* ---- leave button (shown while inside an interior) ---- */
#ssvset-leave{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:60;
  font-family:'Courier New',monospace;}
#ssvset-leave .sgset-btn{background:rgba(4,14,22,.92);box-shadow:0 8px 26px rgba(0,0,0,.5);}

@media (max-width:900px){.sgset{flex-direction:column;}.sgset-side{flex:0 0 46%;max-width:none;
  border-left:none;border-top:1px solid var(--edge);}}
`;

  function ensureStyles(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || d.getElementById(STYLE_ID)) return;
    const el = d.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    d.head.appendChild(el);
  }
  SSVSET.ensureStyles = ensureStyles;

  /* ------------------------------------------------------------------ *
   * 4. Presentation helpers
   * ------------------------------------------------------------------ */

  const KINDS = {
    cantina: { glyph: "☗", label: "Cantina" },
    shop: { glyph: "⚖", label: "Shop" },
    market: { glyph: "⚖", label: "Market" },
    salvage: { glyph: "⚙", label: "Salvage" },
    medbay: { glyph: "✚", label: "Medbay" },
    admin: { glyph: "▤", label: "Administration" },
    pad: { glyph: "▲", label: "Landing pad" },
    temple: { glyph: "◇", label: "Temple" },
    hab: { glyph: "⌂", label: "Habitat" },
    dock: { glyph: "⚓", label: "Dock" },
    gate: { glyph: "▥", label: "Gate" },
    ruin: { glyph: "☠", label: "Ruin" },
    den: { glyph: "●", label: "Den" },
    default: { glyph: "■", label: "Location" },
  };
  const kindOf = (k) => KINDS[k] || KINDS.default;
  SSVSET.KINDS = KINDS;

  const TIMES = ["dawn", "day", "dusk", "night"];
  SSVSET.TIMES = TIMES;
  const TIME_LABEL = { dawn: "Dawn", day: "Day", dusk: "Dusk", night: "Night" };

  /**
   * Fold the live world state over the authored content for one location, producing the
   * flags the UI actually renders from. Content is never mutated.
   */
  function annotate(loc, state, isGM) {
    const st = state || {};
    const discovered = st.discovered?.[loc.id] ?? loc.state !== "hidden";
    const locked = st.locked?.[loc.id] ?? loc.state === "locked";
    const hours = Array.isArray(loc.openHours) && loc.openHours.length ? loc.openHours : null;
    const shut = !!(hours && !hours.includes(st.timeOfDay || "day"));
    const here = Object.entries(st.whereIs || {})
      .filter(([, v]) => v === loc.id)
      .map(([k]) => k);
    return {
      ...loc,
      discovered,
      locked,
      shut,
      here,
      // Players only see discovered locations; the GM sees everything, flagged as such.
      visible: discovered || isGM,
      gmOnly: !discovered && isGM,
      enterable: discovered && !locked && !shut,
      hasShop: (loc.npcs || []).some((n) => n.shopId),
      hasQuest: !!loc.quest || (loc.npcs || []).some((n) => n.quest),
    };
  }
  SSVSET.annotate = annotate;

  function blockReason(a) {
    if (a.locked) return a.lockedReason || "Locked";
    if (a.shut) return `Closed until ${(a.openHours || []).map((h) => TIME_LABEL[h] || h).join(" / ")}`;
    if (!a.discovered) return "Undiscovered";
    return "";
  }

  const userLabel = (ctx, id) => {
    const u = (ctx.users || []).find((x) => x.id === id);
    return u ? u.charName || u.name : "Someone";
  };

  /* ------------------------------------------------------------------ *
   * 5. The settlement hub
   * ------------------------------------------------------------------ */

  const uiState = { filter: "", gmPanel: false, activeLoc: null };
  SSVSET.resetUiState = () => {
    uiState.filter = "";
    uiState.gmPanel = false;
    uiState.activeLoc = null;
  };

  function renderCity(root, ctx) {
    ensureStyles(root.ownerDocument);
    const city = ctx.city;
    if (!city) {
      root.innerHTML = `<div class="sgset"><div class="sgset-noart">No settlement selected</div></div>`;
      return;
    }
    const state = ctx.state || {};
    const tod = state.timeOfDay || "day";
    const locs = (city.locations || []).map((l) => annotate(l, state, ctx.isGM)).filter((l) => l.visible);
    const q = uiState.filter.trim().toLowerCase();
    const shown = q
      ? locs.filter((l) => `${l.name} ${l.blurb || ""} ${kindOf(l.kind).label}`.toLowerCase().includes(q))
      : locs;

    const art = city.art?.[tod] || city.art?.[tod === "night" || tod === "dusk" ? "night" : "day"] || city.art?.day || city.art?.night;
    const standing = ctx.standing;

    root.innerHTML = `
<div class="sgset">
  <div class="sgset-stage">
    ${art ? `
    <div class="sgset-frame">
      <img class="sgset-art is-${esc(tod)}" src="${esc(ctx.assetPath ? ctx.assetPath(art) : art)}" alt="">
      <div class="sgset-scrim"></div>
      ${shown.map((l) => hotspotHtml(l, ctx)).join("")}
    </div>` : `
    <div class="sgset-frame" style="width:100%;height:100%">
      <div class="sgset-noart">${esc(city.name)} — no artwork yet</div>
      ${shown.map((l) => hotspotHtml(l, ctx)).join("")}
    </div>`}
    <div class="sgset-head">
      <div>
        <h2 class="sgset-title">${esc(city.name)}</h2>
        <div class="sgset-sub">
          <span>${esc(city.region || "Unknown region")}</span>
          <span class="sgset-chip">${esc(TIME_LABEL[tod] || tod)}</span>
          ${city.law != null ? `<span class="sgset-chip">Law ${esc(city.law)}</span>` : ""}
          ${standing
            ? `<span class="sgset-chip ${standing.value >= 0 ? "good" : "bad"}">${esc(standing.faction)} ${standing.value >= 0 ? "+" : ""}${esc(standing.value)}</span>`
            : ""}
        </div>
      </div>
      <div class="sgset-spacer"></div>
      ${ctx.isGM ? `<button class="sgset-iconbtn" data-act="gm">⚙ GM</button>` : ""}
      <button class="sgset-iconbtn" data-act="close">Close</button>
    </div>
    ${ctx.isGM && uiState.gmPanel ? gmPanelHtml(locs, ctx) : ""}
  </div>
  <aside class="sgset-side">
    <div class="sgset-sidehead">
      <h3>Interesting places — ${shown.length}</h3>
      <input class="sgset-search" data-act="filter" placeholder="Search this settlement…"
             value="${esc(uiState.filter)}">
    </div>
    <div class="sgset-list">
      ${shown.length ? shown.map((l) => locRowHtml(l, ctx)).join("") : `<div class="sgset-empty">Nothing here matches</div>`}
    </div>
    <div class="sgset-sidefoot">
      ${partyFootHtml(locs, ctx)}
    </div>
  </aside>
</div>`;

    wireCity(root, ctx, shown);
  }
  SSVSET.renderCity = renderCity;

  function hotspotHtml(l, ctx) {
    if (!l.hotspot) return "";
    const k = kindOf(l.kind);
    const cls = [
      "sgset-hot",
      l.locked ? "is-locked" : "",
      l.shut ? "is-shut" : "",
      l.gmOnly ? "is-gmonly" : "",
      uiState.activeLoc === l.id ? "is-active" : "",
    ].filter(Boolean).join(" ");
    const reason = blockReason(l);
    return `
<button class="${cls}" data-act="hot" data-loc="${esc(l.id)}"
        style="left:${clamp(l.hotspot.x * 100, 0, 100)}%;top:${clamp(l.hotspot.y * 100, 0, 100)}%"
        title="${esc(l.name)}${reason ? " — " + esc(reason) : ""}">
  <span class="ring">${k.glyph}${l.here.length ? `<span class="here">${l.here.length}</span>` : ""}</span>
  <span class="tag">${esc(l.name)}${reason ? ` · ${esc(reason)}` : ""}</span>
</button>`;
  }

  function locRowHtml(l, ctx) {
    const k = kindOf(l.kind);
    const reason = blockReason(l);
    const tags = [];
    if (l.hasShop) tags.push(`<span class="sgset-tag shop">Trade</span>`);
    if (l.hasQuest) tags.push(`<span class="sgset-tag quest">Business here</span>`);
    if (l.shut) tags.push(`<span class="sgset-tag shut">${esc(reason)}</span>`);
    if (l.locked) tags.push(`<span class="sgset-tag locked">${esc(reason)}</span>`);
    if (l.gmOnly) tags.push(`<span class="sgset-tag gm">Hidden from players</span>`);
    return `
<button class="sgset-loc ${l.enterable ? "" : "is-blocked"}" data-act="enter" data-loc="${esc(l.id)}">
  <span class="glyph">${k.glyph}</span>
  <span class="body">
    <span class="name">${esc(l.name)}</span>
    ${l.blurb ? `<span class="blurb">${esc(l.blurb)}</span>` : ""}
    ${tags.length ? `<span class="sgset-tags">${tags.join("")}</span>` : ""}
    ${l.here.length ? `<span class="sgset-who">${l.here.map((u) => `<span class="sgset-pip">${esc(userLabel(ctx, u))}</span>`).join("")}</span>` : ""}
  </span>
</button>`;
  }

  function partyFootHtml(locs, ctx) {
    const inside = Object.entries(ctx.state?.whereIs || {});
    if (!inside.length) return `<span>The whole party is out in the open</span>`;
    const byLoc = new Map();
    for (const [uid, lid] of inside) {
      if (!byLoc.has(lid)) byLoc.set(lid, []);
      byLoc.get(lid).push(uid);
    }
    return [...byLoc.entries()].map(([lid, users]) => {
      const l = locs.find((x) => x.id === lid);
      return `<span class="sgset-chip">${esc(l?.name || lid)}: ${users.map((u) => esc(userLabel(ctx, u))).join(", ")}</span>`;
    }).join("");
  }

  function gmPanelHtml(locs, ctx) {
    const state = ctx.state || {};
    const inside = Object.entries(state.whereIs || {});
    return `
<div class="sgset-gm">
  <h4>GM controls</h4>
  <label>Current settlement</label>
  <select data-act="setcity">
    ${(ctx.cities || []).map((c) => `<option value="${esc(c.id)}" ${c.id === ctx.city.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
  </select>
  <div class="grp">
    <label>Time of day</label>
    <div class="sgset-row">
      ${TIMES.map((t) => `<button class="sgset-mini ${(state.timeOfDay || "day") === t ? "on" : ""}" data-act="time" data-t="${t}">${esc(TIME_LABEL[t])}</button>`).join("")}
    </div>
  </div>
  <div class="grp">
    <label>Locations</label>
    ${locs.map((l) => `
      <div class="sgset-gmloc">
        <div class="nm">${esc(l.name)}</div>
        <div class="sgset-row">
          <button class="sgset-mini ${l.discovered ? "on" : ""}" data-act="reveal" data-loc="${esc(l.id)}">${l.discovered ? "Revealed" : "Hidden"}</button>
          <button class="sgset-mini ${l.locked ? "on" : ""}" data-act="lock" data-loc="${esc(l.id)}">${l.locked ? "Locked" : "Unlocked"}</button>
          <button class="sgset-mini ${state.leaveLocked?.[l.id] ? "on" : ""}" data-act="leavelock" data-loc="${esc(l.id)}">${state.leaveLocked?.[l.id] ? "No exit" : "Exit open"}</button>
          <button class="sgset-mini warn" data-act="rebuild" data-loc="${esc(l.id)}">Rebuild</button>
        </div>
      </div>`).join("")}
  </div>
  ${inside.length ? `
  <div class="grp">
    <label>Recall to the hub</label>
    <div class="sgset-row">
      ${inside.map(([uid]) => `<button class="sgset-mini" data-act="recall" data-user="${esc(uid)}">${esc(userLabel(ctx, uid))}</button>`).join("")}
    </div>
  </div>` : ""}
  <div class="grp">
    <div class="sgset-row">
      <button class="sgset-mini warn" data-act="rebuildall">Rebuild every scene</button>
      <button class="sgset-mini" data-act="syncshops">Sync shop hours</button>
    </div>
  </div>
</div>`;
  }

  function wireCity(root, ctx, shown) {
    const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));

    const frame = root.querySelector(".sgset-frame");
    const img = root.querySelector(".sgset-art");
    if (frame && img) {
      if (!img.complete) img.addEventListener("load", () => frame.classList.add("is-loaded"), { once: true });
      else frame.classList.add("is-loaded");
    }
    const locOf = (el) => shown.find((l) => l.id === el.dataset.loc);

    on('[data-act="close"]', "click", () => ctx.close());
    on('[data-act="gm"]', "click", () => { uiState.gmPanel = !uiState.gmPanel; ctx.refresh(); });

    const search = root.querySelector('[data-act="filter"]');
    if (search) {
      search.addEventListener("input", (e) => {
        uiState.filter = e.target.value;
        const pos = e.target.selectionStart;
        ctx.refresh();
        const again = root.querySelector('[data-act="filter"]');
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      });
    }

    const tryEnter = (el) => {
      const l = locOf(el);
      if (!l) return;
      if (!l.enterable) {
        if (!ctx.isGM) return ctx.notify(`${l.name} — ${blockReason(l)}`);
        return ctx.confirm(`${l.name} is ${blockReason(l).toLowerCase()}. Go in anyway?`).then((yes) => yes && ctx.enter(l.id));
      }
      ctx.enter(l.id);
    };
    on('[data-act="enter"]', "click", (e) => tryEnter(e.currentTarget));
    on('[data-act="hot"]', "click", (e) => tryEnter(e.currentTarget));
    on('[data-act="hot"]', "mouseenter", (e) => { uiState.activeLoc = e.currentTarget.dataset.loc; });

    on('[data-act="time"]', "click", (e) => ctx.setTimeOfDay(e.currentTarget.dataset.t));
    on('[data-act="setcity"]', "change", (e) => ctx.setCity(e.currentTarget.value));
    on('[data-act="reveal"]', "click", (e) => { const l = locOf(e.currentTarget); ctx.reveal(l.id, !l.discovered); });
    on('[data-act="lock"]', "click", (e) => { const l = locOf(e.currentTarget); ctx.setLocked(l.id, !l.locked); });
    on('[data-act="leavelock"]', "click", (e) => {
      const l = locOf(e.currentTarget);
      ctx.setLeaveLock(l.id, !(ctx.state?.leaveLocked?.[l.id]));
    });
    on('[data-act="rebuild"]', "click", (e) => ctx.rebuild(e.currentTarget.dataset.loc));
    on('[data-act="rebuildall"]', "click", () => ctx.rebuildAll());
    on('[data-act="syncshops"]', "click", () => ctx.syncShopHours());
    on('[data-act="recall"]', "click", (e) => ctx.recall(e.currentTarget.dataset.user));
  }

  /* ------------------------------------------------------------------ *
   * 6. NPC card
   * ------------------------------------------------------------------ */

  function renderNpcCard(root, ctx, npc, loc) {
    ensureStyles(root.ownerDocument);
    const src = npc.portrait ? (ctx.assetPath ? ctx.assetPath(npc.portrait) : npc.portrait) : null;
    const points = ctx.isGM ? npc.talkingPoints || [] : [];
    const rumours = ctx.isGM ? npc.rumours || [] : [];

    root.innerHTML = `
<div class="sgset-cardwrap" data-act="scrim">
  <div class="sgset-card">
    <div class="top">
      ${src ? `<img class="port" src="${esc(src)}" alt="">` : `<div class="portfallback">${kindOf(loc?.kind).glyph}</div>`}
      <div>
        <h3>${esc(npc.name || "Someone")}</h3>
        ${npc.role ? `<div class="role">${esc(npc.role)}${loc ? ` · ${esc(loc.name)}` : ""}</div>` : ""}
        ${npc.blurb ? `<div class="blurb">${esc(npc.blurb)}</div>` : ""}
      </div>
    </div>
    ${points.length ? `
    <div class="sect">
      <h5>Talking points — GM only</h5>
      ${points.map((t, i) => `
        <div class="sgset-line">
          <button class="sgset-mini" data-act="say" data-i="${i}" data-kind="point">Say</button>
          <span class="txt">${esc(t)}</span>
        </div>`).join("")}
    </div>` : ""}
    ${rumours.length ? `
    <div class="sect">
      <h5>Rumours — GM only</h5>
      ${rumours.map((t, i) => `
        <div class="sgset-line">
          <button class="sgset-mini" data-act="say" data-i="${i}" data-kind="rumour">Say</button>
          <span class="txt">${esc(t)}</span>
        </div>`).join("")}
      <div class="sgset-row" style="margin-top:8px">
        <button class="sgset-mini" data-act="say" data-i="-1" data-kind="rumour">Random rumour</button>
      </div>
    </div>` : ""}
    <div class="acts">
      ${npc.shopId
        ? (ctx.hasShopModule
            ? `<button class="sgset-btn primary" data-act="shop">Browse wares</button>`
            : `<button class="sgset-btn ghost" disabled>Trade unavailable — shop module off</button>`)
        : ""}
      ${npc.actor && ctx.isGM ? `<button class="sgset-btn" data-act="sheet">Open sheet</button>` : ""}
      <div style="flex:1 1 auto"></div>
      <button class="sgset-btn ghost" data-act="close">Done</button>
    </div>
  </div>
</div>`;

    root.querySelector('[data-act="close"]')?.addEventListener("click", () => ctx.closeCard());
    root.querySelector('[data-act="scrim"]')?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) ctx.closeCard();
    });
    root.querySelector('[data-act="shop"]')?.addEventListener("click", () => ctx.openShop(npc.shopId, npc));
    root.querySelector('[data-act="sheet"]')?.addEventListener("click", () => ctx.openSheet(npc));
    root.querySelectorAll('[data-act="say"]').forEach((el) =>
      el.addEventListener("click", () => {
        const list = el.dataset.kind === "rumour" ? npc.rumours || [] : npc.talkingPoints || [];
        const i = Number(el.dataset.i);
        const line = i < 0 ? list[Math.floor(Math.random() * list.length)] : list[i];
        if (line) ctx.say(npc, line);
      })
    );
  }
  SSVSET.renderNpcCard = renderNpcCard;

  /* ------------------------------------------------------------------ *
   * 7. Leave button
   * ------------------------------------------------------------------ */

  function renderLeave(root, ctx, info) {
    ensureStyles(root.ownerDocument);
    if (!info || !info.show) { root.innerHTML = ""; return; }
    root.innerHTML = `<button class="sgset-btn" data-act="leave">↰ Back out to ${esc(info.cityName)}</button>`;
    root.querySelector('[data-act="leave"]').addEventListener("click", () => ctx.leave());
  }
  SSVSET.renderLeave = renderLeave;



  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  if (typeof globalThis !== "undefined") globalThis.SSVSET = SSVSET;
  if (typeof module !== "undefined" && module.exports) module.exports = SSVSET;

  if (typeof process !== "undefined" && process.argv && process.argv.includes("--selftest")) {
    const fails = selftest();
    if (fails.length) {
      console.error("SELFTEST FAILED:");
      for (const f of fails) console.error("  ✗ " + f);
      process.exit(1);
    }
    console.log("geometry selftest: all assertions passed");
  }
})();
