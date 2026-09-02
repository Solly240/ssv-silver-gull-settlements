/**
 * Sites — the dungeons reached from the settlement hub.
 *
 * Deliberately self-contained: its own world setting, its own scene building, and it talks
 * to the settlement UI only through `globalThis.SSVSITES`. Nothing in settlements.js needs
 * to understand dungeons, and a broken site cannot take the hub down with it.
 *
 * Geometry is never stored. A site is a `type` and a `seed`; dungeon-gen regenerates it
 * identically every time, so `data/sites.json` stays a few lines per site and the map can
 * never disagree with the walls derived from it.
 */

const MODULE_ID = "ssv-silver-gull-settlements";
const SITE_DIR = () => `worlds/${game.world.id}/ssv-sites`;

let SITES = null;

async function loadSites() {
  if (SITES) return SITES;
  try {
    const res = await fetch(`modules/${MODULE_ID}/data/sites.json`);
    SITES = (await res.json()).sites || [];
  } catch (e) {
    console.error(`${MODULE_ID} | could not load sites.json`, e);
    SITES = [];
  }
  return SITES;
}

const siteById = (id) => (SITES || []).find((s) => s.id === id) || null;

/* ------------------------------------------------------------------ *
 * State — discovered / locked / which scene it built
 * ------------------------------------------------------------------ */

const getSiteState = () => game.settings.get(MODULE_ID, "siteState") || {};
async function setSiteState(id, patch) {
  if (!game.user.isGM) return;
  const all = foundry.utils.duplicate(getSiteState());
  all[id] = { ...(all[id] || {}), ...patch };
  await game.settings.set(MODULE_ID, "siteState", all);
}

/** What the hub should show. Players never see a site they have not found. */
function list() {
  const st = getSiteState();
  const isGM = game.user.isGM;
  return (SITES || [])
    .map((s) => {
      const own = st[s.id] || {};
      const discovered = own.discovered ?? false;
      const locked = own.locked ?? true;
      // Fall back to the flag when the id is not on file — a scene built before this
      // setting existed, or one the GM renamed, is still ours and should be adopted
      // rather than silently rebuilt.
      const scene = (own.sceneId ? game.scenes.get(own.sceneId) : null)
        || game.scenes.find((sc) => sc.getFlag(MODULE_ID, "siteId") === s.id)
        || null;
      return {
        ...s,
        discovered,
        locked,
        built: !!scene,
        sceneId: scene?.id || null,
        visible: discovered || isGM,
        gmOnly: !discovered && isGM,
        enterable: isGM || (discovered && !locked && !!scene),
        reason: !discovered ? "Undiscovered" : locked ? "Locked by the GM" : !scene ? "Not built yet" : "",
      };
    })
    .filter((s) => s.visible);
}

/* ------------------------------------------------------------------ *
 * Building a site into a real scene
 * ------------------------------------------------------------------ */

/** Regenerate the dungeon and stock it. Same seed in, same site out, every time. */
function buildModel(site) {
  const raw = globalThis.SSVDUNGEN.generate({ type: site.type, seed: site.seed });
  const model = globalThis.SSVDUN.convert(raw, { gridSize: site.gridSize || 64 });
  const plan = globalThis.SSVSTOCK.stock(model, {
    type: site.type,
    seed: site.seed,
    partySize: partySize(),
    level: partyLevel(),
  });
  return { raw, model, plan };
}

const players = () => game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);
const partySize = () => Math.max(1, players().length);
function partyLevel() {
  const ps = players();
  if (!ps.length) return 3;
  const lv = ps.map((a) => a.system?.details?.level
    || a.items.filter((i) => i.type === "class").reduce((n, i) => n + (i.system?.levels || 0), 0));
  return Math.max(1, Math.round(lv.reduce((a, b) => a + b, 0) / lv.length));
}

/**
 * Draw the map and put it on the server.
 *
 * The SVG is rasterised in the browser rather than shipped as an asset: the map is derived
 * from the seed, so there is nothing to ship until a GM asks for this particular site.
 */
async function uploadMap(site, model) {
  const svg = globalThis.SSVDUNART.toSvg(model, { theme: site.theme || "dungeon", grid: !site.gridless });
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement("canvas");
    c.width = model.width;
    c.height = model.height;
    c.getContext("2d").drawImage(img, 0, 0, model.width, model.height);
    const out = await new Promise((r) => c.toBlob(r, "image/webp", 0.92));

    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
    try { await FP.createDirectory("data", SITE_DIR()); } catch (e) { /* already there */ }
    const name = `${site.id}.webp`;
    const file = new File([out], name, { type: "image/webp" });
    await FP.upload("data", SITE_DIR(), file, {}, { notify: false });
    return `${SITE_DIR()}/${name}`;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Foundry's wall flags for each kind of doorway we emit. */
function wallDataFor(d) {
  const c = d.seg.map(Math.round);
  if (d.kind === "secret") return { c, door: 2, ds: 0 };
  if (d.kind === "locked") return { c, door: 1, ds: 2 };
  if (d.kind === "door") return { c, door: 1, ds: 0 };
  return { c, door: 0 };                       // barred / portcullis: a wall you cannot open
}

/** Import an SRD stat block once, renamed for the setting. */
const actorCache = new Map();
async function actorFor(entry) {
  if (actorCache.has(entry.name)) return actorCache.get(entry.name);
  let actor = game.actors.getName(entry.name);
  if (!actor) {
    const pack = game.packs.get(entry.pack);
    const idx = pack ? await pack.getIndex() : null;
    const hit = idx?.find((e) => e.name.toLowerCase() === entry.srd.toLowerCase());
    if (!hit) { console.warn(`${MODULE_ID} | no stat block "${entry.srd}"`); return null; }
    const src = await pack.getDocument(hit._id);
    const data = src.toObject();
    data.name = entry.name;
    delete data._id;
    data.folder = (await folder("Actor", "SSV — Site Creatures"))?.id ?? null;
    data.flags = { ...(data.flags || {}), [MODULE_ID]: { srd: entry.srd, generated: true } };
    actor = await Actor.create(data);
  }
  actorCache.set(entry.name, actor);
  return actor;
}

async function folder(type, name) {
  let f = game.folders.find((x) => x.type === type && x.name === name);
  if (!f) f = await Folder.create({ name, type, color: "#3f6f5f" });
  return f;
}

/** One shared container actor; each cache token carries its own contents. */
async function cacheActor() {
  let a = game.actors.getName("Salvage Cache");
  if (a) return a;
  return Actor.create({
    name: "Salvage Cache",
    type: "npc",
    img: "icons/containers/chest/chest-worn-oak-tan.webp",
    folder: (await folder("Actor", "SSV — Site Creatures"))?.id ?? null,
    flags: { [MODULE_ID]: { generated: true, container: true } },
  });
}

/** Spread N tokens around a room centre without stacking them. */
function spread(room, n, g) {
  const out = [];
  const cols = Math.max(1, Math.floor(room.rect.w / g));
  const rows = Math.max(1, Math.floor(room.rect.h / g));
  for (let i = 0; i < n; i++) {
    const cx = i % cols;
    const cy = Math.floor(i / cols) % rows;
    out.push({ x: room.rect.x + cx * g, y: room.rect.y + cy * g });
  }
  return out;
}

/**
 * Build (or rebuild) the Foundry scene for a site.
 *
 * Destructive on rebuild: the scene is deleted and remade, so anything hand-placed is lost.
 * That is deliberate — a half-updated dungeon is worse than a fresh one.
 */
async function build(siteId, { notify = true } = {}) {
  if (!game.user.isGM) return ui.notifications?.warn("Only the GM can build a site.");
  const site = siteById(siteId);
  if (!site) return;

  const { model, plan } = buildModel(site);
  if (notify) ui.notifications?.info(`Building ${site.name} — ${model.rooms.length} rooms…`);

  const img = await uploadMap(site, model);

  // Replace any previous scene for this site.
  const prevId = getSiteState()[siteId]?.sceneId;
  const prev = prevId ? game.scenes.get(prevId) : null;
  if (prev) await prev.delete();

  const g = model.gridSize;
  const hasBackground = "background" in Scene.implementation.schema.fields;
  const sceneData = {
    name: `${site.name}`,
    folder: (await folder("Scene", "Campaign — Sites"))?.id ?? null,
    width: model.width,
    height: model.height,
    padding: 0.06,
    // Gridless: the rooms are drawn as rooms, and a square grid over illustrated stone
    // only ever fights the picture. Size still matters — it is the distance scale.
    grid: { type: site.gridless ? CONST.GRID_TYPES.GRIDLESS : CONST.GRID_TYPES.SQUARE, size: g },
    initial: { x: model.spawns[0]?.x ?? model.width / 2, y: model.spawns[0]?.y ?? model.height / 2, scale: 0.5 },
    tokenVision: true,
    fog: { exploration: true },                 // a dungeon IS a map to uncover
    environment: { globalLight: { enabled: false }, darknessLevel: site.darkness ?? 0.85 },
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: { [MODULE_ID]: { siteId, seed: site.seed, type: site.type } },
  };
  if (hasBackground) sceneData.background = { src: img };

  const scene = await Scene.create(sceneData);

  // v14 dropped Scene#background — the map is a Tile, and a Tile's x/y is its CENTRE.
  if (!hasBackground) {
    await scene.createEmbeddedDocuments("Tile", [{
      texture: { src: img },
      width: model.width, height: model.height,
      x: model.width / 2, y: model.height / 2,
      sort: -1000, locked: true,
      flags: { [MODULE_ID]: { mapBackground: true } },
    }]);
  }

  // Walls, doors.
  const walls = model.walls.map((w) => ({ c: w.map(Math.round) }));
  const doors = model.doors.map(wallDataFor);
  await scene.createEmbeddedDocuments("Wall", [...walls, ...doors]);

  // A lamp per room, and one on the way in. Radii are grid DISTANCE units, not pixels.
  const lights = model.rooms.map((r) => ({
    x: Math.round(r.centre.x), y: Math.round(r.centre.y),
    config: { dim: 30, bright: 10, color: site.theme === "scan" ? "#79d7ff" : "#ffb066", alpha: 0.12 },
  }));
  for (const s of model.spawns) lights.push({ x: Math.round(s.x), y: Math.round(s.y), config: { dim: 40, bright: 15 } });
  await scene.createEmbeddedDocuments("AmbientLight", lights);

  // Creatures.
  const tokens = [];
  for (const room of plan.rooms) {
    if (!room.enemies.length) continue;
    const total = room.enemies.reduce((n, e) => n + e.count, 0);
    const spots = spread(room, total, g);
    let i = 0;
    for (const e of room.enemies) {
      const actor = await actorFor(e);
      if (!actor) { i += e.count; continue; }
      for (let k = 0; k < e.count; k++) {
        const at = spots[i++] || { x: room.centre.x, y: room.centre.y };
        const proto = actor.prototypeToken.toObject();
        tokens.push({
          ...proto,
          name: e.name,
          actorId: actor.id,
          actorLink: false,
          x: Math.round(at.x), y: Math.round(at.y),
          hidden: true,                          // the GM reveals a room when the party opens it
          flags: { [MODULE_ID]: { siteId, role: room.role } },
        });
      }
    }
  }

  // Loot caches.
  const cache = await cacheActor();
  for (const room of plan.rooms) {
    if (!room.loot.length && !room.gold) continue;
    const items = [];
    for (const l of room.loot) {
      const src = game.items.getName(l.name);
      if (!src) { console.warn(`${MODULE_ID} | no item "${l.name}" in the world`); continue; }
      for (let k = 0; k < l.qty; k++) { const o = src.toObject(); delete o._id; items.push(o); }
    }
    const proto = cache.prototypeToken.toObject();
    tokens.push({
      ...proto,
      name: "Salvage",
      actorId: cache.id,
      actorLink: false,
      x: Math.round(room.centre.x - g / 2), y: Math.round(room.centre.y - g / 2),
      width: 1, height: 1, hidden: true,
      delta: { items, system: { currency: { gp: room.gold || 0 } } },
      flags: { [MODULE_ID]: { siteId, loot: true } },
    });
  }
  if (tokens.length) await scene.createEmbeddedDocuments("Token", tokens);

  // Room notes become map pins the GM can read.
  const notes = [];
  for (const room of plan.rooms) {
    for (const n of room.notes || []) {
      notes.push({ x: Math.round(n.at.x), y: Math.round(n.at.y), text: `${n.ref}. ${n.text}`,
        icon: { size: 32 }, global: false });
    }
  }
  if (notes.length) {
    try { await scene.createEmbeddedDocuments("Note", notes.map((n) => ({ ...n, entryId: null }))); }
    catch (e) { console.warn(`${MODULE_ID} | notes could not be placed`, e); }
  }

  await setSiteState(siteId, { sceneId: scene.id, built: true });
  await applyAccess(siteId);
  if (notify) {
    ui.notifications?.info(
      `${site.name}: ${model.rooms.length} rooms, ${model.walls.length} walls, ` +
      `${plan.summary.fights} encounters, ${plan.summary.heads} creatures, ${plan.summary.lootDrops} caches.`);
  }
  return scene;
}

/**
 * Locking is enforced on the document, not just in the UI.
 *
 * A player with OBSERVER on a scene can open it themselves; without it they cannot. So a
 * locked site is genuinely shut, not merely hidden behind a button that says no.
 */
async function applyAccess(siteId) {
  if (!game.user.isGM) return;
  const s = list().find((x) => x.id === siteId) || {};
  const scene = s.sceneId ? game.scenes.get(s.sceneId) : null;
  if (!scene) return;
  const open = s.discovered && !s.locked;
  await scene.update({
    "ownership.default": open
      ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER
      : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
    navigation: open,
  });
}

/* ------------------------------------------------------------------ *
 * Player-facing
 * ------------------------------------------------------------------ */

async function open(siteId) {
  const s = list().find((x) => x.id === siteId);
  if (!s) return;
  if (!s.enterable) return ui.notifications?.warn(`${s.name} — ${s.reason}`);
  if (!s.sceneId) return ui.notifications?.warn(`${s.name} has not been built yet.`);
  const scene = game.scenes.get(s.sceneId);
  if (!scene) return ui.notifications?.warn("That scene is missing.");
  if (game.user.isGM) await scene.activate();
  else await scene.view();
}

/* ------------------------------------------------------------------ *
 * GM operations
 * ------------------------------------------------------------------ */

const gm = {
  reveal: async (id, v) => { await setSiteState(id, { discovered: v }); await applyAccess(id); },
  lock: async (id, v) => { await setSiteState(id, { locked: v }); await applyAccess(id); },
  build: (id) => build(id),
  buildAll: async () => { for (const s of SITES || []) await build(s.id, { notify: false }); ui.notifications?.info("All sites built."); },
  /** Preview the encounter and loot plan without building anything. */
  plan: (id) => {
    const site = siteById(id);
    if (!site) return null;
    const { plan } = buildModel(site);
    console.table(plan.rooms.filter((r) => r.enemies.length).map((r) => ({
      depth: r.depth, role: r.role, difficulty: r.difficulty, xp: r.adjustedXp,
      enemies: r.enemies.map((e) => `${e.count}x ${e.name}`).join(" + "),
    })));
    return plan;
  },
};

/* ------------------------------------------------------------------ *
 * Retiring the old settlement battlemaps
 * ------------------------------------------------------------------ */

/**
 * The interiors are pictures now, so the seven built battlemaps are no longer the way in.
 * They are moved rather than deleted — a fight can still break out in the Tab, and the GM
 * can open one by hand from the Scenes tab.
 */
async function retireInteriorScenes() {
  if (!game.user.isGM) return;
  const st = game.settings.get(MODULE_ID, "state") || {};
  const keys = st.sceneKeys || {};
  const ids = new Set(Object.values(keys));
  const scenes = game.scenes.filter((s) =>
    ids.has(s.id) || s.getFlag(MODULE_ID, "locId") || /^(Frostwatch Landing|Kettle Hollow) — /.test(s.name));
  if (!scenes.length) return ui.notifications?.info("No settlement battlemaps to retire.");

  const f = await folder("Scene", "Retired — Settlement Interiors");
  for (const s of scenes) await s.update({ folder: f.id, navigation: false });
  await game.settings.set(MODULE_ID, "state", { ...st, sceneKeys: {} });
  ui.notifications?.info(`Retired ${scenes.length} settlement battlemaps into "${f.name}".`);
  return scenes.length;
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "siteState", {
    scope: "world", config: false, type: Object, default: {},
    onChange: () => globalThis.SilverGullSettlements?.refresh?.(),
  });
});

Hooks.once("ready", async () => {
  await loadSites();
  globalThis.SSVSITES = { list, open, gm, build, retireInteriorScenes, loadSites, buildModel, siteById };
  const mod = game.modules.get(MODULE_ID);
  if (mod?.api) mod.api.sites = globalThis.SSVSITES;
});

export { list, open, gm, build, retireInteriorScenes };
