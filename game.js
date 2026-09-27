/* Zinger: a party game of one-liners.
 * The host screen is the "server": it holds all game state. Phones connect to it
 * peer-to-peer over WebRTC (PeerJS), so the whole thing runs on static hosting
 * like GitHub Pages with no backend of our own.
 */
(() => {
'use strict';

// ---------- Config ----------
const PREFIX = 'zinger-v1-';
const Q = new URLSearchParams(location.search);
const FAST = Q.has('fast'); // ?fast shortens every timer (handy for testing)
const T = FAST
  ? { intro: 1.5, answer: 15, finalAnswer: 12, vote: 8, finalVote: 10, reveal: 2.5, scores: 2.5, finalReveal: 3 }
  : { intro: 4, answer: 90, finalAnswer: 75, vote: 20, finalVote: 30, reveal: 7, scores: 8, finalReveal: 12 };
const MIN = 3, MAX = 8, MAXLEN = 80, FINAL_VOTES = 3;
const COLORS = ['#2ee6c5', '#ff5d8f', '#ffd23f', '#5aa9ff', '#ff8a3d', '#b388ff', '#7ddc5a', '#ff6b6b'];
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ';

// ---------- Utils ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clean = t => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAXLEN);
const mkStore = area => ({
  get(k, d) { try { const v = window[area].getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { window[area].setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
});
const store = mkStore('localStorage');
const session = mkStore('sessionStorage');
// ---------- Local mode (?local): tabs in one browser talk over BroadcastChannel ----------
// Mimics the small slice of the PeerJS API we use. Handy for testing without a network.
const LOCAL = Q.has('local');
const FLAGS = [FAST && 'fast', LOCAL && 'local'].filter(Boolean).map(f => '&' + f).join('');
class Emitter {
  constructor() { this._h = {}; }
  on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
  emit(e, ...a) { (this._h[e] || []).forEach(f => { try { f(...a); } catch (err) { console.error(err); } }); }
}
class LocalConn extends Emitter {
  constructor(peer, remote, cid) { super(); this.peer = peer; this.remote = remote; this.cid = cid; this.open = false; }
  send(data) { if (this.open) this.peer._post({ type: 'data', to: this.remote, cid: this.cid, data }); }
  close() { if (!this.open && !this.peer.conns[this.cid]) return; this.peer._post({ type: 'close', to: this.remote, cid: this.cid }); this._closed(); }
  _closed() { const was = this.open || this.peer.conns[this.cid]; this.open = false; delete this.peer.conns[this.cid]; if (was) setTimeout(() => this.emit('close'), 0); }
}
class LocalPeer extends Emitter {
  constructor(id) {
    super();
    this.id = id || 'p' + rid(); this.open = false; this.destroyed = false; this.disconnected = false; this.conns = {};
    this.bc = new BroadcastChannel('zinger-local');
    this.bc.onmessage = e => this._msg(e.data);
    addEventListener('pagehide', () => this.destroy());
    setTimeout(() => { this.open = true; this.emit('open', this.id); }, 30);
  }
  _post(m) { if (!this.destroyed) this.bc.postMessage({ ...m, from: this.id }); }
  connect(remote) {
    const cid = rid(), c = new LocalConn(this, remote, cid);
    this.conns[cid] = c;
    this._post({ type: 'conn', to: remote, cid });
    setTimeout(() => { if (!c.open && this.conns[cid]) { delete this.conns[cid]; this.emit('error', { type: 'peer-unavailable' }); } }, 1500);
    return c;
  }
  _msg(m) {
    if (!m || m.to !== this.id || this.destroyed) return;
    const c = this.conns[m.cid];
    if (m.type === 'conn') {
      const nc = new LocalConn(this, m.from, m.cid); nc.open = true; this.conns[m.cid] = nc;
      this._post({ type: 'ack', to: m.from, cid: m.cid });
      this.emit('connection', nc); setTimeout(() => nc.emit('open'), 0);
    } else if (m.type === 'ack' && c) { c.open = true; c.emit('open'); }
    else if (m.type === 'data' && c) c.emit('data', m.data);
    else if (m.type === 'close' && c) c._closed();
  }
  reconnect() { }
  destroy() { if (this.destroyed) return; Object.values(this.conns).forEach(c => c.close()); this.destroyed = true; try { this.bc.close(); } catch { } }
}
if (LOCAL) window.Peer = LocalPeer;

function showScreen(id) { document.querySelectorAll('.screen').forEach(e => { e.hidden = e.id !== id; }); window.scrollTo(0, 0); }
const joinUrl = code => `${location.origin}${location.pathname}?code=${code}${LOCAL ? '&local' : ''}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// =====================================================================
//                               HOST
// =====================================================================
const H = {
  peer: null, code: null, status: 'connecting', players: [],
  phase: 'lobby', round: 0, matchups: [], queue: [], vi: 0, final: null,
  timer: null, deadline: 0, onEnd: null, paused: false, pauseLeft: 0,
  deck: [], deckDirty: true, lastKey: '',
  settings: Object.assign({ tts: false, customOnly: false, custom: '' }, store.get('zinger-settings', {})),
};

function startHost() {
  if (!window.Peer) return alert('Could not load the networking library. Check your connection and reload.');
  showScreen('host');
  document.title = 'Zinger · Host';
  hostPeer();
  renderHost();
  setInterval(tick, 250);
  window.addEventListener('beforeunload', e => { if (H.phase !== 'lobby' || H.players.length) { e.preventDefault(); e.returnValue = ''; } });
}

function genCode() { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return c; }

function hostPeer() {
  const code = H.code || genCode();
  const peer = new Peer(PREFIX + code);
  H.peer = peer;
  peer.on('open', () => { H.code = code; H.status = 'ready'; H.lastKey = ''; syncAll(); });
  peer.on('connection', conn => {
    conn.on('data', d => hostMsg(conn, d));
    conn.on('close', () => hostClose(conn));
    conn.on('error', () => hostClose(conn));
  });
  peer.on('disconnected', () => {
    if (peer.destroyed || H.peer !== peer) return;
    H.status = 'reconnecting'; H.lastKey = ''; renderHost();
    setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
  });
  peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      // Code already taken (or our old registration hasn't expired yet).
      if (!H.players.length && H.phase === 'lobby') H.code = null;
      peer.destroy(); setTimeout(hostPeer, H.code ? 3000 : 200); return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      H.status = 'reconnecting'; H.lastKey = ''; renderHost();
      setTimeout(() => {
        if (H.peer !== peer) return;
        if (peer.destroyed) hostPeer(); else if (peer.disconnected) peer.reconnect();
      }, 3000);
      return;
    }
    console.warn('[host]', err.type, err);
  });
}

const connected = () => H.players.filter(p => p.connected);
const vip = () => H.players.find(p => p.connected) || null;
const byId = id => H.players.find(p => p.id === id);
const myMatchups = p => H.matchups.filter(m => m.a === p.id || m.b === p.id);

function send(p, msg) { if (p.conn && p.connected) { try { p.conn.send(msg); } catch { /* ignore */ } } }

function hostMsg(conn, d) {
  if (!d || typeof d !== 'object') return;
  if (d.t === 'join') return hostJoin(conn, d);
  const p = H.players.find(x => x.conn === conn);
  if (!p) return;
  switch (d.t) {
    case 'start': if (p === vip() && H.phase === 'lobby') startGame(); break;
    case 'answer': submitAnswer(p, String(d.qid || ''), d.text); break;
    case 'vote': submitVote(p, String(d.qid || ''), d.choice); break;
    case 'fvote': submitFinalVote(p, d.choice); break;
    case 'again': if (p === vip() && H.phase === 'end') backToLobby(); break;
  }
}

function hostJoin(conn, d) {
  const reject = msg => { try { conn.send({ t: 'reject', msg }); } catch { } setTimeout(() => { try { conn.close(); } catch { } }, 800); };
  const name = clean(d.name).slice(0, 14);
  const pid = String(d.pid || '').slice(0, 40);
  if (!name) return reject('Please enter a name.');
  let p = (pid && H.players.find(x => x.id === pid)) ||
          H.players.find(x => !x.connected && x.name.toLowerCase() === name.toLowerCase());
  if (p) {
    if (p.conn && p.conn !== conn) { const old = p.conn; p.conn = null; try { old.close(); } catch { } }
    p.conn = conn; p.connected = true;
    if (H.phase === 'lobby' && !H.players.some(x => x !== p && x.name.toLowerCase() === name.toLowerCase())) p.name = name;
  } else {
    if (H.phase !== 'lobby') return reject('That game is already underway. Hang tight for the next one!');
    if (H.players.length >= MAX) return reject(`This room is full (${MAX} players max).`);
    if (H.players.some(x => x.name.toLowerCase() === name.toLowerCase())) return reject('Someone already has that name. Try another.');
    const used = new Set(H.players.map(x => x.color));
    p = { id: pid || rid(), name, color: COLORS.find(c => !used.has(c)) || COLORS[0], score: 0, conn, connected: true };
    H.players.push(p);
  }
  send(p, { t: 'welcome', id: p.id, name: p.name, color: p.color });
  syncAll();
}

function hostClose(conn) {
  const p = H.players.find(x => x.conn === conn);
  if (!p) return;
  p.conn = null; p.connected = false;
  if (H.phase === 'lobby' || H.phase === 'end') H.players = H.players.filter(x => x !== p || H.phase === 'end');
  syncAll();
  maybeAdvance();
}

// ---------- Flow ----------
function setPhase(phase, secs, onEnd) {
  clearTimeout(H.timer); H.timer = null;
  H.phase = phase; H.onEnd = onEnd || null; H.paused = false;
  H.deadline = secs ? Date.now() + secs * 1000 : 0;
  if (secs && onEnd) H.timer = setTimeout(fire, secs * 1000);
  syncAll();
}
function fire() { clearTimeout(H.timer); H.timer = null; const f = H.onEnd; H.onEnd = null; H.paused = false; if (f) f(); }
function skip() { if (H.onEnd) fire(); }
function togglePause() {
  if (!H.onEnd) return;
  if (!H.paused) { H.paused = true; H.pauseLeft = Math.max(0, H.deadline - Date.now()); clearTimeout(H.timer); H.timer = null; }
  else { H.paused = false; H.deadline = Date.now() + H.pauseLeft; H.timer = setTimeout(fire, H.pauseLeft); }
  H.lastKey = ''; syncAll();
}
const remaining = () => H.paused ? H.pauseLeft / 1000 : (H.deadline ? Math.max(0, (H.deadline - Date.now()) / 1000) : null);

function customPrompts() { return H.settings.custom.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 500); }
function buildDeck() {
  const c = customPrompts();
  const list = H.settings.customOnly && c.length ? c : [...(window.ZINGER_PROMPTS || []), ...c];
  H.deck = shuffle([...new Set(list)]); H.deckDirty = false;
}
function drawPrompt() { if (!H.deck.length) buildDeck(); return H.deck.pop() || 'Say something funny'; }

function startGame() {
  H.players = connected();
  if (H.players.length < MIN) return;
  H.players.forEach(p => { p.score = 0; });
  if (H.deckDirty || H.deck.length < 20) buildDeck();
  H.round = 0;
  nextRound();
}

function nextRound() {
  H.round++;
  if (H.round <= 2) {
    const order = shuffle(connected().length >= 2 ? connected() : H.players.slice());
    const n = order.length;
    H.matchups = order.map((p, i) => ({ qid: `r${H.round}m${i}`, prompt: drawPrompt(), a: p.id, b: order[(i + 1) % n].id, answers: {}, votes: {}, result: null }));
    speak(H.round === 1 ? 'Round one!' : 'Round two! Double points!');
    setPhase('intro', T.intro, () => setPhase('answer', T.answer, endAnswers));
  } else {
    H.final = { prompt: drawPrompt(), answers: {}, received: {}, left: {}, cast: {}, order: [], pts: {} };
    H.matchups = [];
    speak('The Last Word!');
    setPhase('intro', T.intro, () => setPhase('final-answer', T.finalAnswer, startFinalVote));
  }
}

function submitAnswer(p, qid, text) {
  text = clean(text);
  if (!text) return;
  if (H.phase === 'answer') {
    const m = H.matchups.find(x => x.qid === qid && (x.a === p.id || x.b === p.id));
    if (!m || m.answers[p.id] != null) return;
    m.answers[p.id] = text;
  } else if (H.phase === 'final-answer' && qid === 'final') {
    if (H.final.answers[p.id] != null) return;
    H.final.answers[p.id] = text;
  } else return;
  syncAll(); maybeAdvance();
}

// End a phase early once every connected player has done their part.
function maybeAdvance() {
  if (!H.onEnd || H.paused) return;
  const live = connected();
  if (!live.length) return;
  let done = false;
  if (H.phase === 'answer') done = live.every(p => myMatchups(p).every(m => m.answers[p.id] != null));
  else if (H.phase === 'final-answer') done = live.every(p => H.final.answers[p.id] != null);
  else if (H.phase === 'vote') { const m = H.queue[H.vi]; done = live.filter(p => p.id !== m.a && p.id !== m.b).every(p => m.votes[p.id]); }
  else if (H.phase === 'final-vote') done = live.every(p => !(H.final.left[p.id] > 0) || !finalOptionsFor(p).length);
  if (done) setTimeout(skip, 600); // brief beat so the last action registers on screen
}

function endAnswers() {
  H.queue = shuffle(H.matchups.filter(m => m.answers[m.a] != null || m.answers[m.b] != null));
  H.vi = 0;
  if (!H.queue.length) return showScores();
  startVote();
}

function startVote() {
  const m = H.queue[H.vi];
  [m.left, m.right] = Math.random() < 0.5 ? [m.a, m.b] : [m.b, m.a];
  const hasA = m.answers[m.a] != null, hasB = m.answers[m.b] != null;
  if (!hasA || !hasB) {
    const w = hasA ? m.a : m.b, pts = 500 * H.round;
    m.result = { forfeit: true, winner: w, va: 0, vb: 0, pts: { [w]: pts }, shutout: null };
    byId(w).score += pts;
    return setPhase('reveal', T.reveal, nextVote);
  }
  setPhase('vote', T.vote, reveal);
  speak(`${m.prompt}. ${m.answers[m.left]}. Or. ${m.answers[m.right]}.`);
  maybeAdvance();
}

function submitVote(p, qid, choice) {
  if (H.phase !== 'vote') return;
  const m = H.queue[H.vi];
  if (m.qid !== qid || p.id === m.a || p.id === m.b || m.votes[p.id]) return;
  if (choice !== 'L' && choice !== 'R') return;
  m.votes[p.id] = choice === 'L' ? m.left : m.right;
  syncAll(); maybeAdvance();
}

function reveal() {
  const m = H.queue[H.vi], mult = H.round;
  const vals = Object.values(m.votes);
  const va = vals.filter(v => v === m.a).length, vb = vals.filter(v => v === m.b).length, total = va + vb;
  const pts = { [m.a]: 0, [m.b]: 0 };
  if (total) {
    pts[m.a] = Math.round((1000 * mult * va / total) / 10) * 10;
    pts[m.b] = Math.round((1000 * mult * vb / total) / 10) * 10;
  }
  let shutout = null;
  if (total && (va === 0 || vb === 0)) { shutout = va ? m.a : m.b; pts[shutout] += 250 * mult; }
  m.result = { va, vb, pts, shutout, winner: va > vb ? m.a : vb > va ? m.b : null };
  byId(m.a).score += pts[m.a]; byId(m.b).score += pts[m.b];
  if (shutout) speak(`Shutout! ${byId(shutout).name}!`);
  setPhase('reveal', T.reveal, nextVote);
}

function nextVote() { H.vi++; if (H.vi < H.queue.length) startVote(); else showScores(); }
function showScores() { setPhase('scores', T.scores, nextRound); }

function finalOptionsFor(p) { return H.final.order.map((id, k) => ({ k, id })).filter(o => o.id !== p.id); }

function startFinalVote() {
  const F = H.final, ids = Object.keys(F.answers);
  if (ids.length < 2) {
    if (ids.length === 1) { F.pts[ids[0]] = 1000; byId(ids[0]).score += 1000; F.order = ids; }
    return setPhase('final-reveal', T.finalReveal, endGame);
  }
  F.order = shuffle(ids);
  H.players.forEach(p => { F.left[p.id] = FINAL_VOTES; F.cast[p.id] = {}; });
  speak(F.prompt);
  setPhase('final-vote', T.finalVote, finalReveal);
}

function submitFinalVote(p, k) {
  const F = H.final;
  if (H.phase !== 'final-vote' || !(F.left[p.id] > 0)) return;
  const id = F.order[k];
  if (id == null || id === p.id) return;
  F.left[p.id]--;
  F.received[id] = (F.received[id] || 0) + 1;
  F.cast[p.id][k] = (F.cast[p.id][k] || 0) + 1;
  syncAll(); maybeAdvance();
}

function finalReveal() {
  const F = H.final;
  F.order.forEach(id => { const v = F.received[id] || 0; F.pts[id] = v * 400; byId(id).score += v * 400; });
  setPhase('final-reveal', T.finalReveal, endGame);
}

function endGame() {
  const top = ranked()[0];
  if (top) speak(`${winners().map(p => p.name).join(' and ')} ${winners().length > 1 ? 'win' : 'wins'}!`);
  setPhase('end', 0, null);
}
function ranked() { return H.players.slice().sort((a, b) => b.score - a.score); }
function winners() { const r = ranked(); return r.filter(p => p.score === r[0]?.score); }
function rankOf(p) { return ranked().filter(x => x.score > p.score).length + 1; }

function backToLobby() {
  H.players = connected();
  H.players.forEach(p => { p.score = 0; });
  H.round = 0; H.matchups = []; H.queue = []; H.final = null;
  setPhase('lobby', 0, null);
}

// ---------- Views sent to phones ----------
function viewFor(p) {
  const base = { phase: H.phase, round: H.round, score: p.score, remaining: remaining(), paused: H.paused };
  const v = vip();
  switch (H.phase) {
    case 'lobby':
      return { ...base, players: connected().map(x => ({ name: x.name, color: x.color })), vip: v === p, vipName: v?.name, min: MIN };
    case 'intro':
      return { ...base, title: roundTitle() };
    case 'answer': {
      const mine = myMatchups(p);
      return { ...base, total: mine.length, todo: mine.filter(m => m.answers[p.id] == null).map(m => ({ qid: m.qid, prompt: m.prompt })) };
    }
    case 'final-answer':
      return { ...base, total: 1, todo: H.final.answers[p.id] == null ? [{ qid: 'final', prompt: H.final.prompt }] : [] };
    case 'vote': {
      const m = H.queue[H.vi];
      return { ...base, qid: m.qid, prompt: m.prompt, mine: m.a === p.id || m.b === p.id, voted: !!m.votes[p.id],
        options: [{ k: 'L', text: m.answers[m.left] }, { k: 'R', text: m.answers[m.right] }] };
    }
    case 'final-vote': {
      const F = H.final;
      return { ...base, prompt: F.prompt, left: F.left[p.id] || 0,
        options: finalOptionsFor(p).map(o => ({ k: o.k, text: F.answers[o.id], given: F.cast[p.id]?.[o.k] || 0 })) };
    }
    case 'end':
      return { ...base, rank: rankOf(p), count: H.players.length, vip: v === p, vipName: v?.name };
    default:
      return base;
  }
}
function roundTitle() { return H.round === 1 ? 'Round 1' : H.round === 2 ? 'Round 2' : 'The Last Word'; }

function syncAll() { renderHost(); H.players.forEach(p => send(p, { t: 'view', v: viewFor(p) })); }

// ---------- Host rendering ----------
function speak(text) {
  if (!H.settings.tts || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/_{2,}/g, ' blank '));
    u.rate = 1.05; speechSynthesis.speak(u);
  } catch { /* ignore */ }
}
const promptHtml = t => esc(t).replace(/_{2,}/g, '<span class="blank">______</span>');
const nameOf = id => esc(byId(id)?.name || '?');
const colorOf = id => byId(id)?.color || '#fff';

function renderHost() {
  const root = $('#host');
  if (root.hidden) return;
  const key = [H.phase, H.round, H.vi, H.status, H.paused, H.code].join('|');
  if (key !== H.lastKey) {
    H.lastKey = key;
    root.innerHTML = `
      <header class="h-top">
        <div class="h-logo">Zinger</div>
        <div class="h-meta">
          ${H.round && H.phase !== 'lobby' && H.phase !== 'end' ? `<span class="pill">${roundTitle()}${H.round === 2 ? ' · 2x points' : ''}</span>` : ''}
          ${H.code && H.phase !== 'lobby' ? `<span class="pill">Code <b>${H.code}</b></span>` : ''}
          ${H.status !== 'ready' ? `<span class="pill">${H.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>` : ''}
        </div>
      </header>
      <section class="h-main">${hostStage()}</section>
      <footer class="h-foot">
        <div>${H.code && H.phase !== 'lobby' ? `Join late? Rejoin at <b>${esc(location.host + location.pathname)}</b> with code <b>${H.code}</b>` : ''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn ghost" data-act="tts">${H.settings.tts ? '🔊 Read aloud: on' : '🔈 Read aloud: off'}</button>
          ${H.onEnd ? `<button class="btn ghost" data-act="pause">${H.paused ? '▶ Resume' : '⏸ Pause'}</button>
                       <button class="btn ghost" data-act="skip">⏭ Skip</button>` : ''}
        </div>
      </footer>`;
    wireHost(root);
  }
  const live = $('#live', root);
  if (live) live.innerHTML = hostLive();
  tick();
}

function hostStage() {
  if (!H.code) return `<h2 class="round-title" style="font-size:40px">Setting up…</h2><p class="sub">Connecting to the game server</p>`;
  const timer = `<div class="timer" data-timer>–</div>`;
  switch (H.phase) {
    case 'lobby': {
      const url = joinUrl(H.code);
      let qr = '';
      try { const q = qrcode(0, 'M'); q.addData(url); q.make(); qr = `<div class="qr">${q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>`; } catch { }
      const s = H.settings;
      return `<div class="lobby">
        <div class="code-box">
          <div class="code-label">Join on your phone at</div>
          <div class="join-url">${esc(location.host + location.pathname)}</div>
          <div class="code-label" style="margin-top:18px">Room code</div>
          <div class="code">${H.code}</div>
          ${qr}
        </div>
        <div>
          <div id="live"></div>
          <details class="settings">
            <summary>Settings &amp; custom prompts</summary>
            <label><input type="checkbox" data-set="tts" ${s.tts ? 'checked' : ''}> Read prompts and answers aloud</label>
            <label style="display:block">Your own prompts, one per line (use ____ for a blank)
              <textarea data-set="custom" placeholder="The worst thing to say at Thanksgiving dinner">${esc(s.custom)}</textarea></label>
            <label><input type="checkbox" data-set="customOnly" ${s.customOnly ? 'checked' : ''}> Only use my prompts</label>
            <p class="sub" style="font-size:14px">${(window.ZINGER_PROMPTS || []).length} built-in prompts. Custom prompts save on this device.</p>
          </details>
        </div>
      </div>`;
    }
    case 'intro':
      return `<h1 class="round-title">${roundTitle()}</h1>
        <p class="sub">${H.round === 1 ? 'Grab your phones. Prompts incoming!' : H.round === 2 ? 'Everything is worth double!' : 'One prompt for everyone. You get 3 votes to spread around.'}</p>`;
    case 'answer':
      return `<h2 class="round-title" style="font-size:clamp(34px,5vw,64px)">Write your answers!</h2>
        <p class="sub">Check your phone. Each prompt goes to two of you.</p>${timer}<div id="live"></div>`;
    case 'final-answer':
      return `<p class="sub">The Last Word · everyone answers</p><h2 class="prompt">${promptHtml(H.final.prompt)}</h2>${timer}<div id="live"></div>`;
    case 'vote': case 'reveal': {
      const m = H.queue[H.vi], R = H.phase === 'reveal' ? m.result : null;
      const card = id => {
        const txt = m.answers[id];
        if (!R) return `<div class="ans">${txt != null ? esc(txt) : '<span class="blank">No answer</span>'}</div>`;
        const votes = Object.entries(m.votes).filter(([, v]) => v === id).map(([vid]) => byId(vid)).filter(Boolean);
        const cls = R.winner === id || R.forfeit && R.winner === id ? 'win' : R.winner ? 'lose' : '';
        return `<div class="ans ${cls}" style="--c:${colorOf(id)}">
          ${R.pts?.[id] ? `<div class="pts">+${R.pts[id]}</div>` : ''}
          <div>${txt != null ? esc(txt) : '<span class="blank">No answer</span>'}</div>
          <div class="who" style="color:${colorOf(id)};filter:brightness(.6)">${nameOf(id)}</div>
          ${R.forfeit ? '' : `<div class="votes">${plural(votes.length, 'vote')}</div>
          <div class="voters">${votes.map(v => `<span>${esc(v.name)}</span>`).join('')}</div>`}
        </div>`;
      };
      let banner = '';
      if (R?.forfeit) banner = `<div class="banner" style="font-size:32px">${nameOf(R.winner)} wins by forfeit</div>`;
      else if (R?.shutout) banner = `<div class="banner">Shutout! ${nameOf(R.shutout)}</div>`;
      else if (R && !R.winner) banner = `<div class="banner" style="font-size:32px">${R.va + R.vb ? "It's a tie!" : 'No votes!'}</div>`;
      return `<p class="sub">Matchup ${H.vi + 1} of ${H.queue.length}</p>
        <h2 class="prompt">${promptHtml(m.prompt)}</h2>
        <div class="versus">${card(m.left)}<div class="vs">VS</div>${card(m.right)}</div>
        ${R ? banner : `${timer}<div id="live"></div>`}`;
    }
    case 'scores': case 'end': {
      const r = ranked(), w = winners();
      const head = H.phase === 'end'
        ? `<h1 class="round-title">${w.map(p => esc(p.name)).join(' & ')} ${w.length > 1 ? 'win' : 'wins'}!</h1>`
        : `<h1 class="round-title" style="font-size:clamp(34px,5vw,64px)">Scores after ${roundTitle()}</h1>`;
      return `${head}<div class="board">${r.map((p, i) => `<div class="row" style="--c:${p.color};animation-delay:${i * 0.08}s">
          <span class="rank">${rankOf(p)}</span><span class="nm">${esc(p.name)}${p.connected ? '' : ' <small style="color:var(--muted)">(away)</small>'}</span><span class="sc">${p.score.toLocaleString()}</span></div>`).join('')}</div>
        ${H.phase === 'end' ? `<div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center"><button class="btn" data-act="again">Back to lobby</button></div>
          <p class="sub" style="font-size:16px">${vip() ? `${esc(vip().name)} can also restart from their phone.` : ''}</p>` : ''}`;
    }
    case 'final-vote': case 'final-reveal': {
      const F = H.final, rev = H.phase === 'final-reveal';
      let ids = F.order.slice();
      if (rev) ids.sort((a, b) => (F.received[b] || 0) - (F.received[a] || 0));
      const top = rev && ids.length ? (F.received[ids[0]] || 0) : -1;
      return `<p class="sub">The Last Word · ${rev ? 'results' : 'spend your 3 votes on your phone'}</p>
        <h2 class="prompt" style="font-size:clamp(24px,3.4vw,44px)">${promptHtml(F.prompt)}</h2>
        <div class="final-grid">${ids.map((id, i) => `<div class="ans ${rev && top > 0 && (F.received[id] || 0) === top ? 'win' : ''}" style="animation-delay:${i * 0.08}s">
            ${rev && F.pts[id] ? `<div class="pts">+${F.pts[id]}</div>` : ''}
            <div>${esc(F.answers[id])}</div>
            ${rev ? `<div class="who">${nameOf(id)}</div><div class="votes">${plural(F.received[id] || 0, 'vote')}</div>` : ''}
          </div>`).join('') || '<p class="sub">Nobody answered!</p>'}</div>
        ${rev ? '' : `${timer}<div id="live"></div>`}`;
    }
  }
  return '';
}

function hostLive() {
  const chips = (list, isDone) => `<div class="status-row">${list.map(p =>
    `<span class="chip ${isDone(p) ? 'done' : ''} ${p.connected ? '' : 'off'}" style="--c:${p.color}">${isDone(p) ? '✓ ' : ''}${esc(p.name)}</span>`).join('')}</div>`;
  switch (H.phase) {
    case 'lobby': {
      const live = connected(), v = vip(), can = live.length >= MIN;
      const slots = Math.max(0, MIN - live.length);
      return `<h2 style="margin:0;color:var(--yellow)">Players ${live.length}/${MAX}</h2>
        <div class="players">${live.map(p => `<span class="chip" style="--c:${p.color}">${p === v ? '<span class="crown">👑</span>' : ''}${esc(p.name)}</span>`).join('')}
          ${Array.from({ length: slots }, () => '<span class="empty-slot">waiting…</span>').join('')}</div>
        <p class="sub" style="font-size:18px;margin-bottom:14px">${can ? `Everyone in? ${v ? `👑 ${esc(v.name)} can start from their phone, or` : ''}` : `Need at least ${MIN} players to start.`}</p>
        <button class="btn big" data-act="start" ${can ? '' : 'disabled'}>Start game</button>`;
    }
    case 'answer':
      return chips(H.players, p => myMatchups(p).every(m => m.answers[p.id] != null));
    case 'final-answer':
      return chips(H.players, p => H.final.answers[p.id] != null);
    case 'vote': {
      const m = H.queue[H.vi];
      const voters = H.players.filter(p => p.id !== m.a && p.id !== m.b);
      return `<p class="sub">Vote on your phone! ${Object.keys(m.votes).length} of ${voters.filter(p => p.connected).length} in</p>` + chips(voters, p => !!m.votes[p.id]);
    }
    case 'final-vote':
      return chips(H.players, p => !(H.final.left[p.id] > 0));
  }
  return '';
}

function wireHost(root) {
  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'start') startGame();
    else if (a === 'skip') skip();
    else if (a === 'pause') togglePause();
    else if (a === 'again') backToLobby();
    else if (a === 'tts') { H.settings.tts = !H.settings.tts; saveSettings(); H.lastKey = ''; renderHost(); if (H.settings.tts) speak('Read aloud is on.'); }
  }));
  root.querySelectorAll('[data-set]').forEach(el => el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
    const k = el.dataset.set;
    H.settings[k] = el.type === 'checkbox' ? el.checked : el.value;
    if (k !== 'tts') H.deckDirty = true;
    saveSettings();
  }));
}
function saveSettings() { store.set('zinger-settings', H.settings); }

function tick() {
  const r = remaining();
  document.querySelectorAll('#host [data-timer]').forEach(el => {
    el.textContent = r == null ? '' : (H.paused ? '⏸ ' : '') + Math.ceil(r);
    el.classList.toggle('low', r != null && r <= 5 && !H.paused);
  });
}

// =====================================================================
//                              PLAYER
// =====================================================================
const P = {
  peer: null, conn: null, code: '', name: '', pid: null, me: null, view: null,
  joined: false, left: false, tries: 0, retryT: null, status: '', deadline: 0,
  drafts: {}, sending: {}, lastKey: '',
};

function getPid() {
  let id = session.get('zinger-pid', null);
  if (!id) { id = rid(); session.set('zinger-pid', id); }
  return id;
}

function joinGame(code, name) {
  if (!window.Peer) { $('#joinErr').textContent = 'Could not load the networking library. Check your connection and reload.'; return; }
  Object.assign(P, { code, name, pid: getPid(), joined: false, left: false, tries: 0, view: null, status: 'Connecting…', lastKey: '' });
  store.set('zinger-name', name);
  session.set('zinger-session', { code, name });
  history.replaceState(null, '', `?code=${code}${FLAGS}`);
  showScreen('play');
  renderPlay();
  ensurePeer();
  if (!P.ticking) { P.ticking = setInterval(playTick, 250); }
}

function ensurePeer() {
  if (P.left) return;
  if (P.conn && P.conn.open) return;
  const pr = P.peer;
  if (pr && !pr.destroyed) {
    if (pr.disconnected) { try { pr.reconnect(); } catch { newPeer(); } return; }
    if (pr.open) { connectHost(); return; }
    return; // still opening; 'open' will fire
  }
  newPeer();
}

function newPeer() {
  if (P.peer) { try { P.peer.destroy(); } catch { } }
  const peer = new Peer();
  P.peer = peer;
  peer.on('open', () => { if (P.peer === peer) connectHost(); });
  peer.on('disconnected', () => { if (P.peer === peer && !P.left && !(P.conn && P.conn.open)) retryLater(); });
  peer.on('error', err => {
    if (P.peer !== peer || P.left) return;
    if (err.type === 'peer-unavailable') {
      if (!P.joined) return fail(`No game found with code ${P.code}. Double-check the code on the big screen.`);
      return retryLater();
    }
    if (err.type === 'browser-incompatible') return fail('This browser does not support the connection Zinger needs. Try Chrome or Safari.');
    retryLater();
  });
}

function connectHost() {
  if (P.left) return;
  if (P.conn) { const old = P.conn; P.conn = null; try { old.close(); } catch { } }
  const conn = P.peer.connect(PREFIX + P.code, { reliable: true });
  P.conn = conn;
  const to = setTimeout(() => { if (P.conn === conn && !conn.open) { P.conn = null; try { conn.close(); } catch { } retryLater(); } }, 9000);
  conn.on('open', () => { clearTimeout(to); P.tries = 0; conn.send({ t: 'join', name: P.name, pid: P.pid }); });
  conn.on('data', d => { if (P.conn === conn) playMsg(d); });
  conn.on('close', () => { if (P.conn === conn && !P.left) { P.conn = null; retryLater(); } });
  conn.on('error', () => { if (P.conn === conn && !P.left) { P.conn = null; retryLater(); } });
}

function retryLater() {
  if (P.left || P.retryT) return;
  P.tries++;
  if (!P.joined && P.tries > 4) return fail('Could not reach the game. Check the code and your connection, then try again.');
  P.status = P.joined ? 'Reconnecting…' : 'Connecting…';
  renderPlay();
  P.retryT = setTimeout(() => { P.retryT = null; ensurePeer(); }, Math.min(1000 * P.tries, 4000));
}

function fail(msg) {
  session.set('zinger-session', null);
  P.left = true; clearTimeout(P.retryT); P.retryT = null;
  try { P.conn && P.conn.close(); } catch { }
  try { P.peer && P.peer.destroy(); } catch { }
  P.conn = null; P.peer = null;
  showScreen('home');
  $('#joinErr').textContent = msg;
}

function playMsg(d) {
  if (!d || typeof d !== 'object') return;
  if (d.t === 'welcome') { P.joined = true; P.me = { id: d.id, name: d.name, color: d.color }; P.name = d.name; P.status = ''; P.lastKey = ''; renderPlay(); }
  else if (d.t === 'reject') fail(d.msg);
  else if (d.t === 'view') {
    P.view = d.v; P.status = '';
    P.deadline = d.v.remaining != null ? Date.now() + d.v.remaining * 1000 : 0;
    renderPlay();
  }
}

function sendHost(msg) { if (P.conn && P.conn.open) { P.conn.send(msg); return true; } return false; }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && P.code && !P.left && !(P.conn && P.conn.open)) {
    clearTimeout(P.retryT); P.retryT = null; ensurePeer();
  }
});

function renderPlay() {
  const root = $('#play');
  if (root.hidden) return;
  const v = P.view;
  const key = JSON.stringify([P.status, P.me, v && { ...v, remaining: null }]);
  if (key === P.lastKey) return;
  P.lastKey = key;
  const focused = document.activeElement?.dataset?.qid;
  const me = P.me || { name: P.name, color: '#fff' };
  root.innerHTML = `
    <header class="p-top">
      <span class="me"><span class="dot" style="--c:${me.color}"></span>${esc(me.name)}</span>
      <span>${v && v.phase !== 'lobby' ? `${(v.score || 0).toLocaleString()} pts` : `Room ${esc(P.code)}`}</span>
      <span class="p-timer" data-ptimer></span>
    </header>
    <section class="p-main">${playBody()}</section>`;
  wirePlay(root);
  if (focused) { const ta = root.querySelector(`textarea[data-qid="${CSS.escape(focused)}"]`); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  playTick();
}

function center(emoji, title, text, extra = '') {
  return `<div class="p-center">${emoji ? `<div class="big-emoji">${emoji}</div>` : ''}${title ? `<h2>${title}</h2>` : ''}${text ? `<p>${text}</p>` : ''}${extra}</div>`;
}

function playBody() {
  const v = P.view;
  if (P.status || !v) return center('📡', esc(P.status || 'Connecting…'), 'Keep this page open.');
  if (v.paused) return center('⏸️', 'Paused', 'The host paused the game.');
  switch (v.phase) {
    case 'lobby': {
      const list = `<div class="status-row" style="margin-top:8px">${v.players.map(p => `<span class="chip" style="--c:${p.color};font-size:16px">${esc(p.name)}</span>`).join('')}</div>`;
      if (v.vip) {
        const can = v.players.length >= v.min;
        return center('👑', "You're the VIP", can ? 'Start when everyone is in.' : `Waiting for at least ${v.min} players…`,
          `${list}<button class="btn big" data-act="start" ${can ? '' : 'disabled'} style="margin-top:12px">Everyone's in, start!</button>`);
      }
      return center('🎤', "You're in!", `Waiting for ${esc(v.vipName || 'the VIP')} to start the game.`, list);
    }
    case 'intro':
      return center('🎬', esc(v.title), 'Get ready…');
    case 'answer': case 'final-answer': {
      if (!v.todo.length) return center('✅', 'Done!', 'Waiting for everyone else to finish.');
      const q = v.todo[0], n = v.total - v.todo.length + 1, draft = P.drafts[q.qid] || '';
      return `<div class="p-count">${v.phase === 'final-answer' ? 'The Last Word' : `Prompt ${n} of ${v.total}`}</div>
        <div class="p-prompt">${promptHtml(q.prompt)}</div>
        <textarea data-qid="${esc(q.qid)}" maxlength="${MAXLEN}" placeholder="Your answer" enterkeyhint="send">${esc(draft)}</textarea>
        <div class="charcount"><span data-cc>${draft.length}</span>/${MAXLEN}</div>
        <button class="btn big" data-act="answer" data-qid="${esc(q.qid)}" ${P.sending[q.qid] ? 'disabled' : ''}>${P.sending[q.qid] ? 'Sending…' : 'Submit'}</button>`;
    }
    case 'vote':
      if (v.mine) return center('🤞', "That's yours!", 'Sit back and watch how people vote.');
      if (v.voted) return center('🗳️', 'Vote locked in', 'Eyes on the big screen.');
      return `<div class="p-count">Which is funnier?</div>
        <div class="p-prompt" style="font-size:18px">${promptHtml(v.prompt)}</div>
        ${v.options.map(o => `<button class="choice" data-act="vote" data-k="${o.k}">${esc(o.text)}</button>`).join('')}`;
    case 'final-vote': {
      if (!v.options.length) return center('👀', 'Watch the screen', 'Everyone is voting.');
      return `<div class="p-count">${v.left ? `Tap to vote · ${plural(v.left, 'vote')} left` : 'All votes cast!'}</div>
        <div class="p-prompt" style="font-size:18px">${promptHtml(v.prompt)}</div>
        ${v.options.map(o => `<button class="choice ${o.given ? 'picked' : ''}" data-act="fvote" data-k="${o.k}" ${v.left ? '' : 'disabled'}>
          ${o.given ? `<span class="tally">${'★'.repeat(o.given)}</span>` : ''}${esc(o.text)}</button>`).join('')}`;
    }
    case 'end': {
      const medal = v.rank === 1 ? '🏆' : v.rank === 2 ? '🥈' : v.rank === 3 ? '🥉' : '🎉';
      return center(medal, v.rank === 1 ? 'You win!' : `#${v.rank} of ${v.count}`, `<span class="score-big">${(v.score || 0).toLocaleString()}</span>`,
        v.vip ? '<button class="btn big" data-act="again" style="margin-top:16px">Play again</button>'
              : `<p>Waiting for ${esc(v.vipName || 'the VIP')} to start a new game.</p>`);
    }
    default:
      return center('👀', 'Look at the big screen', '');
  }
}

function wirePlay(root) {
  const ta = root.querySelector('textarea[data-qid]');
  if (ta) {
    ta.addEventListener('input', () => { P.drafts[ta.dataset.qid] = ta.value; const cc = root.querySelector('[data-cc]'); if (cc) cc.textContent = ta.value.length; });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); root.querySelector('[data-act="answer"]')?.click(); } });
  }
  root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'start') sendHost({ t: 'start' });
    else if (a === 'again') sendHost({ t: 'again' });
    else if (a === 'answer') {
      const qid = b.dataset.qid, text = clean(P.drafts[qid] ?? ta?.value);
      if (!text) { ta?.focus(); return; }
      if (sendHost({ t: 'answer', qid, text })) { P.sending[qid] = true; b.disabled = true; b.textContent = 'Sending…'; }
    }
    else if (a === 'vote') { if (sendHost({ t: 'vote', qid: P.view.qid, choice: b.dataset.k })) b.classList.add('picked'); root.querySelectorAll('.choice').forEach(x => { x.disabled = true; }); }
    else if (a === 'fvote') { sendHost({ t: 'fvote', choice: Number(b.dataset.k) }); }
  }));
}

function playTick() {
  const el = document.querySelector('#play [data-ptimer]');
  if (!el) return;
  const v = P.view;
  const timed = v && !v.paused && P.deadline && ['answer', 'final-answer', 'vote', 'final-vote'].includes(v.phase);
  const r = timed ? Math.max(0, (P.deadline - Date.now()) / 1000) : null;
  el.textContent = r == null ? '' : Math.ceil(r);
  el.classList.toggle('low', r != null && r <= 5);
}

// =====================================================================
//                               HOME
// =====================================================================
function initHome() {
  const code = (Q.get('code') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const codeIn = $('#joinCode'), nameIn = $('#joinName');
  codeIn.value = code;
  nameIn.value = store.get('zinger-name', '');
  if (code) (nameIn.value ? $('#joinForm button') : nameIn).focus();
  codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  $('#joinForm').addEventListener('submit', e => {
    e.preventDefault();
    const c = codeIn.value.trim().toUpperCase(), n = clean(nameIn.value).slice(0, 14);
    $('#joinErr').textContent = '';
    if (!/^[A-Z]{4}$/.test(c)) { $('#joinErr').textContent = 'Room codes are 4 letters.'; codeIn.focus(); return; }
    if (!n) { $('#joinErr').textContent = 'Enter your name.'; nameIn.focus(); return; }
    joinGame(c, n);
  });
  $('#hostBtn').addEventListener('click', startHost);
  if (Q.has('host')) return startHost();
  // Reloaded mid-game? Hop straight back in.
  const s = session.get('zinger-session', null);
  if (s && code && s.code === code && s.name) joinGame(s.code, s.name);
}

initHome();
// Exposed for automated tests only.
window.__zinger = { H, P };
})();
