/*
 * On This Day Panel — Obsidian Plugin
 *
 * On a daily note (YYYY-MM-DD filename): shows files created/modified on that date.
 * On any other note: uses the note's own creation date as the context date.
 *
 * Sections: Created same day, Last modified same day, On this day (prev years),
 *           Backlinks, Outgoing links, External links.
 *           All togglable and reorderable via Settings.
 *
 * Live updates: internal links/backlinks via metadataCache 'changed' event;
 *               external links via vault 'modify' event. Both debounced.
 *
 * Data sources: Obsidian vault/metadataCache APIs only — no base file required.
 */

'use strict';

const { Plugin, ItemView, PluginSettingTab, Setting, openUrl } = require('obsidian');

const VIEW_TYPE         = 'daily-context-panel';
const DAILY_NOTE_RE     = /^\d{4}-\d{2}-\d{2}$/;
const EXCLUDED_PREFIXES = ['Misc/'];
const DEBOUNCE_MS       = 500;

const DEFAULT_SETTINGS = {
  showRibbonIcon: true,
  createdOnNonDaily: true,
  modifiedOnNonDaily: true,
  sections: [
    { id: 'created',    label: 'Created same day',          enabled: true  },
    { id: 'modified',   label: 'Last modified same day',    enabled: true  },
    { id: 'onthisday',  label: 'On this day — previous years', enabled: false },
    { id: 'backlinks',  label: 'Backlinks',                 enabled: false },
    { id: 'outgoing',   label: 'Outgoing links',            enabled: false },
    { id: 'external',   label: 'External links',            enabled: false },
  ]
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayBounds(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const start = new Date(year, month - 1, day).getTime();
  return { start, end: start + 86_400_000 - 1 };
}

function isExcluded(file) {
  for (const prefix of EXCLUDED_PREFIXES) {
    if (file.path.startsWith(prefix)) return true;
  }
  return false;
}

// Two-pass extraction: no lookbehind (mobile compatible).
function extractExternalLinks(content) {
  const results = [];
  const seen = new Set();
  let match;

  // Pass 1: [text](url) markdown links
  const mdRe = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  while ((match = mdRe.exec(content)) !== null) {
    const url = match[1];
    if (!seen.has(url)) {
      seen.add(url);
      const labelMatch = match[0].match(/^\[([^\]]+)\]/);
      results.push({ url, label: labelMatch ? labelMatch[1] : url });
    }
  }

  // Pass 2: bare URLs — strip markdown links first so their URLs aren't double-counted
  const stripped = content.replace(/\[[^\]]*\]\(https?:\/\/[^)\s]+\)/g, ' ');
  const bareRe = /https?:\/\/[^\s)\]]+/g;
  while ((match = bareRe.exec(stripped)) !== null) {
    const url = match[0];
    if (!seen.has(url)) {
      seen.add(url);
      results.push({ url, label: url });
    }
  }

  return results;
}

// ── View ──────────────────────────────────────────────────────────────────────

class DailyContextView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentFilePath = null;
    this._debounceTimer = null;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'On This Day'; }
  getIcon()        { return 'calendar-days'; }

  async onOpen() {
    this.containerEl.children[1].addClass('daily-context-panel');
    this._renderEmpty('Open a note to see context.');
  }

  async onClose() {
    clearTimeout(this._debounceTimer);
  }

  // Called when the active file changes (hard switch — no debounce)
  async renderForFile(file) {
    if (this.currentFilePath === file.path) return;
    this.currentFilePath = file.path;
    clearTimeout(this._debounceTimer);
    await this._render(file);
  }

  // Called on live edits — debounced to avoid repainting on every keystroke
  debouncedRefresh(changedFilePath) {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(async () => {
      const active = this.app.workspace.getActiveFile();
      if (!active) return;
      this.currentFilePath = null; // force full re-render
      await this._render(active);
    }, DEBOUNCE_MS);
  }

  // Called after settings change
  async refresh() {
    const file = this.app.workspace.getActiveFile();
    if (file) {
      this.currentFilePath = null;
      await this._render(file);
    }
  }

  clearView() {
    clearTimeout(this._debounceTimer);
    this.currentFilePath = null;
    this._renderEmpty('Open a note to see context.');
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

  async _render(file) {
    const root = this.containerEl.children[1];
    root.empty();

    const isDailyNote = DAILY_NOTE_RE.test(file.basename);
    const dateStr = isDailyNote ? file.basename : formatDate(file.stat.ctime);
    const { start, end } = dayBounds(dateStr);

    // Header
    const header = root.createEl('div', { cls: 'daily-context-header' });
    if (!isDailyNote) {
      const dailyFile = this.app.vault.getMarkdownFiles()
        .find(f => f.basename === dateStr);
      if (dailyFile) {
        const h4 = header.createEl('h4');
        const link = h4.createEl('a', {
          text: dateStr,
          cls: 'daily-context-link internal-link daily-context-date-link'
        });
        link.addEventListener('click', (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(dailyFile.path, '', false);
        });
      } else {
        header.createEl('h4', { text: dateStr });
      }
      header.createEl('div', {
        text: 'Context date from note creation',
        cls: 'daily-context-subheader'
      });
    } else {
      header.createEl('h4', { text: dateStr });
    }

    const enabledSections = this.plugin.settings.sections.filter(s => s.enabled);
    if (enabledSections.length === 0) {
      root.createEl('div', {
        text: 'No sections enabled. Check plugin settings.',
        cls: 'daily-context-empty'
      });
      return;
    }

    const showCreatedOnNonDaily  = this.plugin.settings.createdOnNonDaily  ?? true;
    const showModifiedOnNonDaily = this.plugin.settings.modifiedOnNonDaily ?? true;

    const showCreated  = isDailyNote || showCreatedOnNonDaily;
    const showModified = isDailyNote || showModifiedOnNonDaily;
    const sameDaySuffix = isDailyNote ? '' : ' on same day';

    // Single vault scan — only performed if at least one date section will render
    const needsDateScan = enabledSections.some(
      s => (s.id === 'created' && showCreated) || (s.id === 'modified' && showModified)
    );
    let created = [], modified = [];
    if (needsDateScan) {
      ({ created, modified } = this._collectDateFiles(start, end, file));
    }

    let anythingRendered = false;

    for (const section of enabledSections) {
      let rendered = false;
      switch (section.id) {
        case 'created':
          if (showCreated) rendered = this._renderFileList(root, `Created${sameDaySuffix}`, created);
          break;
        case 'modified':
          if (showModified) rendered = this._renderFileList(root, `Last modified${sameDaySuffix}`, modified);
          break;
        case 'onthisday':
          rendered = this._renderOnThisDay(root, dateStr, file);
          break;
        case 'backlinks':
          rendered = this._renderBacklinks(root, file);
          break;
        case 'outgoing':
          rendered = this._renderOutgoing(root, file);
          break;
        case 'external':
          rendered = await this._renderExternalLinks(root, file);
          break;
      }
      if (rendered) anythingRendered = true;
    }

    if (!anythingRendered) {
      root.createEl('div', {
        text: 'Nothing to show for this note.',
        cls: 'daily-context-empty'
      });
    }
  }

  // Single pass over the vault — returns both created and modified lists
  _collectDateFiles(start, end, currentFile) {
    const created  = [];
    const modified = [];

    for (const f of this.app.vault.getMarkdownFiles()) {
      if (isExcluded(f))               continue;
      if (f.path === currentFile.path) continue;
      if (DAILY_NOTE_RE.test(f.basename)) continue;

      const wasCreatedToday  = f.stat.ctime >= start && f.stat.ctime <= end;
      const wasModifiedToday = f.stat.mtime >= start && f.stat.mtime <= end;

      if (wasCreatedToday)       created.push(f);
      else if (wasModifiedToday) modified.push(f);
    }

    return { created, modified };
  }

  _renderOnThisDay(root, dateStr, currentFile) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const matches = [];

    for (const f of this.app.vault.getMarkdownFiles()) {
      if (isExcluded(f))               continue;
      if (f.path === currentFile.path) continue;
      if (DAILY_NOTE_RE.test(f.basename)) continue;

      const created = new Date(f.stat.ctime);
      if (
        created.getMonth() + 1 === month &&
        created.getDate()       === day   &&
        created.getFullYear()   !== year
      ) {
        matches.push(f);
      }
    }

    // Most recent year first
    matches.sort((a, b) => b.stat.ctime - a.stat.ctime);

    return this._renderFileList(root, 'On this day', matches);
  }

  _renderFileList(root, title, files) {
    if (files.length === 0) return false;

    root.createEl('div', {
      text: `${title} (${files.length})`,
      cls: 'daily-context-section-title'
    });
    const list = root.createEl('div', { cls: 'daily-context-list' });
    for (const f of files) this._renderInternalItem(list, f);
    return true;
  }

  _renderBacklinks(root, file) {
    const backlinks = [];
    const resolved = this.app.metadataCache.resolvedLinks;

    for (const [sourcePath, links] of Object.entries(resolved)) {
      if (sourcePath === file.path) continue;          // never link to itself
      if (links[file.path] === undefined) continue;
      const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
      if (sourceFile && !isExcluded(sourceFile)) backlinks.push(sourceFile);
    }

    return this._renderFileList(root, 'Backlinks', backlinks);
  }

  _renderOutgoing(root, file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const links = cache?.links ?? [];
    const seen = new Set();
    const outgoing = [];

    for (const link of links) {
      const target = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
      if (target && target.path !== file.path && !seen.has(target.path) && !isExcluded(target)) {
        seen.add(target.path);
        outgoing.push(target);
      }
    }

    return this._renderFileList(root, 'Outgoing links', outgoing);
  }

  async _renderExternalLinks(root, file) {
    let content;
    try {
      content = await this.app.vault.cachedRead(file);
    } catch {
      return false;
    }

    const links = extractExternalLinks(content);
    if (links.length === 0) return false;

    root.createEl('div', {
      text: `External links (${links.length})`,
      cls: 'daily-context-section-title'
    });
    const list = root.createEl('div', { cls: 'daily-context-list' });
    for (const { url, label } of links) this._renderExternalItem(list, url, label);
    return true;
  }

  // ── Item rendering ───────────────────────────────────────────────────────────

  _renderInternalItem(container, file) {
    const item = container.createEl('div', { cls: 'daily-context-item' });

    const link = item.createEl('a', {
      text: file.basename,
      cls: 'daily-context-link internal-link'
    });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      this.app.workspace.openLinkText(file.path, '', false);
    });

    const folder = file.parent?.path;
    if (folder && folder !== '/') {
      item.createEl('span', { text: folder, cls: 'daily-context-folder' });
    }
  }

  _renderExternalItem(container, url, label) {
    const item = container.createEl('div', { cls: 'daily-context-item' });

    const link = item.createEl('a', {
      text: label,
      cls: 'daily-context-link daily-context-external-link'
    });
    link.setAttribute('href', url);
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openUrl(url);
    });

    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      item.createEl('span', { text: domain, cls: 'daily-context-folder' });
    } catch { /* malformed URL */ }
  }

  _renderEmpty(message) {
    const root = this.containerEl.children[1];
    root.empty();
    root.createEl('div', { text: message, cls: 'daily-context-empty' });
  }
}

// ── Settings tab ──────────────────────────────────────────────────────────────

class DailyContextSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('On This Day Panel').setHeading();

    new Setting(containerEl)
      .setName('Show ribbon icon')
      .setDesc('Display the calendar icon in the ribbon for quick access.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showRibbonIcon)
        .onChange(async (value) => {
          this.plugin.settings.showRibbonIcon = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Show "Created on same day" on non-daily notes')
      .setDesc('When off, the Created section only appears on daily notes.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.createdOnNonDaily ?? true)
        .onChange(async (value) => {
          this.plugin.settings.createdOnNonDaily = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Show "Last modified on same day" on non-daily notes')
      .setDesc('When off, the Last modified section only appears on daily notes.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.modifiedOnNonDaily ?? true)
        .onChange(async (value) => {
          this.plugin.settings.modifiedOnNonDaily = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName('Sections').setHeading();

    containerEl.createEl('p', {
      text: 'Toggle sections on or off and reorder them using the arrows.',
      cls: 'setting-item-description'
    });

    const sections = this.plugin.settings.sections;

    sections.forEach((section, index) => {
      const setting = new Setting(containerEl)
        .setName(section.label)
        .addToggle(toggle => toggle
          .setValue(section.enabled)
          .onChange(async (value) => {
            section.enabled = value;
            await this.plugin.saveSettings();
          })
        );

      if (index > 0) {
        setting.addExtraButton(btn => btn
          .setIcon('arrow-up')
          .setTooltip('Move up')
          .onClick(async () => {
            [sections[index - 1], sections[index]] = [sections[index], sections[index - 1]];
            await this.plugin.saveSettings();
            this.display();
          })
        );
      }

      if (index < sections.length - 1) {
        setting.addExtraButton(btn => btn
          .setIcon('arrow-down')
          .setTooltip('Move down')
          .onClick(async () => {
            [sections[index + 1], sections[index]] = [sections[index], sections[index + 1]];
            await this.plugin.saveSettings();
            this.display();
          })
        );
      }
    });
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

class DailyContextPlugin extends Plugin {
  constructor(...args) {
    super(...args);
    this._ribbonIcon = null;
  }

  // Access the view without storing a direct reference (guideline: avoid view refs)
  _getView() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view ?? null;
  }

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new DailyContextView(leaf, this));

    this.addSettingTab(new DailyContextSettingTab(this.app, this));

    if (this.settings.showRibbonIcon) {
      this._ribbonIcon = this.addRibbonIcon('calendar-days', 'On This Day', () => this._activateView());
    }

    this.addCommand({
      id: 'open-on-this-day-panel',
      name: 'Open On This Day panel',
      callback: () => this._activateView()
    });

    // Switch to a new file
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        const view = this._getView();
        if (!view) return;
        if (file) view.renderForFile(file);
        else       view.clearView();
      })
    );

    // Live updates: internal links, outgoing links, backlinks
    // metadataCache 'changed' already fires after Obsidian's own idle debounce
    this.registerEvent(
      this.app.metadataCache.on('changed', (changedFile) => {
        const view = this._getView();
        if (!view) return;

        const active = this.app.workspace.getActiveFile();
        if (!active) return;

        const backlinkEnabled = this.settings.sections.some(
          s => s.id === 'backlinks' && s.enabled
        );
        // Only refresh if it's the current file, or backlinks are on (another
        // file could have just linked to the active one)
        if (changedFile.path !== active.path && !backlinkEnabled) return;

        view.debouncedRefresh(changedFile.path);
      })
    );

    // Live updates: external links (not in metadataCache — requires raw content read)
    this.registerEvent(
      this.app.vault.on('modify', (changedFile) => {
        const view = this._getView();
        if (!view) return;
        if (!this.settings.sections.some(s => s.id === 'external' && s.enabled)) return;

        const active = this.app.workspace.getActiveFile();
        if (!active || changedFile.path !== active.path) return;

        view.debouncedRefresh(changedFile.path);
      })
    );
  }

  onunload() {
    // Leaves are cleaned up automatically by Obsidian on unload
  }

  async loadSettings() {
    const saved = await this.loadData();
    if (saved?.sections) {
      const savedIds = new Set(saved.sections.map(s => s.id));
      const merged = [...saved.sections];
      for (const def of DEFAULT_SETTINGS.sections) {
        if (!savedIds.has(def.id)) merged.push(def);
      }
      this.settings = {
        showRibbonIcon:      saved.showRibbonIcon      ?? DEFAULT_SETTINGS.showRibbonIcon,
        createdOnNonDaily:   saved.createdOnNonDaily   ?? DEFAULT_SETTINGS.createdOnNonDaily,
        modifiedOnNonDaily:  saved.modifiedOnNonDaily  ?? DEFAULT_SETTINGS.modifiedOnNonDaily,
        sections: merged
      };
    } else {
      this.settings = structuredClone(DEFAULT_SETTINGS);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Sync ribbon icon visibility
    if (this.settings.showRibbonIcon && !this._ribbonIcon) {
      this._ribbonIcon = this.addRibbonIcon('calendar-days', 'On This Day', () => this._activateView());
    } else if (!this.settings.showRibbonIcon && this._ribbonIcon) {
      this._ribbonIcon.remove();
      this._ribbonIcon = null;
    }
    const view = this._getView();
    if (view) await view.refresh();
  }

  async _activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);

    const active = this.app.workspace.getActiveFile();
    const view = this._getView();
    if (active && view) await view.renderForFile(active);
  }
}

module.exports = DailyContextPlugin;
