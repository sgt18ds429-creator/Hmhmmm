// game-worker.js — يشغّل السباق في عامل خلفي على OffscreenCanvas: انشغال الصفحة بالتحويل لا يقطّع اللعبة.
import { createRace } from './game-core.js';

let race = null;
self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    race = createRace(m.canvas, { emit: (x) => self.postMessage(x), best: m.best || 0, reduced: !!m.reduced });
    race.resize(m.w, m.h, m.dpr);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (!race) return;
  if (m.type === 'resize') race.resize(m.w, m.h, m.dpr);
  else if (m.type === 'move') race.move(m.dir);
  else if (m.type === 'tap') race.tap();
  else if (m.type === 'pause') race.pause(m.paused);
  else if (m.type === 'progress') race.progress(m.pct);
  else if (m.type === 'finish') race.finish();
  else if (m.type === 'stats') self.postMessage({ type: 'stats', stats: race.stats() });
  else if (m.type === 'stop') { race.stop(); self.close(); }
};
