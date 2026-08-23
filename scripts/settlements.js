/* SSV Silver Gull — Settlements : Foundry wiring.
 *
 * Everything that touches game/ui/Hooks/canvas lives here. All rendering, styling and
 * floorplan geometry lives in settle-render.js (globalThis.SSVSET), which is loaded first
 * as a classic script so it always exists by the time this module evaluates.
 */

const MODULE_ID = "ssv-silver-gull-settlements";
const SHOP_ID = "ssv-silver-gull-shop";
const POLITICS_ID = "ssv-silver-gull-politics";
const SOCKET = `module.${MODULE_ID}`;
const NPC_FOLDER = "Settlement NPCs";

const S = () => globalThis.SSVSET;
const D2 = () => foundry.applications?.api?.DialogV2;

/** Only the one authoritative GM acts on a request, or every GM would run it. */
const isActiveGM = () => game.user.isGM && (game.users?.activeGM?.id ?? game.user.id) === game.user.id;

/* ------------------------------------------------------------------ *
 * Content + state
 * ------------------------------------------------------------------ */

let CONTENT = null;

async function loadContent() {
  if (CONTENT) return CONTENT;
  try {
    const res = await fetch(`modules/${MODULE_ID}/data/settlements.json`);
    CONTENT = await res.json();
  } catch (e) {
    console.error(`${MODULE_ID} | could not load settlements.json`, e);
    CONTENT = { version: "0", cities: [] };
  }
  invalidateState();   // currentCityId falls back to cities()[0] — drop anything cached before content landed
  return CONTENT;
}

const cities = () => CONTENT?.cities || [];
const cityById = (id) => cities().find((c) => c.id === id) || null;
const locById = (city, id) => (city?.locations || []).find((l) => l.id === id) || null;

function findLoc(locId) {
  for (const c of cities()) {
    const l = locById(c, locId);
    if (l) return { city: c, loc: l };
  }
  return { city: null, loc: null };
}

// Cached: getState() allocates a fresh object and makes Foundry deserialise the setting on
// every call, and onTokenMoved hits it while a token is being dragged. The stored value only
// ever changes through a settings write, which fires the onChange that clears this.
let _stateCache = null;
const invalidateState = () => { _stateCache = null; };
const getState = () => (_stateCache ??= _buildState());
const _buildState = () => {
  const raw = game.settings.get(MODULE_ID, "state") || {};
  return {
    currentCityId: raw.currentCityId ?? cities()[0]?.id ?? null,
    timeOfDay: raw.timeOfDay ?? "day",
    discovered: raw.discovered ?? {},
    locked: raw.locked ?? {},
    leaveLocked: raw.leaveLocked ?? {},
    whereIs: raw.whereIs ?? {},
    sceneKeys: raw.sceneKeys ?? {},
    quests: raw.quests ?? {},
  };
};

/** GM-only write. Players never touch settings; they go through the socket. */
async function setState(patch) {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, "state", { ...getState(), ...patch });
}

const assetPath = (rel) => {
  if (!rel) return rel;
  if (/^(https?:|data:|modules\/|worlds\/|systems\/|icons\/|assets\/foundry)/.test(rel)) return rel;
  return `modules/${MODULE_ID}/${rel.replace(/^\.?\//, "")}`;
};

/**
 * Art paths for the browser to fetch, stamped with the module version.
 *
 * Filenames never change between releases, so a browser will happily keep serving the
 * copy it cached — which is why an updated settlement vista could still show the old one.
 * Only used for images the page requests directly; scene backgrounds are stored on the
 * document and must stay a clean path.
 */
const artPath = (rel) => {
  const p = assetPath(rel);
  if (!p || /^(https?:|data:)/.test(p)) return p;
  const v = game.modules.get(MODULE_ID)?.version || "0";
  return `${p}${p.includes("?") ? "&" : "?"}v=${encodeURIComponent(v)}`;
};

/* ------------------------------------------------------------------ *
 * Roots
 * ------------------------------------------------------------------ */

function ensureRoot(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }
  return el;
}
const hubRoot = () => ensureRoot("ssvset-panel");
const cardRoot = () => ensureRoot("ssvset-card");
const leaveRoot = () => ensureRoot("ssvset-leave");
const dossierRoot = () => ensureRoot("ssvset-dossier");

const hubOpen = () => hubRoot().style.display === "block";
const cardOpen = () => !!cardRoot().firstChild;

/* ------------------------------------------------------------------ *
 * The ctx handed to the pure renderer
 * ------------------------------------------------------------------ */

function standingSummary(city) {
  if (!city?.faction) return null;
  try {
    const api = game.modules.get(POLITICS_ID)?.api;
    if (!api?.getData) return null;
    const data = api.getData();
    const value = Number(data?.[city.faction]?.standing);
    if (!Number.isFinite(value)) return null;
    const name = (api.FACTIONS || []).find((f) => f.id === city.faction)?.name || city.faction;
    return { faction: name, value };
  } catch (e) {
    return null;
  }
}

function buildCtx() {
  const state = getState();
  const city = cityById(state.currentCityId) || cities()[0] || null;
  return {
    isGM: game.user.isGM,
    userId: game.user.id,
    users: game.users.filter((u) => u.active || u.character).map((u) => ({
      id: u.id, name: u.name, charName: u.character?.name || null,
    })),
    city,
    cities: cities().map((c) => ({ id: c.id, name: c.name })),
    state,
    standing: standingSummary(city),
    hasShopModule: !!game.modules.get(SHOP_ID)?.active,
    assetPath: artPath,
    refresh: () => drawHub(),
    close: () => closeHub(),
    notify: (m) => ui.notifications?.info(m),
    confirm: (q) => confirmDialog(q),
    enter: (locId) => requestEnter(locId),
    leave: () => requestLeave(),
    closeCard: () => closeCard(),
    openShop: (shopId, npc) => openShopFor(shopId, npc),
    openSheet: (npc) => game.actors.getName(npc.actor)?.sheet?.render(true),
    say: (npc, line) => sayLine(npc, line),
    acceptedTitles,
    closeDossier,
    advanceQuest: (key, quest, npc, loc) => gmAdvanceQuest(key, quest, npc, loc?.id),
    stepQuestBack: (key) => gmStepQuestBack(key),
    payout: (quest, npc) => payoutQuest(quest, npc),
    journalQuest: (id) => { try { return journalApi()?.getQuest?.(id) || null; } catch (e) { return null; } },
    openJournalQuest: (id) => {
      const api = journalApi();
      if (!api) return ui.notifications?.warn("The journal module is not available.");
      api.refresh?.();
      ui.notifications?.info("Open the Ship's Journal — Quests tab.");
    },
    itemInfo: (catId) => {
      try {
        const cat = game.modules.get(SHOP_ID)?.api?.getCatalogue?.();
        return (cat?.items || []).find((i) => i.id === catId) || null;
      } catch (e) { return null; }
    },
    questGivers: () => questGiversIn(cityById(getState().currentCityId)),
    openDossier: (locId, npcKey) => openDossier(locId, npcKey),
    setTimeOfDay: (t) => gmCall("setTimeOfDay", { t }),
    setCity: (id) => gmCall("setCity", { id }),
    reveal: (locId, v) => gmCall("reveal", { locId, v }),
    setLocked: (locId, v) => gmCall("setLocked", { locId, v }),
    setLeaveLock: (locId, v) => gmCall("setLeaveLock", { locId, v }),
    rebuild: (locId) => gmRebuild(locId),
    rebuildAll: () => gmRebuildAll(),
    recall: (userId) => gmCall("recall", { userId }),
    syncShopHours: () => gmSyncShopHours(),
  };
}

async function confirmDialog(question) {
  const d = D2();
  if (d) return d.confirm({ window: { title: "Settlements" }, content: `<p>${question}</p>` }).catch(() => false);
  return new Promise((res) =>
    new Dialog({
      title: "Settlements",
      content: `<p>${question}</p>`,
      buttons: { yes: { label: "Yes", callback: () => res(true) }, no: { label: "No", callback: () => res(false) } },
      default: "yes",
      close: () => res(false),
    }).render(true)
  );
}

/* ------------------------------------------------------------------ *
 * Hub open/close/draw
 * ------------------------------------------------------------------ */

async function openHub(cityId) {
  await loadContent();
  if (cityId && game.user.isGM) await setState({ currentCityId: cityId });
  if (!cities().length) return ui.notifications?.warn("No settlements have been authored yet.");
  hubRoot().style.display = "block";
  S().resetUiState();
  drawHub();
}

function closeHub() {
  hubRoot().style.display = "none";
  hubRoot().innerHTML = "";
}

function toggleHub() {
  if (cardOpen()) return closeCard();
  if (hubOpen()) return closeHub();
  openHub();
}

function drawHub() {
  if (!hubOpen()) return;
  try {
    S().renderCity(hubRoot(), buildCtx());
  } catch (e) {
    console.error(`${MODULE_ID} | could not draw the settlement view`, e);
    closeHub();
    ui.notifications?.error("The settlement view failed to draw — see the console.");
  }
}

/* ------------------------------------------------------------------ *
 * NPC card
 * ------------------------------------------------------------------ */

function closeCard() {
  cardRoot().innerHTML = "";
}

async function openNpcCard(tokenDoc) {
  await loadContent();
  const locId = tokenDoc.getFlag(MODULE_ID, "locId");
  const npcKey = tokenDoc.getFlag(MODULE_ID, "npcKey");
  const { loc } = findLoc(locId);
  const npc = (loc?.npcs || []).find((n) => n.key === npcKey);
  if (!npc) return;

  // The GM gets the full brief; everyone else gets the hand-off card. Tell the GM who is
  // talking to whom so the dossier is already open when the conversation starts.
  if (game.user.isGM) return openDossier(locId, npcKey);
  S().renderNpcCard(cardRoot(), buildCtx(), { ...npc, locId: locId }, loc);
  if (npc.quests?.length) emit({ toGM: true, type: "questGiver", npcKey, locId, userId: game.user.id });
}

function sayLine(npc, line) {
  ChatMessage.create({
    content: `<p><strong>${npc.name}:</strong> &ldquo;${line}&rdquo;</p>`,
    speaker: { alias: npc.name },
  });
}

/**
 * Make sure every shop a location's shopkeepers point at actually exists.
 *
 * The shop module seeds worlds from its own catalogue and deliberately skips a world that
 * already has shops — so a world seeded before a shopkeeper was added never gets that
 * shop, and clicking the keeper only produced "That shop is gone." Each shopkeeper carries
 * the spec needed to mint their own shop, so the GM can just create what is missing.
 */
async function ensureShopsFor(loc) {
  if (!isActiveGM()) return;
  const api = game.modules.get(SHOP_ID)?.api;
  if (!api?.createShop || !api?.getShops) return;
  const existing = api.getShops() || {};
  for (const npc of loc?.npcs || []) {
    if (!npc.shopId || existing[npc.shopId]) continue;
    if (!npc.shop) {
      console.warn(`${MODULE_ID} | ${npc.key} points at ${npc.shopId} but carries no shop spec`);
      continue;
    }
    try {
      await api.createShop({ id: npc.shopId, ...npc.shop });
      console.log(`${MODULE_ID} | created missing shop ${npc.shopId}`);
    } catch (e) {
      console.error(`${MODULE_ID} | could not create ${npc.shopId}`, e);
    }
  }
}

async function openShopFor(shopId, npc) {
  const mod = game.modules.get(SHOP_ID);
  const api = mod?.api;
  if (!api?.openShop) return ui.notifications?.warn("The shop module is not available.");

  const missing = !(api.getShops?.() || {})[shopId];
  if (missing) {
    if (game.user.isGM) {
      const { loc } = findLoc(npc?.locId ?? canvas?.scene?.getFlag(MODULE_ID, "locId"));
      await ensureShopsFor(loc || { npcs: npc ? [npc] : [] });
    } else {
      // Ask the GM to mint it, then try again once they have.
      emit({ toGM: true, type: "ensureShop", shopId, locId: canvas?.scene?.getFlag(MODULE_ID, "locId") });
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  if (!(api.getShops?.() || {})[shopId]) {
    return ui.notifications?.warn("That shop has not been set up yet — ask your GM.");
  }
  closeCard();
  await api.openShop(shopId);
}

/* ------------------------------------------------------------------ *
 * Leave button
 * ------------------------------------------------------------------ */

function drawLeave() {
  const scene = canvas?.scene;
  const locId = scene?.getFlag?.(MODULE_ID, "locId");
  if (!locId || hubOpen()) return S().renderLeave(leaveRoot(), buildCtx(), null);
  const state = getState();
  const inHere = state.whereIs?.[game.user.id] === locId;
  const locked = !!state.leaveLocked?.[locId];
  const { city } = findLoc(locId);
  S().renderLeave(leaveRoot(), buildCtx(), {
    show: (inHere || game.user.isGM) && !locked,
    cityName: city?.name || "the settlement",
  });
}

/* ------------------------------------------------------------------ *
 * Scene building
 * ------------------------------------------------------------------ */

/**
 * Can this location be built as a scene?
 *
 * Two kinds of interior: one analysed off finished map art (`geometry`) and one derived from
 * an authored ASCII floorplan (`plan`). Guarding on `plan` alone silently excluded every
 * analysed map — buildScene returned null ("has no floorplan yet") and Rebuild every scene
 * reported "Rebuilt 0 scenes". Always ask through here.
 */
const buildable = (loc) => !!(loc?.interior?.plan || loc?.interior?.geometry);

function sceneNameFor(city, loc) {
  return `${city.name} — ${loc.name}`;
}

function sceneFor(locId) {
  const { city, loc } = findLoc(locId);
  if (!loc) return null;
  const id = getState().sceneKeys?.[locId];
  return (id && game.scenes.get(id)) || game.scenes.getName(sceneNameFor(city, loc)) || null;
}

/** Make sure a scene's background image is what we asked for, and say so if it will not take. */
async function ensureBackground(scene, src) {
  if (!scene || !src) return;
  const got = () => scene.background?.src || scene.img || null;
  if (got() === src) return;
  try {
    await scene.update({ "background.src": src });
  } catch (e) {
    console.error(`${MODULE_ID} | could not set background.src`, e);
  }
  if (got() !== src) {
    // Older scene shapes used a flat `img` field.
    try { await scene.update({ img: src }); } catch (e) { /* not this version's shape */ }
  }
  if (got() !== src) {
    console.error(`${MODULE_ID} | ${scene.name}: background is "${got()}", wanted "${src}"`);
    ui.notifications?.error(`${scene.name}: could not set the map image. See the console.`);
  } else {
    console.log(`${MODULE_ID} | ${scene.name}: background set to ${src}`);
  }
}

function wallDocs(geo) {
  return geo.walls.map((w) => ({
    c: w.c, move: w.move, sight: w.sight, light: w.light, sound: w.sound, door: w.door, ds: w.ds,
  }));
}

function lightDocs(geo) {
  return geo.lights.map((l) => ({
    x: l.x,
    y: l.y,
    config: {
      dim: l.dim,
      bright: l.bright,
      color: l.color,
      alpha: l.alpha,
      animation: l.animation || { type: null, speed: 5, intensity: 5 },
    },
  }));
}

async function ensureNpcFolder() {
  let f = game.folders.find((x) => x.type === "Actor" && x.name === NPC_FOLDER);
  if (!f) f = await Folder.create({ name: NPC_FOLDER, type: "Actor" });
  return f;
}

/** Reuse a named actor if one exists, otherwise mint a throwaway one for the token art. */
async function actorForNpc(npc) {
  if (npc.actor) {
    const a = game.actors.getName(npc.actor);
    if (a) return a;
  }
  const name = npc.actor || npc.name || "Settlement local";
  const existing = game.actors.getName(name);
  if (existing) return existing;
  const folder = await ensureNpcFolder();
  return Actor.create({
    name,
    type: "npc",
    img: assetPath(npc.portrait) || "icons/svg/mystery-man.svg",
    folder: folder.id,
    prototypeToken: { texture: { src: assetPath(npc.token || npc.portrait) || "icons/svg/mystery-man.svg" } },
  });
}

async function npcTokenDocs(geo, loc) {
  const g = geo.gridSize;
  const out = [];
  const taken = [];
  for (const npc of loc.npcs || []) {
    const actor = await actorForNpc(npc);
    if (!actor) continue;
    let cell = null;
    if (npc.post && geo.posts[npc.post]) cell = geo.posts[npc.post];
    else if (npc.spawnArea) cell = geo.waypoints.find((w) => w.tag === npc.spawnArea);
    if (!cell) cell = geo.waypoints[0] || geo.spawns[0];
    if (!cell) continue;

    // Analysed maps give a precise point (a token's x/y is its top-left, the point is a
    // centre); authored grids give a cell. Then nudge off anyone already standing here —
    // several crowd NPCs share a waypoint and would otherwise spawn in a stack.
    let px = cell.x != null ? Math.round(cell.x - g / 2) : cell.col * g;
    let py = cell.y != null ? Math.round(cell.y - g / 2) : cell.row * g;
    const gap = g * 0.85;
    for (let attempt = 0; attempt < 12 && taken.some((t) => Math.hypot(t.x - px, t.y - py) < gap); attempt++) {
      const angle = (attempt / 12) * Math.PI * 2;
      const ring = g * (0.9 + 0.5 * Math.floor(attempt / 6));
      px = Math.round((cell.x != null ? cell.x - g / 2 : cell.col * g) + Math.cos(angle) * ring);
      py = Math.round((cell.y != null ? cell.y - g / 2 : cell.row * g) + Math.sin(angle) * ring);
    }
    taken.push({ x: px, y: py });

    out.push({
      name: npc.name || actor.name,
      actorId: actor.id,
      actorLink: false,
      x: px,
      y: py,
      width: 1,
      height: 1,
      disposition: npc.hostile ? -1 : npc.shopId ? 1 : 0,
      texture: { src: assetPath(npc.token || npc.portrait) || actor.img },
      sight: { enabled: false },
      lockRotation: true,
      flags: {
        [MODULE_ID]: {
          npcKey: npc.key,
          locId: loc.id,
          shopId: npc.shopId || null,
          wander: !!npc.wander,
          home: { col: Math.round(px / g), row: Math.round(py / g), x: px, y: py },
          radius: Number(npc.radius) || 6,
        },
      },
    });
  }
  return out;
}

/**
 * Create or rebuild the Foundry scene for one location. Idempotent: an existing scene is
 * stripped of module-owned walls, lights and NPC tokens and re-derived, so player tokens
 * and any GM-added props survive a rebuild.
 */
async function buildScene(cityId, locId, { rebuild = false } = {}) {
  const city = cityById(cityId);
  const loc = locById(city, locId);
  if (!city || !buildable(loc)) return null;

  const geo = S().deriveGeometry(loc.interior);
  let scene = sceneFor(locId);

  const core = {
    name: sceneNameFor(city, loc),
    width: geo.width,
    height: geo.height,
    padding: 0,
    background: { src: assetPath(loc.interior.img) },
    // Gridless by default: these maps are illustrated art whose architecture never lines up
    // with a square grid, and a grid drawn over them just fights the picture.
    grid: {
      type: loc.interior.gridless === false ? CONST.GRID_TYPES.SQUARE : CONST.GRID_TYPES.GRIDLESS,
      size: geo.gridSize,
    },
    tokenVision: loc.interior.tokenVision ?? true,
    flags: {
      [MODULE_ID]: {
        cityId, locId,
        spawns: geo.spawns,
        exits: geo.exits,
        posts: geo.posts,
        waypoints: geo.waypoints,
        passable: geo.passable,
        wallSegments: geo.wallSegments || null,
        gridSize: geo.gridSize,
        cols: geo.cols,
        rows: geo.rows,
        geoHash: S().geometryHash(geo, loc.interior.img),
      },
    },
  };
  // Darkness moved from `darkness` to `environment.darknessLevel` at v13. Send whichever
  // the running version actually declares, rather than both.
  const level = Number(loc.interior.darkness ?? 0.55);
  const darkness = "environment" in (Scene.implementation ?? Scene).schema.fields
    ? { environment: { darknessLevel: level } }
    : { darkness: level };

  if (!scene) {
    scene = await Scene.create({ ...core, ...darkness, navigation: false });
  } else if (rebuild) {
    await scene.update({ ...core, ...darkness });
    // Only module-owned documents go. Player tokens and anything the GM added by hand stay.
    const walls = scene.walls.map((d) => d.id);
    const lights = scene.lights.map((d) => d.id);
    const npcTokens = scene.tokens.filter((t) => t.getFlag(MODULE_ID, "npcKey")).map((t) => t.id);
    if (walls.length) await scene.deleteEmbeddedDocuments("Wall", walls);
    if (lights.length) await scene.deleteEmbeddedDocuments("AmbientLight", lights);
    if (npcTokens.length) await scene.deleteEmbeddedDocuments("Token", npcTokens);
  } else {
    return scene;
  }

  // Verify the background actually stuck. A nested TextureData subfield passed inside a
  // larger create/update payload can be dropped; the dot-notation form is the reliable way
  // to set it, and a scene with no background renders as flat grey with the walls and
  // lights present, which looks like the map "not working".
  await ensureBackground(scene, assetPath(loc.interior.img));

  await scene.createEmbeddedDocuments("Wall", wallDocs(geo));
  const lights = lightDocs(geo);
  if (lights.length) await scene.createEmbeddedDocuments("AmbientLight", lights);
  const npcs = await npcTokenDocs(geo, loc);
  if (npcs.length) await scene.createEmbeddedDocuments("Token", npcs);

  const keys = { ...getState().sceneKeys, [locId]: scene.id };
  await setState({ sceneKeys: keys });
  return scene;
}

/**
 * The scene for a location, built if missing and repaired if the content has moved on.
 *
 * A released map change alters the image, its dimensions and every wall coordinate. Without
 * this check the old scene keeps its old size and Foundry stretches the new artwork across
 * it — a blurry, misaligned map whose walls no longer match the picture. Requiring the GM to
 * remember a manual Rebuild after every update is not a fix.
 */
async function ensureScene(cityId, locId) {
  const existing = sceneFor(locId);
  if (!existing) return buildScene(cityId, locId, { rebuild: false });
  if (!isActiveGM()) return existing;

  const city = cityById(cityId);
  const loc = locById(city, locId);
  if (!loc?.interior) return existing;

  const geo = S().deriveGeometry(loc.interior);
  const want = S().geometryHash(geo, loc.interior.img);
  const have = existing.getFlag(MODULE_ID, "geoHash");
  const sized = existing.width === geo.width && existing.height === geo.height;
  if (have === want && sized) return existing;

  console.log(`${MODULE_ID} | ${existing.name} is out of date (${have || "no hash"} -> ${want}); rebuilding`);
  ui.notifications?.info(`${loc.name}: the map changed, rebuilding the scene.`);
  return buildScene(cityId, locId, { rebuild: true });
}

/** Scenes whose map has moved on since they were built. */
function staleScenes() {
  const out = [];
  for (const city of cities()) {
    for (const loc of city.locations || []) {
      if (!loc.interior) continue;
      const scene = sceneFor(loc.id);
      if (!scene) continue;
      try {
        const geo = S().deriveGeometry(loc.interior);
        const want = S().geometryHash(geo, loc.interior.img);
        const sized = scene.width === geo.width && scene.height === geo.height;
        if (scene.getFlag(MODULE_ID, "geoHash") !== want || !sized) out.push({ city, loc, scene });
      } catch (e) { /* a plan we cannot derive is not a staleness problem */ }
    }
  }
  return out;
}

async function gmRebuild(locId) {
  if (!game.user.isGM) return;
  const { city } = findLoc(locId);
  if (!city) return;
  if (!(await confirmDialog("Rebuild this scene from its floorplan? Hand-placed walls and lights in it will be replaced."))) return;
  await loadContent();
  const scene = await buildScene(city.id, locId, { rebuild: true });
  ui.notifications?.info(scene ? `Rebuilt ${scene.name}.` : "That location has no floorplan.");
  drawHub();
}

async function gmRebuildAll() {
  if (!game.user.isGM) return;
  const city = cityById(getState().currentCityId);
  if (!city) return;
  if (!(await confirmDialog(`Rebuild every scene in ${city.name} from its floorplan?`))) return;
  let n = 0;
  for (const loc of city.locations || []) {
    if (!buildable(loc)) continue;
    await buildScene(city.id, loc.id, { rebuild: true });
    n++;
  }
  if (!n) {
    ui.notifications?.warn(`Nothing to rebuild in ${city.name} — no location has a map. This is a bug; check the console.`);
    console.warn(`${MODULE_ID} | rebuildAll found no buildable locations in ${city.id}`,
      (city.locations || []).map((l) => ({ id: l.id, plan: !!l.interior?.plan, geometry: !!l.interior?.geometry })));
  } else {
    ui.notifications?.info(`Rebuilt ${n} scene${n === 1 ? "" : "s"} in ${city.name}.`);
  }
  drawHub();
}

/* ------------------------------------------------------------------ *
 * Entering and leaving
 * ------------------------------------------------------------------ */

function requestEnter(locId) {
  if (game.user.isGM) return gmEnter(game.user.id, locId);
  emit({ toGM: true, type: "enter", userId: game.user.id, locId });
}

function requestLeave() {
  if (game.user.isGM) return gmLeave(game.user.id);
  emit({ toGM: true, type: "leave", userId: game.user.id });
}

function actorForUser(user) {
  return user.character || game.actors.find((a) => a.testUserPermission(user, "OWNER") && a.type === "character") || null;
}

async function gmEnter(userId, locId) {
  if (!isActiveGM()) return;
  await loadContent();
  const { city, loc } = findLoc(locId);
  if (!city || !loc) return;
  const scene = await ensureScene(city.id, locId);
  if (!scene) return ui.notifications?.warn(`${loc.name} has no floorplan yet.`);

  const user = game.users.get(userId);
  const actor = user ? actorForUser(user) : null;
  const spawn = scene.getFlag(MODULE_ID, "spawns")?.[0];
  const g = scene.getFlag(MODULE_ID, "gridSize") || scene.grid?.size || 100;

  if (actor && spawn) {
    const existing = scene.tokens.find((t) => t.actorId === actor.id);
    const pos = { x: spawn.col * g, y: spawn.row * g };
    if (existing) await existing.update(pos);
    else {
      const data = (await actor.getTokenDocument({ ...pos, actorLink: true })).toObject();
      delete data._id;
      await scene.createEmbeddedDocuments("Token", [data]);
    }
  }

  recentEnter.set(userId, Date.now());
  await setState({ whereIs: { ...getState().whereIs, [userId]: locId } });
  await syncShopLocation(city);
  await ensureShopsFor(loc);
  emit({ toUser: userId, type: "view", sceneId: scene.id });
  if (userId === game.user.id) viewScene(scene.id);
  refreshEveryone();
}

async function gmLeave(userId) {
  if (!isActiveGM()) return;
  const state = getState();
  const locId = state.whereIs?.[userId];
  const scene = locId ? sceneFor(locId) : null;
  const user = game.users.get(userId);
  const actor = user ? actorForUser(user) : null;
  if (scene && actor) {
    const mine = scene.tokens.filter((t) => t.actorId === actor.id).map((t) => t.id);
    if (mine.length) await scene.deleteEmbeddedDocuments("Token", mine);
  }
  const whereIs = { ...state.whereIs };
  delete whereIs[userId];
  await setState({ whereIs });
  emit({ toUser: userId, type: "hub" });
  if (userId === game.user.id) openHub();
  refreshEveryone();
}

function viewScene(sceneId) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return;
  closeHub();
  closeCard();
  scene.view();
}

const refreshEveryone = () => emit({ type: "refresh" });

/* ------------------------------------------------------------------ *
 * Walking out of the door
 * ------------------------------------------------------------------ */

const inRect = (px, py, r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;

/* Placing a token at the spawn point fires updateToken. Without a short grace period a
 * spawn near the door would bounce the player straight back out to the hub. */
const recentEnter = new Map();
const justEntered = (userId) => Date.now() - (recentEnter.get(userId) || 0) < 2000;

function onTokenMoved(doc) {
  if (!isActiveGM()) return;
  const scene = doc.parent;
  const locId = scene?.getFlag?.(MODULE_ID, "locId");
  if (!locId) return;
  if (getState().leaveLocked?.[locId]) return;
  const exits = scene.getFlag(MODULE_ID, "exits") || [];
  if (!exits.length) return;
  const g = scene.getFlag(MODULE_ID, "gridSize") || scene.grid?.size || 100;
  const cx = doc.x + (doc.width * g) / 2;
  const cy = doc.y + (doc.height * g) / 2;
  if (!exits.some((r) => inRect(cx, cy, r))) return;
  // Only send out players whose own character is standing in the doorway.
  for (const [userId, where] of Object.entries(getState().whereIs || {})) {
    if (where !== locId) continue;
    const user = game.users.get(userId);
    if (justEntered(userId)) continue;
    if (actorForUser(user)?.id === doc.actorId) gmLeave(userId);
  }
}

/* ------------------------------------------------------------------ *
 * Ambient life: wandering NPCs and idle chatter
 * ------------------------------------------------------------------ */

let wanderTimer = null;

/* Per-token behaviour. Not persisted: tokens carry their own position, and a fresh mind on
 * reload is fine. Modes: "busy" (standing somewhere doing something) and "walking". */
const minds = new Map();
// gmRebuild deletes and recreates NPC tokens with fresh ids, so without this every rebuild
// left its predecessors' entries behind for the lifetime of the session — and spotTaken
// walks this map for every candidate spot.
Hooks.on("deleteToken", (doc) => { minds.delete(doc.id); });

function settlementScenes() {
  return game.scenes.filter((s) => s.getFlag(MODULE_ID, "locId"));
}

function sceneHasAudience(scene) {
  return game.users.some((u) => u.active && u.viewedScene === scene.id);
}

const randInt = (n) => Math.floor(Math.random() * n);

/** How close two people will stand. Kept in step units so it scales with the map. */
const personalSpace = (g) => g * 0.85;

/**
 * Is this spot already taken — by another token standing there, or by another NPC on their
 * way to it? Without the second check two of them pick the same stool and end up stacked.
 */
function spotTaken(scene, token, x, y, gap) {
  for (const other of scene.tokens) {
    if (other.id === token.id) continue;
    if (Math.hypot(other.x - x, other.y - y) < gap) return true;
    const mind = minds.get(other.id);
    if (mind?.target && Math.hypot(mind.target.x - x, mind.target.y - y) < gap) return true;
  }
  return false;
}
const randRange = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[randInt(arr.length)];

/** Would a straight walk from one point to another go through a wall? */
function blockedBy(segs, x0, y0, x1, y1) {
  if (!segs?.length) return false;
  return segs.some((c) => S().segmentsCross(x0, y0, x1, y1, c[0], c[1], c[2], c[3]));
}

function mindFor(scene, token) {
  let m = minds.get(token.id);
  if (!m) {
    const g = scene.getFlag(MODULE_ID, "gridSize") || 100;
    const home = token.getFlag(MODULE_ID, "home");
    m = {
      mode: "busy",
      until: Date.now() + randInt(6000),
      anchor: home
        ? { x: home.x ?? home.col * g, y: home.y ?? home.row * g }
        : { x: token.x, y: token.y },
      target: null,
    };
    minds.set(token.id, m);
  }
  return m;
}

/**
 * Choose somewhere worth standing: a waypoint the artist's map suggests, or a point near
 * this NPC's own patch. Rejects anything on the far side of a wall.
 */
function chooseSpot(scene, token, from) {
  const g = scene.getFlag(MODULE_ID, "gridSize") || 100;
  const segs = scene.getFlag(MODULE_ID, "wallSegments");
  const waypoints = scene.getFlag(MODULE_ID, "waypoints") || [];
  const radius = (token.getFlag(MODULE_ID, "radius") || 6) * g;
  const anchor = mindFor(scene, token).anchor;

  const candidates = [];
  for (const w of waypoints) {
    const p = { x: w.x ?? w.col * g, y: w.y ?? w.row * g };
    if (Math.hypot(p.x - anchor.x, p.y - anchor.y) <= radius * 1.6) candidates.push(p);
  }
  for (let i = 0; i < 10; i++) {
    candidates.push({
      x: anchor.x + randRange(-radius, radius),
      y: anchor.y + randRange(-radius, radius),
    });
  }

  const W = scene.width || scene.dimensions?.width || 0;
  const H = scene.height || scene.dimensions?.height || 0;
  for (const p of candidates.sort(() => Math.random() - 0.5)) {
    const jitter = { x: p.x + randRange(-g * 0.3, g * 0.3), y: p.y + randRange(-g * 0.3, g * 0.3) };
    if (jitter.x < g * 0.3 || jitter.y < g * 0.3 || (W && jitter.x > W - g) || (H && jitter.y > H - g)) continue;
    if (blockedBy(segs, from.x + g / 2, from.y + g / 2, jitter.x + g / 2, jitter.y + g / 2)) continue;
    if (spotTaken(scene, token, jitter.x, jitter.y, personalSpace(g))) continue;
    return jitter;
  }
  return null;
}

/** One beat of one NPC's life. */
async function stepNpc(scene, token) {
  const now = Date.now();
  const m = mindFor(scene, token);
  const g = scene.getFlag(MODULE_ID, "gridSize") || 100;
  const here = { x: token.x, y: token.y };

  if (m.mode === "busy") {
    if (now < m.until) return;
    const spot = chooseSpot(scene, token, here);
    if (!spot) { m.until = now + randRange(4000, 9000); return; }
    m.target = spot;
    m.mode = "walking";
  }

  if (m.mode === "walking" && m.target) {
    const dx = m.target.x - here.x;
    const dy = m.target.y - here.y;
    const dist = Math.hypot(dx, dy);
    // Arrived: stop and do whatever it is they came over here to do.
    if (dist < g * 0.35) {
      m.mode = "busy";
      m.target = null;
      m.until = now + randRange(6000, 22000);
      return;
    }
    const speed = g * randRange(0.5, 0.85);
    const stepLen = Math.min(speed, dist);
    const nx = here.x + (dx / dist) * stepLen;
    const ny = here.y + (dy / dist) * stepLen;
    const segs = scene.getFlag(MODULE_ID, "wallSegments");
    if (blockedBy(segs, here.x + g / 2, here.y + g / 2, nx + g / 2, ny + g / 2)) {
      // Walked into something. Give up on this errand rather than grinding at the wall.
      m.mode = "busy";
      m.target = null;
      m.until = now + randRange(2000, 5000);
      return;
    }
    // Never walk onto someone. Try to slip past them, and wait a beat if there is no room.
    const gap = personalSpace(g);
    if (spotTaken(scene, token, nx, ny, gap)) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const sx = here.x + (-dy / dist) * stepLen * 0.8 * side;
      const sy = here.y + (dx / dist) * stepLen * 0.8 * side;
      const canSidestep = !blockedBy(segs, here.x + g / 2, here.y + g / 2, sx + g / 2, sy + g / 2)
        && !spotTaken(scene, token, sx, sy, gap);
      if (!canSidestep) {
        m.until = now + randRange(1200, 3000);
        m.mode = "busy";
        m.target = null;
        return;
      }
      await token.update({ x: Math.round(sx), y: Math.round(sy) }, { animate: true });
      return;
    }
    await token.update({ x: Math.round(nx), y: Math.round(ny) }, { animate: true });
  }
}

async function wanderTick() {
  if (!isActiveGM()) return;
  if (game.paused) return;
  if (!game.settings.get(MODULE_ID, "wander")) return;
  for (const scene of settlementScenes()) {
    if (!sceneHasAudience(scene)) continue;
    if (game.combats.some((c) => c.scene?.id === scene.id && c.started)) continue;
    const locId = scene.getFlag(MODULE_ID, "locId");
    const { loc } = findLoc(locId);
    const hours = loc?.openHours;
    if (Array.isArray(hours) && hours.length && !hours.includes(getState().timeOfDay)) continue;

    for (const token of scene.tokens) {
      if (!token.getFlag(MODULE_ID, "wander")) continue;
      try {
        await stepNpc(scene, token);
      } catch (e) {
        console.error(`${MODULE_ID} | npc step failed`, e);
      }
    }
  }
  maybeChatter();
}

let lastChatter = 0;
function maybeChatter() {
  if (game.paused) return;
  if (!game.settings.get(MODULE_ID, "chatter")) return;
  const now = Date.now();
  if (now - lastChatter < 18000) return;
  for (const scene of settlementScenes()) {
    if (!sceneHasAudience(scene)) continue;
    const { loc } = findLoc(scene.getFlag(MODULE_ID, "locId"));
    const lines = loc?.chatter || [];
    if (!lines.length) continue;
    // Someone standing still is far more likely to be the one talking.
    const speakers = scene.tokens.filter((t) => t.getFlag(MODULE_ID, "npcKey"));
    const idle = speakers.filter((t) => minds.get(t.id)?.mode === "busy");
    const who = pick(idle.length ? idle : speakers);
    if (!who) continue;
    lastChatter = now;
    const line = pick(lines);
    emit({ type: "bubble", sceneId: scene.id, tokenId: who.id, line });
    showBubble(scene.id, who.id, line);
    return;
  }
}

function showBubble(sceneId, tokenId, line) {
  if (canvas?.scene?.id !== sceneId) return;
  const token = canvas.tokens?.get(tokenId);
  const bubbles = canvas.hud?.bubbles;
  if (!token || !bubbles) return;
  try {
    if (bubbles.broadcast) bubbles.broadcast(token, line);
    else bubbles.say(token, line);
  } catch (e) { /* a missing bubble is not worth an error */ }
}

function startWander() {
  stopWander();
  // Only a GM ever drives NPC movement (wanderTick returns immediately otherwise), so
  // player clients have no reason to wake on this interval at all. Gate on isGM rather
  // than isActiveGM so GM handover still works — wanderTick re-checks isActiveGM itself.
  if (!game.user.isGM) return;
  const ms = Number(game.settings.get(MODULE_ID, "wanderMs")) || 2500;
  wanderTimer = setInterval(() => {
    // Nothing to animate while the tab is hidden; the next visible tick picks it up.
    if (document.hidden) return;
    wanderTick().catch((e) => console.error(`${MODULE_ID} |`, e));
  }, ms);
}
function stopWander() {
  if (wanderTimer) clearInterval(wanderTimer);
  wanderTimer = null;
}

/* ------------------------------------------------------------------ *
 * Quest-givers
 * ------------------------------------------------------------------ */

const JOURNAL_ID = "ssv-silver-gull-journal";
const journalApi = () => game.modules.get(JOURNAL_ID)?.api || null;

let _dossier = null; // {npcKey, locId}

function closeDossier() {
  _dossier = null;
  dossierRoot().innerHTML = "";
}

function npcAt(locId, npcKey) {
  const { city, loc } = findLoc(locId);
  const npc = (loc?.npcs || []).find((n) => n.key === npcKey) || null;
  return { city, loc, npc };
}

function openDossier(locId, npcKey) {
  if (!game.user.isGM) return;
  const { loc, npc } = npcAt(locId, npcKey);
  if (!npc) return;
  _dossier = { npcKey, locId };
  S().renderDossier(dossierRoot(), buildCtx(), npc, loc);
}

function drawDossier() {
  if (!_dossier) return;
  openDossier(_dossier.locId, _dossier.npcKey);
}

/** Titles of jobs this person has already given the party — shown on the player's card. */
function acceptedTitles(npc, loc) {
  const state = getState();
  const api = journalApi();
  return (npc.quests || [])
    .map((q, i) => ({ q, key: S().questKey(loc, npc, q, i) }))
    .filter(({ key }) => ["accepted", "ready", "complete"].includes(S().stageOf(state, key)))
    .map(({ q }) => (q.id && api?.getQuest?.(q.id)?.name) || q.title || q.id)
    .filter(Boolean);
}

/**
 * Move a quest to its next stage, mirroring into the journal.
 *
 * Our four stages do not map one-to-one: the journal only knows hidden / active / complete,
 * so "ready to hand in" is ours alone and simply does not touch it.
 */
async function gmAdvanceQuest(key, quest, npc, locId) {
  if (!isActiveGM()) return;
  const state = getState();
  const from = S().stageOf(state, key);
  const to = { offered: "accepted", accepted: "ready", ready: "complete" }[from];
  if (!to) return;

  await setState({ quests: { ...state.quests, [key]: to } });

  const api = journalApi();
  if (quest?.id && api) {
    try {
      if (to === "accepted") await api.revealQuest(quest.id);
      if (to === "complete") await api.setQuestStatus(quest.id, "complete");
      api.refresh?.();
    } catch (e) {
      console.error(`${MODULE_ID} | journal update failed for ${quest.id}`, e);
      ui.notifications?.warn("Could not update the journal — see the console.");
    }
  }

  const name = (quest?.id && api?.getQuest?.(quest.id)?.name) || quest?.title || "the job";
  if (to === "accepted") {
    ChatMessage.create({ content: `<p><em>${npc?.name || "Someone"} gives the crew a job: <strong>${name}</strong>.</em></p>` });
  }
  if (to === "complete") {
    await payoutQuest(quest, npc);
    ChatMessage.create({ content: `<p><em><strong>${name}</strong> — settled up with ${npc?.name || "someone"}.</em></p>` });
  }
  refreshEveryone();
  refreshLocal();
}

async function gmStepQuestBack(key) {
  if (!isActiveGM()) return;
  const state = getState();
  const from = S().stageOf(state, key);
  const to = { accepted: "offered", ready: "accepted", complete: "ready" }[from];
  if (!to) return;
  await setState({ quests: { ...state.quests, [key]: to } });
  refreshEveryone();
  refreshLocal();
}

/**
 * Hand over a reward. Every step is optional and degrades to a note if that module is off,
 * so a missing sibling never blocks the rest of the payout.
 */
async function payoutQuest(quest, npc) {
  if (!game.user.isGM) return;
  const reward = quest?.reward;
  if (!reward) return;
  const shop = game.modules.get(SHOP_ID)?.api;
  const done = [];

  if (reward.gold) {
    if (shop?.awardTreasury) {
      // The treasury is integer copper; gp is display only.
      await shop.awardTreasury(Math.round(reward.gold * 100), `Quest reward — ${npc?.name || "quest"}`);
      done.push(`${reward.gold} gp to the treasury`);
    } else done.push(`${reward.gold} gp (shop module off — pay by hand)`);
  }

  if (reward.item) {
    if (shop?.grantItem) {
      const res = await shop.grantItem({ catId: reward.item, qty: reward.qty || 1, dest: reward.dest || "ship" });
      done.push(res?.ok ? `${res.name}${res.qty > 1 ? ` ×${res.qty}` : ""} to ${res.actor}`
                        : `item failed: ${res?.reason || "unknown"}`);
    } else done.push(`${reward.item} (shop module off — hand it over yourself)`);
  }

  if (reward.standing) {
    const pol = game.modules.get(POLITICS_ID)?.api;
    if (pol?.adjustStanding) {
      await pol.adjustStanding(reward.standing.faction, reward.standing.delta,
        `Quest — ${npc?.name || "settlement"}`);
      done.push(`${reward.standing.faction} ${reward.standing.delta >= 0 ? "+" : ""}${reward.standing.delta}`);
    } else done.push(`standing change (politics module off)`);
  }

  if (done.length) {
    ChatMessage.create({ content: `<p><strong>Paid out:</strong> ${done.join(" · ")}</p>` });
    ui.notifications?.info(`Paid out: ${done.join(", ")}`);
  }
}

/** Every quest-giver in a settlement, with how far along each of their jobs is. */
function questGiversIn(city) {
  const state = getState();
  const out = [];
  for (const loc of city?.locations || []) {
    for (const npc of loc.npcs || []) {
      if (!npc.quests?.length) continue;
      out.push({
        locId: loc.id, locName: loc.name, npcKey: npc.key, name: npc.name,
        stages: npc.quests.map((q, i) => S().stageOf(state, S().questKey(loc, npc, q, i))),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Quest markers over tokens
 * ------------------------------------------------------------------ *
 *
 * Drawn as our own PIXI child on the Token rather than via TokenDocument#overlayEffect,
 * whose schema moved between v12 and v13. Everything is guarded: a marker that fails to
 * draw must never take the canvas down with it.
 */

const MARKER = "ssvsetQuestMarker";

function markerWanted(tokenDoc) {
  if (!game.settings.get(MODULE_ID, "questMarkers")) return false;
  const npcKey = tokenDoc.getFlag(MODULE_ID, "npcKey");
  const locId = tokenDoc.getFlag(MODULE_ID, "locId");
  if (!npcKey || !locId) return false;
  const { npc } = npcAt(locId, npcKey);
  if (!npc?.quests?.length) return false;
  return S().pendingQuests(npc, getState()).length > 0;
}

function drawMarker(token) {
  try {
    const want = markerWanted(token.document);
    const existing = token[MARKER];
    if (!want) {
      if (existing) { existing.destroy({ children: true }); token[MARKER] = null; }
      return;
    }
    if (existing && !existing.destroyed) {
      existing.x = token.w / 2;
      existing.y = -8;
      return;
    }
    const g = new PIXI.Container();
    const size = Math.max(14, Math.min(28, token.w * 0.28));
    const glow = new PIXI.Graphics();
    glow.beginFill(0xf2b03d, 0.22).drawCircle(0, 0, size * 0.9).endFill();
    const mark = new PIXI.Graphics();
    mark.beginFill(0xf2b03d, 1).lineStyle(2, 0x2b1c06, 1)
      .moveTo(0, -size * 0.55)
      .lineTo(size * 0.34, size * 0.45)
      .lineTo(-size * 0.34, size * 0.45)
      .closePath().endFill();
    g.addChild(glow, mark);
    g.x = token.w / 2;
    g.y = -8;
    token[MARKER] = token.addChild(g);
  } catch (e) {
    console.warn(`${MODULE_ID} | quest marker failed`, e);
  }
}

function refreshMarkers() {
  if (!canvas?.ready) return;
  for (const token of canvas.tokens?.placeables || []) drawMarker(token);
}

/* ------------------------------------------------------------------ *
 * Shop bridge
 * ------------------------------------------------------------------ */

async function syncShopLocation(city) {
  if (!game.user.isGM || !city?.shopLocationId) return;
  const api = game.modules.get(SHOP_ID)?.api;
  if (!api?.setLocation) return;
  try { await api.setLocation(city.shopLocationId); } catch (e) { /* shop may be mid-load */ }
}

/** Flip each shop's open flag to match the settlement's opening hours. */
async function gmSyncShopHours() {
  if (!game.user.isGM) return;
  const mod = game.modules.get(SHOP_ID);
  if (!mod?.active) return ui.notifications?.warn("The shop module is not active.");
  const city = cityById(getState().currentCityId);
  const tod = getState().timeOfDay;
  const shops = foundry.utils.duplicate(game.settings.get(SHOP_ID, "shops") || {});
  let n = 0;
  for (const loc of city?.locations || []) {
    const hours = Array.isArray(loc.openHours) && loc.openHours.length ? loc.openHours : null;
    for (const npc of loc.npcs || []) {
      if (!npc.shopId || !shops[npc.shopId]) continue;
      const open = hours ? hours.includes(tod) : true;
      if (shops[npc.shopId].open !== open) { shops[npc.shopId].open = open; n++; }
    }
  }
  await game.settings.set(SHOP_ID, "shops", shops);
  ui.notifications?.info(`Updated ${n} shop${n === 1 ? "" : "s"} for ${tod}.`);
}

/* ------------------------------------------------------------------ *
 * GM-routed actions
 * ------------------------------------------------------------------ */

function gmCall(type, payload) {
  if (game.user.isGM) return handleGm({ type, ...payload });
  emit({ toGM: true, type, ...payload });
}

async function handleGm(msg) {
  if (!isActiveGM()) return;
  const state = getState();
  switch (msg.type) {
    case "enter": return gmEnter(msg.userId, msg.locId);
    case "leave": return gmLeave(msg.userId);
    case "recall": return gmLeave(msg.userId);
    case "questGiver": {
      // A player walked up to a quest-giver: open the brief and say who it was.
      openDossier(msg.locId, msg.npcKey);
      const { npc } = npcAt(msg.locId, msg.npcKey);
      const who = game.users.get(msg.userId);
      ChatMessage.create({
        content: `<p><em>${who?.character?.name || who?.name || "Someone"} approaches <strong>${npc?.name || "an NPC"}</strong>.</em></p>`,
        whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
      });
      return;
    }
    case "ensureShop": {
      const { loc } = findLoc(msg.locId);
      if (loc) await ensureShopsFor(loc);
      return;
    }
    case "setTimeOfDay":
      await setState({ timeOfDay: msg.t });
      break;
    case "setCity":
      await setState({ currentCityId: msg.id });
      await syncShopLocation(cityById(msg.id));
      break;
    case "reveal":
      await setState({ discovered: { ...state.discovered, [msg.locId]: !!msg.v } });
      break;
    case "setLocked":
      await setState({ locked: { ...state.locked, [msg.locId]: !!msg.v } });
      break;
    case "setLeaveLock":
      await setState({ leaveLocked: { ...state.leaveLocked, [msg.locId]: !!msg.v } });
      break;
    default:
      return;
  }
  refreshEveryone();
  refreshLocal();
}

/* ------------------------------------------------------------------ *
 * Socket
 * ------------------------------------------------------------------ */

function emit(msg) {
  game.socket.emit(SOCKET, msg);
}

function onSocket(msg) {
  if (!msg) return;
  if (msg.toGM) return void handleGm(msg);
  if (msg.toUser && msg.toUser !== game.user.id) return;
  switch (msg.type) {
    case "view": return viewScene(msg.sceneId);
    case "hub": return void openHub();
    case "refresh": return refreshLocal();
    case "bubble": return showBubble(msg.sceneId, msg.tokenId, msg.line);
  }
}

function refreshLocal() {
  drawHub();
  drawLeave();
  drawDossier();
  refreshMarkers();
}

/* ------------------------------------------------------------------ *
 * Token click → NPC card
 * ------------------------------------------------------------------ */

let clickPatched = false;
function patchTokenClick() {
  if (clickPatched) return;
  const proto = CONFIG.Token?.objectClass?.prototype;
  if (!proto?._onClickLeft) return;
  const original = proto._onClickLeft;
  proto._onClickLeft = function (event) {
    try {
      const npcKey = this.document?.getFlag?.(MODULE_ID, "npcKey");
      // A GM holding Alt gets the normal select behaviour, so tokens stay editable.
      const KM = globalThis.KeyboardManager ?? foundry.helpers?.interaction?.KeyboardManager;
      const altHeld = KM && game.keyboard?.isModifierActive?.(KM.MODIFIER_KEYS.ALT);
      if (npcKey && !(game.user.isGM && altHeld)) {
        // Run Foundry's handler first and *then* open the card. Returning early here left
        // the canvas interaction manager mid-click, which wedged Escape until reload.
        const result = original.call(this, event);
        openNpcCard(this.document);
        return result;
      }
    } catch (e) { /* fall through to Foundry's own handler */ }
    return original.call(this, event);
  };
  clickPatched = true;
}

/* ------------------------------------------------------------------ *
 * Combat auto-locks the way out
 * ------------------------------------------------------------------ */

async function setCombatLock(locId, should) {
  if (!isActiveGM() || !locId) return;
  if (!game.settings.get(MODULE_ID, "autoLockInCombat")) return;
  const state = getState();
  if (!!state.leaveLocked?.[locId] === should) return;
  await setState({ leaveLocked: { ...state.leaveLocked, [locId]: should } });
  refreshEveryone();
  refreshLocal();
}

const combatLocId = (combat) => combat?.scene?.getFlag?.(MODULE_ID, "locId") || null;

/* ------------------------------------------------------------------ *
 * Init / ready
 * ------------------------------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "state", {
    scope: "world", config: false, type: Object, default: {},
    onChange: () => { invalidateState(); refreshLocal(); },
  });
  const bool = (key, def) =>
    game.settings.register(MODULE_ID, key, {
      name: game.i18n.localize(`${MODULE_ID}.settings.${key}.name`),
      hint: game.i18n.localize(`${MODULE_ID}.settings.${key}.hint`),
      scope: "world", config: true, type: Boolean, default: def,
    });
  bool("questMarkers", true);
  bool("wander", true);
  bool("chatter", true);
  bool("autoLockInCombat", true);
  game.settings.register(MODULE_ID, "wanderMs", {
    name: game.i18n.localize(`${MODULE_ID}.settings.wanderMs.name`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.wanderMs.hint`),
    scope: "world", config: true, type: Number, default: 2500,
    range: { min: 800, max: 8000, step: 100 },
  });

  /* Escape closes our overlays, and otherwise gets out of the way.
   *
   * This used to be a capture-phase window listener that called stopImmediatePropagation.
   * That is a bad way to take a key off Foundry: anything it swallows is gone, and a
   * stale overlay flag meant Escape stopped reaching Foundry's own dismiss handler
   * entirely — no main menu until you rejoined. Registering at PRIORITY and returning
   * false when we have nothing open hands the key straight back to core. */
  game.keybindings.register(MODULE_ID, "dismiss", {
    name: game.i18n.localize(`${MODULE_ID}.keybind.dismiss.name`),
    hint: game.i18n.localize(`${MODULE_ID}.keybind.dismiss.hint`),
    editable: [{ key: "Escape" }],
    precedence: CONST.KEYBINDING_PRECEDENCE?.PRIORITY ?? 0,
    onDown: () => {
      if (cardOpen()) { closeCard(); return true; }
      if (_dossier) { closeDossier(); return true; }
      if (hubOpen()) { closeHub(); return true; }
      return false;
    },
  });

  game.keybindings.register(MODULE_ID, "open", {
    name: game.i18n.localize(`${MODULE_ID}.keybind.open.name`),
    hint: game.i18n.localize(`${MODULE_ID}.keybind.open.hint`),
    editable: [{ key: "KeyC" }],
    onDown: () => { toggleHub(); return true; },
  });
});

Hooks.on("getSceneControlButtons", (controls) => {
  const tool = {
    name: "ssv-settlements",
    title: game.i18n.localize(`${MODULE_ID}.control`),
    icon: "fas fa-city",
    button: true,
    visible: true,
    onClick: () => toggleHub(),
    onChange: () => toggleHub(),
  };
  // v13+ hands over a keyed object; v12 an array.
  if (Array.isArray(controls)) {
    controls.find((c) => c.name === "token")?.tools?.push(tool);
  } else {
    const token = controls.token || controls.tokens;
    if (token?.tools) token.tools[tool.name] = { ...tool, order: 99 };
  }
});

Hooks.once("ready", async () => {
  await loadContent();
  hubRoot().style.display = "none";
  hubRoot().innerHTML = "";
  closeCard();
  closeDossier();
  leaveRoot().innerHTML = "";

  if (game.user.isGM) {
    const state = getState();
    if (!state.currentCityId && cities().length) await setState({ currentCityId: cities()[0].id });
  }

  // A content update changes map dimensions and every wall coordinate. Say so on load
  // rather than letting the GM discover it as a stretched, misaligned map mid-session.
  if (isActiveGM()) {
    const stale = staleScenes();
    if (stale.length) {
      ui.notifications?.warn(
        `Settlements: ${stale.length} scene${stale.length === 1 ? "" : "s"} built from an older map. ` +
        `Press C, open the GM panel and use Rebuild every scene — or just walk in, which repairs it.`,
        { permanent: true }
      );
      console.log(`${MODULE_ID} | stale scenes:`, stale.map((x) => x.scene.name));
    }
  }

  game.socket.on(SOCKET, onSocket);
  patchTokenClick();
  startWander();

  Hooks.on("updateToken", (doc, change) => {
    if (("x" in change || "y" in change)) onTokenMoved(doc);
  });
  Hooks.on("canvasReady", () => { drawLeave(); refreshMarkers(); });
  Hooks.on("drawToken", (token) => drawMarker(token));
  Hooks.on("refreshToken", (token) => drawMarker(token));
  Hooks.on("updateCombat", (combat) => setCombatLock(combatLocId(combat), !!combat.started));
  Hooks.on("deleteCombat", (combat) => setCombatLock(combatLocId(combat), false));

  drawLeave();

  const api = {
    open: openHub,
    close: closeHub,
    /** Escape hatch: shut every overlay this module owns, from the console. */
    closeAll: () => { closeCard(); closeHub(); closeDossier(); leaveRoot().innerHTML = ""; },
    openDossier,
    questGivers: () => questGiversIn(cityById(getState().currentCityId)),
    setQuestStage: async (key, stage) => {
      if (!game.user.isGM) return;
      await setState({ quests: { ...getState().quests, [key]: stage } });
      refreshEveryone();
      refreshLocal();
    },
    toggle: toggleHub,
    enter: requestEnter,
    leave: requestLeave,
    reveal: (locId, v = true) => gmCall("reveal", { locId, v }),
    setLocked: (locId, v = true) => gmCall("setLocked", { locId, v }),
    setLeaveLock: (locId, v = true) => gmCall("setLeaveLock", { locId, v }),
    setTimeOfDay: (t) => gmCall("setTimeOfDay", { t }),
    setCity: (id) => gmCall("setCity", { id }),
    rebuild: gmRebuild,
    rebuildAll: gmRebuildAll,
    staleScenes: () => staleScenes().map((x) => x.scene.name),
    /** What every settlement scene actually has on it — for diagnosing a blank map. */
    inspectScenes: () => {
      const rows = [];
      for (const city of cities()) {
        for (const loc of city.locations || []) {
          const scene = sceneFor(loc.id);
          if (!scene) { rows.push({ loc: loc.id, scene: "(none)" }); continue; }
          rows.push({
            loc: loc.id, scene: scene.name,
            background: scene.background?.src || scene.img || "(none)",
            wanted: assetPath(loc.interior?.img),
            size: `${scene.width}x${scene.height}`,
            walls: scene.walls.size, lights: scene.lights.size,
            grid: `${scene.grid?.type}/${scene.grid?.size}`,
          });
        }
      }
      console.table(rows);
      return rows;
    },
    fixBackgrounds: async () => {
      if (!game.user.isGM) return;
      let n = 0;
      for (const city of cities()) {
        for (const loc of city.locations || []) {
          const scene = sceneFor(loc.id);
          if (!scene || !loc.interior?.img) continue;
          await ensureBackground(scene, assetPath(loc.interior.img));
          n++;
        }
      }
      ui.notifications?.info(`Checked the map image on ${n} scene(s).`);
      return n;
    },
    getContent: () => CONTENT,
    getState,
    geometryFor: (locId) => {
      const { loc } = findLoc(locId);
      return loc?.interior ? S().deriveGeometry(loc.interior) : null;
    },
  };
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
  globalThis.SilverGullSettlements = api;

  console.log(`${MODULE_ID} | ready — ${cities().length} settlement(s) loaded`);
});
