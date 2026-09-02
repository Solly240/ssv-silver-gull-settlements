/**
 * Watabou "One Page Dungeon" JSON  →  exact dungeon geometry.
 *
 * PURE. No `game.`, `ui.`, `Hooks.` or `canvas.` — same rule as settle-render.js, so the
 * preview page can run this in a bare browser and the node tests can require it.
 *
 * The whole point of this file: Watabou hands us the floor as a list of grid rectangles and
 * the doors as grid positions. That means walls are *derived*, never detected — the boundary
 * of the floor region is the wall, closed by construction. None of the ink-threshold,
 * `--strength`-sweeping misery in analyze_map.py applies to a dungeon.
 *
 * Coordinates in: whole grid cells, and freely negative (Watabou centres on the entrance).
 * Coordinates out: pixels, origin at top-left, with a one-cell margin all round.
 */
(function (root) {
  const SSVDUN = (root.SSVDUN = root.SSVDUN || {});

  /**
   * Watabou door `type` codes.
   *
   * "open" is a gap with nothing in it — we must NOT emit a wall or a door there, or the
   * passage is sealed. "entrance"/"exit" are staircases, not barriers: they become spawn
   * and exit markers, which is where the party lands and where they can leave.
   */
  const DOOR_TYPES = {
    0: "open",        // connection — never blocks
    1: "door",        // ordinary door
    2: "open",        // archway
    3: "entrance",    // stairs in — the way the party arrives
    4: "portcullis",  // impassable, but you can see through it
    5: "locked",      // locked door
    6: "secret",      // secret door
    7: "barred",      // impassable and solid
    8: "exit",        // staircase out of the dungeon
    9: "door",        // steps — a door with a change of level
  };
  SSVDUN.DOOR_TYPES = DOOR_TYPES;

  const key = (x, y) => `${x},${y}`;

  /** Every floor cell named by the rect list. */
  function floorCells(rects) {
    const cells = new Set();
    for (const r of rects || []) {
      for (let dy = 0; dy < r.h; dy++) {
        for (let dx = 0; dx < r.w; dx++) cells.add(key(r.x + dx, r.y + dy));
      }
    }
    return cells;
  }

  /**
   * Merge contiguous colinear unit edges into single runs.
   *
   * Purely a document-count optimisation: a 40x30 dungeon emits ~900 unit segments and
   * about 120 merged ones, and Foundry walks every wall for each vision test.
   */
  function mergeRuns(edges) {
    const byLine = new Map();
    for (const [line, from] of edges) {
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(from);
    }
    const out = [];
    for (const [line, list] of byLine) {
      list.sort((a, b) => a - b);
      let start = list[0];
      let prev = list[0];
      for (let i = 1; i <= list.length; i++) {
        const v = list[i];
        if (v === prev + 1) { prev = v; continue; }
        out.push([line, start, prev + 1]);
        start = v;
        prev = v;
      }
    }
    return out;
  }

  /**
   * Convert a parsed Watabou JSON into pixel-space geometry.
   *
   * @param {object} raw    the JSON as exported by the generator (J in the app)
   * @param {object} [opts] { gridSize = 64, margin = 1 }
   */
  function convert(raw, opts = {}) {
    if (!raw || !Array.isArray(raw.rects)) throw new Error("not a Watabou dungeon export");
    const g = opts.gridSize || 64;
    const margin = opts.margin == null ? 1 : opts.margin;

    const cells = floorCells(raw.rects);
    if (!cells.size) throw new Error("dungeon has no floor");

    // ---- bounds and the offset that puts everything in positive pixel space ----
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const k of cells) {
      const [x, y] = k.split(",").map(Number);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const offX = margin - minX;
    const offY = margin - minY;
    const cols = maxX - minX + 1 + margin * 2;
    const rows = maxY - minY + 1 + margin * 2;
    const px = (cx) => (cx + offX) * g;
    const py = (cy) => (cy + offY) * g;

    // ---- doors, indexed by the cell they sit in ----
    const doorAt = new Map();
    const entrances = [];
    const exits = [];
    for (const d of raw.doors || []) {
      const kind = DOOR_TYPES[d.type] ?? "door";
      const at = { ...d, kind };
      if (kind === "entrance") { entrances.push(at); continue; }
      if (kind === "exit") { exits.push(at); continue; }
      if (kind === "open") continue;                   // a gap: nothing to place
      doorAt.set(key(d.x, d.y), at);
    }

    // ---- walls: every floor edge whose neighbour is not floor ----
    const vert = [];   // [x, y]  — a vertical unit edge at grid-x, spanning y..y+1
    const horz = [];   // [y, x]  — a horizontal unit edge at grid-y, spanning x..x+1
    // Unit edges kept unmerged, each with the normal pointing away from the floor. The art
    // needs these to hatch outward from a wall; the merged runs above have lost the side.
    const edges = [];
    for (const k of cells) {
      const [x, y] = k.split(",").map(Number);
      if (!cells.has(key(x - 1, y))) { vert.push([x, y]); edges.push(edge(px(x), py(y), px(x), py(y + 1), -1, 0)); }
      if (!cells.has(key(x + 1, y))) { vert.push([x + 1, y]); edges.push(edge(px(x + 1), py(y), px(x + 1), py(y + 1), 1, 0)); }
      if (!cells.has(key(x, y - 1))) { horz.push([y, x]); edges.push(edge(px(x), py(y), px(x + 1), py(y), 0, -1)); }
      if (!cells.has(key(x, y + 1))) { horz.push([y + 1, x]); edges.push(edge(px(x), py(y + 1), px(x + 1), py(y + 1), 0, 1)); }
    }

    const walls = [];
    for (const [x, y0, y1] of mergeRuns(vert)) walls.push([px(x), py(y0), px(x), py(y1)]);
    for (const [y, x0, x1] of mergeRuns(horz)) walls.push([px(x0), py(y), px(x1), py(y)]);

    // ---- door segments, across the middle of their own cell ----
    // The door cell is itself floor (Watabou carves a 1x1 rect for it), so no wall was
    // generated across the passage — the door is the only thing in the gap. It sits
    // perpendicular to the direction of travel.
    const doors = [];
    for (const d of doorAt.values()) {
      const horizontalTravel = d.dir && d.dir.x !== 0;
      const seg = horizontalTravel
        ? [px(d.x + 0.5), py(d.y), px(d.x + 0.5), py(d.y + 1)]
        : [px(d.x), py(d.y + 0.5), px(d.x + 1), py(d.y + 0.5)];
      doors.push({ kind: d.kind, seg, cell: { x: d.x, y: d.y } });
    }

    // ---- rooms vs corridors ----
    // A rect only a single cell wide is a passage, not a chamber. Counting those as rooms
    // inflates the room list several times over and would drop encounters in corridors.
    const rooms = [];
    const corridors = [];
    (raw.rects || []).forEach((r, i) => {
      if (r.w === 1 && r.h === 1 && doorAtAny(raw, r.x, r.y)) return;      // door cell
      if (r.w === 1 || r.h === 1) {
        corridors.push({ id: `c${i}`, cell: { ...r }, rect: { x: px(r.x), y: py(r.y), w: r.w * g, h: r.h * g } });
        return;
      }
      rooms.push({
        id: `r${i}`,
        cell: { x: r.x, y: r.y, w: r.w, h: r.h },
        rect: { x: px(r.x), y: py(r.y), w: r.w * g, h: r.h * g },
        centre: { x: px(r.x + r.w / 2), y: py(r.y + r.h / 2) },
        area: r.w * r.h,
        ending: !!r.ending,
        notes: [],
      });
    });

    // ---- notes attach to the room that contains them ----
    for (const n of raw.notes || []) {
      const p = n.pos || {};
      const room = rooms.find((r) =>
        p.x >= r.cell.x && p.x <= r.cell.x + r.cell.w &&
        p.y >= r.cell.y && p.y <= r.cell.y + r.cell.h);
      const note = { ref: n.ref, text: n.text, at: { x: px(p.x), y: py(p.y) } };
      if (room) room.notes.push(note);
      else if (rooms.length) nearestRoom(rooms, p).notes.push(note);     // fell in a corridor
    }

    return {
      title: raw.title || "Unnamed dungeon",
      story: raw.story || "",
      gridSize: g,
      width: cols * g,
      height: rows * g,
      cols,
      rows,
      offset: { x: offX, y: offY },
      cells,
      rooms,
      corridors,
      walls,
      edges,
      doors,
      spawns: entrances.map((d) => ({ x: px(d.x + 0.5), y: py(d.y + 0.5), dir: d.dir, cell: { x: d.x, y: d.y } })),
      exits: exits.map((d) => ({ x: px(d.x + 0.5), y: py(d.y + 0.5), dir: d.dir, cell: { x: d.x, y: d.y } })),
      columns: (raw.columns || []).map((c) => ({ x: px(c.x + 0.5), y: py(c.y + 0.5) })),
      water: (raw.water || []).map((w) => ({ x: px(w.x), y: py(w.y), w: (w.w || 1) * g, h: (w.h || 1) * g })),
    };
  }
  SSVDUN.convert = convert;

  /** Closest room by centre, for a note that did not land inside one. */
  function nearestRoom(rooms, p) {
    let best = rooms[0], bd = Infinity;
    for (const r of rooms) {
      const dx = (r.cell.x + r.cell.w / 2) - p.x;
      const dy = (r.cell.y + r.cell.h / 2) - p.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  const edge = (x0, y0, x1, y1, nx, ny) => ({ x0, y0, x1, y1, nx, ny });

  function doorAtAny(raw, x, y) {
    return (raw.doors || []).some((d) => d.x === x && d.y === y);
  }

  /**
   * Every floor cell reachable from the party's landing point.
   *
   * Doors are passable — a closed door is something a player opens. Only the walls stop the
   * flood, and since they are the boundary of the floor region this can only fail if the
   * generator produced a genuinely detached room. Same guarantee the settlement build makes.
   */
  function reachable(model, from) {
    const start = from || model.spawns[0]?.cell || firstCell(model.cells);
    if (!start) return new Set();
    const seen = new Set([key(start.x, start.y)]);
    const queue = [start];
    while (queue.length) {
      const c = queue.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = key(c.x + dx, c.y + dy);
        if (seen.has(k) || !model.cells.has(k)) continue;
        seen.add(k);
        queue.push({ x: c.x + dx, y: c.y + dy });
      }
    }
    return seen;
  }
  SSVDUN.reachable = reachable;

  function firstCell(cells) {
    for (const k of cells) {
      const [x, y] = k.split(",").map(Number);
      return { x, y };
    }
    return null;
  }

  /** Rooms with no cell reachable from the spawn — should always be empty. */
  function unreachableRooms(model) {
    const seen = reachable(model);
    return model.rooms.filter((r) => {
      for (let dy = 0; dy < r.cell.h; dy++) {
        for (let dx = 0; dx < r.cell.w; dx++) {
          if (seen.has(key(r.cell.x + dx, r.cell.y + dy))) return false;
        }
      }
      return true;
    });
  }
  SSVDUN.unreachableRooms = unreachableRooms;

  if (typeof module !== "undefined" && module.exports) module.exports = SSVDUN;
})(typeof globalThis !== "undefined" ? globalThis : this);
