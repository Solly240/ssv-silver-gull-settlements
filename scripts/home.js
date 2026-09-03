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
  { id: "ssv-silver-gull-settlements", key: "G", label: "Settlement", glyph: "🏛", open: () => globalThis.SilverGullSettlements?.open() },
  { id: "ssv-silver-gull-shop", key: "I", label: "Trade", glyph: "⚖", open: (m) => m.api?.open?.() },
  { id: "ssv-silver-gull-sundowner", key: "B", label: "Sundowner", glyph: "◆", open: (m) => m.api?.open?.() },
  // `api.open?.() ?? pressKey()` would fire BOTH when open() exists and returns undefined,
  // which is the normal case — opening the journal and then toggling it shut again.
  { id: "ssv-silver-gull-journal", key: "J", label: "Journal", glyph: "▤",
    open: (m) => (typeof m.api?.open === "function" ? m.api.open() : pressKey("KeyJ")) },
  { id: "ssv-silver-gull-politics", key: "P", label: "Standing", glyph: "◈", open: (m) => m.api?.open?.() },
  { id: "ssv-silver-gull-ship-combat", key: "S", label: "The Gull", glyph: "▲", open: (m) => m.api?.open?.() },
];

/** The journal has no open() in its API, so fall back to the key it already binds. */
function pressKey(code) {
  const ev = { key: code.replace("Key", "").toLowerCase(), code, bubbles: true };
  window.dispatchEvent(new KeyboardEvent("keydown", ev));
  window.dispatchEvent(new KeyboardEvent("keyup", ev));
}

const CSS = `
#${BAR_ID}{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:28;
  display:flex;gap:10px;padding:14px 16px;border-radius:18px;
  background:rgba(4,12,20,.74);border:1px solid rgba(95,208,196,.28);
  backdrop-filter:blur(9px);box-shadow:0 12px 40px rgba(0,0,0,.55);
  font-family:'Courier New',monospace;pointer-events:auto;}
#${BAR_ID} button{position:relative;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:7px;min-width:132px;min-height:112px;padding:16px 14px;
  border-radius:14px;cursor:pointer;
  background:linear-gradient(180deg,rgba(16,44,60,.92),rgba(7,20,30,.94));
  border:1px solid rgba(95,208,196,.3);color:#d7f2ee;
  font-family:inherit;font-size:13px;letter-spacing:.14em;text-transform:uppercase;
  box-shadow:inset 0 1px 0 rgba(140,235,225,.16), 0 4px 14px rgba(0,0,0,.45);
  transition:border-color .15s ease, background .15s ease, transform .12s ease,
             box-shadow .15s ease;}
#${BAR_ID} button:hover{background:linear-gradient(180deg,rgba(26,68,88,.97),rgba(10,30,42,.97));
  border-color:rgba(95,208,196,.75);transform:translateY(-3px);
  box-shadow:inset 0 1px 0 rgba(160,255,245,.25), 0 10px 26px rgba(0,0,0,.6),
             0 0 22px rgba(95,208,196,.18);}
#${BAR_ID} button:active{transform:translateY(0);}
#${BAR_ID} .g{font-size:34px;line-height:1;color:#5fd0c4;
  text-shadow:0 0 16px rgba(95,208,196,.5);}
#${BAR_ID} .t{font-size:12px;}
#${BAR_ID} .k{position:absolute;top:7px;right:9px;font-size:11px;opacity:.45;
  border:1px solid rgba(95,208,196,.35);border-radius:5px;padding:1px 5px;line-height:1.3;}
@media (max-width:1100px){#${BAR_ID} button{min-width:96px;min-height:88px;}
  #${BAR_ID} .g{font-size:26px;}}
@media (max-width:820px){#${BAR_ID} button{min-width:70px;min-height:70px;padding:10px;}
  #${BAR_ID} .t{display:none;} #${BAR_ID} .g{font-size:22px;}}
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
}

function drawBar() {
  removeBar();
  if (!isHome()) return;
  ensureStyles();
  const bar = document.createElement("div");
  bar.id = BAR_ID;
  const live = LAUNCHERS.filter((l) => game.modules.get(l.id)?.active);
  bar.innerHTML = live.map((l) => `
    <button data-mod="${l.id}" title="${l.label} — ${l.key}">
      <span class="g">${l.glyph}</span>
      <span class="t">${l.label}</span>
      <span class="k">${l.key}</span>
    </button>`).join("");
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
