/**
 * The home scene — where the campaign sits when it is not anywhere.
 *
 * A plain static backdrop with a row of launchers along the bottom. Deliberately not a
 * dashboard: the modules it opens already show the ship's state far better than a summary
 * panel would, and a home screen that tries to be a second UI just goes stale.
 *
 * It also fixes a real problem — a world with no obvious "current" scene ends up with
 * whatever Foundry last promoted as active, which is how a locked dungeon became the thing
 * players would land on.
 */

const MODULE_ID = "ssv-silver-gull-settlements";
const HOME_IMG = `modules/${MODULE_ID}/assets/home/bridge.webp`;
const BAR_ID = "ssvset-home";

/** Every SSV module that has somewhere to go, with the key that already opens it. */
const LAUNCHERS = [
  { id: "ssv-silver-gull-settlements", key: "G", label: "Settlement",
    hint: "Where you are", open: () => globalThis.SilverGullSettlements?.open() },
  { id: "ssv-silver-gull-sundowner", key: "B", label: "Sundowner",
    hint: "Black market", open: (m) => m.api?.open?.() },
  // `api.open?.() ?? pressKey()` would fire BOTH when open() exists and returns undefined,
  // which is the normal case — opening the journal and then toggling it shut again.
  { id: "ssv-silver-gull-journal", key: "J", label: "Journal",
    hint: "Quests, lore, standing",
    open: (m) => (typeof m.api?.open === "function" ? m.api.open() : pressKey("KeyJ")) },
  { id: "ssv-silver-gull-ship-combat", key: "S", label: "The Gull",
    hint: "Ship and stations", open: (m) => m.api?.open?.() },
];
// Trade (I) and Standing (P) are deliberately not here: a shop is reached by talking to its
// keeper, and standing is a tab inside the journal. Both keys still work.

/** The journal has no open() in its API, so fall back to the key it already binds. */
function pressKey(code) {
  const ev = { key: code.replace("Key", "").toLowerCase(), code, bubbles: true };
  window.dispatchEvent(new KeyboardEvent("keydown", ev));
  window.dispatchEvent(new KeyboardEvent("keyup", ev));
}

const CSS = `
#${BAR_ID}{position:fixed;left:26px;top:50%;transform:translateY(-50%);z-index:28;
  width:246px;padding:16px 14px 13px;border-radius:16px;
  background:linear-gradient(180deg,rgba(6,17,26,.82),rgba(3,10,17,.88));
  border:1px solid rgba(95,208,196,.26);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:0 18px 50px rgba(0,0,0,.6), inset 0 1px 0 rgba(140,235,225,.12);
  font-family:'Courier New',monospace;pointer-events:auto;}
#${BAR_ID} .hd{font-size:10px;letter-spacing:.3em;text-transform:uppercase;
  color:rgba(95,208,196,.75);padding:0 4px 11px;border-bottom:1px solid rgba(95,208,196,.16);
  margin-bottom:9px;}
#${BAR_ID} .row{display:flex;align-items:center;gap:12px;width:100%;
  padding:9px 8px;margin:0;border:0;border-radius:10px;cursor:pointer;
  background:transparent;color:#cfeae6;font-family:inherit;text-align:left;
  transition:background .13s ease, transform .13s ease;}
#${BAR_ID} .row:hover{background:rgba(95,208,196,.1);transform:translateX(3px);}
#${BAR_ID} .row:hover .cap{border-color:rgba(95,208,196,.85);color:#eafffb;
  box-shadow:0 0 14px rgba(95,208,196,.35), inset 0 1px 0 rgba(200,255,250,.35);}
#${BAR_ID} .cap{flex:0 0 34px;height:34px;display:flex;align-items:center;justify-content:center;
  border-radius:8px;font-size:16px;font-weight:700;color:#9fe8de;
  background:linear-gradient(180deg,rgba(22,58,74,.95),rgba(8,24,34,.95));
  border:1px solid rgba(95,208,196,.42);
  box-shadow:inset 0 1px 0 rgba(160,255,245,.22), 0 2px 5px rgba(0,0,0,.5);
  transition:border-color .13s ease, box-shadow .13s ease, color .13s ease;}
#${BAR_ID} .tx{min-width:0;}
#${BAR_ID} .lb{display:block;font-size:12.5px;letter-spacing:.13em;text-transform:uppercase;
  line-height:1.25;}
#${BAR_ID} .ht{display:block;font-size:10.5px;letter-spacing:.04em;color:rgba(160,196,192,.62);
  text-transform:none;margin-top:2px;}
#${BAR_ID} .ft{font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;
  color:rgba(160,196,192,.4);padding:10px 4px 0;margin-top:7px;
  border-top:1px solid rgba(95,208,196,.13);}
/* The macro hotbar is dead weight on a static home screen, and the sidebar crowds the art. */
body.ssvset-at-home #hotbar{display:none;}
@media (max-height:620px){#${BAR_ID} .ht{display:none;} #${BAR_ID} .row{padding:7px 8px;}}
@media (max-width:900px){#${BAR_ID}{width:auto;} #${BAR_ID} .tx{display:none;}}
`;

function ensureStyles() {
  if (document.getElementById(BAR_ID + "-css")) return;
  const el = document.createElement("style");
  el.id = BAR_ID + "-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}

const isHome = () => !!canvas?.scene?.getFlag(MODULE_ID, "homeScene");

function removeBar() {
  document.getElementById(BAR_ID)?.remove();
  document.body.classList.remove("ssvset-at-home");
}

function drawBar() {
  removeBar();
  document.body.classList.toggle("ssvset-at-home", isHome());
  if (!isHome()) return;
  ensureStyles();
  const bar = document.createElement("div");
  bar.id = BAR_ID;
  const live = LAUNCHERS.filter((l) => game.modules.get(l.id)?.active);
  bar.innerHTML =
    `<div class="hd">SSV Silver Gull</div>` +
    live.map((l) => `
    <button class="row" data-mod="${l.id}" title="${l.label} — press ${l.key}">
      <span class="cap">${l.key}</span>
      <span class="tx"><span class="lb">${l.label}</span><span class="ht">${l.hint}</span></span>
    </button>`).join("") +
    `<div class="ft">Press the key or click</div>`;
  bar.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const l = LAUNCHERS.find((x) => x.id === b.dataset.mod);
    const mod = game.modules.get(l.id);
    try { l.open(mod); }
    catch (e) { console.error(`${MODULE_ID} | could not open ${l.id}`, e); ui.notifications?.warn(`${l.label} would not open.`); }
  }));
  document.body.appendChild(bar);
}

/**
 * Create the home scene, or bring an existing one up to date.
 *
 * Nothing to walk around on: no walls, no vision, no fog, lit. It is a picture with
 * buttons, and the moment a token needs to move the party should be somewhere else.
 */
async function ensureHomeScene({ activate = false } = {}) {
  if (!game.user.isGM) return null;
  let scene = game.scenes.find((s) => s.getFlag(MODULE_ID, "homeScene"));

  const img = HOME_IMG;
  // Exactly the picture's own size, with no padding. Anything larger leaves deck around the
  // edges of the art for the camera to wander into, which is the black border you see.
  const width = 1536;
  const height = 1024;
  const hasBackground = "background" in Scene.implementation.schema.fields;

  if (scene) {
    // Bring an existing home scene up to the current shape rather than making a second one.
    if (scene.width !== width || scene.height !== height || scene.padding !== 0) {
      await scene.update({ width, height, padding: 0 });
    }
    const tile = scene.tiles.find((t) => t.getFlag(MODULE_ID, "mapBackground"));
    if (tile) {
      await tile.update({ width, height, x: width / 2, y: height / 2, "texture.src": img });
    } else if (!hasBackground) {
      await scene.createEmbeddedDocuments("Tile", [{
        texture: { src: img }, width, height, x: width / 2, y: height / 2,
        sort: -1000, locked: true, flags: { [MODULE_ID]: { mapBackground: true } },
      }]);
    }
  }

  if (!scene) {
    const data = {
      name: "SSV Silver Gull",
      folder: null,                       // deliberately loose in the Scenes tab: it is the default,
                                          // not a member of any set of maps

      width, height, padding: 0,
      grid: { type: CONST.GRID_TYPES.GRIDLESS, size: 100 },
      tokenVision: false,
      fog: { exploration: false },
      environment: { globalLight: { enabled: true }, darknessLevel: 0 },
      navigation: true,
      navName: "The Gull",
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      flags: { [MODULE_ID]: { homeScene: true } },
    };
    if (hasBackground) data.background = { src: img };
    scene = await Scene.create(data);
    if (!hasBackground) {
      // v14: the map is a Tile, and a Tile's x/y is its CENTRE.
      await scene.createEmbeddedDocuments("Tile", [{
        texture: { src: img }, width, height, x: width / 2, y: height / 2,
        sort: -1000, locked: true, flags: { [MODULE_ID]: { mapBackground: true } },
      }]);
    }
  }

  if (activate) await scene.activate();
  return scene;
}

/**
 * Fill the window with the picture and keep it there.
 *
 * `cover` rather than `contain`: contain letterboxes, which is the black surround. This
 * crops a little off the long edge instead, and the art was composed with room to lose.
 */
function fitView() {
  if (!isHome() || !canvas?.ready) return;
  const s = canvas.scene;
  const w = window.innerWidth || 1920;
  const h = window.innerHeight || 1080;
  const scale = Math.max(w / s.width, h / s.height);
  canvas.pan({ x: s.width / 2, y: s.height / 2, scale });
}

/**
 * The home screen is a picture with buttons on it, not a map — dragging it around only ever
 * reveals the edge of the art. Swallow the gestures that move the camera while we are here.
 */
let _pinned = null;
function pinView() {
  unpinView();
  if (!isHome()) return;
  const view = canvas?.app?.view;
  if (!view) return;
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  // Middle and right drag are Foundry's pan; the wheel is its zoom.
  const onPointer = (e) => { if (e.button === 1 || e.button === 2) swallow(e); };
  view.addEventListener("wheel", swallow, { capture: true, passive: false });
  view.addEventListener("pointerdown", onPointer, { capture: true });
  const onResize = () => fitView();
  window.addEventListener("resize", onResize);
  _pinned = () => {
    view.removeEventListener("wheel", swallow, { capture: true });
    view.removeEventListener("pointerdown", onPointer, { capture: true });
    window.removeEventListener("resize", onResize);
  };
  fitView();
}
function unpinView() { if (_pinned) { _pinned(); _pinned = null; } }

Hooks.on("canvasReady", () => { drawBar(); pinView(); });
Hooks.on("canvasTearDown", () => unpinView());
Hooks.on("updateScene", () => { if (isHome()) { drawBar(); fitView(); } });

Hooks.once("ready", () => {
  drawBar();
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = Object.assign(mod.api || {}, { home: { ensureHomeScene, drawBar } });
  pinView();
  globalThis.SSVHOME = { ensureHomeScene, drawBar, isHome, fitView, pinView, unpinView };
});

export { ensureHomeScene, drawBar, fitView };
