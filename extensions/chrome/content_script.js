'use strict';

const FOLDERS_KEY = 'notebooklm_folders';
const ASSIGNMENTS_KEY = 'notebooklm_assignments';
const ACTIVE_FILTER_KEY = 'notebooklm_active_filter';
const OLD_CATEGORIES_KEY = 'notebooklm_user_categories';
let FOLDERS = [];
let ASSIGNMENTS = {};

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
 */
async function loadFolders() {
    const oldResult = await chrome.storage.local.get(OLD_CATEGORIES_KEY);
    if (oldResult[OLD_CATEGORIES_KEY] && Object.keys(oldResult[OLD_CATEGORIES_KEY]).length > 0) {
        const oldCategories = oldResult[OLD_CATEGORIES_KEY];
        const migratedFolders = Object.keys(oldCategories).filter(
            name => name !== 'All' && name !== 'Other'
        );
        await chrome.storage.local.set({
            [FOLDERS_KEY]: migratedFolders,
            [ASSIGNMENTS_KEY]: {}
        });
        await chrome.storage.local.remove(OLD_CATEGORIES_KEY);
        FOLDERS = migratedFolders;
        ASSIGNMENTS = {};
        console.log('Migrated old categories to folders:', FOLDERS);
        return;
    }

    const result = await chrome.storage.local.get([FOLDERS_KEY, ASSIGNMENTS_KEY]);
    FOLDERS = result[FOLDERS_KEY] || [];
    ASSIGNMENTS = result[ASSIGNMENTS_KEY] || {};
}

/**
 * Extracts a stable notebook ID from the element's link href.
 * Falls back to title-based ID if no link found.
 */
function getNotebookId(el) {
    const link = el.querySelector('a[href*="/notebook/"]');
    if (link) {
        const match = link.getAttribute('href').match(/\/notebook\/([^/?#]+)/);
        if (match) return match[1];
    }
    const titleEl = el.querySelector('.project-button-title, .project-table-title');
    if (titleEl) return 'title:' + titleEl.textContent.trim();
    return null;
}

/**
 * Returns the folder a notebook is assigned to, or "Uncategorized".
 */
function getNotebookFolder(el) {
    const id = getNotebookId(el);
    if (id && ASSIGNMENTS[id]) return ASSIGNMENTS[id];
    return 'Uncategorized';
}

/**
 * Count notebooks for each folder and update button text.
 */
function updateButtonCounts() {
    const projectButtons = document.querySelectorAll('project-button, tr.mat-mdc-row');
    const allFolders = ['All', ...FOLDERS, 'Uncategorized'];
    const counts = {};
    allFolders.forEach(f => { counts[f] = 0; });
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
            btn.textContent = `${name} (${counts[name]})`;
        }
    });
}

/**
 * Filters notebooks based on the selected folder.
 */
async function filterProjects(selectedCategory) {
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

    const allFolders = ['All', ...FOLDERS, 'Uncategorized'];
    allFolders.forEach(name => {
        const button = document.createElement('button');
        button.className = 'category-filter-button';
        button.setAttribute('data-category', name);
        button.textContent = name;
        button.addEventListener('click', () => filterProjects(name));
        filterContainer.appendChild(button);
    });

    const actionsWrapper = document.createElement('div');
    actionsWrapper.className = 'filter-bar-actions';
    actionsWrapper.appendChild(createAddFolderButton());
    actionsWrapper.appendChild(createManagerButton());
    filterContainer.appendChild(actionsWrapper);

    const featuredProjectsContainer = targetContainer.querySelector('.featured-projects-container');
    if (featuredProjectsContainer) {
        targetContainer.insertBefore(filterContainer, featuredProjectsContainer);
    } else {
        targetContainer.insertBefore(filterContainer, targetContainer.firstChild);
    }

    updateButtonCounts();

    const result = await chrome.storage.local.get(ACTIVE_FILTER_KEY);
    let lastFilter = result[ACTIVE_FILTER_KEY] || 'All';
    if (lastFilter !== 'All' && lastFilter !== 'Uncategorized' && !FOLDERS.includes(lastFilter)) {
        lastFilter = 'All';
    }
    filterProjects(lastFilter);
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
                const newEntry = createFolderEntry('');
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
        <div class="modal-actions">
            <button id="add-new-category-btn">Add New Folder</button>
            <div>
                <button id="cancel-categories-btn">Cancel</button>
                <button id="save-categories-btn">Save and Close</button>
            </div>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const listContainer = modal.querySelector('#category-list-container');

    FOLDERS.forEach(name => {
        listContainer.appendChild(createFolderEntry(name));
    });

    modal.querySelector('#add-new-category-btn').addEventListener('click', () => {
        const newEntry = createFolderEntry('');
        listContainer.appendChild(newEntry);
        newEntry.querySelector('.folder-name-input').focus();
    });

    modal.querySelector('#save-categories-btn').addEventListener('click', saveAndCloseFolderManager);
    modal.querySelector('#cancel-categories-btn').addEventListener('click', closeFolderManager);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeFolderManager();
    });
}

function createFolderEntry(name) {
    const entry = document.createElement('div');
    entry.className = 'folder-entry';
    entry.innerHTML = `
        <div>
            <label>
                Folder Name
                <input name="folder-name-input" type="text" class="folder-name-input" placeholder="e.g., Work">
            </label>
        </div>
        <button class="delete-folder-btn" title="Delete Folder">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <line x1="4.5" y1="4.5" x2="11.5" y2="11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <line x1="11.5" y1="4.5" x2="4.5" y2="11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
        </button>
    `;
    entry.querySelector('.folder-name-input').value = name;
    entry.querySelector('.delete-folder-btn').addEventListener('click', () => {
        entry.remove();
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
            newFolders.push(name);
        }
    });

    // Remove assignments pointing to deleted folders
    const folderSet = new Set(newFolders);
    const newAssignments = {};
    for (const [id, folder] of Object.entries(ASSIGNMENTS)) {
        if (folderSet.has(folder)) {
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
    });
    document.querySelectorAll('project-button, tr.mat-mdc-row').forEach(el => {
        injectAssignButton(el);
    });
}

function injectAssignButton(el) {
    const folder = getNotebookFolder(el);
    const isAssigned = folder !== 'Uncategorized';

    if (el.tagName === 'TR') {
        // Table row: inject a dedicated <td> cell
        const existingCell = el.querySelector('.folder-col-cell');
        if (existingCell) {
            // Update existing cell
            const btn = existingCell.querySelector('.folder-assign-btn');
            if (btn) {
                btn.textContent = folder;
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
            existing.textContent = folder;
            existing.classList.toggle('assigned', isAssigned);
            return;
        }

        const btn = document.createElement('button');
        btn.className = 'folder-assign-btn';
        if (isAssigned) btn.classList.add('assigned');
        btn.title = 'Assign to folder';
        btn.textContent = folder;
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
    const options = [...FOLDERS, 'Uncategorized'];

    options.forEach(folderName => {
        const option = document.createElement('div');
        option.className = 'folder-assign-option';
        option.textContent = folderName;
        if (folderName === currentFolder) option.classList.add('selected');
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = getNotebookId(el);
            if (!id) return;

            if (folderName === 'Uncategorized') {
                delete ASSIGNMENTS[id];
            } else {
                ASSIGNMENTS[id] = folderName;
            }
            persistAssignments();
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
