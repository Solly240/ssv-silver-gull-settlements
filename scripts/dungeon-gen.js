/**
 * Site generator — produces the same shape of data the One Page Dungeon generator exports,
 * so dungeon-geom.js and dungeon-art.js consume it unchanged.
 *
 * PURE. No Foundry globals (see settle-render.js for the rule).
 *
 * Why ours and not Watabou's: his generator is not open source — only the minified Haxe
 * build is published — and what we actually needed was not his algorithm but our own
 * setting. A dungeon full of holy spellbooks and goblins is no use on Vorrn-7. Here the
 * layout is biased per site type (a dead ship is a spine with compartments off it; an ice
 * hollow is a chain of irregular chambers) and every note comes from campaign vocabulary.
 *
 * Output matches the Watabou schema exactly:
 *   { version, title, story, rects[], doors[], notes[], columns[], water[] }
 * so anything already written against that format keeps working, and a real Watabou export
 * can still be dropped in wherever we want one.
 */
(function (root) {
  const GEN = (root.SSVDUNGEN = root.SSVDUNGEN || {});

  /* ---------------------------------------------------------------- *
   * Seeded randomness — same seed, same site, forever.
   * ---------------------------------------------------------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hashSeed = (s) => {
    if (typeof s === "number") return s | 0;
    let h = 2166136261;
    for (const ch of String(s ?? "")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return h | 0;
  };

  /* ---------------------------------------------------------------- *
   * Site types — layout shape and the words that go with it.
   * ---------------------------------------------------------------- */
  const TYPES = {
    derelict: {
      label: "Derelict",
      room: [2, 5], corridor: [2, 6], straightness: 0.72, chambers: 1, loops: 2,
      doorMix: [1, 1, 1, 0, 0, 9, 5, 6],
      titles: [
        "the {ship}", "the wreck of the {ship}", "{ship}, adrift", "the hulk of the {ship}",
      ],
      ships: [
        "SSV Corradine", "Long Silence", "Kestrel's Due", "Concord Tender 44", "Ninth Ambit",
        "Harrowgate", "Vesper Nine", "Cold Comfort", "Adler's Promise", "Threshold's Wake",
      ],
      stories: [
        "Her transponder has been calling the same six seconds for eleven years.",
        "She went dark mid-fold and came out somewhere she was never meant to be.",
        "The Apostles boarded her first. Nothing that boarded her has left.",
        "A Concord survey ship, stripped to the frame by somebody patient.",
        "Her reactor is still warm. Nothing aboard should still be warm.",
      ],
      notes: [
        "A ration locker, forced open from the inside.",
        "Crew remains at a console, still strapped in. The screen loops one word.",
        "A cracked {fuel}, leaking slow. Anything with a flame here is a mistake.",
        "The bulkhead is scored with claw marks that stop halfway up the wall.",
        "A sealed med-pod, occupied. The occupant's readout is flat, and warm.",
        "Salvage worth taking: {loot}, still crated.",
        "A hand-scratched tally on the wall. It stops at forty-one.",
        "Gravity is wrong in this compartment. Dropped things fall sideways.",
        "An Apostle prayer-sigil burned into the deck plating.",
        "The ship's log, recoverable. The last entry is in no language ASTRA knows.",
      ],
    },
    station: {
      label: "Station",
      room: [3, 6], corridor: [1, 4], straightness: 0.5, chambers: 1, loops: 3,
      doorMix: [1, 1, 0, 0, 2, 5, 6, 4],
      titles: ["{name} Station", "{name} Depot", "the {name} Waystation"],
      ships: ["Sett Lower", "Vorrn Transit", "Ninth Ring", "Kell Anchorage", "Bonefield Annex", "Coldwater"],
      stories: [
        "A fuel crossroads that stopped answering its own beacon.",
        "The Frostwatch stopped patrolling this ring two seasons ago and will not say why.",
        "Nobody owns it. Several people are extremely interested in that.",
        "Someone is still running the air handlers. Nobody is running anything else.",
      ],
      notes: [
        "A trade terminal, still logged in to somebody's account.",
        "Cargo bay: {loot} on a pallet, manifest scratched out.",
        "A Frostwatch patrol seal, cut through from the far side.",
        "Bunks for twelve. Six are made. Six are not.",
        "A {fuel} bolted into a jury-rigged rack, humming.",
        "The window here looks out on something that was not in the nav scan.",
        "An Iron Directorate crate, unmarked, wrong stencils.",
        "Somebody has been living here. Recently. Alone.",
      ],
    },
    hollow: {
      label: "Ice hollow",
      room: [2, 5], corridor: [1, 5], straightness: 0.35, chambers: 2, loops: 1,
      doorMix: [0, 0, 0, 2, 2, 1, 6],
      titles: ["the {name} Hollow", "{name} Deep", "the hollows under {name}"],
      ships: ["Kettle", "Vorrn", "Greylight", "Sable", "the Bonefield", "Nine Winters"],
      stories: [
        "A colony carved into the body of a glacier, on no registry anywhere.",
        "Meltwater runs in channels down the middle of every hall.",
        "The ice here is forty metres thick and something is lit behind it.",
        "It was a mining cut once. It has not been a mining cut for a long time.",
      ],
      notes: [
        "Blue light through forty metres of ice. Shapes move behind it, or seem to.",
        "A meltwater channel, running warm. Warm is not normal here.",
        "A cache under the ice: {loot}.",
        "Bodies in the wall, perfectly preserved, standing upright.",
        "Cut marks — tools, not claws. Old, and not made by anything on the registry.",
        "A {fuel} abandoned mid-haul, frozen into the floor.",
        "The ceiling here groans on a slow cycle. Roughly every nine minutes.",
        "Satedan script scratched at head height. Ronon will want to see this.",
      ],
    },
    ancient: {
      label: "Ancient site",
      room: [3, 6], corridor: [2, 5], straightness: 0.85, chambers: 1, loops: 2,
      doorMix: [1, 0, 2, 6, 6, 5, 4],
      titles: ["the {name} Vault", "{name} Threshold", "the Gate-work at {name}"],
      ships: ["Erevos", "Keth Minor", "the Corrupted Ring", "Talvos", "Zero Ambit"],
      stories: [
        "The geometry is deliberate and it is not built for people.",
        "Ancient work. The UGC would execute the whole crew for standing here.",
        "The writing is older than ASTRA and she will not translate it.",
        "Every surface is one continuous instruction, and it is a command, not a description.",
      ],
      notes: [
        "A wall of Ancient script. It reads as an order, not a record.",
        "A dormant guardian alcove. The alcove is empty. It should not be.",
        "An {fuel} seated in a cradle built for it a very long time ago.",
        "The room is a perfect measure of something. Nothing here is approximate.",
        "A gate-ring fragment, cold, and humming below hearing.",
        "Kael and Gerthorlemue both stop at the threshold. Neither can say why.",
        "{loot}, arranged — not stored, arranged.",
        "The floor records footsteps and shows them back, out of order.",
      ],
    },
  };
  GEN.TYPES = TYPES;

  const LOOT = [
    "ferrocrystal billets", "verdite ingots", "a sealed Concord tool roll",
    "unmarked Directorate ordnance", "a crate of patch kits and filament",
    "salvaged hull plate", "a working nav core", "medical printer stock",
  ];
  const FUEL = [
    "promethium jug", "deuterium slug", "ceruleum fuel rod", "tritium canister",
    "cryo-slush tank", "reclaimed plasma drum", "verdite fuel brick", "hyperfold half-cell",
  ];

  const key = (x, y) => `${x},${y}`;
  const pick = (rng, a) => a[Math.floor(rng() * a.length) | 0];
  const between = (rng, [lo, hi]) => lo + Math.floor(rng() * (hi - lo + 1));

  /* ---------------------------------------------------------------- *
   * Generation
   * ---------------------------------------------------------------- */

  /**
   * @param {object} opts { seed, type = "derelict", rooms = 12, noteCount }
   * @returns Watabou-schema dungeon data
   */
  function generate(opts = {}) {
    const type = TYPES[opts.type] ? opts.type : "derelict";
    const T = TYPES[type];
    const seed = opts.seed == null ? 1 : opts.seed;
    const rng = mulberry32(hashSeed(seed));
    const target = opts.rooms || between(rng, [9, 15]);

    const occupied = new Set();
    const rects = [];
    const doors = [];
    const placed = [];                       // rooms only, in placement order

    const claim = (r) => {
      for (let dy = 0; dy < r.h; dy++) {
        for (let dx = 0; dx < r.w; dx++) occupied.add(key(r.x + dx, r.y + dy));
      }
      rects.push(r);
    };
    const cellsOf = (r) => {
      const out = [];
      for (let dy = 0; dy < r.h; dy++) for (let dx = 0; dx < r.w; dx++) out.push([r.x + dx, r.y + dy]);
      return out;
    };

    // First room at the origin.
    const first = { x: 0, y: 0, w: between(rng, T.room), h: between(rng, T.room) };
    claim(first);
    placed.push(first);

    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let lastDir = pick(rng, DIRS);

    let guard = target * 60;
    while (placed.length < target && guard-- > 0) {
      const from = placed[Math.floor(Math.pow(rng(), 0.6) * placed.length) | 0] || first;
      // A dead ship runs along a spine; a hollow wanders.
      const dir = rng() < T.straightness ? lastDir : pick(rng, DIRS);
      const [dxn, dyn] = dir;

      // A cell on the outward-facing side of the source room.
      const along = dxn !== 0 ? between(rng, [0, from.h - 1]) : between(rng, [0, from.w - 1]);
      const doorCell = dxn !== 0
        ? { x: dxn > 0 ? from.x + from.w : from.x - 1, y: from.y + along }
        : { x: from.x + along, y: dyn > 0 ? from.y + from.h : from.y - 1 };

      const runLen = between(rng, T.corridor);
      const corridor = [];
      for (let i = 1; i <= runLen; i++) corridor.push({ x: doorCell.x + dxn * i, y: doorCell.y + dyn * i });

      const rw = between(rng, T.room);
      const rh = between(rng, T.room);
      const head = corridor.length ? corridor[corridor.length - 1] : doorCell;
      const room = {
        x: dxn !== 0 ? (dxn > 0 ? head.x + 1 : head.x - rw) : head.x - Math.floor(rng() * rw),
        y: dyn !== 0 ? (dyn > 0 ? head.y + 1 : head.y - rh) : head.y - Math.floor(rng() * rh),
        w: rw, h: rh,
      };

      // Everything the proposal would occupy, and everything it would touch.
      const want = [[doorCell.x, doorCell.y], ...corridor.map((c) => [c.x, c.y]), ...cellsOf(room)];
      const parent = new Set(cellsOf(from).map(([x, y]) => key(x, y)));
      if (want.some(([x, y]) => occupied.has(key(x, y)))) continue;
      let touches = false;
      for (const [x, y] of want) {
        for (let hy = -1; hy <= 1 && !touches; hy++) {
          for (let hx = -1; hx <= 1; hx++) {
            const k = key(x + hx, y + hy);
            if (occupied.has(k) && !parent.has(k)) { touches = true; break; }
          }
        }
        if (touches) break;
      }
      if (touches) continue;

      claim({ x: doorCell.x, y: doorCell.y, w: 1, h: 1 });
      if (corridor.length) claim(runRect(doorCell, dxn, dyn, corridor.length));
      claim(room);
      placed.push(room);
      doors.push({ x: doorCell.x, y: doorCell.y, dir: { x: dxn, y: dyn }, type: pick(rng, T.doorMix) });
      lastDir = dir;

      // Some chambers are two overlapping rects, which stops an ice hollow reading as boxes.
      for (let c = 1; c < T.chambers; c++) {
        if (rng() > 0.5) continue;
        const bump = {
          x: room.x + between(rng, [-1, 1]), y: room.y + between(rng, [-1, 1]),
          w: between(rng, T.room), h: between(rng, T.room),
        };
        const bcells = cellsOf(bump);
        const free = bcells.every(([x, y]) => {
          for (let hy = -1; hy <= 1; hy++) for (let hx = -1; hx <= 1; hx++) {
            const k = key(x + hx, y + hy);
            if (occupied.has(k) && !parent.has(k) &&
                !cellsOf(room).some(([rx, ry]) => key(rx, ry) === k)) return false;
          }
          return true;
        });
        if (free) claim(bump);
      }
    }

    // A tree of rooms is a boring dungeon. Add a few loops back to nearby rooms.
    let loops = T.loops;
    let lguard = 200;
    while (loops > 0 && lguard-- > 0) {
      const a = pick(rng, placed);
      const b = pick(rng, placed);
      if (a === b) continue;
      const link = tryLink(a, b, occupied, rng);
      if (!link) continue;
      claim({ x: link.door.x, y: link.door.y, w: 1, h: 1 });
      if (link.corridor.length) claim(runRect(link.door, link.dir.x, link.dir.y, link.corridor.length));
      doors.push({ x: link.door.x, y: link.door.y, dir: link.dir, type: pick(rng, T.doorMix) });
      loops--;
    }

    // The deepest room is the one worth reaching.
    const ending = placed.reduce((best, r) => {
      const d = Math.abs(r.x) + Math.abs(r.y);
      return d > best.d ? { r, d } : best;
    }, { r: placed[0], d: -1 }).r;
    ending.ending = true;

    // Stairs in, on the outside of the first room; stairs out of the deepest.
    doors.push({ x: first.x - 1, y: first.y, dir: { x: 1, y: 0 }, type: 3 });
    claim({ x: first.x - 1, y: first.y, w: 1, h: 1 });
    if (rng() < 0.6) {
      const ex = { x: ending.x + ending.w, y: ending.y + ending.h - 1 };
      if (!occupied.has(key(ex.x, ex.y))) {
        doors.push({ x: ex.x, y: ex.y, dir: { x: 1, y: 0 }, type: 8 });
        claim({ x: ex.x, y: ex.y, w: 1, h: 1 });
      }
    }

    // ---- the words ----
    const flavour = (s) => s
      .replace(/\{loot\}/g, () => pick(rng, LOOT))
      .replace(/\{fuel\}/g, () => pick(rng, FUEL));

    const noteRooms = placed.filter((r) => r.w > 1 && r.h > 1);
    shuffle(noteRooms, rng);
    const wanted = Math.min(opts.noteCount || between(rng, [6, 10]), noteRooms.length, T.notes.length);
    const pool = T.notes.slice();
    shuffle(pool, rng);
    const notes = [];
    for (let i = 0; i < wanted; i++) {
      const r = noteRooms[i];
      notes.push({
        text: flavour(pool[i]),
        ref: String(i + 1),
        pos: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
      });
    }

    const name = pick(rng, T.ships);
    const title = pick(rng, T.titles).replace(/\{ship\}|\{name\}/g, name);

    return {
      version: "ssv-1",
      generator: { type, seed, rooms: placed.length },
      title: title.replace(/^./, (c) => c.toUpperCase()),
      story: flavour(pick(rng, T.stories)),
      rects,
      doors,
      notes,
      columns: [],
      water: [],
    };
  }
  GEN.generate = generate;

  /** A straight run of cells leaving a door, as one rect — not one rect per cell. */
  function runRect(from, dx, dy, len) {
    if (dx > 0) return { x: from.x + 1, y: from.y, w: len, h: 1 };
    if (dx < 0) return { x: from.x - len, y: from.y, w: len, h: 1 };
    if (dy > 0) return { x: from.x, y: from.y + 1, w: 1, h: len };
    return { x: from.x, y: from.y - len, w: 1, h: len };
  }

  /** A straight corridor between two rooms, if one fits without touching anything else. */
  function tryLink(a, b, occupied, rng) {
    const overlapY = Math.max(a.y, b.y) <= Math.min(a.y + a.h, b.y + b.h) - 1;
    const overlapX = Math.max(a.x, b.x) <= Math.min(a.x + a.w, b.x + b.w) - 1;
    let dir, doorCell, steps;
    if (overlapY && (b.x > a.x + a.w || a.x > b.x + b.w)) {
      const y = between(rng, [Math.max(a.y, b.y), Math.min(a.y + a.h, b.y + b.h) - 1]);
      const right = b.x > a.x;
      dir = { x: right ? 1 : -1, y: 0 };
      doorCell = { x: right ? a.x + a.w : a.x - 1, y };
      steps = Math.abs((right ? b.x : b.x + b.w - 1) - doorCell.x) - 1;
    } else if (overlapX && (b.y > a.y + a.h || a.y > b.y + b.h)) {
      const x = between(rng, [Math.max(a.x, b.x), Math.min(a.x + a.w, b.x + b.w) - 1]);
      const down = b.y > a.y;
      dir = { x: 0, y: down ? 1 : -1 };
      doorCell = { x, y: down ? a.y + a.h : a.y - 1 };
      steps = Math.abs((down ? b.y : b.y + b.h - 1) - doorCell.y) - 1;
    } else return null;
    if (steps < 0 || steps > 8) return null;

    const corridor = [];
    for (let i = 1; i <= steps; i++) corridor.push({ x: doorCell.x + dir.x * i, y: doorCell.y + dir.y * i });
    const want = [[doorCell.x, doorCell.y], ...corridor.map((c) => [c.x, c.y])];
    if (want.some(([x, y]) => occupied.has(key(x, y)))) return null;
    return { door: doorCell, dir, corridor };
  }

  function shuffle(a, rng) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = GEN;
})(typeof globalThis !== "undefined" ? globalThis : this);
