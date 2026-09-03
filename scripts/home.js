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
#${BAR_ID}{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:28;
  display:flex;gap:8px;padding:10px 12px;border-radius:14px;
  background:rgba(4,12,20,.74);border:1px solid rgba(95,208,196,.28);
  backdrop-filter:blur(9px);box-shadow:0 12px 40px rgba(0,0,0,.55);
  font-family:'Courier New',monospace;pointer-events:auto;}
#${BAR_ID} button{display:flex;flex-direction:column;align-items:center;gap:3px;
  min-width:78px;padding:8px 10px;border-radius:10px;cursor:pointer;
  background:rgba(9,26,38,.85);border:1px solid rgba(95,208,196,.22);color:#d7f2ee;
  font-family:inherit;font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  transition:border-color .15s ease, background .15s ease, transform .15s ease;}
#${BAR_ID} button:hover{background:rgba(16,44,60,.95);border-color:rgba(95,208,196,.6);
  transform:translateY(-2px);}
#${BAR_ID} .g{font-size:17px;line-height:1;color:#5fd0c4;}
#${BAR_ID} .k{opacity:.5;font-size:9px;}
#${BAR_ID} .t{font-size:10px;}
@media (max-width:820px){#${BAR_ID} button{min-width:60px;} #${BAR_ID} .t{display:none;}}
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
  const width = 1536;
  const height = 1024;
  const hasBackground = "background" in Scene.implementation.schema.fields;

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

Hooks.on("canvasReady", () => drawBar());
Hooks.on("updateScene", () => { if (isHome()) drawBar(); });

Hooks.once("ready", () => {
  drawBar();
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = Object.assign(mod.api || {}, { home: { ensureHomeScene, drawBar } });
  globalThis.SSVHOME = { ensureHomeScene, drawBar, isHome };
});

export { ensureHomeScene, drawBar };
