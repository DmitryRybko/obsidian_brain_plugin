var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
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
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

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
var DEFAULT_SETTINGS = {
  useCurvedLinks: true,
  mobileHistoryOffset: 60
};
function extractLinkpath(value) {
  if (typeof value !== "string") return null;
  let v = value.trim();
  const m = v.match(/^\[\[(.*?)\]\]$/);
  if (m) v = m[1];
  v = v.split("|")[0].split("#")[0].trim();
  return v || null;
}
var NewNoteModal = class extends import_obsidian.Modal {
  constructor(app, suggestions, onSubmit) {
    super(app);
    __publicField(this, "onSubmit");
    __publicField(this, "suggestions");
    __publicField(this, "suggestionLimit", 5);
    __publicField(this, "value", "");
    __publicField(this, "inputEl", null);
    __publicField(this, "listEl", null);
    this.suggestions = suggestions;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    this.containerEl.addClass("brain-new-note-modal-container");
    contentEl.createEl("h3", { text: "New note name" });
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
    if (matches.length === 0) {
      this.listEl.style.display = "none";
      return;
    }
    this.listEl.style.display = "";
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
    if (name) {
      this.close();
      this.onSubmit(name);
    }
  }
  onClose() {
    this.contentEl.empty();
    this.inputEl = null;
    this.listEl = null;
  }
};
var BrainView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    __publicField(this, "plugin");
    __publicField(this, "container");
    __publicField(this, "svg");
    __publicField(this, "nodeLayer");
    __publicField(this, "historyLayer");
    __publicField(this, "currentFile", null);
    __publicField(this, "pointEls", /* @__PURE__ */ new Map());
    __publicField(this, "resizeObserver", null);
    __publicField(this, "recentPaths", []);
    __publicField(this, "historyLimit", 20);
    __publicField(this, "drag", {
      active: false,
      sourcePath: "",
      direction: "bottom",
      line: null,
      startX: 0,
      startY: 0
    });
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
    this.container = root.createDiv({ cls: "brain-canvas" });
    const svgNS = "http://www.w3.org/2000/svg";
    this.svg = document.createElementNS(svgNS, "svg");
    this.svg.addClass("brain-svg");
    this.container.appendChild(this.svg);
    this.nodeLayer = this.container.createDiv({ cls: "brain-node-layer" });
    this.historyLayer = this.container.createDiv({ cls: "brain-history" });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.container.clientWidth > 0) this.render();
    });
    this.resizeObserver.observe(this.container);
    const active = this.app.workspace.getActiveFile();
    if (active && active.extension === "md") {
      this.currentFile = active;
      this.touchHistory(active);
    }
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.extension === "md") {
          this.currentFile = file;
          this.touchHistory(file);
          this.render();
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf || leaf === this.leaf) return;
        const view = leaf.view;
        if (view instanceof import_obsidian.MarkdownView && view.file && view.file.extension === "md" && view.file !== this.currentFile) {
          this.currentFile = view.file;
          this.touchHistory(view.file);
          this.render();
        }
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.render())
    );
    this.container.addEventListener(
      "mousemove",
      (e) => this.onMouseMove(e)
    );
    this.container.addEventListener("mouseup", (e) => this.onMouseUp(e));
    this.container.addEventListener("dragover", (e) => e.preventDefault());
    this.container.addEventListener("drop", (e) => this.onDrop(e));
    this.app.workspace.onLayoutReady(() => {
      window.requestAnimationFrame(() => this.render());
    });
  }
  async onClose() {
    var _a;
    (_a = this.resizeObserver) == null ? void 0 : _a.disconnect();
    this.resizeObserver = null;
    this.contentEl.empty();
  }
  /* --------------------- relationship lookups --------------------- */
  getParents(file) {
    var _a;
    const fm = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter;
    if (!fm || fm.parents == null) return [];
    let parents = fm.parents;
    if (!Array.isArray(parents)) parents = [parents];
    const out = [];
    for (const p of parents) {
      const lp = extractLinkpath(p);
      if (!lp) continue;
      const dest = this.app.metadataCache.getFirstLinkpathDest(
        lp,
        file.path
      );
      if (dest) out.push(dest);
    }
    out.sort(
      (a, b) => a.basename.localeCompare(b.basename, void 0, {
        sensitivity: "base",
        numeric: true
      })
    );
    return out;
  }
  getChildren(file) {
    const out = [];
    for (const md of this.app.vault.getMarkdownFiles()) {
      if (md.path === file.path) continue;
      if (this.getParents(md).some((p) => p.path === file.path))
        out.push(md);
    }
    out.sort(
      (a, b) => a.basename.localeCompare(b.basename, void 0, {
        sensitivity: "base",
        numeric: true
      })
    );
    return out;
  }
  getExistingNoteSuggestions(excludePath) {
    var _a;
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path !== excludePath);
    const basenameCounts = /* @__PURE__ */ new Map();
    for (const f of files) {
      basenameCounts.set(
        f.basename,
        ((_a = basenameCounts.get(f.basename)) != null ? _a : 0) + 1
      );
    }
    const suggestions = files.map(
      (f) => {
        var _a2;
        return ((_a2 = basenameCounts.get(f.basename)) != null ? _a2 : 0) > 1 ? f.path.replace(/\.md$/i, "") : f.basename;
      }
    );
    suggestions.sort(
      (a, b) => a.localeCompare(b, void 0, {
        sensitivity: "base",
        numeric: true
      })
    );
    return suggestions;
  }
  resolveExistingNote(input, contextPath) {
    var _a;
    const raw = ((_a = extractLinkpath(input)) != null ? _a : input).trim();
    if (!raw) return null;
    const asPath = raw.endsWith(".md") ? raw : `${raw}.md`;
    const byPath = this.app.vault.getAbstractFileByPath(asPath);
    if (byPath instanceof import_obsidian.TFile && byPath.extension === "md") return byPath;
    const byLink = this.app.metadataCache.getFirstLinkpathDest(
      raw,
      contextPath
    );
    if (byLink && byLink.extension === "md") return byLink;
    const rawNoExt = raw.replace(/\.md$/i, "");
    if (rawNoExt !== raw) {
      const byLinkNoExt = this.app.metadataCache.getFirstLinkpathDest(
        rawNoExt,
        contextPath
      );
      if (byLinkNoExt && byLinkNoExt.extension === "md")
        return byLinkNoExt;
    }
    return null;
  }
  async getOrCreateNoteFromInput(input, contextPath) {
    var _a;
    const existing = this.resolveExistingNote(input, contextPath);
    if (existing) return existing;
    const raw = ((_a = extractLinkpath(input)) != null ? _a : input).trim();
    if (!raw) return null;
    const path = raw.endsWith(".md") ? raw : `${raw}.md`;
    const found = this.app.vault.getAbstractFileByPath(path);
    if (found instanceof import_obsidian.TFile && found.extension === "md") return found;
    return await this.app.vault.create(path, "");
  }
  /* --------------------- frontmatter mutations --------------------- */
  async removeParent(child, parent) {
    await this.app.fileManager.processFrontMatter(child, (fm) => {
      let parents = fm.parents;
      if (parents == null) return;
      if (!Array.isArray(parents)) parents = [parents];
      parents = parents.filter(
        (p) => extractLinkpath(p) !== parent.basename
      );
      fm.parents = parents;
    });
  }
  async addParent(child, parent) {
    await this.removeParent(parent, child);
    await this.app.fileManager.processFrontMatter(child, (fm) => {
      let parents = fm.parents;
      if (parents == null) parents = [];
      if (!Array.isArray(parents)) parents = [parents];
      const link = `[[${parent.basename}]]`;
      const already = parents.some(
        (p) => extractLinkpath(p) === parent.basename
      );
      if (!already) parents.push(link);
      fm.parents = parents;
    });
  }
  async createLinkedNote(name, asChild) {
    if (!this.currentFile) return;
    const newFile = await this.getOrCreateNoteFromInput(
      name,
      this.currentFile.path
    );
    if (!newFile) return;
    if (asChild) await this.addParent(newFile, this.currentFile);
    else await this.addParent(this.currentFile, newFile);
    this.render();
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
    if (import_obsidian.Platform.isMobile) {
      this.historyLayer.style.bottom = `${this.plugin.settings.mobileHistoryOffset}px`;
    } else {
      this.historyLayer.style.bottom = "";
    }
    this.historyLayer.empty();
    const files = this.getRecentFiles();
    if (files.length === 0) {
      this.historyLayer.style.display = "none";
      return;
    }
    this.historyLayer.style.display = "block";
    const row = this.historyLayer.createDiv({
      cls: "brain-history-row"
    });
    for (const file of files) {
      const item = row.createDiv({
        cls: "brain-history-item",
        text: file.basename
      });
      item.dataset.path = file.path;
      item.addEventListener("click", () => this.openNote(file));
    }
  }
  /* --------------------- rendering --------------------- */
  render() {
    if (!this.svg || !this.nodeLayer) return;
    this.nodeLayer.empty();
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    this.pointEls.clear();
    this.renderHistory();
    if (!this.currentFile) {
      this.nodeLayer.createDiv({
        cls: "brain-empty",
        text: "Open a markdown note to see its brain."
      });
      return;
    }
    const W = this.container.clientWidth;
    const cx = W / 2;
    const topPadding = 56;
    const parentToCenterGap = 95;
    const centerToChildGap = 90;
    const parentsY = topPadding;
    const centerY = parentsY + parentToCenterGap;
    const childrenY = centerY + centerToChildGap;
    const parents = this.getParents(this.currentFile);
    const children = this.getChildren(this.currentFile);
    this.makeNode(this.currentFile, cx, centerY, true);
    this.layoutRow(parents, W, parentsY);
    this.layoutChildrenTwoColumns(children, W, childrenY);
    window.requestAnimationFrame(
      () => this.drawLinks(parents, children)
    );
  }
  layoutRow(files, W, y) {
    const n = files.length;
    if (n === 0) return;
    const gap = W / (n + 1);
    files.forEach((f, i) => {
      this.makeNode(f, gap * (i + 1), y, false);
    });
  }
  layoutChildrenTwoColumns(files, W, startY) {
    const n = files.length;
    if (n === 0) return;
    const cx = W / 2;
    const colOffset = Math.min(W / 4, 180);
    const leftX = cx - colOffset;
    const rightX = cx + colOffset;
    const rowGap = 55;
    files.forEach((f, i) => {
      const col = i % 2;
      const rowIndex = Math.floor(i / 2);
      const x = col === 0 ? leftX : rightX;
      const y = startY + rowIndex * rowGap;
      this.makeNode(f, x, y, false);
    });
  }
  makeNode(file, x, y, central) {
    const node = this.nodeLayer.createDiv({
      cls: "brain-node" + (central ? " brain-central" : "")
    });
    node.dataset.path = file.path;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    const hasParents = this.getParents(file).length > 0;
    const hasChildren = this.getChildren(file).length > 0;
    const top = node.createDiv({
      cls: "brain-point brain-point-top" + (hasParents ? " brain-point-connected" : "")
    });
    top.dataset.path = file.path;
    top.dataset.direction = "top";
    this.pointEls.set(`${file.path}|top`, top);
    const isMobile = import_obsidian.Platform.isMobile;
    const truncateAt = 18;
    const needsTruncation = !central && isMobile && file.basename.length > truncateAt;
    const displayName = needsTruncation ? file.basename.substring(0, truncateAt) + "\u2026" : file.basename;
    const label = node.createDiv({
      cls: "brain-label",
      text: displayName,
      attr: { "data-fullname": file.basename }
    });
    label.addEventListener("click", () => this.openNote(file));
    const bottom = node.createDiv({
      cls: "brain-point brain-point-bottom" + (hasChildren ? " brain-point-connected" : "")
    });
    bottom.dataset.path = file.path;
    bottom.dataset.direction = "bottom";
    this.pointEls.set(`${file.path}|bottom`, bottom);
    top.addEventListener(
      "mousedown",
      (e) => this.startDrag(e, file, "top")
    );
    bottom.addEventListener(
      "mousedown",
      (e) => this.startDrag(e, file, "bottom")
    );
  }
  /** Open a note in a real editor pane (never on top of the canvas). */
  openNote(file) {
    var _a;
    const { workspace } = this.app;
    const mdLeaves = workspace.getLeavesOfType("markdown");
    let target = (_a = mdLeaves.find((l) => l !== this.leaf)) != null ? _a : null;
    if (!target) target = workspace.getLeaf("split", "vertical");
    target.openFile(file).then(() => {
      this.currentFile = file;
      this.touchHistory(file);
      this.render();
    });
  }
  pointCenter(path, dir) {
    const el = this.pointEls.get(`${path}|${dir}`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cr = this.container.getBoundingClientRect();
    return {
      x: r.left - cr.left + r.width / 2,
      y: r.top - cr.top + r.height / 2
    };
  }
  drawLinks(parents, children) {
    if (!this.currentFile) return;
    const center = this.currentFile;
    for (const c of children) {
      const a = this.pointCenter(center.path, "bottom");
      const b = this.pointCenter(c.path, "top");
      if (a && b) this.drawLine(a.x, a.y, b.x, b.y);
    }
    for (const p of parents) {
      const a = this.pointCenter(p.path, "bottom");
      const b = this.pointCenter(center.path, "top");
      if (a && b) this.drawLine(a.x, a.y, b.x, b.y);
    }
  }
  drawLine(x1, y1, x2, y2) {
    const ns = "http://www.w3.org/2000/svg";
    if (!this.plugin.settings.useCurvedLinks) {
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.addClass("brain-link");
      this.svg.appendChild(line);
      return;
    }
    const dy = (y2 - y1) * 0.5;
    const cx1 = x1;
    const cy1 = y1 + dy;
    const cx2 = x2;
    const cy2 = y2 - dy;
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`
    );
    path.addClass("brain-link");
    this.svg.appendChild(path);
  }
  /* --------------------- connection-point dragging --------------------- */
  startDrag(e, file, dir) {
    e.preventDefault();
    e.stopPropagation();
    const start = this.pointCenter(file.path, dir);
    if (!start) return;
    const ns = "http://www.w3.org/2000/svg";
    const line = document.createElementNS(ns, "line");
    line.addClass("brain-link", "brain-link-temp");
    line.setAttribute("x1", String(start.x));
    line.setAttribute("y1", String(start.y));
    line.setAttribute("x2", String(start.x));
    line.setAttribute("y2", String(start.y));
    this.svg.appendChild(line);
    this.drag = {
      active: true,
      sourcePath: file.path,
      direction: dir,
      line,
      startX: start.x,
      startY: start.y
    };
  }
  onMouseMove(e) {
    if (!this.drag.active || !this.drag.line) return;
    const cr = this.container.getBoundingClientRect();
    this.drag.line.setAttribute("x2", String(e.clientX - cr.left));
    this.drag.line.setAttribute("y2", String(e.clientY - cr.top));
  }
  onMouseUp(e) {
    var _a;
    const d = this.drag;
    if (!d.active) return;
    this.drag.active = false;
    if (d.line) {
      this.svg.removeChild(d.line);
      this.drag.line = null;
    }
    if (!this.currentFile) return;
    const source = this.app.vault.getAbstractFileByPath(d.sourcePath);
    if (!(source instanceof import_obsidian.TFile)) return;
    const targetEl = (_a = e.target) == null ? void 0 : _a.closest(
      ".brain-node, .brain-history-item"
    );
    if (targetEl && targetEl.dataset.path) {
      const destPath = targetEl.dataset.path;
      if (destPath !== source.path) {
        const dest = this.app.vault.getAbstractFileByPath(destPath);
        if (dest instanceof import_obsidian.TFile) {
          const op = d.direction === "bottom" ? this.addParent(dest, source) : this.addParent(source, dest);
          op.then(() => this.render());
        }
      }
      return;
    }
    const suggestions = this.getExistingNoteSuggestions(source.path);
    new NewNoteModal(this.app, suggestions, async (name) => {
      var _a2;
      const asChild = d.direction === "bottom";
      if (d.sourcePath === ((_a2 = this.currentFile) == null ? void 0 : _a2.path)) {
        await this.createLinkedNote(name, asChild);
      } else {
        const nf = await this.getOrCreateNoteFromInput(
          name,
          source.path
        );
        if (!nf) return;
        if (asChild) await this.addParent(nf, source);
        else await this.addParent(source, nf);
        this.render();
      }
    }).open();
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
      if (lp) {
        const dest = this.app.metadataCache.getFirstLinkpathDest(lp, "");
        if (dest) file = dest;
      }
    }
    if (file && file.extension === "md" && file.path !== this.currentFile.path) {
      await this.addParent(file, this.currentFile);
      this.render();
    }
  }
};
var BrainCanvasPlugin = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(
      VIEW_TYPE_BRAIN,
      (leaf) => new BrainView(leaf, this)
    );
    this.addRibbonIcon(
      "git-fork",
      "Open Brain Canvas",
      () => this.activateView()
    );
    this.addCommand({
      id: "open-brain-canvas",
      name: "Open Brain Canvas",
      callback: () => this.activateView()
    });
    this.addSettingTab(new BrainCanvasSettingTab(this.app, this));
  }
  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BRAIN);
  }
  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /** Re-render every open Brain Canvas view (used after a setting changes). */
  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_BRAIN).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof BrainView) view.render();
    });
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_BRAIN)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_BRAIN, active: true });
    }
    workspace.revealLeaf(leaf);
  }
};
var BrainCanvasSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    __publicField(this, "plugin");
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Curved links").setDesc(
      "Draw connections as smooth B\xE9zier curves. Turn off for straight lines."
    ).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.useCurvedLinks).onChange(async (value) => {
        this.plugin.settings.useCurvedLinks = value;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Mobile history offset").setDesc(
      "On mobile, raise the recent-thoughts strip by this many pixels so it stays clear of Obsidian's bottom menu. Desktop is unaffected."
    ).addSlider(
      (slider) => slider.setLimits(0, 200, 5).setValue(this.plugin.settings.mobileHistoryOffset).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.mobileHistoryOffset = value;
        await this.plugin.saveSettings();
        this.plugin.refreshViews();
      })
    );
  }
};
