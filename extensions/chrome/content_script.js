'use strict';

const FOLDERS_KEY = 'notebooklm_folders';
const ASSIGNMENTS_KEY = 'notebooklm_assignments';
const ACTIVE_FILTER_KEY = 'notebooklm_active_filter';
const OLD_CATEGORIES_KEY = 'notebooklm_user_categories';

// Muted ink-wash tones palette (8 colors)
const FOLDER_COLORS = [
    '#7B9EA8', // slate blue
    '#8D9B6A', // olive green
    '#A67B5B', // warm umber
    '#7B6FA8', // muted violet
    '#A8857B', // dusty rose
    '#6A8D7B', // sage green
    '#A8A07B', // sand
    '#8D6A6A', // mauve
];

// FOLDERS: Array of { name: string, color?: string }
let FOLDERS = [];
let ASSIGNMENTS = {};
let ACTIVE_FILTER = 'All';
let SELECT_MODE = false;
let SELECTED_IDS = new Set();

// --- Helpers ---

function folderNames() {
    return FOLDERS.map(f => f.name);
}

function getFolderColor(name) {
    const f = FOLDERS.find(f => f.name === name);
    return f ? (f.color || null) : null;
}

// Normalise raw stored data: migrate string[] → {name}[] if needed
function normaliseFolders(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(item => (typeof item === 'string' ? { name: item } : item));
}

async function init() {
    await loadFolders();

    document.arrive(
        '.all-projects-container',
        { existing: true, onceOnly: false }, (element) => {
            createFilterUI(element);
        }
    );

    // Inject folder column header into table
    document.arrive(
        'table.mdc-data-table__table thead tr',
        { existing: true, onceOnly: false }, (headerRow) => {
            injectFolderColumnHeader(headerRow);
        }
    );

    // Inject assign buttons on each notebook element
    document.arrive(
        'project-button, tr.mat-mdc-row',
        { existing: true, onceOnly: false }, (element) => {
            injectAssignButton(element);
        }
    );
}

/**
 * Loads folders and assignments from storage.
 * Migrates old keyword-based categories on first run.
 * Migrates string[] folder format to {name, color?}[] if needed.
 */
async function loadFolders() {
    const oldResult = await chrome.storage.local.get(OLD_CATEGORIES_KEY);
    if (oldResult[OLD_CATEGORIES_KEY] && Object.keys(oldResult[OLD_CATEGORIES_KEY]).length > 0) {
        const oldCategories = oldResult[OLD_CATEGORIES_KEY];
        const migratedFolders = Object.keys(oldCategories)
            .filter(name => name !== 'All' && name !== 'Other')
            .map(name => ({ name }));
        // Preserve any existing assignment data rather than always writing {}
        const existingResult = await chrome.storage.local.get(ASSIGNMENTS_KEY);
        const existingAssignments = existingResult[ASSIGNMENTS_KEY] || {};
        await chrome.storage.local.set({
            [FOLDERS_KEY]: migratedFolders,
            [ASSIGNMENTS_KEY]: existingAssignments
        });
        await chrome.storage.local.remove(OLD_CATEGORIES_KEY);
        FOLDERS = migratedFolders;
        ASSIGNMENTS = existingAssignments;
        if (Object.keys(existingAssignments).length === 0) {
            console.info(
                '[NotebookLM Folder Manager] v2→v3 migration: folder names preserved. ' +
                'Notebook assignments could not be auto-migrated from the keyword-based format — ' +
                'please reassign notebooks to folders.'
            );
        }
        console.log('[NotebookLM Folder Manager] Migrated old categories to folders:', FOLDERS);
        return;
    }

    const result = await chrome.storage.local.get([FOLDERS_KEY, ASSIGNMENTS_KEY, ACTIVE_FILTER_KEY]);
    const rawFolders = result[FOLDERS_KEY] || [];
    FOLDERS = normaliseFolders(rawFolders);
    // Persist normalised format if migration happened (string[] → object[])
    if (rawFolders.length > 0 && typeof rawFolders[0] === 'string') {
        await chrome.storage.local.set({ [FOLDERS_KEY]: FOLDERS });
    }
    ASSIGNMENTS = result[ASSIGNMENTS_KEY] || {};
    const storedFilter = result[ACTIVE_FILTER_KEY] || 'All';
    ACTIVE_FILTER = (storedFilter === 'All' || storedFilter === 'Uncategorized' || folderNames().includes(storedFilter))
        ? storedFilter
        : 'All';
}

/**
 * Extracts a stable notebook ID from the element's link href.
 * Tries child links first, then ancestor links.
 * Falls back to title + position-among-same-titles to avoid collisions.
 */
function getNotebookId(el) {
    // Try link within the element
    const link = el.querySelector('a[href*="/notebook/"]');
    if (link) {
        const match = link.getAttribute('href').match(/\/notebook\/([^/?#]+)/);
        if (match) return match[1];
    }
    // Try ancestor link
    const ancestorLink = el.closest('a[href*="/notebook/"]');
    if (ancestorLink) {
        const match = ancestorLink.getAttribute('href').match(/\/notebook\/([^/?#]+)/);
        if (match) return match[1];
    }
    // Fallback: title + index-among-same-titles to avoid collisions for duplicate names
    const titleEl = el.querySelector('.project-button-title, .project-table-title');
    if (titleEl) {
        const title = titleEl.textContent.trim();
        const allEls = Array.from(document.querySelectorAll('project-button, tr.mat-mdc-row'));
        const sameTitle = allEls.filter(e => {
            const t = e.querySelector('.project-button-title, .project-table-title');
            return t && t.textContent.trim() === title;
        });
        const idx = sameTitle.indexOf(el);
        const id = 'title:' + title + (idx > 0 ? ':' + idx : '');
        console.warn('[NotebookLM Folder Manager] Using fallback ID (no notebook link found):', id);
        return id;
    }
    return null;
}

/**
 * Returns the folder a notebook is assigned to, or "Uncategorized".
 * Treats assignments pointing to deleted folders as "Uncategorized".
 */
function getNotebookFolder(el) {
    const id = getNotebookId(el);
    if (id && ASSIGNMENTS[id] && FOLDERS.some(f => f.name === ASSIGNMENTS[id])) {
        return ASSIGNMENTS[id];
    }
    return 'Uncategorized';
}

/**
 * Count notebooks for each folder and update button text.
 */
function updateButtonCounts() {
    const projectButtons = document.querySelectorAll('project-button, tr.mat-mdc-row');
    const names = folderNames();
    const allFolderNames = ['All', ...names, 'Uncategorized'];
    const counts = {};
    allFolderNames.forEach(f => { counts[f] = 0; });
    counts['All'] = projectButtons.length;

    projectButtons.forEach(proj => {
        const folder = getNotebookFolder(proj);
        if (counts[folder] !== undefined) {
            counts[folder]++;
        } else {
            counts['Uncategorized']++;
        }
    });

    document.querySelectorAll('.category-filter-button').forEach(btn => {
        const name = btn.getAttribute('data-category');
        if (name && counts[name] !== undefined) {
            const dot = btn.querySelector('.folder-color-dot');
            const dotHtml = dot ? dot.outerHTML : '';
            btn.innerHTML = dotHtml + `${name} (${counts[name]})`;
        }
    });
}

/**
 * Filters notebooks based on the selected folder.
 */
async function filterProjects(selectedCategory) {
    ACTIVE_FILTER = selectedCategory;
    const projectButtons = document.querySelectorAll('project-button, tr.mat-mdc-row');

    projectButtons.forEach(proj => {
        const folder = getNotebookFolder(proj);
        if (selectedCategory === 'All' || folder === selectedCategory) {
            proj.setAttribute('data-filtered', 'visible');
        } else {
            proj.setAttribute('data-filtered', 'hidden');
        }
    });

    document.querySelectorAll('.category-filter-button').forEach(btn => {
        if (btn.getAttribute('data-category') === selectedCategory) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    await chrome.storage.local.set({ [ACTIVE_FILTER_KEY]: selectedCategory });
}

/**
 * Creates and injects the filter button UI.
 */
async function createFilterUI(targetContainer) {
    const oldContainer = document.querySelector('.category-filter-container');
    if (oldContainer) oldContainer.remove();

    const filterContainer = document.createElement('div');
    filterContainer.className = 'category-filter-container';

    // "All" button
    const allBtn = document.createElement('button');
    allBtn.className = 'category-filter-button';
    allBtn.setAttribute('data-category', 'All');
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => filterProjects('All'));
    filterContainer.appendChild(allBtn);

    // Per-folder buttons with optional color dot
    FOLDERS.forEach(folder => {
        const button = document.createElement('button');
        button.className = 'category-filter-button';
        button.setAttribute('data-category', folder.name);
        if (folder.color) {
            button.style.setProperty('--folder-color', folder.color);
            button.classList.add('has-color');
            const dot = document.createElement('span');
            dot.className = 'folder-color-dot';
            button.appendChild(dot);
            button.appendChild(document.createTextNode(folder.name));
        } else {
            button.textContent = folder.name;
        }
        button.addEventListener('click', () => filterProjects(folder.name));
        filterContainer.appendChild(button);
    });

    // "Uncategorized" button
    const uncatBtn = document.createElement('button');
    uncatBtn.className = 'category-filter-button';
    uncatBtn.setAttribute('data-category', 'Uncategorized');
    uncatBtn.textContent = 'Uncategorized';
    uncatBtn.addEventListener('click', () => filterProjects('Uncategorized'));
    filterContainer.appendChild(uncatBtn);

    const actionsWrapper = document.createElement('div');
    actionsWrapper.className = 'filter-bar-actions';
    actionsWrapper.appendChild(createAddFolderButton());
    actionsWrapper.appendChild(createManagerButton());
    actionsWrapper.appendChild(createSelectModeButton());
    filterContainer.appendChild(actionsWrapper);

    const featuredProjectsContainer = targetContainer.querySelector('.featured-projects-container');
    if (featuredProjectsContainer) {
        targetContainer.insertBefore(filterContainer, featuredProjectsContainer);
    } else {
        targetContainer.insertBefore(filterContainer, targetContainer.firstChild);
    }

    updateButtonCounts();
    // ACTIVE_FILTER was pre-loaded in loadFolders() — no async storage read needed here
    filterProjects(ACTIVE_FILTER);
}

function createAddFolderButton() {
    const button = document.createElement('button');
    button.id = 'quick-add-folder-btn';
    button.title = 'Add New Folder';
    button.innerHTML = `<svg viewBox="0 0 16 16"><line x1="8" y1="4" x2="8" y2="12"/><line x1="4" y1="8" x2="12" y2="8"/></svg> Add`;
    button.addEventListener('click', () => {
        openFolderManager();
        // Auto-add a new empty entry and focus it
        setTimeout(() => {
            const listContainer = document.querySelector('#category-list-container');
            if (listContainer) {
                const newEntry = createFolderEntry({ name: '', color: undefined });
                listContainer.appendChild(newEntry);
                newEntry.querySelector('.folder-name-input').focus();
            }
        }, 50);
    });
    return button;
}

function createManagerButton() {
    const button = document.createElement('button');
    button.id = 'open-category-manager-btn';
    button.title = 'Manage Folders';
    button.innerHTML = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M10 2.5V5M10 15v2.5M2.5 10H5M15 10h2.5M4.7 4.7l1.8 1.8M13.5 13.5l1.8 1.8M15.3 4.7l-1.8 1.8M6.5 13.5l-1.8 1.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
    button.addEventListener('click', openFolderManager);
    return button;
}

function createSelectModeButton() {
    const button = document.createElement('button');
    button.id = 'select-mode-btn';
    button.title = 'Select notebooks';
    button.textContent = 'Select';
    button.addEventListener('click', () => {
        if (SELECT_MODE) {
            exitSelectMode();
        } else {
            enterSelectMode();
        }
    });
    return button;
}

// --- Bulk Select Mode ---

function enterSelectMode() {
    SELECT_MODE = true;
    SELECTED_IDS.clear();
    const filterContainer = document.querySelector('.category-filter-container');
    if (filterContainer) filterContainer.classList.add('select-mode-active');
    renderBulkToolbar();
    document.querySelectorAll('project-button, tr.mat-mdc-row').forEach(el => {
        injectSelectCheckbox(el);
    });
    document.querySelectorAll('table.mdc-data-table__table thead tr').forEach(hr => {
        injectSelectAllHeader(hr);
    });
}

function exitSelectMode() {
    SELECT_MODE = false;
    SELECTED_IDS.clear();
    const filterContainer = document.querySelector('.category-filter-container');
    if (filterContainer) filterContainer.classList.remove('select-mode-active');
    const toolbar = document.getElementById('bulk-action-toolbar');
    if (toolbar) toolbar.remove();
    document.querySelectorAll('.select-checkbox-cell, .select-checkbox-card, .select-all-header').forEach(el => el.remove());
    document.querySelectorAll('[data-select-checked]').forEach(el => el.removeAttribute('data-select-checked'));
}

function renderBulkToolbar() {
    const existing = document.getElementById('bulk-action-toolbar');
    if (existing) existing.remove();

    const toolbar = document.createElement('div');
    toolbar.id = 'bulk-action-toolbar';
    toolbar.innerHTML = `
        <span id="bulk-selected-count">${SELECTED_IDS.size} selected</span>
        <button id="bulk-move-btn">Move to ▾</button>
        <button id="bulk-cancel-btn">Cancel</button>
    `;

    const filterContainer = document.querySelector('.category-filter-container');
    if (filterContainer) {
        filterContainer.parentNode.insertBefore(toolbar, filterContainer.nextSibling);
    }

    toolbar.querySelector('#bulk-move-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showBulkFolderPicker(e.target);
    });
    toolbar.querySelector('#bulk-cancel-btn').addEventListener('click', exitSelectMode);
}

function updateBulkToolbar() {
    const countEl = document.getElementById('bulk-selected-count');
    if (countEl) countEl.textContent = `${SELECTED_IDS.size} selected`;
}

function showBulkFolderPicker(triggerEl) {
    const existing = document.querySelector('.bulk-folder-menu');
    if (existing) { existing.remove(); return; }

    const menu = document.createElement('div');
    menu.className = 'bulk-folder-menu folder-assign-menu';

    [...FOLDERS, { name: 'Uncategorized', color: undefined }].forEach(f => {
        const name = f.name;
        const color = f.color || null;
        const option = document.createElement('div');
        option.className = 'folder-assign-option';
        if (color) {
            const dot = document.createElement('span');
            dot.className = 'folder-color-dot';
            dot.style.background = color;
            option.appendChild(dot);
        }
        option.appendChild(document.createTextNode(name));
        option.addEventListener('click', async () => {
            menu.remove();
            await applyBulkAssignment(name);
        });
        menu.appendChild(option);
    });

    document.body.appendChild(menu);
    const rect = triggerEl.getBoundingClientRect();
    menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    menu.style.left = (rect.left + window.scrollX) + 'px';

    const close = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', close, true);
        }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
}

async function applyBulkAssignment(folderName) {
    SELECTED_IDS.forEach(id => {
        if (folderName === 'Uncategorized') {
            delete ASSIGNMENTS[id];
        } else {
            ASSIGNMENTS[id] = folderName;
        }
    });
    try {
        await persistAssignments();
    } catch (err) {
        console.error('[NotebookLM Folder Manager] Failed to persist bulk assignment:', err);
    }
    exitSelectMode();
    refreshView();
}

function injectSelectCheckbox(el) {
    const id = getNotebookId(el);

    if (el.tagName === 'TR') {
        if (el.querySelector('.select-checkbox-cell')) return;
        const td = document.createElement('td');
        td.className = 'select-checkbox-cell mat-mdc-cell';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'select-cb';
        if (id) {
            cb.checked = SELECTED_IDS.has(id);
            cb.addEventListener('change', () => {
                if (cb.checked) { SELECTED_IDS.add(id); } else { SELECTED_IDS.delete(id); }
                updateSelectAllHeader();
                updateBulkToolbar();
            });
        } else {
            cb.disabled = true;
        }
        td.appendChild(cb);
        el.insertBefore(td, el.firstChild);
    } else {
        if (el.querySelector('.select-checkbox-card')) return;
        const wrapper = document.createElement('label');
        wrapper.className = 'select-checkbox-card';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'select-cb';
        if (id) {
            cb.checked = SELECTED_IDS.has(id);
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                if (cb.checked) { SELECTED_IDS.add(id); } else { SELECTED_IDS.delete(id); }
                updateBulkToolbar();
            });
        } else {
            cb.disabled = true;
        }
        wrapper.appendChild(cb);
        el.style.position = 'relative';
        el.insertBefore(wrapper, el.firstChild);
    }
}

function injectSelectAllHeader(headerRow) {
    if (headerRow.querySelector('.select-all-header')) return;
    const th = document.createElement('th');
    th.className = 'select-all-header mat-mdc-header-cell';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'select-all-cb';
    cb.title = 'Select all visible';
    cb.addEventListener('change', () => {
        const visible = Array.from(document.querySelectorAll('tr.mat-mdc-row[data-filtered="visible"]'));
        visible.forEach(row => {
            const id = getNotebookId(row);
            if (!id) return;
            const rowCb = row.querySelector('.select-cb');
            if (rowCb) rowCb.checked = cb.checked;
            if (cb.checked) { SELECTED_IDS.add(id); } else { SELECTED_IDS.delete(id); }
        });
        updateBulkToolbar();
    });
    th.appendChild(cb);
    headerRow.insertBefore(th, headerRow.firstChild);
}

function updateSelectAllHeader() {
    const cb = document.getElementById('select-all-cb');
    if (!cb) return;
    const visible = Array.from(document.querySelectorAll('tr.mat-mdc-row[data-filtered="visible"]'));
    const allChecked = visible.length > 0 && visible.every(row => {
        const id = getNotebookId(row);
        return id && SELECTED_IDS.has(id);
    });
    cb.checked = allChecked;
    cb.indeterminate = !allChecked && SELECTED_IDS.size > 0;
}

// --- Folder Manager Modal ---

function openFolderManager() {
    if (document.getElementById('category-manager-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'category-manager-overlay';
    overlay.id = 'category-manager-overlay';

    const modal = document.createElement('div');
    modal.className = 'category-manager-modal';

    modal.innerHTML = `
        <h2>Manage Folders</h2>
        <div id="category-list-container"></div>
        <div id="import-error-msg" class="import-error-msg" style="display:none"></div>
        <div class="modal-actions">
            <button id="add-new-category-btn">Add New Folder</button>
            <div class="modal-actions-right">
                <button id="import-folders-btn" title="Import folder configuration">↑ Import</button>
                <button id="export-folders-btn" title="Export folder configuration">↓ Export</button>
                <input type="file" id="import-file-input" accept=".json" style="display:none">
                <button id="cancel-categories-btn">Cancel</button>
                <button id="save-categories-btn">Save and Close</button>
            </div>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const listContainer = modal.querySelector('#category-list-container');

    FOLDERS.forEach(folder => {
        listContainer.appendChild(createFolderEntry(folder));
    });

    modal.querySelector('#add-new-category-btn').addEventListener('click', () => {
        const newEntry = createFolderEntry({ name: '', color: undefined });
        listContainer.appendChild(newEntry);
        newEntry.querySelector('.folder-name-input').focus();
    });

    modal.querySelector('#save-categories-btn').addEventListener('click', saveAndCloseFolderManager);
    modal.querySelector('#cancel-categories-btn').addEventListener('click', closeFolderManager);
    modal.querySelector('#export-folders-btn').addEventListener('click', exportFolders);
    modal.querySelector('#import-folders-btn').addEventListener('click', () => {
        modal.querySelector('#import-file-input').click();
    });
    modal.querySelector('#import-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) importFolders(file, modal);
        e.target.value = ''; // reset so same file can be re-selected
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeFolderManager();
    });
}

// --- Export / Import ---

function exportFolders() {
    const date = new Date().toISOString().slice(0, 10);
    const data = {
        version: 1,
        folders: FOLDERS,
        assignments: ASSIGNMENTS
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notebooklm-folders-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function importFolders(file, modal) {
    const errorEl = modal.querySelector('#import-error-msg');
    errorEl.style.display = 'none';
    errorEl.textContent = '';

    const reader = new FileReader();
    reader.onload = (e) => {
        let data;
        try {
            data = JSON.parse(e.target.result);
        } catch {
            showImportError(errorEl, 'Invalid JSON file. Please select a valid export file.');
            return;
        }

        // Validate schema
        if (!data || typeof data !== 'object' || !Array.isArray(data.folders) || typeof data.assignments !== 'object') {
            showImportError(errorEl, 'Invalid format. Expected { version, folders, assignments }.');
            return;
        }

        const importedFolders = normaliseFolders(data.folders);
        const importedAssignments = data.assignments || {};

        // Ask Merge or Replace
        const choice = window.confirm(
            'How would you like to import?\n\n' +
            'OK = Merge (add new folders, keep existing assignments)\n' +
            'Cancel = Replace (overwrite all folders and assignments)'
        );

        if (choice) {
            // Merge: add new folders not already present; add new assignments
            const existingNames = new Set(folderNames());
            importedFolders.forEach(f => {
                if (!existingNames.has(f.name)) FOLDERS.push(f);
            });
            Object.assign(ASSIGNMENTS, importedAssignments);
        } else {
            // Replace: full overwrite
            FOLDERS = importedFolders;
            ASSIGNMENTS = importedAssignments;
        }

        // Re-render folder list in modal
        const listContainer = modal.querySelector('#category-list-container');
        listContainer.innerHTML = '';
        FOLDERS.forEach(folder => listContainer.appendChild(createFolderEntry(folder)));
    };
    reader.onerror = () => showImportError(errorEl, 'Failed to read file.');
    reader.readAsText(file);
}

function showImportError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
}

/**
 * Creates a folder entry row in the manager modal.
 * @param {{ name: string, color?: string }} folder
 */
function createFolderEntry(folder) {
    const entry = document.createElement('div');
    entry.className = 'folder-entry';

    // Color swatch picker
    const colorPickerHtml = FOLDER_COLORS.map(c =>
        `<button type="button" class="color-swatch${folder.color === c ? ' selected' : ''}"
            data-color="${c}" style="background:${c}" title="${c}"></button>`
    ).join('') +
    `<button type="button" class="color-swatch color-swatch-none${!folder.color ? ' selected' : ''}"
        data-color="" title="No color">✕</button>`;

    entry.innerHTML = `
        <div class="folder-entry-main">
            <label>
                Folder Name
                <input name="folder-name-input" type="text" class="folder-name-input" placeholder="e.g., Work">
            </label>
            <div class="color-picker-row">${colorPickerHtml}</div>
        </div>
        <button class="delete-folder-btn" title="Delete Folder">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <line x1="4.5" y1="4.5" x2="11.5" y2="11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="11.5" y1="4.5" x2="4.5" y2="11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
        </button>
    `;
    entry.querySelector('.folder-name-input').value = folder.name;
    entry.querySelector('.delete-folder-btn').addEventListener('click', () => {
        entry.remove();
    });

    // Color swatch selection
    entry.querySelectorAll('.color-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
            entry.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });

    return entry;
}

function closeFolderManager() {
    const overlay = document.getElementById('category-manager-overlay');
    if (overlay) overlay.remove();
}

async function saveAndCloseFolderManager() {
    const entries = document.querySelectorAll('.folder-entry');
    const seen = new Set();
    const newFolders = [];

    entries.forEach(entry => {
        const name = entry.querySelector('.folder-name-input').value.trim();
        if (name && name !== 'All' && name !== 'Uncategorized' && !seen.has(name)) {
            seen.add(name);
            const selectedSwatch = entry.querySelector('.color-swatch.selected');
            const color = selectedSwatch ? selectedSwatch.getAttribute('data-color') || undefined : undefined;
            newFolders.push({ name, color: color || undefined });
        }
    });

    // Remove assignments pointing to deleted folders
    const folderNameSet = new Set(newFolders.map(f => f.name));
    const newAssignments = {};
    for (const [id, folder] of Object.entries(ASSIGNMENTS)) {
        if (folderNameSet.has(folder)) {
            newAssignments[id] = folder;
        }
    }

    FOLDERS = newFolders;
    ASSIGNMENTS = newAssignments;

    await chrome.storage.local.set({
        [FOLDERS_KEY]: FOLDERS,
        [ASSIGNMENTS_KEY]: ASSIGNMENTS
    });

    const projectContainer = document.querySelector('.all-projects-container');
    if (projectContainer) {
        await createFilterUI(projectContainer);
    }

    closeFolderManager();
    injectAssignButtons();
}

// --- Folder Column & Assignment UI ---

/**
 * Injects a "Folder" header cell into the table header row.
 */
function injectFolderColumnHeader(headerRow) {
    if (headerRow.querySelector('.folder-col-header')) return;

    const th = document.createElement('th');
    th.className = 'folder-col-header mat-mdc-header-cell';
    th.textContent = 'Folder';
    th.setAttribute('role', 'columnheader');

    // Insert after first header cell (Title)
    const firstTh = headerRow.querySelector('th');
    if (firstTh && firstTh.nextSibling) {
        headerRow.insertBefore(th, firstTh.nextSibling);
    } else {
        headerRow.appendChild(th);
    }
}

function injectAssignButtons() {
    // Re-inject column header if table re-rendered
    document.querySelectorAll('table.mdc-data-table__table thead tr').forEach(hr => {
        injectFolderColumnHeader(hr);
        if (SELECT_MODE) injectSelectAllHeader(hr);
    });
    document.querySelectorAll('project-button, tr.mat-mdc-row').forEach(el => {
        injectAssignButton(el);
        if (SELECT_MODE) injectSelectCheckbox(el);
    });
}

function applyFolderColorToBtn(btn, folderName) {
    const color = getFolderColor(folderName);
    let dot = btn.querySelector('.folder-color-dot');
    if (color) {
        if (!dot) {
            dot = document.createElement('span');
            dot.className = 'folder-color-dot';
            btn.insertBefore(dot, btn.firstChild);
        }
        dot.style.background = color;
    } else if (dot) {
        dot.remove();
    }
}

function injectAssignButton(el) {
    const folder = getNotebookFolder(el);
    const isAssigned = folder !== 'Uncategorized';
    // Apply filter immediately to avoid flash of unfiltered content
    if (ACTIVE_FILTER === 'All' || folder === ACTIVE_FILTER) {
        el.setAttribute('data-filtered', 'visible');
    } else {
        el.setAttribute('data-filtered', 'hidden');
    }

    if (el.tagName === 'TR') {
        // Table row: inject a dedicated <td> cell
        const existingCell = el.querySelector('.folder-col-cell');
        if (existingCell) {
            // Update existing cell
            const btn = existingCell.querySelector('.folder-assign-btn');
            if (btn) {
                // Preserve color dot, update text
                let dot = btn.querySelector('.folder-color-dot');
                const dotHtml = dot ? dot.outerHTML : '';
                btn.innerHTML = dotHtml + folder;
                applyFolderColorToBtn(btn, folder);
                btn.classList.toggle('assigned', isAssigned);
            }
            return;
        }

        const td = document.createElement('td');
        td.className = 'folder-col-cell mat-mdc-cell';

        const btn = document.createElement('button');
        btn.className = 'folder-assign-btn';
        if (isAssigned) btn.classList.add('assigned');
        btn.title = 'Assign to folder';
        btn.textContent = folder;
        applyFolderColorToBtn(btn, folder);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            showFolderAssignMenu(el, e);
        });

        td.appendChild(btn);

        // Insert after first cell (Title column)
        const firstTd = el.querySelector('td');
        if (firstTd && firstTd.nextSibling) {
            el.insertBefore(td, firstTd.nextSibling);
        } else {
            el.appendChild(td);
        }
    } else {
        // Card view: overlay tag on the card
        const existing = el.querySelector('.folder-assign-btn');
        if (existing) {
            let dot = existing.querySelector('.folder-color-dot');
            const dotHtml = dot ? dot.outerHTML : '';
            existing.innerHTML = dotHtml + folder;
            applyFolderColorToBtn(existing, folder);
            existing.classList.toggle('assigned', isAssigned);
            return;
        }

        const btn = document.createElement('button');
        btn.className = 'folder-assign-btn';
        if (isAssigned) btn.classList.add('assigned');
        btn.title = 'Assign to folder';
        btn.textContent = folder;
        applyFolderColorToBtn(btn, folder);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            showFolderAssignMenu(el, e);
        });

        el.style.position = 'relative';
        el.appendChild(btn);
    }
}

function showFolderAssignMenu(el, event) {
    const existing = document.querySelector('.folder-assign-menu');
    if (existing) existing.remove();

    const triggerBtn = event.target.closest('.folder-assign-btn');
    triggerBtn.classList.add('active');

    const menu = document.createElement('div');
    menu.className = 'folder-assign-menu';

    const currentFolder = getNotebookFolder(el);
    const options = [...FOLDERS, { name: 'Uncategorized', color: undefined }];

    options.forEach(f => {
        const folderName = typeof f === 'string' ? f : f.name;
        const folderColor = typeof f === 'string' ? null : (f.color || null);
        const option = document.createElement('div');
        option.className = 'folder-assign-option';
        if (folderColor) {
            const dot = document.createElement('span');
            dot.className = 'folder-color-dot';
            dot.style.background = folderColor;
            option.appendChild(dot);
        }
        option.appendChild(document.createTextNode(folderName));
        if (folderName === currentFolder) option.classList.add('selected');
        option.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = getNotebookId(el);
            if (!id) return;

            if (folderName === 'Uncategorized') {
                delete ASSIGNMENTS[id];
            } else {
                ASSIGNMENTS[id] = folderName;
            }
            try {
                await persistAssignments();
            } catch (err) {
                console.error('[NotebookLM Folder Manager] Failed to persist assignment:', err);
            }
            menu.remove();
            triggerBtn.classList.remove('active');
            refreshView();
        });
        menu.appendChild(option);
    });

    document.body.appendChild(menu);

    const btnRect = triggerBtn.getBoundingClientRect();
    menu.style.top = (btnRect.bottom + window.scrollY + 4) + 'px';
    menu.style.left = (btnRect.left + window.scrollX) + 'px';

    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            triggerBtn.classList.remove('active');
            document.removeEventListener('click', closeMenu, true);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
}

async function persistAssignments() {
    await chrome.storage.local.set({ [ASSIGNMENTS_KEY]: ASSIGNMENTS });
}

function refreshView() {
    updateButtonCounts();
    const activeBtn = document.querySelector('.category-filter-button.active');
    const activeFilter = activeBtn ? activeBtn.getAttribute('data-category') : 'All';
    filterProjects(activeFilter);
    injectAssignButtons();
}

init();
