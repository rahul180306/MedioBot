import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

interface BenchmarkRecord {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly status: string;
  readonly updated: string;
  readonly description: string;
}

function makeRecords(): BenchmarkRecord[] {
  return [
    { name: "Cedar", owner: "Research", status: "active", updated: "Today, 9:42 AM", description: "Quarterly research review and supporting notes." },
    { name: "Nimbus", owner: "Cody", status: "queued", updated: "Yesterday, 4:18 PM", description: "Release preparation for the workspace update." },
    { name: "Juniper", owner: "Maestro", status: "active", updated: "Yesterday, 11:06 AM", description: "Partner onboarding and account coordination." },
    { name: "Maple", owner: "Vision", status: "active", updated: "Monday, 2:31 PM", description: "Design review materials for the next planning cycle." },
  ].map((record) => ({ ...record, id: randomBytes(6).toString("hex") }))
    .sort(() => Math.random() - 0.5);
}

export function buildBenchmarkHtml(records: ReadonlyArray<BenchmarkRecord> = makeRecords()): string {
  const serialized = JSON.stringify(records).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light"><title>Records · Atlas Workspace</title>
  <style>
    :root { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #18232d; background: #f3f6f7; font-synthesis: none; text-rendering: optimizeLegibility; --ink: #18232d; --muted: #64727e; --line: #dce3e7; --accent: #147a72; --accent-dark: #0d625b; --surface: #fff; --soft: #f7f9fa; --radius: 12px; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; min-height: 100vh; }
    button, input, select { font: inherit; }
    a { color: inherit; }
    button, a, input, select { -webkit-tap-highlight-color: transparent; }
    :focus-visible { outline: 3px solid #65b9b0; outline-offset: 3px; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 224px minmax(0, 1fr); grid-template-rows: 66px 1fr; }
    .topbar { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding: 0 30px; background: #fff; border-bottom: 1px solid var(--line); }
    .brand { display: flex; align-items: center; gap: 11px; color: var(--ink); font-weight: 690; letter-spacing: -.025em; }
    .brand-mark { width: 29px; height: 29px; display: grid; place-items: center; border-radius: 9px; background: #e3f1ef; color: var(--accent-dark); font-size: 15px; font-weight: 750; }
    .workspace-label { color: var(--muted); font-size: 13px; }
    .account { display: flex; align-items: center; gap: 10px; color: #3e4b56; font-size: 13px; }
    .avatar { width: 31px; height: 31px; display: grid; place-items: center; border-radius: 50%; background: #e9eef0; color: #43525d; font-size: 12px; font-weight: 700; }
    .sidebar { padding: 26px 14px; background: #f8fafb; border-right: 1px solid var(--line); }
    .side-label { padding: 0 11px; margin: 2px 0 11px; color: #82909a; font-size: 10px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
    .nav { display: grid; gap: 4px; }
    .nav a { display: flex; align-items: center; min-height: 39px; padding: 0 11px; border-radius: 8px; text-decoration: none; color: #586671; font-size: 13px; font-weight: 540; transition: background-color 150ms ease, color 150ms ease; }
    .nav a:hover { background: #edf2f3; color: var(--ink); }
    .nav a[aria-current="page"] { background: #e5f1ef; color: var(--accent-dark); font-weight: 650; }
    .sidebar-note { margin: 30px 10px 0; padding-top: 16px; border-top: 1px solid var(--line); color: #7a8790; font-size: 11px; line-height: 1.55; }
    main { width: min(1180px, 100%); margin: 0 auto; padding: 43px clamp(22px, 4vw, 58px) 70px; }
    .eyebrow { margin: 0 0 9px; color: var(--muted); font-size: 11px; font-weight: 650; letter-spacing: .1em; text-transform: uppercase; }
    h1 { margin: 0; color: var(--ink); font-size: clamp(26px, 3vw, 34px); letter-spacing: -.045em; line-height: 1.15; }
    h2 { margin: 0; font-size: 20px; letter-spacing: -.025em; }
    .lede { margin: 9px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .page-heading { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-bottom: 26px; }
    .record-count { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: #5d6a74; font-size: 12px; white-space: nowrap; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 15px; }
    .search-wrap { position: relative; flex: 1; max-width: 410px; }
    .search-wrap label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
    .search-wrap input { width: 100%; height: 42px; padding: 0 13px 0 38px; border: 1px solid #d7e0e4; border-radius: 9px; background: #fff; color: var(--ink); font-size: 13px; }
    .search-wrap::before { content: "⌕"; position: absolute; top: 6px; left: 13px; color: #78858e; font-size: 22px; pointer-events: none; }
    .filters { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 12px; }
    .filters select { height: 40px; padding: 0 31px 0 11px; border: 1px solid #d7e0e4; border-radius: 9px; background: #fff; color: #34434e; }
    .surface { overflow: hidden; border: 1px solid #dce3e7; border-radius: var(--radius); background: var(--surface); box-shadow: 0 3px 14px rgb(37 57 69 / .035); }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; min-width: 700px; border-collapse: collapse; text-align: left; }
    caption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
    thead { background: #f8fafb; }
    th { height: 43px; padding: 0 17px; border-bottom: 1px solid var(--line); color: #78858e; font-size: 10px; font-weight: 700; letter-spacing: .075em; text-transform: uppercase; }
    td { height: 66px; padding: 10px 17px; border-bottom: 1px solid #edf1f3; color: #53616b; font-size: 13px; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: #fbfcfc; }
    .record-name { color: var(--ink); font-size: 13px; font-weight: 650; text-decoration: none; }
    .record-name:hover { color: var(--accent-dark); text-decoration: underline; text-underline-offset: 3px; }
    .status { display: inline-flex; align-items: center; min-height: 24px; padding: 0 9px; border-radius: 999px; background: #e9f4ef; color: #28734f; font-size: 11px; font-weight: 650; text-transform: capitalize; }
    .status.queued { background: #f2f0e8; color: #816b27; }
    .status.archived { background: #eef0f2; color: #64717b; }
    .actions { display: flex; align-items: center; gap: 13px; white-space: nowrap; }
    .text-action { padding: 4px 0; border: 0; background: transparent; color: var(--accent-dark); cursor: pointer; font-size: 12px; font-weight: 620; text-decoration: none; }
    .text-action:hover { color: #084f4a; text-decoration: underline; text-underline-offset: 3px; }
    .button { min-height: 38px; padding: 0 14px; border: 1px solid #cfd9de; border-radius: 8px; background: #fff; color: #35444e; cursor: pointer; font-size: 12px; font-weight: 630; transition: transform 130ms cubic-bezier(.2,.7,.25,1), background-color 150ms ease, border-color 150ms ease; }
    .button:hover { background: #f7f9fa; border-color: #aebdc4; }
    .button:active { transform: translateY(1px); }
    .button.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
    .button.primary:hover { border-color: var(--accent-dark); background: var(--accent-dark); }
    .button.danger { border-color: #a53e3e; background: #a53e3e; color: #fff; }
    .table-footer { padding: 13px 17px; border-top: 1px solid var(--line); color: #74818a; font-size: 11px; }
    .empty { padding: 48px 20px; color: var(--muted); text-align: center; font-size: 13px; }
    .breadcrumbs { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; color: var(--muted); font-size: 12px; }
    .breadcrumbs a { color: var(--accent-dark); text-decoration: none; }
    .detail-top { display: flex; align-items: start; justify-content: space-between; gap: 18px; margin-bottom: 25px; }
    .detail-actions { display: flex; gap: 9px; }
    .detail-card { padding: clamp(20px, 3vw, 32px); }
    .detail-title { display: flex; align-items: center; gap: 13px; }
    .detail-title .status { margin-left: 2px; }
    .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 23px 34px; max-width: 760px; margin-top: 30px; }
    .field-label { margin-bottom: 7px; color: #79868f; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .field-value { color: #263640; font-size: 14px; line-height: 1.5; }
    .description { grid-column: 1 / -1; padding-top: 18px; border-top: 1px solid #edf1f3; }
    .edit-form { display: grid; gap: 16px; max-width: 580px; margin-top: 24px; }
    .form-field { display: grid; gap: 7px; color: #52616b; font-size: 12px; font-weight: 620; }
    .form-field input, .form-field select { width: 100%; height: 41px; padding: 0 11px; border: 1px solid #d3dde1; border-radius: 8px; background: #fff; color: #263640; }
    .form-actions { display: flex; justify-content: end; gap: 9px; padding-top: 7px; }
    .notice { min-height: 20px; margin: 13px 0 0; color: var(--accent-dark); font-size: 12px; }
    dialog { width: min(430px, calc(100vw - 32px)); padding: 0; border: 1px solid #d8e0e4; border-radius: 13px; background: #fff; color: var(--ink); box-shadow: 0 22px 70px rgb(22 38 48 / .2); }
    dialog::backdrop { background: rgb(25 39 48 / .34); }
    .dialog-body { padding: 25px; }
    .dialog-body h2 { font-size: 19px; }
    .dialog-body p { margin: 12px 0 22px; color: #5f6c75; font-size: 13px; line-height: 1.55; }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; grid-template-rows: 58px auto 1fr; }
      .topbar { grid-column: 1; padding: 0 17px; }
      .workspace-label { display: none; }
      .sidebar { padding: 9px 13px; border-right: 0; border-bottom: 1px solid var(--line); }
      .side-label, .sidebar-note { display: none; }
      .nav { display: flex; gap: 4px; overflow-x: auto; }
      .nav a { flex: 0 0 auto; min-height: 36px; }
      main { padding: 29px 16px 48px; }
      .page-heading { align-items: start; }
      .toolbar { align-items: stretch; flex-direction: column; }
      .search-wrap { max-width: none; }
      .filters { justify-content: space-between; }
      .detail-top { flex-direction: column; }
    }
    @media (max-width: 460px) {
      .account-name { display: none; }
      .record-count { font-size: 10px; }
      .detail-grid { grid-template-columns: 1fr; gap: 17px; }
      .description { grid-column: 1; }
      .detail-title { align-items: start; flex-direction: column; }
      .detail-actions { width: 100%; }
      .detail-actions .button { flex: 1; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true">A</span><span>Atlas Workspace</span></div>
      <span class="workspace-label">Operations workspace</span>
      <div class="account"><span class="account-name">Workspace admin</span><span class="avatar" aria-hidden="true">WA</span></div>
    </header>
    <aside class="sidebar">
      <p class="side-label">Workspace</p>
      <nav class="nav" aria-label="Primary navigation">
        <a href="#records" aria-current="page">Records</a>
        <a href="#activity" id="activity-link">Activity</a>
      </nav>
      <p class="sidebar-note">Workspace records and ownership details.</p>
    </aside>
    <main id="main-content" tabindex="-1"></main>
  </div>
  <dialog id="archive-dialog" aria-labelledby="archive-title" aria-describedby="archive-description">
    <form method="dialog" class="dialog-body">
      <h2 id="archive-title">Archive record?</h2>
      <p id="archive-description"></p>
      <div class="form-actions"><button class="button" value="cancel">Cancel</button><button class="button danger" id="confirm-archive" value="archive">Archive</button></div>
    </form>
  </dialog>
  <script>
    const records = ${serialized};
    const archiveConfirmations = [];
    const main = document.querySelector('#main-content');
    const dialog = document.querySelector('#archive-dialog');
    const noticeText = document.createElement('p');
    noticeText.className = 'notice'; noticeText.setAttribute('role', 'status');
    let selectedRecord = null;
    let pendingArchive = null;
    let searchValue = '';
    let statusFilter = 'all';

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function statusBadge(value) { return element('span', 'status ' + value, value[0].toUpperCase() + value.slice(1)); }
    function setNotice(text) { noticeText.textContent = text; }
    function filteredRecords() {
      return records.filter((record) => record.name.toLowerCase().includes(searchValue.toLowerCase())
        && (statusFilter === 'all' || record.status === statusFilter));
    }
    function actionButton(label, callback, className = 'text-action') {
      const button = element('button', className, label); button.type = 'button'; button.addEventListener('click', callback); return button;
    }
    function renderList() {
      selectedRecord = null;
      const eyebrow = element('p', 'eyebrow', 'Workspace / Records');
      const title = element('h1', '', 'Records');
      const description = element('p', 'lede', 'Manage and review workspace records.');
      const headingCopy = element('div'); headingCopy.append(eyebrow, title, description);
      const count = element('span', 'record-count', records.length.toString().padStart(2, '0') + ' records');
      const pageHeading = element('section', 'page-heading'); pageHeading.append(headingCopy, count);

      const searchLabel = element('label', '', 'Search records'); searchLabel.htmlFor = 'record-search';
      const searchInput = element('input'); searchInput.id = 'record-search'; searchInput.type = 'search'; searchInput.setAttribute('role', 'searchbox');
      searchInput.placeholder = 'Search records'; searchInput.value = searchValue;
      searchInput.addEventListener('input', () => { searchValue = searchInput.value; renderRows(); });
      const searchWrap = element('div', 'search-wrap'); searchWrap.append(searchLabel, searchInput);
      const filterLabel = element('label', 'filters', 'Status'); filterLabel.htmlFor = 'status-filter';
      const filter = element('select'); filter.id = 'status-filter'; filter.setAttribute('aria-label', 'Filter by status');
      for (const optionValue of ['all', 'active', 'queued', 'ready', 'archived']) {
        const option = element('option', '', optionValue === 'all' ? 'All statuses' : optionValue[0].toUpperCase() + optionValue.slice(1));
        option.value = optionValue; filter.append(option);
      }
      filter.value = statusFilter; filter.addEventListener('change', () => { statusFilter = filter.value; renderRows(); }); filterLabel.append(filter);
      const toolbar = element('div', 'toolbar'); toolbar.append(searchWrap, filterLabel);

      const table = document.createElement('table'); table.id = 'records-table'; table.setAttribute('aria-label', 'Workspace records');
      const caption = element('caption', '', 'Workspace records'); table.append(caption);
      const head = document.createElement('thead'); const headerRow = document.createElement('tr');
      for (const label of ['Name', 'Status', 'Last updated', 'Actions']) {
        const th = element('th', '', label); th.scope = 'col'; headerRow.append(th);
      }
      head.append(headerRow); table.append(head);
      const body = document.createElement('tbody'); body.id = 'records-body'; table.append(body);
      const scroll = element('div', 'table-scroll'); scroll.append(table);
      const footer = element('div', 'table-footer', 'Showing records in this workspace');
      const surface = element('section', 'surface'); surface.append(scroll, footer);
      main.replaceChildren(pageHeading, toolbar, surface, noticeText);
      renderRows();
    }
    function renderRows() {
      const body = document.querySelector('#records-body'); if (!body) return;
      body.replaceChildren();
      const matching = filteredRecords();
      if (!matching.length) {
        const row = document.createElement('tr'); const cell = element('td', 'empty', 'No records match your search.'); cell.colSpan = 4; row.append(cell); body.append(row); return;
      }
      for (const record of matching) {
        const row = document.createElement('tr');
        const nameCell = document.createElement('td'); const name = element('a', 'record-name', record.name); name.href = '#record';
        name.addEventListener('click', (event) => { event.preventDefault(); renderDetail(record); }); nameCell.append(name);
        const statusCell = document.createElement('td'); statusCell.append(statusBadge(record.status));
        const updatedCell = element('td', '', record.updated);
        const actionsCell = document.createElement('td'); const actions = element('div', 'actions');
        const view = element('a', 'text-action', 'View record'); view.href = '#record';
        view.addEventListener('click', (event) => { event.preventDefault(); renderDetail(record); });
        actions.append(view, actionButton('Edit record', () => renderEdit(record)), actionButton('Archive record', () => askArchive(record)));
        actionsCell.append(actions); row.append(nameCell, statusCell, updatedCell, actionsCell); body.append(row);
      }
    }
    function renderDetail(record) {
      selectedRecord = record;
      const back = element('a', '', 'Back to records'); back.href = '#records'; back.addEventListener('click', (event) => { event.preventDefault(); renderList(); });
      const crumbs = element('nav', 'breadcrumbs'); crumbs.setAttribute('aria-label', 'Breadcrumb'); crumbs.append(back, element('span', '', '/'), element('span', '', record.name));
      const title = element('h1', '', record.name); const badge = statusBadge(record.status);
      const titleRow = element('div', 'detail-title'); titleRow.append(title, badge);
      const eyebrow = element('p', 'eyebrow', 'Record details');
      const copy = element('div'); copy.append(eyebrow, titleRow);
      const edit = actionButton('Edit record', () => renderEdit(record), 'button primary'); edit.type = 'button';
      const archive = actionButton('Archive record', () => askArchive(record), 'button'); archive.type = 'button';
      const actions = element('div', 'detail-actions'); actions.append(edit, archive);
      const detailTop = element('div', 'detail-top'); detailTop.append(copy, actions);
      const grid = element('div', 'detail-grid');
      for (const [label, value] of [['Owner', record.owner], ['Record ID', record.id], ['Last updated', record.updated]]) {
        const field = element('div'); field.append(element('div', 'field-label', label), element('div', 'field-value', value)); grid.append(field);
      }
      const description = element('div', 'description'); description.append(element('div', 'field-label', 'Description'), element('div', 'field-value', record.description)); grid.append(description);
      const card = element('section', 'surface detail-card'); card.append(detailTop, grid);
      main.replaceChildren(crumbs, card, noticeText); main.focus();
    }
    function renderEdit(record) {
      selectedRecord = record;
      const eyebrow = element('p', 'eyebrow', 'Record settings'); const title = element('h1', '', 'Edit record');
      const description = element('p', 'lede', 'Update the details for this workspace record.');
      const header = element('div'); header.append(eyebrow, title, description);
      const name = document.createElement('input'); name.value = record.name; name.readOnly = true; name.id = 'edit-name';
      const owner = document.createElement('input'); owner.value = record.owner; owner.readOnly = true; owner.id = 'edit-owner';
      const status = document.createElement('select'); status.id = 'edit-status';
      for (const value of ['queued', 'active', 'ready', 'archived']) { const option = element('option', '', value[0].toUpperCase() + value.slice(1)); option.value = value; status.append(option); }
      status.value = record.status;
      const form = element('form', 'edit-form');
      for (const [label, control, id] of [['Name', name, 'edit-name'], ['Owner', owner, 'edit-owner'], ['Status', status, 'edit-status']]) {
        const fieldLabel = element('label', 'form-field', label); fieldLabel.htmlFor = id; fieldLabel.append(control); form.append(fieldLabel);
      }
      const cancel = element('a', 'button', 'Cancel'); cancel.href = '#records'; cancel.addEventListener('click', (event) => { event.preventDefault(); renderList(); });
      const save = element('button', 'button primary', 'Save changes'); save.type = 'submit';
      const formActions = element('div', 'form-actions'); formActions.append(cancel, save); form.append(formActions);
      form.addEventListener('submit', (event) => {
        event.preventDefault(); save.disabled = true; save.textContent = 'Saving changes'; setNotice('Saving changes…');
        setTimeout(() => { record.status = status.value; record.updated = 'Just now'; setNotice(record.name + ' was updated'); renderList(); }, 300);
      });
      const card = element('section', 'surface detail-card'); card.append(header, form);
      main.replaceChildren(card, noticeText); main.focus();
    }
    function askArchive(record) {
      pendingArchive = record;
      document.querySelector('#archive-description').textContent = 'You are about to archive "' + record.name + '". This record will no longer appear as active.';
      dialog.showModal();
    }
    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'archive' || !pendingArchive) { pendingArchive = null; return; }
      const record = pendingArchive; pendingArchive = null;
      archiveConfirmations.push({ id: record.id, description: document.querySelector('#archive-description').textContent });
      const confirm = document.querySelector('#confirm-archive'); confirm.disabled = true;
      setNotice('Archiving record…');
      setTimeout(() => { record.status = 'archived'; record.updated = 'Just now'; confirm.disabled = false; setNotice(record.name + ' was archived');
        if (selectedRecord === record) renderDetail(record); else renderList(); }, 300);
    });
    document.querySelector('a[href="#records"]').addEventListener('click', (event) => {
      event.preventDefault(); renderList();
    });
    document.querySelector('#activity-link').addEventListener('click', (event) => {
      event.preventDefault();
      const heading = element('div'); heading.append(element('p', 'eyebrow', 'Workspace / Activity'), element('h1', '', 'Activity'), element('p', 'lede', 'Recent changes across workspace records.'));
      const surface = element('section', 'surface detail-card', 'No recent activity.'); main.replaceChildren(heading, surface);
    });
    renderList();
  </script>
</body>
</html>`;
}

export async function startBenchmarkServer(): Promise<{ readonly url: string; close(): Promise<void> }> {
  const html = buildBenchmarkHtml();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the local records application");
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())) };
}
