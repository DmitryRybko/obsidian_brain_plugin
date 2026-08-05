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
	WorkspaceLeaf,
} from "obsidian";

export const VIEW_TYPE_BRAIN = "brain-canvas-view";

/* ------------------------- settings ------------------------- */

interface BrainCanvasSettings {
	useCurvedLinks: boolean;
	mobileHistoryOffset: number;
}

const DEFAULT_SETTINGS: BrainCanvasSettings = {
	useCurvedLinks: true,
	mobileHistoryOffset: 60,
};

/* ------------------------- helpers ------------------------- */

function extractLinkpath(value: any): string | null {
	if (typeof value !== "string") return null;
	let v = value.trim();
	const m = v.match(/^\[\[(.*?)\]\]$/);
	if (m) v = m[1];
	v = v.split("|")[0].split("#")[0].trim();
	return v || null;
}

/* ------------------------- new-note modal ------------------------- */

class NewNoteModal extends Modal {
	private onSubmit: (name: string) => void;
	private readonly suggestions: string[];
	private readonly title: string;
	private value = "";
	private inputEl: HTMLInputElement | null = null;

	constructor(
		app: App,
		suggestions: string[],
		onSubmit: (name: string) => void,
		title: string = "New note name"
	) {
		super(app);
		this.suggestions = suggestions;
		this.onSubmit = onSubmit;
		this.title = title;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });

		const listId = `brain-note-suggestions-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2)}`;
		if (this.suggestions.length > 0) {
			const datalist = contentEl.createEl("datalist");
			datalist.id = listId;
			for (const s of this.suggestions)
				datalist.createEl("option", { value: s });
		}

		new Setting(contentEl).addText((text) => {
			this.inputEl = text.inputEl;
			text.setPlaceholder("Type a new or existing note name");
			if (this.suggestions.length > 0) {
				text.inputEl.setAttribute("list", listId);
			}
			text.onChange((v) => (this.value = v));
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
	}

	private commit() {
		const name = (this.inputEl?.value ?? this.value).trim();
		if (name) {
			this.close();
			this.onSubmit(name);
		}
	}

	onClose() {
		this.contentEl.empty();
		this.inputEl = null;
	}
}

/* ------------------------- the view ------------------------- */

export class BrainView extends ItemView {
	private plugin: BrainCanvasPlugin;
	private container!: HTMLElement;
	private svg!: SVGSVGElement;
	private nodeLayer!: HTMLElement;
	private historyLayer!: HTMLElement;
	private currentFile: TFile | null = null;
	private pointEls: Map<string, HTMLElement> = new Map();
	private resizeObserver: ResizeObserver | null = null;
	private recentPaths: string[] = [];
	private readonly historyLimit = 20;
	private drag: {
		active: boolean;
		sourcePath: string;
		direction: "top" | "bottom";
		line: SVGLineElement | null;
		startX: number;
		startY: number;
	} = {
		active: false,
		sourcePath: "",
		direction: "bottom",
		line: null,
		startX: 0,
		startY: 0,
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

		this.container = root.createDiv({ cls: "brain-canvas" });

		// SVG layer for links (behind nodes)
		const svgNS = "http://www.w3.org/2000/svg";
		this.svg = document.createElementNS(svgNS, "svg") as SVGSVGElement;
		this.svg.addClass("brain-svg");
		this.container.appendChild(this.svg);

		// HTML layer for note labels + connection points (above svg)
		this.nodeLayer = this.container.createDiv({ cls: "brain-node-layer" });

		// Bottom recent-history strip
		this.historyLayer = this.container.createDiv({ cls: "brain-history" });

		// Header actions (the three-dots pane menu isn't surfaced on mobile)
		this.addAction("arrow-down", "Create child note", () =>
			this.promptCreateLinkedNote(true)
		);
		this.addAction("arrow-up", "Create parent note", () =>
			this.promptCreateLinkedNote(false)
		);

		// Re-render whenever the canvas changes size.
		this.resizeObserver = new ResizeObserver(() => {
			if (this.container.clientWidth > 0) this.render();
		});
		this.resizeObserver.observe(this.container);

		// pick an initial file
		const active = this.app.workspace.getActiveFile();
		if (active && active.extension === "md") {
			this.currentFile = active;
			this.touchHistory(active);
		}

		// update when a markdown file is opened
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file && file.extension === "md") {
					this.currentFile = file;
					this.touchHistory(file);
					this.render();
				}
			})
		);

		// update when focused pane changes
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!leaf || leaf === this.leaf) return;
				const view = leaf.view;
				if (
					view instanceof MarkdownView &&
					view.file &&
					view.file.extension === "md" &&
					view.file !== this.currentFile
				) {
					this.currentFile = view.file;
					this.touchHistory(view.file);
					this.render();
				}
			})
		);

		// re-render when metadata changes
		this.registerEvent(
			this.app.metadataCache.on("changed", () => this.render())
		);

		// live drag wiring
		this.container.addEventListener("mousemove", (e) => this.onMouseMove(e));
		this.container.addEventListener("mouseup", (e) => this.onMouseUp(e));

		// accept files dropped from explorer
		this.container.addEventListener("dragover", (e) => e.preventDefault());
		this.container.addEventListener("drop", (e) => this.onDrop(e));

		// initial render when layout is ready
		this.app.workspace.onLayoutReady(() => {
			window.requestAnimationFrame(() => this.render());
		});
	}

	async onClose() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.contentEl.empty();
	}

	/* --------------------- pane (three-dots) menu --------------------- */

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);

		menu.addItem((item) =>
			item
				.setTitle("Create child note")
				.setIcon("arrow-down")
				.setDisabled(!this.currentFile)
				.onClick(() => this.promptCreateLinkedNote(true))
		);

		menu.addItem((item) =>
			item
				.setTitle("Create parent note")
				.setIcon("arrow-up")
				.setDisabled(!this.currentFile)
				.onClick(() => this.promptCreateLinkedNote(false))
		);

		menu.addSeparator();
	}

	private promptCreateLinkedNote(asChild: boolean) {
		if (!this.currentFile) {
			new Notice("Open a note in the Brain Canvas first.");
			return;
		}
		const suggestions = this.getExistingNoteSuggestions(
			this.currentFile.path
		);
		new NewNoteModal(
			this.app,
			suggestions,
			(name) => {
				void this.createLinkedNote(name, asChild);
			},
			asChild ? "New child note" : "New parent note"
		).open();
	}

	/* --------------------- relationship lookups --------------------- */

	private getParents(file: TFile): TFile[] {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || fm.parents == null) return [];
		let parents = fm.parents;
		if (!Array.isArray(parents)) parents = [parents];
		const out: TFile[] = [];
		for (const p of parents) {
			const lp = extractLinkpath(p);
			if (!lp) continue;
			const dest = this.app.metadataCache.getFirstLinkpathDest(
				lp,
				file.path
			);
			if (dest) out.push(dest);
		}
		out.sort((a, b) =>
			a.basename.localeCompare(b.basename, undefined, {
				sensitivity: "base",
				numeric: true,
			})
		);
		return out;
	}

	private getChildren(file: TFile): TFile[] {
		const out: TFile[] = [];
		for (const md of this.app.vault.getMarkdownFiles()) {
			if (md.path === file.path) continue;
			if (this.getParents(md).some((p) => p.path === file.path))
				out.push(md);
		}
		out.sort((a, b) =>
			a.basename.localeCompare(b.basename, undefined, {
				sensitivity: "base",
				numeric: true,
			})
		);
		return out;
	}

	private getExistingNoteSuggestions(excludePath?: string): string[] {
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path !== excludePath);

		const basenameCounts = new Map<string, number>();
		for (const f of files) {
			basenameCounts.set(
				f.basename,
				(basenameCounts.get(f.basename) ?? 0) + 1
			);
		}

		const suggestions = files.map((f) =>
			(basenameCounts.get(f.basename) ?? 0) > 1
				? f.path.replace(/\.md$/i, "")
				: f.basename
		);

		suggestions.sort((a, b) =>
			a.localeCompare(b, undefined, {
				sensitivity: "base",
				numeric: true,
			})
		);

		return suggestions;
	}

	private resolveExistingNote(
		input: string,
		contextPath: string
	): TFile | null {
		const raw = (extractLinkpath(input) ?? input).trim();
		if (!raw) return null;

		const asPath = raw.endsWith(".md") ? raw : `${raw}.md`;
		const byPath = this.app.vault.getAbstractFileByPath(asPath);
		if (byPath instanceof TFile && byPath.extension === "md") return byPath;

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

	private async getOrCreateNoteFromInput(
		input: string,
		contextPath: string
	): Promise<TFile | null> {
		const existing = this.resolveExistingNote(input, contextPath);
		if (existing) return existing;

		const raw = (extractLinkpath(input) ?? input).trim();
		if (!raw) return null;

		const path = raw.endsWith(".md") ? raw : `${raw}.md`;
		const found = this.app.vault.getAbstractFileByPath(path);
		if (found instanceof TFile && found.extension === "md") return found;

		return await this.app.vault.create(path, "");
	}

	/* --------------------- frontmatter mutations --------------------- */

	private async removeParent(child: TFile, parent: TFile) {
		await this.app.fileManager.processFrontMatter(child, (fm) => {
			let parents = fm.parents;
			if (parents == null) return;
			if (!Array.isArray(parents)) parents = [parents];
			parents = parents.filter(
				(p: any) => extractLinkpath(p) !== parent.basename
			);
			fm.parents = parents;
		});
	}

	private async addParent(child: TFile, parent: TFile) {
		// Ensure flip behavior: if inverse relation exists, remove it.
		await this.removeParent(parent, child);

		await this.app.fileManager.processFrontMatter(child, (fm) => {
			let parents = fm.parents;
			if (parents == null) parents = [];
			if (!Array.isArray(parents)) parents = [parents];

			const link = `[[${parent.basename}]]`;
			const already = parents.some(
				(p: any) => extractLinkpath(p) === parent.basename
			);
			if (!already) parents.push(link);
			fm.parents = parents;
		});
	}

	private async createLinkedNote(name: string, asChild: boolean) {
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

		// On mobile, lift the strip above Obsidian's bottom menu.
		if (Platform.isMobile) {
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
			cls: "brain-history-row",
		});

		// oldest -> newest (newest appears on right)
		for (const file of files) {
			const item = row.createDiv({
				cls: "brain-history-item",
				text: file.basename,
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

		// Keep recent strip fresh
		this.renderHistory();

		if (!this.currentFile) {
			this.nodeLayer.createDiv({
				cls: "brain-empty",
				text: "Open a markdown note to see its brain.",
			});
			return;
		}

		const W = this.container.clientWidth;
		const cx = W / 2;

		// Top-aligned, denser vertical layout
		const topPadding = 56;
		const parentToCenterGap = 95;
		const centerToChildGap = 90;

		const parentsY = topPadding;
		const centerY = parentsY + parentToCenterGap;
		const childrenY = centerY + centerToChildGap;

		const parents = this.getParents(this.currentFile);
		const children = this.getChildren(this.currentFile);

		// central
		this.makeNode(this.currentFile, cx, centerY, true);

		// parents row (above)
		this.layoutRow(parents, W, parentsY);

		// children in two columns (below)
		this.layoutChildrenTwoColumns(children, W, childrenY);

		// draw links after DOM has measurable geometry
		window.requestAnimationFrame(() => this.drawLinks(parents, children));
	}

	private layoutRow(files: TFile[], W: number, y: number) {
		const n = files.length;
		if (n === 0) return;
		const gap = W / (n + 1);
		files.forEach((f, i) => {
			this.makeNode(f, gap * (i + 1), y, false);
		});
	}

	private layoutChildrenTwoColumns(
		files: TFile[],
		W: number,
		startY: number
	) {
		const n = files.length;
		if (n === 0) return;

		const cx = W / 2;
		const colOffset = Math.min(W / 4, 180);
		const leftX = cx - colOffset;
		const rightX = cx + colOffset;

		// smaller => children closer vertically
		const rowGap = 55;

		files.forEach((f, i) => {
			const col = i % 2; // 0 left, 1 right
			const rowIndex = Math.floor(i / 2);
			const x = col === 0 ? leftX : rightX;
			const y = startY + rowIndex * rowGap;
			this.makeNode(f, x, y, false);
		});
	}

	private makeNode(file: TFile, x: number, y: number, central: boolean) {
		const node = this.nodeLayer.createDiv({
			cls: "brain-node" + (central ? " brain-central" : ""),
		});
		node.dataset.path = file.path;
		node.style.left = `${x}px`;
		node.style.top = `${y}px`;

		const hasParents = this.getParents(file).length > 0;
		const hasChildren = this.getChildren(file).length > 0;

		const top = node.createDiv({
			cls:
				"brain-point brain-point-top" +
				(hasParents ? " brain-point-connected" : ""),
		});
		top.dataset.path = file.path;
		top.dataset.direction = "top";
		this.pointEls.set(`${file.path}|top`, top);

		const isMobile = Platform.isMobile;
		const truncateAt = 18;
		const needsTruncation =
			!central && isMobile && file.basename.length > truncateAt;
		const displayName = needsTruncation
			? file.basename.substring(0, truncateAt) + "…"
			: file.basename;

		const label = node.createDiv({
			cls: "brain-label",
			text: displayName,
			attr: { "data-fullname": file.basename },
		});
		label.addEventListener("click", () => this.openNote(file));

		const bottom = node.createDiv({
			cls:
				"brain-point brain-point-bottom" +
				(hasChildren ? " brain-point-connected" : ""),
		});
		bottom.dataset.path = file.path;
		bottom.dataset.direction = "bottom";
		this.pointEls.set(`${file.path}|bottom`, bottom);

		top.addEventListener("mousedown", (e) =>
			this.startDrag(e, file, "top")
		);
		bottom.addEventListener("mousedown", (e) =>
			this.startDrag(e, file, "bottom")
		);
	}

	/** Open a note in a real editor pane (never on top of the canvas). */
	private openNote(file: TFile) {
		const { workspace } = this.app;

		// Find existing markdown pane that isn't this canvas.
		const mdLeaves = workspace.getLeavesOfType("markdown");
		let target = mdLeaves.find((l) => l !== this.leaf) ?? null;

		// None available? Open one in a split next to canvas.
		if (!target) target = workspace.getLeaf("split", "vertical");

		target.openFile(file).then(() => {
			this.currentFile = file;
			this.touchHistory(file);
			this.render();
		});
	}

	private pointCenter(path: string, dir: "top" | "bottom") {
		const el = this.pointEls.get(`${path}|${dir}`);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const cr = this.container.getBoundingClientRect();
		return {
			x: r.left - cr.left + r.width / 2,
			y: r.top - cr.top + r.height / 2,
		};
	}

	private drawLinks(parents: TFile[], children: TFile[]) {
		if (!this.currentFile) return;
		const center = this.currentFile;

		// central -> children: central.bottom to child.top
		for (const c of children) {
			const a = this.pointCenter(center.path, "bottom");
			const b = this.pointCenter(c.path, "top");
			if (a && b) this.drawLine(a.x, a.y, b.x, b.y);
		}

		// parents -> central: parent.bottom to central.top
		for (const p of parents) {
			const a = this.pointCenter(p.path, "bottom");
			const b = this.pointCenter(center.path, "top");
			if (a && b) this.drawLine(a.x, a.y, b.x, b.y);
		}
	}

	private drawLine(x1: number, y1: number, x2: number, y2: number) {
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

		// Cubic Bézier
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

	private startDrag(e: MouseEvent, file: TFile, dir: "top" | "bottom") {
		e.preventDefault();
		e.stopPropagation();

		const start = this.pointCenter(file.path, dir);
		if (!start) return;

		const ns = "http://www.w3.org/2000/svg";
		const line = document.createElementNS(ns, "line") as SVGLineElement;
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
			startY: start.y,
		};
	}

	private onMouseMove(e: MouseEvent) {
		if (!this.drag.active || !this.drag.line) return;
		const cr = this.container.getBoundingClientRect();
		this.drag.line.setAttribute("x2", String(e.clientX - cr.left));
		this.drag.line.setAttribute("y2", String(e.clientY - cr.top));
	}

	private onMouseUp(e: MouseEvent) {
		const d = this.drag;
		if (!d.active) return;
		this.drag.active = false;
		if (d.line) {
			this.svg.removeChild(d.line);
			this.drag.line = null;
		}

		if (!this.currentFile) return;

		const source = this.app.vault.getAbstractFileByPath(d.sourcePath);
		if (!(source instanceof TFile)) return;

		// Dropped on an existing brain node OR history item?
		const targetEl = (e.target as HTMLElement)?.closest(
			".brain-node, .brain-history-item"
		) as HTMLElement | null;

		if (targetEl && targetEl.dataset.path) {
			const destPath = targetEl.dataset.path;
			if (destPath !== source.path) {
				const dest = this.app.vault.getAbstractFileByPath(destPath);
				if (dest instanceof TFile) {
					// dragging from bottom => dest becomes child of source
					const op =
						d.direction === "bottom"
							? this.addParent(dest, source)
							: this.addParent(source, dest);
					op.then(() => this.render());
				}
			}
			return;
		}

		// Dropped on empty space => create a new note and link it.
		const suggestions = this.getExistingNoteSuggestions(source.path);
		new NewNoteModal(this.app, suggestions, async (name) => {
			const asChild = d.direction === "bottom";
			if (d.sourcePath === this.currentFile?.path) {
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

	private async onDrop(e: DragEvent) {
		e.preventDefault();
		if (!this.currentFile) return;

		// Obsidian internal drag manager
		const dm = (this.app as any).dragManager;
		let file: TFile | null = null;
		if (dm?.draggable?.file instanceof TFile) file = dm.draggable.file;

		if (!file) {
			const text = e.dataTransfer?.getData("text/plain");
			const lp = text ? extractLinkpath(text) || text : null;
			if (lp) {
				const dest = this.app.metadataCache.getFirstLinkpathDest(lp, "");
				if (dest) file = dest;
			}
		}

		if (
			file &&
			file.extension === "md" &&
			file.path !== this.currentFile.path
		) {
			await this.addParent(file, this.currentFile);
			this.render();
		}
	}
}

/* ------------------------- plugin entry ------------------------- */

export default class BrainCanvasPlugin extends Plugin {
	declare settings: BrainCanvasSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_BRAIN,
			(leaf) => new BrainView(leaf, this)
		);

		this.addRibbonIcon("git-fork", "Open Brain Canvas", () =>
			this.activateView()
		);

		this.addCommand({
			id: "open-brain-canvas",
			name: "Open Brain Canvas",
			callback: () => this.activateView(),
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
		this.app.workspace
			.getLeavesOfType(VIEW_TYPE_BRAIN)
			.forEach((leaf) => {
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

		new Setting(containerEl)
			.setName("Curved links")
			.setDesc(
				"Draw connections as smooth Bézier curves. Turn off for straight lines."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useCurvedLinks)
					.onChange(async (value) => {
						this.plugin.settings.useCurvedLinks = value;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					})
			);

		new Setting(containerEl)
			.setName("Mobile history offset")
			.setDesc(
				"On mobile, raise the recent-thoughts strip by this many pixels so it stays clear of Obsidian's bottom menu. Desktop is unaffected."
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