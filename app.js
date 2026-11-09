'use strict';

/*
 * Mina böcker – familjeversion.
 *
 * Data (samma struktur lokalt och i Supabase, se supabase/schema.sql):
 *   members: { id, name, color }                       – familjemedlemmar (profiler)
 *   books:   { id, title, authors, year, isbn, cover, pages, owned, added_at }
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
  books: ['id', 'title', 'authors', 'year', 'isbn', 'cover', 'pages', 'owned', 'added_at', 'updated_at'],
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
  if (b.cover) return `<img class="${cls}" src="${esc(b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return `<div class="${cls}" aria-hidden="true">${esc((b.title || '?')[0].toUpperCase())}</div>`;
}
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
  es.sort((x, y) => (x.status === y.status ? (pct(y, b) ?? y.page ?? 0) - (pct(x, b) ?? x.page ?? 0) : x.status === 'reading' ? -1 : 1));
  return `<div class="who-row">${es.map((e) => {
    const m = db.members[e.member_id];
    const label = `${avatar(m, 'avatar sm')}<span class="name">${esc(m.name)}</span>`;
    if (e.status === 'reading') {
      const p = pct(e, b);
      const pg = e.page ? `s. ${e.page}${b.pages ? ` / ${b.pages}` : ''}${p != null ? ` · ${p}%` : ''}` : 'Ange sida';
      return `<button type="button" class="who-line" data-progress="${esc(e.id)}" aria-label="Uppdatera hur långt ${esc(m.name)} kommit">
        ${label}<span class="bar"><i style="width:${p ?? 0}%;background:${esc(m.color)}"></i></span><span class="pg">${pg}</span></button>`;
    }
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
  const img = $('#editCover');
  img.hidden = !d.cover;
  if (d.cover) img.src = d.cover;
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
  };
  if (!prev || COLUMNS.books.some((c) => c !== 'updated_at' && book[c] !== prev[c])) put('books', book);

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
      cover: img.replace(/^http:/, 'https:'),
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
  const ms = members();
  $('#whoList').innerHTML = (ms.length ? ms.map((m) =>
    `<button type="button" class="who-pick" data-pick="${esc(m.id)}">${avatar(m)}${esc(m.name)}${m.id === me ? ' <span class="muted">(vald)</span>' : ''}</button>`).join('')
    : '<p class="muted">Skriv ditt namn för att komma igång. Lägg sedan till resten av familjen under ⋯.</p>') +
    (sb && !session ? '<button type="button" class="link-btn" id="loginFirst">Har familjen redan ett konto? Logga in först</button>' : '');
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
    loggedout: ['○', '', 'Inte inloggad – data sparas bara på den här enheten'],
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
    </div>`;
    return;
  }
  el.innerHTML = `<p class="muted">Inloggad som <b>${esc(session.user.email)}</b> · ${esc(statusText || '')}</p>
    <div class="actions">
      <button type="button" id="syncNowBtn" class="btn">⟳ Synka nu</button>
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
  if (s && s.user.id !== was) {
    subscribe();
    await sync();
    if (!me || !db.members[me]) openWho();
  } else if (!s) {
    subscribe();
  }
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
  const card = e.target.closest('.card');
  if (!card) return;
  const action = e.target.closest('button[data-action]');
  if (action) quickAction(card.dataset.id, action.dataset.action);
  else openEdit(card.dataset.id);
});
$('#list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('card')) openEdit(e.target.dataset.id);
});

// Lägg till
$('#addBtn').addEventListener('click', () => {
  if (!me) { openWho(); return; }
  $('#q').value = '';
  $('#results').innerHTML = '';
  $('#addFor').innerHTML = members().map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  $('#addFor').value = target();
  $('#addFor').closest('label').hidden = members().length < 2;
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
$('#manualBtn').addEventListener('click', () => {
  const q = $('#q').value.trim();
  const forId = $('#addFor').value || me;
  $('#addDialog').close();
  openEdit(null, forId, normIsbn(q) ? { isbn: q } : { title: q });
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
  commit();
  $('#editDialog').close();
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
  if (!me || !db.members[me]) openWho();
  else migrateV1();
})();
