'use strict';

/*
 * Mina böcker – familjeversion.
 *
 * Data (samma struktur lokalt och i Supabase, se supabase/schema.sql):
 *   members: { id, name, color }                       – familjemedlemmar (profiler)
 *   books:   { id, title, authors, year, isbn, cover, pages, owned, spine, added_at }
 *   entries: { id: "<bok>:<person>", book_id, member_id,
 *              status: 'wishlist'|'reading'|'read', page, rating, notes, started_at, finished_at }
 *
 * Lokalt först: allt sparas direkt i localStorage och läggs i en kö (outbox) som
 * skickas till Supabase när man är inloggad och har nät. Appen fungerar alltså offline.
 */

const DB_KEY = 'mina-bocker:v2';
const OUTBOX_KEY = 'mina-bocker:outbox';
const ME_KEY = 'mina-bocker:me';
const WHO_KEY = 'mina-bocker:who';
const V1_KEY = 'mina-bocker:v1';
const TABLES = ['members', 'books', 'entries']; // i FK-ordning
const COLUMNS = {
  members: ['id', 'name', 'color', 'updated_at'],
  books: ['id', 'title', 'authors', 'year', 'isbn', 'cover', 'pages', 'owned', 'spine', 'added_at', 'updated_at'],
  entries: ['id', 'book_id', 'member_id', 'status', 'page', 'rating', 'notes', 'started_at', 'finished_at', 'updated_at'],
};
const COLORS = ['#7a4b2a', '#2f6f8f', '#a2456f', '#3f7d3a', '#c0702a', '#5a4fa0', '#4f8a8b', '#8f3b2f'];

const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);
const entryId = (bookId, memberId) => `${bookId}:${memberId}`;
const int = (v) => { const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : null; };

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('Kunde inte spara – är lagringen full?'); }
}

let db = loadJSON(DB_KEY, { members: {}, books: {}, entries: {} });
let outbox = loadJSON(OUTBOX_KEY, []);
let me = localStorage.getItem(ME_KEY) || null;
let who = localStorage.getItem(WHO_KEY) || me || 'all';
let currentTab = 'reading';

// ---------- Ändringar ----------
function put(table, row) {
  row.updated_at = new Date().toISOString();
  db[table][row.id] = row;
  enqueue(table, 'upsert', row.id);
}
function del(table, id) {
  delete db[table][id];
  enqueue(table, 'delete', id);
}
function enqueue(table, op, id) {
  outbox = outbox.filter((o) => !(o.table === table && o.id === id));
  outbox.push({ table, op, id });
}
function commit() {
  saveJSON(DB_KEY, db);
  saveJSON(OUTBOX_KEY, outbox);
  render();
  scheduleSync();
}

function deleteBook(bookId) {
  for (const e of Object.values(db.entries)) if (e.book_id === bookId) del('entries', e.id);
  del('books', bookId);
}
function deleteMember(memberId) {
  for (const e of Object.values(db.entries)) if (e.member_id === memberId) del('entries', e.id);
  del('members', memberId);
}

// ---------- Hjälpfunktioner ----------
const members = () => Object.values(db.members).sort((a, b) => a.name.localeCompare(b.name, 'sv'));
const entriesOf = (bookId) => Object.values(db.entries).filter((e) => e.book_id === bookId && db.members[e.member_id]);
const target = () => (who !== 'all' && db.members[who] ? who : me);
const nextColor = () => COLORS.find((c) => !members().some((m) => m.color === c)) || COLORS[members().length % COLORS.length];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function avatar(m, cls = 'avatar') {
  if (!m) return '';
  return `<span class="${cls}" style="background:${esc(m.color || '#888')}" aria-hidden="true">${esc((m.name || '?')[0].toUpperCase())}</span>`;
}
function coverHtml(b, cls = 'cover') {
  const src = coverSrc(b);
  if (!src) return placeholderHtml(b, cls);
  return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer"
    data-t="${esc(b.title)}" data-a="${esc(b.authors)}" onerror="coverFail(this)" onload="coverLoad(this)">`;
}
// Saknas omslag: ett genererat "bokomslag" med titel och författare.
function placeholderHtml(b, cls = 'cover') {
  return `<div class="${cls} ph" style="--ph:${hashColor(b.title || '')}" aria-hidden="true">
    <span class="ph-t">${esc(b.title || '?')}</span><span class="ph-a">${esc((b.authors || '').split(',')[0])}</span></div>`;
}
window.coverFail = (img) => { img.outerHTML = placeholderHtml({ title: img.dataset.t, authors: img.dataset.a }, img.className); };
window.coverLoad = (img) => { if (img.naturalWidth < 5) window.coverFail(img); };
function shortDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T12:00:00');
  if (isNaN(dt)) return d;
  const opts = { day: 'numeric', month: 'short' };
  if (dt.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return dt.toLocaleDateString('sv-SE', opts);
}
const starStr = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const pct = (e, b) => (b.pages && e.page ? Math.min(100, Math.round((e.page / b.pages) * 100)) : null);

// ---------- Flikar ----------
function entriesFor(status) {
  return Object.values(db.entries).filter((e) =>
    e.status === status && db.books[e.book_id] && db.members[e.member_id] && (who === 'all' || e.member_id === who));
}
function booksForTab(tab) {
  if (tab === 'shelf') return Object.values(db.books).filter((b) => b.owned);
  const status = tab === 'wishlist' ? 'wishlist' : tab;
  const ids = new Set(entriesFor(status).map((e) => e.book_id));
  let list = [...ids].map((id) => db.books[id]);
  if (tab === 'wishlist') list = list.filter((b) => !b.owned);
  return list;
}
function latest(bookId, field) {
  return entriesOf(bookId).reduce((max, e) => ((e[field] || '') > max ? e[field] : max), '');
}

// ---------- Rendering ----------
function render() {
  document.querySelectorAll('.tabs button').forEach((btn) => {
    const t = btn.dataset.tab;
    btn.setAttribute('aria-selected', String(t === currentTab));
    btn.querySelector('.count').textContent = booksForTab(t).length || '';
  });

  renderPeople();
  renderHeader();
  if ($('#bookDialog').open) { if (db.books[viewBookId]) openBook(viewBookId); else $('#bookDialog').close(); }
  const vt = $('#viewToggle');
  vt.hidden = currentTab !== 'shelf';
  vt.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === shelfView)));

  const q = $('#filter').value.trim().toLowerCase();
  let list = booksForTab(currentTab);
  if (q) list = list.filter((b) => `${b.title} ${b.authors}`.toLowerCase().includes(q));
  list.sort((a, b) => {
    if (currentTab === 'read') return latest(b.id, 'finished_at').localeCompare(latest(a.id, 'finished_at'));
    if (currentTab === 'reading') return latest(b.id, 'started_at').localeCompare(latest(a.id, 'started_at'));
    return (a.authors || '').localeCompare(b.authors || '', 'sv') || a.title.localeCompare(b.title, 'sv');
  });

  const el = $('#list');
  if (!list.length) {
    const name = who !== 'all' && db.members[who] ? db.members[who].name : null;
    const empty = {
      reading: name ? `${name} läser ingen bok just nu.` : 'Ingen läser något just nu.',
      shelf: 'Bokhyllan är tom.',
      wishlist: name ? `${name} har inget på önskelistan.` : 'Önskelistan är tom.',
      read: name ? `${name} har inga lästa böcker ännu.` : 'Inga lästa böcker ännu.',
    }[currentTab];
    el.innerHTML = `<div class="empty"><div class="big">📚</div><p>${q ? 'Inga träffar.' : esc(empty)}</p>
      ${q ? '' : '<p>Tryck på <b>＋</b> för att lägga till en bok.</p>'}</div>`;
    return;
  }
  if (currentTab === 'shelf' && shelfView === 'spines') {
    el.innerHTML = `<div class="bookcase">${list.map((b) => `<div class="slot">${spine(b)}</div>`).join('')}</div>`;
    extractSpineColors(list);
    return;
  }
  el.innerHTML = list.map(card).join('');
}

function card(b) {
  const es = entriesOf(b.id);
  const byStatus = (s) => es.filter((e) => e.status === s);
  let body = '';
  const quick = [];
  const t = target();
  const mine = db.entries[entryId(b.id, t)];

  if (currentTab === 'reading') {
    // Visa alla i familjen som läser (eller har läst) boken – så ser man vem som kommit längst.
    body = whoRows([...byStatus('reading'), ...byStatus('read')], b);
  } else if (currentTab === 'read') {
    body = whoRows(byStatus('read'), b);
  }
  if (currentTab === 'reading' || currentTab === 'read') {
    if (b.owned) body += '<div class="tags"><span class="tag">📚 I hyllan</span></div>';
    else quick.push(['own', '📚 Till hyllan']);
  } else if (currentTab === 'wishlist') {
    body = names('Önskas av', byStatus('wishlist'));
    quick.push(['buy', '✓ Köpt']);
    if (mine?.status !== 'reading') quick.push(['start', '▶ Börja läsa']);
  } else if (currentTab === 'shelf') {
    body = names('Läser', byStatus('reading')) + names('Läst av', byStatus('read'));
    if (mine?.status !== 'reading' && t) quick.push(['start', '▶ Börja läsa']);
  }

  return `<div class="card" data-id="${esc(b.id)}" role="button" tabindex="0">
    ${coverHtml(b)}
    <div class="info">
      <span class="title">${esc(b.title)}</span>
      <span class="author">${esc(b.authors)}${b.year ? ' · ' + esc(b.year) : ''}</span>
      ${body}
      ${quick.length ? `<div class="quick">${quick.map(([a, l]) => `<button data-action="${a}">${l}</button>`).join('')}</div>` : ''}
    </div>
  </div>`;
}

function names(label, es) {
  if (!es.length) return '';
  return `<div class="tags"><span class="tag">${label}: ${es.map((e) => esc(db.members[e.member_id].name)).join(', ')}</span></div>`;
}

function whoRows(es, b) {
  if (!es.length) return '';
  const rank = { reading: 0, read: 1, wishlist: 2 };
  es.sort((x, y) => (x.status === y.status ? (pct(y, b) ?? y.page ?? 0) - (pct(x, b) ?? x.page ?? 0) : rank[x.status] - rank[y.status]));
  return `<div class="who-row">${es.map((e) => {
    const m = db.members[e.member_id];
    const label = `${avatar(m, 'avatar sm')}<span class="name">${esc(m.name)}</span>`;
    if (e.status === 'reading') {
      const p = pct(e, b);
      const pg = e.page ? `s. ${e.page}${b.pages ? ` / ${b.pages}` : ''}${p != null ? ` · ${p}%` : ''}` : 'Ange sida';
      return `<button type="button" class="who-line" data-progress="${esc(e.id)}" aria-label="Uppdatera hur långt ${esc(m.name)} kommit">
        ${label}<span class="bar"><i style="width:${p ?? 0}%;background:${esc(m.color)}"></i></span><span class="pg">${pg}</span></button>`;
    }
    if (e.status === 'wishlist') return `<div class="who-line">${label}<span class="grow">Önskar sig boken</span></div>`;
    return `<div class="who-line">${label}<span class="grow">${e.rating ? `<span class="rating">${starStr(e.rating)}</span>` : '✓ Läst'}</span><span class="pg">${esc(shortDate(e.finished_at))}</span></div>`;
  }).join('')}</div>`;
}

function renderPeople() {
  const el = $('#people');
  const ms = members();
  el.hidden = currentTab === 'shelf' || ms.length < 2;
  if (el.hidden) return;
  el.innerHTML = `<button class="chip all" data-who="all" aria-pressed="${who === 'all'}">Alla</button>` +
    ms.map((m) => `<button class="chip" data-who="${esc(m.id)}" aria-pressed="${who === m.id}">${avatar(m)}${esc(m.name)}</button>`).join('');
}

function renderHeader() {
  const m = db.members[me];
  const btn = $('#meBtn');
  btn.textContent = m ? m.name[0].toUpperCase() : '?';
  btn.style.background = m?.color || '';
  btn.title = m ? `Inloggad på enheten som ${m.name} – tryck för att byta` : 'Välj vem du är';
}

// ---------- Snabbåtgärder ----------
function quickAction(bookId, action) {
  const b = db.books[bookId];
  if (!b) return;
  if (action === 'own') {
    put('books', { ...b, owned: true });
    toast(`”${b.title}” ställd i bokhyllan 📚`);
  }
  if (action === 'buy') {
    put('books', { ...b, owned: true });
    for (const e of entriesOf(bookId)) if (e.status === 'wishlist') del('entries', e.id);
    toast(`”${b.title}” flyttad till bokhyllan`);
  }
  if (action === 'start') {
    const t = target();
    const prev = db.entries[entryId(bookId, t)];
    put('entries', { ...blankEntry(bookId, t), ...prev, status: 'reading', page: null, started_at: today(), finished_at: null });
    toast(`${db.members[t].name} läser nu ”${b.title}”`);
  }
  commit();
}
function blankEntry(bookId, memberId) {
  return { id: entryId(bookId, memberId), book_id: bookId, member_id: memberId, status: 'reading',
    page: null, rating: 0, notes: '', started_at: null, finished_at: null };
}

// ---------- Hur långt har man kommit ----------
let progressId = null;

function openProgress(id) {
  const e = db.entries[id];
  if (!e) return;
  const b = db.books[e.book_id];
  const m = db.members[e.member_id];
  progressId = id;
  const f = $('#progressForm').elements;
  $('#progressTitle').textContent = e.member_id === me ? 'Hur långt har du kommit?' : `Hur långt har ${m.name} kommit?`;
  $('#progressBook').textContent = `${b.title}${b.authors ? ' – ' + b.authors : ''}`;
  f.page.value = e.page ?? '';
  f.pages.value = b.pages ?? '';
  syncSlider();
  const others = entriesOf(b.id).filter((o) => o.id !== id && o.status !== 'wishlist');
  $('#othersProgress').textContent = others.map((o) =>
    `${db.members[o.member_id].name}: ${o.status === 'read' ? 'utläst' : o.page ? 's. ' + o.page : 'har börjat'}`).join(' · ');
  $('#progressDialog').showModal();
  f.page.focus();
  f.page.select();
}
function syncSlider() {
  const f = $('#progressForm').elements;
  const pages = int(f.pages.value);
  f.slider.hidden = !pages;
  if (pages) { f.slider.max = pages; f.slider.value = int(f.page.value) ?? 0; }
}
function saveProgress(finish = false) {
  const e = db.entries[progressId];
  if (!e) return;
  const f = $('#progressForm').elements;
  const b = db.books[e.book_id];
  const pages = int(f.pages.value);
  if (pages !== (b.pages ?? null)) put('books', { ...b, pages });
  let page = int(f.page.value);
  if (finish) {
    put('entries', { ...e, status: 'read', page: pages || page, finished_at: today() });
    toast(`Grattis! ”${b.title}” är utläst 🎉`);
  } else {
    put('entries', { ...e, page });
  }
  commit();
}

// ---------- Redigera bok ----------
let editBookId = null;
let editMember = null;
let drafts = {};
let editRating = 0;

function openEdit(bookId, memberId = target(), prefill = {}) {
  const b = db.books[bookId];
  editBookId = b ? bookId : null;
  const f = $('#editForm').elements;
  const d = b || { title: '', authors: '', year: '', isbn: '', pages: null, cover: '', owned: currentTab === 'shelf', ...prefill };
  $('#editTitle').textContent = b ? 'Bok' : 'Ny bok';
  f.title.value = d.title || '';
  f.authors.value = d.authors || '';
  f.year.value = d.year || '';
  f.isbn.value = d.isbn || '';
  f.pages.value = d.pages ?? '';
  f.owned.checked = !!d.owned;
  editCover = d.cover || '';
  $('#coverPicker').hidden = true;
  renderEditCover();
  loadSpineEdit(b);
  $('#deleteBtn').hidden = !b;

  drafts = {};
  for (const m of members()) {
    const e = b && db.entries[entryId(b.id, m.id)];
    drafts[m.id] = e
      ? { status: e.status, page: e.page, rating: e.rating || 0, notes: e.notes || '' }
      : { status: '', page: null, rating: 0, notes: '' };
  }
  if (!b && memberId && drafts[memberId]) {
    drafts[memberId].status = { reading: 'reading', wishlist: 'wishlist', read: 'read' }[currentTab] || '';
  }
  editMember = memberId && drafts[memberId] ? memberId : members()[0]?.id;
  loadDraft();
  $('#editDialog').showModal();
}

function storeDraft() {
  if (!editMember) return;
  const f = $('#editForm').elements;
  drafts[editMember] = { status: f.status.value, page: int(f.page.value), rating: editRating, notes: f.notes.value.trim() };
}
function loadDraft() {
  const f = $('#editForm').elements;
  const d = drafts[editMember] || { status: '', page: null, rating: 0, notes: '' };
  f.status.value = d.status;
  f.page.value = d.page ?? '';
  f.notes.value = d.notes;
  editRating = d.rating;
  renderStars();
  renderMemberTabs();
  updatePageRow();
}
function renderMemberTabs() {
  const ms = members();
  $('#memberTabs').hidden = ms.length < 2;
  $('#memberTabs').innerHTML = ms.map((m) =>
    `<button type="button" class="chip${drafts[m.id]?.status ? ' has' : ''}" data-member="${esc(m.id)}" aria-pressed="${m.id === editMember}">${avatar(m)}${esc(m.name)}</button>`).join('');
  const m = db.members[editMember];
  $('#statusLegend').textContent = m ? (m.id === me ? 'Min läsning' : `${m.name}s läsning`) : 'Läsning';
}
function updatePageRow() {
  $('#pageRow').hidden = $('#editForm').elements.status.value !== 'reading';
}
function renderStars() {
  $('#stars').innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" data-n="${n}" class="${n <= editRating ? 'on' : ''}" aria-label="${n} stjärnor">★</button>`).join('');
}

function saveEdit() {
  storeDraft();
  const f = $('#editForm').elements;
  const title = f.title.value.trim();
  if (!title) return;
  const prev = db.books[editBookId];
  const book = {
    ...(prev || { id: uid(), cover: '', added_at: today() }),
    title,
    authors: f.authors.value.trim(),
    year: f.year.value.trim(),
    isbn: f.isbn.value.trim(),
    pages: int(f.pages.value),
    owned: f.owned.checked,
    cover: editCover,
    spine: cleanSpine(editSpine),
  };
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  if (!prev || COLUMNS.books.some((c) => c !== 'updated_at' && !same(book[c], prev[c]))) put('books', book);

  for (const [memberId, d] of Object.entries(drafts)) {
    const id = entryId(book.id, memberId);
    const old = db.entries[id];
    if (!d.status) { if (old) del('entries', id); continue; }
    const e = {
      ...(old || blankEntry(book.id, memberId)),
      status: d.status,
      page: d.status === 'reading' ? d.page : old?.page ?? null,
      rating: d.rating,
      notes: d.notes,
    };
    if (d.status === 'reading' && old?.status !== 'reading') e.started_at = today();
    if (d.status === 'read' && old?.status !== 'read') e.finished_at = today();
    if (!old || COLUMNS.entries.some((c) => c !== 'updated_at' && e[c] !== old[c])) put('entries', e);
  }
  commit();
}

// ---------- Sök / lägg till ----------
let searchTimer = null;
let searchSeq = 0;
let lastResults = [];

function normIsbn(s) {
  const d = String(s).replace(/[^0-9Xx]/g, '').toUpperCase();
  return d.length === 10 || d.length === 13 ? d : null;
}

async function searchGoogle(q) {
  const isbn = normIsbn(q);
  const query = isbn ? `isbn:${isbn}` : q;
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=15&printType=books`);
  if (!res.ok) throw new Error('google ' + res.status);
  const data = await res.json();
  return (data.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '';
    return {
      title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title || '',
      authors: (v.authors || []).join(', '),
      year: (v.publishedDate || '').slice(0, 4),
      isbn: ids.find((i) => i.type === 'ISBN_13')?.identifier || ids.find((i) => i.type === 'ISBN_10')?.identifier || '',
      pages: v.pageCount || null,
      cover: googleImg(img),
    };
  });
}

async function searchOpenLibrary(q) {
  const isbn = normIsbn(q);
  const param = isbn ? `isbn=${isbn}` : `q=${encodeURIComponent(q)}`;
  const res = await fetch(`https://openlibrary.org/search.json?${param}&limit=15&fields=title,author_name,first_publish_year,isbn,cover_i,number_of_pages_median`);
  if (!res.ok) throw new Error('openlibrary ' + res.status);
  const data = await res.json();
  return (data.docs || []).map((d) => ({
    title: d.title || '',
    authors: (d.author_name || []).join(', '),
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    isbn: isbn || d.isbn?.find((i) => i.length === 13) || d.isbn?.[0] || '',
    pages: d.number_of_pages_median || null,
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
  }));
}

async function search(q) {
  const seq = ++searchSeq;
  const el = $('#results');
  if (q.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = '<p class="muted">Söker…</p>';
  let results = [];
  try { results = await searchGoogle(q); } catch { /* prova nästa källa */ }
  if (!results.length) { try { results = await searchOpenLibrary(q); } catch { /* ingen träff */ } }
  if (seq !== searchSeq) return;
  lastResults = results;
  if (!results.length) {
    el.innerHTML = '<p class="muted">Inga träffar. Du kan lägga till boken manuellt.</p>';
    return;
  }
  el.innerHTML = results.map((r, i) => `<div class="result">
      ${coverHtml(r)}
      <div class="info">
        <span class="title">${esc(r.title)}</span>
        <span class="author">${esc(r.authors)}${r.year ? ' · ' + esc(r.year) : ''}${r.pages ? ` · ${r.pages} s.` : ''}</span>
      </div>
      <div class="add">
        <button type="button" class="btn" data-i="${i}" data-to="reading">Läser</button>
        <button type="button" class="btn" data-i="${i}" data-to="shelf">Hyllan</button>
        <button type="button" class="btn" data-i="${i}" data-to="wishlist">Önskar</button>
      </div>
    </div>`).join('');
}

function findDuplicate(data) {
  const isbn = normIsbn(data.isbn || '');
  const key = `${(data.title || '').toLowerCase()}|${(data.authors || '').toLowerCase()}`;
  return Object.values(db.books).find((b) =>
    (isbn && normIsbn(b.isbn || '') === isbn) || `${b.title.toLowerCase()}|${(b.authors || '').toLowerCase()}` === key);
}

function addBook(data, to, memberId) {
  let book = findDuplicate(data);
  if (!book) {
    book = { id: uid(), title: data.title || 'Utan titel', authors: data.authors || '', year: data.year || '',
      isbn: data.isbn || '', cover: data.cover || '', pages: data.pages || null, owned: false, added_at: today() };
    put('books', book);
  } else if ((!book.pages && data.pages) || (!book.cover && data.cover)) {
    book = { ...book, pages: book.pages || data.pages || null, cover: book.cover || data.cover || '' };
    put('books', book);
  }
  const name = db.members[memberId]?.name;
  if (to === 'reading' && $('#addOwned').checked && !book.owned) {
    book = { ...book, owned: true };
    put('books', book);
  }
  if (to === 'shelf') {
    if (!book.owned) put('books', { ...book, owned: true });
    toast(`”${book.title}” ställd i bokhyllan`);
  } else {
    const old = db.entries[entryId(book.id, memberId)];
    const status = to === 'reading' ? 'reading' : 'wishlist';
    put('entries', { ...blankEntry(book.id, memberId), ...old, status,
      ...(status === 'reading' && old?.status !== 'reading' ? { started_at: today(), page: null } : {}) });
    toast(status === 'reading' ? `${name} läser nu ”${book.title}”` : `”${book.title}” på ${name}s önskelista`);
  }
  currentTab = to;
  if (who !== 'all') setWho(memberId);
  commit();
}

// ---------- Streckkodsskanning ----------
let scanStream = null;

async function startScan() {
  if (scanStream) { stopScan(); return; }
  const video = $('#scanVideo');
  try {
    const detector = new BarcodeDetector({ formats: ['ean_13'] });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = scanStream;
    video.hidden = false;
    await video.play();
    $('#scanBtn').textContent = '✕ Stoppa';
    const tick = async () => {
      if (!scanStream) return;
      try {
        const code = (await detector.detect(video)).find((c) => /^97[89]\d{10}$/.test(c.rawValue));
        if (code) { stopScan(); $('#q').value = code.rawValue; search(code.rawValue); return; }
      } catch { /* ignorera enstaka fel */ }
      requestAnimationFrame(tick);
    };
    tick();
  } catch {
    stopScan();
    toast('Kunde inte starta kameran');
  }
}
function stopScan() {
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  const video = $('#scanVideo');
  video.srcObject = null;
  video.hidden = true;
  $('#scanBtn').textContent = '📷 Skanna';
}

// ---------- Familjen / vem är jag ----------
function setMe(id) {
  me = id;
  localStorage.setItem(ME_KEY, id);
  setWho(id);
  migrateV1();
  render();
}
function setWho(id) {
  who = id;
  localStorage.setItem(WHO_KEY, id);
}
function addMember(name) {
  name = name.trim();
  if (!name) return null;
  const existing = members().find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const m = { id: uid(), name, color: nextColor() };
  put('members', m);
  commit();
  return m.id;
}

function openWho() {
  if ($('#newPassDialog').open) return; // visas när lösenordet är valt
  const ms = members();
  $('#whoList').innerHTML = (ms.length ? ms.map((m) =>
    `<button type="button" class="who-pick" data-pick="${esc(m.id)}">${avatar(m)}${esc(m.name)}${m.id === me ? ' <span class="muted">(vald)</span>' : ''}</button>`).join('')
    : '<p class="muted">Skriv ditt namn för att komma igång. Lägg sedan till resten av familjen under ⋯.</p>') +
    (sb && !session ? '<p class="muted">Har familjen redan ett konto?</p><button type="button" class="btn primary" id="loginFirst">Logga in först</button>' : '');
  $('#newMemberName').value = '';
  if (!$('#whoDialog').open) $('#whoDialog').showModal();
}

// Flytta data från första versionen (en person, inga profiler) till den inloggade profilen.
function migrateV1(list = loadJSON(V1_KEY, null), memberId = me) {
  if (!Array.isArray(list) || !list.length || !memberId) return 0;
  let n = 0;
  for (const old of list) {
    if (!old?.title) continue;
    const dup = findDuplicate(old);
    const book = dup || { id: old.id || uid(), title: old.title, authors: old.authors || '', year: old.year || '',
      isbn: old.isbn || '', cover: old.cover || '', pages: int(old.pages), owned: false, added_at: old.addedAt || today() };
    if (old.owned) book.owned = true;
    put('books', book);
    const status = old.reading === 'reading' ? 'reading' : old.reading === 'read' ? 'read' : old.wanted ? 'wishlist' : null;
    if (status) {
      put('entries', { ...blankEntry(book.id, memberId), status, rating: old.rating || 0, notes: old.notes || '',
        started_at: old.startedAt || null, finished_at: old.finishedAt || null });
    }
    n++;
  }
  if (localStorage.getItem(V1_KEY)) {
    localStorage.setItem(V1_KEY + '-backup', localStorage.getItem(V1_KEY));
    localStorage.removeItem(V1_KEY);
  }
  commit();
  return n;
}

// ---------- Synk (Supabase) ----------
const cfg = window.BOOKS_CONFIG || {};
// Läs av återställningslänken från mejlet innan Supabase-klienten tar bort den ur adressen.
const authHash = new URLSearchParams(location.hash.slice(1));
let recoveryPending = authHash.get('type') === 'recovery';
const authLinkError = authHash.get('error_description');
const sb = cfg.supabaseUrl && cfg.supabaseKey && window.supabase
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey)
  : null;
let session = null;
let syncState = 'local';
let syncError = '';
let syncing = false;
let syncAgain = false;
let syncTimer = null;
let channel = null;

function scheduleSync(delay = 300) {
  if (!sb || !session) { updateSyncUI(); return; }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

async function sync() {
  if (!sb || !session) { updateSyncUI(); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSyncState('syncing');
  try {
    await flush();
    await pull();
    setSyncState(outbox.length ? 'pending' : 'ok');
  } catch (err) {
    console.warn('Synk misslyckades', err);
    syncError = err?.message || String(err);
    setSyncState(navigator.onLine ? 'error' : 'offline');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

function toRow(table, row) {
  const out = { household_id: session.user.id };
  for (const c of COLUMNS[table]) out[c] = row[c] ?? null;
  return out;
}

async function flush() {
  if (!outbox.length) return;
  const snap = [...outbox];
  const drop = new Set();
  for (const t of TABLES) {
    const rows = snap.filter((o) => o.table === t && o.op === 'upsert' && db[t][o.id]).map((o) => toRow(t, db[t][o.id]));
    if (!rows.length) continue;
    const { error } = await sb.from(t).upsert(rows);
    if (!error) continue;
    if (error.code !== '23503') throw error;
    // Främmande nyckel saknas (t.ex. boken togs bort på en annan enhet) – ta raderna en och en och släpp de trasiga.
    for (const r of rows) {
      const res = await sb.from(t).upsert(r);
      if (res.error?.code === '23503') { drop.add(`${t}:${r.id}`); delete db[t][r.id]; } else if (res.error) throw res.error;
    }
  }
  for (const t of [...TABLES].reverse()) {
    const ids = snap.filter((o) => o.table === t && o.op === 'delete').map((o) => o.id);
    if (!ids.length) continue;
    const { error } = await sb.from(t).delete().in('id', ids);
    if (error) throw error;
  }
  outbox = outbox.filter((o) => !snap.includes(o) && !drop.has(`${o.table}:${o.id}`));
  saveJSON(OUTBOX_KEY, outbox);
}

async function pull() {
  const results = await Promise.all(TABLES.map((t) => sb.from(t).select('*').limit(10000)));
  const fresh = {};
  TABLES.forEach((t, i) => {
    if (results[i].error) throw results[i].error;
    fresh[t] = {};
    for (const { household_id, ...row } of results[i].data) fresh[t][row.id] = row;
  });
  // Ändringar som inte hunnit skickas ligger kvar ovanpå.
  for (const o of outbox) {
    if (o.op === 'upsert' && db[o.table][o.id]) fresh[o.table][o.id] = db[o.table][o.id];
    if (o.op === 'delete') delete fresh[o.table][o.id];
  }
  db = fresh;
  saveJSON(DB_KEY, db);
  render();
  setTimeout(autoCovers, 1000);
  if (me && !db.members[me] && members().length) openWho(); // min profil togs bort på en annan enhet
}

function subscribe() {
  if (!sb) return;
  if (channel) { sb.removeChannel(channel); channel = null; }
  if (!session) return;
  channel = sb.channel('hushall');
  for (const t of TABLES) channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => scheduleSync(500));
  channel.subscribe();
}

function setSyncState(s) {
  syncState = s;
  updateSyncUI();
}

function updateSyncUI() {
  const btn = $('#syncBtn');
  if (!sb) { btn.hidden = true; return; }
  btn.hidden = false;
  let state = syncState;
  if (!session) state = 'loggedout';
  else if (state === 'ok' && outbox.length) state = 'pending';
  const look = {
    loggedout: ['Logga in', 'login', 'Inte inloggad – data sparas bara på den här enheten'],
    syncing: ['◌', 'pending', 'Synkar…'],
    pending: ['●', 'pending', `${outbox.length} ändring(ar) väntar på att skickas`],
    ok: ['●', 'ok', 'Synkad'],
    offline: ['●', 'pending', 'Offline – ändringar skickas när du är online igen'],
    error: ['⚠', 'err', `Synkfel: ${syncError}`],
    local: ['○', '', 'Inte synkad'],
  }[state];
  btn.textContent = look[0];
  btn.className = `sync-dot ${look[1]}`;
  btn.title = look[2];
  if ($('#menuDialog').open) renderSyncPanel(look[2]);
}

function renderSyncPanel(statusText) {
  const el = $('#syncPanel');
  if (!sb) {
    el.innerHTML = `<p class="muted">Synk är inte påslagen. Följ instruktionen i README (Supabase, gratis) och fyll i <code>config.js</code>.
      Tills dess sparas allt bara i den här webbläsaren.</p>`;
    return;
  }
  if (!session) {
    el.innerHTML = `<div class="sync-form">
      <p class="muted">Använd <b>ett gemensamt konto för hela familjen</b> – alla loggar in med samma e-post och lösenord,
      och väljer sedan sin egen profil. Barnen behöver alltså ingen egen e-post.</p>
      <input id="email" type="email" placeholder="E-post" autocomplete="username">
      <input id="password" type="password" placeholder="Lösenord (minst 6 tecken)" autocomplete="current-password">
      <div class="actions">
        <button type="button" id="loginBtn" class="btn primary">Logga in</button>
        <button type="button" id="signupBtn" class="btn">Skapa familjekonto</button>
      </div>
      <button type="button" id="forgotBtn" class="link-btn">Glömt lösenord?</button>
    </div>`;
    return;
  }
  el.innerHTML = `<p class="muted">Inloggad som <b>${esc(session.user.email)}</b> · ${esc(statusText || '')}</p>
    <div class="actions">
      <button type="button" id="syncNowBtn" class="btn">⟳ Synka nu</button>
      <button type="button" id="passwordBtn" class="btn">Byt lösenord</button>
      <button type="button" id="logoutBtn" class="btn">Logga ut</button>
    </div>`;
}

async function login(signup) {
  const email = $('#email').value.trim();
  const password = $('#password').value;
  if (!email || password.length < 6) { toast('Fyll i e-post och ett lösenord på minst 6 tecken'); return; }
  const { data, error } = signup
    ? await sb.auth.signUp({ email, password })
    : await sb.auth.signInWithPassword({ email, password });
  if (error) { toast(error.message === 'Invalid login credentials' ? 'Fel e-post eller lösenord' : error.message); return; }
  if (signup && !data.session) { toast('Kolla mejlen och bekräfta kontot, logga sedan in här'); return; }
  toast('Inloggad – synkar…');
}

async function onSession(s) {
  const was = session?.user?.id;
  session = s;
  updateSyncUI();
  if (s && recoveryPending) { recoveryPending = false; openNewPassword(true); }
  if (s && s.user.id !== was) {
    subscribe();
    await sync();
    if (!me || !db.members[me]) openWho();
  } else if (!s) {
    subscribe();
  }
}

// ---------- Lösenord ----------
async function forgotPassword() {
  const email = $('#email').value.trim();
  if (!email) { toast('Skriv din e-post först'); $('#email').focus(); return; }
  const redirectTo = location.origin + location.pathname;
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) { toast(error.message); return; }
  toast('Kolla mejlen – öppna länken på den här enheten för att välja nytt lösenord');
}

function openNewPassword(fromLink) {
  $('#newPassIntro').textContent = fromLink
    ? 'Välj ett nytt lösenord för familjekontot.'
    : `Nytt lösenord för ${session?.user?.email || 'kontot'}. Alla i familjen behöver logga in med det nya på sina enheter.`;
  $('#newPass1').value = '';
  $('#newPass2').value = '';
  $('#newPassDialog').showModal();
  $('#newPass1').focus();
}

async function saveNewPassword() {
  const a = $('#newPass1').value, b = $('#newPass2').value;
  if (a.length < 6) { toast('Lösenordet måste vara minst 6 tecken'); return; }
  if (a !== b) { toast('Lösenorden är inte lika'); return; }
  const { error } = await sb.auth.updateUser({ password: a });
  if (error) { toast(error.message); return; }
  $('#newPassDialog').close();
  toast('Lösenordet är bytt ✓');
}

// ---------- Export / import ----------
function exportData() {
  const data = { app: 'mina-bocker', version: 2, exportedAt: new Date().toISOString(),
    members: Object.values(db.members), books: Object.values(db.books), entries: Object.values(db.entries) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `mina-bocker-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.version === 2) {
      let n = 0;
      for (const t of TABLES) for (const row of data[t] || []) if (row?.id) { put(t, row); n++; }
      commit();
      toast(`Import klar: ${n} poster`);
    } else {
      const n = migrateV1(Array.isArray(data) ? data : data.books, me);
      toast(`Import klar: ${n} böcker`);
    }
  } catch {
    toast('Filen kunde inte läsas');
  }
}

// ---------- Inställningar ----------
function openMenu() {
  updateSyncUI();
  renderSyncPanel($('#syncBtn').title);
  renderFamily();
  const year = String(new Date().getFullYear());
  const perPerson = members().map((m) => {
    const n = Object.values(db.entries).filter((e) => e.member_id === m.id && e.status === 'read' && (e.finished_at || '').startsWith(year)).length;
    return `${m.name} ${n}`;
  }).join(', ');
  $('#stats').textContent = `${Object.keys(db.books).length} böcker totalt.` + (perPerson ? ` Lästa i år: ${perPerson}.` : '');
  if (!$('#menuDialog').open) $('#menuDialog').showModal();
}

function renderFamily() {
  $('#familyList').innerHTML = members().map((m) => `<div class="family-row">
      ${avatar(m)}
      <input value="${esc(m.name)}" data-rename="${esc(m.id)}" aria-label="Namn">
      <button type="button" class="btn danger" data-remove="${esc(m.id)}" aria-label="Ta bort ${esc(m.name)}">✕</button>
    </div>`).join('') + `<div class="search-row">
      <input id="familyNew" placeholder="Lägg till, t.ex. Klara" autocomplete="off">
      <button type="button" id="familyAdd" class="btn">Lägg till</button>
    </div>`;
}

// ---------- Övrigt ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------- Händelser ----------
document.querySelector('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  currentTab = btn.dataset.tab;
  render();
});
$('#people').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-who]');
  if (!btn) return;
  setWho(btn.dataset.who);
  render();
});
$('#filter').addEventListener('input', render);

$('#list').addEventListener('click', (e) => {
  const prog = e.target.closest('[data-progress]');
  if (prog) { openProgress(prog.dataset.progress); return; }
  const sp = e.target.closest('.spine');
  if (sp) { openBook(sp.dataset.id); return; }
  const card = e.target.closest('.card');
  if (!card) return;
  const action = e.target.closest('button[data-action]');
  if (action) quickAction(card.dataset.id, action.dataset.action);
  else openBook(card.dataset.id);
});
$('#list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('card')) openBook(e.target.dataset.id);
});

// Lägg till
$('#addBtn').addEventListener('click', () => {
  if (!me) { openWho(); return; }
  $('#q').value = '';
  $('#results').innerHTML = '';
  $('#addFor').innerHTML = members().map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  $('#addFor').value = target();
  $('#addFor').closest('label').hidden = members().length < 2;
  $('#addOwned').checked = localStorage.getItem('mina-bocker:add-owned') === '1';
  $('#addDialog').showModal();
  $('#q').focus();
});
$('#addDialog').addEventListener('close', stopScan);
$('#searchForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'cancel') { e.preventDefault(); search($('#q').value.trim()); }
});
$('#q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search($('#q').value.trim()), 400);
});
$('#results').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-i]');
  if (!btn) return;
  addBook(lastResults[+btn.dataset.i], btn.dataset.to, $('#addFor').value || me);
  $('#addDialog').close();
});
$('#addOwned').addEventListener('change', (e) => localStorage.setItem('mina-bocker:add-owned', e.target.checked ? '1' : '0'));
$('#manualBtn').addEventListener('click', () => {
  const q = $('#q').value.trim();
  const forId = $('#addFor').value || me;
  $('#addDialog').close();
  openEdit(null, forId, { ...(normIsbn(q) ? { isbn: q } : { title: q }), ...($('#addOwned').checked ? { owned: true } : {}) });
});
if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
  $('#scanBtn').hidden = false;
  $('#scanBtn').addEventListener('click', startScan);
}

// Redigera
$('#memberTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-member]');
  if (!btn) return;
  storeDraft();
  editMember = btn.dataset.member;
  loadDraft();
});
$('#editForm').addEventListener('change', (e) => {
  if (e.target.name === 'status') { updatePageRow(); storeDraft(); renderMemberTabs(); }
});
$('#stars').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-n]');
  if (!btn) return;
  const n = +btn.dataset.n;
  editRating = editRating === n ? 0 : n;
  renderStars();
});
$('#editForm').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'save') saveEdit();
});
$('#deleteBtn').addEventListener('click', () => {
  const b = db.books[editBookId];
  if (!b || !confirm(`Ta bort ”${b.title}” för hela familjen?`)) return;
  deleteBook(b.id);
  fileDel(b.id).catch(() => {});
  localEpubs.delete(b.id);
  commit();
  $('#editDialog').close();
  $('#bookDialog').close();
  toast('Boken borttagen');
});

// Hur långt
$('#progressForm').addEventListener('input', (e) => {
  const f = $('#progressForm').elements;
  if (e.target.name === 'slider') f.page.value = f.slider.value;
  else syncSlider();
});
$('#progressForm').addEventListener('click', (e) => {
  const step = e.target.closest('[data-step]');
  if (!step) return;
  const f = $('#progressForm').elements;
  const pages = int(f.pages.value);
  let p = (int(f.page.value) ?? 0) + +step.dataset.step;
  p = Math.max(0, pages ? Math.min(p, pages) : p);
  f.page.value = p;
  syncSlider();
});
$('#progressForm').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'save') saveProgress(false);
});
$('#finishBtn').addEventListener('click', () => {
  const e = db.entries[progressId];
  saveProgress(true);
  $('#progressDialog').close();
  if (e) openEdit(e.book_id, e.member_id); // sätt betyg direkt
});

// Vem är du
$('#meBtn').addEventListener('click', openWho);
$('#whoDialog').addEventListener('cancel', (e) => { if (!me || !db.members[me]) e.preventDefault(); });
$('#whoDialog').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick) { setMe(pick.dataset.pick); $('#whoDialog').close(); return; }
  if (e.target.id === 'loginFirst') { $('#whoDialog').close(); openMenu(); }
});
const addMe = () => {
  const id = addMember($('#newMemberName').value);
  if (id) { setMe(id); $('#whoDialog').close(); }
};
$('#addMemberBtn').addEventListener('click', addMe);
$('#newMemberName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addMe(); } });

// Meny
$('#menuBtn').addEventListener('click', openMenu);
$('#syncBtn').addEventListener('click', openMenu);
$('#menuDialog').addEventListener('click', async (e) => {
  const id = e.target.id;
  if (id === 'loginBtn') login(false);
  if (id === 'signupBtn') login(true);
  if (id === 'forgotBtn') forgotPassword();
  if (id === 'passwordBtn') { $('#menuDialog').close(); openNewPassword(false); }
  if (id === 'syncNowBtn') sync();
  if (id === 'logoutBtn' && confirm('Logga ut? Böckerna ligger kvar på den här enheten men synkas inte längre.')) await sb.auth.signOut();
  if (id === 'familyAdd') {
    if (addMember($('#familyNew').value) && !me) setMe(members()[0].id);
    renderFamily();
  }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const m = db.members[rm.dataset.remove];
    if (m && confirm(`Ta bort ${m.name} och allt ${m.name} läst och önskat sig?`)) {
      deleteMember(m.id);
      if (who === m.id) setWho('all');
      commit();
      renderFamily();
      if (m.id === me) { me = null; localStorage.removeItem(ME_KEY); $('#menuDialog').close(); openWho(); }
    }
  }
});
$('#menuDialog').addEventListener('change', (e) => {
  const id = e.target.dataset.rename;
  const name = e.target.value.trim();
  if (id && name && db.members[id] && name !== db.members[id].name) {
    put('members', { ...db.members[id], name });
    commit();
    renderFamily();
  }
});
$('#menuDialog').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'familyNew') { e.preventDefault(); $('#familyAdd').click(); }
  if (e.target.id === 'password') { e.preventDefault(); login(false); }
});
$('#newPassSave').addEventListener('click', saveNewPassword);
$('#newPassDialog').addEventListener('close', () => { if (!me || !db.members[me]) openWho(); });
$('#newPass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveNewPassword(); } });
$('#exportBtn').addEventListener('click', exportData);
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', (e) => {
  if (e.target.files[0]) importData(e.target.files[0]);
  e.target.value = '';
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) e.target.closest('dialog')?.close();
});

// Stäng dialoger genom att klicka utanför (utom "vem är du" innan man valt)
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => {
  if (e.target === d && !(d.id === 'whoDialog' && !db.members[me])) d.close();
}));

// Andra flikar i samma webbläsare
window.addEventListener('storage', (e) => {
  if (e.key === DB_KEY) { db = loadJSON(DB_KEY, db); render(); }
  if (e.key === OUTBOX_KEY) outbox = loadJSON(OUTBOX_KEY, outbox);
});
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 120000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- Omslag ----------
const COVER_TRIED_KEY = 'mina-bocker:cover-tried';
const SPINE_PALETTE = ['#7a4b2a', '#2f4f6f', '#6b2f3a', '#3f5f3a', '#8a6d3b', '#4a3f6b', '#2f5f5f', '#8f4a2f', '#4f4f55', '#1f3f5f', '#6f2f5f', '#5a4a2a'];

function hashStr(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) | 0;
  return Math.abs(h);
}
const hashColor = (s) => SPINE_PALETTE[hashStr(s) % SPINE_PALETTE.length];
const googleImg = (u) => (u ? u.replace(/^http:/, 'https:').replace('&edge=curl', '').replace(/zoom=\d/, 'zoom=1') : '');

// Eget omslag om det finns, annars Open Librarys omslag via ISBN (404 → genererat omslag).
function coverSrc(b) {
  if (b.cover) return b.cover;
  const isbn = normIsbn(b.isbn || '');
  return isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false` : '';
}

async function coverCandidates(b) {
  const out = [];
  const add = (u) => { if (u && !out.includes(u)) out.push(u); };
  const isbn = normIsbn(b.isbn || '');
  const author = (b.authors || '').split(',')[0].trim();
  if (isbn) add(`https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`);
  const queries = [];
  if (isbn) queries.push(`isbn:${isbn}`);
  if (b.title) queries.push(`intitle:${b.title}${author ? ` inauthor:${author}` : ''}`);
  for (const q of queries) {
    try {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=12`);
      if (r.ok) for (const it of (await r.json()).items || []) {
        const l = it.volumeInfo?.imageLinks;
        add(googleImg(l?.thumbnail || l?.smallThumbnail));
      }
    } catch { /* nästa källa */ }
  }
  if (b.title) {
    try {
      const r = await fetch(`https://openlibrary.org/search.json?title=${encodeURIComponent(b.title)}${author ? `&author=${encodeURIComponent(author)}` : ''}&limit=10&fields=cover_i`);
      if (r.ok) for (const d of (await r.json()).docs || []) if (d.cover_i) add(`https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`);
    } catch { /* ingen träff */ }
  }
  return out;
}

// Hämta omslag i bakgrunden till böcker som saknar (t.ex. manuellt tillagda eller från första versionen).
let autoCoversRunning = false;
async function autoCovers() {
  if (autoCoversRunning || !navigator.onLine) return;
  autoCoversRunning = true;
  try {
    const tried = new Set(loadJSON(COVER_TRIED_KEY, []));
    const todo = Object.values(db.books).filter((b) => !b.cover && !tried.has(b.id)).slice(0, 10);
    for (const b of todo) {
      const found = (await coverCandidates(b)).filter((u) => !u.includes('/b/isbn/'));
      if (!navigator.onLine) break;
      tried.add(b.id);
      saveJSON(COVER_TRIED_KEY, [...tried]);
      const cur = db.books[b.id];
      if (found[0] && cur && !cur.cover) { put('books', { ...cur, cover: found[0] }); commit(); }
    }
  } finally {
    autoCoversRunning = false;
  }
}

async function resizeImage(blob, maxW = 320, maxH = 480) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.78);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Omslagsväljaren i redigeringsdialogen
let editCover = '';
function renderEditCover() {
  const f = $('#editForm').elements;
  $('#editCover').innerHTML = coverHtml({ title: f.title.value || '?', authors: f.authors.value, isbn: f.isbn.value, cover: editCover }, 'cover big');
}
async function openCoverPicker() {
  const el = $('#coverPicker');
  if (!el.hidden) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<p class="muted">Letar omslag…</p>';
  const f = $('#editForm').elements;
  const list = await coverCandidates({ title: f.title.value.trim(), authors: f.authors.value.trim(), isbn: f.isbn.value.trim() });
  el.innerHTML = `<div class="cp-grid">
    ${list.map((u) => `<button type="button" class="cp-item" data-cover="${esc(u)}"><img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.remove()" onload="if(this.naturalWidth<5)this.parentNode.remove()"></button>`).join('')}
    <button type="button" class="cp-item cp-own" data-own>📷<br>Egen bild</button>
    <button type="button" class="cp-item cp-own" data-cover="">✕<br>Inget</button>
  </div>${list.length ? '<p class="muted">Välj ett omslag, eller ta en bild på din egen bok.</p>' : '<p class="muted">Hittade inga omslag – ta en bild på boken!</p>'}`;
}

// ---------- Bokhyllan ----------
const SHELF_VIEW_KEY = 'mina-bocker:shelf-view';
const SPINE_KEY = 'mina-bocker:spine-colors';
let shelfView = localStorage.getItem(SHELF_VIEW_KEY) || 'spines';
let spineCache = loadJSON(SPINE_KEY, {});

function isLight(color) {
  let r, g, b;
  const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) [r, g, b] = m.slice(1).map(Number);
  else if (/^#[0-9a-f]{6}$/i.test(color)) [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  else return false;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
}
function spineColor(b) {
  if (b.spine?.color) return b.spine.color;
  const c = spineCache[b.id];
  return c && c.src === coverSrc(b) && c.color ? c.color : hashColor(b.title);
}
// Tjockleken är proportionell mot antal sidor: 400 sidor blir exakt dubbelt så tjock som 200.
// Saknas sidantal används uppmätt tjocklek (ca 160 sidor per cm), annars fotots proportioner.
const PX_PER_PAGE = 0.1;
function spineSize(b) {
  const s = b.spine || {};
  const h = s.h ? Math.max(90, Math.min(184, Math.round(s.h * 7.5))) : 148 + (hashStr(b.id || b.title) % 36);
  const pages = b.pages || (s.w ? s.w * 160 : null);
  let w = pages ? pages * PX_PER_PAGE : s.ratio ? h * s.ratio : 280 * PX_PER_PAGE;
  w = Math.max(5, Math.min(100, Math.round(w * 2) / 2));
  return { w, h };
}
function spine(b) {
  const { w, h } = spineSize(b);
  const color = spineColor(b);
  const photo = b.spine?.img && /^data:image\//.test(b.spine.img) ? b.spine.img : '';
  const author = (b.authors || '').split(',')[0].trim().split(/\s+/).pop();
  const readers = entriesOf(b.id).filter((e) => e.status === 'reading').map((e) => db.members[e.member_id]);
  return `<button type="button" class="spine${isLight(color) ? ' light' : ''}${photo ? ' photo' : ''}${w < 15 ? ' thin' : ''}" data-id="${esc(b.id)}"
      style="--w:${w}px;--h:${h}px;--sc:${esc(color)}${photo ? `;--img:url(${photo})` : ''}" title="${esc(b.title)}${b.authors ? ' – ' + esc(b.authors) : ''}">
    <span class="sp-title">${esc(b.title)}</span>
    ${author ? `<span class="sp-author">${esc(author)}</span>` : ''}
    ${readers.length ? `<span class="sp-marks">${readers.map((m) => `<i style="background:${esc(m.color)}" title="${esc(m.name)} läser"></i>`).join('')}</span>` : ''}
    ${localEpubs.has(b.id) ? '<span class="sp-e" title="E-bok på den här enheten">e</span>' : ''}
  </button>`;
}
// Bokryggens färg hämtas från omslaget (när bildservern tillåter det), annars en färg från titeln.
function extractSpineColors(list) {
  for (const b of list) {
    const src = coverSrc(b);
    const cached = spineCache[b.id];
    if (!src || b.spine?.img || b.spine?.color || (cached && cached.src === src)) continue;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    const done = (color) => {
      spineCache[b.id] = { src, color };
      saveJSON(SPINE_KEY, spineCache);
      if (!color) return;
      document.querySelectorAll('.spine').forEach((el) => {
        if (el.dataset.id !== b.id) return;
        el.style.setProperty('--sc', color);
        el.classList.toggle('light', isLight(color));
      });
    };
    img.onload = () => {
      try {
        if (img.naturalWidth < 5) return done(null);
        const n = 16;
        const c = document.createElement('canvas');
        c.width = c.height = n;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, n, n);
        const d = ctx.getImageData(0, 0, n, n).data;
        let r = 0, g = 0, bl = 0, wsum = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = 0.15 + (mx - mn) / 255; // mättade färger väger tyngre
          r += d[i] * w; g += d[i + 1] * w; bl += d[i + 2] * w; wsum += w;
        }
        done(`rgb(${Math.round(r / wsum)}, ${Math.round(g / wsum)}, ${Math.round(bl / wsum)})`);
      } catch { done(null); }
    };
    img.onerror = () => done(null);
    img.src = src;
  }
}

// ---------- Bokvy ----------
let viewBookId = null;
function openBook(id) {
  const b = db.books[id];
  if (!b) return;
  viewBookId = id;
  $('#bvCover').innerHTML = coverHtml(b, 'cover huge');
  $('#bvTitle').textContent = b.title;
  $('#bvAuthor').textContent = b.authors || '';
  $('#bvMeta').textContent = [b.year, b.pages ? `${b.pages} sidor` : '', b.isbn ? `ISBN ${b.isbn}` : ''].filter(Boolean).join(' · ');
  const tags = [];
  if (b.owned) tags.push('I bokhyllan');
  if (localEpubs.has(id)) tags.push('E-bok på den här enheten');
  $('#bvTags').innerHTML = tags.map((t) => `<span class="tag">${t}</span>`).join('');
  const es = entriesOf(id);
  $('#bvFamily').innerHTML = es.length ? `<h3>Familjen</h3>${whoRows(es, b)}` : '';
  $('#bvNotes').innerHTML = es.filter((e) => e.notes).map((e) =>
    `<p class="note"><b>${esc(db.members[e.member_id].name)}:</b> ${esc(e.notes)}</p>`).join('');
  const t = target();
  const mine = t && db.entries[entryId(id, t)];
  const forName = t && t !== me ? ` (${esc(db.members[t].name)})` : '';
  const acts = [];
  if (localEpubs.has(id)) acts.push('<button type="button" class="btn primary" data-bv="read">📖 Läs</button>');
  if (t && mine?.status !== 'reading') acts.push(`<button type="button" class="btn" data-bv="start">▶ Börja läsa${forName}</button>`);
  if (mine?.status === 'reading') acts.push(`<button type="button" class="btn" data-bv="progress">Hur långt?${forName}</button>`);
  acts.push('<span class="spacer"></span>');
  if (b.owned) acts.push('<button type="button" class="btn" data-bv="spine" title="Fota bokryggen">📷 Rygg</button>');
  acts.push(localEpubs.has(id)
    ? '<button type="button" class="link-btn" data-bv="rmepub">Ta bort epub</button>'
    : '<button type="button" class="btn" data-bv="epub">＋ Epub</button>');
  if (!b.owned) acts.push('<button type="button" class="btn" data-bv="own">📚 Till hyllan</button>');
  acts.push('<button type="button" class="btn" data-bv="edit">✎ Redigera</button>');
  $('#bvActions').innerHTML = acts.join('');
  if (!$('#bookDialog').open) $('#bookDialog').showModal();
}

// ---------- Epub-filer (sparas lokalt per enhet i IndexedDB) ----------
let localEpubs = new Set();
let idbPromise = null;
function idb() {
  return idbPromise ||= new Promise((res, rej) => {
    const r = indexedDB.open('mina-bocker-filer', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('epubs', { keyPath: 'bookId' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => { idbPromise = null; rej(r.error); };
  });
}
async function idbReq(mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction('epubs', mode);
    const r = fn(tx.objectStore('epubs'));
    tx.oncomplete = () => res(r?.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
const fileGet = (id) => idbReq('readonly', (st) => st.get(id));
const filePut = (rec) => idbReq('readwrite', (st) => st.put(rec));
const fileDel = (id) => idbReq('readwrite', (st) => st.delete(id));
const fileKeys = () => idbReq('readonly', (st) => st.getAllKeys());

const scripts = {};
function loadScript(src) {
  return scripts[src] ||= new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = res;
    el.onerror = () => { delete scripts[src]; rej(new Error('Kunde inte ladda läsaren')); };
    document.head.append(el);
  });
}
async function ensureEpub() {
  await loadScript('vendor/jszip-3.10.1.min.js');
  await loadScript('vendor/epub-0.3.93.min.js');
}

function epubIsbn(identifier) {
  const raw = String(identifier || '');
  const digits = raw.replace(/^urn:isbn:/i, '').replace(/[\s-]/g, '');
  return /isbn/i.test(raw) || /^(97[89])?\d{9}[\dX]$/i.test(digits) ? normIsbn(digits) || '' : '';
}

async function importEpubs(files, attachTo = null) {
  files = [...files];
  if (!files.length) return null;
  try { await ensureEpub(); } catch (e) { toast(e.message); return null; }
  navigator.storage?.persist?.().catch(() => {});
  let ok = 0, lastId = null;
  for (const file of files) {
    try {
      toast(`Läser in ${file.name}…`);
      const data = await file.arrayBuffer();
      const ep = window.ePub(data.slice(0));
      await ep.ready;
      const meta = ep.packaging?.metadata || {};
      let cover = '';
      try {
        const url = await ep.coverUrl();
        if (url) cover = await resizeImage(await (await fetch(url)).blob());
      } catch { /* ingen omslagsbild */ }
      ep.destroy();
      const title = (meta.title || file.name.replace(/\.epub$/i, '')).trim();
      const authors = (meta.creator || '').trim();
      const isbn = epubIsbn(meta.identifier);
      let book = attachTo ? db.books[attachTo] : findDuplicate({ title, authors, isbn });
      if (!book) {
        book = { id: uid(), title, authors, year: (meta.pubdate || '').slice(0, 4), isbn, cover, pages: null, owned: true, added_at: today() };
        put('books', book);
      } else if (!book.cover && cover) {
        book = { ...book, cover };
        put('books', book);
      }
      await filePut({ bookId: book.id, name: file.name, size: file.size, data, added_at: today() });
      localEpubs.add(book.id);
      ok++;
      lastId = book.id;
    } catch (err) {
      console.warn(err);
      toast(`Kunde inte läsa ${file.name}`);
    }
  }
  commit();
  if (ok) toast(ok === 1 ? 'Epub tillagd – tryck på Läs för att börja' : `${ok} epub-filer tillagda`);
  return lastId;
}

// ---------- Läsaren ----------
const READER_KEY = 'mina-bocker:reader';
const THEMES = {
  light: { bg: '#ffffff', fg: '#222222' },
  sepia: { bg: '#f4ecd8', fg: '#3b2f22' },
  dark: { bg: '#1c1916', fg: '#e6ddd2' },
};
let rd = null;
let rdSaveTimer = null;

async function openReader(bookId) {
  const rec = await fileGet(bookId).catch(() => null);
  if (!rec) { toast('Epub-filen finns inte på den här enheten'); return; }
  try { await ensureEpub(); } catch (e) { toast(e.message); return; }
  if (rd) closeReader();
  $('#bookDialog').close();
  const b = db.books[bookId];
  const prefs = loadJSON(READER_KEY, { size: 100, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' });
  $('#reader').hidden = false;
  document.body.classList.add('reading-mode');
  $('#rdTitle').textContent = b?.title || rec.name;
  $('#rdPct').textContent = '';
  $('#rdChapter').textContent = '';
  $('#rdFinish').hidden = true;
  $('#rdToc').hidden = true;
  $('#rdView').innerHTML = '';

  const book = window.ePub(rec.data.slice(0));
  const rendition = book.renderTo('rdView', { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', minSpreadWidth: 900 });
  rd = { book, rendition, bookId, prefs, pct: null, toc: [] };
  for (const [k, t] of Object.entries(THEMES)) {
    rendition.themes.register(k, { body: { background: `${t.bg} !important`, color: `${t.fg} !important` }, a: { color: 'inherit !important' } });
  }
  applyReaderPrefs();
  rendition.hooks.content.register((contents) => {
    const d = contents.document;
    let x0 = null, y0 = null;
    d.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    d.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) (dx < 0 ? rendition.next() : rendition.prev());
    }, { passive: true });
    d.addEventListener('keydown', readerKey);
  });
  rendition.on('relocated', onRelocated);

  const pos = localStorage.getItem('mina-bocker:pos:' + bookId);
  try { await rendition.display(pos || undefined); } catch { await rendition.display(); }
  book.loaded.navigation.then((nav) => renderToc(nav.toc)).catch(() => {});
  startReadingIfNeeded(bookId);

  // Positioner för procent (sparas så att det bara behöver räknas ut en gång)
  await book.ready;
  const key = 'mina-bocker:loc:' + bookId;
  const saved = localStorage.getItem(key);
  if (saved) { try { book.locations.load(saved); } catch { /* räkna om */ } }
  if (!book.locations.length()) {
    await book.locations.generate(1200);
    try { localStorage.setItem(key, book.locations.save()); } catch { /* för stort, räknas om nästa gång */ }
  }
  if (rd?.book !== book) return;
  // Saknas sidantal: uppskatta (ca 1 800 tecken per tryckt sida) så att framstegen syns för familjen.
  const cur = db.books[bookId];
  if (cur && !cur.pages) { put('books', { ...cur, pages: Math.max(1, Math.round((book.locations.length() * 1200) / 1800)) }); commit(); }
  const loc = rendition.currentLocation();
  if (loc?.start) onRelocated(loc);
}

function startReadingIfNeeded(bookId) {
  if (!me) return;
  const e = db.entries[entryId(bookId, me)];
  if (e?.status === 'reading' || e?.status === 'read') return;
  put('entries', { ...blankEntry(bookId, me), ...e, status: 'reading', started_at: today(), finished_at: null });
  commit();
}

function onRelocated(loc) {
  if (!rd || !loc?.start) return;
  localStorage.setItem('mina-bocker:pos:' + rd.bookId, loc.start.cfi);
  const p = loc.atEnd ? 1 : rd.book.locations.length() ? rd.book.locations.percentageFromCfi(loc.start.cfi) : null;
  rd.pct = p;
  $('#rdPct').textContent = p != null ? `${Math.round(p * 100)} %` : '';
  const href = (loc.start.href || '').split('#')[0];
  const ch = rd.toc.filter((t) => t.href.split('#')[0].endsWith(href) || href.endsWith(t.href.split('#')[0])).pop();
  $('#rdChapter').textContent = ch ? ch.label : '';
  $('#rdFinish').hidden = !(loc.atEnd || (p != null && p >= 0.97));
  clearTimeout(rdSaveTimer);
  rdSaveTimer = setTimeout(saveReaderProgress, 2000);
}

function saveReaderProgress() {
  if (!rd || rd.pct == null || !me) return;
  const b = db.books[rd.bookId];
  const e = db.entries[entryId(rd.bookId, me)];
  if (!b?.pages || e?.status !== 'reading') return;
  const page = Math.max(1, Math.round(rd.pct * b.pages));
  if (page !== e.page) { put('entries', { ...e, page }); commit(); }
}

function renderToc(toc) {
  const flat = [];
  const walk = (items, depth) => items.forEach((it) => { flat.push({ label: it.label.trim(), href: it.href, depth }); if (it.subitems) walk(it.subitems, depth + 1); });
  walk(toc || [], 0);
  if (!rd) return;
  rd.toc = flat;
  $('#rdToc').innerHTML = flat.length
    ? flat.map((t, i) => `<button type="button" data-toc="${i}" style="padding-left:${12 + t.depth * 16}px">${esc(t.label)}</button>`).join('')
    : '<p class="muted">Ingen innehållsförteckning.</p>';
}

function applyReaderPrefs() {
  if (!rd) return;
  const { prefs, rendition } = rd;
  rendition.themes.select(prefs.theme);
  rendition.themes.fontSize(`${prefs.size}%`);
  const t = THEMES[prefs.theme];
  $('#reader').style.setProperty('--rd-bg', t.bg);
  $('#reader').style.setProperty('--rd-fg', t.fg);
  saveJSON(READER_KEY, prefs);
}

function readerKey(e) {
  if (!rd) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') rd.rendition.next();
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') rd.rendition.prev();
  if (e.key === 'Escape') closeReader();
}

function closeReader() {
  if (!rd) return;
  clearTimeout(rdSaveTimer);
  saveReaderProgress();
  try { rd.rendition.destroy(); rd.book.destroy(); } catch { /* redan stängd */ }
  rd = null;
  $('#reader').hidden = true;
  document.body.classList.remove('reading-mode');
  render();
}

function finishFromReader() {
  if (!rd) return;
  const bookId = rd.bookId;
  closeReader();
  const e = db.entries[entryId(bookId, me)];
  const b = db.books[bookId];
  if (e) put('entries', { ...e, status: 'read', page: b?.pages || e.page, finished_at: today() });
  commit();
  toast(`Grattis! ”${b?.title}” är utläst 🎉`);
  openEdit(bookId, me);
}

// ---------- Händelser: omslag, hylla, bokvy, läsare ----------
$('#editCoverBtn').addEventListener('click', openCoverPicker);
$('#coverPicker').addEventListener('click', (e) => {
  if (e.target.closest('[data-own]')) { $('#coverFile').click(); return; }
  const item = e.target.closest('[data-cover]');
  if (!item) return;
  editCover = item.dataset.cover;
  renderEditCover();
  $('#coverPicker').hidden = true;
});
$('#coverFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    editCover = await resizeImage(file);
    renderEditCover();
    $('#coverPicker').hidden = true;
  } catch { toast('Kunde inte läsa bilden'); }
});

$('#viewToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  shelfView = btn.dataset.view;
  localStorage.setItem(SHELF_VIEW_KEY, shelfView);
  render();
});

$('#bookDialog').addEventListener('click', async (e) => {
  const prog = e.target.closest('[data-progress]');
  if (prog) { openProgress(prog.dataset.progress); return; }
  const btn = e.target.closest('[data-bv]');
  if (!btn) return;
  const id = viewBookId;
  const a = btn.dataset.bv;
  if (a === 'read') openReader(id);
  if (a === 'spine') openSpinePhoto(({ img, ratio }) => {
    const cur = db.books[id];
    if (!cur) return;
    put('books', { ...cur, spine: { ...(cur.spine || {}), img, ratio } });
    commit();
    toast('Bokryggen sparad');
  });
  if (a === 'start') quickAction(id, 'start');
  if (a === 'own') quickAction(id, 'own');
  if (a === 'progress') openProgress(entryId(id, target()));
  if (a === 'epub') $('#bvEpubFile').click();
  if (a === 'edit') { $('#bookDialog').close(); openEdit(id); }
  if (a === 'rmepub' && confirm('Ta bort epub-filen från den här enheten? Boken ligger kvar.')) {
    await fileDel(id).catch(() => {});
    localEpubs.delete(id);
    render();
  }
});
$('#bvEpubFile').addEventListener('change', async (e) => {
  const files = e.target.files;
  const id = viewBookId;
  if (files.length) await importEpubs(files, id);
  e.target.value = '';
  if (localEpubs.has(id)) openBook(id);
});

$('#epubImportBtn').addEventListener('click', () => $('#epubFile').click());
$('#epubFile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  $('#addDialog').close();
  const id = await importEpubs(files);
  if (id && files.length === 1) openBook(id);
  else if (id) { currentTab = 'shelf'; render(); }
});

$('#rdClose').addEventListener('click', closeReader);
$('#rdPrev').addEventListener('click', () => rd?.rendition.prev());
$('#rdNext').addEventListener('click', () => rd?.rendition.next());
$('#rdSmaller').addEventListener('click', () => { if (rd) { rd.prefs.size = Math.max(60, rd.prefs.size - 10); applyReaderPrefs(); } });
$('#rdBigger').addEventListener('click', () => { if (rd) { rd.prefs.size = Math.min(220, rd.prefs.size + 10); applyReaderPrefs(); } });
$('#rdTheme').addEventListener('click', () => {
  if (!rd) return;
  const order = Object.keys(THEMES);
  rd.prefs.theme = order[(order.indexOf(rd.prefs.theme) + 1) % order.length];
  applyReaderPrefs();
});
$('#rdTocBtn').addEventListener('click', () => { $('#rdToc').hidden = !$('#rdToc').hidden; });
$('#rdToc').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-toc]');
  if (!btn || !rd) return;
  rd.rendition.display(rd.toc[+btn.dataset.toc].href);
  $('#rdToc').hidden = true;
});
$('#rdFinish').addEventListener('click', finishFromReader);
document.addEventListener('keydown', (e) => { if (rd && !$('#reader').hidden) readerKey(e); });
window.addEventListener('resize', () => { if (rd) rd.rendition.resize(); });
window.addEventListener('pagehide', saveReaderProgress);

// ---------- Fota bokryggen ----------
// Man tar en bild (gärna på hela hyllan), drar en ruta runt en bokrygg och får en
// liten stående bild av ryggen. Bildens proportioner ger också bokens tjocklek i hyllan.
let spSrc = null;        // canvas med källbilden (ev. vriden)
let spLastPhoto = null;  // förra bilden, så man kan fota hela hyllan en gång
let spRect = null;       // markeringen, normaliserad 0–1
let spDone = null;       // anropas med { img, ratio }

function openSpinePhoto(onDone) {
  spDone = onDone;
  spSrc = null;
  spRect = null;
  $('#spWork').hidden = true;
  $('#spRotate').hidden = true;
  $('#spLast').hidden = !spLastPhoto;
  $('#spUse').disabled = true;
  $('#spineDialog').showModal();
}

async function loadSpinePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    useSpineSource(c);
    spLastPhoto = c;
  } catch {
    toast('Kunde inte läsa bilden');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function useSpineSource(c) {
  spSrc = c;
  spRect = { x: 0.42, y: 0.05, w: 0.16, h: 0.9 };
  $('#spWork').hidden = false;
  $('#spRotate').hidden = false;
  drawSpineSource();
}

function drawSpineSource() {
  const view = $('#spCanvas');
  const maxW = Math.min($('#spineDialog').clientWidth - 140, 600);
  const maxH = window.innerHeight * 0.55;
  const k = Math.min(maxW / spSrc.width, maxH / spSrc.height);
  view.width = Math.round(spSrc.width * k);
  view.height = Math.round(spSrc.height * k);
  view.getContext('2d').drawImage(spSrc, 0, 0, view.width, view.height);
  drawSpineRect();
}

function drawSpineRect() {
  const r = spRect, el = $('#spRect'), v = $('#spCanvas');
  Object.assign(el.style, { left: `${r.x * v.width}px`, top: `${r.y * v.height}px`, width: `${r.w * v.width}px`, height: `${r.h * v.height}px` });
  const out = cropSpine();
  $('#spUse').disabled = !out;
  const pv = $('#spPreview');
  if (!out) { pv.width = pv.height = 0; return; }
  pv.width = out.width;
  pv.height = out.height;
  pv.getContext('2d').drawImage(out, 0, 0);
}

// Klipper ut markeringen. Ligger ryggen ner (bredare än hög) vrids den till stående.
function cropSpine() {
  if (!spSrc || !spRect) return null;
  const sx = spRect.x * spSrc.width, sy = spRect.y * spSrc.height;
  const sw = spRect.w * spSrc.width, sh = spRect.h * spSrc.height;
  if (sw < 6 || sh < 6) return null;
  const lying = sw > sh;
  const long = lying ? sw : sh, short = lying ? sh : sw;
  const H = Math.min(280, Math.round(long));
  const W = Math.max(4, Math.round((short / long) * H));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  if (lying) {
    ctx.translate(0, H);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(spSrc, sx, sy, sw, sh, 0, 0, H, W);
  } else {
    ctx.drawImage(spSrc, sx, sy, sw, sh, 0, 0, W, H);
  }
  return c;
}

function rotateSpineSource() {
  const c = document.createElement('canvas');
  c.width = spSrc.height;
  c.height = spSrc.width;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(spSrc, 0, 0);
  useSpineSource(c);
  spLastPhoto = c;
}

let spDrag = null;
$('#spCrop').addEventListener('pointerdown', (e) => {
  const v = $('#spCanvas').getBoundingClientRect();
  const x = (e.clientX - v.left) / v.width, y = (e.clientY - v.top) / v.height;
  spDrag = { x0: Math.min(1, Math.max(0, x)), y0: Math.min(1, Math.max(0, y)) };
  $('#spCrop').setPointerCapture(e.pointerId);
  e.preventDefault();
});
$('#spCrop').addEventListener('pointermove', (e) => {
  if (!spDrag) return;
  const v = $('#spCanvas').getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - v.left) / v.width));
  const y = Math.min(1, Math.max(0, (e.clientY - v.top) / v.height));
  spRect = { x: Math.min(x, spDrag.x0), y: Math.min(y, spDrag.y0), w: Math.abs(x - spDrag.x0), h: Math.abs(y - spDrag.y0) };
  drawSpineRect();
});
const endDrag = () => { spDrag = null; };
$('#spCrop').addEventListener('pointerup', endDrag);
$('#spCrop').addEventListener('pointercancel', endDrag);

$('#spTake').addEventListener('click', () => $('#spFile').click());
$('#spFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) loadSpinePhoto(f);
});
$('#spLast').addEventListener('click', () => { if (spLastPhoto) useSpineSource(spLastPhoto); });
$('#spRotate').addEventListener('click', rotateSpineSource);
$('#spUse').addEventListener('click', () => {
  const out = cropSpine();
  if (!out) return;
  const res = { img: out.toDataURL('image/jpeg', 0.78), ratio: Math.round((out.width / out.height) * 1000) / 1000 };
  $('#spineDialog').close();
  spDone?.(res);
});

// ---------- Bokryggen i redigeringen ----------
let editSpine = {};
let editSpineColorSet = false;

function toHex(color) {
  const m = String(color).match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return /^#[0-9a-f]{6}$/i.test(color) ? color : '#7a4b2a';
  return '#' + m.slice(1).map((n) => (+n).toString(16).padStart(2, '0')).join('');
}
const cm = (v) => { const n = parseFloat(String(v).replace(',', '.')); return n > 0 && n < 100 ? Math.round(n * 10) / 10 : null; };

function loadSpineEdit(b) {
  editSpine = { ...(b?.spine || {}) };
  editSpineColorSet = !!editSpine.color;
  $('#spineH').value = editSpine.h ? String(editSpine.h).replace('.', ',') : '';
  $('#spineW').value = editSpine.w ? String(editSpine.w).replace('.', ',') : '';
  $('#spineEdit').open = !!(editSpine.img || editSpine.color || editSpine.h || editSpine.w);
  renderSpinePreview();
}
function draftBook() {
  const f = $('#editForm').elements;
  const prev = db.books[editBookId];
  return { ...(prev || {}), id: editBookId || 'ny', title: f.title.value || '?', authors: f.authors.value, isbn: f.isbn.value,
    pages: int(f.pages.value), cover: editCover, spine: cleanSpine(editSpine) };
}
function cleanSpine(s) {
  const out = {};
  if (s.img) { out.img = s.img; out.ratio = s.ratio; }
  if (s.color) out.color = s.color;
  if (s.h) out.h = s.h;
  if (s.w) out.w = s.w;
  return Object.keys(out).length ? out : null;
}
function renderSpinePreview() {
  const b = draftBook();
  $('#spinePreview').innerHTML = spine(b);
  if (!editSpineColorSet) $('#spineColor').value = toHex(spineColor({ ...b, spine: null }));
  else $('#spineColor').value = toHex(editSpine.color);
}

$('#spinePhotoBtn').addEventListener('click', () => openSpinePhoto(({ img, ratio }) => {
  editSpine = { ...editSpine, img, ratio };
  renderSpinePreview();
}));
$('#spineResetBtn').addEventListener('click', () => {
  editSpine = {};
  editSpineColorSet = false;
  $('#spineH').value = '';
  $('#spineW').value = '';
  renderSpinePreview();
});
$('#spineColor').addEventListener('input', (e) => {
  editSpine.color = e.target.value;
  editSpineColorSet = true;
  renderSpinePreview();
});
$('#editForm').elements.pages.addEventListener('input', () => { if ($('#spineEdit').open) renderSpinePreview(); });
['#spineH', '#spineW'].forEach((sel) => $(sel).addEventListener('input', () => {
  editSpine.h = cm($('#spineH').value);
  editSpine.w = cm($('#spineW').value);
  renderSpinePreview();
}));

// ---------- Start ----------
(async function start() {
  if (who !== 'all' && !db.members[who]) who = me || 'all';
  render();
  updateSyncUI();
  if (sb) {
    const { data } = await sb.auth.getSession();
    await onSession(data.session);
    sb.auth.onAuthStateChange((_event, s) => { setTimeout(() => onSession(s), 0); });
  }
  if (authLinkError) toast(/expired|invalid/i.test(authLinkError) ? 'Länken har gått ut – be om en ny under ⋯ → Glömt lösenord?' : authLinkError);
  if (!me || !db.members[me]) openWho();
  else migrateV1();
  fileKeys().then((keys) => { localEpubs = new Set(keys); render(); }).catch(() => {});
  setTimeout(autoCovers, 1500);
})();
