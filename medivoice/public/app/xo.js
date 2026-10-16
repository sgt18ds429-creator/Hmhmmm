// xo.js — «إكس أو» ضد الكمبيوتر، تُلعب أثناء انتظار الملزمة (مثل السباق: نافذة سفلية بتقدّم التحويل،
// وتنغلق وحدها عندما تجهز الملزمة). ثلاث مستويات: سهل، متوسط، صعب (لا يُغلب).
// الرسم عناصر صفحة عادية: العلامات تُرسم بخط يتحرك (SVG)، وكل الحركات شفافية وتحريك فقط.

import { h, sheet, clear } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const STORE = 'mv-xo';
const load = () => { try { return { level: 'mid', you: 0, cpu: 0, draw: 0, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { return { level: 'mid', you: 0, cpu: 0, draw: 0 }; } };
const save = (v) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* تخزين غير متاح */ } };

function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

/** الفائز والخط الفائز، أو تعادل، أو لا شيء بعد */
export function judge(b) {
  for (const line of LINES) {
    const [a, c, d] = line;
    if (b[a] && b[a] === b[c] && b[a] === b[d]) return { win: b[a], line };
  }
  return b.every(Boolean) ? { draw: true } : null;
}

/** أفضل حركة (minimax كامل: 3×3 صغيرة) — يفضّل الفوز الأسرع والخسارة الأبطأ */
function best(b, me) {
  const them = me === 'X' ? 'O' : 'X';
  let top = -Infinity, moves = [];
  const score = (board, turn, depth) => {
    const j = judge(board);
    if (j?.win) return j.win === me ? 10 - depth : depth - 10;
    if (j?.draw) return 0;
    let bestScore = turn === me ? -Infinity : Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i]) continue;
      board[i] = turn;
      const v = score(board, turn === me ? them : me, depth + 1);
      board[i] = null;
      bestScore = turn === me ? Math.max(bestScore, v) : Math.min(bestScore, v);
    }
    return bestScore;
  };
  for (let i = 0; i < 9; i++) {
    if (b[i]) continue;
    b[i] = me;
    const v = score(b, them, 1);
    b[i] = null;
    if (v > top) { top = v; moves = [i]; } else if (v === top) moves.push(i);
  }
  return moves[Math.floor(Math.random() * moves.length)];
}

/** حركة الكمبيوتر حسب المستوى */
export function cpuMove(b, level, me = 'O') {
  const free = b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (!free.length) return -1;
  const random = () => free[Math.floor(Math.random() * free.length)];
  const them = me === 'X' ? 'O' : 'X';
  const finish = (who) => { for (const i of free) { b[i] = who; const w = judge(b)?.win; b[i] = null; if (w) return i; } return -1; };
  if (level === 'easy') {
    // يفوز إذا شاف الفرصة، ويسد عليك أحياناً فقط
    const win = finish(me);
    if (win >= 0) return win;
    const block = finish(them);
    if (block >= 0 && Math.random() < 0.45) return block;
    return random();
  }
  if (level === 'mid' && Math.random() < 0.28) {
    const win = finish(me);
    if (win >= 0) return win;
    const block = finish(them);
    return block >= 0 ? block : random();
  }
  return best(b, me);
}

function mark(kind) {
  const el = svg('svg', { viewBox: '0 0 100 100', class: `xo-mark ${kind === 'X' ? 'x' : 'o'}`, 'aria-hidden': 'true' });
  if (kind === 'X') el.append(svg('path', { d: 'M27 27 73 73' }), svg('path', { d: 'M73 27 27 73' }));
  else el.append(svg('circle', { cx: 50, cy: 50, r: 25 }));
  return el;
}

/**
 * @returns { update(pct, text), done(), close(), stats() } — نفس واجهة سباق السيارات
 */
export function openXO({ onClose } = {}) {
  const data = load();
  const fill = h('i');
  const pctEl = h('b', { class: 'num' }, '0%');
  const textEl = h('small');
  const bar = h('div', { class: 'game-progress', role: 'status' }, fill, pctEl, textEl);

  const youEl = h('b', { class: 'num' }, String(data.you));
  const drawEl = h('b', { class: 'num' }, String(data.draw));
  const cpuEl = h('b', { class: 'num' }, String(data.cpu));
  const scores = h('div', { class: 'xo-scores' },
    h('div', { class: 'xo-score you' }, mark('X'), h('span', null, 'أنت'), youEl),
    h('div', { class: 'xo-score tie' }, h('span', null, 'تعادل'), drawEl),
    h('div', { class: 'xo-score cpu' }, mark('O'), h('span', null, 'الكمبيوتر'), cpuEl));

  const levelSeg = h('div', { class: 'seg xo-level', role: 'group', 'aria-label': 'المستوى' });
  const paintLevel = () => clear(levelSeg).append(...[['easy', 'سهل'], ['mid', 'متوسط'], ['hard', 'صعب']].map(([v, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(data.level === v), onclick: () => { if (data.level === v) return; data.level = v; save(data); paintLevel(); newRound(true); } }, label)));
  paintLevel();

  const turnEl = h('p', { class: 'xo-turn', 'aria-live': 'polite' });
  const cells = [...Array(9)].map((_, i) => h('button', { type: 'button', class: 'xo-cell', 'aria-label': `الخانة ${i + 1}`, onclick: () => play(i) }));
  const lineSvg = svg('svg', { class: 'xo-line', viewBox: '0 0 300 300', 'aria-hidden': 'true' });
  const board = h('div', { class: 'xo-board', dir: 'ltr' }, ...cells, lineSvg);
  const result = h('div', { class: 'xo-result', hidden: true });
  const stage = h('div', { class: 'xo-stage' }, board, result);
  const s = sheet({ title: 'إكس أو', body: h('div', { class: 'game xo' }, bar, scores, levelSeg, turnEl, stage), onClose: () => { closed = true; clearTimeout(cpuTimer); onClose?.(); } });
  s.panel.classList.add('game-panel');

  let b = Array(9).fill(null), over = false, busy = false, closed = false, finished = false, cpuTimer = 0, starter = 'X';

  function setTurn(text, thinking = false) {
    clear(turnEl).append(text);
    turnEl.classList.toggle('thinking', thinking);
    if (thinking) turnEl.append(h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  }
  function put(i, who) {
    b[i] = who;
    cells[i].append(mark(who));
    cells[i].classList.add('taken');
    cells[i].setAttribute('aria-label', `الخانة ${i + 1}: ${who === 'X' ? 'إكس' : 'أو'}`);
  }
  function drawWinLine(line) {
    const at = (i) => [50 + (i % 3) * 100, 50 + Math.floor(i / 3) * 100];
    const [x1, y1] = at(line[0]), [x2, y2] = at(line[2]);
    const ex = (x2 - x1) * 0.18, ey = (y2 - y1) * 0.18;
    clear(lineSvg);
    for (const cls of ['glow', 'core']) lineSvg.append(svg('line', { class: cls, x1: x1 - ex, y1: y1 - ey, x2: x2 + ex, y2: y2 + ey }));
    for (const i of line) cells[i].classList.add('win');
  }
  function confetti() {
    if (document.documentElement.dataset.motion === 'off') return;
    const colors = ['#ff6bd6', '#8f7bff', '#6fe3b4', '#ffd166', '#7cc8ff'];
    for (let i = 0; i < 26; i++) {
      const p = h('i', { class: 'xo-confetti' });
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.4;
      const d = 90 + Math.random() * 110;
      p.style.setProperty('--dx', `${Math.cos(a) * d}px`);
      p.style.setProperty('--dy', `${Math.sin(a) * d - 40}px`);
      p.style.setProperty('--r', `${Math.round(Math.random() * 540 - 270)}deg`);
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = `${Math.random() * 0.08}s`;
      stage.append(p);
      setTimeout(() => p.remove(), 1300);
    }
  }
  function end(j) {
    over = true;
    let title, cls;
    if (j.win) {
      drawWinLine(j.line);
      if (j.win === 'X') { data.you++; title = 'فزت!'; cls = 'won'; confetti(); try { navigator.vibrate?.([30, 40, 30]); } catch { /* */ } }
      else { data.cpu++; title = 'فاز الكمبيوتر'; cls = 'lost'; }
    } else { data.draw++; title = 'تعادل'; cls = 'tie'; }
    save(data);
    youEl.textContent = String(data.you); cpuEl.textContent = String(data.cpu); drawEl.textContent = String(data.draw);
    for (const el of [j.win === 'X' ? youEl : j.win === 'O' ? cpuEl : drawEl]) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    setTurn(j.win === 'X' ? 'أحسنت!' : j.win === 'O' ? 'حظ أوفر المرة الجاية' : 'ولا أحد فاز');
    setTimeout(() => {
      if (closed || finished) return;
      clear(result).append(h('h3', null, title), h('button', { class: 'btn small', type: 'button', onclick: () => newRound() }, 'جولة جديدة'));
      result.className = `xo-result ${cls}`;
      result.hidden = false;
    }, j.win ? 900 : 500);
  }
  function cpuTurn() {
    busy = true;
    setTurn('الكمبيوتر يفكر', true);
    cpuTimer = setTimeout(() => {
      if (closed || over) return;
      const i = cpuMove(b, data.level, 'O');
      if (i >= 0) put(i, 'O');
      busy = false;
      const j = judge(b);
      if (j) end(j); else setTurn('دورك');
    }, 420 + Math.random() * 380);
  }
  function play(i) {
    if (over || busy || finished || b[i]) return;
    put(i, 'X');
    const j = judge(b);
    if (j) { end(j); return; }
    cpuTurn();
  }
  function newRound(resetStarter = false) {
    clearTimeout(cpuTimer);
    b = Array(9).fill(null); over = false; busy = false;
    for (const [i, c] of cells.entries()) { clear(c); c.className = 'xo-cell'; c.setAttribute('aria-label', `الخانة ${i + 1}`); }
    clear(lineSvg);
    result.hidden = true;
    // من يبدأ يتبادل كل جولة
    starter = resetStarter ? 'X' : starter === 'X' ? 'O' : 'X';
    board.classList.remove('fresh'); void board.offsetWidth; board.classList.add('fresh');
    if (starter === 'O') cpuTurn(); else setTurn('دورك، ابدأ');
  }
  starter = 'O'; // أول جولة: أنت تبدأ
  newRound();

  return {
    update(pct, text) {
      const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
      fill.style.width = `${v}%`;
      pctEl.textContent = `${v}%`;
      textEl.textContent = text || '';
    },
    done() {
      this.update(100, 'الملزمة جاهزة');
      finished = true;
      clearTimeout(cpuTimer);
      clear(result).append(h('h3', null, 'الملزمة جاهزة!'), h('p', null, 'أفتحها لك الآن…'));
      result.className = 'xo-result ready';
      result.hidden = false;
    },
    close() { s.close(); },
    stats() { return Promise.resolve({ engine: 'xo' }); },
  };
}
