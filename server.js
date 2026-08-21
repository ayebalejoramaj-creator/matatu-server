/* =========================================================================
   MATATU MULTIPLAYER SERVER
   - Serves the static frontend from /public
   - Manages rooms (private via code, or public in the lobby)
   - Runs the authoritative MatatuEngine per room
   - Talks to clients over Socket.IO
   ========================================================================= */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MatatuEngine } = require('./engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // tighten this to your real domain once you have one
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

/* ---- In-memory room store ------------------------------------------
   Fine for one server instance / MVP. If this ever needs to scale across
   multiple server processes, this map would move to Redis — not needed
   for launch. */
const rooms = new Map(); // code -> Room

const MAX_SEATS = 4;
const MIN_SEATS_TO_START = 2;

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function publicRoomList() {
  return Array.from(rooms.values())
    .filter(r => r.isPublic && !r.started)
    .map(r => ({
      code: r.code,
      name: r.name,
      seated: r.seats.filter(Boolean).length,
      maxSeats: r.maxSeats,
    }));
}

function broadcastLobby() {
  io.to('lobby').emit('lobby:update', publicRoomList());
}

function roomSummary(room) {
  return {
    code: room.code,
    name: room.name,
    isPublic: room.isPublic,
    maxSeats: room.maxSeats,
    config: room.config,
    started: room.started,
    hostSeat: room.hostSeat,
    seats: room.seats.map(s => s ? { name: s.name, connected: s.connected } : null),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomSummary(room));
}

function broadcastGameState(room) {
  room.seats.forEach((seat, idx) => {
    if (!seat) return;
    const view = room.engine.viewFor(idx);
    io.to(seat.socketId).emit('game:state', view);
  });
}

function createRoom({ name, isPublic, config, hostSocketId, hostName }) {
  const code = makeRoomCode();
  const maxSeats = Math.min(Math.max(config.numPlayers || 3, 2), MAX_SEATS);
  const room = {
    code,
    name: name || `${hostName}'s table`,
    isPublic: !!isPublic,
    maxSeats,
    config: {
      startingHandSize: config.startingHandSize || 5,
      useJokers: config.useJokers !== false,
      allowStacking: config.allowStacking !== false,
      numPlayers: maxSeats,
    },
    seats: new Array(maxSeats).fill(null),
    hostSeat: 0,
    started: false,
    engine: null,
  };
  room.seats[0] = { socketId: hostSocketId, name: hostName, connected: true };
  rooms.set(code, room);
  return room;
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    const idx = room.seats.findIndex(s => s && s.socketId === socketId);
    if (idx !== -1) return { room, idx };
  }
  return null;
}

function seatCount(room) { return room.seats.filter(Boolean).length; }

function firstOpenSeat(room) { return room.seats.findIndex(s => s === null); }

io.on('connection', (socket) => {
  /* ---- Lobby ---- */
  socket.on('lobby:join', () => {
    socket.join('lobby');
    socket.emit('lobby:update', publicRoomList());
  });
  socket.on('lobby:leave', () => socket.leave('lobby'));

  /* ---- Room creation / joining ---- */
  socket.on('room:create', ({ name, isPublic, config, hostName }, ack) => {
    const room = createRoom({ name, isPublic, config: config || {}, hostSocketId: socket.id, hostName: hostName || 'Host' });
    socket.join(room.code);
    ack && ack({ ok: true, code: room.code, seatIndex: 0 });
    broadcastRoom(room);
    if (room.isPublic) broadcastLobby();
  });

  socket.on('room:join', ({ code, name }, ack) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return ack && ack({ ok: false, error: 'Room not found.' });
    if (room.started) return ack && ack({ ok: false, error: 'That game already started.' });
    const openIdx = firstOpenSeat(room);
    if (openIdx === -1) return ack && ack({ ok: false, error: 'Room is full.' });

    room.seats[openIdx] = { socketId: socket.id, name: name || 'Player', connected: true };
    socket.join(room.code);
    ack && ack({ ok: true, code: room.code, seatIndex: openIdx });
    broadcastRoom(room);
    if (room.isPublic) broadcastLobby();
  });

  socket.on('room:leave', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, idx } = found;
    room.seats[idx] = null;
    socket.leave(room.code);
    if (seatCount(room) === 0) {
      rooms.delete(room.code);
    } else {
      if (idx === room.hostSeat) {
        room.hostSeat = room.seats.findIndex(Boolean);
      }
      broadcastRoom(room);
    }
    if (room.isPublic) broadcastLobby();
  });

  socket.on('room:start', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, idx } = found;
    if (idx !== room.hostSeat) return socket.emit('room:error', 'Only the host can start the game.');
    if (seatCount(room) < MIN_SEATS_TO_START) return socket.emit('room:error', `Need at least ${MIN_SEATS_TO_START} players.`);

    room.started = true;
    room.engine = new MatatuEngine(room.config);
    const activePlayers = room.seats
      .map((s, i) => s ? { id: s.socketId, name: s.name, seatIdx: i } : null)
      .filter(Boolean);

    // Map seat index -> engine player index (compacted, in seat order)
    room.seatToEngineIdx = {};
    activePlayers.forEach((p, engineIdx) => { room.seatToEngineIdx[p.seatIdx] = engineIdx; });

    room.engine.on('stateChange', () => broadcastGameState(room));
    room.engine.on('gameOver', ({ winner }) => {
      io.to(room.code).emit('game:over', { winnerName: room.engine.state.players[winner].name });
    });
    room.engine.on('invalidMove', ({ reason, playerIdx }) => {
      const seatIdx = Object.keys(room.seatToEngineIdx).find(s => room.seatToEngineIdx[s] === playerIdx);
      if (seatIdx === undefined) return;
      const seat = room.seats[seatIdx];
      if (seat) io.to(seat.socketId).emit('game:invalidMove', { reason });
    });

    room.engine.newGame(activePlayers.map(p => ({ id: p.id, name: p.name })));
    broadcastRoom(room);
    broadcastGameState(room);
    if (room.isPublic) broadcastLobby();
  });

  /* ---- In-game actions ---- */
  function withEngineSeat(socket, fn) {
    const found = findRoomBySocket(socket.id);
    if (!found || !found.room.engine) return;
    const { room, idx } = found;
    const engineIdx = room.seatToEngineIdx[idx];
    if (engineIdx === undefined) return;
    fn(room.engine, engineIdx);
  }

  socket.on('game:play', ({ cardId }) => {
    withEngineSeat(socket, (engine, engineIdx) => engine.dispatch({ type: 'PLAY', playerIdx: engineIdx, cardId }));
  });
  socket.on('game:draw', () => {
    withEngineSeat(socket, (engine, engineIdx) => engine.dispatch({ type: 'DRAW', playerIdx: engineIdx }));
  });
  socket.on('game:pass', () => {
    withEngineSeat(socket, (engine, engineIdx) => engine.dispatch({ type: 'PASS', playerIdx: engineIdx }));
  });
  socket.on('game:chooseSuit', ({ suit }) => {
    withEngineSeat(socket, (engine, engineIdx) => engine.dispatch({ type: 'CHOOSE_SUIT', playerIdx: engineIdx, suit }));
  });

  /* ---- Disconnect handling ----
     We don't immediately free the seat — give a short grace period in
     case it's just a phone lock / brief network drop. */
  socket.on('disconnect', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, idx } = found;
    room.seats[idx].connected = false;
    broadcastRoom(room);

    setTimeout(() => {
      const stillThere = room.seats[idx];
      if (stillThere && stillThere.socketId === socket.id && !stillThere.connected) {
        room.seats[idx] = null;
        if (seatCount(room) === 0) {
          rooms.delete(room.code);
        } else {
          if (idx === room.hostSeat) room.hostSeat = room.seats.findIndex(Boolean);
          broadcastRoom(room);
        }
        if (room.isPublic) broadcastLobby();
      }
    }, 30000); // 30s grace period
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Matatu server listening on :${PORT}`));
