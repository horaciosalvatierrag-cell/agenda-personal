(() => {
  'use strict';

  const boardCanvas = document.getElementById('tetrisBoard');
  if (!boardCanvas) return;
  const boardContext = boardCanvas.getContext('2d');
  const nextCanvas = document.getElementById('tetrisNext');
  const nextContext = nextCanvas.getContext('2d');
  const WIDTH = 10, HEIGHT = 20, CELL = 30;
  const SHAPES = {
    I: [[1,1,1,1]],
    O: [[1,1],[1,1]],
    T: [[0,1,0],[1,1,1]],
    S: [[0,1,1],[1,1,0]],
    Z: [[1,1,0],[0,1,1]],
    J: [[1,0,0],[1,1,1]],
    L: [[0,0,1],[1,1,1]]
  };
  const COLORS = { I:'#31c7ef', O:'#f4cc36', T:'#a76af5', S:'#5bd18b', Z:'#ee6674', J:'#5688f5', L:'#f09a4a' };
  let board = [], current = null, bag = [], queue = [], timer = 0, repeatTimer = 0;
  let score = 0, lines = 0, level = 1, running = false, paused = false, gameOver = false, active = false, exitCallback = null;
  let pointerControl = null;

  function emptyBoard() { return Array.from({length:HEIGHT}, () => Array(WIDTH).fill('')); }
  function shuffledBag() {
    const pieces = Object.keys(SHAPES);
    for (let i=pieces.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [pieces[i],pieces[j]]=[pieces[j],pieces[i]]; }
    return pieces;
  }
  function takePiece() { if (!bag.length) bag=shuffledBag(); return bag.pop(); }
  function fillQueue() { while (queue.length<4) queue.push(takePiece()); }
  function updateStats() {
    document.getElementById('tetrisScore').textContent=score.toLocaleString();
    document.getElementById('tetrisLevel').textContent=String(level);
    document.getElementById('tetrisLines').textContent=String(lines);
    document.getElementById('tetrisPause').disabled=!running&&!paused;
    document.getElementById('tetrisPause').textContent=paused?'CONTINUAR':'PAUSAR';
  }
  function drawBlock(context,x,y,size,color) {
    context.fillStyle=color;context.fillRect(x+1,y+1,size-2,size-2);
    context.fillStyle='#ffffff38';context.fillRect(x+2,y+2,size-4,Math.max(2,size*.09));
    context.fillStyle='#06101c40';context.fillRect(x+2,y+size-4,size-4,2);
  }
  function drawBoard() {
    boardContext.fillStyle='#101a28';boardContext.fillRect(0,0,boardCanvas.width,boardCanvas.height);
    boardContext.strokeStyle='#ffffff12';boardContext.lineWidth=1;
    for(let x=0;x<=WIDTH;x++){boardContext.beginPath();boardContext.moveTo(x*CELL+.5,0);boardContext.lineTo(x*CELL+.5,HEIGHT*CELL);boardContext.stroke();}
    for(let y=0;y<=HEIGHT;y++){boardContext.beginPath();boardContext.moveTo(0,y*CELL+.5);boardContext.lineTo(WIDTH*CELL,y*CELL+.5);boardContext.stroke();}
    for(let y=0;y<HEIGHT;y++)for(let x=0;x<WIDTH;x++)if(board[y][x])drawBlock(boardContext,x*CELL,y*CELL,CELL,COLORS[board[y][x]]);
    if(current)current.matrix.forEach((row,y)=>row.forEach((cell,x)=>{if(cell&&current.y+y>=0)drawBlock(boardContext,(current.x+x)*CELL,(current.y+y)*CELL,CELL,COLORS[current.type]);}));
    if(paused||gameOver){boardContext.fillStyle='#07101dcc';boardContext.fillRect(0,0,boardCanvas.width,boardCanvas.height);boardContext.fillStyle='#fff';boardContext.textAlign='center';boardContext.font='bold 20px system-ui,sans-serif';boardContext.fillText(gameOver?'FIN DEL JUEGO':'PAUSA',boardCanvas.width/2,boardCanvas.height/2);}
  }
  function drawNext() {
    nextContext.clearRect(0,0,nextCanvas.width,nextCanvas.height);nextContext.fillStyle='#f4f7fa';nextContext.fillRect(0,0,nextCanvas.width,nextCanvas.height);
    if(!queue.length)return;
    const type=queue[0],shape=SHAPES[type],cell=20,offsetX=(nextCanvas.width-shape[0].length*cell)/2,offsetY=(nextCanvas.height-shape.length*cell)/2;
    shape.forEach((row,y)=>row.forEach((on,x)=>{if(on)drawBlock(nextContext,offsetX+x*cell,offsetY+y*cell,cell,COLORS[type]);}));
  }
  function draw() { drawBoard();drawNext();updateStats(); }
  function collides(matrix,x0,y0) {
    for(let y=0;y<matrix.length;y++)for(let x=0;x<matrix[y].length;x++)if(matrix[y][x]){
      const bx=x0+x,by=y0+y;
      if(bx<0||bx>=WIDTH||by>=HEIGHT||(by>=0&&board[by][bx]))return true;
    }
    return false;
  }
  function spawn() {
    fillQueue();const type=queue.shift();fillQueue();const matrix=SHAPES[type].map(row=>row.slice());
    current={type,matrix,x:Math.floor((WIDTH-matrix[0].length)/2),y:0};drawNext();
    if(collides(current.matrix,current.x,current.y))finishGame();
  }
  function scheduleDrop() {
    clearTimeout(timer);if(!running)return;
    timer=setTimeout(()=>{stepDown(false);scheduleDrop();},Math.max(90,850-(level-1)*65));
  }
  function start() {
    if(!active)return;
    if(gameOver||!board.length)resetState();
    if(!current)spawn();
    gameOver=false;paused=false;running=true;document.getElementById('tetrisStatus').textContent='¡Suerte! Usa las flechas o los controles táctiles.';draw();scheduleDrop();
  }
  function resetState() {
    clearTimeout(timer);board=emptyBoard();current=null;bag=[];queue=[];score=0;lines=0;level=1;running=false;paused=false;gameOver=false;fillQueue();
  }
  function finishGame() {
    clearTimeout(timer);timer=0;running=false;paused=false;gameOver=true;
    document.getElementById('tetrisStatus').textContent='FIN DEL JUEGO · Pulsa REINICIAR para volver a jugar.';draw();
  }
  function lockPiece() {
    if(!current)return;
    current.matrix.forEach((row,y)=>row.forEach((cell,x)=>{if(cell){const by=current.y+y,bx=current.x+x;if(by<0){finishGame();return;}board[by][bx]=current.type;}}));
    if(gameOver)return;
    let cleared=0;board=board.filter(row=>{if(row.every(Boolean)){cleared++;return false;}return true;});
    while(board.length<HEIGHT)board.unshift(Array(WIDTH).fill(''));
    if(cleared){const points=[0,100,300,500,800][cleared]||800;score+=points*level;lines+=cleared;level=Math.floor(lines/10)+1;}
    spawn();if(!gameOver)draw();
  }
  function stepDown(soft) {
    if(!running||!current)return false;
    if(!collides(current.matrix,current.x,current.y+1)){current.y++;if(soft)score++;draw();return true;}
    lockPiece();return false;
  }
  function move(dx) { if(!running||!current)return;if(!collides(current.matrix,current.x+dx,current.y)){current.x+=dx;draw();} }
  function rotate() {
    if(!running||!current||current.type==='O')return;
    const matrix=current.matrix[0].map((_,x)=>current.matrix.map(row=>row[x]).reverse());
    for(const kick of [0,-1,1,-2,2])if(!collides(matrix,current.x+kick,current.y)){current.matrix=matrix;current.x+=kick;draw();return;}
  }
  function hardDrop() {
    if(!running||!current)return;let distance=0;
    while(!collides(current.matrix,current.x,current.y+1)){current.y++;distance++;}
    score+=distance*2;lockPiece();
  }
  function togglePause() {
    if(gameOver)return;
    if(running){running=false;paused=true;clearTimeout(timer);timer=0;document.getElementById('tetrisStatus').textContent='Juego pausado.';draw();}
    else if(paused){paused=false;running=true;document.getElementById('tetrisStatus').textContent='Partida en curso.';draw();scheduleDrop();}
  }
  function gameAction(action) {
    if(action==='left')move(-1);else if(action==='right')move(1);else if(action==='down')stepDown(true);else if(action==='rotate')rotate();else if(action==='drop')hardDrop();else if(action==='pause')togglePause();
  }
  function onKeyDown(event) {
    if(!active)return;
    const target=event.target;
    if(target instanceof HTMLElement&&(/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)||target.isContentEditable))return;
    const actions={ArrowLeft:'left',ArrowRight:'right',ArrowDown:'down',ArrowUp:'rotate',Space:'drop',KeyP:'pause'};
    if(event.key==='Escape'){event.preventDefault();exit();return;}
    const action=actions[event.code];if(!action)return;
    event.preventDefault();if(action==='pause'&&event.repeat)return;if(['rotate','drop'].includes(action)&&event.repeat)return;gameAction(action);
  }
  function onVisibilityChange() {
    if(document.hidden&&running){running=false;paused=true;clearTimeout(timer);timer=0;document.getElementById('tetrisStatus').textContent='Partida pausada al ocultar la aplicación.';draw();}
  }
  function stopPointerControl() {
    clearInterval(repeatTimer);repeatTimer=0;
    if(pointerControl){pointerControl.classList.remove('active');pointerControl=null;}
  }
  document.querySelectorAll('[data-game-control]').forEach(button=>{
    const action=button.dataset.gameControl;
    if(['left','right','down'].includes(action)){
      button.addEventListener('pointerdown',event=>{event.preventDefault();stopPointerControl();pointerControl=button;button.classList.add('active');button.setPointerCapture?.(event.pointerId);gameAction(action);repeatTimer=setInterval(()=>gameAction(action),action==='down'?80:105);});
      button.addEventListener('pointerup',stopPointerControl);button.addEventListener('pointercancel',stopPointerControl);button.addEventListener('lostpointercapture',stopPointerControl);
    }else button.addEventListener('click',()=>gameAction(action));
  });
  window.addEventListener('pointerup',stopPointerControl);window.addEventListener('blur',stopPointerControl);
  document.getElementById('tetrisStart').addEventListener('click',start);
  document.getElementById('tetrisPause').addEventListener('click',togglePause);
  document.getElementById('tetrisRestart').addEventListener('click',()=>{if(!active)return;resetState();document.getElementById('tetrisStatus').textContent='Partida nueva.';draw();start();});

  function enter(onExit) {
    leave();active=true;exitCallback=typeof onExit==='function'?onExit:null;resetState();fillQueue();
    window.addEventListener('keydown',onKeyDown);document.addEventListener('visibilitychange',onVisibilityChange);
    document.getElementById('tetrisStatus').textContent='Pulsa INICIAR para jugar.';draw();
  }
  function leave() {
    clearTimeout(timer);clearInterval(repeatTimer);timer=repeatTimer=0;stopPointerControl();
    if(active){window.removeEventListener('keydown',onKeyDown);document.removeEventListener('visibilitychange',onVisibilityChange);}
    active=false;running=false;paused=false;current=null;board=[];bag=[];queue=[];exitCallback=null;
    if(boardContext)boardContext.clearRect(0,0,boardCanvas.width,boardCanvas.height);if(nextContext)nextContext.clearRect(0,0,nextCanvas.width,nextCanvas.height);
    document.getElementById('tetrisPause').disabled=true;
  }
  function exit() { const callback=exitCallback;leave();if(callback)callback(); }
  window.AgendaTetris={enter,leave,exit};
})();
