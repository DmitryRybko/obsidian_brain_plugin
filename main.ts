import {
	App,
	ItemView,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	WorkspaceLeaf,
	debounce,
	normalizePath,
	setIcon,
} from "obsidian";

export const VIEW_TYPE_BRAIN = "brain-canvas-view";
const SVG_NS = "http://www.w3.org/2000/svg";

/* ------------------------- settings ------------------------- */

interface BrainCanvasSettings {
	parentsProperty: string;
	jumpsProperty: string;
	useCurvedLinks: boolean;
	mobileHistoryOffset: number;
	/** Which side of the central note siblings go on; jumps take the other side. */
	siblingsSide: "left" | "right";
	// "Filter view" toggles, remembered between sessions.
	showSiblings: boolean;
	showJumps: boolean;
}

const DEFAULT_SETTINGS: BrainCanvasSettings = {
	parentsProperty: "parents",
	jumpsProperty: "jumps",
	useCurvedLinks: true,
	mobileHistoryOffset: 60,
	siblingsSide: "right", // as in TheBrain: jumps left, siblings right
	showSiblings: true,
	showJumps: true,
};

type FilterKey = "showSiblings" | "showJumps";

const FILTERS: { key: FilterKey; label: string }[] = [
	{ key: "showSiblings", label: "Siblings" },
	{ key: "showJumps", label: "Jumps" },
];

/* ------------------------- layout constants ------------------------- */

const COMPACT_WIDTH = 600; // below this width, use the narrow (mobile) layout
const TOP_PADDING = 76; // room for the toolbar
const ROW_GAP = 48; // between wrapped rows of parents
const PARENT_TO_CENTER = 95;
const CENTER_TO_CHILD = 90;
const CHILD_ROW_GAP = 55;
const SIDE_ROW_GAP = 44;
const SIDE_ROW_GAP_COMPACT = 38;
const HISTORY_RESERVE = 56;

/* ------------------------- helpers ------------------------- */

const collator = new Intl.Collator(undefined, {
	sensitivity: "base",
	numeric: true,
});
const byName = (a: TFile, b: TFile) => collator.compare(a.basename, b.basename);

function extractLinkpath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let v = value.trim();
	const m = v.match(/^\[\[(.*?)\]\]$/);
	if (m) v = m[1];
	v = v.split("|")[0].split("#")[0].trim();
	return v || null;
}

function asList(value: unknown): unknown[] {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

/** Characters Obsidian can't use in file names, or that break [[links]]. */
const ILLEGAL_NAME_CHARS = /[\\:*?"<>|#^[\]]/;

type Role = "center" | "parent" | "child" | "jump" | "sibling";
/** Connection points ("gates", as TheBrain calls them) around a note. */
type Gate = "top" | "bottom" | "left" | "right";
type Side = "left" | "right";

/**
 * A removable relation.
 *  - parent: `a` (child) lists `b` (parent) in the parents property.
 *  - jump:   `a` and `b` are jump-linked; either note may declare it.
 */
interface LinkRef {
	kind: "parent" | "jump";
	a: string;
	b: string;
}

function linkKey(l: LinkRef): string {
	return l.kind === "jump"
		? `jump|${[l.a, l.b].sort().join("|")}`
		: `parent|${l.a}|${l.b}`;
}

/* ------------------------- relation index ------------------------- */

/**
 * Keeps parent/child/jump relations for the whole vault in memory so the view
 * never has to scan every file during a render. Updated per file on metadata
 * changes; fully rebuilt (lazily) after creates, deletes, renames or a
 * settings change.
 */
class RelationIndex {
	private parentsOf = new Map<string, Set<string>>(); // child -> parents
	private childrenOf = new Map<string, Set<string>>(); // parent -> children
	private jumpsOut = new Map<string, Set<string>>(); // declared in the note
	private jumpsIn = new Map<string, Set<string>>(); // declared in other notes
	private dirty = true;
	private static readonly EMPTY: ReadonlySet<string> = new Set();

	constructor(
		private app: App,
		private settings: () => BrainCanvasSettings
	) {}

	markDirty() {
		this.dirty = true;
	}

	/** Resolve one frontmatter value to a markdown file, relative to the note that holds it. */
	resolveValue(value: unknown, sourcePath: string): TFile | null {
		const lp = extractLinkpath(value);
		if (!lp) return null;
		const dest = this.app.metadataCache.getFirstLinkpathDest(lp, sourcePath);
		return dest && dest.extension === "md" ? dest : null;
	}

	resolveProperty(file: TFile, prop: string): TFile[] {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const out = new Map<string, TFile>();
		for (const v of asList(fm?.[prop])) {
			const dest = this.resolveValue(v, file.path);
			if (dest && dest.path !== file.path) out.set(dest.path, dest);
		}
		return [...out.values()];
	}

	/** Re-index one file. Returns true if its relations changed. */
	updateFile(file: TFile): boolean {
		if (this.dirty) return true;
		const before = this.signature(file.path);
		this.unindex(file.path);
		this.indexFile(file);
		return before !== this.signature(file.path);
	}

	parents(file: TFile): TFile[] {
		return this.toFiles(this.get(this.parentsOf, file.path));
	}

	children(file: TFile): TFile[] {
		return this.toFiles(this.get(this.childrenOf, file.path));
	}

	jumps(file: TFile): TFile[] {
		return this.toFiles(
			new Set([
				...this.get(this.jumpsOut, file.path),
				...this.get(this.jumpsIn, file.path),
			])
		);
	}

	/** Other children of this note's parents. */
	siblings(file: TFile): TFile[] {
		const out = new Set<string>();
		for (const p of this.get(this.parentsOf, file.path)) {
			for (const c of this.get(this.childrenOf, p)) {
				if (c !== file.path) out.add(c);
			}
		}
		return this.toFiles(out);
	}

	hasParents(path: string): boolean {
		return this.get(this.parentsOf, path).size > 0;
	}

	hasChildren(path: string): boolean {
		return this.get(this.childrenOf, path).size > 0;
	}

	isJump(a: string, b: string): boolean {
		return (
			this.get(this.jumpsOut, a).has(b) || this.get(this.jumpsIn, a).has(b)
		);
	}

	/* ----- internals ----- */

	private get(map: Map<string, Set<string>>, key: string): ReadonlySet<string> {
		if (this.dirty) this.rebuild();
		return map.get(key) ?? RelationIndex.EMPTY;
	}

	private toFiles(paths: Iterable<string>): TFile[] {
		const out: TFile[] = [];
		for (const p of paths) {
			const f = this.app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile) out.push(f);
		}
		return out.sort(byName);
	}

	private rebuild() {
		this.parentsOf.clear();
		this.childrenOf.clear();
		this.jumpsOut.clear();
		this.jumpsIn.clear();
		this.dirty = false;
		for (const md of this.app.vault.getMarkdownFiles()) this.indexFile(md);
	}

	private indexFile(file: TFile) {
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

	private unindex(path: string) {
		for (const p of this.parentsOf.get(path) ?? []) {
			this.childrenOf.get(p)?.delete(path);
		}
		this.parentsOf.delete(path);
		for (const j of this.jumpsOut.get(path) ?? []) {
			this.jumpsIn.get(j)?.delete(path);
		}
		this.jumpsOut.delete(path);
	}

	private signature(path: string): string {
		const parents = [...(this.parentsOf.get(path) ?? [])].sort().join("\n");
		const jumps = [...(this.jumpsOut.get(path) ?? [])].sort().join("\n");
		return `${parents}\u0000${jumps}`;
	}
}

function add(map: Map<string, Set<string>>, key: string, value: string) {
	let set = map.get(key);
	if (!set) map.set(key, (set = new Set()));
	set.add(value);
}

/* ------------------------- new-note modal ------------------------- */

class NewNoteModal extends Modal {
	private value = "";
	private inputEl: HTMLInputElement | null = null;
	private listEl: HTMLElement | null = null;
	private readonly suggestionLimit = 5;

	constructor(
		app: App,
		private readonly heading: string,
		private readonly suggestions: string[],
		private readonly onSubmit: (name: string) => Promise<void> | void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		// Lets CSS pin this modal to the top of the screen on mobile.
		this.containerEl.addClass("brain-new-note-modal-container");
		contentEl.createEl("h3", { text: this.heading });

		// Custom suggestion list, rendered ABOVE the input.
		// (Replaces the native <datalist>, whose dropdown covers the
		// entire screen, including the keyboard, on Android.)
		this.listEl = contentEl.createDiv({ cls: "brain-suggestion-list" });

		new Setting(contentEl).addText((text) => {
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

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Create / Link")
				.setCta()
				.onClick(() => this.commit())
		);

		this.renderSuggestions();
	}

	private renderSuggestions() {
		if (!this.listEl) return;
		this.listEl.empty();
		const query = this.value.trim().toLowerCase();
		const matches = this.suggestions
			.filter((s) => !query || s.toLowerCase().includes(query))
			.slice(0, this.suggestionLimit);

		this.listEl.toggleClass("is-hidden", matches.length === 0);
		for (const s of matches) {
			const item = this.listEl.createDiv({
				cls: "brain-suggestion-item",
				text: s,
			});
			// pointerdown + preventDefault: the input keeps focus and the
			// on-screen keyboard stays open while picking a suggestion.
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

	private commit() {
		const name = (this.inputEl?.value ?? this.value).trim();
		if (!name) return;
		this.close();
		Promise.resolve(this.onSubmit(name)).catch((err) => {
			console.error("Brain Canvas:", err);
			new Notice(`Brain Canvas: ${errorMessage(err)}`);
		});
	}

	onClose() {
		this.contentEl.empty();
		this.inputEl = null;
		this.listEl = null;
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function headingFor(kind: Role): string {
	return kind === "parent"
		? "Add parent"
		: kind === "child"
		? "Add child"
		: kind === "jump"
		? "Add jump"
		: "Add sibling";
}

/* ------------------------- the view ------------------------- */

interface ViewLayout {
	center: TFile;
	parents: TFile[];
	children: TFile[];
	jumps: TFile[];
	siblings: TFile[];
	compact: boolean;
	siblingsSide: Side;
	jumpsSide: Side;
}

type Point = { x: number; y: number };

export class BrainView extends ItemView {
	private plugin: BrainCanvasPlugin;
	private scroller!: HTMLElement;
	private stage!: HTMLElement;
	private svg!: SVGSVGElement;
	private nodeLayer!: HTMLElement;
	private historyLayer!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private filterButtons = new Map<FilterKey, HTMLButtonElement>();

	private currentFile: TFile | null = null;
	private layout: ViewLayout | null = null;
	private nodeEls = new Map<string, HTMLElement>(); // path -> label element
	private pointEls = new Map<string, HTMLElement>(); // `${path}|${gate}`
	private selectedLink: LinkRef | null = null;
	private deleteBtn: HTMLElement | null = null;
	private tooltipEl: HTMLElement | null = null;
	private tooltipTimer: number | null = null;
	private linkFrame: number | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private lastWidth = 0;
	private suppressClickUntil = 0;

	private recentPaths: string[] = [];
	private readonly historyLimit = 20;

	private drag: {
		active: boolean;
		pointerId: number;
		sourcePath: string;
		gate: Gate;
		line: SVGLineElement | null;
		startX: number;
		startY: number;
		moved: boolean;
	} = {
		active: false,
		pointerId: -1,
		sourcePath: "",
		gate: "bottom",
		line: null,
		startX: 0,
		startY: 0,
		moved: false,
	};

	constructor(leaf: WorkspaceLeaf, plugin: BrainCanvasPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_BRAIN;
	}

	getDisplayText(): string {
		return "Brain Canvas";
	}

	getIcon(): string {
		return "git-fork";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("brain-root");

		// Scrollable canvas; the stage grows with the content.
		this.scroller = root.createDiv({ cls: "brain-canvas" });
		this.stage = this.scroller.createDiv({ cls: "brain-stage" });

		// SVG layer for links (behind nodes)
		this.svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
		this.svg.addClass("brain-svg");
		this.stage.appendChild(this.svg);

		// HTML layer for note labels + connection points (above svg)
		this.nodeLayer = this.stage.createDiv({ cls: "brain-node-layer" });

		// Fixed overlays (don't scroll with the canvas)
		this.buildToolbar(root);
		this.historyLayer = root.createDiv({ cls: "brain-history" });

		// Re-render when the width changes (height changes don't affect layout).
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
				if (
					view instanceof MarkdownView &&
					view.file &&
					view.file.extension === "md"
				) {
					this.navigateTo(view.file);
				}
			})
		);

		// Keep history paths valid across renames (files and folders).
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.recentPaths = this.recentPaths.map((p) =>
					p === oldPath
						? file.path
						: p.startsWith(oldPath + "/")
						? file.path + p.slice(oldPath.length)
						: p
				);
			})
		);

		// Gate dragging. Pointer events cover mouse, touch and pen;
		// the captured pointer's events bubble up to the stage.
		this.registerDomEvent(this.stage, "pointermove", (e) =>
			this.onPointerMove(e)
		);
		this.registerDomEvent(this.stage, "pointerup", (e) => this.onPointerUp(e));
		this.registerDomEvent(this.stage, "pointercancel", () => this.cancelDrag());

		// Click on empty canvas clears a selected link.
		this.registerDomEvent(this.stage, "click", (e) => {
			const t = e.target as Element;
			if (this.selectedLink && !t.closest(".brain-link-group, .brain-link-delete")) {
				this.selectedLink = null;
				this.drawLinks();
			}
		});

		// Hide the full-name tooltip when the canvas scrolls.
		this.registerDomEvent(this.scroller, "scroll", () => this.hideTooltip());

		// Accept files dropped from the file explorer.
		this.registerDomEvent(this.scroller, "dragover", (e) => e.preventDefault());
		this.registerDomEvent(this.scroller, "drop", (e) => this.onDrop(e));

		this.app.workspace.onLayoutReady(() => {
			window.requestAnimationFrame(() => this.render());
		});
	}

	async onClose() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.cancelLinkFrame();
		this.hideTooltip();
		this.contentEl.empty();
	}

	private navigateTo(file: TFile) {
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

	private getExistingNoteSuggestions(excludePath?: string): string[] {
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path !== excludePath);

		const basenameCounts = new Map<string, number>();
		for (const f of files) {
			basenameCounts.set(f.basename, (basenameCounts.get(f.basename) ?? 0) + 1);
		}

		// Duplicate basenames are shown as paths so the user can tell them apart.
		return files
			.map((f) =>
				(basenameCounts.get(f.basename) ?? 0) > 1
					? f.path.replace(/\.md$/i, "")
					: f.basename
			)
			.sort((a, b) => collator.compare(a, b));
	}

	/* --------------------- recent history --------------------- */

	private touchHistory(file: TFile) {
		if (file.extension !== "md") return;
		this.recentPaths = this.recentPaths.filter((p) => p !== file.path);
		this.recentPaths.push(file.path); // newest on right
		if (this.recentPaths.length > this.historyLimit) {
			this.recentPaths = this.recentPaths.slice(-this.historyLimit);
		}
	}

	private getRecentFiles(): TFile[] {
		const out: TFile[] = [];
		for (const path of this.recentPaths) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile && f.extension === "md") out.push(f);
		}
		return out;
	}

	private renderHistory() {
		if (!this.historyLayer) return;
		this.contentEl.setCssProps({
			"--brain-history-offset": `${this.plugin.settings.mobileHistoryOffset}px`,
		});
		this.historyLayer.empty();

		const files = this.getRecentFiles();
		this.historyLayer.toggleClass("is-hidden", files.length === 0);
		if (files.length === 0) return;

		const row = this.historyLayer.createDiv({ cls: "brain-history-row" });
		// oldest -> newest (newest appears on right)
		for (const file of files) {
			const item = row.createDiv({
				cls: "brain-history-item",
				text: file.basename,
				attr: { title: file.path },
			});
			item.toggleClass("is-current", file === this.currentFile);
			item.dataset.path = file.path;
			item.addEventListener("click", () => this.openNote(file));
		}
		// Keep the newest item in view.
		row.scrollLeft = row.scrollWidth;
	}

	/* --------------------- toolbar --------------------- */

	private buildToolbar(root: HTMLElement) {
		this.toolbarEl = root.createDiv({ cls: "brain-toolbar" });

		// Left: filter-view toggles.
		const filters = this.toolbarEl.createDiv({
			cls: "brain-filters",
			attr: { role: "group", "aria-label": "Show on canvas" },
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

		// Right: create/link actions for the central note.
		this.actionsEl = this.toolbarEl.createDiv({ cls: "brain-actions" });
		const action = (icon: string, label: string, kind: Role) => {
			const btn = this.actionsEl.createEl("button", {
				cls: "brain-toolbar-btn",
				attr: { "aria-label": label },
			});
			setIcon(btn, icon);
			btn.addEventListener("click", () => this.promptLinkedNote(kind));
		};
		action("corner-left-up", "Add parent", "parent");
		action("corner-right-down", "Add child", "child");
		action("arrow-left-right", "Add jump", "jump");
		action("users", "Add sibling", "sibling");
	}

	private updateToolbar(counts: Record<FilterKey, number> | null) {
		for (const { key } of FILTERS) {
			const btn = this.filterButtons.get(key);
			if (!btn) continue;
			const on = this.plugin.settings[key];
			btn.toggleClass("is-active", on);
			btn.setAttr("aria-pressed", on ? "true" : "false");
			const count = counts?.[key] ?? 0;
			const countEl = btn.querySelector(".brain-filter-count");
			if (countEl) countEl.textContent = count > 0 ? String(count) : "";
		}
		this.actionsEl.toggleClass("is-hidden", !this.currentFile);
	}

	private promptLinkedNote(kind: Role) {
		const center = this.currentFile;
		if (!center) return;
		if (kind === "sibling" && !this.plugin.index.hasParents(center.path)) {
			new Notice("Siblings share a parent. Add a parent to this note first.");
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
	private async link(kind: Role, center: TFile, other: TFile) {
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

		// The current note may have been deleted.
		if (
			this.currentFile &&
			!(this.app.vault.getAbstractFileByPath(this.currentFile.path) instanceof TFile)
		) {
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
				text: "Open a markdown note to see its brain.",
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
			showJumps: allJumps.length,
		});

		// Each note appears once; earlier roles win.
		const shown = new Set<string>([center.path]);
		const take = (files: TFile[]) =>
			files.filter((f) => {
				if (shown.has(f.path)) return false;
				shown.add(f.path);
				return true;
			});
		const parents = take(idx.parents(center));
		const children = take(idx.children(center));
		const jumps = s.showJumps ? take(allJumps) : [];
		const siblings = s.showSiblings ? take(allSiblings) : [];

		const siblingsSide: Side = s.siblingsSide === "left" ? "left" : "right";
		const layout: ViewLayout = {
			center,
			parents,
			children,
			jumps,
			siblings,
			compact: Platform.isMobile || W < COMPACT_WIDTH,
			siblingsSide,
			jumpsSide: siblingsSide === "left" ? "right" : "left",
		};
		this.layout = layout;
		this.stage.toggleClass("is-compact", layout.compact);

		const bottom = this.layoutAll(layout, W);

		const reserve = this.historyLayer.hasClass("is-hidden")
			? 24
			: HISTORY_RESERVE + (Platform.isMobile ? s.mobileHistoryOffset : 0);
		const height = Math.max(this.scroller.clientHeight, bottom + 40 + reserve);
		this.stage.setCssProps({ "--brain-stage-height": `${height}px` });

		// Draw links once the DOM has measurable geometry.
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
	private layoutAll(L: ViewLayout, W: number): number {
		const hasSides = L.jumps.length > 0 || L.siblings.length > 0;
		const sideW = !hasSides
			? 0
			: L.compact
			? Math.round(W * 0.3)
			: Math.min(230, Math.max(150, W * 0.22));
		this.stage.setCssProps({
			"--brain-side-width": `${sideW}px`,
			// room left for the central label between the side columns
			"--brain-center-width": `${Math.max(110, W - 2 * sideW - 24)}px`,
		});
		const cx = W / 2;
		const gap = L.compact ? SIDE_ROW_GAP_COMPACT : SIDE_ROW_GAP;

		// Parents: above, between the side columns on desktop; full width on
		// mobile, where the side columns start at the central note instead.
		const pLeft = L.compact ? 0 : sideW;
		const pRight = L.compact ? W : W - sideW;
		let centerY = TOP_PADDING;
		if (L.parents.length) {
			const lastRowY = this.layoutRows(
				L.parents, "parent", pLeft, pRight, TOP_PADDING, L.compact ? 110 : 130
			);
			centerY = lastRowY + PARENT_TO_CENTER;
		}
		this.makeNode(L.center, cx, centerY, "center");

		// Side columns, aligned toward the central note (as in TheBrain).
		const xFor = (side: Side) => (side === "left" ? sideW - 6 : W - sideW + 6);
		const topLimit = L.compact ? centerY : TOP_PADDING;
		const sideBottom = Math.max(
			this.layoutColumn(L.jumps, "jump", xFor(L.jumpsSide), centerY, gap, topLimit),
			this.layoutColumn(L.siblings, "sibling", xFor(L.siblingsSide), centerY, gap, topLimit)
		);

		// Children: two columns below. On desktop they sit between the side
		// columns; on mobile they use the full width below the side columns.
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
	private layoutRows(
		files: TFile[],
		role: Role,
		left: number,
		right: number,
		startY: number,
		minSpacing: number
	): number {
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
	private layoutColumn(
		files: TFile[],
		role: Role,
		x: number,
		centerY: number,
		gap: number,
		topLimit: number
	): number {
		if (files.length === 0) return 0;
		const startY = Math.max(topLimit, centerY - ((files.length - 1) * gap) / 2);
		files.forEach((f, i) => this.makeNode(f, x, startY + i * gap, role));
		return startY + (files.length - 1) * gap;
	}

	/** Children in two columns. Returns the bottom y. */
	private layoutChildren(files: TFile[], cx: number, colOffset: number, startY: number): number {
		files.forEach((f, i) => {
			const x = i % 2 === 0 ? cx - colOffset : cx + colOffset;
			const y = startY + Math.floor(i / 2) * CHILD_ROW_GAP;
			this.makeNode(f, x, y, "child");
		});
		return files.length
			? startY + Math.floor((files.length - 1) / 2) * CHILD_ROW_GAP
			: 0;
	}

	private makeNode(file: TFile, x: number, y: number, role: Role) {
		const idx = this.plugin.index;
		const L = this.layout;
		const node = this.nodeLayer.createDiv({
			cls: ["brain-node", `brain-role-${role}`],
		});
		if (role === "center") node.addClass("brain-central");
		const side = role === "jump" || role === "sibling";
		if (side && L) {
			// Anchor the edge that faces the central note.
			const columnSide = role === "jump" ? L.jumpsSide : L.siblingsSide;
			node.addClass("brain-side", columnSide === "left" ? "brain-anchor-end" : "brain-anchor-start");
		}
		node.dataset.path = file.path;
		node.setCssProps({ "--brain-x": `${x}px`, "--brain-y": `${y}px` });

		const addGate = (parent: HTMLElement, gate: Gate, label: string) => {
			const el = parent.createDiv({ cls: `brain-point brain-point-${gate}` });
			el.setAttr("aria-label", label);
			el.addEventListener("pointerdown", (e) => this.startDrag(e, file, gate));
			this.pointEls.set(`${file.path}|${gate}`, el);
			return el;
		};

		// Side notes stay clean: no gates, like TheBrain's jump/sibling lists.
		if (!side) {
			const top = addGate(node, "top", "Drag to link a parent");
			top.toggleClass("brain-point-connected", idx.hasParents(file.path));
		}

		// The central note also gets side gates: jumps on one side, siblings
		// on the other.
		const row = node.createDiv({ cls: "brain-node-row" });
		const sideGate = (side: Side) => {
			if (role !== "center" || !L) return;
			const isJump = side === L.jumpsSide;
			const g = addGate(row, side, isJump ? "Drag to link a jump" : "Drag to link a sibling");
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
	private wireOpenAndMenu(el: HTMLElement, file: TFile, role: Role) {
		el.addEventListener("click", (e) => {
			e.stopPropagation();
			if (Date.now() < this.suppressClickUntil) return;
			this.openNote(file);
		});
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			if (Platform.isMobile) return; // long-press below handles touch
			this.openNodeMenu(file, role, e);
		});

		// Long-press for touch (iOS doesn't fire contextmenu reliably).
		let timer: number | null = null;
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
	private wireFullName(el: HTMLElement, name: string) {
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

	private showTooltip(anchor: HTMLElement, text: string) {
		this.hideTooltip();
		const tip = this.nodeLayer.createDiv({ cls: "brain-tooltip", text });
		const r = anchor.getBoundingClientRect();
		const p = this.toStage(r.left + r.width / 2, r.top);
		// Keep the bubble inside the canvas horizontally.
		const W = this.stage.clientWidth;
		const half = tip.offsetWidth / 2;
		const x = Math.min(Math.max(p.x, half + 6), W - half - 6);
		tip.setCssProps({ "--brain-x": `${x}px`, "--brain-y": `${p.y}px` });
		this.tooltipEl = tip;
	}

	private hideTooltip(delay = 0) {
		if (this.tooltipTimer !== null) window.clearTimeout(this.tooltipTimer);
		this.tooltipTimer = null;
		const remove = () => {
			this.tooltipEl?.remove();
			this.tooltipEl = null;
		};
		if (delay > 0) this.tooltipTimer = window.setTimeout(remove, delay);
		else remove();
	}

	private openNodeMenu(file: TFile, role: Role, at: MouseEvent | Point) {
		const center = this.currentFile;
		const menu = new Menu();
		// Full name first: labels may be shortened, especially on mobile.
		menu.addItem((i) => i.setTitle(file.basename).setIcon("file-text").setDisabled(true));
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Open in new tab")
				.setIcon("file-plus")
				.onClick(() => this.app.workspace.getLeaf("tab").openFile(file))
		);

		if (center && role !== "center") {
			const link: LinkRef | null =
				role === "parent"
					? { kind: "parent", a: center.path, b: file.path }
					: role === "child"
					? { kind: "parent", a: file.path, b: center.path }
					: role === "jump"
					? { kind: "jump", a: center.path, b: file.path }
					: null;

			if (!this.plugin.index.isJump(center.path, file.path)) {
				menu.addItem((i) =>
					i
						.setTitle("Add as jump")
						.setIcon("arrow-left-right")
						.onClick(() => this.plugin.addJump(center, file))
				);
			}
			if (link) {
				menu.addSeparator();
				const title =
					role === "parent"
						? "Remove parent link"
						: role === "child"
						? "Remove child link"
						: "Remove jump";
				menu.addItem((i) =>
					i
						.setTitle(title)
						.setIcon("unlink")
						.setWarning(true)
						.onClick(() => this.removeLink(link))
				);
			}
		}

		if (at instanceof MouseEvent) menu.showAtMouseEvent(at);
		else menu.showAtPosition(at);
	}

	/** Open a note in a real editor pane (never on top of the canvas). */
	private async openNote(file: TFile) {
		const { workspace } = this.app;
		const mdLeaves = workspace.getLeavesOfType("markdown");
		const target =
			mdLeaves.find((l) => l !== this.leaf) ?? workspace.getLeaf("split", "vertical");
		await target.openFile(file);
		// file-open normally updates the view; this covers the case where it didn't.
		if (this.currentFile !== file) this.navigateTo(file);
	}

	/* --------------------- links --------------------- */

	private cancelLinkFrame() {
		if (this.linkFrame !== null) window.cancelAnimationFrame(this.linkFrame);
		this.linkFrame = null;
	}

	private clearSvg() {
		while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
	}

	private toStage(clientX: number, clientY: number): Point {
		const r = this.stage.getBoundingClientRect();
		return { x: clientX - r.left, y: clientY - r.top };
	}

	private pointCenter(path: string, gate: Gate): Point | null {
		const el = this.pointEls.get(`${path}|${gate}`);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return this.toStage(r.left + r.width / 2, r.top + r.height / 2);
	}

	/** Middle of a label's left or right edge. */
	private labelSide(path: string, side: Side): Point | null {
		const el = this.nodeEls.get(path);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return this.toStage(side === "left" ? r.left : r.right, r.top + r.height / 2);
	}

	private drawLinks() {
		this.clearSvg();
		this.deleteBtn?.remove();
		this.deleteBtn = null;
		const L = this.layout;
		if (!L) return;
		const center = L.center.path;
		const selectedKey = this.selectedLink ? linkKey(this.selectedLink) : null;
		let selectedMid: Point | null = null;

		const draw = (a: Point | null, b: Point | null, link: LinkRef, horizontal: boolean) => {
			if (!a || !b) return;
			const selected = linkKey(link) === selectedKey;
			const mid = this.drawLink(a, b, horizontal, {
				link,
				cls: link.kind === "jump" ? "brain-link-jump" : "",
				selected,
			});
			if (selected) selectedMid = mid;
		};

		// parents -> central: parent.bottom to central.top
		for (const p of L.parents) {
			draw(
				this.pointCenter(p.path, "bottom"),
				this.pointCenter(center, "top"),
				{ kind: "parent", a: center, b: p.path },
				false
			);
		}
		// central -> children: central.bottom to child.top
		for (const c of L.children) {
			draw(
				this.pointCenter(center, "bottom"),
				this.pointCenter(c.path, "top"),
				{ kind: "parent", a: c.path, b: center },
				false
			);
		}
		// jumps: from the central note's jump gate to the facing edge of each jump
		const facing = (side: Side): Side => (side === "left" ? "right" : "left");
		for (const j of L.jumps) {
			draw(
				this.pointCenter(center, L.jumpsSide),
				this.labelSide(j.path, facing(L.jumpsSide)),
				{ kind: "jump", a: center, b: j.path },
				true
			);
		}
		// siblings: faint dotted lines from the sibling gate (not removable:
		// a sibling is derived from shared parents)
		for (const sib of L.siblings) {
			const a = this.pointCenter(center, L.siblingsSide);
			const b = this.labelSide(sib.path, facing(L.siblingsSide));
			if (a && b) this.drawLink(a, b, true, { cls: "brain-link-sibling" });
		}

		// Re-attach a line being dragged, if any.
		if (this.drag.active && this.drag.line) this.svg.appendChild(this.drag.line);

		if (selectedMid && this.selectedLink) this.showDeleteButton(selectedMid, this.selectedLink);
		else this.selectedLink = null; // selection no longer visible
	}

	/**
	 * Draws a link; removable links get a wide invisible hit area.
	 * Returns its midpoint.
	 */
	private drawLink(
		a: Point,
		b: Point,
		horizontal: boolean,
		opts: { link?: LinkRef; cls?: string; selected?: boolean }
	): Point {
		let d: string;
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

		// With symmetric control points, t=0.5 lands exactly on the midpoint.
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}

	private showDeleteButton(at: Point, link: LinkRef) {
		const btn = this.nodeLayer.createEl("button", {
			cls: "brain-link-delete",
			attr: { "aria-label": "Remove link" },
		});
		setIcon(btn, "x");
		btn.setCssProps({ "--brain-x": `${at.x}px`, "--brain-y": `${at.y}px` });
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.removeLink(link);
		});
		this.deleteBtn = btn;
	}

	private async removeLink(link: LinkRef) {
		const a = this.app.vault.getAbstractFileByPath(link.a);
		const b = this.app.vault.getAbstractFileByPath(link.b);
		this.selectedLink = null;
		this.drawLinks();
		if (!(a instanceof TFile) || !(b instanceof TFile)) return;
		try {
			if (link.kind === "parent") {
				await this.plugin.removeRelation(a, this.plugin.settings.parentsProperty, b);
			} else {
				await this.plugin.removeJump(a, b);
			}
			new Notice(`Removed link: ${a.basename} – ${b.basename}`);
		} catch (err) {
			console.error("Brain Canvas:", err);
			new Notice(`Couldn't remove link: ${errorMessage(err)}`);
		}
	}

	/* --------------------- gate dragging --------------------- */

	private startDrag(e: PointerEvent, file: TFile, gate: Gate) {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();

		const start = this.pointCenter(file.path, gate);
		if (!start) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

		const line = document.createElementNS(SVG_NS, "line") as SVGLineElement;
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
			moved: false,
		};
	}

	private onPointerMove(e: PointerEvent) {
		const d = this.drag;
		if (!d.active || !d.line || e.pointerId !== d.pointerId) return;
		const p = this.toStage(e.clientX, e.clientY);
		if (Math.hypot(p.x - d.startX, p.y - d.startY) > 6) d.moved = true;
		d.line.setAttribute("x2", String(p.x));
		d.line.setAttribute("y2", String(p.y));
	}

	private cancelDrag() {
		if (this.drag.line?.parentNode) this.drag.line.parentNode.removeChild(this.drag.line);
		this.drag.active = false;
		this.drag.line = null;
	}

	/** What dragging from a gate creates. */
	private roleForGate(gate: Gate): Role {
		if (gate === "top") return "parent";
		if (gate === "bottom") return "child";
		return this.layout && gate === this.layout.jumpsSide ? "jump" : "sibling";
	}

	private onPointerUp(e: PointerEvent) {
		const d = { ...this.drag };
		if (!d.active || e.pointerId !== d.pointerId) return;
		this.cancelDrag();
		if (!d.moved || !this.currentFile) return; // a tap on a gate does nothing

		const source = this.app.vault.getAbstractFileByPath(d.sourcePath);
		if (!(source instanceof TFile)) return;
		const kind = this.roleForGate(d.gate);

		if (kind === "sibling" && !this.plugin.index.hasParents(source.path)) {
			new Notice("Siblings share a parent. Add a parent to this note first.");
			return;
		}

		// With pointer capture, e.target is the source gate, so look up what's
		// actually under the pointer.
		const under = document.elementFromPoint(e.clientX, e.clientY);
		const targetEl = under?.closest<HTMLElement>(".brain-node, .brain-history-item");
		if (targetEl?.dataset.path) {
			if (targetEl.dataset.path === source.path) return;
			const dest = this.app.vault.getAbstractFileByPath(targetEl.dataset.path);
			if (dest instanceof TFile) {
				this.link(kind, source, dest).catch((err) =>
					new Notice(`Brain Canvas: ${errorMessage(err)}`)
				);
			}
			return;
		}

		// Dropped on empty space => create (or pick) a note and link it.
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

	private async onDrop(e: DragEvent) {
		e.preventDefault();
		if (!this.currentFile) return;

		// Obsidian's internal drag manager (private API), with a text fallback.
		const dm = (this.app as any).dragManager;
		let file: TFile | null = null;
		if (dm?.draggable?.file instanceof TFile) file = dm.draggable.file;

		if (!file) {
			const text = e.dataTransfer?.getData("text/plain");
			const lp = text ? extractLinkpath(text) || text : null;
			if (lp) file = this.app.metadataCache.getFirstLinkpathDest(lp, "");
		}

		if (file && file.extension === "md" && file.path !== this.currentFile.path) {
			await this.plugin.addParent(file, this.currentFile);
		}
	}
}

/* ------------------------- plugin entry ------------------------- */

export default class BrainCanvasPlugin extends Plugin {
	declare settings: BrainCanvasSettings;
	index!: RelationIndex;
	private resolvedOnce = false;

	/** Coalesces bursts of vault/metadata events into one re-render. */
	scheduleRefresh = debounce(() => this.refreshViews(), 150, true);

	async onload() {
		await this.loadSettings();
		this.index = new RelationIndex(this.app, () => this.settings);

		this.registerView(VIEW_TYPE_BRAIN, (leaf) => new BrainView(leaf, this));

		this.addRibbonIcon("git-fork", "Open Brain Canvas", () => this.activateView());

		this.addCommand({
			id: "open-brain-canvas",
			name: "Open Brain Canvas",
			callback: () => this.activateView(),
		});

		this.addSettingTab(new BrainCanvasSettingTab(this.app, this));

		// Only re-render when a file's relations actually changed.
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.extension === "md" && this.index.updateFile(file)) {
					this.scheduleRefresh();
				}
			})
		);
		// First full metadata pass after startup.
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				if (this.resolvedOnce) return;
				this.resolvedOnce = true;
				this.invalidate();
			})
		);
		// Creates, deletes and renames can change how links resolve.
		this.app.workspace.onLayoutReady(() => {
			// (Registered after layout-ready: "create" fires for every file on vault load.)
			this.registerEvent(this.app.vault.on("create", () => this.invalidate()));
		});
		this.registerEvent(this.app.vault.on("delete", () => this.invalidate()));
		this.registerEvent(this.app.vault.on("rename", () => this.invalidate()));
	}

	// No detachLeavesOfType here: Obsidian restores the view in place after updates.
	onunload() {}

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
	async removeRelation(owner: TFile, prop: string, target: TFile) {
		await this.app.fileManager.processFrontMatter(owner, (fm) => {
			const list = asList(fm[prop]);
			const kept = list.filter(
				(v) => this.index.resolveValue(v, owner.path)?.path !== target.path
			);
			if (kept.length === list.length) return;
			if (kept.length === 0) delete fm[prop];
			else fm[prop] = kept;
		});
	}

	/** Add a link to `target` in `owner[prop]`, unless one already resolves to it. */
	async addRelation(owner: TFile, prop: string, target: TFile) {
		if (owner.path === target.path) {
			new Notice("A note can't be linked to itself.");
			return;
		}
		// Shortest unambiguous link text, e.g. "Note" or "folder/Note" for duplicates.
		const linktext = this.app.metadataCache.fileToLinktext(target, owner.path, true);
		await this.app.fileManager.processFrontMatter(owner, (fm) => {
			const list = asList(fm[prop]);
			const exists = list.some(
				(v) => this.index.resolveValue(v, owner.path)?.path === target.path
			);
			if (exists) return;
			list.push(`[[${linktext}]]`);
			fm[prop] = list;
		});
	}

	async addParent(child: TFile, parent: TFile) {
		const prop = this.settings.parentsProperty;
		// Flip behaviour: if the inverse relation exists, remove it.
		await this.removeRelation(parent, prop, child);
		await this.addRelation(child, prop, parent);
	}

	async addJump(a: TFile, b: TFile) {
		if (this.index.isJump(a.path, b.path)) return;
		await this.addRelation(a, this.settings.jumpsProperty, b);
	}

	/** Make `other` a sibling of `note` by giving it all of `note`'s parents. */
	async addSibling(note: TFile, other: TFile) {
		const parents = this.index.parents(note);
		if (parents.length === 0) {
			new Notice("Siblings share a parent. Add a parent to this note first.");
			return;
		}
		for (const p of parents) {
			if (p.path !== other.path) await this.addParent(other, p);
		}
	}

	/** A jump may be declared on either note, so clear both sides. */
	async removeJump(a: TFile, b: TFile) {
		const prop = this.settings.jumpsProperty;
		await this.removeRelation(a, prop, b);
		await this.removeRelation(b, prop, a);
	}

	/* --------------------- note lookup / creation --------------------- */

	resolveExistingNote(input: string, contextPath: string): TFile | null {
		const raw = (extractLinkpath(input) ?? input).trim();
		if (!raw) return null;

		const asPath = normalizePath(raw.endsWith(".md") ? raw : `${raw}.md`);
		const byPath = this.app.vault.getAbstractFileByPath(asPath);
		if (byPath instanceof TFile && byPath.extension === "md") return byPath;

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
	async getOrCreateNote(input: string, context: TFile): Promise<TFile | null> {
		const existing = this.resolveExistingNote(input, context.path);
		if (existing) return existing;

		const raw = (extractLinkpath(input) ?? input).trim().replace(/\.md$/i, "");
		const segments = raw.split("/").map((s) => s.trim()).filter(Boolean);
		const name = segments.pop();
		if (!name) return null;

		if ([name, ...segments].some((s) => ILLEGAL_NAME_CHARS.test(s))) {
			new Notice('Note names can\'t contain any of these characters: \\ : * ? " < > | # ^ [ ]');
			return null;
		}

		let folder = segments.length
			? normalizePath(segments.join("/"))
			: this.app.fileManager.getNewFileParent(context.path).path;
		if (folder === "/") folder = "";
		const path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);

		try {
			if (folder) await this.ensureFolder(folder);
			const found = this.app.vault.getAbstractFileByPath(path);
			if (found instanceof TFile) return found;
			return await this.app.vault.create(path, "");
		} catch (err) {
			console.error("Brain Canvas:", err);
			new Notice(`Couldn't create "${name}": ${errorMessage(err)}`);
			return null;
		}
	}

	private async ensureFolder(path: string) {
		let current = "";
		for (const part of path.split("/")) {
			current = current ? `${current}/${part}` : part;
			const f = this.app.vault.getAbstractFileByPath(current);
			if (!f) await this.app.vault.createFolder(current);
			else if (!(f instanceof TFolder)) throw new Error(`"${current}" is a file, not a folder`);
		}
	}
}

/* ------------------------- settings tab ------------------------- */

class BrainCanvasSettingTab extends PluginSettingTab {
	plugin: BrainCanvasPlugin;

	constructor(app: App, plugin: BrainCanvasPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Rebuild the index after the user stops typing, not on every key.
		const applyProperties = debounce(
			async () => {
				await this.plugin.saveSettings();
				this.plugin.invalidate();
			},
			500,
			true
		);

		const propertySetting = (
			name: string,
			desc: string,
			key: "parentsProperty" | "jumpsProperty",
			other: "parentsProperty" | "jumpsProperty"
		) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_SETTINGS[key])
						.setValue(this.plugin.settings[key])
						.onChange((value) => {
							const v = value.trim();
							const invalid = !v || v === this.plugin.settings[other];
							text.inputEl.toggleClass("brain-input-invalid", invalid);
							if (invalid) return;
							this.plugin.settings[key] = v;
							applyProperties();
						})
				);

		new Setting(containerEl).setName("Properties").setHeading();
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

		new Setting(containerEl).setName("Appearance").setHeading();
		new Setting(containerEl)
			.setName("Siblings side")
			.setDesc("Which side of the central note siblings appear on. Jumps use the other side.")
			.addDropdown((dd) =>
				dd
					.addOption("right", "Right (jumps on the left, as in TheBrain)")
					.addOption("left", "Left (jumps on the right)")
					.setValue(this.plugin.settings.siblingsSide)
					.onChange(async (value) => {
						this.plugin.settings.siblingsSide = value === "left" ? "left" : "right";
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);

		new Setting(containerEl)
			.setName("Curved links")
			.setDesc("Draw connections as smooth Bézier curves. Turn off for straight lines.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useCurvedLinks).onChange(async (value) => {
					this.plugin.settings.useCurvedLinks = value;
					await this.plugin.saveSettings();
					this.plugin.refreshViews();
				})
			);

		new Setting(containerEl)
			.setName("Mobile history offset")
			.setDesc(
				"On mobile, raise the recent-notes strip by this many pixels so it stays clear of Obsidian's bottom menu. Desktop is unaffected."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 200, 5)
					.setValue(this.plugin.settings.mobileHistoryOffset)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.mobileHistoryOffset = value;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);
	}
}
