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

const active = r => r.order.filter(id => !r.players[id].out);

function view(r, pid) {
  const me = r.players[pid];
  const showAll = r.phase === 'over' || (me.out && r.settings.spectator === 'full');
  return {
    code: r.code, phase: r.phase, settings: r.settings, host: r.hostPid, you: pid, turn: r.turn,
    players: r.order.map(id => {
      const p = r.players[id];
      const themeVisible = showAll || p.out || id === pid;
      return { pid: id, name: p.name, score: p.score, out: p.out, connected: p.connected,
               hasTheme: !!p.theme, theme: themeVisible ? p.theme : null };
    }),
    pending: r.pending ? { char: r.pending.char, by: r.pending.by, answered: Object.keys(r.pending.answers) } : null,
    myAnswer: r.pending ? (r.pending.answers[pid] || null) : null,
    log: r.log,
    guessesForMe: me.out ? [] : r.guesses.filter(g => g.target === pid).map(g => ({
      id: g.id, text: g.text, from: g.ghost ? 'A spectator' : r.players[g.guesser].name
    })),
  };
}

function emitState(r) {
  for (const id of r.order) {
    const p = r.players[id];
    if (p.connected && p.sid) io.to(p.sid).emit('state', view(r, id));
  }
}
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

function advance(r) {
  const act = active(r).filter(id => r.players[id].connected);
  if (!act.length) { r.turn = null; return; }
  const i = r.order.indexOf(r.turn);
  for (let k = 1; k <= r.order.length; k++) {
    const id = r.order[(i + k + r.order.length) % r.order.length];
    if (act.includes(id)) { r.turn = id; return; }
  }
}

function tryReveal(r, force) {
  if (!r.pending) return;
  const need = active(r).filter(id => r.players[id].connected);
  const done = need.every(id => r.pending.answers[id]);
  if (!done && !force) return;
  const answers = {};
  active(r).forEach(id => { answers[id] = r.pending.answers[id] || '?'; });
  r.log.push({ char: r.pending.char, by: r.players[r.pending.by].name, answers });
  r.pending = null;
  advance(r);
}

function checkOver(r) {
  if (r.phase === 'play' && active(r).length <= 1) r.phase = 'over';
}

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
      code, hostPid: pid, phase: 'lobby',
      settings: { category: 'Anime characters', spectator: 'ghost', penalty: true },
      players: {}, order: [], turn: null, pending: null, log: [], guesses: [], gid: 0,
    };
    r.players[pid] = { pid, name, score: 0, out: false, theme: null };
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
    if (r.phase !== 'lobby') return cb({ error: 'That game already started' });
    if (r.order.some(id => r.players[id].name.toLowerCase() === name.toLowerCase())) return cb({ error: 'That name is taken' });
    const pid = uid();
    r.players[pid] = { pid, name, score: 0, out: false, theme: null };
    r.order.push(pid);
    attach(r, pid);
    cb({ code, pid });
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
      category: clean(s.category, 40) || 'Anime characters',
      spectator: s.spectator === 'full' ? 'full' : 'ghost',
      penalty: !!s.penalty,
    };
    emitState(c.r);
  });

  socket.on('start', () => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid || c.r.phase !== 'lobby') return;
    if (c.r.order.length < 2) return err('Need at least 2 players');
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

  socket.on('char', ({ text }) => {
    const c = ctx(); if (!c) return;
    const { r, p, pid } = c;
    if (r.phase !== 'play' || r.turn !== pid || r.pending || p.out) return;
    text = clean(text, 60);
    if (!text) return;
    if (r.log.some(l => l.char.toLowerCase() === text.toLowerCase())) return err('That character was already played');
    r.pending = { char: text, by: pid, answers: {} };
    emitState(r);
  });

  socket.on('answer', ({ v }) => {
    const c = ctx(); if (!c || !c.r.pending || c.p.out) return;
    if (!['Y', 'N', '?'].includes(v)) return;
    c.r.pending.answers[c.pid] = v;
    tryReveal(c.r);
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

  socket.on('judge', ({ id, correct }) => {
    const c = ctx(); if (!c || c.r.phase !== 'play') return;
    const { r, p, pid } = c;
    const g = r.guesses.find(x => x.id === id && x.target === pid);
    if (!g) return;
    r.guesses = r.guesses.filter(x => x !== g);
    const gr = r.players[g.guesser];
    if (correct) {
      if (g.ghost) {
        toPlayer(r, g.guesser, 'Ghost vote correct! The owner has been notified.');
        toPlayer(r, pid, 'A spectator read your theme: ' + g.text);
      } else {
        gr.score += 1;
        p.out = true;
        r.guesses = r.guesses.filter(x => x.target !== pid && x.guesser !== pid);
        if (r.pending) delete r.pending.answers[pid];
        broadcast(r, gr.name + ' guessed ' + p.name + "'s theme: " + p.theme);
        if (r.turn === pid && !r.pending) advance(r);
        tryReveal(r);
        checkOver(r);
      }
    } else {
      if (!g.ghost && r.settings.penalty) gr.score -= 1;
      toPlayer(r, g.guesser, 'Wrong guess: ' + g.text + (!g.ghost && r.settings.penalty ? ' (-1)' : ''));
    }
    emitState(r);
  });

  socket.on('forceContinue', () => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid || c.r.phase !== 'play') return;
    if (c.r.pending) tryReveal(c.r, true); else advance(c.r);
    emitState(c.r);
  });

  socket.on('kick', ({ pid: target }) => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid) return;
    const r = c.r;
    const t = r.players[target];
    if (!t || target === c.pid) return;
    if (t.sid) io.to(t.sid).emit('kicked');

    r.guesses = r.guesses.filter(x => x.target !== target && x.guesser !== target);
    if (r.pending) {
      delete r.pending.answers[target];
      if (r.pending.by === target) r.pending = null;
    }
    t.out = true;
    if (r.turn === target) advance(r);
    delete r.players[target];
    r.order = r.order.filter(id => id !== target);

    if (r.phase === 'themes' && r.order.length >= 2 && r.order.every(id => r.players[id].theme)) {
      r.phase = 'play';
      r.turn = r.order[0];
    }
    if (r.phase === 'play') { tryReveal(r); checkOver(r); }
    emitState(r);
  });
  
  socket.on('endGame', () => {
    const c = ctx(); if (!c || c.pid !== c.r.hostPid) return;
    c.r.phase = 'over';
    emitState(c.r);
  });

  socket.on('disconnect', () => {
    const c = ctx(); if (!c || c.p.sid !== socket.id) return;
    c.p.connected = false;
    if (c.r.phase === 'play') {
      if (c.r.turn === c.pid && !c.r.pending) advance(c.r);
      tryReveal(c.r);
    }
    emitState(c.r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Theme Game running.');
  console.log('  This computer: http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log('  Same Wi-Fi:    http://' + i.address + ':' + PORT);
});
