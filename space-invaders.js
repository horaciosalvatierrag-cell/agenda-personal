(() => {
  'use strict';
  const canvas = document.getElementById('invadersCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const $ = id => document.getElementById(id);
  const stars = Array.from({ length: 95 }, (_, i) => ({ x: (i * 197 + 23) % W, y: (i * 113 + 41) % H, r: i % 7 === 0 ? 1.7 : .8, a: .25 + (i % 5) * .13 }));
  let active = false, running = false, paused = false, gameOver = false, raf = 0, exitCallback = null;
  let score = 0, lives = 3, level = 1, playerX = W / 2, invaders = [], playerShots = [], enemyShots = [], barriers = [], direction = 1, enemySpeed = 30, lastTime = 0, lastFire = 0, enemyFire = 0;
  const held = new Set();

  function wave() {
    invaders = [];
    const rows = Math.min(6, 4 + Math.floor((level - 1) / 2)), cols = 10, gapX = 60, gapY = 43;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) invaders.push({ x: 135 + col * gapX, y: 76 + row * gapY, row, alive: true });
    playerShots = []; enemyShots = []; direction = 1; enemySpeed = 28 + level * 7;
    if (level === 1) barriers = [210, 370, 530, 690].map(x => ({ x, y: H - 142, health: 7 }));
  }
  function updateHud() { $('invadersScore').textContent = score.toLocaleString(); $('invadersLives').textContent = String(lives); $('invadersLevel').textContent = String(level); }
  function reset() { score = 0; lives = 3; level = 1; playerX = W / 2; barriers = []; gameOver = false; paused = false; running = false; wave(); updateHud(); draw(); }
  function drawShip(x, y, scale = 1) {
    ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); ctx.fillStyle = '#6cf5c2'; ctx.shadowColor = '#29e5aa'; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(18, 15); ctx.lineTo(8, 11); ctx.lineTo(0, 16); ctx.lineTo(-8, 11); ctx.lineTo(-18, 15); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#d7fff1'; ctx.fillRect(-3, 2, 6, 11); ctx.restore();
  }
  function drawAlien(alien) {
    const size = 15, colors = ['#ff5e80', '#ffb84d', '#8f78ff', '#4bd9ef', '#b6f36b', '#64caff'];
    ctx.fillStyle = colors[alien.row % colors.length]; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8;
    ctx.fillRect(alien.x - size, alien.y - 6, 5, 4); ctx.fillRect(alien.x + size - 5, alien.y - 6, 5, 4);
    ctx.fillRect(alien.x - 11, alien.y - 10, 22, 13); ctx.fillRect(alien.x - 15, alien.y - 4, 30, 9);
    ctx.clearRect(alien.x - 8, alien.y - 7, 4, 4); ctx.clearRect(alien.x + 4, alien.y - 7, 4, 4);
    ctx.fillStyle = '#09111f'; ctx.fillRect(alien.x - 8, alien.y - 7, 4, 4); ctx.fillRect(alien.x + 4, alien.y - 7, 4, 4); ctx.shadowBlur = 0;
  }
  function overlay(title, subtitle) {
    ctx.fillStyle = '#030817b9'; ctx.fillRect(0, 0, W, H); ctx.textAlign = 'center';
    ctx.shadowColor = '#55e4ff'; ctx.shadowBlur = 18; ctx.fillStyle = '#f4fbff'; ctx.font = '700 39px system-ui,sans-serif'; ctx.fillText(title, W / 2, H / 2 - 4);
    ctx.shadowBlur = 0; ctx.fillStyle = '#a9bfd6'; ctx.font = '17px system-ui,sans-serif'; ctx.fillText(subtitle, W / 2, H / 2 + 32);
  }
  function draw() {
    const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#081229'); bg.addColorStop(1, '#101532'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    stars.forEach((s, i) => { ctx.globalAlpha = s.a * (.72 + .28 * Math.sin(performance.now() / 800 + i)); ctx.fillStyle = i % 3 ? '#e2f3ff' : '#8ba9ff'; ctx.fillRect(s.x, s.y, s.r, s.r); }); ctx.globalAlpha = 1;
    ctx.strokeStyle = '#375072'; ctx.globalAlpha = .65; ctx.beginPath(); ctx.moveTo(25, H - 36); ctx.lineTo(W - 25, H - 36); ctx.stroke(); ctx.globalAlpha = 1;
    barriers.forEach(b => { if (!b.health) return; ctx.fillStyle = `rgba(84,231,170,${.25 + b.health * .085})`; ctx.fillRect(b.x - 38, b.y - 15, 76, 28); ctx.clearRect(b.x - 14, b.y + 2, 28, 12); if (b.health < 5) { ctx.strokeStyle = '#b1ffe1'; ctx.beginPath(); ctx.moveTo(b.x - 23, b.y - 12); ctx.lineTo(b.x - 8, b.y - 2); ctx.lineTo(b.x + 7, b.y - 12); ctx.stroke(); } });
    invaders.forEach(a => { if (a.alive) drawAlien(a); });
    drawShip(playerX, H - 68);
    ctx.fillStyle = '#e9fcff'; ctx.shadowColor = '#50e9ff'; ctx.shadowBlur = 12;
    playerShots.forEach(s => ctx.fillRect(s.x - 2, s.y - 10, 4, 15));
    ctx.fillStyle = '#ff7592'; ctx.shadowColor = '#ff476e'; enemyShots.forEach(s => { ctx.fillRect(s.x - 3, s.y - 8, 6, 13); ctx.fillRect(s.x - 1, s.y - 11, 2, 3); }); ctx.shadowBlur = 0;
    if (!active || !running && !paused && !gameOver) overlay('SPACE INVADERS', 'Pulsa INICIAR para defender la Tierra');
    else if (paused) overlay('PAUSA', 'Pulsa P o CONTINUAR');
    else if (gameOver) overlay('FIN DEL JUEGO', 'Pulsa REINICIAR para volver a jugar');
  }
  function shoot(now) { if (now - lastFire < 310) return; playerShots.push({ x: playerX, y: H - 92 }); lastFire = now; }
  function loseLife() { lives--; updateHud(); playerX = W / 2; enemyShots = []; if (lives <= 0) { gameOver = true; running = false; $('invadersStatus').textContent = 'FIN DEL JUEGO · Pulsa REINICIAR para volver a jugar.'; $('invadersPause').disabled = true; } }
  function update(dt, now) {
    if (held.has('left')) playerX -= 310 * dt; if (held.has('right')) playerX += 310 * dt; playerX = Math.max(34, Math.min(W - 34, playerX));
    if (held.has('fire')) shoot(now);
    let minX = Infinity, maxX = -Infinity;
    for (const a of invaders) if (a.alive) { minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); }
    if (!Number.isFinite(minX)) { score += 100 * level; level++; wave(); updateHud(); $('invadersStatus').textContent = `Oleada ${level} · bonificación +${100 * (level - 1)}`; return; }
    if ((direction > 0 && maxX + 19 >= W - 25) || (direction < 0 && minX - 19 <= 25)) { direction *= -1; invaders.forEach(a => { if (a.alive) a.y += 19; }); }
    invaders.forEach(a => { if (a.alive) { a.x += direction * enemySpeed * dt; if (a.y > H - 105) { gameOver = true; running = false; $('invadersStatus').textContent = 'Los invasores alcanzaron la Tierra.'; } } });
    playerShots.forEach(s => { s.y -= 470 * dt; for (const a of invaders) if (a.alive && Math.abs(s.x - a.x) < 20 && Math.abs(s.y - a.y) < 18) { a.alive = false; s.y = -50; score += (5 - Math.min(4, a.row)) * 10 * level; updateHud(); break; } });
    playerShots = playerShots.filter(s => s.y > -20);
    if (now - enemyFire > Math.max(320, 1150 - level * 55)) { const shooters = invaders.filter(a => a.alive).sort((a, b) => b.y - a.y), lane = new Set(); const bottom = shooters.filter(a => { if (lane.has(a.x)) return false; lane.add(a.x); return true; }); if (bottom.length) { const a = bottom[Math.floor(Math.random() * bottom.length)]; enemyShots.push({ x: a.x, y: a.y + 12, vx: (playerX - a.x) * .07 }); } enemyFire = now; }
    enemyShots.forEach(s => { s.x += (s.vx || 0) * dt; s.y += 230 * dt; for (const b of barriers) if (b.health && Math.abs(s.x - b.x) < 39 && Math.abs(s.y - b.y) < 23) { b.health--; s.y = H + 20; break; } if (Math.abs(s.x - playerX) < 24 && Math.abs(s.y - (H - 68)) < 22) { s.y = H + 20; loseLife(); } });
    enemyShots = enemyShots.filter(s => s.y < H + 10);
  }
  function frame(now) { if (!active || !running) return; const dt = Math.min(.04, (now - (lastTime || now)) / 1000); lastTime = now; update(dt, now); draw(); if (running) raf = requestAnimationFrame(frame); }
  function start() { if (!active) return; if (gameOver) reset(); paused = false; running = true; lastTime = 0; $('invadersStatus').textContent = `Oleada ${level} · ¡Destruye a los invasores!`; $('invadersPause').disabled = false; cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); }
  function togglePause() { if (!active || gameOver) return; if (running) { running = false; paused = true; cancelAnimationFrame(raf); $('invadersStatus').textContent = 'Juego pausado.'; } else if (paused) start(); draw(); }
  function keydown(event) { if (!active || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') || event.target?.isContentEditable) return; if (event.key === 'Escape') { event.preventDefault(); exit(); return; } const keys = ['ArrowLeft', 'ArrowRight', ' ', 'Spacebar']; if (keys.includes(event.key) || event.code === 'Space') event.preventDefault(); if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') held.add('left'); if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') held.add('right'); if (event.code === 'Space') held.add('fire'); if (event.key.toLowerCase() === 'p' && !event.repeat) togglePause(); }
  function keyup(event) { if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') held.delete('left'); if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') held.delete('right'); if (event.code === 'Space') held.delete('fire'); }
  function onControlDown(event) { const button = event.target.closest('[data-invaders-control]'); if (!button || !active) return; event.preventDefault(); const action = button.dataset.invadersControl; if (action === 'left' || action === 'right') held.add(action); else if (action === 'fire') { held.add('fire'); shoot(performance.now()); } else if (action === 'pause') togglePause(); button.setPointerCapture?.(event.pointerId); }
  function onControlUp(event) { const button = event.target.closest('[data-invaders-control]'); if (button) held.delete(button.dataset.invadersControl); }
  function onVisibility() { if (document.hidden && running) togglePause(); }
  function enter(onExit) { leave(); active = true; exitCallback = typeof onExit === 'function' ? onExit : null; reset(); window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); document.addEventListener('visibilitychange', onVisibility); document.querySelector('.invaders-touch-controls').addEventListener('pointerdown', onControlDown); document.querySelector('.invaders-touch-controls').addEventListener('pointerup', onControlUp); document.querySelector('.invaders-touch-controls').addEventListener('pointercancel', onControlUp); }
  function leave() { cancelAnimationFrame(raf); raf = 0; active = running = paused = false; held.clear(); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); document.removeEventListener('visibilitychange', onVisibility); document.querySelector('.invaders-touch-controls')?.removeEventListener('pointerdown', onControlDown); document.querySelector('.invaders-touch-controls')?.removeEventListener('pointerup', onControlUp); document.querySelector('.invaders-touch-controls')?.removeEventListener('pointercancel', onControlUp); exitCallback = null; }
  function exit() { const callback = exitCallback; leave(); draw(); if (callback) callback(); }
  $('invadersStart').addEventListener('click', start); $('invadersPause').addEventListener('click', togglePause); $('invadersRestart').addEventListener('click', () => { if (!active) return; reset(); start(); });
  window.addEventListener('blur', () => held.clear());
  window.AgendaSpaceInvaders = { enter, leave, exit };
  draw();
})();
