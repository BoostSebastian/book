'use strict';

/*
 * Mina böcker – familjeversion.
 *
 * Data (samma struktur lokalt och i Supabase, se supabase/schema.sql):
 *   members: { id, name, color }                       – familjemedlemmar (profiler)
 *   books:   { id, title, authors, year, isbn, cover, pages, owned, spine, genres, moods, description, series, series_no, added_at }
 *   entries: { id: "<bok>:<person>", book_id, member_id,
 *              status: 'wishlist'|'reading'|'read', page, rating, notes, audio (ljudbok), started_at, finished_at }
 *
 * Lokalt först: allt sparas direkt i localStorage och läggs i en kö (outbox) som
 * skickas till Supabase när man är inloggad och har nät. Appen fungerar alltså offline.
 */

const APP_VERSION = '24';
const DB_KEY = 'mina-bocker:v2';
const OUTBOX_KEY = 'mina-bocker:outbox';
const ME_KEY = 'mina-bocker:me';
const WHO_KEY = 'mina-bocker:who';
const V1_KEY = 'mina-bocker:v1';
const TABLES = ['members', 'books', 'entries']; // i FK-ordning
const COLUMNS = {
  members: ['id', 'name', 'color', 'updated_at'],
  books: ['id', 'title', 'authors', 'year', 'isbn', 'cover', 'pages', 'owned', 'spine', 'genres', 'moods', 'description', 'series', 'series_no', 'added_at', 'updated_at'],
  entries: ['id', 'book_id', 'member_id', 'status', 'page', 'rating', 'notes', 'audio', 'started_at', 'finished_at', 'updated_at'],
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
// Bara lyssnad (ingen har läst den som bok) – då hör den hemma på ljudbokshyllan, inte i bokhyllan.
const isAudioOnly = (es) => es.some((e) => e.audio) && !es.some((e) => !e.audio && e.status !== 'wishlist');
function audioBooks() {
  const ids = new Set(Object.values(db.entries).filter((e) => e.audio && db.members[e.member_id]).map((e) => e.book_id));
  return [...ids].map((id) => db.books[id]).filter(Boolean);
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
  renderStats();
  if ($('#bookDialog').open) { if (db.books[viewBookId]) openBook(viewBookId); else $('#bookDialog').close(); }
  const vt = $('#viewToggle');
  vt.hidden = currentTab !== 'shelf';
  vt.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === shelfView)));

  const q = $('#filter').value.trim().toLowerCase();
  const audioShelf = currentTab === 'shelf' && shelfView === 'audio';
  let list = audioShelf ? audioBooks() : booksForTab(currentTab);
  if (q) list = list.filter((b) => `${b.title} ${b.authors} ${b.series || ''}`.toLowerCase().includes(q));
  const sort = sortFor(currentTab);
  renderSortBar(sort);
  $('#seriesTip').hidden = sort.key !== 'series';
  list = sortBooks(list, sort);

  const el = $('#list');
  if (!list.length) {
    const name = who !== 'all' && db.members[who] ? db.members[who].name : null;
    const empty = {
      reading: name ? `${name} läser ingen bok just nu.` : 'Ingen läser något just nu.',
      shelf: 'Bokhyllan är tom.',
      wishlist: name ? `${name} har inget på önskelistan.` : 'Önskelistan är tom.',
      read: name ? `${name} har inga lästa böcker ännu.` : 'Inga lästa böcker ännu.',
    }[currentTab];
    if (audioShelf) {
      el.innerHTML = `<div class="empty"><div class="big">🎧</div><p>${q ? 'Inga träffar.' : 'Inga ljudböcker ännu.'}</p>
        ${q ? '' : '<p>Kryssa i <b>🎧 Ljudbok</b> när du lägger till en bok, eller under Redigera.</p>'}</div>`;
      return;
    }
    el.innerHTML = `<div class="empty"><div class="big">📚</div><p>${q ? 'Inga träffar.' : esc(empty)}</p>
      ${q ? '' : '<p>Tryck på <b>＋</b> för att lägga till en bok.</p>'}</div>`;
    return;
  }
  if (audioShelf) {
    el.innerHTML = `<div class="record-shelf">${list.map(record).join('')}</div>`;
    extractSpineColors(list);
    return;
  }
  if (currentTab === 'shelf' && shelfView === 'spines') {
    let prev = null;
    const slots = list.map((b) => {
      const g = sort.key === 'series' ? (b.series || '') : null;
      const end = g && g !== prev ? `<div class="slot"><div class="bookend" title="${esc(g)}"><span>${esc(g)}</span></div></div>` : '';
      prev = g;
      return `${end}<div class="slot">${spine(b)}</div>`;
    });
    el.innerHTML = `<div class="bookcase">${slots.join('')}</div>`;
    extractSpineColors(list);
    return;
  }
  if (sort.key === 'series') {
    let prev;
    el.innerHTML = list.map((b) => {
      const g = b.series || '';
      const head = g !== prev ? `<h3 class="group-h">${g ? esc(g) : 'Utan serie'}</h3>` : '';
      prev = g;
      return head + card(b);
    }).join('');
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
    const tg = [];
    if (b.owned) tg.push('📚 I hyllan');
    if (es.some((e) => e.audio)) tg.push('🎧 Ljudbok');
    if (tg.length) body += `<div class="tags">${tg.map((t) => `<span class="tag">${t}</span>`).join('')}</div>`;
    else if (!isAudioOnly(es)) quick.push(['own', '📚 Till hyllan']);
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
      <span class="author">${esc(b.authors)}${b.year ? ' · ' + esc(b.year) : ''}${b.series ? ` · <span class="series">${esc(seriesLabel(b))}</span>` : ''}</span>
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
    const label = `${avatar(m, 'avatar sm')}<span class="name">${e.audio ? '🎧 ' : ''}${esc(m.name)}</span>`;
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
  if (action === 'unown') {
    put('books', { ...b, owned: false });
    toast(`”${b.title}” borttagen ur bokhyllan`);
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
  f.genres.value = (d.genres || []).join(', ');
  f.series.value = d.series || '';
  f.series_no.value = d.series_no ?? '';
  $('#seriesList').innerHTML = [...new Set(Object.values(db.books).map((x) => x.series).filter(Boolean))]
    .sort((x, y) => x.localeCompare(y, 'sv')).map((x) => `<option value="${esc(x)}">`).join('');
  f.description.value = d.description || '';
  f.owned.checked = !!d.owned;
  editCover = d.cover || '';
  $('#coverPicker').hidden = true;
  $('#matchPanel').hidden = true;
  renderEditCover();
  loadSpineEdit(b);
  $('#deleteBtn').hidden = !b;

  drafts = {};
  for (const m of members()) {
    const e = b && db.entries[entryId(b.id, m.id)];
    drafts[m.id] = e
      ? { status: e.status, page: e.page, rating: e.rating || 0, notes: e.notes || '', audio: !!e.audio }
      : { status: '', page: null, rating: 0, notes: '', audio: !!prefill.audio };
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
  drafts[editMember] = { status: f.status.value, page: int(f.page.value), rating: editRating, notes: f.notes.value.trim(), audio: f.audio.checked };
}
function loadDraft() {
  const f = $('#editForm').elements;
  const d = drafts[editMember] || { status: '', page: null, rating: 0, notes: '', audio: false };
  f.status.value = d.status;
  f.audio.checked = !!d.audio;
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
    genres: f.genres.value.split(',').map((g) => g.trim()).filter(Boolean).slice(0, 5),
    description: f.description.value.trim(),
    series: f.series.value.trim() || null,
    series_no: (() => { const n = parseFloat(String(f.series_no.value).replace(',', '.')); return Number.isFinite(n) ? n : null; })(),
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
      audio: !!d.audio,
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

async function searchGoogle(q, lang = '') {
  const isbn = normIsbn(q);
  const query = isbn ? `isbn:${isbn}` : q;
  const data = await gfetch(`volumes?q=${encodeURIComponent(query)}&maxResults=15&printType=books${lang ? `&langRestrict=${lang}` : ''}`);
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
      genres: genresFrom(v.categories),
      gid: it.id,
      cover: googleImg(img),
    };
  });
}

async function searchOpenLibrary(q) {
  const isbn = normIsbn(q);
  const param = isbn ? `isbn=${isbn}` : `q=${encodeURIComponent(q)}`;
  const res = await fetch(`https://openlibrary.org/search.json?${param}&limit=15&fields=key,title,author_name,first_publish_year,isbn,cover_i,number_of_pages_median,subject`);
  if (!res.ok) throw new Error('openlibrary ' + res.status);
  const data = await res.json();
  return (data.docs || []).map((d) => ({
    title: d.title || '',
    authors: (d.author_name || []).join(', '),
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    isbn: isbn || d.isbn?.find((i) => i.length === 13) || d.isbn?.[0] || '',
    pages: d.number_of_pages_median || null,
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
    genres: olGenres(d.subject),
    olWork: d.key || '',
    source: 'openlibrary',
  }));
}

async function search(q) {
  const seq = ++searchSeq;
  const el = $('#results');
  if (q.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = '<p class="muted">Söker…</p>';
  // Alla källor samtidigt; en källa som inte svarar hoppas över.
  const safe = (pr) => pr.catch(() => []);
  const [google, googleSv, libris, ol] = await Promise.all([safe(searchGoogle(q)), safe(searchGoogle(q, 'sv')), safe(searchLibris(q)), safe(searchOpenLibrary(q))]);
  const results = mergeResults(q, [google, googleSv, libris, ol]);
  if (seq !== searchSeq) return;
  lastResults = results;
  if (!results.length) {
    el.innerHTML = '<p class="muted">Inga träffar. Du kan lägga till boken manuellt.</p>';
    return;
  }
  const note = googleOk() ? '' : '<p class="muted small">Google Books svarar inte just nu (gemensam dygnskvot slut) – visar träffar från LIBRIS och Open Library.</p>';
  el.innerHTML = note + results.map((r, i) => `<div class="result">
      ${coverHtml(r)}
      <div class="info">
        <span class="title">${esc(r.title)}</span>
        <span class="author">${esc(r.authors)}${r.year ? ' · ' + esc(r.year) : ''}${r.pages ? ` · ${r.pages} s.` : ''}${r.source === 'libris' ? ' · <span class="src">LIBRIS</span>' : ''}</span>
      </div>
      <div class="add">
        <button type="button" class="btn" data-i="${i}" data-to="reading">Läser</button>
        <button type="button" class="btn" data-i="${i}" data-to="shelf">Hyllan</button>
        <button type="button" class="btn" data-i="${i}" data-to="wishlist">Önskar</button>
      </div>
    </div>`).join('');
}

// ---------- LIBRIS (Kungliga bibliotekets katalog – i stort sett alla böcker utgivna i Sverige) ----------
const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
// "Lindgren, Astrid, 1907-2002" → "Astrid Lindgren"
function librisName(n) {
  const parts = String(n).split(',').map((x) => x.trim()).filter((x) => x && !/^\d{4}-?(\d{4})?\.?$/.test(x));
  return parts.length >= 2 ? `${parts[1]} ${parts[0]}` : parts[0] || '';
}
async function searchLibris(q) {
  const isbn = normIsbn(q);
  const query = isbn ? `NUMM:${isbn}` : q;
  const res = await fetch(`https://libris.kb.se/xsearch?query=${encodeURIComponent(query)}&format=json&format_level=full&n=25`);
  if (!res.ok) throw new Error('libris ' + res.status);
  const data = await res.json();
  return (data.xsearch?.list || [])
    .filter((r) => !r.type || /book|bok|text/i.test(first(r.type)))
    .map((r) => {
      const title = String(first(r.title)).split(' / ')[0].replace(/\s+:\s+/g, ': ').trim();
      const isbns = list(r.isbn).map((x) => normIsbn(String(x).split(' ')[0])).filter(Boolean);
      const pages = parseInt((String(first(r.extent)).match(/(\d+)\s*(s\.|sidor|p\.)/) || [])[1], 10) || null;
      return {
        title,
        authors: [...new Set(list(r.creator).map(librisName).filter(Boolean))].slice(0, 3).join(', '),
        year: (String(first(r.date)).match(/\d{4}/) || [''])[0],
        isbn: isbns.find((x) => x.length === 13) || isbns[0] || '',
        pages,
        cover: '',
        genres: [],
        source: 'libris',
      };
    })
    .filter((r) => r.title);
}

// Slå ihop träffar från flera källor: ta bort dubbletter (ISBN eller titel+efternamn),
// fyll i det som saknas från dubbletten och sortera efter hur väl träffen matchar sökningen.
const fold = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function mergeResults(q, sources) {
  const words = fold(q).split(' ').filter((w) => w.length > 1);
  const out = [];
  const byKey = new Map();
  sources.forEach((src, si) => src.forEach((r, ri) => {
    const last = fold((r.authors || '').split(',')[0]).split(' ').pop();
    const keys = [normIsbn(r.isbn || ''), `${fold(r.title).split(' ').slice(0, 6).join(' ')}|${last}`,
      `${fold(String(r.title).split(':')[0])}|${last}`].filter(Boolean);
    const hit = keys.map((k) => byKey.get(k)).find(Boolean);
    if (hit) {
      for (const f of ['cover', 'pages', 'year', 'isbn', 'gid', 'olWork', 'description']) if (!hit[f] && r[f]) hit[f] = r[f];
      if (!hit.genres?.length && r.genres?.length) hit.genres = r.genres;
      if (r.source === 'libris' && hit.source !== 'libris') { // svenska uppgifter vinner över Googles
        hit.title = r.title;
        hit.authors = r.authors || hit.authors;
        hit.source = 'libris';
      }
      keys.forEach((k) => byKey.set(k, hit));
      return;
    }
    const item = { ...r, order: si * 100 + ri };
    out.push(item);
    keys.forEach((k) => byKey.set(k, item));
  }));
  const score = (r) => {
    const hay = fold(`${r.title} ${r.authors}`);
    const t = fold(r.title);
    const found = words.filter((w) => hay.includes(w)).length / (words.length || 1);
    return found + (t.startsWith(fold(q)) ? 0.4 : 0) + (r.cover ? 0.15 : 0) + (r.isbn ? 0.05 : 0) - r.order / 2000;
  };
  return out.sort((a, b) => score(b) - score(a)).slice(0, 25);
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
      isbn: data.isbn || '', cover: data.cover || '', pages: data.pages || null, genres: data.genres || [], owned: false, added_at: today() };
    put('books', book);
  } else if ((!book.pages && data.pages) || (!book.cover && data.cover)) {
    book = { ...book, pages: book.pages || data.pages || null, cover: book.cover || data.cover || '' };
    put('books', book);
  }
  const name = db.members[memberId]?.name;
  if (to === 'reading' && $('#addOwned').checked && !$('#addAudio').checked && !book.owned) {
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
      ...(status === 'reading' && $('#addAudio').checked ? { audio: true } : {}),
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
    if (missingList().length) {
      syncError = `Databasen saknar ${missingList().join(', ')} – kör supabase/uppdatering-4.sql i Supabase (SQL Editor). Allt annat synkas.`;
      setSyncState('error');
    } else setSyncState(outbox.length ? 'pending' : 'ok');
  } catch (err) {
    console.warn('Synk misslyckades', err);
    // Visa det riktiga felet (med kod), så att det går att felsöka.
    const msg = err?.message || String(err);
    const code = err?.code ? ` [${err.code}]` : '';
    const detail = err?.details ? ` – ${err.details}` : '';
    syncError = err?.code === 'PGRST204' || /Could not find the '.+' column/.test(msg)
      ? `Databasen behöver uppdateras – kör supabase/uppdatering-4.sql i Supabase (SQL Editor). (${msg})`
      : `${msg}${detail}${code}`;
    setSyncState(navigator.onLine ? 'error' : 'offline');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

// Kolumner som inte får vara tomma i databasen: skicka ett standardvärde om raden saknar dem
// (t.ex. läsningar som skapades innan ljudboksfältet fanns).
const COLUMN_DEFAULTS = { books: { owned: false }, entries: { audio: false, rating: 0 } };
function toRow(table, row) {
  const out = { household_id: session.user.id };
  const defaults = COLUMN_DEFAULTS[table] || {};
  for (const c of COLUMNS[table]) out[c] = row[c] ?? defaults[c] ?? null;
  return out;
}

// Kolumner som databasen saknar (en uppdatering i supabase/ har inte körts än).
// De hoppas över så att resten synkar; värdena ligger kvar lokalt och skickas när kolumnen finns.
const missingCols = { members: new Set(), books: new Set(), entries: new Set() };
async function upsertRows(t, rows) {
  for (let i = 0; i < 8; i++) {
    const clean = rows.map((r) => { const o = { ...r }; for (const c of missingCols[t]) delete o[c]; return o; });
    const res = await sb.from(t).upsert(clean.length === 1 ? clean[0] : clean);
    const col = res.error?.code === 'PGRST204' && (res.error.message.match(/'([^']+)' column/) || [])[1];
    if (!col || missingCols[t].has(col)) return res;
    missingCols[t].add(col);
  }
  return { error: { message: 'För många saknade kolumner' } };
}
const hasMissingValues = (t, row) => [...missingCols[t]].some((c) => row?.[c] != null && row[c] !== '' && !(Array.isArray(row[c]) && !row[c].length));
const missingList = () => TABLES.flatMap((t) => [...missingCols[t]].map((c) => `${t}.${c}`));

async function flush() {
  if (!outbox.length) return;
  const snap = [...outbox];
  const drop = new Set();
  for (const t of TABLES) {
    const rows = snap.filter((o) => o.table === t && o.op === 'upsert' && db[t][o.id]).map((o) => toRow(t, db[t][o.id]));
    if (!rows.length) continue;
    const { error } = await upsertRows(t, rows);
    if (!error) continue;
    if (error.code !== '23503') throw error;
    // Främmande nyckel saknas (t.ex. boken togs bort på en annan enhet) – ta raderna en och en och släpp de trasiga.
    for (const r of rows) {
      const res = await upsertRows(t, [r]);
      if (res.error?.code === '23503') { drop.add(`${t}:${r.id}`); delete db[t][r.id]; } else if (res.error) throw res.error;
    }
  }
  for (const t of [...TABLES].reverse()) {
    const ids = snap.filter((o) => o.table === t && o.op === 'delete').map((o) => o.id);
    if (!ids.length) continue;
    const { error } = await sb.from(t).delete().in('id', ids);
    if (error) throw error;
  }
  // Rader med värden i saknade kolumner ligger kvar i kön tills databasen är uppdaterad.
  outbox = outbox.filter((o) => (!snap.includes(o) || (o.op === 'upsert' && hasMissingValues(o.table, db[o.table][o.id])))
    && !drop.has(`${o.table}:${o.id}`));
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
  for (const t of TABLES) for (const c of missingCols[t]) for (const [id, row] of Object.entries(fresh[t])) {
    if (db[t][id]?.[c] != null) row[c] = db[t][id][c];
  }
  // Ändringar som inte hunnit skickas ligger kvar ovanpå.
  for (const o of outbox) {
    if (o.op === 'upsert' && db[o.table][o.id]) fresh[o.table][o.id] = db[o.table][o.id];
    if (o.op === 'delete') delete fresh[o.table][o.id];
  }
  db = fresh;
  saveJSON(DB_KEY, db);
  render();
  setTimeout(autoCovers, 1000);
  setTimeout(autoMeta, 3000);
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
  renderDrivePanel();
  renderSyncPanel($('#syncBtn').title);
  renderFamily();
  const year = String(new Date().getFullYear());
  const perPerson = members().map((m) => {
    const n = Object.values(db.entries).filter((e) => e.member_id === m.id && e.status === 'read' && (e.finished_at || '').startsWith(year)).length;
    return `${m.name} ${n}`;
  }).join(', ');
  $('#stats').textContent = `${Object.keys(db.books).length} böcker totalt.` + (perPerson ? ` Lästa i år: ${perPerson}.` : '') + ` · Version ${APP_VERSION}`;
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
  const sp = e.target.closest('.spine, .lp');
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
  $('#addAudio').checked = false;
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
$('#addOwned').addEventListener('change', (e) => {
  localStorage.setItem('mina-bocker:add-owned', e.target.checked ? '1' : '0');
  if (e.target.checked) $('#addAudio').checked = false;
});
// Ljudbok = ingen fysisk kopia, så "Vi har den hemma" kryssas ur (utan att ändra det sparade valet).
$('#addAudio').addEventListener('change', (e) => {
  $('#addOwned').checked = e.target.checked ? false : localStorage.getItem('mina-bocker:add-owned') === '1';
});
$('#manualBtn').addEventListener('click', () => {
  const q = $('#q').value.trim();
  const forId = $('#addFor').value || me;
  $('#addDialog').close();
  openEdit(null, forId, { ...(normIsbn(q) ? { isbn: q } : { title: q }), ...($('#addOwned').checked && !$('#addAudio').checked ? { owned: true } : {}),
    ...($('#addAudio').checked ? { audio: true } : {}) });
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
  if (player.bookId === b.id) stopPlayer();
  audioDelete(b.id).catch(() => {});
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
      for (const it of (await gfetch(`volumes?q=${encodeURIComponent(q)}&maxResults=12`)).items || []) {
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
// Tjocklek: egen tjocklek i cm om den är ifylld, annars proportionell mot antal sidor
// (400 sidor blir dubbelt så tjock som 200). 1 cm räknas som ca 160 sidor.
// Fotad rygg: fotots form behålls alltid (sträcks aldrig) – höjden anpassas efter tjockleken,
// högst hyllans höjd. Fylls både höjd och tjocklek i används de som de är.
const PX_PER_PAGE = 0.1;
const SPINE_MAX_H = 184, SPINE_MIN_H = 100;
function spineSize(b) {
  const s = b.spine || {};
  let h = s.h ? s.h * 7.5 : 148 + (hashStr(b.id || b.title) % 36);
  let w = s.w ? s.w * 160 * PX_PER_PAGE : (b.pages || 280) * PX_PER_PAGE;
  if (s.img && s.ratio > 0 && !(s.h && s.w)) {
    if (s.h) w = h * s.ratio;           // bara höjd ifylld: tjockleken följer fotot
    else {
      h = w / s.ratio;                  // höjden följer fotot
      if (h > SPINE_MAX_H) { h = SPINE_MAX_H; w = h * s.ratio; }
      if (h < SPINE_MIN_H) { h = SPINE_MIN_H; w = h * s.ratio; }
    }
  }
  h = Math.max(90, Math.min(SPINE_MAX_H, Math.round(h)));
  w = Math.max(5, Math.min(100, Math.round(w * 2) / 2));
  return { w, h };
}
// Ljudbok som LP-skiva: kvadratiskt omslag med en vinylskiva som sticker ut (etiketten i omslagets färg).
function record(b) {
  const listeners = entriesOf(b.id).filter((e) => e.audio).map((e) => db.members[e.member_id]);
  const color = spineColor(b);
  return `<div class="lp-slot"><button type="button" class="lp" data-id="${esc(b.id)}" style="--sc:${esc(color)}"
      title="${esc(b.title)}${b.authors ? ' – ' + esc(b.authors) : ''}">
    <span class="lp-disc" aria-hidden="true"><span class="lp-label"></span></span>
    <span class="lp-sleeve">${coverHtml(b, 'cover lp-cover')}</span>
    ${listeners.length ? `<span class="lp-marks">${listeners.map((m) => avatar(m, 'avatar sm')).join('')}</span>` : ''}
    ${localAudio.has(b.id) ? '<span class="lp-local" title="Ljudfiler på enheten">▶</span>' : ''}
  </button></div>`;
}
function spine(b, audio = false) {
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
    ${audio ? '<span class="sp-audio" aria-hidden="true">🎧</span>' : ''}
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
      document.querySelectorAll('.spine, .lp').forEach((el) => {
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
  if (localAudio.has(id)) tags.push('🎧 Ljudfiler på enheten');
  if (driveBooks?.has(id)) tags.push(`☁️ I Google Drive (${fmtBytes(driveBooks.get(id).size)})`);
  $('#bvTags').innerHTML = tags.map((t) => `<span class="tag">${t}</span>`).join('') +
    (b.series ? `<span class="tag">📚 ${esc(seriesLabel(b))}</span>` : '') +
    (b.genres || []).map((g) => `<span class="tag genre">${esc(g)}</span>`).join('');
  $('#bvDesc').innerHTML = b.description
    ? `<h3>Baksidan</h3><p class="desc clamp">${esc(b.description)}</p>${b.description.length > 320 ? '<button type="button" class="link-btn" data-more>Visa mer</button>' : ''}`
    : '';
  const es = entriesOf(id);
  $('#bvFamily').innerHTML = es.length ? `<h3>Familjen</h3>${whoRows(es, b)}` : '';
  $('#bvNotes').innerHTML = es.filter((e) => e.notes).map((e) =>
    `<p class="note"><b>${esc(db.members[e.member_id].name)}:</b> ${esc(e.notes)}</p>`).join('');
  const t = target();
  const mine = t && db.entries[entryId(id, t)];
  const forName = t && t !== me ? ` (${esc(db.members[t].name)})` : '';
  const acts = [];
  if (localAudio.has(id)) acts.push('<button type="button" class="btn primary" data-bv="listen">▶ Lyssna</button>');
  if (localEpubs.has(id)) acts.push('<button type="button" class="btn primary" data-bv="read">📖 Läs</button>');
  if (t && mine?.status !== 'reading') acts.push(`<button type="button" class="btn" data-bv="start">▶ Börja läsa${forName}</button>`);
  if (mine?.status === 'reading') acts.push(`<button type="button" class="btn" data-bv="progress">Hur långt?${forName}</button>`);
  acts.push('<span class="spacer"></span>');
  if (b.owned) acts.push('<button type="button" class="btn" data-bv="spine" title="Fota bokryggen">📷 Rygg</button>');
  acts.push(localEpubs.has(id)
    ? '<button type="button" class="link-btn" data-bv="rmepub">Ta bort epub</button>'
    : '<button type="button" class="btn" data-bv="epub">＋ Epub</button>');
  acts.push(localAudio.has(id)
    ? '<button type="button" class="link-btn" data-bv="rmaudio">Ta bort ljudfiler</button>'
    : '<button type="button" class="btn" data-bv="addaudio">＋ Ljudfiler</button>');
  if (driveOn()) {
    const inDrive = driveBooks?.has(id);
    if (localAudio.has(id) && !inDrive) acts.push('<button type="button" class="btn" data-bv="driveup">☁️ Spara i Drive</button>');
    if (!localAudio.has(id) && inDrive) acts.unshift('<button type="button" class="btn primary" data-bv="driveget">⬇ Hämta från Drive</button>');
  }
  if (!b.owned) acts.push(`<button type="button" class="btn" data-bv="own">📚 ${isAudioOnly(es) ? 'Vi har den som bok' : 'Till hyllan'}</button>`);
  else acts.push('<button type="button" class="link-btn" data-bv="unown">Ta bort ur hyllan</button>');
  acts.push('<button type="button" class="btn" data-bv="match" title="Hämta sidor, genre, år och omslag">🔄 Uppgifter</button>');
  acts.push('<button type="button" class="btn" data-bv="edit">✎ Redigera</button>');
  $('#bvActions').innerHTML = acts.join('');
  if (!$('#bookDialog').open) $('#bookDialog').showModal();
}

// ---------- Epub-filer (sparas lokalt per enhet i IndexedDB) ----------
let localEpubs = new Set();
let idbPromise = null;
function idb() {
  return idbPromise ||= new Promise((res, rej) => {
    const r = indexedDB.open('mina-bocker-filer', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('epubs')) d.createObjectStore('epubs', { keyPath: 'bookId' });
      if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'key' }).createIndex('bookId', 'bookId');
    };
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
  const more = e.target.closest('[data-more]');
  if (more) { const d = $('#bvDesc .desc'); d.classList.toggle('clamp'); more.textContent = d.classList.contains('clamp') ? 'Visa mer' : 'Visa mindre'; return; }
  const btn = e.target.closest('[data-bv]');
  if (!btn) return;
  const id = viewBookId;
  const a = btn.dataset.bv;
  if (a === 'read') openReader(id);
  if (a === 'listen') { $('#bookDialog').close(); playAudioBook(id).then(openPlayerView); }
  if (a === 'addaudio') $('#bvAudioFile').click();
  if (a === 'driveup') { getDriveToken().catch(() => {}); uploadToDrive(id); }
  if (a === 'driveget') { getDriveToken().catch(() => {}); downloadFromDrive(id); }
  if (a === 'rmaudio' && confirm('Ta bort ljudfilerna från den här enheten? Boken ligger kvar.')) {
    if (player.bookId === id) stopPlayer();
    await audioDelete(id).catch(() => {});
    localStorage.removeItem(posKey(id));
    render();
  }
  if (a === 'spine') openSpinePhoto(({ img, ratio }) => {
    const cur = db.books[id];
    if (!cur) return;
    put('books', { ...cur, spine: { ...(cur.spine || {}), img, ratio } });
    commit();
    toast('Bokryggen sparad');
  });
  if (a === 'start') quickAction(id, 'start');
  if (a === 'own') quickAction(id, 'own');
  if (a === 'unown') quickAction(id, 'unown');
  if (a === 'progress') openProgress(entryId(id, target()));
  if (a === 'epub') $('#bvEpubFile').click();
  if (a === 'edit') { $('#bookDialog').close(); openEdit(id); }
  if (a === 'match') { $('#bookDialog').close(); openEdit(id); openMatch(); }
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
  const H = Math.min(480, Math.round(long));
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
  const res = { img: out.toDataURL('image/jpeg', 0.8), ratio: Math.round((out.width / out.height) * 1000) / 1000 };
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

// ---------- Genre och stämning ----------
const GENRE_SV = {
  'fiction': 'Skönlitteratur', 'literary': 'Skönlitteratur', 'general': null,
  'science fiction': 'Science fiction', 'time travel': 'Science fiction', 'space opera': 'Science fiction', 'dystopian': 'Dystopi',
  'fantasy': 'Fantasy', 'epic': 'Fantasy', 'thrillers': 'Thriller', 'suspense': 'Thriller', 'mystery & detective': 'Deckare',
  'crime': 'Deckare', 'romance': 'Romantik', 'horror': 'Skräck', 'historical': 'Historisk roman', 'action & adventure': 'Äventyr',
  'war & military': 'Krig', 'humorous': 'Humor', 'humor': 'Humor', 'biography & autobiography': 'Biografi', 'history': 'Historia',
  'self-help': 'Självhjälp', 'business & economics': 'Ekonomi', 'psychology': 'Psykologi', 'science': 'Vetenskap',
  'juvenile fiction': 'Barn & unga', 'young adult fiction': 'Barn & unga', 'juvenile nonfiction': 'Barn & unga',
  'comics & graphic novels': 'Serier', 'cooking': 'Mat', 'health & fitness': 'Hälsa', 'philosophy': 'Filosofi',
  'religion': 'Religion', 'political science': 'Samhälle', 'social science': 'Samhälle', 'true crime': 'True crime',
  'travel': 'Resor', 'sports & recreation': 'Sport', 'family & relationships': 'Relationer', 'body, mind & spirit': 'Andlighet',
  'poetry': 'Poesi', 'drama': 'Drama', 'art': 'Konst', 'music': 'Musik', 'nature': 'Natur', 'technology & engineering': 'Teknik',
  'computers': 'Teknik', 'education': 'Utbildning', 'medical': 'Hälsa', 'mathematics': 'Vetenskap', 'literary criticism': 'Litteratur',
};
const FICTION_ROOTS = ['fiction', 'juvenile fiction', 'young adult fiction'];
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// Google Books-kategorier ("Fiction / Science Fiction / Time Travel") → svenska genrer
function genresFrom(categories) {
  const out = [];
  const add = (g) => { if (g && !out.includes(g)) out.push(g); };
  for (const c of categories || []) {
    const parts = String(c).split('/').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) continue;
    if (FICTION_ROOTS.includes(parts[0])) {
      if (parts[0] !== 'fiction') add('Barn & unga');
      const sub = parts.slice(1).map((x) => GENRE_SV[x]).find(Boolean);
      add(sub || (parts[0] === 'fiction' ? 'Skönlitteratur' : null));
    } else {
      add(GENRE_SV[parts[0]] === undefined ? cap(parts[0]) : GENRE_SV[parts[0]]);
    }
  }
  return out.slice(0, 3);
}

const MOODS_SV = {
  adventurous: 'Äventyrlig', moving: 'Gripande', funny: 'Rolig', dark: 'Mörk', emotional: 'Känslosam', hopeful: 'Hoppfull',
  informative: 'Lärorik', inspiring: 'Inspirerande', lighthearted: 'Lättsam', mysterious: 'Mystisk', reflective: 'Eftertänksam',
  relaxing: 'Avkopplande', sad: 'Sorglig', tense: 'Spännande', challenging: 'Utmanande',
};
const moodSv = (m) => MOODS_SV[String(m).toLowerCase()] || cap(String(m));

// ---------- Bokuppgifter från flera källor ----------
// Google Books utan egen nyckel delar en gemensam dygnskvot med alla andra, som ofta tar slut (svar 429).
// Därför: egen nyckel i config.js om den finns, paus mot Google när kvoten är slut,
// och LIBRIS + Open Library som fullvärdiga källor.
let googleBlockedUntil = 0;
let googleQuotaNoted = false;
async function gfetch(path) {
  if (Date.now() < googleBlockedUntil) throw new Error('google-kvot');
  const u = new URL('https://www.googleapis.com/books/v1/' + path);
  const key = (window.BOOKS_CONFIG || {}).googleBooksKey;
  if (key) u.searchParams.set('key', key);
  const r = await fetch(u);
  if (r.status === 429 || r.status === 403) {
    googleBlockedUntil = Date.now() + 15 * 60 * 1000;
    if (!googleQuotaNoted) {
      googleQuotaNoted = true;
      console.warn('Google Books: kvoten är slut', r.status);
    }
    throw new Error('google-kvot');
  }
  if (!r.ok) throw new Error('google ' + r.status);
  return r.json();
}
const googleOk = () => Date.now() >= googleBlockedUntil;

async function googleDetail(gid) {
  try { return (await gfetch(`volumes/${encodeURIComponent(gid)}`)).volumeInfo || null; } catch { return null; }
}

// Text från Google innehåller HTML. DOMParser kör inga skript och laddar inga bilder.
function cleanText(html) {
  if (!html) return '';
  const src = String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*/gi, '\n\n');
  const text = new DOMParser().parseFromString(src, 'text/html').body.textContent || '';
  return text
    .split(/\n-{4,}/)[0]                       // Open Library: källhänvisningar efter en linje
    .replace(/\(\[[^\]]*\]\[\d+\]\)/g, '')     // Open Library: ([källa][1])
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 5000);
}

async function olByIsbn(isbn) {
  try {
    const r = await fetch(`https://openlibrary.org/isbn/${isbn}.json`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function olDescription(workKey) {
  try {
    const r = await fetch(`https://openlibrary.org${workKey}.json`);
    if (!r.ok) return '';
    const d = (await r.json()).description;
    return cleanText(typeof d === 'string' ? d : d?.value);
  } catch { return ''; }
}
// Open Library-ämnen ("Science fiction", "Fantasy fiction", …) → våra genrer
function olGenres(subjects) {
  const out = [];
  for (const s of (subjects || []).slice(0, 20)) {
    const low = String(s).toLowerCase();
    for (const [k, v] of Object.entries(GENRE_SV)) {
      if (!v || k === 'fiction' || k === 'general' || k === 'literary') continue;
      if ((low === k || low.startsWith(k + ' ') || low.endsWith(' ' + k)) && !out.includes(v)) out.push(v);
    }
  }
  return out.slice(0, 3);
}
const similar = (a, b) => { const x = fold(a), y = fold(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };

function fillMissing(m, x) {
  for (const [k, v] of Object.entries(x || {})) {
    const empty = m[k] == null || m[k] === '' || (Array.isArray(m[k]) && !m[k].length);
    const has = v != null && v !== '' && !(Array.isArray(v) && !v.length);
    if (empty && has) m[k] = v;
  }
}

// Samla uppgifter om en bok: Google (om kvoten räcker) → LIBRIS → Open Library.
async function fetchMeta(seed) {
  const m = { ...seed, genres: seed.genres || [] };
  const isbn = normIsbn(m.isbn || '');
  const author = (m.authors || '').split(',')[0].trim();
  const short = (m.title || '').split(/\s*:\s*/)[0].trim();
  const need = () => !m.pages || !m.genres.length || !m.description || !m.year;

  if (need() && googleOk()) {
    try {
      let gid = m.gid;
      if (!gid) {
        for (const q of [isbn && `isbn:${isbn}`, short && `intitle:${short}${author ? ` inauthor:${author}` : ''}`].filter(Boolean)) {
          const items = (await gfetch(`volumes?q=${encodeURIComponent(q)}&maxResults=5`)).items || [];
          const hit = items.find((it) => it.volumeInfo?.pageCount && (isbn || similar(it.volumeInfo.title, short))) || (isbn ? items[0] : null);
          if (hit) { gid = hit.id; break; }
        }
      }
      const v = gid ? await googleDetail(gid) : null;
      if (v) {
        const ids = v.industryIdentifiers || [];
        fillMissing(m, {
          pages: v.pageCount || v.printedPageCount, genres: genresFrom(v.categories), year: (v.publishedDate || '').slice(0, 4),
          description: cleanText(v.description), cover: googleImg(v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail),
          isbn: ids.find((i) => i.type === 'ISBN_13')?.identifier || '',
        });
      }
    } catch { /* kvoten slut eller ingen träff – nästa källa */ }
  }
  if (!m.pages || !m.year) {
    try {
      const hit = (await searchLibris(isbn || `${short} ${author}`)).find((r) => (isbn || similar(r.title, short)) && (r.pages || r.year));
      if (hit) fillMissing(m, { pages: hit.pages, year: hit.year, isbn: hit.isbn, description: hit.description });
    } catch { /* LIBRIS svarar inte */ }
  }
  if (need()) {
    let work = m.olWork;
    if (isbn) {
      const ed = await olByIsbn(isbn);
      if (ed) {
        fillMissing(m, { pages: ed.number_of_pages });
        work = work || ed.works?.[0]?.key;
        const sr = Array.isArray(ed.series) ? ed.series[0] : ed.series;
        if (sr && !m.series) { const ps = parseSeriesText(sr); fillMissing(m, { series: ps.name, series_no: ps.no }); }
      }
    }
    if (!m.pages || !m.genres.length || !work) {
      try {
        const d = (await searchOpenLibrary(`${short} ${author}`.trim())).find((r) => similar(r.title, short));
        if (d) { fillMissing(m, { pages: d.pages, genres: d.genres, year: d.year, cover: d.cover }); work = work || d.olWork; }
      } catch { /* Open Library svarar inte */ }
    }
    if (!m.description && work) fillMissing(m, { description: await olDescription(work) });
  }
  return m;
}

// Fyll i sidantal, genre, år och baksidestext i bakgrunden för böcker som saknar det.
const META_TRIED_KEY = 'mina-bocker:meta-tried-2';
let autoMetaRunning = false;
async function autoMeta() {
  if (autoMetaRunning || !navigator.onLine) return;
  autoMetaRunning = true;
  try {
    const tried = new Set(loadJSON(META_TRIED_KEY, []));
    const todo = Object.values(db.books).filter((b) => (!b.pages || !b.genres?.length || !b.description) && !tried.has(b.id)).slice(0, 12);
    for (const b of todo) {
      if (!navigator.onLine) break;
      const m = await fetchMeta(b);
      tried.add(b.id);
      saveJSON(META_TRIED_KEY, [...tried]);
      const cur = db.books[b.id];
      if (!cur) continue;
      const upd = { ...cur };
      fillMissing(upd, { pages: m.pages, genres: m.genres, year: m.year, description: m.description, isbn: m.isbn });
      if (['pages', 'genres', 'year', 'description', 'isbn'].some((k) => JSON.stringify(upd[k] ?? null) !== JSON.stringify(cur[k] ?? null))) {
        put('books', upd);
        commit();
      }
    }
  } finally {
    autoMetaRunning = false;
  }
}

// ---------- Statistik ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
let statsYear = String(new Date().getFullYear());
let statsWho = null;

function openStats() {
  statsWho = who;
  $('#statsView').hidden = false;
  document.body.classList.add('reading-mode');
  renderStats();
  $('#statsView').scrollTop = 0;
}
function closeStats() {
  $('#statsView').hidden = true;
  document.body.classList.remove('reading-mode');
  $('#vizTip').hidden = true;
}

function renderStats() {
  if ($('#statsView').hidden) return;
  const ms = members();
  if (statsWho !== 'all' && !db.members[statsWho]) statsWho = ms.length > 1 ? 'all' : me;
  const readAll = Object.values(db.entries).filter((e) => e.status === 'read' && db.books[e.book_id] && db.members[e.member_id]
    && (statsWho === 'all' || e.member_id === statsWho));
  const years = [...new Set([String(new Date().getFullYear()), ...readAll.map((e) => (e.finished_at || '').slice(0, 4)).filter(Boolean)])].sort().reverse();
  if (!years.includes(statsYear)) statsYear = years[0];

  $('#statsYears').innerHTML = years.map((y) => `<button type="button" class="chip all" data-year="${y}" aria-pressed="${y === statsYear}">${y}</button>`).join('');
  $('#statsPeople').hidden = ms.length < 2;
  $('#statsPeople').innerHTML = `<button type="button" class="chip all" data-swho="all" aria-pressed="${statsWho === 'all'}">Familjen</button>` +
    ms.map((m) => `<button type="button" class="chip" data-swho="${esc(m.id)}" aria-pressed="${statsWho === m.id}">${avatar(m)}${esc(m.name)}</button>`).join('');

  const read = readAll.filter((e) => (e.finished_at || '').startsWith(statsYear));
  const undated = readAll.filter((e) => !e.finished_at).length;
  const who1 = statsWho === 'all' ? 'Familjen har' : (statsWho === me ? 'Du har' : `${db.members[statsWho]?.name} har`);
  const body = $('#statsBody');
  if (!read.length) {
    body.innerHTML = `<div class="empty"><div class="big">📊</div><p>${esc(who1)} inte läst ut någon bok ${statsYear} ännu.</p>
      ${undated ? `<p class="muted">${undated} lästa böcker saknar datum – sätt datum under Redigera så räknas de med.</p>` : ''}</div>`;
    return;
  }
  const bookOf = (e) => db.books[e.book_id];
  const pages = read.reduce((sum, e) => sum + (bookOf(e).pages || 0), 0);
  const audio = read.filter((e) => e.audio).length;
  const rated = read.filter((e) => e.rating);
  const avg = rated.length ? rated.reduce((s, e) => s + e.rating, 0) / rated.length : null;
  const uniq = new Set(read.map((e) => e.book_id)).size;

  // Per månad
  const perMonth = MONTHS.map(() => 0);
  for (const e of read) perMonth[+e.finished_at.slice(5, 7) - 1]++;
  const maxM = Math.max(...perMonth);
  const isThisYear = statsYear === String(new Date().getFullYear());
  const monthsSoFar = isThisYear ? new Date().getMonth() + 1 : 12;

  // Genre, stämning, författare
  const count = (arr) => { const m = new Map(); for (const k of arr) m.set(k, (m.get(k) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'sv')); };
  const genres = count(read.flatMap((e) => bookOf(e).genres || []));
  const noGenre = read.filter((e) => !(bookOf(e).genres || []).length).length;
  const moods = count(read.flatMap((e) => (bookOf(e).moods || []).map(moodSv)));
  const authors = count(read.map((e) => (bookOf(e).authors || '').split(',')[0].trim()).filter(Boolean)).filter(([, n]) => n > 1).slice(0, 5);
  const withPages = read.filter((e) => bookOf(e).pages).sort((a, b) => bookOf(b).pages - bookOf(a).pages);
  const favorite = [...rated].sort((a, b) => b.rating - a.rating || (b.finished_at || '').localeCompare(a.finished_at || ''))[0];

  const tile = (value, label, sub = '') => `<div class="tile"><div class="tile-v">${value}</div><div class="tile-l">${label}</div>${sub ? `<div class="tile-s">${sub}</div>` : ''}</div>`;
  const fmt = (n) => n.toLocaleString('sv-SE');
  const bookLine = (e, extra) => { const b = bookOf(e); return `<button type="button" class="hl" data-book="${esc(b.id)}">${coverHtml(b)}<span><b>${esc(b.title)}</b><br><span class="muted">${esc(b.authors || '')}${extra ? ' · ' + extra : ''}</span></span></button>`; };

  let html = `<section class="hero">
      <div class="hero-n">${read.length}</div>
      <div class="hero-t">${read.length === 1 ? 'bok läst' : 'böcker lästa'} ${statsYear}</div>
      <div class="hero-s">${esc(who1)} läst ${fmt(pages)} sidor${statsWho === 'all' && uniq !== read.length ? ` · ${uniq} olika titlar` : ''}</div>
    </section>
    <div class="tiles">
      ${tile(fmt(pages), 'sidor', withPages.length < read.length ? `${read.length - withPages.length} utan sidantal` : '')}
      ${tile((read.length / monthsSoFar).toLocaleString('sv-SE', { maximumFractionDigits: 1 }), 'böcker/månad')}
      ${tile(avg ? avg.toLocaleString('sv-SE', { maximumFractionDigits: 1 }) + ' ★' : '–', 'snittbetyg', rated.length ? `${rated.length} betygsatta` : '')}
      ${tile(audio, 'ljudböcker', `${read.length - audio} lästa`)}
    </div>

    <section class="card-s"><h3>Per månad</h3>
      <div class="months" role="img" aria-label="Lästa böcker per månad ${statsYear}">
        ${perMonth.map((n, i) => `<div class="m-col" data-tip="${MONTHS[i]}: ${n} ${n === 1 ? 'bok' : 'böcker'}">
          <span class="m-val">${n && n === maxM ? n : ''}</span>
          <span class="m-bar" style="height:${maxM ? (n / maxM) * 100 : 0}%"></span>
          <span class="m-lab">${MONTHS[i][0].toUpperCase()}</span></div>`).join('')}
      </div>
      <table class="sr-only"><caption>Lästa böcker per månad</caption><tr>${MONTHS.map((m) => `<th>${m}</th>`).join('')}</tr><tr>${perMonth.map((n) => `<td>${n}</td>`).join('')}</tr></table>
    </section>`;

  if (genres.length) {
    const maxG = genres[0][1];
    html += `<section class="card-s"><h3>Genrer</h3><div class="hbars">
      ${genres.slice(0, 8).map(([g, n]) => `<div class="hb" data-tip="${esc(g)}: ${n} ${n === 1 ? 'bok' : 'böcker'}">
        <span class="hb-l">${esc(g)}</span><span class="hb-track"><span class="hb-bar" style="width:${(n / maxG) * 100}%"></span></span><span class="hb-n">${n}</span></div>`).join('')}
      </div>${noGenre ? `<p class="muted small">${noGenre} ${noGenre === 1 ? 'bok' : 'böcker'} saknar genre – lägg till under Redigera.</p>` : ''}</section>`;
  }
  if (moods.length) {
    html += `<section class="card-s"><h3>Stämning</h3><div class="mood-cloud">
      ${moods.map(([m, n]) => `<span class="mood">${esc(m)} <b>${n}</b></span>`).join('')}</div></section>`;
  }
  const hl = [];
  if (favorite) hl.push(`<div><h4>Högst betyg</h4>${bookLine(favorite, starStr(favorite.rating))}</div>`);
  if (withPages.length) hl.push(`<div><h4>Längsta</h4>${bookLine(withPages[0], `${withPages[0] && bookOf(withPages[0]).pages} sidor`)}</div>`);
  if (withPages.length > 1) { const s = withPages[withPages.length - 1]; hl.push(`<div><h4>Kortaste</h4>${bookLine(s, `${bookOf(s).pages} sidor`)}</div>`); }
  if (hl.length) html += `<section class="card-s highlights">${hl.join('')}</section>`;
  if (authors.length) {
    html += `<section class="card-s"><h3>Favoritförfattare</h3><ol class="authors">${authors.map(([a, n]) => `<li><span>${esc(a)}</span><span class="muted">${n} böcker</span></li>`).join('')}</ol></section>`;
  }
  if (statsWho === 'all' && ms.length > 1) {
    const per = ms.map((m) => [m, read.filter((e) => e.member_id === m.id)]).sort((a, b) => b[1].length - a[1].length);
    const maxP = Math.max(1, ...per.map(([, l]) => l.length));
    html += `<section class="card-s"><h3>Familjen</h3><div class="hbars">
      ${per.map(([m, l]) => `<div class="hb" data-tip="${esc(m.name)}: ${l.length} böcker, ${fmt(l.reduce((s, e) => s + (bookOf(e).pages || 0), 0))} sidor">
        <span class="hb-l">${avatar(m, 'avatar sm')} ${esc(m.name)}</span><span class="hb-track"><span class="hb-bar" style="width:${(l.length / maxP) * 100}%"></span></span><span class="hb-n">${l.length}</span></div>`).join('')}
      </div></section>`;
  }
  const sorted = [...read].sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || ''));
  html += `<section class="card-s"><h3>Alla lästa ${statsYear}</h3><div class="cover-grid">
    ${sorted.map((e) => `<button type="button" class="cg" data-book="${esc(e.book_id)}" title="${esc(bookOf(e).title)}">${coverHtml(bookOf(e))}${e.audio ? '<span class="cg-a">🎧</span>' : ''}</button>`).join('')}
    </div></section>`;
  if (undated) html += `<p class="muted small center">${undated === 1 ? '1 läst bok saknar' : `${undated} lästa böcker saknar`} datum och räknas inte in här – sätt datum under Redigera.</p>`;
  body.innerHTML = html;
}

// Tooltip för diagrammen (mus och tryck)
function showTip(el, x, y) {
  const tip = $('#vizTip');
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width / 2))}px`;
  tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
}
$('#statsView').addEventListener('pointerover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (el) showTip(el, e.clientX, e.clientY); else $('#vizTip').hidden = true;
});
$('#statsView').addEventListener('pointermove', (e) => {
  const el = e.target.closest('[data-tip]');
  if (el && !$('#vizTip').hidden) showTip(el, e.clientX, e.clientY);
});
$('#statsView').addEventListener('scroll', () => { $('#vizTip').hidden = true; });
$('#statsView').addEventListener('click', (e) => {
  const y = e.target.closest('[data-year]');
  if (y) { statsYear = y.dataset.year; renderStats(); return; }
  const w = e.target.closest('[data-swho]');
  if (w) { statsWho = w.dataset.swho; renderStats(); return; }
  const b = e.target.closest('[data-book]');
  if (b) { openBook(b.dataset.book); return; }
  const tipEl = e.target.closest('[data-tip]');
  if (tipEl) showTip(tipEl, e.clientX, e.clientY);
});
$('#statsBtn').addEventListener('click', openStats);
$('#statsClose').addEventListener('click', closeStats);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#statsView').hidden && !document.querySelector('dialog[open]')) closeStats(); });

// ---------- Hämta uppgifter (matcha boken mot Google Books och LIBRIS) ----------
let matchResults = [];


async function openMatch() {
  const el = $('#matchPanel');
  const f = $('#editForm').elements;
  const title = f.title.value.trim();
  const author = f.authors.value.split(',')[0].trim();
  const isbn = normIsbn(f.isbn.value);
  if (!title && !isbn) { toast('Skriv en titel först'); return; }
  el.hidden = false;
  el.innerHTML = '<p class="muted">Söker i Google Books, LIBRIS och Open Library…</p>';
  el.scrollIntoView({ block: 'nearest' });
  const q = `${title.split(/\s*:\s*/)[0]} ${author}`.trim();
  const safe = (pr) => pr.catch(() => []);
  const searches = [safe(searchGoogle(q)), safe(searchGoogle(q, 'sv')), safe(searchLibris(q)), safe(searchOpenLibrary(q))];
  if (isbn) searches.unshift(safe(searchGoogle(isbn)), safe(searchLibris(isbn)), safe(searchOpenLibrary(isbn)));
  matchResults = mergeResults(q, await Promise.all(searches)).slice(0, 8);
  if (el.hidden) return;
  if (!matchResults.length) {
    el.innerHTML = '<p class="muted">Hittade ingen träff. Prova att ändra titeln eller fylla i ISBN och tryck igen.</p>';
    return;
  }
  el.innerHTML = `<div class="match-head"><b>Välj rätt utgåva</b><button type="button" class="link-btn" data-match-close>Stäng</button></div>
    ${matchResults.map((r, i) => `<button type="button" class="match-item" data-match="${i}">
      ${coverHtml(r)}
      <span class="info">
        <span class="title">${esc(r.title)}</span>
        <span class="author">${esc(r.authors)}${r.year ? ' · ' + esc(r.year) : ''}</span>
        <span class="muted small">${[r.pages ? `${r.pages} s.` : '', (r.genres || []).join(', '), r.isbn ? `ISBN ${r.isbn}` : '', r.source === 'libris' ? 'LIBRIS' : ''].filter(Boolean).join(' · ') || 'Få uppgifter'}</span>
      </span></button>`).join('')}`;
}

async function applyMatch(r) {
  const el = $('#matchPanel');
  el.innerHTML = '<p class="muted">Hämtar uppgifter…</p>';
  // Exakta genrer och baksidestext finns på källornas detaljsidor, så sökträffens genrer får vänta.
  const m = await fetchMeta({ ...r, genres: [], description: '' });
  if (!m.genres.length) m.genres = r.genres || [];
  const f = $('#editForm').elements;
  const changed = [];
  const set = (field, val, label, allowed = true) => {
    if (val && allowed && String(f[field].value).trim() !== String(val)) { f[field].value = val; changed.push(label); }
  };
  set('pages', m.pages, 'sidor');
  if (m.genres.length) set('genres', m.genres.join(', '), 'genre');
  set('year', m.year, 'år');
  set('isbn', m.isbn, 'ISBN');
  set('authors', m.authors, 'författare', !f.authors.value.trim());
  set('description', m.description, 'baksidestext', !f.description.value.trim());
  set('series', m.series, 'serie', !f.series.value.trim());
  if (m.series_no != null) set('series_no', m.series_no, 'nr i serien', !String(f.series_no.value).trim());
  if (m.cover && !editCover) { editCover = m.cover; changed.push('omslag'); }
  renderEditCover();
  if ($('#spineEdit').open) renderSpinePreview();
  el.hidden = true;
  // Spara direkt på en befintlig bok, så att uppgifterna inte går förlorade om man stänger.
  const cur = db.books[editBookId];
  if (cur && changed.length) {
    put('books', { ...cur, pages: int(f.pages.value), year: f.year.value.trim(), isbn: f.isbn.value.trim(), authors: f.authors.value.trim(),
      genres: f.genres.value.split(',').map((g) => g.trim()).filter(Boolean).slice(0, 5), description: f.description.value.trim(), cover: editCover,
      series: f.series.value.trim() || null, series_no: num(f.series_no.value) });
    commit();
  }
  const quota = !googleOk() ? ' (Google Books är tillfälligt otillgängligt)' : '';
  toast(changed.length ? `Sparat: ${changed.join(', ')}` : `Hittade inga fler uppgifter för den här utgåvan${quota}`);
}

$('#matchBtn').addEventListener('click', () => { if ($('#matchPanel').hidden) openMatch(); else $('#matchPanel').hidden = true; });
$('#matchPanel').addEventListener('click', (e) => {
  if (e.target.closest('[data-match-close]')) { $('#matchPanel').hidden = true; return; }
  const btn = e.target.closest('[data-match]');
  if (btn) applyMatch(matchResults[+btn.dataset.match]);
});

// Alla böcker: kör bakgrundshämtningen igen för allt som saknar sidor, genre eller omslag.
$('#metaAllBtn').addEventListener('click', async () => {
  const missing = Object.values(db.books).filter((b) => !b.pages || !b.genres?.length || !b.cover || !b.description);
  if (!missing.length) { toast('Alla böcker har redan sidor, genre och omslag'); return; }
  const ids = new Set(missing.map((b) => b.id));
  saveJSON(META_TRIED_KEY, loadJSON(META_TRIED_KEY, []).filter((id) => !ids.has(id)));
  saveJSON(COVER_TRIED_KEY, loadJSON(COVER_TRIED_KEY, []).filter((id) => !ids.has(id)));
  const btn = $('#metaAllBtn');
  btn.disabled = true;
  btn.textContent = `Hämtar för ${missing.length} böcker…`;
  try {
    // autoMeta/autoCovers tar några böcker per varv; kör tills inget mer händer.
    for (let round = 0; round < Math.ceil(missing.length / 10) + 1; round++) {
      await autoMeta();
      await autoCovers();
    }
    const still = Object.values(db.books).filter((b) => ids.has(b.id) && (!b.pages || !b.genres?.length)).length;
    toast(still ? `Klart. ${still} böcker hittades inte – använd 🔄 Uppgifter på dem` : 'Klart – alla böcker har fått uppgifter');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Hämta uppgifter för alla';
  }
});

// ---------- Sortering ----------
const SORT_KEY = 'mina-bocker:sort';
const SORT_LABELS = {
  default: 'Standard', author: 'Författare', title: 'Titel', series: 'Serie', pages: 'Längd',
  year: 'Utgivningsår', added: 'Senast tillagd', rating: 'Betyg', color: 'Färg',
};
const SORT_DIR = { author: 1, title: 1, series: 1, pages: 1, year: -1, added: -1, rating: -1, color: 1, started: -1, finished: -1 };

function sortFor(tab) {
  return loadJSON(SORT_KEY, {})[tab] || { key: 'default', dir: null };
}
function saveSort(tab, sort) {
  const all = loadJSON(SORT_KEY, {});
  all[tab] = sort;
  saveJSON(SORT_KEY, all);
}
function effectiveSort(sort) {
  const key = sort.key === 'default' ? ({ reading: 'started', read: 'finished' }[currentTab] || 'author') : sort.key;
  return { key, dir: sort.dir ?? SORT_DIR[key] ?? 1 };
}

const seriesLabel = (b) => `${b.series}${b.series_no != null && b.series_no !== '' ? ` #${String(b.series_no).replace('.', ',')}` : ''}`;
// Efternamn först: "Astrid Lindgren, Ingrid Vang Nyman" → "lindgren astrid"
function authorKey(b) {
  const a = (b.authors || '').split(',')[0].trim().split(/\s+/);
  return fold(`${a.pop() || ''} ${a.join(' ')}`);
}
const titleKey = (b) => fold(String(b.title || '').replace(/^(the|a|an)\s+/i, ''));
function avgRating(b) {
  const r = entriesOf(b.id).map((e) => e.rating).filter(Boolean);
  return r.length ? r.reduce((x, y) => x + y, 0) / r.length : null;
}
// Färgton för regnbågshyllan; gråa ryggar hamnar sist
function hueKey(b) {
  const hex = toHex(spineColor(b));
  const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), d = mx - mn;
  if (d < 0.08) return 1000 + (1 - mx) * 100;
  let h = mx === r ? ((g - bl) / d) % 6 : mx === g ? (bl - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}
const SORT_VALUE = {
  author: authorKey, title: titleKey, pages: (b) => b.pages || null, year: (b) => int(b.year), added: (b) => b.added_at || null,
  rating: avgRating, color: hueKey, started: (b) => latest(b.id, 'started_at') || null, finished: (b) => latest(b.id, 'finished_at') || null,
};

function sortBooks(list, sort) {
  const { key, dir } = effectiveSort(sort);
  const tie = (a, b) => authorKey(a).localeCompare(authorKey(b), 'sv') || titleKey(a).localeCompare(titleKey(b), 'sv');
  const missing = (v) => v == null || v === '';
  return [...list].sort((a, b) => {
    if (key === 'series') {
      if (!a.series || !b.series) return !a.series && !b.series ? tie(a, b) : a.series ? -1 : 1;
      return dir * fold(a.series).localeCompare(fold(b.series), 'sv')
        || (a.series_no ?? 1e9) - (b.series_no ?? 1e9) || (int(a.year) || 0) - (int(b.year) || 0) || tie(a, b);
    }
    const va = SORT_VALUE[key](a), vb = SORT_VALUE[key](b);
    if (missing(va) || missing(vb)) return missing(va) && missing(vb) ? tie(a, b) : missing(va) ? 1 : -1; // saknas → sist
    const c = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'sv');
    return dir * c || tie(a, b);
  });
}

function renderSortBar(sort) {
  const sel = $('#sortSel');
  const keys = Object.keys(SORT_LABELS).filter((k) => k !== 'color' || currentTab === 'shelf');
  const def = { reading: 'senast påbörjad', read: 'senast utläst' }[currentTab] || 'författare';
  sel.innerHTML = keys.map((k) => `<option value="${k}">${k === 'default' ? `Sortera: ${def}` : SORT_LABELS[k]}</option>`).join('');
  sel.value = keys.includes(sort.key) ? sort.key : 'default';
  const { key, dir } = effectiveSort(sort);
  const btn = $('#sortDir');
  btn.textContent = dir === 1 ? '↑' : '↓';
  const words = { pages: ['kortast först', 'längst först'], year: ['äldst först', 'nyast först'], added: ['äldst först', 'nyast först'],
    rating: ['lägst först', 'högst först'], started: ['äldst först', 'senast först'], finished: ['äldst först', 'senast först'] }[key] || ['A–Ö', 'Ö–A'];
  btn.title = btn.ariaLabel = `Ordning: ${dir === 1 ? words[0] : words[1]} (tryck för att vända)`;
}

$('#sortSel').addEventListener('change', (e) => {
  saveSort(currentTab, { key: e.target.value, dir: null });
  render();
});
$('#sortDir').addEventListener('click', () => {
  const sort = sortFor(currentTab);
  saveSort(currentTab, { ...sort, dir: -effectiveSort(sort).dir });
  render();
});

// ---------- Hitta serier automatiskt ----------
const SERIES_STOP = new Set(('the and of a an or in on at to for with from by is are was be how you your my our this that it its ' +
  'och i på en ett det den de som med för till av om är var hur du din mitt vår ' +
  'book books novel novels story stories trilogy series volume edition collection rules complete part chronicles').split(' '));
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Star Wars ; 3", "Jack Reacher, #30", "The First Law -- bk. 2" → { name, no }
function parseSeriesText(t) {
  const m = String(t).match(/^(.*?)(?:\s*[,;:(-]+\s*(?:#|no\.?|nr\.?|bk\.?|book|del|vol\.?)?\s*(\d+(?:[.,]\d+)?)\)?)?\s*$/i);
  const name = (m?.[1] || '').replace(/^(a|an)\s+/i, '').replace(/\s+(novel|series|serien)$/i, '').trim();
  return { name, no: m?.[2] ? num(m[2]) : null };
}

async function detectSeries(onProgress) {
  const all = Object.values(db.books);
  const todo = all.filter((b) => !b.series);
  const groups = new Map();
  const add = (name, b, no, sure) => {
    name = String(name || '').trim();
    if (name.length < 3 || name.length > 60) return;
    const k = fold(name).replace(/^the\s+/, '');
    if (!groups.has(k)) groups.set(k, { name, sure: false, items: new Map() });
    const g = groups.get(k);
    g.sure = g.sure || sure;
    if (!g.items.has(b.id) || (no != null && g.items.get(b.id) == null)) g.items.set(b.id, no);
  };
  const numberAfter = (title, name) => num((String(title).match(new RegExp(escRe(name) + "(?:'s)?\\W{0,3}(\\d+(?:[.,]\\d+)?)\\b", 'i')) || [])[1]);

  // 1) "Titel (Serie, #3)"
  for (const b of todo) {
    const m = b.title.match(/\(([^()]+?)[,;]?\s*#\s*(\d+(?:[.,]\d+)?)\)\s*$/) || b.title.match(/\(([^()]+?)\s+(\d+(?:[.,]\d+)?)\)\s*$/);
    if (m) add(m[1], b, num(m[2]), true);
  }
  // 2) Samma början före kolon/tankstreck hos minst två böcker: "Star Wars: …", "Star Wars – …"
  const prefixOf = (t) => { const m = String(t).match(/^(.{3,40}?)\s*(?::|\s[–-]\s)/); return m ? m[1].replace(/^the\s+/i, '').trim() : null; };
  // Räcker att början finns i minst två titlar ("Star Wars: The Dark Lord Trilogy" + "The Star Wars Trilogy").
  for (const b of todo) {
    const p = prefixOf(b.title);
    if (p && all.filter((x) => fold(x.title).includes(fold(p))).length >= 2) add(p, b, null, false);
  }
  // 3) Samma ord i titlar av samma författare: "Jack Reacher's Rules" + "Reacher 30" → Reacher
  const byAuthor = new Map();
  for (const b of todo) { const a = authorKey(b).split(' ')[0]; if (a) byAuthor.set(a, [...(byAuthor.get(a) || []), b]); }
  for (const books of byAuthor.values()) {
    if (books.length < 2) continue;
    const seen = new Map();
    for (const b of books) {
      const words = new Set(b.title.split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/'s$/i, '')).filter((w) => w.length >= 4 && /^\p{Lu}/u.test(w) && !SERIES_STOP.has(w.toLowerCase())));
      for (const w of words) seen.set(w, [...(seen.get(w) || []), b]);
    }
    for (const [w, bs] of seen) {
      if (bs.length < 2) continue;
      // Finns ett namn framför ordet i någon titel ("Jack Reacher") används det.
      const full = bs.map((b) => (b.title.match(new RegExp(`(\\p{Lu}\\p{L}+\\s+${escRe(w)})`, 'u')) || [])[1]).find(Boolean);
      for (const b of bs) add(full || w, b, numberAfter(b.title, w), false);
    }
  }
  // 4) Open Library: utgåvans serie via ISBN
  const withIsbn = todo.filter((b) => normIsbn(b.isbn || '')).slice(0, 40);
  let i = 0;
  for (const b of withIsbn) {
    onProgress?.(`Frågar Open Library… ${++i}/${withIsbn.length}`);
    const ed = await olByIsbn(normIsbn(b.isbn));
    const s = Array.isArray(ed?.series) ? ed.series[0] : ed?.series;
    if (s) { const p = parseSeriesText(s); add(p.name, b, p.no, true); }
  }
  // 5) Befintliga och hittade serienamn som står i andra titlar ("The Star Wars Trilogy")
  const names = [...new Set([...all.map((b) => b.series).filter(Boolean), ...[...groups.values()].map((g) => g.name)])];
  for (const b of todo) for (const n of names) {
    if (fold(b.title).includes(fold(n))) add(n, b, numberAfter(b.title, n), all.some((x) => x.series && fold(x.series) === fold(n)));
  }
  // Slå ihop grupper med samma böcker och behåll de som är troliga
  const key = (n) => fold(n).replace(/^the\s+/, '');
  const existing = new Set(all.map((b) => b.series && key(b.series)).filter(Boolean));
  return [...groups.values()]
    .filter((g) => g.items.size >= 2 || g.sure || existing.has(key(g.name)))
    .sort((a, b) => (b.sure - a.sure) || b.items.size - a.items.size || a.name.localeCompare(b.name, 'sv'))
    .filter((g, idx, arr) => !arr.slice(0, idx).some((o) => [...g.items.keys()].every((id) => o.items.has(id)))); // bort med dubbletter
}

let foundSeries = [];
async function openFindSeries() {
  const dlg = $('#seriesDialog');
  $('#seriesFound').innerHTML = '<p class="muted">Letar…</p>';
  $('#seriesApply').disabled = true;
  if (!dlg.open) dlg.showModal();
  foundSeries = await detectSeries((t) => { $('#seriesFound').innerHTML = `<p class="muted">${esc(t)}</p>`; });
  if (!dlg.open) return;
  if (!foundSeries.length) {
    $('#seriesFound').innerHTML = '<p class="muted">Hittade inga serier. Skriv in serien under ✎ Redigera på en bok – nästa bok i samma serie föreslås sedan automatiskt här.</p>';
    return;
  }
  $('#seriesFound').innerHTML = foundSeries.map((g, i) => `<div class="sg">
      <div class="sg-head"><input type="checkbox" checked data-sg="${i}" aria-label="Använd"><input class="sg-name" value="${esc(g.name)}" data-sgname="${i}" aria-label="Seriens namn"></div>
      <ul>${[...g.items].map(([id, no]) => `<li>${no != null ? `<b>#${String(no).replace('.', ',')}</b> ` : ''}${esc(db.books[id]?.title || '')}</li>`).join('')}</ul>
    </div>`).join('');
  $('#seriesApply').disabled = false;
}

function applyFoundSeries() {
  let n = 0;
  foundSeries.forEach((g, i) => {
    if (!$(`[data-sg="${i}"]`).checked) return;
    const name = $(`[data-sgname="${i}"]`).value.trim();
    if (!name) return;
    for (const [id, no] of g.items) {
      const b = db.books[id];
      if (!b || b.series) continue;
      // Boken som heter som serien är oftast del 1 ("Dungeon Crawler Carl").
      const first = no == null && fold(b.title).replace(/^the /, '') === fold(name).replace(/^the /, '') ? 1 : null;
      put('books', { ...b, series: name, series_no: no ?? b.series_no ?? first });
      n++;
    }
  });
  $('#seriesDialog').close();
  if (!n) return;
  saveSort('shelf', { key: 'series', dir: null });
  commit();
  toast(`${n} böcker fick en serie`);
}

$('#seriesApply').addEventListener('click', applyFoundSeries);
$('#findSeriesBtn').addEventListener('click', () => { $('#menuDialog').close(); openFindSeries(); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-find-series]')) openFindSeries(); });

// ---------- Ljudböcker på enheten ----------
// Ljudfilerna (mp3/m4b/…) sparas i IndexedDB på den här enheten, en post per fil:
// { key: "<bok>|0001", bookId, index, name, size, duration, blob }. De synkas inte (för stora).
let localAudio = new Set();
async function idbStore(store, mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => res(r?.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
const audioKey = (bookId, i) => `${bookId}|${String(i).padStart(4, '0')}`;
const audioRecords = (bookId) => idbStore('audio', 'readonly', (st) => st.index('bookId').getAll(bookId))
  .then((list) => (list || []).sort((a, b) => a.index - b.index));
async function audioDelete(bookId) {
  const keys = await idbStore('audio', 'readonly', (st) => st.index('bookId').getAllKeys(bookId));
  if (keys?.length) await idbStore('audio', 'readwrite', (st) => { keys.forEach((k) => st.delete(k)); });
  localAudio.delete(bookId);
}
async function loadLocalAudio() {
  const keys = await idbStore('audio', 'readonly', (st) => st.getAllKeys());
  localAudio = new Set((keys || []).map((k) => String(k).split('|')[0]));
}
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm)$/i;
const fmtBytes = (n) => (n > 1e9 ? `${(n / 1e9).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const fmtLong = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };

function blobDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (d) => { URL.revokeObjectURL(url); res(Number.isFinite(d) ? d : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 20000);
    a.src = url;
  });
}
// Titel ur filnamnen: "Project Hail Mary - 01.mp3", "Project Hail Mary - 02.mp3" → "Project Hail Mary"
function guessAudioTitle(files) {
  const names = files.map((f) => f.name.replace(AUDIO_EXT, ''));
  let p = names[0];
  for (const n of names) while (p && !n.startsWith(p)) p = p.slice(0, -1);
  let t = (names.length > 1 ? p : names[0]).replace(/[\s\-_.()[\]]*(del|part|kapitel|chapter|cd|disc|track|spår)?[\s\-_.]*\d*\s*$/i, '');
  t = t.replace(/^\s*\d+[\s\-_.]+/, '').replace(/[_]+/g, ' ').trim();
  return t.length >= 2 ? t : names[0];
}

async function importAudio(fileList, bookId = null) {
  const files = [...fileList].filter((f) => /^audio\//.test(f.type) || AUDIO_EXT.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'sv', { numeric: true }));
  if (!files.length) { toast('Välj ljudfiler (mp3, m4b, m4a …)'); return null; }
  const total = files.reduce((s, f) => s + f.size, 0);
  try { await navigator.storage?.persist?.(); } catch { /* frivilligt */ }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota && est.quota - est.usage < total * 1.05) { toast(`Inte tillräckligt med utrymme (${fmtBytes(total)} behövs)`); return null; }
  } catch { /* okänt utrymme – försök ändå */ }
  let book = bookId && db.books[bookId];
  if (!book) {
    book = { id: uid(), title: guessAudioTitle(files), authors: '', year: '', isbn: '', cover: '', pages: null, owned: false, added_at: today() };
    put('books', book);
  }
  if (player.bookId === book.id) stopPlayer();
  await audioDelete(book.id);
  try {
    for (let i = 0; i < files.length; i++) {
      toast(`Sparar ljudfil ${i + 1} av ${files.length}…`);
      const f = files[i];
      await idbStore('audio', 'readwrite', (st) => st.put({ key: audioKey(book.id, i), bookId: book.id, index: i, name: f.name, size: f.size, duration: 0, blob: f }));
    }
    // Längden läses efteråt (går snabbt, men vill inte hålla importen)
    for (let i = 0; i < files.length; i++) {
      const d = await blobDuration(files[i]);
      await idbStore('audio', 'readwrite', (st) => { const g = st.get(audioKey(book.id, i)); g.onsuccess = () => { if (g.result) st.put({ ...g.result, duration: d }); }; });
    }
  } catch (err) {
    console.warn(err);
    await audioDelete(book.id).catch(() => {});
    toast('Kunde inte spara ljudfilerna – är lagringen full?');
    return null;
  }
  localAudio.add(book.id);
  // Markera som ljudbok för mig (och lägg den under Läser om den är ny)
  if (me) {
    const e = db.entries[entryId(book.id, me)];
    if (!e && !bookId) put('entries', { ...blankEntry(book.id, me), status: 'reading', audio: true, started_at: today() });
    else if (e && !e.audio) put('entries', { ...e, audio: true });
  }
  commit();
  setTimeout(autoCovers, 500);
  setTimeout(autoMeta, 1500);
  toast(`Ljudboken är sparad på enheten (${fmtBytes(total)}) – fungerar offline`);
  if (driveOn() && drivePrefs().autoUpload) {
    if (tokenValid()) uploadToDrive(book.id);
    else setTimeout(() => toast('Tryck ☁️ Spara i Drive i bokvyn för att lägga den i Google Drive'), 3000);
  }
  return book.id;
}

// ---------- Spelaren ----------
const audioEl = $('#audioEl');
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.8, 0.9];
const SLEEP = [0, 15, 30, 45, 60, -1]; // -1 = slutet av kapitlet
const player = { bookId: null, files: [], index: 0, url: null, total: 0, sleepIdx: 0, sleepAt: 0, lastSave: 0 };
const posKey = (id) => `mina-bocker:apos:${id}`;
const playerPrefs = () => loadJSON('mina-bocker:player', { speed: 1 });

async function playAudioBook(bookId, autoplay = true) {
  const recs = await audioRecords(bookId).catch(() => []);
  if (!recs.length) { toast('Ljudfilerna finns inte på den här enheten'); return; }
  if (player.bookId !== bookId) {
    savePosition();
    player.bookId = bookId;
    player.files = recs.map(({ blob, ...meta }) => meta);
    player.total = recs.reduce((s, r) => s + (r.duration || 0), 0);
    const pos = loadJSON(posKey(bookId), { index: 0, time: 0 });
    await loadTrack(Math.min(pos.index, recs.length - 1), pos.time);
  }
  $('#miniPlayer').hidden = false;
  document.body.classList.add('has-player');
  updateMediaSession();
  if (autoplay) {
    startListeningIfNeeded(bookId);
    try { await audioEl.play(); } catch { /* kräver tryck */ }
  }
  renderPlayer();
}

async function loadTrack(index, time = 0) {
  const rec = await idbStore('audio', 'readonly', (st) => st.get(audioKey(player.bookId, index)));
  if (!rec) return;
  if (player.url) URL.revokeObjectURL(player.url);
  player.index = index;
  player.url = URL.createObjectURL(rec.blob);
  audioEl.src = player.url;
  audioEl.playbackRate = playerPrefs().speed;
  await new Promise((res) => { audioEl.onloadedmetadata = res; audioEl.onerror = res; setTimeout(res, 8000); });
  audioEl.onloadedmetadata = null;
  audioEl.onerror = null;
  // Längd som saknades vid importen
  if (!player.files[index].duration && Number.isFinite(audioEl.duration)) {
    player.files[index].duration = audioEl.duration;
    player.total = player.files.reduce((s, f) => s + (f.duration || 0), 0);
  }
  if (time) audioEl.currentTime = Math.min(time, (audioEl.duration || time) - 1);
  updateMediaSession();
  renderPlayer();
}

function elapsed() {
  return player.files.slice(0, player.index).reduce((s, f) => s + (f.duration || 0), 0) + (audioEl.currentTime || 0);
}
function savePosition(force = false) {
  if (!player.bookId) return;
  saveJSON(posKey(player.bookId), { index: player.index, time: audioEl.currentTime || 0 });
  // Uppdatera "hur långt" för mig (som sida, när sidantalet är känt)
  const now = Date.now();
  if (!force && now - player.lastSave < 30000) return;
  player.lastSave = now;
  const b = db.books[player.bookId];
  const e = me && db.entries[entryId(player.bookId, me)];
  if (!b?.pages || !player.total || e?.status !== 'reading') return;
  const page = Math.max(1, Math.round((elapsed() / player.total) * b.pages));
  if (page !== e.page) { put('entries', { ...e, page }); commit(); }
}
function startListeningIfNeeded(bookId) {
  if (!me) return;
  const e = db.entries[entryId(bookId, me)];
  if (e?.status === 'reading' && e.audio) return;
  if (e?.status === 'read') { if (!e.audio) { put('entries', { ...e, audio: true }); commit(); } return; }
  put('entries', { ...blankEntry(bookId, me), ...e, status: 'reading', audio: true, started_at: e?.status === 'reading' ? e.started_at : today(), finished_at: null });
  commit();
}

function seekBy(sec) {
  let t = (audioEl.currentTime || 0) + sec;
  if (t < 0 && player.index > 0) { loadTrack(player.index - 1, Math.max(0, (player.files[player.index - 1].duration || 0) + t)).then(() => audioEl.play()); return; }
  if (audioEl.duration && t > audioEl.duration && player.index < player.files.length - 1) { loadTrack(player.index + 1, t - audioEl.duration).then(() => audioEl.play()); return; }
  audioEl.currentTime = Math.max(0, Math.min(t, audioEl.duration || t));
}
async function gotoTrack(i, play = true) {
  if (i < 0 || i >= player.files.length) return;
  await loadTrack(i, 0);
  if (play) audioEl.play().catch(() => {});
}
function stopPlayer() {
  savePosition(true);
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
  if (player.url) URL.revokeObjectURL(player.url);
  Object.assign(player, { bookId: null, files: [], index: 0, url: null, total: 0 });
  $('#miniPlayer').hidden = true;
  $('#playerView').hidden = true;
  document.body.classList.remove('has-player');
}

function trackName(i) {
  const f = player.files[i];
  if (!f) return '';
  const n = f.name.replace(AUDIO_EXT, '').replace(/_/g, ' ');
  return player.files.length > 1 ? n : 'Hela boken';
}

function renderPlayer() {
  const b = db.books[player.bookId];
  if (!b) return;
  const playing = !audioEl.paused;
  const pct = player.total ? elapsed() / player.total : 0;
  $('#mpCover').innerHTML = coverHtml(b, 'cover mp-cover');
  $('#mpTitle').textContent = b.title;
  $('#mpSub').textContent = `${trackName(player.index)} · ${Math.round(pct * 100)} %`;
  $('#mpPlay').textContent = playing ? '⏸' : '▶';
  $('#mpPlay').ariaLabel = playing ? 'Pausa' : 'Spela';
  $('#mpBar').style.width = `${pct * 100}%`;
  if ($('#playerView').hidden) return;
  $('#pvCover').innerHTML = coverHtml(b, 'cover pv-cover');
  $('#pvTitle').textContent = b.title;
  $('#pvAuthor').textContent = b.authors || '';
  $('#pvChapter').textContent = player.files.length > 1 ? `${trackName(player.index)} (${player.index + 1} av ${player.files.length})` : '';
  const d = audioEl.duration || player.files[player.index]?.duration || 0;
  $('#pvSeek').value = d ? Math.round((audioEl.currentTime / d) * 1000) : 0;
  $('#pvCur').textContent = fmtTime(audioEl.currentTime);
  $('#pvLeft').textContent = `-${fmtTime(d - audioEl.currentTime)}`;
  $('#pvTotal').textContent = player.total ? `${Math.round(pct * 100)} % · ${fmtLong((player.total - elapsed()) / (audioEl.playbackRate || 1))} kvar` : '';
  $('#pvPlay').textContent = playing ? '⏸' : '▶';
  $('#pvPlay').ariaLabel = playing ? 'Pausa' : 'Spela';
  $('#pvSpeed').textContent = `${String(audioEl.playbackRate || 1).replace('.', ',')}×`;
  const sl = SLEEP[player.sleepIdx];
  $('#pvSleep').textContent = sl === 0 ? '😴 Av' : sl === -1 ? '😴 Kapitlets slut' : `😴 ${Math.max(0, Math.ceil((player.sleepAt - Date.now()) / 60000))} min`;
  const last = player.index === player.files.length - 1;
  $('#pvFinish').hidden = !(last && d && audioEl.currentTime > d - 120) && pct < 0.98;
  $('#pvPrev').disabled = player.index === 0;
  $('#pvNext').disabled = last;
}

function openPlayerView() {
  $('#playerView').hidden = false;
  document.body.classList.add('reading-mode');
  renderPlayer();
}
function closePlayerView() {
  $('#playerView').hidden = true;
  $('#pvChapterList').hidden = true;
  document.body.classList.remove('reading-mode');
}

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !player.bookId) return;
  const b = db.books[player.bookId];
  const art = /^(https:|data:image)/.test(b?.cover || '') ? [{ src: b.cover, sizes: '512x512' }] : [];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: b?.title || '', artist: b?.authors || '', album: trackName(player.index), artwork: art });
  } catch { /* äldre webbläsare */ }
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !audioEl.duration || !Number.isFinite(audioEl.duration)) return;
  try { navigator.mediaSession.setPositionState({ duration: audioEl.duration, playbackRate: audioEl.playbackRate, position: Math.min(audioEl.currentTime, audioEl.duration) }); } catch { /* ignorera */ }
}
if ('mediaSession' in navigator) {
  const h = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* stöds inte */ } };
  h('play', () => audioEl.play());
  h('pause', () => audioEl.pause());
  h('seekbackward', (d) => seekBy(-(d?.seekOffset || 30)));
  h('seekforward', (d) => seekBy(d?.seekOffset || 30));
  h('previoustrack', () => (audioEl.currentTime > 5 ? (audioEl.currentTime = 0) : gotoTrack(player.index - 1)));
  h('nexttrack', () => gotoTrack(player.index + 1));
  h('seekto', (d) => { if (d?.seekTime != null) audioEl.currentTime = d.seekTime; });
}

audioEl.addEventListener('timeupdate', () => {
  renderPlayer();
  savePosition();
  updatePositionState();
  const sl = SLEEP[player.sleepIdx];
  if (sl > 0 && Date.now() >= player.sleepAt) { audioEl.pause(); player.sleepIdx = 0; toast('Insomningstimern pausade 😴'); }
});
audioEl.addEventListener('play', () => { renderPlayer(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audioEl.addEventListener('pause', () => { savePosition(true); renderPlayer(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
audioEl.addEventListener('ended', async () => {
  if (SLEEP[player.sleepIdx] === -1) { player.sleepIdx = 0; savePosition(true); renderPlayer(); toast('Kapitlet är slut – god natt 😴'); return; }
  if (player.index < player.files.length - 1) { await gotoTrack(player.index + 1); return; }
  savePosition(true);
  if ($('#playerView').hidden) openPlayerView();
  renderPlayer();
  toast('Slut på ljudboken – tryck ✓ Utläst');
});

$('#mpPlay').addEventListener('click', () => (audioEl.paused ? playAudioBook(player.bookId) : audioEl.pause()));
$('#mpBack').addEventListener('click', () => seekBy(-15));
$('#mpOpen').addEventListener('click', openPlayerView);
$('#pvClose').addEventListener('click', closePlayerView);
$('#pvPlay').addEventListener('click', () => (audioEl.paused ? playAudioBook(player.bookId) : audioEl.pause()));
$('#pvBack').addEventListener('click', () => seekBy(-30));
$('#pvFwd').addEventListener('click', () => seekBy(30));
$('#pvPrev').addEventListener('click', () => (audioEl.currentTime > 5 ? (audioEl.currentTime = 0) : gotoTrack(player.index - 1, !audioEl.paused)));
$('#pvNext').addEventListener('click', () => gotoTrack(player.index + 1, !audioEl.paused));
$('#pvSeek').addEventListener('input', (e) => { if (audioEl.duration) audioEl.currentTime = (e.target.value / 1000) * audioEl.duration; });
$('#pvSpeed').addEventListener('click', () => {
  const i = (SPEEDS.indexOf(audioEl.playbackRate) + 1) % SPEEDS.length;
  audioEl.playbackRate = SPEEDS[i];
  saveJSON('mina-bocker:player', { ...playerPrefs(), speed: SPEEDS[i] });
  renderPlayer();
});
$('#pvSleep').addEventListener('click', () => {
  player.sleepIdx = (player.sleepIdx + 1) % SLEEP.length;
  const sl = SLEEP[player.sleepIdx];
  player.sleepAt = sl > 0 ? Date.now() + sl * 60000 : 0;
  renderPlayer();
});
$('#pvChapters').addEventListener('click', () => {
  const el = $('#pvChapterList');
  el.hidden = !el.hidden;
  if (el.hidden) return;
  el.innerHTML = player.files.map((f, i) => `<button type="button" data-track="${i}" class="${i === player.index ? 'on' : ''}">
    <span>${esc(trackName(i))}</span><span class="muted">${f.duration ? fmtTime(f.duration) : ''}</span></button>`).join('');
});
$('#pvChapterList').addEventListener('click', (e) => {
  const t = e.target.closest('[data-track]');
  if (t) { gotoTrack(+t.dataset.track); $('#pvChapterList').hidden = true; }
});
$('#pvFinish').addEventListener('click', () => {
  const id = player.bookId;
  const e = me && db.entries[entryId(id, me)];
  stopPlayer();
  closePlayerView();
  if (e) put('entries', { ...e, status: 'read', audio: true, page: db.books[id]?.pages || e.page, finished_at: today() });
  localStorage.removeItem(posKey(id));
  commit();
  toast(`Grattis! ”${db.books[id]?.title}” är utlyssnad 🎉`);
  openEdit(id, me);
});
window.addEventListener('pagehide', () => savePosition(true));

// Import från lägg till-dialogen och bokvyn
$('#audioImportBtn').addEventListener('click', () => $('#audioFile').click());
$('#audioFile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  $('#addDialog').close();
  const id = await importAudio(files);
  if (id) openBook(id);
});
$('#bvAudioFile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  const id = viewBookId;
  e.target.value = '';
  if (files.length && await importAudio(files, id)) openBook(id);
});

// ---------- Google Drive: ljudböcker i molnet ----------
// Behörigheten drive.file: appen ser bara filer den själv har skapat. Allt läggs i mappen
// "Mina böcker – ljudböcker" med en undermapp per bok. Mappar och filer märks med appProperties:
//   mapp:  { mbKind: 'audiobook', mbBook: <bok-id>, mbTitle, mbAuthors }
//   fil:   { mbKind: 'track', mbBook, mbIndex, mbDur }
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_PREF = 'mina-bocker:drive';
const driveClientId = () => (window.BOOKS_CONFIG || {}).googleClientId;
const drivePrefs = () => loadJSON(DRIVE_PREF, { connected: false, autoUpload: true });
const driveOn = () => !!driveClientId() && drivePrefs().connected;
let driveClient = null;
let pendingToken = null;
let driveToken = null;
let driveTokenExp = 0;
let driveBooks = null; // Map bokId → { folder, tracks, size } (cache)
try { const t = JSON.parse(sessionStorage.getItem('mb-drive-token') || 'null'); if (t?.e > Date.now()) { driveToken = t.t; driveTokenExp = t.e; } } catch { /* ingen */ }

async function ensureDriveClient() {
  if (driveClient || !driveClientId()) return;
  await loadScript('https://accounts.google.com/gsi/client');
  driveClient = google.accounts.oauth2.initTokenClient({
    client_id: driveClientId(),
    scope: DRIVE_SCOPE,
    callback: (r) => {
      const p = pendingToken;
      pendingToken = null;
      if (r.error) { p?.rej(new Error(r.error_description || r.error)); return; }
      driveToken = r.access_token;
      driveTokenExp = Date.now() + (+r.expires_in || 3600) * 1000;
      try { sessionStorage.setItem('mb-drive-token', JSON.stringify({ t: driveToken, e: driveTokenExp })); } catch { /* privat läge */ }
      saveJSON(DRIVE_PREF, { ...drivePrefs(), connected: true });
      p?.res(driveToken);
    },
    error_callback: (e) => {
      const p = pendingToken;
      pendingToken = null;
      p?.rej(new Error(e?.type === 'popup_closed' ? 'Inloggningen avbröts' : e?.type === 'popup_failed_to_open' ? 'Inloggningsfönstret blockerades – tillåt popup-fönster' : 'Kunde inte logga in på Google'));
    },
  });
}
const tokenValid = () => driveToken && Date.now() < driveTokenExp - 60000;
// Måste anropas direkt i ett tryck (innan första await), annars blockerar webbläsaren inloggningsfönstret.
let tokenPromise = null;
function getDriveToken() {
  if (tokenValid()) return Promise.resolve(driveToken);
  if (tokenPromise) return tokenPromise; // en inloggning i taget, alla väntar på samma
  if (!driveClient) { ensureDriveClient(); return Promise.reject(new Error('Google laddas – tryck igen om en sekund')); }
  tokenPromise = new Promise((res, rej) => { pendingToken = { res, rej }; driveClient.requestAccessToken({ prompt: '' }); })
    .finally(() => { tokenPromise = null; });
  return tokenPromise;
}

async function dapi(url, opts = {}) {
  const t = await getDriveToken();
  const r = await fetch(url.startsWith('http') ? url : DRIVE_API + url, { ...opts, headers: { Authorization: `Bearer ${t}`, ...(opts.headers || {}) } });
  if (r.status === 401) { driveToken = null; throw new Error('Inloggningen till Google har gått ut – tryck igen'); }
  if (!r.ok) throw new Error(`Google Drive ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r;
}
const q = (s) => encodeURIComponent(s);
async function driveFind(query, fields = 'id,name,appProperties') {
  const out = [];
  let page = '';
  do {
    const r = await (await dapi(`/files?q=${q(query + ' and trashed=false')}&fields=nextPageToken,files(${fields})&pageSize=1000&spaces=drive${page ? `&pageToken=${page}` : ''}`)).json();
    out.push(...(r.files || []));
    page = r.nextPageToken || '';
  } while (page);
  return out;
}
const prop = (k, v) => `appProperties has { key='${k}' and value='${String(v).replace(/'/g, "\\'")}' }`;
const clip = (t, n = 100) => String(t || '').slice(0, n);

async function driveRoot() {
  const found = await driveFind(prop('mbKind', 'root'));
  if (found[0]) return found[0];
  return (await dapi('/files?fields=id,name', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mina böcker – ljudböcker', mimeType: 'application/vnd.google-apps.folder', appProperties: { mbKind: 'root' } }) })).json();
}

// Alla ljudböcker i Drive, grupperade per bok
async function listDriveBooks() {
  const folders = await driveFind(prop('mbKind', 'audiobook'));
  const tracks = await driveFind(prop('mbKind', 'track'), 'id,name,size,mimeType,appProperties');
  const map = new Map();
  for (const f of folders) map.set(f.appProperties.mbBook, { folder: f, tracks: [], size: 0 });
  for (const t of tracks) {
    const g = map.get(t.appProperties?.mbBook);
    if (!g) continue;
    g.tracks.push(t);
    g.size += +t.size || 0;
  }
  for (const g of map.values()) g.tracks.sort((a, b) => +a.appProperties.mbIndex - +b.appProperties.mbIndex);
  driveBooks = map;
  return map;
}

// Uppladdning med förlopp (XMLHttpRequest ger förlopp för uppladdning, fetch gör inte det)
function putWithProgress(url, blob, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.upload.onprogress = (e) => onProgress?.(e.loaded);
    x.onload = () => (x.status < 300 ? res(JSON.parse(x.responseText || '{}')) : rej(new Error(`Uppladdning misslyckades (${x.status})`)));
    x.onerror = () => rej(new Error('Uppladdningen avbröts – kontrollera nätet'));
    x.send(blob);
  });
}

// ---- Överföringar (en i taget) med förloppsrad ----
let transferChain = Promise.resolve();
function queueTransfer(label, job) {
  const run = transferChain.then(async () => {
    const el = $('#transfer');
    const show = (text, pct) => { el.hidden = false; $('#transferText').textContent = text; $('#transferBar').style.width = `${Math.round((pct || 0) * 100)}%`; };
    show(`${label}…`, 0);
    try { await job(show); } catch (e) { console.warn(e); toast(e.message || 'Något gick fel med Google Drive'); } finally { el.hidden = true; }
  });
  transferChain = run.catch(() => {});
  return run;
}

function uploadToDrive(bookId) {
  const b = db.books[bookId];
  if (!b) return Promise.resolve();
  return queueTransfer(`☁️ Laddar upp ${b.title}`, async (show) => {
    const recs = await audioRecords(bookId);
    if (!recs.length) throw new Error('Inga ljudfiler på enheten att ladda upp');
    const root = await driveRoot();
    let folder = (await driveFind(`${prop('mbKind', 'audiobook')} and ${prop('mbBook', bookId)}`))[0];
    if (!folder) {
      folder = await (await dapi('/files?fields=id,name,appProperties', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${b.title}${b.authors ? ' – ' + b.authors.split(',')[0] : ''}`.replace(/[\/\\]/g, '-'), mimeType: 'application/vnd.google-apps.folder', parents: [root.id],
          appProperties: { mbKind: 'audiobook', mbBook: bookId, mbTitle: clip(b.title), mbAuthors: clip(b.authors) } }) })).json();
    }
    const existing = await driveFind(`${prop('mbKind', 'track')} and ${prop('mbBook', bookId)}`, 'id,size,appProperties');
    const total = recs.reduce((s, r) => s + r.size, 0);
    let done = 0;
    for (const r of recs) {
      const there = existing.find((t) => +t.appProperties.mbIndex === r.index && +t.size === r.size);
      if (there) { done += r.size; continue; } // redan uppladdad
      const init = await dapi(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': r.blob.type || 'audio/mpeg', 'X-Upload-Content-Length': String(r.size) },
        body: JSON.stringify({ name: r.name, parents: [folder.id], appProperties: { mbKind: 'track', mbBook: bookId, mbIndex: String(r.index), mbDur: String(Math.round(r.duration || 0)) } }),
      });
      const url = init.headers.get('Location');
      if (!url) throw new Error('Google Drive svarade inte med en uppladdningsadress');
      await putWithProgress(url, r.blob, (n) => show(`☁️ Laddar upp ${b.title} – ${fmtBytes(done + n)} av ${fmtBytes(total)}`, (done + n) / total));
      done += r.size;
    }
    await listDriveBooks().catch(() => {});
    toast(`”${b.title}” finns nu i Google Drive ☁️`);
    if ($('#bookDialog').open && viewBookId === bookId) openBook(bookId);
  });
}

function downloadFromDrive(bookId) {
  const g = driveBooks?.get(bookId);
  if (!g) return Promise.resolve();
  const title = db.books[bookId]?.title || g.folder.appProperties.mbTitle || g.folder.name;
  return queueTransfer(`⬇ Hämtar ${title}`, async (show) => {
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota && est.quota - est.usage < g.size * 1.05) throw new Error(`Inte tillräckligt med utrymme på enheten (${fmtBytes(g.size)} behövs)`);
    } catch (e) { if (/utrymme/.test(e.message)) throw e; }
    try { await navigator.storage?.persist?.(); } catch { /* frivilligt */ }
    // Boken finns kanske inte i biblioteket (t.ex. uppladdad av någon annan): skapa den
    if (!db.books[bookId]) {
      put('books', { id: bookId, title, authors: g.folder.appProperties.mbAuthors || '', year: '', isbn: '', cover: '', pages: null, owned: false, added_at: today() });
      commit();
    }
    if (player.bookId === bookId) stopPlayer();
    await audioDelete(bookId);
    let got = 0;
    for (const t of g.tracks) {
      const res = await dapi(`/files/${t.id}?alt=media`);
      const reader = res.body.getReader();
      let acc = new Blob([]), parts = [], pend = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        pend += value.length;
        if (pend > 8e6) { acc = new Blob([acc, ...parts]); parts = []; pend = 0; } // låt webbläsaren lägga stora filer på disk
        show(`⬇ Hämtar ${title} – ${fmtBytes(got)} av ${fmtBytes(g.size)}`, got / (g.size || 1));
      }
      const blob = new Blob([acc, ...parts], { type: t.mimeType || 'audio/mpeg' });
      const i = +t.appProperties.mbIndex;
      await idbStore('audio', 'readwrite', (st) => st.put({ key: audioKey(bookId, i), bookId, index: i, name: t.name, size: blob.size, duration: +t.appProperties.mbDur || 0, blob }));
    }
    localAudio.add(bookId);
    if (me) {
      const e = db.entries[entryId(bookId, me)];
      if (!e) put('entries', { ...blankEntry(bookId, me), status: 'reading', audio: true, started_at: today() });
      else if (!e.audio) put('entries', { ...e, audio: true });
    }
    commit();
    setTimeout(autoCovers, 500);
    toast(`”${title}” är hämtad – fungerar offline 🎧`);
    if ($('#driveDialog').open) renderDriveList();
  });
}

async function deleteFromDrive(bookId) {
  const g = driveBooks?.get(bookId);
  if (!g) return;
  await dapi(`/files/${g.folder.id}`, { method: 'DELETE' }); // tar även bort filerna i mappen
  driveBooks.delete(bookId);
  renderDriveList();
}

// ---- Gränssnitt ----
function renderDrivePanel() {
  const el = $('#drivePanel');
  $('#driveSection').hidden = !driveClientId(); // visas bara när googleClientId är ifyllt i config.js
  if (!driveClientId()) {
    el.innerHTML = '<p class="muted">Inte påslaget. Följ guiden i README ("Google Drive för ljudböcker") och fyll i <code>googleClientId</code> i config.js.</p>';
    return;
  }
  ensureDriveClient().catch(() => {});
  if (!drivePrefs().connected) {
    el.innerHTML = `<p class="muted">Spara ljudböckerna i din Google Drive (15 GB gratis) och hämta dem till vilken enhet som helst.</p>
      <div class="actions"><button type="button" id="driveConnect" class="btn primary">Anslut Google Drive</button></div>`;
    return;
  }
  el.innerHTML = `<p class="muted">Ansluten ✓ – ljudböckerna ligger i mappen ”Mina böcker – ljudböcker”.</p>
    <label class="check"><input type="checkbox" id="driveAuto" ${drivePrefs().autoUpload ? 'checked' : ''}> <span>Spara nya ljudböcker i Drive automatiskt</span></label>
    <div class="actions wrap">
      <button type="button" id="driveOpen" class="btn">☁️ Ljudböcker i Drive</button>
      <button type="button" id="driveDisconnect" class="link-btn">Koppla från</button>
    </div>`;
}

async function openDriveList() {
  $('#driveList').innerHTML = '<p class="muted">Hämtar listan från Google Drive…</p>';
  if (!$('#driveDialog').open) $('#driveDialog').showModal();
  try {
    await listDriveBooks();
    renderDriveList();
  } catch (e) {
    $('#driveList').innerHTML = `<p class="muted">${esc(e.message)}</p><div class="actions"><button type="button" class="btn" data-drive-retry>Försök igen</button></div>`;
  }
}
function renderDriveList() {
  if (!driveBooks) return;
  const items = [...driveBooks.entries()].sort((a, b) => (db.books[a[0]]?.title || a[1].folder.name).localeCompare(db.books[b[0]]?.title || b[1].folder.name, 'sv'));
  const localOnly = [...localAudio].filter((id) => !driveBooks.has(id) && db.books[id]);
  const used = items.reduce((s, [, g]) => s + g.size, 0);
  $('#driveList').innerHTML = (localOnly.length
    ? `<div class="drive-note">${localOnly.length} ljudbok${localOnly.length > 1 ? 'öcker' : ''} på enheten finns inte i Drive.
        <button type="button" class="btn small-btn" data-drive-upload-all>☁️ Ladda upp</button></div>` : '')
    + (items.length ? items.map(([id, g]) => {
      const b = db.books[id] || { title: g.folder.appProperties.mbTitle || g.folder.name, authors: g.folder.appProperties.mbAuthors || '' };
      const here = localAudio.has(id);
      return `<div class="drive-item">
        ${coverHtml(b, 'cover')}
        <div class="info"><span class="title">${esc(b.title)}</span>
          <span class="author">${esc(b.authors || '')}</span>
          <span class="muted small">${g.tracks.length} fil${g.tracks.length === 1 ? '' : 'er'} · ${fmtBytes(g.size)}</span></div>
        <div class="drive-acts">
          ${here ? '<button type="button" class="btn small-btn" data-drive-play="' + esc(id) + '">▶ Lyssna</button>'
            : `<button type="button" class="btn primary small-btn" data-drive-get="${esc(id)}">⬇ Hämta</button>`}
          <button type="button" class="link-btn" data-drive-del="${esc(id)}">Ta bort</button>
        </div></div>`;
    }).join('') : '<p class="muted">Inga ljudböcker i Drive än. Importera en ljudbok, eller tryck ☁️ Spara i Drive på en bok.</p>')
    + `<p class="muted small center">Används i Drive: ${fmtBytes(used)}</p>`;
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.id === 'driveConnect') {
    getDriveToken().then(() => { toast('Google Drive är anslutet ✓'); renderDrivePanel(); }).catch((err) => toast(err.message));
  }
  if (t.id === 'driveDisconnect') {
    try { if (driveToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(driveToken, () => {}); } catch { /* ignorera */ }
    driveToken = null;
    sessionStorage.removeItem('mb-drive-token');
    saveJSON(DRIVE_PREF, { ...drivePrefs(), connected: false });
    driveBooks = null;
    renderDrivePanel();
  }
  if (t.id === 'driveAuto') saveJSON(DRIVE_PREF, { ...drivePrefs(), autoUpload: t.checked });
  if (t.id === 'driveOpen' || t.closest?.('[data-drive-retry]')) {
    getDriveToken().catch(() => {}); // starta inloggning direkt i trycket om det behövs
    $('#menuDialog').close();
    openDriveList();
  }
  const get = t.closest?.('[data-drive-get]');
  if (get) { getDriveToken().catch(() => {}); downloadFromDrive(get.dataset.driveGet); }
  const play = t.closest?.('[data-drive-play]');
  if (play) { $('#driveDialog').close(); playAudioBook(play.dataset.drivePlay).then(openPlayerView); }
  const del = t.closest?.('[data-drive-del]');
  if (del) {
    const id = del.dataset.driveDel;
    const name = db.books[id]?.title || driveBooks?.get(id)?.folder.name;
    if (confirm(`Ta bort ”${name}” från Google Drive? Filerna på den här enheten ligger kvar.`)) deleteFromDrive(id).catch((err) => toast(err.message));
  }
  if (t.closest?.('[data-drive-upload-all]')) {
    getDriveToken().catch(() => {});
    [...localAudio].filter((id) => !driveBooks?.has(id) && db.books[id]).forEach((id) => uploadToDrive(id).then(() => renderDriveList()));
  }
});

// Starta inloggningsklienten i förväg om Drive är anslutet (inloggningsfönster måste öppnas direkt vid ett tryck)
if (driveOn()) ensureDriveClient().catch(() => {});

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
  loadLocalAudio().then(render).catch(() => {});
  if (driveOn() && tokenValid()) listDriveBooks().then(render).catch(() => {});
  setTimeout(autoCovers, 1500);
  setTimeout(autoMeta, 4000);
})();
