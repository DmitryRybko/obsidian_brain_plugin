var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  BrainView: () => BrainView,
  VIEW_TYPE_BRAIN: () => VIEW_TYPE_BRAIN,
  default: () => BrainCanvasPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var VIEW_TYPE_BRAIN = "brain-canvas-view";
var SVG_NS = "http://www.w3.org/2000/svg";
var DEFAULT_SETTINGS = {
  parentsProperty: "parents",
  jumpsProperty: "jumps",
  useCurvedLinks: true,
  mobileHistoryOffset: 60,
  siblingsSide: "right",
  // as in TheBrain: jumps left, siblings right
  showSiblings: true,
  showJumps: true
};
var FILTERS = [
  { key: "showSiblings", label: "Siblings" },
  { key: "showJumps", label: "Jumps" }
];
var COMPACT_WIDTH = 600;
var TOP_PADDING = 76;
var ROW_GAP = 48;
var PARENT_TO_CENTER = 95;
var CENTER_TO_CHILD = 90;
var CHILD_ROW_GAP = 55;
var SIDE_ROW_GAP = 44;
var SIDE_ROW_GAP_COMPACT = 38;
var HISTORY_RESERVE = 56;
var collator = new Intl.Collator(void 0, {
  sensitivity: "base",
  numeric: true
});
var byName = (a, b) => collator.compare(a.basename, b.basename);
function extractLinkpath(value) {
  if (typeof value !== "string") return null;
  let v = value.trim();
  const m = v.match(/^\[\[(.*?)\]\]$/);
  if (m) v = m[1];
  v = v.split("|")[0].split("#")[0].trim();
  return v || null;
}
function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
var ILLEGAL_NAME_CHARS = /[\\:*?"<>|#^[\]]/;
function linkKey(l) {
  return l.kind === "jump" ? `jump|${[l.a, l.b].sort().join("|")}` : `parent|${l.a}|${l.b}`;
}
var _RelationIndex = class _RelationIndex {
  constructor(app, settings) {
    this.app = app;
    this.settings = settings;
    this.parentsOf = /* @__PURE__ */ new Map();
    // child -> parents
    this.childrenOf = /* @__PURE__ */ new Map();
    // parent -> children
    this.jumpsOut = /* @__PURE__ */ new Map();
    // declared in the note
    this.jumpsIn = /* @__PURE__ */ new Map();
    // declared in other notes
    this.dirty = true;
  }
  markDirty() {
    this.dirty = true;
  }
  /** Resolve one frontmatter value to a markdown file, relative to the note that holds it. */
  resolveValue(value, sourcePath) {
    const lp = extractLinkpath(value);
    if (!lp) return null;
    const dest = this.app.metadataCache.getFirstLinkpathDest(lp, sourcePath);
    return dest && dest.extension === "md" ? dest : null;
  }
  resolveProperty(file, prop) {
    var _a;
    const fm = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter;
    const out = /* @__PURE__ */ new Map();
    for (const v of asList(fm == null ? void 0 : fm[prop])) {
      const dest = this.resolveValue(v, file.path);
      if (dest && dest.path !== file.path) out.set(dest.path, dest);
    }
    return [...out.values()];
  }
  /** Re-index one file. Returns true if its relations changed. */
  updateFile(file) {
    if (this.dirty) return true;
    const before = this.signature(file.path);
    this.unindex(file.path);
    this.indexFile(file);
    return before !== this.signature(file.path);
  }
  parents(file) {
    return this.toFiles(this.get(this.parentsOf, file.path));
  }
  children(file) {
    return this.toFiles(this.get(this.childrenOf, file.path));
  }
  jumps(file) {
    return this.toFiles(
      /* @__PURE__ */ new Set([
        ...this.get(this.jumpsOut, file.path),
        ...this.get(this.jumpsIn, file.path)
      ])
    );
  }
  /** Other children of this note's parents. */
  siblings(file) {
    const out = /* @__PURE__ */ new Set();
    for (const p of this.get(this.parentsOf, file.path)) {
      for (const c of this.get(this.childrenOf, p)) {
        if (c !== file.path) out.add(c);
      }
    }
    return this.toFiles(out);
  }
  hasParents(path) {
    return this.get(this.parentsOf, path).size > 0;
  }
  hasChildren(path) {
    return this.get(this.childrenOf, path).size > 0;
  }
  isJump(a, b) {
    return this.get(this.jumpsOut, a).has(b) || this.get(this.jumpsIn, a).has(b);
  }
  /* ----- internals ----- */
  get(map, key) {
    var _a;
    if (this.dirty) this.rebuild();
    return (_a = map.get(key)) != null ? _a : _RelationIndex.EMPTY;
  }
  toFiles(paths) {
    const out = [];
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof import_obsidian.TFile) out.push(f);
    }
    return out.sort(byName);
  }
  rebuild() {
    this.parentsOf.clear();
    this.childrenOf.clear();
    this.jumpsOut.clear();
    this.jumpsIn.clear();
    this.dirty = false;
    for (const md of this.app.vault.getMarkdownFiles()) this.indexFile(md);
  }
  indexFile(file) {
    const s = this.settings();
    for (const p of this.resolveProperty(file, s.parentsProperty)) {
      add(this.parentsOf, file.path, p.path);
      add(this.childrenOf, p.path, file.path);
    }
    for (const j of this.resolveProperty(file, s.jumpsProperty)) {
      add(this.jumpsOut, file.path, j.path);
      add(this.jumpsIn, j.path, file.path);
    }
  }
  unindex(path) {
    var _a, _b, _c, _d;
    for (const p of (_a = this.parentsOf.get(path)) != null ? _a : []) {
      (_b = this.childrenOf.get(p)) == null ? void 0 : _b.delete(path);
    }
    this.parentsOf.delete(path);
    for (const j of (_c = this.jumpsOut.get(path)) != null ? _c : []) {
      (_d = this.jumpsIn.get(j)) == null ? void 0 : _d.delete(path);
    }
    this.jumpsOut.delete(path);
  }
  signature(path) {
    var _a, _b;
    const parents = [...(_a = this.parentsOf.get(path)) != null ? _a : []].sort().join("\n");
    const jumps = [...(_b = this.jumpsOut.get(path)) != null ? _b : []].sort().join("\n");
    return `${parents}\0${jumps}`;
  }
};
_RelationIndex.EMPTY = /* @__PURE__ */ new Set();
var RelationIndex = _RelationIndex;
function add(map, key, value) {
  let set = map.get(key);
  if (!set) map.set(key, set = /* @__PURE__ */ new Set());
  set.add(value);
}
var NewNoteModal = class extends import_obsidian.Modal {
  constructor(app, heading, suggestions, onSubmit) {
    super(app);
    this.heading = heading;
    this.suggestions = suggestions;
    this.onSubmit = onSubmit;
    this.value = "";
    this.inputEl = null;
    this.listEl = null;
    this.suggestionLimit = 5;
  }
  onOpen() {
    const { contentEl } = this;
    this.containerEl.addClass("brain-new-note-modal-container");
    contentEl.createEl("h3", { text: this.heading });
    this.listEl = contentEl.createDiv({ cls: "brain-suggestion-list" });
    new import_obsidian.Setting(contentEl).addText((text) => {
      this.inputEl = text.inputEl;
      text.setPlaceholder("Pick above or type a new name");
      text.onChange((v) => {
        this.value = v;
        this.renderSuggestions();
      });
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.value = text.inputEl.value;
          this.commit();
        }
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new import_obsidian.Setting(contentEl).addButton(
      (b) => b.setButtonText("Create / Link").setCta().onClick(() => this.commit())
    );
    this.renderSuggestions();
  }
  renderSuggestions() {
    if (!this.listEl) return;
    this.listEl.empty();
    const query = this.value.trim().toLowerCase();
    const matches = this.suggestions.filter((s) => !query || s.toLowerCase().includes(query)).slice(0, this.suggestionLimit);
    this.listEl.toggleClass("is-hidden", matches.length === 0);
    for (const s of matches) {
      const item = this.listEl.createDiv({
        cls: "brain-suggestion-item",
        text: s
      });
      item.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        this.value = s;
        if (this.inputEl) {
          this.inputEl.value = s;
          this.inputEl.focus();
        }
        this.renderSuggestions();
      });
    }
  }
  commit() {
    var _a, _b;
    const name = ((_b = (_a = this.inputEl) == null ? void 0 : _a.value) != null ? _b : this.value).trim();
    if (!name) return;
    this.close();
    Promise.resolve(this.onSubmit(name)).catch((err) => {
      console.error("Brain Canvas:", err);
      new import_obsidian.Notice(`Brain Canvas: ${errorMessage(err)}`);
    });
  }
  onClose() {
    this.contentEl.empty();
    this.inputEl = null;
    this.listEl = null;
  }
};
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function headingFor(kind) {
  return kind === "parent" ? "Add parent" : kind === "child" ? "Add child" : kind === "jump" ? "Add jump" : "Add sibling";
}
var BrainView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.filterButtons = /* @__PURE__ */ new Map();
    this.currentFile = null;
    this.layout = null;
    this.nodeEls = /* @__PURE__ */ new Map();
    // path -> label element
    this.pointEls = /* @__PURE__ */ new Map();
    // `${path}|${gate}`
    this.selectedLink = null;
    this.deleteBtn = null;
    this.tooltipEl = null;
    this.tooltipTimer = null;
    this.linkFrame = null;
    this.resizeObserver = null;
    this.lastWidth = 0;
    this.suppressClickUntil = 0;
    this.recentPaths = [];
    this.historyLimit = 20;
    this.drag = {
      active: false,
      pointerId: -1,
      sourcePath: "",
      gate: "bottom",
      line: null,
      startX: 0,
      startY: 0,
      moved: false
    };
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_BRAIN;
  }
  getDisplayText() {
    return "Brain Canvas";
  }
  getIcon() {
    return "git-fork";
  }
  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("brain-root");
    this.scroller = root.createDiv({ cls: "brain-canvas" });
    this.stage = this.scroller.createDiv({ cls: "brain-stage" });
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.addClass("brain-svg");
    this.stage.appendChild(this.svg);
    this.nodeLayer = this.stage.createDiv({ cls: "brain-node-layer" });
    this.buildToolbar(root);
    this.historyLayer = root.createDiv({ cls: "brain-history" });
    this.resizeObserver = new ResizeObserver(() => {
      const w = this.scroller.clientWidth;
      if (w > 0 && w !== this.lastWidth) this.render();
    });
    this.resizeObserver.observe(this.scroller);
    const active = this.app.workspace.getActiveFile();
    if (active && active.extension === "md") {
      this.currentFile = active;
      this.touchHistory(active);
    }
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.extension === "md") this.navigateTo(file);
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf || leaf === this.leaf) return;
        const view = leaf.view;
        if (view instanceof import_obsidian.MarkdownView && view.file && view.file.extension === "md") {
          this.navigateTo(view.file);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.recentPaths = this.recentPaths.map(
          (p) => p === oldPath ? file.path : p.startsWith(oldPath + "/") ? file.path + p.slice(oldPath.length) : p
        );
      })
    );
    this.registerDomEvent(
      this.stage,
      "pointermove",
      (e) => this.onPointerMove(e)
    );
    this.registerDomEvent(this.stage, "pointerup", (e) => this.onPointerUp(e));
    this.registerDomEvent(this.stage, "pointercancel", () => this.cancelDrag());
    this.registerDomEvent(this.stage, "click", (e) => {
      const t = e.target;
      if (this.selectedLink && !t.closest(".brain-link-group, .brain-link-delete")) {
        this.selectedLink = null;
        this.drawLinks();
      }
    });
    this.registerDomEvent(this.scroller, "scroll", () => this.hideTooltip());
    this.registerDomEvent(this.scroller, "dragover", (e) => e.preventDefault());
    this.registerDomEvent(this.scroller, "drop", (e) => this.onDrop(e));
    this.app.workspace.onLayoutReady(() => {
      window.requestAnimationFrame(() => this.render());
    });
  }
  async onClose() {
    var _a;
    (_a = this.resizeObserver) == null ? void 0 : _a.disconnect();
    this.resizeObserver = null;
    this.cancelLinkFrame();
    this.hideTooltip();
    this.contentEl.empty();
  }
  navigateTo(file) {
    this.touchHistory(file);
    if (file === this.currentFile) {
      this.renderHistory();
      return;
    }
    this.currentFile = file;
    this.selectedLink = null;
    this.render();
  }
  /* --------------------- note lookup / creation --------------------- */
  getExistingNoteSuggestions(excludePath) {
    var _a;
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path !== excludePath);
    const basenameCounts = /* @__PURE__ */ new Map();
    for (const f of files) {
      basenameCounts.set(f.basename, ((_a = basenameCounts.get(f.basename)) != null ? _a : 0) + 1);
    }
    return files.map(
      (f) => {
        var _a2;
        return ((_a2 = basenameCounts.get(f.basename)) != null ? _a2 : 0) > 1 ? f.path.replace(/\.md$/i, "") : f.basename;
      }
    ).sort((a, b) => collator.compare(a, b));
  }
  /* --------------------- recent history --------------------- */
  touchHistory(file) {
    if (file.extension !== "md") return;
    this.recentPaths = this.recentPaths.filter((p) => p !== file.path);
    this.recentPaths.push(file.path);
    if (this.recentPaths.length > this.historyLimit) {
      this.recentPaths = this.recentPaths.slice(-this.historyLimit);
    }
  }
  getRecentFiles() {
    const out = [];
    for (const path of this.recentPaths) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof import_obsidian.TFile && f.extension === "md") out.push(f);
    }
    return out;
  }
  renderHistory() {
    if (!this.historyLayer) return;
    this.contentEl.setCssProps({
      "--brain-history-offset": `${this.plugin.settings.mobileHistoryOffset}px`
    });
    this.historyLayer.empty();
    const files = this.getRecentFiles();
    this.historyLayer.toggleClass("is-hidden", files.length === 0);
    if (files.length === 0) return;
    const row = this.historyLayer.createDiv({ cls: "brain-history-row" });
    for (const file of files) {
      const item = row.createDiv({
        cls: "brain-history-item",
        text: file.basename,
        attr: { title: file.path }
      });
      item.toggleClass("is-current", file === this.currentFile);
      item.dataset.path = file.path;
      item.addEventListener("click", () => this.openNote(file));
    }
    row.scrollLeft = row.scrollWidth;
  }
  /* --------------------- toolbar --------------------- */
  buildToolbar(root) {
    this.toolbarEl = root.createDiv({ cls: "brain-toolbar" });
    const filters = this.toolbarEl.createDiv({
      cls: "brain-filters",
      attr: { role: "group", "aria-label": "Show on canvas" }
    });
    for (const { key, label } of FILTERS) {
      const btn = filters.createEl("button", { cls: "brain-filter" });
      btn.createSpan({ text: label });
      btn.createSpan({ cls: "brain-filter-count" });
      btn.addEventListener("click", async () => {
        this.plugin.settings[key] = !this.plugin.settings[key];
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      });
      this.filterButtons.set(key, btn);
    }
    this.actionsEl = this.toolbarEl.createDiv({ cls: "brain-actions" });
    const action = (icon, label, kind) => {
      const btn = this.actionsEl.createEl("button", {
        cls: "brain-toolbar-btn",
        attr: { "aria-label": label }
      });
      (0, import_obsidian.setIcon)(btn, icon);
      btn.addEventListener("click", () => this.promptLinkedNote(kind));
    };
    action("corner-left-up", "Add parent", "parent");
    action("corner-right-down", "Add child", "child");
    action("arrow-left-right", "Add jump", "jump");
    action("users", "Add sibling", "sibling");
  }
  updateToolbar(counts) {
    var _a;
    for (const { key } of FILTERS) {
      const btn = this.filterButtons.get(key);
      if (!btn) continue;
      const on = this.plugin.settings[key];
      btn.toggleClass("is-active", on);
      btn.setAttr("aria-pressed", on ? "true" : "false");
      const count = (_a = counts == null ? void 0 : counts[key]) != null ? _a : 0;
      const countEl = btn.querySelector(".brain-filter-count");
      if (countEl) countEl.textContent = count > 0 ? String(count) : "";
    }
    this.actionsEl.toggleClass("is-hidden", !this.currentFile);
  }
  promptLinkedNote(kind) {
    const center = this.currentFile;
    if (!center) return;
    if (kind === "sibling" && !this.plugin.index.hasParents(center.path)) {
      new import_obsidian.Notice("Siblings share a parent. Add a parent to this note first.");
      return;
    }
    new NewNoteModal(
      this.app,
      headingFor(kind),
      this.getExistingNoteSuggestions(center.path),
      async (name) => {
        const other = await this.plugin.getOrCreateNote(name, center);
        if (other) await this.link(kind, center, other);
      }
    ).open();
  }
  /** Relate `other` to `center` in the given role. */
  async link(kind, center, other) {
    if (kind === "parent") await this.plugin.addParent(center, other);
    else if (kind === "child") await this.plugin.addParent(other, center);
    else if (kind === "jump") await this.plugin.addJump(center, other);
    else if (kind === "sibling") await this.plugin.addSibling(center, other);
  }
  /* --------------------- rendering --------------------- */
  render() {
    if (!this.stage) return;
    this.cancelLinkFrame();
    this.cancelDrag();
    this.hideTooltip();
    this.nodeLayer.empty();
    this.clearSvg();
    this.deleteBtn = null;
    this.nodeEls.clear();
    this.pointEls.clear();
    this.layout = null;
    if (this.currentFile && !(this.app.vault.getAbstractFileByPath(this.currentFile.path) instanceof import_obsidian.TFile)) {
      this.currentFile = null;
    }
    this.renderHistory();
    const W = this.scroller.clientWidth;
    this.lastWidth = W;
    if (!this.currentFile) {
      this.updateToolbar(null);
      this.stage.setCssProps({ "--brain-stage-height": "100%" });
      this.nodeLayer.createDiv({
        cls: "brain-empty",
        text: "Open a markdown note to see its brain."
      });
      return;
    }
    if (W === 0) return;
    const s = this.plugin.settings;
    const idx = this.plugin.index;
    const center = this.currentFile;
    const allJumps = idx.jumps(center);
    const allSiblings = idx.siblings(center);
    this.updateToolbar({
      showSiblings: allSiblings.length,
      showJumps: allJumps.length
    });
    const shown = /* @__PURE__ */ new Set([center.path]);
    const take = (files) => files.filter((f) => {
      if (shown.has(f.path)) return false;
      shown.add(f.path);
      return true;
    });
    const parents = take(idx.parents(center));
    const children = take(idx.children(center));
    const jumps = s.showJumps ? take(allJumps) : [];
    const siblings = s.showSiblings ? take(allSiblings) : [];
    const siblingsSide = s.siblingsSide === "left" ? "left" : "right";
    const layout = {
      center,
      parents,
      children,
      jumps,
      siblings,
      compact: import_obsidian.Platform.isMobile || W < COMPACT_WIDTH,
      siblingsSide,
      jumpsSide: siblingsSide === "left" ? "right" : "left"
    };
    this.layout = layout;
    this.stage.toggleClass("is-compact", layout.compact);
    const bottom = this.layoutAll(layout, W);
    const reserve = this.historyLayer.hasClass("is-hidden") ? 24 : HISTORY_RESERVE + (import_obsidian.Platform.isMobile ? s.mobileHistoryOffset : 0);
    const height = Math.max(this.scroller.clientHeight, bottom + 40 + reserve);
    this.stage.setCssProps({ "--brain-stage-height": `${height}px` });
    this.linkFrame = window.requestAnimationFrame(() => {
      this.linkFrame = null;
      this.drawLinks();
    });
  }
  /**
   * TheBrain-style plex: parents above, children below, jumps and siblings
   * in columns on either side of the central note. The same arrangement is
   * used on mobile, with narrower columns and shorter labels.
   */
  layoutAll(L, W) {
    const hasSides = L.jumps.length > 0 || L.siblings.length > 0;
    const sideW = !hasSides ? 0 : L.compact ? Math.round(W * 0.3) : Math.min(230, Math.max(150, W * 0.22));
    this.stage.setCssProps({
      "--brain-side-width": `${sideW}px`,
      // room left for the central label between the side columns
      "--brain-center-width": `${Math.max(110, W - 2 * sideW - 24)}px`
    });
    const cx = W / 2;
    const gap = L.compact ? SIDE_ROW_GAP_COMPACT : SIDE_ROW_GAP;
    const pLeft = L.compact ? 0 : sideW;
    const pRight = L.compact ? W : W - sideW;
    let centerY = TOP_PADDING;
    if (L.parents.length) {
      const lastRowY = this.layoutRows(
        L.parents,
        "parent",
        pLeft,
        pRight,
        TOP_PADDING,
        L.compact ? 110 : 130
      );
      centerY = lastRowY + PARENT_TO_CENTER;
    }
    this.makeNode(L.center, cx, centerY, "center");
    const xFor = (side) => side === "left" ? sideW - 6 : W - sideW + 6;
    const topLimit = L.compact ? centerY : TOP_PADDING;
    const sideBottom = Math.max(
      this.layoutColumn(L.jumps, "jump", xFor(L.jumpsSide), centerY, gap, topLimit),
      this.layoutColumn(L.siblings, "sibling", xFor(L.siblingsSide), centerY, gap, topLimit)
    );
    let childStart = centerY + CENTER_TO_CHILD;
    let colOffset = Math.min((W - 2 * sideW) / 4, 180);
    if (L.compact) {
      if (hasSides) childStart = Math.max(childStart, sideBottom + 60);
      colOffset = Math.min(W / 4, 180);
    }
    return Math.max(
      centerY,
      sideBottom,
      this.layoutChildren(L.children, cx, colOffset, childStart)
    );
  }
  /** Rows that wrap when there isn't room. Returns the y of the last row. */
  layoutRows(files, role, left, right, startY, minSpacing) {
    const width = right - left;
    const perRow = Math.max(1, Math.floor(width / minSpacing));
    let y = startY;
    for (let i = 0; i < files.length; i += perRow) {
      const row = files.slice(i, i + perRow);
      const gap = width / (row.length + 1);
      row.forEach((f, j) => this.makeNode(f, left + gap * (j + 1), y, role));
      if (i + perRow < files.length) y += ROW_GAP;
    }
    return y;
  }
  /** A vertical stack centred on centerY (never above topLimit). Returns its bottom y. */
  layoutColumn(files, role, x, centerY, gap, topLimit) {
    if (files.length === 0) return 0;
    const startY = Math.max(topLimit, centerY - (files.length - 1) * gap / 2);
    files.forEach((f, i) => this.makeNode(f, x, startY + i * gap, role));
    return startY + (files.length - 1) * gap;
  }
  /** Children in two columns. Returns the bottom y. */
  layoutChildren(files, cx, colOffset, startY) {
    files.forEach((f, i) => {
      const x = i % 2 === 0 ? cx - colOffset : cx + colOffset;
      const y = startY + Math.floor(i / 2) * CHILD_ROW_GAP;
      this.makeNode(f, x, y, "child");
    });
    return files.length ? startY + Math.floor((files.length - 1) / 2) * CHILD_ROW_GAP : 0;
  }
  makeNode(file, x, y, role) {
    const idx = this.plugin.index;
    const L = this.layout;
    const node = this.nodeLayer.createDiv({
      cls: ["brain-node", `brain-role-${role}`]
    });
    if (role === "center") node.addClass("brain-central");
    const side = role === "jump" || role === "sibling";
    if (side && L) {
      const columnSide = role === "jump" ? L.jumpsSide : L.siblingsSide;
      node.addClass("brain-side", columnSide === "left" ? "brain-anchor-end" : "brain-anchor-start");
    }
    node.dataset.path = file.path;
    node.setCssProps({ "--brain-x": `${x}px`, "--brain-y": `${y}px` });
    const addGate = (parent, gate, label2) => {
      const el = parent.createDiv({ cls: `brain-point brain-point-${gate}` });
      el.setAttr("aria-label", label2);
      el.addEventListener("pointerdown", (e) => this.startDrag(e, file, gate));
      this.pointEls.set(`${file.path}|${gate}`, el);
      return el;
    };
    if (!side) {
      const top = addGate(node, "top", "Drag to link a parent");
      top.toggleClass("brain-point-connected", idx.hasParents(file.path));
    }
    const row = node.createDiv({ cls: "brain-node-row" });
    const sideGate = (side2) => {
      if (role !== "center" || !L) return;
      const isJump = side2 === L.jumpsSide;
      const g = addGate(row, side2, isJump ? "Drag to link a jump" : "Drag to link a sibling");
      g.addClass(isJump ? "brain-point-jump" : "brain-point-sibling");
      g.toggleClass(
        "brain-point-connected",
        isJump ? idx.jumps(file).length > 0 : idx.siblings(file).length > 0
      );
    };
    sideGate("left");
    const label = row.createDiv({ cls: "brain-label", text: file.basename });
    this.nodeEls.set(file.path, label);
    this.wireOpenAndMenu(label, file, role);
    if (role !== "center") this.wireFullName(label, file.basename);
    sideGate("right");
    if (!side) {
      const bottom = addGate(node, "bottom", "Drag to link a child");
      bottom.toggleClass("brain-point-connected", idx.hasChildren(file.path));
    }
  }
  /** Click opens the note; right-click or long-press opens a menu. */
  wireOpenAndMenu(el, file, role) {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (Date.now() < this.suppressClickUntil) return;
      this.openNote(file);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (import_obsidian.Platform.isMobile) return;
      this.openNodeMenu(file, role, e);
    });
    let timer = null;
    let sx = 0;
    let sy = 0;
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      sx = e.clientX;
      sy = e.clientY;
      cancel();
      timer = window.setTimeout(() => {
        timer = null;
        this.suppressClickUntil = Date.now() + 700;
        this.hideTooltip();
        this.openNodeMenu(file, role, { x: sx, y: sy });
      }, 500);
    });
    el.addEventListener("pointermove", (e) => {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel();
    });
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("pointerleave", cancel);
  }
  /**
   * Full name for shortened labels: on hover with a mouse, and while a finger
   * rests on the label on touch screens. Only shown when the label is cut off.
   */
  wireFullName(el, name) {
    const truncated = () => el.scrollWidth > el.clientWidth + 1;
    el.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse" && truncated()) this.showTooltip(el, name);
    });
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" && truncated()) this.showTooltip(el, name);
    });
    el.addEventListener("pointerleave", () => this.hideTooltip());
    el.addEventListener("pointerup", (e) => {
      if (e.pointerType !== "mouse") this.hideTooltip(1200);
    });
    el.addEventListener("pointercancel", () => this.hideTooltip());
  }
  showTooltip(anchor, text) {
    this.hideTooltip();
    const tip = this.nodeLayer.createDiv({ cls: "brain-tooltip", text });
    const r = anchor.getBoundingClientRect();
    const p = this.toStage(r.left + r.width / 2, r.top);
    const W = this.stage.clientWidth;
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(p.x, half + 6), W - half - 6);
    tip.setCssProps({ "--brain-x": `${x}px`, "--brain-y": `${p.y}px` });
    this.tooltipEl = tip;
  }
  hideTooltip(delay = 0) {
    if (this.tooltipTimer !== null) window.clearTimeout(this.tooltipTimer);
    this.tooltipTimer = null;
    const remove = () => {
      var _a;
      (_a = this.tooltipEl) == null ? void 0 : _a.remove();
      this.tooltipEl = null;
    };
    if (delay > 0) this.tooltipTimer = window.setTimeout(remove, delay);
    else remove();
  }
  openNodeMenu(file, role, at) {
    const center = this.currentFile;
    const menu = new import_obsidian.Menu();
    menu.addItem((i) => i.setTitle(file.basename).setIcon("file-text").setDisabled(true));
    menu.addSeparator();
    menu.addItem(
      (i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.app.workspace.getLeaf("tab").openFile(file))
    );
    if (center && role !== "center") {
      const link = role === "parent" ? { kind: "parent", a: center.path, b: file.path } : role === "child" ? { kind: "parent", a: file.path, b: center.path } : role === "jump" ? { kind: "jump", a: center.path, b: file.path } : null;
      if (!this.plugin.index.isJump(center.path, file.path)) {
        menu.addItem(
          (i) => i.setTitle("Add as jump").setIcon("arrow-left-right").onClick(() => this.plugin.addJump(center, file))
        );
      }
      if (link) {
        menu.addSeparator();
        const title = role === "parent" ? "Remove parent link" : role === "child" ? "Remove child link" : "Remove jump";
        menu.addItem(
          (i) => i.setTitle(title).setIcon("unlink").setWarning(true).onClick(() => this.removeLink(link))
        );
      }
    }
    if (at instanceof MouseEvent) menu.showAtMouseEvent(at);
    else menu.showAtPosition(at);
  }
  /** Open a note in a real editor pane (never on top of the canvas). */
  async openNote(file) {
    var _a;
    const { workspace } = this.app;
    const mdLeaves = workspace.getLeavesOfType("markdown");
    const target = (_a = mdLeaves.find((l) => l !== this.leaf)) != null ? _a : workspace.getLeaf("split", "vertical");
    await target.openFile(file);
    if (this.currentFile !== file) this.navigateTo(file);
  }
  /* --------------------- links --------------------- */
  cancelLinkFrame() {
    if (this.linkFrame !== null) window.cancelAnimationFrame(this.linkFrame);
    this.linkFrame = null;
  }
  clearSvg() {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
  }
  toStage(clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }
  pointCenter(path, gate) {
    const el = this.pointEls.get(`${path}|${gate}`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return this.toStage(r.left + r.width / 2, r.top + r.height / 2);
  }
  /** Middle of a label's left or right edge. */
  labelSide(path, side) {
    const el = this.nodeEls.get(path);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return this.toStage(side === "left" ? r.left : r.right, r.top + r.height / 2);
  }
  drawLinks() {
    var _a;
    this.clearSvg();
    (_a = this.deleteBtn) == null ? void 0 : _a.remove();
    this.deleteBtn = null;
    const L = this.layout;
    if (!L) return;
    const center = L.center.path;
    const selectedKey = this.selectedLink ? linkKey(this.selectedLink) : null;
    let selectedMid = null;
    const draw = (a, b, link, horizontal) => {
      if (!a || !b) return;
      const selected = linkKey(link) === selectedKey;
      const mid = this.drawLink(a, b, horizontal, {
        link,
        cls: link.kind === "jump" ? "brain-link-jump" : "",
        selected
      });
      if (selected) selectedMid = mid;
    };
    for (const p of L.parents) {
      draw(
        this.pointCenter(p.path, "bottom"),
        this.pointCenter(center, "top"),
        { kind: "parent", a: center, b: p.path },
        false
      );
    }
    for (const c of L.children) {
      draw(
        this.pointCenter(center, "bottom"),
        this.pointCenter(c.path, "top"),
        { kind: "parent", a: c.path, b: center },
        false
      );
    }
    const facing = (side) => side === "left" ? "right" : "left";
    for (const j of L.jumps) {
      draw(
        this.pointCenter(center, L.jumpsSide),
        this.labelSide(j.path, facing(L.jumpsSide)),
        { kind: "jump", a: center, b: j.path },
        true
      );
    }
    for (const sib of L.siblings) {
      const a = this.pointCenter(center, L.siblingsSide);
      const b = this.labelSide(sib.path, facing(L.siblingsSide));
      if (a && b) this.drawLink(a, b, true, { cls: "brain-link-sibling" });
    }
    if (this.drag.active && this.drag.line) this.svg.appendChild(this.drag.line);
    if (selectedMid && this.selectedLink) this.showDeleteButton(selectedMid, this.selectedLink);
    else this.selectedLink = null;
  }
  /**
   * Draws a link; removable links get a wide invisible hit area.
   * Returns its midpoint.
   */
  drawLink(a, b, horizontal, opts) {
    let d;
    if (!this.plugin.settings.useCurvedLinks) {
      d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
    } else if (horizontal) {
      const dx = (b.x - a.x) * 0.5;
      d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    } else {
      const dy = (b.y - a.y) * 0.5;
      d = `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
    }
    const g = document.createElementNS(SVG_NS, "g");
    g.addClass("brain-link-group");
    if (opts.selected) g.addClass("is-selected");
    const visible = document.createElementNS(SVG_NS, "path");
    visible.setAttribute("d", d);
    visible.addClass("brain-link");
    if (opts.cls) visible.addClass(opts.cls);
    g.appendChild(visible);
    const link = opts.link;
    if (link) {
      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", d);
      hit.addClass("brain-link-hit");
      hit.addEventListener("click", (e) => {
        e.stopPropagation();
        const same = this.selectedLink && linkKey(this.selectedLink) === linkKey(link);
        this.selectedLink = same ? null : link;
        this.drawLinks();
      });
      g.appendChild(hit);
    } else {
      g.addClass("is-static");
    }
    this.svg.appendChild(g);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  showDeleteButton(at, link) {
    const btn = this.nodeLayer.createEl("button", {
      cls: "brain-link-delete",
      attr: { "aria-label": "Remove link" }
    });
    (0, import_obsidian.setIcon)(btn, "x");
    btn.setCssProps({ "--brain-x": `${at.x}px`, "--brain-y": `${at.y}px` });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeLink(link);
    });
    this.deleteBtn = btn;
  }
  async removeLink(link) {
    const a = this.app.vault.getAbstractFileByPath(link.a);
    const b = this.app.vault.getAbstractFileByPath(link.b);
    this.selectedLink = null;
    this.drawLinks();
    if (!(a instanceof import_obsidian.TFile) || !(b instanceof import_obsidian.TFile)) return;
    try {
      if (link.kind === "parent") {
        await this.plugin.removeRelation(a, this.plugin.settings.parentsProperty, b);
      } else {
        await this.plugin.removeJump(a, b);
      }
      new import_obsidian.Notice(`Removed link: ${a.basename} \u2013 ${b.basename}`);
    } catch (err) {
      console.error("Brain Canvas:", err);
      new import_obsidian.Notice(`Couldn't remove link: ${errorMessage(err)}`);
    }
  }
  /* --------------------- gate dragging --------------------- */
  startDrag(e, file, gate) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = this.pointCenter(file.path, gate);
    if (!start) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const line = document.createElementNS(SVG_NS, "line");
    line.addClass("brain-link", "brain-link-temp");
    line.setAttribute("x1", String(start.x));
    line.setAttribute("y1", String(start.y));
    line.setAttribute("x2", String(start.x));
    line.setAttribute("y2", String(start.y));
    this.svg.appendChild(line);
    this.drag = {
      active: true,
      pointerId: e.pointerId,
      sourcePath: file.path,
      gate,
      line,
      startX: start.x,
      startY: start.y,
      moved: false
    };
  }
  onPointerMove(e) {
    const d = this.drag;
    if (!d.active || !d.line || e.pointerId !== d.pointerId) return;
    const p = this.toStage(e.clientX, e.clientY);
    if (Math.hypot(p.x - d.startX, p.y - d.startY) > 6) d.moved = true;
    d.line.setAttribute("x2", String(p.x));
    d.line.setAttribute("y2", String(p.y));
  }
  cancelDrag() {
    var _a;
    if ((_a = this.drag.line) == null ? void 0 : _a.parentNode) this.drag.line.parentNode.removeChild(this.drag.line);
    this.drag.active = false;
    this.drag.line = null;
  }
  /** What dragging from a gate creates. */
  roleForGate(gate) {
    if (gate === "top") return "parent";
    if (gate === "bottom") return "child";
    return this.layout && gate === this.layout.jumpsSide ? "jump" : "sibling";
  }
  onPointerUp(e) {
    const d = { ...this.drag };
    if (!d.active || e.pointerId !== d.pointerId) return;
    this.cancelDrag();
    if (!d.moved || !this.currentFile) return;
    const source = this.app.vault.getAbstractFileByPath(d.sourcePath);
    if (!(source instanceof import_obsidian.TFile)) return;
    const kind = this.roleForGate(d.gate);
    if (kind === "sibling" && !this.plugin.index.hasParents(source.path)) {
      new import_obsidian.Notice("Siblings share a parent. Add a parent to this note first.");
      return;
    }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const targetEl = under == null ? void 0 : under.closest(".brain-node, .brain-history-item");
    if (targetEl == null ? void 0 : targetEl.dataset.path) {
      if (targetEl.dataset.path === source.path) return;
      const dest = this.app.vault.getAbstractFileByPath(targetEl.dataset.path);
      if (dest instanceof import_obsidian.TFile) {
        this.link(kind, source, dest).catch(
          (err) => new import_obsidian.Notice(`Brain Canvas: ${errorMessage(err)}`)
        );
      }
      return;
    }
    new NewNoteModal(
      this.app,
      headingFor(kind),
      this.getExistingNoteSuggestions(source.path),
      async (name) => {
        const nf = await this.plugin.getOrCreateNote(name, source);
        if (nf) await this.link(kind, source, nf);
      }
    ).open();
  }
  /* --------------------- drop file from explorer --------------------- */
  async onDrop(e) {
    var _a, _b;
    e.preventDefault();
    if (!this.currentFile) return;
    const dm = this.app.dragManager;
    let file = null;
    if (((_a = dm == null ? void 0 : dm.draggable) == null ? void 0 : _a.file) instanceof import_obsidian.TFile) file = dm.draggable.file;
    if (!file) {
      const text = (_b = e.dataTransfer) == null ? void 0 : _b.getData("text/plain");
      const lp = text ? extractLinkpath(text) || text : null;
      if (lp) file = this.app.metadataCache.getFirstLinkpathDest(lp, "");
    }
    if (file && file.extension === "md" && file.path !== this.currentFile.path) {
      await this.plugin.addParent(file, this.currentFile);
    }
  }
};
var BrainCanvasPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.resolvedOnce = false;
    /** Coalesces bursts of vault/metadata events into one re-render. */
    this.scheduleRefresh = (0, import_obsidian.debounce)(() => this.refreshViews(), 150, true);
  }
  async onload() {
    await this.loadSettings();
    this.index = new RelationIndex(this.app, () => this.settings);
    this.registerView(VIEW_TYPE_BRAIN, (leaf) => new BrainView(leaf, this));
    this.addRibbonIcon("git-fork", "Open Brain Canvas", () => this.activateView());
    this.addCommand({
      id: "open-brain-canvas",
      name: "Open Brain Canvas",
      callback: () => this.activateView()
    });
    this.addSettingTab(new BrainCanvasSettingTab(this.app, this));
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.extension === "md" && this.index.updateFile(file)) {
          this.scheduleRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        if (this.resolvedOnce) return;
        this.resolvedOnce = true;
        this.invalidate();
      })
    );
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", () => this.invalidate()));
    });
    this.registerEvent(this.app.vault.on("delete", () => this.invalidate()));
    this.registerEvent(this.app.vault.on("rename", () => this.invalidate()));
  }
  // No detachLeavesOfType here: Obsidian restores the view in place after updates.
  onunload() {
  }
  invalidate() {
    this.index.markDirty();
    this.scheduleRefresh();
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /** Re-render every open Brain Canvas view. */
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BRAIN)) {
      if (leaf.view instanceof BrainView) leaf.view.render();
    }
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_BRAIN)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_BRAIN, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
  /* --------------------- frontmatter mutations --------------------- */
  /** Remove every entry in `owner[prop]` that resolves to `target` (compared by path). */
  async removeRelation(owner, prop, target) {
    await this.app.fileManager.processFrontMatter(owner, (fm) => {
      const list = asList(fm[prop]);
      const kept = list.filter(
        (v) => {
          var _a;
          return ((_a = this.index.resolveValue(v, owner.path)) == null ? void 0 : _a.path) !== target.path;
        }
      );
      if (kept.length === list.length) return;
      if (kept.length === 0) delete fm[prop];
      else fm[prop] = kept;
    });
  }
  /** Add a link to `target` in `owner[prop]`, unless one already resolves to it. */
  async addRelation(owner, prop, target) {
    if (owner.path === target.path) {
      new import_obsidian.Notice("A note can't be linked to itself.");
      return;
    }
    const linktext = this.app.metadataCache.fileToLinktext(target, owner.path, true);
    await this.app.fileManager.processFrontMatter(owner, (fm) => {
      const list = asList(fm[prop]);
      const exists = list.some(
        (v) => {
          var _a;
          return ((_a = this.index.resolveValue(v, owner.path)) == null ? void 0 : _a.path) === target.path;
        }
      );
      if (exists) return;
      list.push(`[[${linktext}]]`);
      fm[prop] = list;
    });
  }
  async addParent(child, parent) {
    const prop = this.settings.parentsProperty;
    await this.removeRelation(parent, prop, child);
    await this.addRelation(child, prop, parent);
  }
  async addJump(a, b) {
    if (this.index.isJump(a.path, b.path)) return;
    await this.addRelation(a, this.settings.jumpsProperty, b);
  }
  /** Make `other` a sibling of `note` by giving it all of `note`'s parents. */
  async addSibling(note, other) {
    const parents = this.index.parents(note);
    if (parents.length === 0) {
      new import_obsidian.Notice("Siblings share a parent. Add a parent to this note first.");
      return;
    }
    for (const p of parents) {
      if (p.path !== other.path) await this.addParent(other, p);
    }
  }
  /** A jump may be declared on either note, so clear both sides. */
  async removeJump(a, b) {
    const prop = this.settings.jumpsProperty;
    await this.removeRelation(a, prop, b);
    await this.removeRelation(b, prop, a);
  }
  /* --------------------- note lookup / creation --------------------- */
  resolveExistingNote(input, contextPath) {
    var _a;
    const raw = ((_a = extractLinkpath(input)) != null ? _a : input).trim();
    if (!raw) return null;
    const asPath = (0, import_obsidian.normalizePath)(raw.endsWith(".md") ? raw : `${raw}.md`);
    const byPath = this.app.vault.getAbstractFileByPath(asPath);
    if (byPath instanceof import_obsidian.TFile && byPath.extension === "md") return byPath;
    const noExt = raw.replace(/\.md$/i, "");
    const byLink = this.app.metadataCache.getFirstLinkpathDest(noExt, contextPath);
    if (byLink && byLink.extension === "md") return byLink;
    return null;
  }
  /**
   * Find a note by name/path, or create it. A bare name goes into the folder
   * from Obsidian's "Default location for new notes" setting; "a/b/Name"
   * creates missing folders. Shows a Notice and returns null on failure.
   */
  async getOrCreateNote(input, context) {
    var _a;
    const existing = this.resolveExistingNote(input, context.path);
    if (existing) return existing;
    const raw = ((_a = extractLinkpath(input)) != null ? _a : input).trim().replace(/\.md$/i, "");
    const segments = raw.split("/").map((s) => s.trim()).filter(Boolean);
    const name = segments.pop();
    if (!name) return null;
    if ([name, ...segments].some((s) => ILLEGAL_NAME_CHARS.test(s))) {
      new import_obsidian.Notice(`Note names can't contain any of these characters: \\ : * ? " < > | # ^ [ ]`);
      return null;
    }
    let folder = segments.length ? (0, import_obsidian.normalizePath)(segments.join("/")) : this.app.fileManager.getNewFileParent(context.path).path;
    if (folder === "/") folder = "";
    const path = (0, import_obsidian.normalizePath)(folder ? `${folder}/${name}.md` : `${name}.md`);
    try {
      if (folder) await this.ensureFolder(folder);
      const found = this.app.vault.getAbstractFileByPath(path);
      if (found instanceof import_obsidian.TFile) return found;
      return await this.app.vault.create(path, "");
    } catch (err) {
      console.error("Brain Canvas:", err);
      new import_obsidian.Notice(`Couldn't create "${name}": ${errorMessage(err)}`);
      return null;
    }
  }
  async ensureFolder(path) {
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const f = this.app.vault.getAbstractFileByPath(current);
      if (!f) await this.app.vault.createFolder(current);
      else if (!(f instanceof import_obsidian.TFolder)) throw new Error(`"${current}" is a file, not a folder`);
    }
  }
};
var BrainCanvasSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const applyProperties = (0, import_obsidian.debounce)(
      async () => {
        await this.plugin.saveSettings();
        this.plugin.invalidate();
      },
      500,
      true
    );
    const propertySetting = (name, desc, key, other) => new import_obsidian.Setting(containerEl).setName(name).setDesc(desc).addText(
      (text) => text.setPlaceholder(DEFAULT_SETTINGS[key]).setValue(this.plugin.settings[key]).onChange((value) => {
        const v = value.trim();
        const invalid = !v || v === this.plugin.settings[other];
        text.inputEl.toggleClass("brain-input-invalid", invalid);
        if (invalid) return;
        this.plugin.settings[key] = v;
        applyProperties();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Properties").setHeading();
    propertySetting(
      "Parents property",
      "Frontmatter property that lists a note's parents. Existing notes aren't rewritten when you change this.",
      "parentsProperty",
      "jumpsProperty"
    );
    propertySetting(
      "Jumps property",
      "Frontmatter property that lists a note's jumps: related notes outside the hierarchy.",
      "jumpsProperty",
      "parentsProperty"
    );
    new import_obsidian.Setting(containerEl).setName("Appearance").setHeading();
    new import_obsidian.Setting(containerEl).setName("Siblings side").setDesc("Which side of the central note siblings appear on. Jumps use the other side.").addDropdown(
      (dd) => dd.addOption("right", "Right (jumps on the left, as in TheBrain)").addOption("left", "Left (jumps on the right)").setValue(this.plugin.settings.siblingsSide).onChange(async (value) => {
        this.plugin.settings.siblingsSide = value === "left" ? "left" : "right";
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Curved links").setDesc("Draw connections as smooth B\xE9zier curves. Turn off for straight lines.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.useCurvedLinks).onChange(async (value) => {
        this.plugin.settings.useCurvedLinks = value;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Mobile history offset").setDesc(
      "On mobile, raise the recent-notes strip by this many pixels so it stays clear of Obsidian's bottom menu. Desktop is unaffected."
    ).addSlider(
      (slider) => slider.setLimits(0, 200, 5).setValue(this.plugin.settings.mobileHistoryOffset).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.mobileHistoryOffset = value;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      })
    );
  }
};
