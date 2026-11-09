'use strict';

// ---------- Datamodell ----------
// En bok: { id, title, authors, year, isbn, cover, reading: 'none'|'reading'|'read',
//           owned: bool, wanted: bool, rating: 0-5, notes, addedAt, startedAt, finishedAt }

const STORAGE_KEY = 'mina-bocker:v1';
const $ = (sel) => document.querySelector(sel);

let books = load();
let currentTab = 'reading';
let editingId = null;
let editRating = 0;

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
  } catch {
    toast('Kunde inte spara – är lagringen full?');
  }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);

const TABS = {
  reading:  { match: (b) => b.reading === 'reading', empty: 'Du läser ingen bok just nu.' },
  shelf:    { match: (b) => b.owned,                 empty: 'Bokhyllan är tom.' },
  wishlist: { match: (b) => b.wanted && !b.owned,    empty: 'Önskelistan är tom.' },
  read:     { match: (b) => b.reading === 'read',    empty: 'Inga lästa böcker ännu.' },
};

// Standardstatus när man lägger till en bok från en viss flik
const DEFAULTS = {
  reading:  { reading: 'reading', owned: false, wanted: false },
  shelf:    { reading: 'none',    owned: true,  wanted: false },
  wishlist: { reading: 'none',    owned: false, wanted: true  },
  read:     { reading: 'read',    owned: false, wanted: false },
};

// ---------- Rendering ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function coverHtml(b, cls = 'cover') {
  if (b.cover) return `<img class="${cls}" src="${esc(b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return `<div class="${cls}" aria-hidden="true">${esc((b.title || '?')[0].toUpperCase())}</div>`;
}

function render() {
  // Flikräknare
  document.querySelectorAll('.tabs button').forEach((btn) => {
    const t = btn.dataset.tab;
    btn.setAttribute('aria-selected', String(t === currentTab));
    btn.querySelector('.count').textContent = books.filter(TABS[t].match).length || '';
  });

  const q = $('#filter').value.trim().toLowerCase();
  let list = books.filter(TABS[currentTab].match);
  if (q) list = list.filter((b) => `${b.title} ${b.authors}`.toLowerCase().includes(q));

  list.sort((a, b) => {
    if (currentTab === 'read') return (b.finishedAt || '').localeCompare(a.finishedAt || '');
    if (currentTab === 'reading') return (b.startedAt || '').localeCompare(a.startedAt || '');
    return (a.authors || '').localeCompare(b.authors || '', 'sv') || a.title.localeCompare(b.title, 'sv');
  });

  const el = $('#list');
  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="big">📚</div><p>${q ? 'Inga träffar.' : TABS[currentTab].empty}</p>
      ${q ? '' : '<p>Tryck på <b>＋</b> för att lägga till en bok.</p>'}</div>`;
    return;
  }

  el.innerHTML = list.map((b) => {
    const tags = [];
    if (currentTab !== 'shelf' && b.owned) tags.push('I hyllan');
    if (currentTab !== 'reading' && b.reading === 'reading') tags.push('Läser');
    if (currentTab !== 'read' && b.reading === 'read') tags.push('Läst');
    if (currentTab === 'read' && b.finishedAt) tags.push(b.finishedAt);

    const quick = [];
    if (currentTab === 'reading') quick.push(['finish', '✓ Utläst']);
    if (currentTab === 'shelf' && b.reading === 'none') quick.push(['start', '▶ Börja läsa']);
    if (currentTab === 'wishlist') quick.push(['buy', '✓ Köpt'], ['start', '▶ Börja läsa']);

    return `<div class="card" data-id="${b.id}" role="button" tabindex="0">
      ${coverHtml(b)}
      <div class="info">
        <span class="title">${esc(b.title)}</span>
        <span class="author">${esc(b.authors)}${b.year ? ' · ' + esc(b.year) : ''}</span>
        ${b.rating ? `<span class="rating">${'★'.repeat(b.rating)}${'☆'.repeat(5 - b.rating)}</span>` : ''}
        <div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        ${quick.length ? `<div class="quick">${quick.map(([a, l]) => `<button data-action="${a}">${l}</button>`).join('')}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ---------- Snabbåtgärder ----------
function quickAction(id, action) {
  const b = books.find((x) => x.id === id);
  if (!b) return;
  if (action === 'finish') {
    b.reading = 'read';
    b.finishedAt = today();
    toast(`”${b.title}” markerad som läst`);
    save(); render();
    openEdit(id); // låt användaren sätta betyg direkt
    return;
  }
  if (action === 'start') {
    b.reading = 'reading';
    b.startedAt = today();
    toast(`Du läser nu ”${b.title}”`);
  }
  if (action === 'buy') {
    b.owned = true;
    b.wanted = false;
    toast(`”${b.title}” flyttad till bokhyllan`);
  }
  save(); render();
}

// ---------- Sök / lägg till ----------
let searchTimer = null;
let searchSeq = 0;

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
    const isbn13 = ids.find((i) => i.type === 'ISBN_13')?.identifier;
    const isbn10 = ids.find((i) => i.type === 'ISBN_10')?.identifier;
    const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '';
    return {
      title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title || '',
      authors: (v.authors || []).join(', '),
      year: (v.publishedDate || '').slice(0, 4),
      isbn: isbn13 || isbn10 || '',
      cover: img.replace(/^http:/, 'https:'),
    };
  });
}

async function searchOpenLibrary(q) {
  const isbn = normIsbn(q);
  const param = isbn ? `isbn=${isbn}` : `q=${encodeURIComponent(q)}`;
  const res = await fetch(`https://openlibrary.org/search.json?${param}&limit=15&fields=title,author_name,first_publish_year,isbn,cover_i`);
  if (!res.ok) throw new Error('openlibrary ' + res.status);
  const data = await res.json();
  return (data.docs || []).map((d) => ({
    title: d.title || '',
    authors: (d.author_name || []).join(', '),
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    isbn: isbn || d.isbn?.find((i) => i.length === 13) || d.isbn?.[0] || '',
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
  if (!results.length) {
    try { results = await searchOpenLibrary(q); } catch { /* ingen träff */ }
  }
  if (seq !== searchSeq) return; // ett nyare sök har startat

  if (!results.length) {
    el.innerHTML = '<p class="muted">Inga träffar. Du kan lägga till boken manuellt.</p>';
    return;
  }
  el.innerHTML = results.map((r, i) => `<div class="result">
      ${coverHtml(r)}
      <div class="info">
        <span class="title">${esc(r.title)}</span>
        <span class="author">${esc(r.authors)}${r.year ? ' · ' + esc(r.year) : ''}</span>
      </div>
      <div class="add">
        <button class="btn" data-i="${i}" data-to="reading">Läser</button>
        <button class="btn" data-i="${i}" data-to="shelf">Hyllan</button>
        <button class="btn" data-i="${i}" data-to="wishlist">Önskar</button>
      </div>
    </div>`).join('');
  el._results = results;
}

function addBook(data, to) {
  const isbn = normIsbn(data.isbn || '');
  const dup = books.find((b) =>
    (isbn && normIsbn(b.isbn || '') === isbn) ||
    (b.title.toLowerCase() === (data.title || '').toLowerCase() && (b.authors || '') === (data.authors || '')));
  if (dup) {
    toast(`”${dup.title}” finns redan – öppnar den`);
    $('#addDialog').close();
    openEdit(dup.id);
    return;
  }
  const b = {
    id: uid(),
    title: data.title || 'Utan titel',
    authors: data.authors || '',
    year: data.year || '',
    isbn: data.isbn || '',
    cover: data.cover || '',
    rating: 0,
    notes: '',
    addedAt: today(),
    startedAt: '',
    finishedAt: '',
    ...DEFAULTS[to],
  };
  if (b.reading === 'reading') b.startedAt = today();
  if (b.reading === 'read') b.finishedAt = today();
  books.push(b);
  save();
  currentTab = to;
  render();
  toast(`”${b.title}” tillagd`);
}

// ---------- Streckkodsskanning (där webbläsaren stödjer det) ----------
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
        const codes = await detector.detect(video);
        const code = codes.find((c) => /^97[89]\d{10}$/.test(c.rawValue));
        if (code) {
          stopScan();
          $('#q').value = code.rawValue;
          search(code.rawValue);
          return;
        }
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

// ---------- Redigera ----------
function openEdit(id) {
  const b = books.find((x) => x.id === id);
  editingId = id;
  const f = $('#editForm');
  const d = b || { title: '', authors: '', year: '', isbn: '', notes: '', rating: 0, ...DEFAULTS[currentTab] };
  $('#editTitle').textContent = b ? 'Redigera bok' : 'Ny bok';
  f.elements.title.value = d.title;
  f.elements.authors.value = d.authors;
  f.elements.year.value = d.year;
  f.elements.isbn.value = d.isbn;
  f.elements.notes.value = d.notes;
  f.elements.reading.value = d.reading;
  f.elements.owned.checked = d.owned;
  f.elements.wanted.checked = d.wanted;
  editRating = d.rating || 0;
  renderStars();
  const img = $('#editCover');
  img.hidden = !d.cover;
  if (d.cover) img.src = d.cover;
  $('#deleteBtn').hidden = !b;
  $('#editDialog').showModal();
}

function renderStars() {
  $('#stars').innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" data-n="${n}" class="${n <= editRating ? 'on' : ''}" aria-label="${n} stjärnor">★</button>`).join('');
}

function saveEdit() {
  const f = $('#editForm');
  const title = f.elements.title.value.trim();
  if (!title) return;
  let b = books.find((x) => x.id === editingId);
  if (!b) {
    b = { id: uid(), cover: '', addedAt: today(), startedAt: '', finishedAt: '' };
    books.push(b);
  }
  const prevReading = b.reading;
  Object.assign(b, {
    title,
    authors: f.elements.authors.value.trim(),
    year: f.elements.year.value.trim(),
    isbn: f.elements.isbn.value.trim(),
    notes: f.elements.notes.value.trim(),
    reading: f.elements.reading.value || 'none',
    owned: f.elements.owned.checked,
    wanted: f.elements.wanted.checked && !f.elements.owned.checked,
    rating: editRating,
  });
  if (b.reading === 'reading' && prevReading !== 'reading') b.startedAt = today();
  if (b.reading === 'read' && prevReading !== 'read') b.finishedAt = today();
  save();
  render();
}

// ---------- Export / import ----------
function exportData() {
  const blob = new Blob([JSON.stringify({ app: 'mina-bocker', version: 1, exportedAt: new Date().toISOString(), books }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mina-bocker-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.books;
    if (!Array.isArray(incoming)) throw new Error();
    const byId = new Map(books.map((b) => [b.id, b]));
    let added = 0;
    for (const b of incoming) {
      if (!b || !b.title) continue;
      if (!b.id) b.id = uid();
      if (!byId.has(b.id)) added++;
      byId.set(b.id, { reading: 'none', owned: false, wanted: false, rating: 0, ...b });
    }
    books = [...byId.values()];
    save();
    render();
    toast(`Import klar: ${added} nya, ${incoming.length - added} uppdaterade`);
  } catch {
    toast('Filen kunde inte läsas');
  }
}

// ---------- Övrigt ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function updateStats() {
  const year = String(new Date().getFullYear());
  const readThisYear = books.filter((b) => b.reading === 'read' && (b.finishedAt || '').startsWith(year)).length;
  $('#stats').textContent = `${books.length} böcker totalt · ${readThisYear} lästa i år`;
}

// ---------- Händelser ----------
document.querySelector('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  currentTab = btn.dataset.tab;
  render();
});

$('#filter').addEventListener('input', render);

$('#list').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const action = e.target.closest('button[data-action]');
  if (action) quickAction(card.dataset.id, action.dataset.action);
  else openEdit(card.dataset.id);
});
$('#list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('card')) openEdit(e.target.dataset.id);
});

$('#addBtn').addEventListener('click', () => {
  $('#q').value = '';
  $('#results').innerHTML = '';
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
  addBook($('#results')._results[+btn.dataset.i], btn.dataset.to);
  $('#addDialog').close();
});
$('#manualBtn').addEventListener('click', () => {
  const q = $('#q').value.trim();
  $('#addDialog').close();
  openEdit(null);
  if (q && !normIsbn(q)) $('#editForm').elements.title.value = q;
  else if (q) $('#editForm').elements.isbn.value = q;
});
if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
  $('#scanBtn').hidden = false;
  $('#scanBtn').addEventListener('click', startScan);
}

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
$('#editForm').elements.owned.addEventListener('change', (e) => {
  if (e.target.checked) $('#editForm').elements.wanted.checked = false;
});
$('#deleteBtn').addEventListener('click', () => {
  const b = books.find((x) => x.id === editingId);
  if (!b || !confirm(`Ta bort ”${b.title}”?`)) return;
  books = books.filter((x) => x.id !== editingId);
  save();
  render();
  $('#editDialog').close();
  toast('Boken borttagen');
});

$('#menuBtn').addEventListener('click', () => { updateStats(); $('#menuDialog').showModal(); });
$('#exportBtn').addEventListener('click', exportData);
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', (e) => {
  if (e.target.files[0]) importData(e.target.files[0]);
  e.target.value = '';
});

// Stäng dialoger genom att klicka utanför
document.querySelectorAll('dialog').forEach((d) =>
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

// Synka om data ändras i en annan flik
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) { books = load(); render(); }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
