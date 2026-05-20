// ─── Config ───────────────────────────────────────────────────────────────────

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzeEfsqfJ3-yPfw5g2JOiL1JxpM8_WMfGGBB2r8W6tI0hVFg1qKh4tuSPtYohoZB2J1/exec';

// ── DEV MODE ─────────────────────────────────────────────────
const DEV_MODE = false;

let searchQuery = '';
const DEV_EMAIL = 'amz.paopao@gmail.com';
const DEV_NAME = 'Pao Pao';
const ALL_COURSES = [
  { id: 'tgeo', badge: '🌍', title: 'TGeo Crash Course', desc: 'สรุปเนื้อหาครบ + ตะลุยโจทย์เข้มข้น เพื่อสอบ TGeo และคว้าเหรียญรางวัล', tapes: '51 Tapes', grad: 'linear-gradient(135deg,#ff8ade,#acfff3)', formLink: '#' },
  { id: 'geocamp1', badge: '🏕️', title: 'Geo Camp 1 Essentials', desc: 'เรียนภูมิศาสตร์ตั้งแต่ 0 ครอบคลุมทุก Head เหมาะสำหรับ Geo Camp 1', tapes: '56 Tapes', grad: 'linear-gradient(135deg,#acfff3,#ff8ade)', formLink: '#' },
  { id: 'tgeomock2026', badge: '📝', title: 'TGeo Mock Exam 2026', desc: 'ข้อสอบจำลอง WRT + MMT ครบทุกพาร์ท พร้อมเฉลยละเอียดทุกข้อ', tapes: '11 Tapes', grad: 'linear-gradient(135deg,#fbffa4,#acfff3)', formLink: '#' },
];

const HEAD_COLORS = {
  'Physical':  { bg: '#ff8ade18', border: '#ff8ade44', dot: '#ff8ade' },
  'Fieldwork': { bg: '#acfff318', border: '#acfff344', dot: '#00b4a0' },
  'Human':     { bg: '#fbffa418', border: '#fbffa444', dot: '#c9a700' },
  'Written':   { bg: '#c4b5fd18', border: '#a78bfa44', dot: '#7c3aed' },
  'INTRO':     { bg: '#fed7aa18', border: '#fb923c44', dot: '#ea6c00' },
  'WRT':       { bg: '#bbf7d018', border: '#4ade8044', dot: '#16a34a' },
  'MMT':       { bg: '#bae6fd18', border: '#38bdf844', dot: '#0284c7' },
  'Geographic':{ bg: '#f0abfc18', border: '#e879f944', dot: '#a21caf' },
  'Geo':       { bg: '#99f6e418', border: '#2dd4bf44', dot: '#0d9488' },
};

function getHeadColor(head) {
  for (const [key, val] of Object.entries(HEAD_COLORS)) {
    if (head && head.startsWith(key)) return val;
  }
  return { bg: '#f5f5f5', border: '#ddd', dot: '#bbb' };
}

// ─── State ────────────────────────────────────────────────────────────────────

let currentUser = null;
let studentData = null;
let contentRows = [];
let courseInfoData = [];
let checkedTapes = {};
let openHeads = {};
let openSubheads = {};
let videoModal = null;
let latestRequestId = 0; // [FIX] ตัวแปรป้องกัน Data Race

// ─── Utilities ────────────────────────────────────────────────────────────────

function parseGSheetJSON(raw) {
  const json = JSON.parse(raw.replace(/.*?\(/, '').replace(/\);\s*$/, ''));
  const cols = json.table.cols.map(c => c.label);
  return json.table.rows
    .filter(row => row.c && row.c.some(c => c && c.v != null))
    .map(row => {
      const obj = {};
      row.c.forEach((cell, i) => { obj[cols[i]] = cell?.v ?? ''; });
      return obj;
    });
}

function getDaysUntilExpiry(dateStr) {
  if (!dateStr) return null;
  const exp = new Date(dateStr);
  const now = new Date();
  return Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
}

function tapeKey(tape) { return `${tape.Course}_tape_${tape.TapeNo}`; }

// [FIX] แยก LocalStorage ของ Progress ตาม Email
function getStorageKey(email) {
  return `geojourney_progress_${(email || '').toLowerCase().trim()}`;
}

function loadProgress(email) {
  try { 
    const raw = localStorage.getItem(getStorageKey(email)); 
    checkedTapes = raw ? JSON.parse(raw) : {}; 
  } catch (e) { checkedTapes = {}; }
}

function saveProgress(email) {
  try { localStorage.setItem(getStorageKey(email), JSON.stringify(checkedTapes)); } catch (e) {}
}

function getYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function getDriveEmbedUrl(url) {
  if (!url) return null;
  const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return `https://drive.google.com/file/d/${m2[1]}/preview`;
  return url;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

function cacheKey(email) {
  return `geojourney_cache_${(email || '').toLowerCase().trim()}`;
}

function getCached(email) {
  try {
    const raw = localStorage.getItem(cacheKey(email));
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch (e) { return null; }
}

function setCache(email, data) {
  if (!data?.found) {
    clearCache(email); // [FIX] ไม่จำค่า Cache ตอน Error
    return;
  }
  try {
    localStorage.setItem(cacheKey(email), JSON.stringify({ data, ts: Date.now() }));
  } catch (e) {}
}

function clearCache(email) {
  try { localStorage.removeItem(cacheKey(email)); } catch (e) {}
}

// ─── Single fetch using getAll ────────────────────────────────────────────────

async function fetchAll(email) {
  const res = await fetch(`${APPS_SCRIPT_URL}?action=getAll&email=${encodeURIComponent(email)}`);
  const data = await res.json();
  return data;
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function showScreen(html) {
  const app = document.getElementById('app');
  app.style.transition = 'opacity 0.2s ease-in-out';
  app.style.opacity = '0';
  setTimeout(() => {
    app.innerHTML = '';
    if (typeof html === 'string') app.innerHTML = html;
    else app.appendChild(html);
    app.style.opacity = '1';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, 120);
}

// ─── Last watched ─────────────────────────────────────────────────────────────

const LAST_WATCHED_KEY = 'geojourney_last_watched';

function saveLastWatched(tape) {
  try {
    localStorage.setItem(LAST_WATCHED_KEY, JSON.stringify({
      tapeNo: tape.TapeNo, title: tape.Title || `Tape ${tape.TapeNo}`,
      subHead: tape['Sub-Head'] || '', course: tape.Course || '',
    }));
  } catch (e) {}
}

function getLastWatched() {
  try { return JSON.parse(localStorage.getItem(LAST_WATCHED_KEY)); } catch (e) { return null; }
}

// ─── Viewer page ──────────────────────────────────────────────────────────────

function renderViewer(tape, allTapes) {
  const subTapes = allTapes.filter(t => t['Sub-Head'] === tape['Sub-Head']);
  let startIdx = subTapes.findIndex(t => tapeKey(t) === tapeKey(tape));
  if (startIdx < 0) startIdx = 0;

  function buildPage(currentTape, currentIdx) {
    const isDoneCurrent = !!checkedTapes[tapeKey(currentTape)];

    const page = el('div', { className: 'fade-up viewer-page-wrap', style: { maxWidth: '1100px', margin: '0 auto', padding: '28px 24px 80px' } });

    const topbar = el('div', { className: 'viewer-topbar' });

    const backBtn = el('button', { onClick: () => { cleanup(); renderDashboard(); }, className: 'btn-back' });
    backBtn.innerHTML = `<span style="font-size:15px">←</span> กลับ`;

    const titleArea = el('div', { className: 'viewer-title-bar' });
    const metaLine = el('div', { className: 'viewer-meta', style: { display: 'flex', alignItems: 'center', gap: '8px' } });
    const tapePill = el('span', { style: { padding: '2px 10px', borderRadius: '100px', background: 'linear-gradient(135deg,#ff8ade22,#acfff322)', border: '1px solid #ff8ade44', color: '#c44f9a', fontSize: '11px', fontWeight: '700' } }, `Tape ${currentTape.TapeNo}`);
    metaLine.appendChild(tapePill);
    metaLine.appendChild(document.createTextNode(currentTape['Sub-Head'] || currentTape.Head || ''));
    const titleText = el('div', { className: 'viewer-title-text' }, currentTape.Title || `Tape ${currentTape.TapeNo}`);
    titleArea.appendChild(metaLine);
    titleArea.appendChild(titleText);

    const doneCount = subTapes.filter(t => checkedTapes[tapeKey(t)]).length;
    const counterBadge = el('div', { style: { padding: '6px 14px', borderRadius: '100px', background: '#f5f5f5', fontSize: '12px', color: '#888', fontWeight: '600', flexShrink: '0' } }, `${doneCount}/${subTapes.length} เทป`);

    topbar.appendChild(backBtn);
    topbar.appendChild(titleArea);
    topbar.appendChild(counterBadge);
    page.appendChild(topbar);

    const card = el('div', { className: 'viewer-body' });

    const videoSide = el('div', { className: 'video-side' });

    const loadingDiv = el('div', { className: 'vl-loading', style: { position: 'relative', overflow: 'hidden', width: '100%', height: '100%', justifyContent: 'center' } });
    loadingDiv.innerHTML = `
      <div style="position:absolute;inset:0;overflow:hidden;pointer-events:none">
        <div style="position:absolute;top:-60px;left:-60px;width:260px;height:260px;border-radius:50%;background:radial-gradient(circle,#ff8ade18 0%,transparent 70%)"></div>
        <div style="position:absolute;bottom:-40px;right:-40px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,#acfff318 0%,transparent 70%)"></div>
      </div>
      <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:0;text-align:center;max-width:320px">
        <div style="position:relative;width:72px;height:72px;margin-bottom:28px">
          <svg width="72" height="72" viewBox="0 0 72 72" fill="none" style="animation:vlSpin .9s linear infinite;position:absolute;inset:0">
            <circle cx="36" cy="36" r="32" stroke="#ffffff06" stroke-width="3"/>
            <path d="M36 4 a32 32 0 0 1 32 32" stroke="url(#vlg3)" stroke-width="3" stroke-linecap="round"/>
            <defs><linearGradient id="vlg3" x1="36" y1="4" x2="68" y2="36" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#ff8ade"/><stop offset="100%" stop-color="#acfff3"/></linearGradient></defs>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px">🎬</div>
        </div>
        <div style="padding:3px 14px;border-radius:100px;background:linear-gradient(135deg,#ff8ade22,#acfff222);border:1px solid #ff8ade33;font-size:11px;font-weight:700;color:#ff8ade;letter-spacing:.5px;margin-bottom:12px">TAPE ${currentTape.TapeNo}</div>
        <div style="font-size:17px;font-weight:700;color:#ffffff;line-height:1.4;font-family:'Playfair Display',serif;margin-bottom:8px">${currentTape.Title || `Tape ${currentTape.TapeNo}`}</div>
        <div style="font-size:12px;color:#ffffff55;margin-bottom:24px">${currentTape['Sub-Head'] || currentTape.Head || ''}</div>
        <div class="vl-dots" style="display:flex;gap:6px"><span></span><span></span><span></span></div>
      </div>
    `;
    videoSide.appendChild(loadingDiv);

    const iframeWrap = el('div', { className: 'vl-iframe-wrap' });
    iframeWrap.style.cssText = 'display:none;position:absolute;inset:0;width:100%;height:100%;';
    videoSide.appendChild(iframeWrap);
    card.appendChild(videoSide);

    const sidebar = el('div', { className: 'vl-playlist' });
    const sideHead = el('div', { style: { padding: '16px 16px 12px', borderBottom: '1px solid #f5f5f5', background: 'linear-gradient(135deg,#ff8ade08,#acfff310)', flexShrink: '0' } });
    sideHead.appendChild(el('div', { style: { fontSize: '10px', fontWeight: '700', color: '#c44f9a', textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: '4px' } }, 'Playlist'));
    sideHead.appendChild(el('div', { style: { fontSize: '13px', fontWeight: '700', color: '#1a1a2e', lineHeight: '1.3' } }, currentTape['Sub-Head'] || currentTape.Head || ''));
    const sideProg = el('div', { style: { marginTop: '10px', height: '3px', background: '#eee', borderRadius: '100px', overflow: 'hidden' } });
    sideProg.appendChild(el('div', { style: { height: '100%', borderRadius: '100px', background: 'linear-gradient(90deg,#ff8ade,#acfff3)', width: `${subTapes.length > 0 ? Math.round((doneCount / subTapes.length) * 100) : 0}%` } }));
    sideHead.appendChild(sideProg);
    sidebar.appendChild(sideHead);

    const plList = el('div', { style: { flex: '1', overflowY: 'auto' } });
    subTapes.forEach((t, i) => {
      const isDone = !!checkedTapes[tapeKey(t)];
      const isActive = i === currentIdx;
      const item = el('div', { className: `vl-pl-item ${isActive ? 'active' : ''}` });
      if (isActive) {
        item.style.borderLeft = '3px solid #ff8ade';
      } else {
        item.style.borderLeft = '3px solid transparent';
      }
      const statusIcon = el('div', { style: { width: '22px', height: '22px', borderRadius: '50%', flexShrink: '0', marginTop: '1px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: '700', background: isDone ? '#00b4a015' : isActive ? '#ff8ade22' : '#f5f5f5', border: `1.5px solid ${isDone ? '#00b4a0' : isActive ? '#ff8ade' : '#e0e0e0'}`, color: isDone ? '#00b4a0' : isActive ? '#ff8ade' : '#ccc' } }, isDone ? '✓' : isActive ? '▶' : `${i + 1}`);
      const tText = el('div', { className: 'vl-pl-text' });
      tText.appendChild(el('div', { className: 'vl-pl-no' }, `Tape ${t.TapeNo}`));
      tText.appendChild(el('div', { className: 'vl-pl-name', style: { color: isActive ? '#1a1a2e' : '#444', fontWeight: isActive ? '600' : '400', wordBreak: 'break-word' } }, t.Title || `Tape ${t.TapeNo}`));
      item.appendChild(statusIcon);
      item.appendChild(tText);
      item.addEventListener('click', () => {
        saveLastWatched(t);
        showScreen(buildPage(t, i));
        setTimeout(() => loadVideo(t, document.querySelector('.vl-iframe-wrap'), document.querySelector('.vl-loading')), 160);
      });
      plList.appendChild(item);
    });
    sidebar.appendChild(plList);
    card.appendChild(sidebar);
    page.appendChild(card);

    const footer = el('div', { className: 'viewer-footer' });
    const footerLeft = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } });
    const navBtns = el('div', { className: 'vl-nav-btns' });

    const prevBtn = el('button', { className: 'btn-nav-vl vl-nav-prev' }, '←');
    prevBtn.disabled = currentIdx <= 0;
    prevBtn.addEventListener('click', () => {
      if (currentIdx > 0) { const prev = subTapes[currentIdx - 1]; saveLastWatched(prev); showScreen(buildPage(prev, currentIdx - 1)); setTimeout(() => loadVideo(prev, document.querySelector('.vl-iframe-wrap'), document.querySelector('.vl-loading')), 160); }
    });

    const nextBtn = el('button', { className: 'btn-nav-vl vl-nav-next' }, '→');
    nextBtn.disabled = currentIdx >= subTapes.length - 1;
    nextBtn.addEventListener('click', () => {
      if (currentIdx < subTapes.length - 1) { const next = subTapes[currentIdx + 1]; saveLastWatched(next); showScreen(buildPage(next, currentIdx + 1)); setTimeout(() => loadVideo(next, document.querySelector('.vl-iframe-wrap'), document.querySelector('.vl-loading')), 160); }
    });

    navBtns.appendChild(prevBtn);
    navBtns.appendChild(nextBtn);
    const tapeCounter = el('div', { style: { fontSize: '13px', color: '#aaa' } });
    tapeCounter.innerHTML = `<span style="color:#1a1a2e;font-weight:600">${currentIdx + 1}</span> / ${subTapes.length}`;
    footerLeft.appendChild(navBtns);
    footerLeft.appendChild(tapeCounter);

    const doneBtn = el('button', { className: 'btn-done-vl' }, isDoneCurrent ? '✓ Done' : '✓ Mark as done');
    if (isDoneCurrent) {
       doneBtn.style.background = 'linear-gradient(135deg,#acfff3,#00b4a0)';
    } else {
       doneBtn.style.background = 'linear-gradient(135deg,#ff8ade,#acfff3)';
    }
    doneBtn.addEventListener('click', () => {
      toggleTape(tapeKey(currentTape), currentTape, allTapes, currentUser.email);
      const done = !!checkedTapes[tapeKey(currentTape)];
      doneBtn.textContent = done ? '✓ Done' : '✓ Mark as done';
      doneBtn.style.background = done ? 'linear-gradient(135deg,#acfff3,#00b4a0)' : 'linear-gradient(135deg,#ff8ade,#acfff3)';
    });

    footer.appendChild(footerLeft);
    footer.appendChild(doneBtn);
    page.appendChild(footer);
    return page;
  }

  saveLastWatched(tape);

  function keyHandler(e) {
    if (e.key === 'Escape') { cleanup(); renderDashboard(); }
    if (e.key === 'ArrowRight') document.querySelector('.vl-nav-next')?.click();
    if (e.key === 'ArrowLeft')  document.querySelector('.vl-nav-prev')?.click();
  }
  function cleanup() { document.removeEventListener('keydown', keyHandler); }
  document.addEventListener('keydown', keyHandler);

  showScreen(buildPage(tape, startIdx));
  setTimeout(() => { loadVideo(tape, document.querySelector('.vl-iframe-wrap'), document.querySelector('.vl-loading')); }, 160);
}

function loadVideo(tape, iframeWrap, loadingDiv) {
  if (!iframeWrap || !loadingDiv) return;
  const ytId = getYouTubeId(tape.DriveLink);
  const src = ytId ? `https://www.youtube.com/embed/${ytId}?autoplay=1` : getDriveEmbedUrl(tape.DriveLink);

  if (!src) {
    loadingDiv.style.display = 'none';
    iframeWrap.style.display = 'flex';
    iframeWrap.innerHTML = `<div class="vl-no-video"><div style="font-size:44px">🎬</div><p>ยังไม่มีลิงก์วิดีโอสำหรับ Tape นี้</p></div>`;
    return;
  }

  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
  iframe.setAttribute('allowfullscreen', 'true');

  if (ytId) {
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
    const reveal = () => { loadingDiv.style.display = 'none'; iframeWrap.style.display = 'block'; };
    iframe.addEventListener('load', reveal);
    setTimeout(reveal, 3000);
    iframeWrap.innerHTML = '';
    iframeWrap.appendChild(iframe);
  } else {
    iframe.style.cssText = 'width:100%;height:calc(100% + 100px);border:none;display:block;margin-top:-100px;';
    const cropWrap = document.createElement('div');
    cropWrap.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
    cropWrap.appendChild(iframe);
    loadingDiv.style.display = 'none';
    iframeWrap.style.display = 'block';
    iframeWrap.innerHTML = '';
    iframeWrap.appendChild(cropWrap);
  }
}

// ─── Modal (legacy) ───────────────────────────────────────────────────────────

function openModal(tape) {
  videoModal = tape;
  const ytId = getYouTubeId(tape.DriveLink);
  const backdrop = el('div', { className: 'modal-backdrop', onClick: (e) => { if (e.target === backdrop) closeModal(); } });
  const box = el('div', { className: 'modal-box' });
  const header = el('div', { className: 'modal-header' });
  const info = el('div', {});
  info.appendChild(el('div', { className: 'modal-tape-meta' }, `Tape ${tape.TapeNo} · ${tape['Sub-Head']}`));
  info.appendChild(el('div', { className: 'modal-tape-title' }, tape.Title));
  header.appendChild(info);
  header.appendChild(el('button', { className: 'modal-close', onClick: closeModal }, '✕'));
  box.appendChild(header);
  const videoArea = el('div', { className: 'modal-video' });
  if (ytId) {
    videoArea.appendChild(el('iframe', { src: `https://www.youtube.com/embed/${ytId}?autoplay=1`, allow: 'autoplay; encrypted-media', allowfullscreen: 'true' }));
  } else if (tape.DriveLink) {
    const noVid = el('div', { className: 'modal-no-video' });
    noVid.innerHTML = `<div class="icon">▶</div><p>Opens in a new tab</p><a class="modal-open-link" href="${tape.DriveLink}" target="_blank" rel="noopener noreferrer">Open Video →</a>`;
    videoArea.appendChild(noVid);
  } else {
    const noVid = el('div', { className: 'modal-no-video' });
    noVid.innerHTML = `<div class="icon">🎬</div><p style="color:#888">Video link not yet added</p>`;
    videoArea.appendChild(noVid);
  }
  box.appendChild(videoArea);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onEscKey);
}

function closeModal() {
  const backdrop = document.querySelector('.modal-backdrop');
  if (backdrop) backdrop.remove();
  document.removeEventListener('keydown', onEscKey);
  videoModal = null;
}

function onEscKey(e) { if (e.key === 'Escape') closeModal(); }

// ─── Progress bar ─────────────────────────────────────────────────────────────

function buildProgressBar(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const card = el('div', { className: 'progress-card' });
  card.innerHTML = `
    <div class="progress-header">
      <div><div class="progress-label">Overall Progress</div><div class="progress-pct">${pct}% <span>complete</span></div></div>
      <div class="progress-count"><strong>${done}</strong>/${total} tapes</div>
    </div>
    <div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:${pct}%"></div></div>
    ${pct === 100 ? '<div class="progress-complete">🎉 Course complete! Outstanding work!</div>' : ''}
  `;
  return card;
}

function updateProgressBar(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const fill = document.getElementById('progress-fill');
  const pctEl = document.querySelector('.progress-pct');
  const cntEl = document.querySelector('.progress-count');
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.innerHTML = `${pct}% <span>complete</span>`;
  if (cntEl) cntEl.innerHTML = `<strong>${done}</strong>/${total} tapes`;
}

function safeId(str) { return str.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '_'); }

function updateAllProgressUI(allTapes) {
  const purchasedIds = studentData?.courses || [];
  const totalDone = allTapes.filter(t => checkedTapes[tapeKey(t)]).length;
  updateProgressBar(totalDone, allTapes.length);

  const courseGroups = {};
  allTapes.forEach(t => { const c = (t.Course || 'general').toLowerCase().trim(); if (!courseGroups[c]) courseGroups[c] = []; courseGroups[c].push(t); });
  purchasedIds.forEach(cid => {
    const ct = courseGroups[cid] || [];
    if (!ct.length) return;
    const done = ct.filter(t => checkedTapes[tapeKey(t)]).length;
    const pct = Math.round((done / ct.length) * 100);
    const pctEl = document.getElementById(`cpct-${cid}`);
    const subEl = document.getElementById(`csub-${cid}`);
    const barEl = document.getElementById(`cbar-${cid}`);
    if (pctEl) { pctEl.textContent = pct === 100 ? '✓ Complete' : `${pct}%`; pctEl.style.background = pct === 100 ? 'linear-gradient(135deg,#acfff3,#00b4a0)' : 'linear-gradient(135deg,#ff8ade22,#acfff322)'; pctEl.style.color = pct === 100 ? '#1a1a2e' : '#c44f9a'; pctEl.style.border = pct === 100 ? 'none' : '1px solid #ff8ade33'; }
    if (subEl) subEl.textContent = `${done} / ${ct.length} tapes completed`;
    if (barEl) { barEl.style.width = `${pct}%`; barEl.style.transition = 'width 0.4s ease'; }
  });

  const headGroups = {};
  allTapes.forEach(t => { const h = t.Head || 'General'; if (!headGroups[h]) headGroups[h] = []; headGroups[h].push(t); });
  Object.entries(headGroups).forEach(([h, tapes]) => {
    const done = tapes.filter(t => checkedTapes[tapeKey(t)]).length;
    const e = document.getElementById(`hcount-${safeId(h)}`);
    if (!e) return;
    e.textContent = done === tapes.length ? `${done}/${tapes.length} ✓` : `${done}/${tapes.length}`;
    e.style.color = done === tapes.length ? '#00b4a0' : done > 0 ? '#c44f9a' : '';
  });

  const shGroups = {};
  allTapes.forEach(t => { const sh = t['Sub-Head'] || 'General'; if (!shGroups[sh]) shGroups[sh] = []; shGroups[sh].push(t); });
  Object.entries(shGroups).forEach(([sh, tapes]) => {
    const done = tapes.filter(t => checkedTapes[tapeKey(t)]).length;
    const e = document.getElementById(`shcount-${safeId(sh)}`);
    if (!e) return;
    e.textContent = done === tapes.length ? `${done}/${tapes.length} ✓` : `${done}/${tapes.length}`;
    e.style.color = done === tapes.length ? '#00b4a0' : done > 0 ? '#c44f9a' : '';
  });
}

// ─── Search Auto-Complete Suggestions ─────────────────────────────────────────

function showSuggestions(q, allTapes) {
  const box = document.getElementById('search-suggestions');
  if (!box) return;

  const query = q.toLowerCase().trim();
  if (!query) { box.style.display = 'none'; return; }

  let courseSugs = [];
  let topicSugs = [];
  const terms = query.split(/\s+/).filter(Boolean);

  const courses = [...new Set(allTapes.map(t => (t.Course || '').toLowerCase().trim()))].filter(Boolean);
  const subheads = [...new Set(allTapes.map(t => (t['Sub-Head'] || '').trim()))].filter(Boolean);

  const exactCourse = courses.find(c => c === terms[0]);

  if (exactCourse) {
     const lastTerm = terms.length > 1 ? terms[terms.length - 1] : '';
     if (/\d/.test(lastTerm)) {
        allTapes.filter(t => (t.Course || '').toLowerCase() === exactCourse && String(t.TapeNo).startsWith(lastTerm))
                .slice(0, 4)
                .forEach(t => courseSugs.push({ text: `${exactCourse} ${t.TapeNo}`, type: 'Tape' }));
     } else {
        courseSugs.push({ text: `${exactCourse} 1`, type: 'Guide' });
     }
  }

  courses.forEach(c => {
    if (c.includes(query) && c !== query && !courseSugs.find(s => s.text === c)) {
      courseSugs.push({ text: c, type: 'Course' });
    }
  });

  subheads.forEach(sh => {
    if (sh.toLowerCase().includes(query) && !topicSugs.find(s => s.text === sh)) {
      topicSugs.push({ text: sh, type: 'Topic' });
    }
  });

  const suggestions = [...courseSugs, ...topicSugs].slice(0, 6);

  if (suggestions.length === 0) { box.style.display = 'none'; return; }

  box.innerHTML = '';
  const safeTerms = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${safeTerms.join('|')})`, 'gi');

  suggestions.forEach(s => {
    const item = el('div', { className: 'sug-item' });
    const icon = s.type === 'Course' ? '📚' : (s.type === 'Topic' ? '💡' : '🎬'); 
    const highlighted = s.text.replace(regex, '<span style="color:#ff8ade;font-weight:700">$1</span>');
    
    item.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:14px;color:#aaa">${icon}</span>
        <span>${highlighted}</span>
      </div>
      <span style="font-size:10px;color:#888;background:#f5f5f5;padding:3px 8px;border-radius:100px;font-weight:600">${s.type}</span>
    `;
    
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const input = document.getElementById('tape-search');
      input.value = s.text;
      box.style.display = 'none';
      filterTapes(s.text);
      input.focus();
    });
    box.appendChild(item);
  });
  box.style.display = 'block';
}

// ─── Filter Logic ─────────────────────────────────────────────────────────────

function filterTapes(q) {
  searchQuery = q.toLowerCase().trim();
  const queryTerms = searchQuery.split(/\s+/).filter(Boolean); 
  const rows = document.querySelectorAll('.tape-row');
  let visible = 0;

  rows.forEach(row => {
    const searchData = row.dataset.search || '';
    const match = queryTerms.length === 0 || queryTerms.every(term => searchData.includes(term));
    
    row.style.display = match ? '' : 'none'; 
    if (match) visible++;

    if (queryTerms.length > 0 && match) {
      const subheadBody = row.closest('.subhead-body');
      if (subheadBody && subheadBody.style.display === 'none') {
        const subheadHeader = subheadBody.previousElementSibling;
        if (subheadHeader) subheadHeader.click(); 
      }

      const headBody = row.closest('.head-body');
      if (headBody && headBody.style.display === 'none') {
        const headHeader = headBody.previousElementSibling;
        if (headHeader) headHeader.click();
      }
    }
  });

  const cnt = document.getElementById('search-count');
  if (cnt) cnt.textContent = searchQuery ? `${visible} result${visible !== 1 ? 's' : ''}` : '';
}

// ─── Build Components ─────────────────────────────────────────────────────────

function buildTapeRow(tape, allTapes, email) {
  const key = tapeKey(tape);
  const isDone = !!checkedTapes[key];
  const row = el('div', { className: `tape-row${isDone ? ' done' : ''}` });
  
  row.dataset.search = `${tape.Course || ''} tape ${tape.TapeNo} ${tape.Title || ''} ${tape['Sub-Head'] || ''} ${tape.Head || ''}`.toLowerCase();

  const cb = el('div', { className: `tape-checkbox${isDone ? ' checked' : ''}` }, isDone ? '✓' : '');
  cb.addEventListener('click', (e) => { e.stopPropagation(); toggleTape(key, tape, allTapes, email); });
  row.appendChild(cb);

  const info = el('div', { className: 'tape-info' });
  info.appendChild(el('div', { className: 'tape-num' }, `Tape ${tape.TapeNo}`));
  info.appendChild(el('div', { className: 'tape-title' }, tape.Title || `Tape ${tape.TapeNo}`));
  row.appendChild(info);

  const hasVideo = !!tape.DriveLink && tape.DriveLink.startsWith('http');
  const hasPDF = !!tape.PDFLink && tape.PDFLink.startsWith('http');

  if (hasVideo) row.appendChild(el('button', { className: 'btn-watch', onClick: (e) => { e.stopPropagation(); renderViewer(tape, allTapes); } }, '▶ Watch'));
  if (hasPDF) row.appendChild(el('button', { className: 'btn-pdf', onClick: (e) => { e.stopPropagation(); window.open(tape.PDFLink, '_blank', 'noopener'); } }, '📄 PDF'));
  if (!hasVideo && !hasPDF) row.appendChild(el('button', { className: 'btn-watch btn-watch-disabled' }, '▶ Watch'));

  row.addEventListener('click', () => toggleTape(key, tape, allTapes, email));
  return row;
}

function toggleTape(key, tape, allTapes, email) {
  checkedTapes[key] = !checkedTapes[key];
  saveProgress(email);
  document.querySelectorAll('.tape-row').forEach(row => {
    const cb = row.querySelector('.tape-checkbox');
    const title = row.querySelector('.tape-title');
    const num = row.querySelector('.tape-num');
    if (num && title && num.textContent === `Tape ${tape.TapeNo}` && title.textContent === (tape.Title || `Tape ${tape.TapeNo}`)) {
      const done = !!checkedTapes[key];
      row.classList.toggle('done', done);
      cb.classList.toggle('checked', done);
      cb.textContent = done ? '✓' : '';
    }
  });
  updateAllProgressUI(allTapes);
}

function buildSubheadBlock(subHead, tapes, allTapes, email) {
  const key = `subhead_${subHead}`;
  const isOpen = !!openSubheads[key];
  const doneCount = tapes.filter(t => checkedTapes[tapeKey(t)]).length;

  const block = el('div', { className: 'subhead-block' });
  const header = el('div', { className: 'subhead-header' });
  const left = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '1', minWidth: '0' } });
  left.appendChild(el('span', { className: 'subhead-title' }, subHead));
  const right = el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: '0' } });
  right.appendChild(el('span', { id: `shcount-${safeId(subHead)}`, style: { fontSize: '11px', fontWeight: '700', padding: '2px 8px', borderRadius: '100px', color: doneCount > 0 ? '#00b4a0' : '#aaa', background: doneCount > 0 ? '#acfff322' : 'transparent' } }, doneCount > 0 ? `${doneCount}/${tapes.length} ✓` : `${tapes.length} tape${tapes.length > 1 ? 's' : ''}`));
  const chevron = el('span', { className: `subhead-chevron${isOpen ? ' open' : ''}` }, '⌄');
  right.appendChild(chevron);
  header.appendChild(left);
  header.appendChild(right);

  const body = el('div', { className: 'subhead-body', style: { display: isOpen ? 'flex' : 'none' } });
  tapes.forEach(tape => body.appendChild(buildTapeRow(tape, allTapes, email)));

  header.addEventListener('click', () => {
    openSubheads[key] = !openSubheads[key];
    body.style.display = openSubheads[key] ? 'flex' : 'none';
    chevron.classList.toggle('open', !!openSubheads[key]);
  });

  block.appendChild(header);
  block.appendChild(body);
  return block;
}

function buildHeadBlock(head, tapes, allTapes, email) {
  const key = `head_${head}`;
  const isOpen = !!openHeads[key];
  const colors = getHeadColor(head);
  const doneCount = tapes.filter(t => checkedTapes[tapeKey(t)]).length;

  const block = el('div', { className: 'head-block' });
  const header = el('div', { className: 'head-header', style: { background: colors.bg, borderBottom: isOpen ? `1px solid ${colors.border}` : 'none' } });

  const titleWrap = el('div', { className: 'head-title' });
  titleWrap.appendChild(el('span', { className: 'head-dot', style: { background: colors.dot } }));
  titleWrap.appendChild(document.createTextNode(head));

  const meta = el('div', { className: 'head-meta' });
  const countBadge = el('span', { id: `hcount-${safeId(head)}`, className: 'head-count' }, `${doneCount}/${tapes.length}`);
  const chevron = el('span', { className: `head-chevron${isOpen ? ' open' : ''}` }, '⌄');
  meta.appendChild(countBadge);
  meta.appendChild(chevron);
  header.appendChild(titleWrap);
  header.appendChild(meta);

  const body = el('div', { className: 'head-body', style: { display: isOpen ? 'block' : 'none', paddingTop: '12px' } });
  const subHeads = {};
  tapes.forEach(tape => { const sh = tape['Sub-Head'] || 'General'; if (!subHeads[sh]) subHeads[sh] = []; subHeads[sh].push(tape); });
  Object.entries(subHeads).sort(([, a], [, b]) => Number(a[0].TapeNo) - Number(b[0].TapeNo)).forEach(([sh, shTapes]) => body.appendChild(buildSubheadBlock(sh, shTapes, allTapes, email)));

  header.addEventListener('click', () => {
    openHeads[key] = !openHeads[key];
    body.style.display = openHeads[key] ? 'block' : 'none';
    header.style.borderBottom = openHeads[key] ? `1px solid ${colors.border}` : 'none';
    chevron.classList.toggle('open', !!openHeads[key]);
  });

  block.appendChild(header);
  block.appendChild(body);
  return block;
}

// ─── Main dashboard render ────────────────────────────────────────────────────

function renderDashboard() {
  const purchasedIds = studentData?.courses || [];
  const allTapes = contentRows;
  const doneTapes = allTapes.filter(t => checkedTapes[tapeKey(t)]).length;
  const page = el('div', { className: 'page fade-up' });

  const userHeader = el('div', { className: 'user-header' });
  const userInfo = el('div', { className: 'user-info' });
  userInfo.innerHTML = `<div class="user-avatar">😊</div><div><div class="user-name">${currentUser.name}</div><div class="user-email">${currentUser.email}</div></div>`;
  const actions = el('div', { className: 'user-actions' });
  purchasedIds.forEach(id => actions.appendChild(el('span', { className: 'course-badge' }, `${id.toUpperCase()} ✓`)));
  actions.appendChild(el('button', { className: 'btn-ghost', onClick: handleSignOut }, 'Sign out'));
  userHeader.appendChild(userInfo);
  userHeader.appendChild(actions);
  page.appendChild(userHeader);

  if (studentData?.expireDate) {
    const days = getDaysUntilExpiry(studentData.expireDate);
    if (days !== null && days <= 30) {
      const danger = days <= 7;
      const banner = el('div', { className: `expiry-warning${danger ? ' expiry-danger' : ''}` });
      banner.innerHTML = `<span style="font-size:18px">${danger ? '🚨' : '⚠️'}</span><span>${danger ? `Access expires in ${days} day${days !== 1 ? 's' : ''}! Please renew soon.` : `Access expires on ${studentData.expireDate} (${days} days remaining).`}</span>`;
      page.appendChild(banner);
    }
  }

  const pillWrap = el('div', {});
  pillWrap.appendChild(el('span', { className: 'section-pill' }, 'My Courses'));
  const h1 = el('h1', { className: 'section-title' }, 'Your Learning Content');
  if (studentData?.expireDate) {
    const expLine = el('p', { style: { color: '#888', fontSize: '14px', marginTop: '4px', marginBottom: '20px' } });
    expLine.innerHTML = `Access expires: <strong style="color:#c44f9a">${studentData.expireDate}</strong>`;
    pillWrap.appendChild(h1);
    pillWrap.appendChild(expLine);
  } else {
    pillWrap.appendChild(h1);
  }
  page.appendChild(pillWrap);
  page.appendChild(buildProgressBar(doneTapes, allTapes.length));

  const lastW = getLastWatched();
  if (lastW && allTapes.find(t => String(t.TapeNo) === String(lastW.tapeNo))) {
    const tape = allTapes.find(t => String(t.TapeNo) === String(lastW.tapeNo));
    const banner = el('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 20px', borderRadius: '16px', marginBottom: '24px', background: 'linear-gradient(135deg,#ff8ade0d,#acfff318)', border: '1px solid #ff8ade33', cursor: 'pointer' }, onClick: () => renderViewer(tape, allTapes) });
    banner.innerHTML = `<div style="font-size:22px">▶️</div><div style="flex:1;min-width:0"><div style="font-size:11px;color:#c44f9a;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">Continue Watching</div><div style="font-size:13px;font-weight:600;color:#1a1a2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Tape ${lastW.tapeNo} · ${lastW.title}</div></div><div style="font-size:12px;color:#ff8ade;font-weight:600;flex-shrink:0">Watch →</div>`;
    page.appendChild(banner);
  }

  // ── Search Wrap with Suggestions ──
  const searchWrap = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px', position: 'relative' } });
  const searchInput = el('input', { type: 'text', placeholder: '🔍 พิมพ์ชื่อคอร์ส หรือหัวข้อ (เช่น tgeo 1, mock)', id: 'tape-search', autocomplete: 'off' });
  searchInput.className = 'tape-search-input';
  searchInput.value = searchQuery;

  const searchSuggestions = el('div', { id: 'search-suggestions', style: { display: 'none' } });

  searchInput.addEventListener('input', e => {
    filterTapes(e.target.value);
    showSuggestions(e.target.value, allTapes);
  });

  document.addEventListener('click', (e) => {
    if (!searchWrap.contains(e.target)) {
      const box = document.getElementById('search-suggestions');
      if (box) box.style.display = 'none';
    }
  });

  const searchCount = el('span', { id: 'search-count', style: { fontSize: '12px', color: '#aaa', flexShrink: '0' } });
  if (searchQuery) searchCount.textContent = '...';
  
  searchWrap.appendChild(searchInput);
  searchWrap.appendChild(searchCount);
  searchWrap.appendChild(searchSuggestions);
  page.appendChild(searchWrap);

  if (allTapes.length === 0) {
    const empty = el('div', { className: 'empty-state' });
    empty.innerHTML = `<div class="icon">📂</div><p>Content will appear here once uploaded. Check back soon!</p>`;
    page.appendChild(empty);
  } else {
    const courseGroups = {};
    allTapes.forEach(tape => { const c = (tape.Course || 'general').toLowerCase().trim(); if (!courseGroups[c]) courseGroups[c] = []; courseGroups[c].push(tape); });
    const orderedCourseIds = purchasedIds.length > 0 ? purchasedIds : Object.keys(courseGroups);

    orderedCourseIds.forEach((courseId, ci) => {
      const courseTapes = courseGroups[courseId];
      if (!courseTapes || courseTapes.length === 0) return;
      const courseInfo = ALL_COURSES.find(c => c.id === courseId);
      const doneCount = courseTapes.filter(t => checkedTapes[tapeKey(t)]).length;
      const pct = Math.round((doneCount / courseTapes.length) * 100);
      const gradColors = { tgeo: { bg: '#ff8ade12', border: '#ff8ade33' }, geocamp: { bg: '#acfff312', border: '#acfff333' }, geocamp1: { bg: '#acfff312', border: '#acfff333' }, tgeomock: { bg: '#fbffa412', border: '#fbffa433' }, tgeomock2026: { bg: '#fbffa412', border: '#fbffa433' } };
      const gradColor = gradColors[courseId] || { bg: '#f5f5f5', border: '#e0e0e0' };

      const section = el('div', { style: { marginTop: ci === 0 ? '0' : '48px', marginBottom: '20px' } });
      const hRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '14px', padding: '16px 20px', background: gradColor.bg, border: `1px solid ${gradColor.border}`, borderRadius: '16px' } });
      hRow.appendChild(el('div', { style: { width: '44px', height: '44px', borderRadius: '14px', flexShrink: '0', background: courseInfo?.grad || 'linear-gradient(135deg,#ff8ade,#acfff3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', boxShadow: '0 4px 12px rgba(255,138,222,0.25)' } }, courseInfo?.badge || '📚'));
      const infoCol = el('div', { style: { flex: '1', minWidth: '0' } });
      infoCol.appendChild(el('div', { style: { fontSize: '17px', fontWeight: '700', fontFamily: "'Playfair Display',serif", color: '#1a1a2e' } }, courseInfo?.title || courseId.toUpperCase()));
      infoCol.appendChild(el('div', { id: `csub-${courseId}`, style: { fontSize: '12px', color: '#aaa', marginTop: '2px' } }, `${doneCount} / ${courseTapes.length} tapes completed`));
      hRow.appendChild(infoCol);
      hRow.appendChild(el('div', { id: `cpct-${courseId}`, style: { padding: '5px 14px', borderRadius: '100px', flexShrink: '0', background: pct === 100 ? 'linear-gradient(135deg,#acfff3,#00b4a0)' : 'linear-gradient(135deg,#ff8ade22,#acfff322)', border: pct === 100 ? 'none' : '1px solid #ff8ade33', fontSize: '12px', fontWeight: '700', color: pct === 100 ? '#1a1a2e' : '#c44f9a' } }, pct === 100 ? '✓ Complete' : `${pct}%`));

      const progBar = el('div', { style: { height: '3px', background: '#f0f0f0', borderRadius: '100px', overflow: 'hidden', marginBottom: '16px' } });
      progBar.appendChild(el('div', { id: `cbar-${courseId}`, style: { height: '100%', borderRadius: '100px', width: `${pct}%`, background: pct === 100 ? 'linear-gradient(90deg,#acfff3,#00b4a0)' : 'linear-gradient(90deg,#ff8ade,#acfff3)', transition: 'width 0.4s ease' } }));

      section.appendChild(hRow);
      section.appendChild(progBar);
      page.appendChild(section);

      const heads = {};
      courseTapes.forEach(tape => { const h = tape.Head || 'General'; if (!heads[h]) heads[h] = []; heads[h].push(tape); });
      Object.entries(heads).sort(([, a], [, b]) => Number(a[0].TapeNo) - Number(b[0].TapeNo)).forEach(([head, tapes]) => page.appendChild(buildHeadBlock(head, tapes, allTapes, currentUser.email)));
    });
  }

  const lockedSource = courseInfoData.length > 0
    ? courseInfoData.filter(ci => { const id = (ci.CourseID || ci.courseId || ci['Course ID'] || '').toLowerCase().trim(); return id && !purchasedIds.includes(id); }).map(ci => ({ id: (ci.CourseID || ci.courseId || ci['Course ID'] || '').toLowerCase().trim(), badge: ci.Badge || ci.badge || '📚', title: ci.Title || ci.title || 'Course', desc: ci.Desc || ci.desc || ci.Description || '', tapes: ci.Tapes || ci.tapes || '', grad: ci.Grad || ci.grad || 'linear-gradient(135deg,#ff8ade,#acfff3)', formLink: ci.FormLink || ci.formLink || '#' }))
    : ALL_COURSES.filter(c => !purchasedIds.includes(c.id));

  if (lockedSource.length > 0) {
    const divider = el('div', { style: { margin: '40px 0 20px' } });
    divider.appendChild(el('h2', { className: 'locked-section-title' }, '🔒 Other Courses'));
    divider.appendChild(el('p', { className: 'locked-section-sub' }, 'Unlock more content to accelerate your learning'));
    page.appendChild(divider);
    const grid = el('div', { className: 'locked-grid' });
    lockedSource.forEach(course => {
      const card = el('div', { className: 'locked-card' });
      card.appendChild(el('div', { className: 'locked-card-bar', style: { background: course.grad } }));
      const body = el('div', { className: 'locked-card-body' });
      body.innerHTML = `<div class="locked-icon-lock">🔒</div><div class="locked-badge-icon">${course.badge}</div><div class="locked-card-title">${course.title}</div><p class="locked-card-desc">${course.desc}</p>${course.tapes ? `<span class="locked-tapes-badge" style="background:${course.grad}">${course.tapes}</span>` : ''}`;
      body.appendChild(el('button', { className: 'btn-purchase', onClick: () => { const link = course.formLink && course.formLink !== '#' ? course.formLink : null; if (link) window.open(link, '_blank'); else window.location.href = '/#contact'; } }, '🛒 Purchase to Unlock'));
      card.appendChild(body);
      grid.appendChild(card);
    });
    page.appendChild(grid);
  }

  showScreen(page);
  if (searchQuery) setTimeout(() => filterTapes(searchQuery), 50);
}

// ─── Auth handlers ────────────────────────────────────────────────────────────

function handleLogin() { if (!window.netlifyIdentity) return; window.netlifyIdentity.open('login'); }

function handleSignOut() {
  if (window.netlifyIdentity) window.netlifyIdentity.logout();
  currentUser = null; studentData = null; contentRows = [];
  renderLoginScreen();
}

function renderAuthLoadingScreen() {
  const wrap = el('div', { className: 'loader-wrap fade-up' });
  wrap.innerHTML = `
    <div class="loader"></div>
    <div style="text-align:center; margin-top:20px;">
      <h3 style="color:#1a1a2e; margin-bottom:8px; font-family:'Playfair Display', serif;">Verifying Identity</h3>
      <p style="color:#888; font-size:14px;">กำลังตรวจสอบสิทธิ์เข้าใช้งานบทเรียนของคุณ...</p>
    </div>
  `;
  showScreen(wrap);
}

function renderLoginScreen() {
  const wrap = el('div', { className: 'login-screen' });
  const box = el('div', { className: 'login-box fade-up' });
  box.innerHTML = `<div class="login-icon floating">🎓</div><span class="section-pill">My Course</span><h1>My Learning Space</h1><p>Sign in to access your enrolled courses<br>and continue learning right away.</p>`;
  box.appendChild(el('button', { className: 'btn-primary', onClick: handleLogin }, '🔐 Sign In / Sign Up'));
  const hint = el('p', { className: 'login-hint' });
  hint.innerHTML = `Haven't purchased yet? <a href="/#courses">Browse courses →</a>`;
  box.appendChild(hint);
  wrap.appendChild(box);
  showScreen(wrap);
}

function renderLoadingScreen() {
  const wrap = el('div', { className: 'loader-wrap' });
  wrap.innerHTML = `<div class="loader"></div><p style="color:#888;font-size:15px; margin-top:15px;">Loading your courses...</p>`;
  showScreen(wrap);
}

function renderErrorScreen(msg, email) {
  const wrap = el('div', { className: 'error-screen fade-up' });
  wrap.innerHTML = `
    <div style="font-size:56px">📭</div>
    <h2>No Courses Found</h2>
    <p>${msg}</p>
    <div class="error-actions">
      <a href="/#contact" class="btn-primary" style="max-width:200px;text-decoration:none;display:inline-block;text-align:center;padding:12px 28px">✉️ Contact P' J'Ae</a>
      ${email ? `<button class="btn-primary" id="retry-btn" style="background:linear-gradient(135deg,#acfff3,#ff8ade);max-width:160px">🔄 Try Again</button>` : ''}
      <button class="btn-ghost" id="signout-err-btn">← Sign Out</button>
    </div>
  `;
  showScreen(wrap);
  document.getElementById('signout-err-btn')?.addEventListener('click', handleSignOut);
  document.getElementById('retry-btn')?.addEventListener('click', () => {
    clearCache(email);
    loadUserData(email, 0);
  });
}

// ─── Main load flow ───────────────────────────────────────────────────────────

function applyData(email, data) {
  const courses = data.courses || [];
  studentData = { email, courses, expireDate: data.expireDate || null };
  contentRows = (data.content || []).sort((a, b) => Number(a.TapeNo) - Number(b.TapeNo));
  courseInfoData = data.courseInfo || [];
  
  loadProgress(email);
  
  if (contentRows.length > 0) openHeads[`head_${contentRows[0].Head || 'General'}`] = true;
  renderDashboard();
}

async function loadUserData(email, retry = 0) {
  const currentRequestId = ++latestRequestId;
  const MAX_RETRY = 4;
  const RETRY_DELAY = 2000;

  const cached = getCached(email);
  if (cached) {
    applyData(email, cached);
    fetchAll(email).then(fresh => {
      if (!fresh?.found || currentRequestId !== latestRequestId) return;
      setCache(email, fresh);
    }).catch(() => {});
    return;
  }

  if (retry === 0) renderLoadingScreen();

  try {
    const data = await fetchAll(email);
    
    // ป้องกันคนกดรีเฟรชหรือสลับบัญชีระหว่างรอดึงข้อมูล
    if (currentRequestId !== latestRequestId) return;

    if (!data.found) {
      if (retry < MAX_RETRY) {
        setTimeout(() => loadUserData(email, retry + 1), RETRY_DELAY);
        return;
      }
      renderErrorScreen("No course found for this account. Please contact P' J'Ae to enroll.", email);
      return;
    }
    setCache(email, data);
    applyData(email, data);
  } catch (err) {
    console.error(err);
    if (currentRequestId !== latestRequestId) return;
    if (retry < MAX_RETRY) {
      setTimeout(() => loadUserData(email, retry + 1), RETRY_DELAY);
      return;
    }
    renderErrorScreen('Failed to load course data. Please try again.', email);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function initApp() {
  if (DEV_MODE) {
    currentUser = { email: DEV_EMAIL, name: DEV_NAME };
    const devBanner = document.createElement('div');
    devBanner.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#1a1a2e;color:#fbffa4;padding:8px 16px;border-radius:100px;font-size:12px;font-weight:700;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
    devBanner.textContent = '🛠 DEV MODE';
    document.body.appendChild(devBanner);
    loadUserData(DEV_EMAIL);
    return;
  }

  if (!window.netlifyIdentity) {
    renderErrorScreen('Authentication service not available. Please refresh the page.');
    return;
  }

  renderAuthLoadingScreen();

  window.netlifyIdentity.on('init', (user) => {
    if (user) {
      currentUser = { email: user.email, name: user.user_metadata?.full_name || user.email };
      loadUserData(currentUser.email);
    } else {
      renderLoginScreen();
    }
  });

  window.netlifyIdentity.on('login', (user) => {
    currentUser = { email: user.email, name: user.user_metadata?.full_name || user.email };
    window.netlifyIdentity.close();
    clearCache(user.email);
    loadUserData(currentUser.email);
  });

  window.netlifyIdentity.on('logout', () => {
    currentUser = null; studentData = null; contentRows = [];
    renderLoginScreen();
  });

  window.netlifyIdentity.init();
}

window.addEventListener('load', () => {
  if (window.location.pathname.includes('my-course')) {
    initApp();
  }
});
