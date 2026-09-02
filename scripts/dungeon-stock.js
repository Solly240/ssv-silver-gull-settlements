/**
 * Stock a generated site with enemies and loot.
 *
 * PURE — no Foundry globals. Takes a model from dungeon-geom.js and returns a plan; the
 * wiring turns that plan into tokens and items.
 *
 * The point of doing this from the room graph rather than by hand: the graph already knows
 * which rooms are shallow, which are dead ends and which one is the end of the site, so
 * "guards by the door, cache in the dead end, the worst thing in the deepest room" falls
 * out of the data instead of being decided one room at a time.
 *
 * Every creature is an SRD stat block wearing a campaign name. The block is what the GM
 * rolls; the name is what the players hear.
 */
(function (root) {
  const S = (root.SSVSTOCK = root.SSVSTOCK || {});

  const SRD_PACK = "world.ssv--bestiary-srd";

  /** XP by challenge rating, for budgeting. */
  const XP = { "1/8": 25, "1/4": 50, "1/2": 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800 };

  /**
   * name      what the players are told
   * srd       the stat block to copy
   * cr        for budgeting
   * tier      0 shallow · 1 middle · 2 deep · 3 boss
   */
  const ROSTER = {
    derelict: [
      { name: "Scav", srd: "Bandit", cr: "1/8", tier: 0 },
      { name: "Scav Cutter", srd: "Thug", cr: "1/2", tier: 1 },
      { name: "Apostle Zealot", srd: "Cultist", cr: "1/8", tier: 0 },
      { name: "Cutting Drone", srd: "Flying Sword", cr: "1/4", tier: 0 },
      { name: "Maintenance Shell", srd: "Animated Armor", cr: 1, tier: 1 },
      { name: "Rift-Spawn", srd: "Gray Ooze", cr: "1/2", tier: 1 },
      { name: "Hull-Gnawer", srd: "Grick", cr: 2, tier: 2 },
      { name: "Salvage Mimic", srd: "Mimic", cr: 2, tier: 2 },
      { name: "Apostle Speaker", srd: "Cult Fanatic", cr: 2, tier: 3 },
      { name: "Scav Boss", srd: "Bandit Captain", cr: 2, tier: 3 },
    ],
    hollow: [
      { name: "Frostbitten Dead", srd: "Skeleton", cr: "1/4", tier: 0 },
      { name: "Ice-Locked Corpse", srd: "Zombie", cr: "1/4", tier: 0 },
      { name: "Glacier Mephit", srd: "Ice Mephit", cr: "1/2", tier: 1 },
      { name: "Hollow-Crawler", srd: "Darkmantle", cr: "1/2", tier: 1 },
      { name: "Meltwater Ooze", srd: "Gray Ooze", cr: "1/2", tier: 1 },
      { name: "Rime Wisp", srd: "Will-o'-Wisp", cr: 2, tier: 2 },
      { name: "Cold Hunter", srd: "Winter Wolf", cr: 3, tier: 2 },
      { name: "Thing In The Ice", srd: "Gibbering Mouther", cr: 2, tier: 3 },
      { name: "Hollow Warden", srd: "Ogre", cr: 2, tier: 3 },
    ],
    station: [
      { name: "Dock Tough", srd: "Thug", cr: "1/2", tier: 0 },
      { name: "Directorate Scout", srd: "Scout", cr: "1/2", tier: 1 },
      { name: "Station Guard", srd: "Guard", cr: "1/8", tier: 0 },
      { name: "Maintenance Shell", srd: "Animated Armor", cr: 1, tier: 1 },
      { name: "Vent Shadow", srd: "Shadow", cr: "1/2", tier: 2 },
      { name: "Directorate Veteran", srd: "Veteran", cr: 3, tier: 3 },
    ],
    ancient: [
      { name: "Dormant Shell", srd: "Animated Armor", cr: 1, tier: 0 },
      { name: "Gate-Sliver", srd: "Flying Sword", cr: "1/4", tier: 0 },
      { name: "Threshold Echo", srd: "Specter", cr: 1, tier: 1 },
      { name: "Crystalline Drone", srd: "Rug of Smothering", cr: 2, tier: 1 },
      { name: "Watcher At The Sill", srd: "Will-o'-Wisp", cr: 2, tier: 2 },
      { name: "Guardian Remnant", srd: "Grick", cr: 2, tier: 2 },
      { name: "Awoken Guardian", srd: "Veteran", cr: 3, tier: 3 },
    ],
  };
  S.ROSTER = ROSTER;

  /** Real Items that exist in the world, so loot is loot and not a note. */
  const LOOT_TIERS = [
    ["Deuterium Slug", "Tritium Canister", "Cryo-Slush Tank"],
    ["Promethium Jug", "Verdite Fuel Brick", "Ceruleum Fuel Rod", "Reclaimed Plasma Drum"],
    ["Hyperfold Half-Cell", "Promethium Core Drum"],
    ["Hyperfold Fuel Cell", "Antimatter Thimble"],
  ];
  S.LOOT_TIERS = LOOT_TIERS;

  const xpOf = (e) => XP[e.cr] ?? 0;

  /** DMG group multiplier, stepped down one band because this party is seven strong. */
  function multiplier(n, partySize) {
    let band = n <= 1 ? 1 : n === 2 ? 1.5 : n <= 6 ? 2 : n <= 10 ? 2.5 : 3;
    if (partySize >= 6) band = n <= 1 ? 1 : n === 2 ? 1 : n <= 6 ? 1.5 : n <= 10 ? 2 : 2.5;
    return band;
  }

  /** Distance in cells from the party's landing point to every floor cell. */
  function depths(model) {
    const key = (x, y) => `${x},${y}`;
    const start = model.spawns[0]?.cell;
    const d = new Map();
    if (!start) return d;
    d.set(key(start.x, start.y), 0);
    const q = [start];
    while (q.length) {
      const c = q.shift();
      const cd = d.get(key(c.x, c.y));
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = key(c.x + dx, c.y + dy);
        if (!model.cells.has(k) || d.has(k)) continue;
        d.set(k, cd + 1);
        q.push({ x: c.x + dx, y: c.y + dy });
      }
    }
    return d;
  }

  function roomDepth(room, d) {
    let best = Infinity;
    for (let dy = 0; dy < room.cell.h; dy++) {
      for (let dx = 0; dx < room.cell.w; dx++) {
        const v = d.get(`${room.cell.x + dx},${room.cell.y + dy}`);
        if (v != null && v < best) best = v;
      }
    }
    return best === Infinity ? 0 : best;
  }

  /**
   * @param {object} model  from SSVDUN.convert
   * @param {object} opts   { type, partySize = 7, level = 3, seed = 1, density = 0.6 }
   */
  function stock(model, opts = {}) {
    const type = ROSTER[opts.type] ? opts.type : "derelict";
    const roster = ROSTER[type];
    const partySize = opts.partySize || 7;
    const level = opts.level || 3;
    const density = opts.density == null ? 0.5 : opts.density;
    let seed = (opts.seed || 1) >>> 0;
    const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

    // DMG per-character thresholds, times the party.
    const per = { easy: 75, medium: 150, hard: 225, deadly: 400 };
    if (level <= 2) Object.assign(per, { easy: 50, medium: 100, hard: 150, deadly: 200 });
    if (level >= 4) Object.assign(per, { easy: 125, medium: 250, hard: 375, deadly: 500 });
    const budget = {
      easy: per.easy * partySize, medium: per.medium * partySize,
      hard: per.hard * partySize, deadly: per.deadly * partySize,
    };

    const d = depths(model);
    const maxDepth = Math.max(1, ...model.rooms.map((r) => roomDepth(r, d)).filter((v) => Number.isFinite(v)));

    // The generator flags an "ending" room by straight-line distance from the origin, which
    // is not the same as the furthest room to walk to — put the boss where the party
    // actually arrives last.
    let deepest = null, deepestD = -1;
    for (const r of model.rooms) {
      const rd = roomDepth(r, d);
      if (rd > deepestD) { deepestD = rd; deepest = r; }
    }

    // Keep the number of fights roughly constant however many rooms the site has, so a big
    // site is a longer crawl and not a longer grind.
    const wantFights = Math.max(3, Math.min(6, Math.round(model.rooms.length * 0.45)));
    const eligible = model.rooms.filter((r) => r !== deepest && roomDepth(r, d) > 1).length || 1;
    const fightChance = Math.min(0.9, wantFights / eligible);

    const plan = [];
    let totalXp = 0;

    for (const room of model.rooms) {
      const dep = roomDepth(room, d);
      const frac = Math.min(1, dep / maxDepth);
      const entry = dep <= 1;
      const boss = room === deepest;

      let role = "empty";
      if (boss) role = "boss";
      else if (entry) role = "entry";
      else if (rng() < fightChance) role = "guard";
      else if (rng() < 0.45) role = "treasure";

      const item = { roomId: room.id, depth: dep, role, enemies: [], loot: [], gold: 0, centre: room.centre, rect: room.rect, area: room.area, notes: room.notes };

      if (role === "guard" || role === "boss") {
        // Aim between medium and deadly, climbing with depth. Aiming at *easy* — which is
        // what a first pass did — gives seven level-3 characters nothing to worry about;
        // a party this size eats an easy encounter on action economy alone.
        const target = boss
          ? budget.deadly * 0.9
          : budget.medium + (budget.deadly * 0.85 - budget.medium) * frac;
        const tier = boss ? 3 : frac < 0.34 ? 0 : frac < 0.7 ? 1 : 2;
        const pool = roster.filter((e) => e.tier === tier);
        const lead = pool[Math.floor(rng() * pool.length) | 0] || roster[0];

        // Seven players plus a dozen monsters is a forty-minute round. Cap the bodies.
        const HEAD_CAP = 8;
        const cap = Math.max(1, Math.min(boss ? 3 : 6, Math.floor(room.area / 2), HEAD_CAP));
        const adj = (list) => {
          const heads = list.reduce((n2, e) => n2 + e.count, 0);
          const raw = list.reduce((n2, e) => n2 + xpOf(e) * e.count, 0);
          return raw * multiplier(heads, partySize);
        };
        let n = 1;
        while (n < cap && adj([{ ...lead, count: n + 1 }]) <= target * 1.1) n++;
        item.enemies.push({ ...lead, count: n, pack: SRD_PACK, xp: xpOf(lead) });

        // A single species N times over is a dull fight. If the budget is still light and
        // there is floor for it, bring in something that fights differently.
        if (!boss && adj(item.enemies) < target * 0.8) {
          const mates = roster.filter((e) => e.name !== lead.name && e.tier <= tier);
          const mate = mates[Math.floor(rng() * mates.length) | 0];
          if (mate) {
            const room4 = HEAD_CAP - item.enemies.reduce((n2, e) => n2 + e.count, 0);
            let m = 1;
            while (m < Math.min(cap, room4) && adj([...item.enemies, { ...mate, count: m + 1 }]) <= target * 1.15) m++;
            if (room4 > 0) item.enemies.push({ ...mate, count: Math.min(m, room4), pack: SRD_PACK, xp: xpOf(mate) });
          }
        }

        if (boss) {
          const addPool = roster.filter((e) => e.tier <= 1);
          const add = addPool[Math.floor(rng() * addPool.length) | 0];
          const room4 = HEAD_CAP - item.enemies.reduce((n2, e) => n2 + e.count, 0);
          if (add && room4 > 0) item.enemies.push({ ...add, count: Math.min(room4, 2 + Math.floor(rng() * 3)), pack: SRD_PACK, xp: xpOf(add) });
        }
        const heads = item.enemies.reduce((n2, e) => n2 + e.count, 0);
        const raw = item.enemies.reduce((n2, e) => n2 + e.xp * e.count, 0);
        item.xp = raw;
        item.adjustedXp = Math.round(raw * multiplier(heads, partySize));
        item.difficulty = item.adjustedXp >= budget.deadly ? "deadly"
          : item.adjustedXp >= budget.hard ? "hard"
          : item.adjustedXp >= budget.medium ? "medium" : "easy";
        totalXp += raw;
      }

      if (role === "treasure" || role === "boss" || (role === "guard" && rng() < 0.35)) {
        const tierIdx = boss ? 3 : Math.min(2, Math.floor(frac * 3));
        const pool = LOOT_TIERS[tierIdx];
        const name = pool[Math.floor(rng() * pool.length) | 0];
        item.loot.push({ name, qty: boss ? 1 : 1 + Math.floor(rng() * 2) });
        item.gold = Math.round((20 + rng() * 60) * (1 + frac * 2) * (boss ? 3 : 1));
      }

      plan.push(item);
    }

    const fights = plan.filter((p) => p.enemies.length);
    return {
      type, partySize, level, budget,
      rooms: plan,
      summary: {
        rooms: plan.length,
        fights: fights.length,
        heads: fights.reduce((n, p) => n + p.enemies.reduce((m, e) => m + e.count, 0), 0),
        totalXp,
        perPc: Math.round(totalXp / partySize),
        hardest: fights.reduce((b, p) => (p.adjustedXp > (b?.adjustedXp || 0) ? p : b), null)?.difficulty || "none",
        lootDrops: plan.filter((p) => p.loot.length).length,
        gold: plan.reduce((n, p) => n + p.gold, 0),
      },
    };
  }
  S.stock = stock;

  if (typeof module !== "undefined" && module.exports) module.exports = S;
})(typeof globalThis !== "undefined" ? globalThis : this);
