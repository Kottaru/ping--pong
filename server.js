const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const GAME_WIDTH = 800;
const GAME_HEIGHT = 500;
const PADDLE_W = 12;
const PADDLE_H = 85;
const BALL_RADIUS = 8;
const WIN_SCORE = 5;
const SPEED_INITIAL = 5.5;
const SPEED_MAX = 13;
const SPEED_INCREMENT = 0.35;
const COUNTDOWN_SECONDS = 3;

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createGameRoom() {
  return {
    players: [{ id: null, name: 'Jogador 1', y: GAME_HEIGHT / 2 - PADDLE_H / 2, score: 0 },
              { id: null, name: 'Jogador 2', y: GAME_HEIGHT / 2 - PADDLE_H / 2, score: 0 }],
    ball: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2, dx: 0, dy: 0, speed: SPEED_INITIAL, trail: [] },
    state: 'waiting',
    countdown: COUNTDOWN_SECONDS,
    countdownTimer: null,
    gameLoop: null,
    paddleSpeed: 6
  };
}

function resetBall(room, dir) {
  const b = room.ball;
  b.x = GAME_WIDTH / 2;
  b.y = GAME_HEIGHT / 2 + (Math.random() * 80 - 40);
  b.speed = SPEED_INITIAL;
  b.dx = dir * b.speed;
  b.dy = (Math.random() * 4 - 2);
}

function startCountdown(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.state = 'countdown';
  room.countdown = COUNTDOWN_SECONDS;
  room.ball = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2, dx: 0, dy: 0, speed: SPEED_INITIAL };

  io.to(roomCode).emit('countdown', { time: room.countdown });
  io.to(roomCode).emit('gameState', getState(roomCode));

  room.countdownTimer = setInterval(() => {
    room.countdown--;
    io.to(roomCode).emit('countdown', { time: room.countdown });

    if (room.countdown <= 0) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      startPlaying(roomCode);
    }
  }, 1000);
}

function startPlaying(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.state = 'playing';
  resetBall(room, Math.random() > 0.5 ? 1 : -1);

  room.gameLoop = setInterval(() => {
    if (room.state !== 'playing') return;
    updateGame(roomCode);
    io.to(roomCode).emit('gameState', getState(roomCode));
  }, 1000 / 60);
}

function updateGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const { players, ball } = room;

  ball.x += ball.dx;
  ball.y += ball.dy;

  ball.trail.push({ x: ball.x, y: ball.y });
  if (ball.trail.length > 8) ball.trail.shift();

  if (ball.y - BALL_RADIUS <= 0 || ball.y + BALL_RADIUS >= GAME_HEIGHT) {
    ball.dy = -ball.dy;
    ball.y = Math.max(BALL_RADIUS, Math.min(GAME_HEIGHT - BALL_RADIUS, ball.y));
  }

  players.forEach((p, idx) => {
    if (ball.x - BALL_RADIUS < PADDLE_W + 20 && ball.x + BALL_RADIUS > 10 &&
        ball.y + BALL_RADIUS > p.y && ball.y - BALL_RADIUS < p.y + PADDLE_H) {
      const hitPos = (ball.y - (p.y + PADDLE_H / 2)) / (PADDLE_H / 2);
      const angle = hitPos * Math.PI / 3.2;
      const dir = idx === 0 ? 1 : -1;
      ball.speed = Math.min(ball.speed + SPEED_INCREMENT, SPEED_MAX);
      ball.dx = dir * ball.speed * Math.cos(angle);
      ball.dy = ball.speed * Math.sin(angle);
      ball.x = idx === 0 ? PADDLE_W + 20 + BALL_RADIUS : GAME_WIDTH - PADDLE_W - 20 - BALL_RADIUS;
    }
  });

  if (ball.x - BALL_RADIUS < 0) {
    players[1].score++;
    if (players[1].score >= WIN_SCORE) {
      endGame(roomCode, players[1].name);
    } else {
      resetBall(room, 1);
      io.to(roomCode).emit('score', { p1: players[0].score, p2: players[1].score });
    }
  }
  if (ball.x + BALL_RADIUS > GAME_WIDTH) {
    players[0].score++;
    if (players[0].score >= WIN_SCORE) {
      endGame(roomCode, players[0].name);
    } else {
      resetBall(room, -1);
      io.to(roomCode).emit('score', { p1: players[0].score, p2: players[1].score });
    }
  }
}

function endGame(roomCode, winner) {
  const room = rooms[roomCode];
  if (!room) return;
  room.state = 'ended';
  if (room.gameLoop) { clearInterval(room.gameLoop); room.gameLoop = null; }
  io.to(roomCode).emit('gameOver', { winner, p1: room.players[0].score, p2: room.players[1].score });
}

function getState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;
  return {
    p1: { y: room.players[0].y, score: room.players[0].score, name: room.players[0].name },
    p2: { y: room.players[1].y, score: room.players[1].score, name: room.players[1].name },
    ball: room.ball,
    state: room.state
  };
}

function cleanupRoom(roomCode) {
  const room = rooms[roomCode];
  if (room) {
    if (room.countdownTimer) clearInterval(room.countdownTimer);
    if (room.gameLoop) clearInterval(room.gameLoop);
  }
  delete rooms[roomCode];
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerIndex = -1;

  socket.on('createRoom', ({ name }) => {
    if (currentRoom) return;
    let code = generateRoomCode();
    while (rooms[code]) code = generateRoomCode();

    rooms[code] = createGameRoom();
    rooms[code].players[0].id = socket.id;
    rooms[code].players[0].name = name || 'Jogador 1';

    socket.join(code);
    currentRoom = code;
    playerIndex = 0;
    socket.emit('roomCreated', { code, playerIndex: 0 });
    socket.emit('gameState', getState(code));
  });

  socket.on('joinRoom', ({ code, name }) => {
    if (currentRoom) return;
    const roomCode = code.toUpperCase().trim();
    const room = rooms[roomCode];

    if (!room) return socket.emit('error', 'Sala não encontrada.');
    if (room.players[0].id && room.players[1].id) return socket.emit('error', 'Sala está cheia.');
    if (room.state !== 'waiting') return socket.emit('error', 'A partida já começou.');

    room.players[1].id = socket.id;
    room.players[1].name = name || 'Jogador 2';

    socket.join(roomCode);
    currentRoom = roomCode;
    playerIndex = 1;

    socket.emit('roomJoined', { code: roomCode, playerIndex: 1 });
    io.to(roomCode).emit('playerJoined', { name: room.players[1].name });
    io.to(roomCode).emit('gameState', getState(roomCode));

    startCountdown(roomCode);
  });

  socket.on('paddleMove', ({ y }) => {
    if (!currentRoom || playerIndex < 0) return;
    const room = rooms[currentRoom];
    if (!room) return;
    const p = room.players[playerIndex];
    p.y = Math.max(0, Math.min(GAME_HEIGHT - PADDLE_H, y));
  });

  socket.on('ping', () => {
    socket.emit('pong');
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      io.to(currentRoom).emit('opponentDisconnected');
      cleanupRoom(currentRoom);
    }
    currentRoom = null;
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
