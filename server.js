const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname + '/public'));

const rooms = {};
const uid = () => Math.random().toString(36).slice(2, 10);
const clean = (s, n) => String(s || '').trim().slice(0, n);
function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)]; } while (rooms[c]);
  return c;
}

const DEFAULTS = { category: 'Anime characters', spectator: 'ghost', penalty: true, difficulty: 'medium', timer: 30, bonus: true, chat: 'out', supers: 2 };
const active = r => r.order.filter(id => !r.players[id].out);
const threadKey = (a, b) => [a, b].sort().join('|');

/* ---------- character name matching ---------- */
const norm = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
const nameKey = s => norm(s).join(' ') || String(s).toLowerCase();
function similar(a, b) {
  const A = norm(a), B = norm(b);
  if (!A.length || !B.length) return false;
  const [s, l] = A.length <= B.length ? [A, B] : [B, A];
  return s.every(t => l.includes(t));
}

function chatAllowed(r, a, b) {
  const m = r.settings.chat;
  if (m === 'off') return false;
  if (m === 'anyone') return true;
  return a.out || b.out || r.phase === 'over';
}

/* ---------- views ---------- */
function view(r, pid) {
  const me = r.players[pid];
  const showAll = r.phase === 'over' || (me.out && r.settings.spectator === 'full');
  const threads = {};
  for (const id of r.order) {
    if (id === pid) continue;
    const th = r.threads[threadKey(pid, id)];
    if (th) threads[id] = th.map(m => ({ me: m.from === pid, text: m.text }));
  }
  return {
    code: r.code, phase: r.phase, settings: r.settings, host: r.hostPid, you: pid, turn: r.turn,
    players: r.order.map(id => {
      const p = r.players[id];
      const themeVisible = showAll || p.out || id === pid;
      return { pid: id, name: p.name, score: p.score, out: p.out, connected: p.connected,
               supers: p.supers || 0,
               hasTheme: !!p.theme, theme: themeVisible ? p.theme : null };
    }),
    pending: r.pending ? {
      char: r.pending.char, by: r.pending.by, answered: Object.keys(r.pending.answers),
      secsLeft: r.pending.deadline ? Math.max(0, Math.ceil((r.pending.deadline - Date.now()) / 1000)) : null,
    } : null,
    myAnswer: r.pending ? (r.pending.answers[pid] || null) : null,
    log: r.log,
    threads,
    guessesForMe: me.out ? [] : r.guesses.filter(g => g.target === pid).map(g => ({
      id: g.id, text: g.text, from: g.ghost ? 'A spectator' : r.players[g.guesser].name
    })),
  };
}

function emitOne(r, id) {
  const p = r.players[id];
  if (p && p.connected && p.sid) io.to(p.sid).emit('state', view(r, id));
}
function emitState(r) { r.order.forEach(id => emitOne(r, id)); }
function broadcast(r, msg) {
  for (const id of r.order) {
    const p = r.players[id];
    if (p.connected && p.sid) io.to(p.sid).emit('notice', msg);
  }
}
function toPlayer(r, pid, msg) {
  const p = r.players[pid];
  if (p && p.connected && p.sid) io.to(p.sid).emit('notice', msg);
}

/* ---------- turn / pending logic ---------- */
function advance(r) {
  const act = active(r).filter(id => r.players[id].connected);
  if (!act.length) { r.turn = null; return; }
  const i = r.order.indexOf(r.turn);
  for (let k = 1; k <= r.order.length; k++) {
    const id = r.order[(i + k + r.order.length) % r.order.length];
    if (act.includes(id)) { r.turn = id; return; }
  }
}

function clearPending(r) {
  if (r.pending && r.pending.timer) clearTimeout(r.pending.timer);
  r.pending = null;
}

function startPending(r, char, by) {
  const p = { char, by, answers: {} };
  const secs = r.settings.timer;
  if (secs > 0) {
    p.deadline = Date.now() + secs * 1000;
    p.timer = setTimeout(() => {
      if (r.pending === p) { tryReveal(r, true); emitState(r); }
    }, secs * 1000);
  }
  r.pending = p;
}

function tryReveal(r, force) {
  if (!r.pending) return;
  const need = active(r).filter(id => r.players[id].connected);
  const done = need.every(id => r.pending.answers[id]);
  if (!done && !force) return;
  const answers = {};
  active(r).forEach(id => { answers[id] = r.pending.answers[id] || '?'; });
  r.log.push({ id: ++r.lid, char: r.pending.char, by: r.players[r.pending.by].name, answers, flags: {} });
  clearPending(r);
  advance(r);
}

function checkOver(r) {
  if (r.phase === 'play' && active(r).length <= 1) r.phase = 'over';
}

function removePlayer(r, target) {
  const t = r.players[target];
  if (!t) return;
  r.guesses = r.guesses.filter(x => x.target !== target && x.guesser !== target);
  Object.keys(r.threads).forEach(k => { if (k.split('|').includes(target)) delete r.threads[k]; });
  if (r.pending) {
    delete r.pending.answers[target];
    if (r.pending.by === target) clearPending(r);
  }
  t.out = true;
  if (r.turn === target) advance(r);
  delete r.players[target];
  r.order = r.order.filter(id => id !== target);
  if (!r.order.length) { clearPending(r); delete rooms[r.code]; return; }
  if (r.hostPid === target) r.hostPid = r.order.find(id => r.players[id].connected) || r.order[0];
  if (r.phase === 'themes') {
    if (r.order.length < 2) {
      r.phase = 'lobby';
      r.order.forEach(id => { r.players[id].theme = null; });
    } else if (r.order.every(id => r.players[id].theme)) {
      r.phase = 'play';
      r.turn = r.order[0];
    }
  }
  if (r.phase === 'play') { tryReveal(r); checkOver(r); }
}

/* ---------- sockets ---------- */
io.on('connection', socket => {
  const ctx = () => {
    const r = rooms[socket.data.code];
    if (!r) return null;
    const p = r.players[socket.data.pid];
    return p ? { r, p, pid: p.pid } : null;
  };
  const err = m => socket.emit('notice', m);
  const attach = (r, pid) => {
    socket.data = { code: r.code, pid };
    r.players[pid].sid = socket.id;
    r.players[pid].connected = true;
  };

  socket.on('create', ({ name }, cb) => {
    name = clean(name, 20);
    if (!name) return cb({ error: 'Enter a name' });
    const code = newCode();
    const pid = uid();
    const r = rooms[code] = {
      code, hostPid: pid, phase: 'lobby', settings: { ...DEFAULTS },
      players: {}, order: [], turn: null, pending: null, log: [], lid: 0, guesses: [], gid: 0, threads: {},
    };
    r.players[pid] = { pid, name, score: 0, out: false, theme: null, supers: 0 };
    r.order.push(pid);
    attach(r, pid);
    cb({ code, pid });
    emitState(r);
  });

  socket.on('join', ({ name, code }, cb) => {
    code = String(code || '').toUpperCase().trim();
    name = clean(name, 20);
    const r = rooms[code];
    if (!name) return cb({ error: 'Enter a name' });
    if (!r) return cb({ error: 'No room with that code' });
    if (r.phase === 'over') return cb({ error: 'That game has finished' });
    if (r.order.some(id => r.players[id].name.toLowerCase() === name.toLowerCase())) return cb({ error: 'That name is taken' });
    const late = r.phase === 'play';
    const pid = uid();
    r.players[pid] = { pid, name, score: 0, out: late, theme: null, supers: 0 };
    r.order.push(pid);
    attach(r, pid);
    cb({ code, pid });
    if (late) broadcast(r, name + ' joined as a spectator');
    emitState(r);
  });

  socket.on('rejoin', ({ code, pid }, cb) => {
    const r = rooms[code];
    if (!r || !r.players[pid]) return cb(false);
    attach(r, pid);
    cb(true);
    emitState(r);
  });

  socket.on('settings', s => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid || c.r.phase !== 'lobby') return;
    c.r.settings = {
      category: clean(s.category, 40) || DEFAULTS.category,
      spectator: s.spectator === 'full' ? 'full' : 'ghost',
      penalty: !!s.penalty,
      difficulty: ['easy', 'medium', 'hard'].includes(s.difficulty) ? s.difficulty : 'medium',
      timer: [0, 15, 20, 30, 45, 60].includes(Number(s.timer)) ? Number(s.timer) : 30,
      bonus: !!s.bonus,
      chat: ['off', 'out', 'anyone'].includes(s.chat) ? s.chat : 'out',
      supers: [0, 1, 2, 3, 5].includes(Number(s.supers)) ? Number(s.supers) : 2,
    };
    emitState(c.r);
  });

  socket.on('start', () => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid || c.r.phase !== 'lobby') return;
    if (c.r.order.length < 2) return err('Need at least 2 players');
    c.r.order.forEach(id => { c.r.players[id].supers = c.r.settings.supers; });
    c.r.phase = 'themes';
    emitState(c.r);
  });

  socket.on('theme', ({ text }) => {
    const c = ctx(); if (!c || c.r.phase !== 'themes') return;
    text = clean(text, 60);
    if (!text) return;
    c.p.theme = text;
    if (c.r.order.every(id => c.r.players[id].theme)) { c.r.phase = 'play'; c.r.turn = c.r.order[0]; }
    emitState(c.r);
  });

  socket.on('forcePlay', () => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid || c.r.phase !== 'themes') return;
    const r = c.r;
    if (!c.p.theme) return err('Lock in your own theme first');
    const keep = r.order.filter(id => r.players[id].theme);
    if (keep.length < 2) return err('Need at least 2 players with themes');
    r.order.filter(id => !keep.includes(id)).forEach(id => {
      const p = r.players[id];
      if (p.sid) io.to(p.sid).emit('kicked');
      delete r.players[id];
    });
    r.order = keep;
    r.phase = 'play';
    r.turn = r.order[0];
    emitState(r);
  });

  socket.on('char', ({ text, force }, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    const c = ctx(); if (!c) return done({});
    const { r, p, pid } = c;
    if (r.phase !== 'play' || r.turn !== pid || r.pending || p.out) return done({});
    text = clean(text, 60);
    if (!text) return done({});
    if (r.log.some(l => nameKey(l.char) === nameKey(text))) { err('That character was already played'); return done({ error: true }); }
    if (!force) {
      const sim = r.log.find(l => similar(l.char, text));
      if (sim) return done({ similar: sim.char });
    }
    startPending(r, text, pid);
    done({ ok: true });
    emitState(r);
  });

  socket.on('retract', () => {
    const c = ctx(); if (!c || !c.r.pending || c.r.pending.by !== c.pid) return;
    // refund any super yes used on the retracted character
    Object.entries(c.r.pending.answers).forEach(([id, a]) => {
      if (a === 'S' && c.r.players[id]) c.r.players[id].supers = (c.r.players[id].supers || 0) + 1;
    });
    clearPending(c.r);
    emitState(c.r);
  });

  socket.on('answer', ({ v }) => {
    const c = ctx(); if (!c || !c.r.pending || c.p.out) return;
    if (!['Y', 'N', '?', 'S'].includes(v)) return;
    if (c.r.pending.answers[c.pid]) return; // already answered
    if (v === 'S') {
      if (!(c.p.supers > 0)) return err('No super yes left');
      c.p.supers--;
    }
    c.r.pending.answers[c.pid] = v;
    tryReveal(c.r);
    emitState(c.r);
  });

  socket.on('flag', ({ id, target }) => {
    const c = ctx(); if (!c || c.r.phase !== 'play') return;
    const { r, p, pid } = c;
    const l = r.log.find(x => x.id === id);
    if (!l || target === pid || !(target in l.answers)) return;
    const f = l.flags[target] || (l.flags[target] = []);
    if (f.includes(pid)) return;
    f.push(pid);
    toPlayer(r, target, p.name + ' flagged your answer for "' + l.char + '"');
    emitState(r);
  });

  socket.on('amend', ({ id, v }) => {
    const c = ctx(); if (!c) return;
    const l = c.r.log.find(x => x.id === id);
    if (!l || !l.flags[c.pid] || !['Y', 'N', '?'].includes(v)) return;
    l.answers[c.pid] = v;
    delete l.flags[c.pid];
    broadcast(c.r, c.p.name + ' changed an answer for "' + l.char + '"');
    emitState(c.r);
  });

  socket.on('guess', ({ target, text }) => {
    const c = ctx(); if (!c || c.r.phase !== 'play') return;
    const { r, p, pid } = c;
    text = clean(text, 80);
    const t = r.players[target];
    if (!text || !t || t.out || target === pid) return err('Pick a player and type a guess');
    const ghost = p.out;
    if (ghost && r.settings.spectator !== 'ghost') return err('Ghost votes are off');
    r.guesses.push({ id: ++r.gid, guesser: pid, target, text, ghost });
    toPlayer(r, target, ghost ? 'A spectator is guessing your theme' : p.name + ' is guessing your theme');
    emitState(r);
  });

  socket.on('judge', ({ id, verdict }) => {
    const c = ctx(); if (!c || c.r.phase !== 'play') return;
    const { r, p, pid } = c;
    const g = r.guesses.find(x => x.id === id && x.target === pid);
    if (!g) return;
    r.guesses = r.guesses.filter(x => x !== g);
    const gr = r.players[g.guesser];
    if (verdict === 'right') {
      if (g.ghost) {
        toPlayer(r, g.guesser, 'Ghost vote correct! The owner has been notified.');
        toPlayer(r, pid, 'A spectator read your theme: ' + g.text);
      } else {
        let pts = 1, note = '';
        if (r.settings.bonus) {
          if (r.log.length < 5) { pts += 1; note += ' (+1 quick read)'; }
          if (r.log.length >= 12) { p.score += 1; note += ' (+1 to ' + p.name + ' for staying hidden)'; }
        }
        gr.score += pts;
        p.out = true;
        r.guesses = r.guesses.filter(x => x.target !== pid && x.guesser !== pid);
        if (r.pending) delete r.pending.answers[pid];
        broadcast(r, gr.name + ' guessed ' + p.name + "'s theme: " + p.theme + note);
        if (r.turn === pid && !r.pending) advance(r);
        tryReveal(r);
        checkOver(r);
      }
    } else if (verdict === 'close') {
      toPlayer(r, g.guesser, 'Close! "' + g.text + '" is near ' + (g.ghost ? 'their' : p.name + "'s") + ' theme. Try rewording it.');
    } else {
      if (!g.ghost && r.settings.penalty) gr.score -= 1;
      toPlayer(r, g.guesser, 'Wrong guess: ' + g.text + (!g.ghost && r.settings.penalty ? ' (-1)' : ''));
    }
    emitState(r);
  });

  socket.on('msg', ({ to, text }) => {
    const c = ctx(); if (!c) return;
    const { r, p, pid } = c;
    const t = r.players[to];
    text = clean(text, 200);
    if (!t || !text || to === pid) return;
    if (!chatAllowed(r, p, t)) return err('Messages are not open between you two right now');
    const key = threadKey(pid, to);
    const th = r.threads[key] || (r.threads[key] = []);
    th.push({ from: pid, text });
    if (th.length > 100) th.shift();
    emitOne(r, pid);
    emitOne(r, to);
  });

  socket.on('kick', ({ pid: target }) => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid) return;
    const r = c.r;
    const t = r.players[target];
    if (!t || target === c.pid) return;
    if (t.sid) io.to(t.sid).emit('kicked');
    removePlayer(r, target);
    emitState(r);
  });

  socket.on('leave', () => {
    const c = ctx(); if (!c) return;
    const r = c.r;
    socket.data = {};
    removePlayer(r, c.pid);
    if (rooms[r.code]) emitState(r);
  });

  socket.on('forceContinue', () => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid || c.r.phase !== 'play') return;
    if (c.r.pending) tryReveal(c.r, true); else advance(c.r);
    emitState(c.r);
  });

  socket.on('endGame', () => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid) return;
    clearPending(c.r);
    c.r.phase = 'over';
    emitState(c.r);
  });

  socket.on('rematch', () => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid || c.r.phase !== 'over') return;
    const r = c.r;
    r.order.filter(id => !r.players[id].connected).forEach(id => delete r.players[id]);
    r.order = r.order.filter(id => r.players[id]);
    r.order.forEach(id => {
      const p = r.players[id];
      p.score = 0; p.out = false; p.theme = null; p.supers = 0;
    });
    r.log = []; r.guesses = []; r.threads = {}; r.turn = null;
    clearPending(r);
    r.phase = 'lobby';
    emitState(r);
  });

  socket.on('disconnect', () => {
    const c = ctx(); if (!c || c.p.sid !== socket.id) return;
    const { r, pid } = c;
    c.p.connected = false;
    if (r.phase === 'play') {
      if (r.turn === pid && !r.pending) advance(r);
      tryReveal(r);
    }
    emitState(r);
    if (r.hostPid === pid) {
      setTimeout(() => {
        const rr = rooms[r.code];
        if (!rr || rr.hostPid !== pid || !rr.players[pid] || rr.players[pid].connected) return;
        const next = rr.order.find(id => rr.players[id].connected);
        if (next) { rr.hostPid = next; toPlayer(rr, next, 'You are now the host'); emitState(rr); }
      }, 30000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Theme Game running.');
  console.log('  This computer: http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log('  Same Wi-Fi:    http://' + i.address + ':' + PORT);
});
