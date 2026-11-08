(() => {
  'use strict';
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const GRID = 21;
  const TILE = 24;
  const DIRS = {
    up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 }
  };
  const DIR_ORDER = ['up', 'left', 'down', 'right'];
  const ghostColors = ['#ff5876', '#f28dbf', '#69e5ef'];
  const ghostNames = ['BLINK', 'ECHO', 'STATIC'];
  let board = [], player, ghosts = [], pellets = 0, score = 0, best = Number(localStorage.getItem('maze-memory-best') || 0);
  let level = 1, lives = 3, state = 'ready', lastTime = 0, accumulator = 0, powerTime = 0, soundOn = true;
  let routeCounts = new Map(), routeSamples = [], learnedRoute = [], levelTrace = [], stepCounter = 0, frame = 0;
  let audioCtx = null;

  function seededRandom(seed) {
    let n = seed >>> 0;
    return () => { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; };
  }
  function key(x, y) { return `${x},${y}`; }
  function inside(x, y) { return x >= 0 && y >= 0 && x < GRID && y < GRID; }
  function walkable(x, y) { return inside(x, y) && board[y] && board[y][x] !== '#'; }

  function makeMaze(stage) {
    const rng = seededRandom(4817 + stage * 991);
    const grid = Array.from({ length: GRID }, () => Array(GRID).fill('#'));
    const visited = new Set();
    const start = { x: 1, y: 1 };
    const stack = [start];
    visited.add(key(start.x, start.y)); grid[start.y][start.x] = '.';
    while (stack.length) {
      const current = stack[stack.length - 1];
      const options = DIR_ORDER.map(name => ({ name, d: DIRS[name] })).filter(({ d }) => {
        const x = current.x + d.x * 2, y = current.y + d.y * 2;
        return x > 0 && y > 0 && x < GRID - 1 && y < GRID - 1 && !visited.has(key(x, y));
      });
      if (!options.length) { stack.pop(); continue; }
      const { d } = options[Math.floor(rng() * options.length)];
      const nx = current.x + d.x * 2, ny = current.y + d.y * 2;
      grid[current.y + d.y][current.x + d.x] = '.';
      grid[ny][nx] = '.'; visited.add(key(nx, ny)); stack.push({ x: nx, y: ny });
    }
    // Open a handful of loops so every chase has more than one answer.
    for (let y = 1; y < GRID - 1; y++) for (let x = 1; x < GRID - 1; x++) {
      if (grid[y][x] === '#' && ((x % 2 === 0 && y % 2 === 1) || (x % 2 === 1 && y % 2 === 0)) && rng() < .17) grid[y][x] = '.';
    }
    // A small open ghost den, connected to the rest of the maze.
    for (let y = 8; y <= 11; y++) for (let x = 8; x <= 12; x++) grid[y][x] = '.';
    grid[7][10] = '.';
    // Keep an open approach to the player's start.
    for (let x = 9; x <= 11; x++) grid[19][x] = '.';
    grid[18][10] = '.';
    // Put power cores far apart; all remaining corridors hold a shard.
    grid[1][1] = 'o'; grid[1][19] = 'o'; grid[19][1] = 'o'; grid[19][19] = 'o';
    grid[9][10] = ' ';
    return grid;
  }

  function countPellets() {
    pellets = board.reduce((sum, row) => sum + row.filter(cell => cell === '.' || cell === 'o').length, 0);
  }
  function initActors() {
    player = { x: 10, y: 19, fromX: 10, fromY: 19, dir: 'left', nextDir: 'left', moveTime: 0 };
    const starts = [{ x: 10, y: 9 }, { x: 9, y: 9 }, { x: 11, y: 9 }];
    ghosts = starts.map((pos, i) => ({ ...pos, fromX: pos.x, fromY: pos.y, dir: i === 1 ? 'left' : 'right', moveTime: .25 + i * .12, personality: i }));
    powerTime = 0;
  }
  function newLevel() {
    board = makeMaze(level); countPellets(); initActors(); routeCounts = new Map(); routeSamples = []; levelTrace = []; stepCounter = 0;
    $('level').textContent = String(level).padStart(2, '0');
    updateHud(); draw();
  }
  function resetGame() {
    score = 0; level = 1; lives = 3; learnedRoute = []; state = 'playing'; accumulator = 0;
    $('overlay').classList.add('hidden'); $('pauseBadge').classList.remove('visible');
    newLevel(); updateHud(); playTone(440, .08);
  }
  function updateHud() {
    $('score').textContent = String(score).padStart(6, '0');
    $('best').textContent = String(best).padStart(6, '0');
    $('level').textContent = String(level).padStart(2, '0');
    [...$('lives').children].forEach((heart, i) => heart.classList.toggle('lost', i >= lives));
    const inherited = learnedRoute.length ? Math.min(42, learnedRoute.length * 2) : 0;
    const current = Math.min(58, routeCounts.size * 3);
    const percent = Math.min(100, inherited + current);
    $('memoryFill').style.width = `${percent}%`; $('memoryMarker').style.left = `${percent}%`;
    const total = learnedRoute.length + routeCounts.size;
    $('memoryCount').textContent = `${total} TRACE POINT${total === 1 ? '' : 'S'}`;
    $('memoryNote').textContent = learnedRoute.length ? 'They’re replaying last level’s turns.' : routeCounts.size > 5 ? 'They’re starting to predict your turns.' : 'They don’t know your rhythm. Yet.';
    $('statusText').textContent = state === 'playing' ? (powerTime > 0 ? 'POWER UP' : 'IN MOTION') : state === 'over' ? 'RUN OVER' : state === 'paused' ? 'PAUSED' : 'READY';
  }

  function setDirection(name) {
    if (!DIRS[name]) return;
    if (state === 'ready') startGame();
    player.nextDir = name;
  }
  function startGame() {
    if (state === 'over' || state === 'ready') resetGame();
    else if (state === 'paused') togglePause();
  }
  function togglePause() {
    if (state === 'playing') { state = 'paused'; $('pauseBadge').classList.add('visible'); $('pauseButton').innerHTML = '▶ <span>RESUME</span>'; }
    else if (state === 'paused') { state = 'playing'; $('pauseBadge').classList.remove('visible'); $('pauseButton').innerHTML = 'Ⅱ <span>PAUSE</span>'; lastTime = performance.now(); }
    updateHud();
  }
  function soundToggle() {
    soundOn = !soundOn; $('soundIcon').textContent = soundOn ? '♪' : '×'; document.querySelector('.sound-label').textContent = soundOn ? 'SOUND ON' : 'SOUND OFF';
  }
  function playTone(freq, duration = .06, type = 'sine') {
    if (!soundOn) return;
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = type; osc.frequency.value = freq; gain.gain.setValueAtTime(.035, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + duration);
      osc.connect(gain); gain.connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + duration);
    } catch (_) { /* Audio is optional. */ }
  }

  function playerStep() {
    let direction = player.nextDir;
    let d = DIRS[direction];
    if (!walkable(player.x + d.x, player.y + d.y)) {
      direction = player.dir; d = DIRS[direction];
      if (!walkable(player.x + d.x, player.y + d.y)) return false;
    }
    player.fromX = player.x; player.fromY = player.y; player.x += d.x; player.y += d.y; player.dir = direction;
    const tile = board[player.y][player.x];
    if (tile === '.' || tile === 'o') {
      board[player.y][player.x] = ' '; pellets--; score += tile === 'o' ? 50 : 10;
      if (tile === 'o') { powerTime = 7; playTone(680, .22, 'triangle'); }
      else if (score % 50 === 0) playTone(560, .035);
      if (score > best) { best = score; localStorage.setItem('maze-memory-best', String(best)); }
      playTone(300 + Math.random() * 60, .025);
    }
    remember(player.x, player.y);
    if (pellets <= 0) finishLevel();
    updateHud();
    return true;
  }
  function remember(x, y) {
    const k = key(x, y); routeCounts.set(k, (routeCounts.get(k) || 0) + 1);
    if (stepCounter++ % 2 === 0) { routeSamples.push({ x, y }); if (routeSamples.length > 120) routeSamples.shift(); }
    levelTrace.push({ x, y }); if (levelTrace.length > 220) levelTrace.shift();
  }
  function finishLevel() {
    learnedRoute = routeSamples.slice(); level++; score += 500;
    state = 'levelup'; $('overlayKicker').textContent = 'PATTERN CAPTURED'; $('overlayTitle').innerHTML = 'They know<br>your next move.';
    $('overlayText').textContent = `The ghosts saved ${learnedRoute.length} trace points. Level ${level} is already adapting.`;
    $('playButton').querySelector('span').textContent = 'NEXT LEVEL'; $('overlayHint');
    $('overlay').classList.remove('hidden'); $('pauseBadge').classList.remove('visible'); playTone(770, .3, 'triangle'); updateHud();
  }
  function revive() {
    lives--;
    if (lives <= 0) {
      state = 'over'; $('overlayKicker').textContent = 'END OF RUN'; $('overlayTitle').innerHTML = 'The maze<br>got your measure.';
      $('overlayText').textContent = `You scored ${String(score).padStart(6, '0')} and left ${routeCounts.size} trace points behind. Try a new route.`;
      $('playButton').querySelector('span').textContent = 'PLAY AGAIN'; $('overlay').classList.remove('hidden'); playTone(130, .45, 'sawtooth');
    } else {
      player.x = 10; player.y = 19; player.fromX = 10; player.fromY = 19; player.dir = 'left'; player.nextDir = 'left';
      ghosts.forEach((g, i) => { g.x = [10, 9, 11][i]; g.y = 9; g.fromX = g.x; g.fromY = g.y; });
      powerTime = 0; playTone(190, .22, 'sawtooth');
    }
    updateHud();
  }
  function finishCollision() {
    for (const g of ghosts) {
      if (g.x === player.x && g.y === player.y) {
        if (powerTime > 0) { g.x = [10, 9, 11][g.personality]; g.y = 9; g.fromX = g.x; g.fromY = g.y; score += 200; playTone(880, .1, 'triangle'); }
        else { revive(); return; }
      }
    }
  }

  function bfs(startX, startY, targetX, targetY) {
    if (startX === targetX && startY === targetY) return [];
    const queue = [{ x: startX, y: startY, path: [] }], seen = new Set([key(startX, startY)]);
    while (queue.length) {
      const item = queue.shift();
      for (const name of DIR_ORDER) {
        const d = DIRS[name], x = item.x + d.x, y = item.y + d.y, k = key(x, y);
        if (!walkable(x, y) || seen.has(k)) continue;
        const path = item.path.concat(name);
        if (x === targetX && y === targetY) return path;
        seen.add(k); queue.push({ x, y, path });
      }
    }
    return [];
  }
  function nearestLearnedTarget(g) {
    if (!learnedRoute.length) return null;
    // Replay a point from the previous route, weighted toward frequently visited cells.
    const offset = (stepCounter * 3 + g.personality * 17) % learnedRoute.length;
    for (let i = 0; i < Math.min(16, learnedRoute.length); i++) {
      const point = learnedRoute[(offset + i * 7) % learnedRoute.length];
      if (walkable(point.x, point.y) && !(point.x === g.x && point.y === g.y)) return point;
    }
    return learnedRoute[offset];
  }
  function targetFor(g) {
    if (powerTime > 0) return { x: g.x < GRID / 2 ? GRID - 2 : 1, y: g.y < GRID / 2 ? GRID - 2 : 1 };
    const learned = nearestLearnedTarget(g);
    if (g.personality === 1 && learned) return learned;
    if (g.personality === 2 && learned && Math.random() < .72) return learned;
    if (g.personality === 2) {
      const d = DIRS[player.dir]; return { x: Math.max(1, Math.min(GRID - 2, player.x + d.x * 3)), y: Math.max(1, Math.min(GRID - 2, player.y + d.y * 3)) };
    }
    // Blink hunts directly, but learned traces give it an occasional interception.
    if (learned && learnedRoute.length > 12 && Math.random() < .18) return learned;
    return { x: player.x, y: player.y };
  }
  function ghostStep(g) {
    const target = targetFor(g);
    const path = bfs(g.x, g.y, target.x, target.y);
    let next = path[0];
    // Don't walk straight back unless trapped or it is the only shortest route.
    if (next && g.dir && DIRS[g.dir].x + DIRS[next].x === 0 && DIRS[g.dir].y + DIRS[next].y === 0) {
      const alternatives = DIR_ORDER.filter(name => {
        const d = DIRS[name]; return walkable(g.x + d.x, g.y + d.y) && !(d.x + DIRS[g.dir].x === 0 && d.y + DIRS[g.dir].y === 0);
      });
      if (alternatives.length) {
        alternatives.sort((a, b) => {
          const da = DIRS[a], db = DIRS[b];
          const pa = bfs(g.x + da.x, g.y + da.y, target.x, target.y).length;
          const pb = bfs(g.x + db.x, g.y + db.y, target.x, target.y).length;
          return pa - pb;
        });
        next = alternatives[0];
      }
    }
    if (!next) {
      const moves = DIR_ORDER.filter(name => { const d = DIRS[name]; return walkable(g.x + d.x, g.y + d.y); });
      next = moves[Math.floor(Math.random() * moves.length)];
    }
    if (next) {
      const d = DIRS[next]; g.fromX = g.x; g.fromY = g.y; g.x += d.x; g.y += d.y; g.dir = next;
    }
  }

  function update(dt) {
    if (state !== 'playing') return;
    if (powerTime > 0) powerTime = Math.max(0, powerTime - dt);
    player.moveTime += dt;
    const playerRate = Math.max(.095, .125 - (level - 1) * .003);
    while (player.moveTime >= playerRate && state === 'playing') { player.moveTime -= playerRate; playerStep(); finishCollision(); }
    ghosts.forEach((g, i) => {
      g.moveTime += dt;
      const rate = Math.max(.105, (.205 + i * .018) - (level - 1) * .006) * (powerTime > 0 ? 1.48 : 1);
      g.visualRate = rate;
      while (g.moveTime >= rate && state === 'playing') { g.moveTime -= rate; ghostStep(g); finishCollision(); }
    });
    if (frame % 8 === 0) updateHud();
  }

  function resize() {
    const cssWidth = canvas.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssWidth * dpr); canvas.height = Math.round(cssWidth * dpr);
    ctx.setTransform(canvas.width / (GRID * TILE), 0, 0, canvas.height / (GRID * TILE), 0, 0);
    draw();
  }
  function draw() {
    const w = GRID * TILE;
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = '#080e1a'; ctx.fillRect(0, 0, w, w);
    // Quiet grid texture behind the corridors.
    ctx.strokeStyle = '#172034'; ctx.lineWidth = .35;
    for (let x = 0; x <= w; x += TILE) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, w); ctx.stroke(); }
    for (let y = 0; y <= w; y += TILE) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      if (board[y]?.[x] === '#') drawWall(x, y);
      else if (board[y]?.[x] === '.') drawPellet(x, y, false);
      else if (board[y]?.[x] === 'o') drawPellet(x, y, true);
    }
    // Subtle ghost den floor marker.
    ctx.strokeStyle = '#405070'; ctx.globalAlpha = .45; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(8 * TILE + 4, 10 * TILE); ctx.lineTo(13 * TILE - 4, 10 * TILE); ctx.stroke(); ctx.globalAlpha = 1;
    if (player) drawPlayer();
    if (ghosts.length) ghosts.forEach(drawGhost);
    // A faint scanline shimmer gives the board a quiet arcade feel.
    ctx.fillStyle = '#fff'; ctx.globalAlpha = .018;
    for (let y = 1; y < w; y += 4) ctx.fillRect(0, y, w, .4);
    ctx.globalAlpha = 1;
  }
  function drawWall(x, y) {
    const px = x * TILE, py = y * TILE;
    ctx.fillStyle = '#101b32'; ctx.fillRect(px, py, TILE, TILE);
    ctx.strokeStyle = '#29406b'; ctx.lineWidth = 1.25;
    ctx.strokeRect(px + .7, py + .7, TILE - 1.4, TILE - 1.4);
    ctx.fillStyle = '#22385e'; ctx.fillRect(px + 3, py + 3, TILE - 6, 1);
  }
  function drawPellet(x, y, power) {
    const cx = x * TILE + TILE / 2, cy = y * TILE + TILE / 2;
    if (power) {
      const pulse = 1 + Math.sin(performance.now() / 170) * .16;
      ctx.shadowColor = '#d8f36a'; ctx.shadowBlur = 12;
      ctx.fillStyle = '#e8ff8d'; ctx.beginPath(); ctx.arc(cx, cy, 4.5 * pulse, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = '#a4b8cb'; ctx.globalAlpha = .76; ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    }
  }
  function actorPos(actor) {
    const rate = actor === player ? Math.max(.095, .125 - (level - 1) * .003) : (actor.visualRate || .22);
    const amount = Math.max(0, Math.min(1, actor.moveTime / rate));
    return { x: actor.fromX + (actor.x - actor.fromX) * amount, y: actor.fromY + (actor.y - actor.fromY) * amount };
  }
  function drawPlayer() {
    const pos = actorPos(player);
    const x = pos.x * TILE + TILE / 2, y = pos.y * TILE + TILE / 2;
    const angle = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[player.dir] || 0;
    const mouth = .12 + Math.abs(Math.sin(performance.now() / 75)) * .34;
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    ctx.shadowColor = '#d8f36a'; ctx.shadowBlur = 14; ctx.fillStyle = '#e0fa75';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 8.5, mouth, Math.PI * 2 - mouth); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  function drawGhost(g) {
    const pos = actorPos(g);
    const cx = pos.x * TILE + TILE / 2, cy = pos.y * TILE + TILE / 2;
    const color = powerTime > 0 ? (powerTime < 2 && Math.floor(performance.now() / 130) % 2 ? '#f0f3ff' : '#627cc8') : ghostColors[g.personality];
    ctx.save(); ctx.translate(cx, cy);
    ctx.shadowColor = color; ctx.shadowBlur = powerTime > 0 ? 4 : 10;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(-8, 8); ctx.lineTo(-8, -1); ctx.quadraticCurveTo(-8, -8, 0, -8); ctx.quadraticCurveTo(8, -8, 8, -1); ctx.lineTo(8, 8); ctx.lineTo(4, 5); ctx.lineTo(0, 8); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#f6f7ff'; ctx.beginPath(); ctx.ellipse(-3, -1, 2.4, 3.1, 0, 0, Math.PI * 2); ctx.ellipse(3, -1, 2.4, 3.1, 0, 0, Math.PI * 2); ctx.fill();
    const d = DIRS[g.dir] || DIRS.left; ctx.fillStyle = '#172033'; ctx.beginPath(); ctx.arc(-3 + d.x * .7, -1 + d.y * .7, 1.1, 0, Math.PI * 2); ctx.arc(3 + d.x * .7, -1 + d.y * .7, 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function loop(now) {
    const dt = Math.min(.05, (now - (lastTime || now)) / 1000); lastTime = now; frame++;
    update(dt); draw(); requestAnimationFrame(loop);
  }
  $('playButton').addEventListener('click', () => {
    if (state === 'levelup') { state = 'playing'; $('overlay').classList.add('hidden'); levelTrace = []; routeCounts = new Map(); routeSamples = []; newLevel(); }
    else startGame();
  });
  $('pauseButton').addEventListener('click', () => { if (state === 'ready') return; togglePause(); });
  $('soundButton').addEventListener('click', soundToggle);
  window.addEventListener('keydown', (event) => {
    const keyName = event.key.toLowerCase();
    const map = { arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right' };
    if (map[keyName]) { event.preventDefault(); setDirection(map[keyName]); }
    else if (keyName === 'enter' || keyName === ' ') { event.preventDefault(); if (state === 'levelup') $('playButton').click(); else startGame(); }
    else if (keyName === 'escape' || keyName === 'p') { if (state === 'playing' || state === 'paused') togglePause(); }
  });
  document.querySelectorAll('.control').forEach(button => {
    const press = event => { event.preventDefault(); setDirection(button.dataset.dir); };
    button.addEventListener('pointerdown', press); button.addEventListener('contextmenu', event => event.preventDefault());
  });
  window.addEventListener('resize', resize);
  board = makeMaze(level); countPellets(); initActors(); resize(); updateHud();
  $('overlayHint').innerHTML = 'PRESS <kbd>ENTER</kbd> TO BEGIN';
  requestAnimationFrame(loop);
})();
