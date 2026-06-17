// ==UserScript==
// @name         YouTube Playlist Video Length Sorter
// @namespace    https://github.com/f1amy/yt-playlist-length-sort
// @homepageURL  https://github.com/f1amy/yt-playlist-length-sort
// @version      1.1
// @description  Sort videos on YouTube playlist page by duration ASC or DESC
// @author       F1amy
// @downloadURL  https://raw.githubusercontent.com/f1amy/yt-playlist-length-sort/master/ytPlaylistDurationSort.user.js
// @match        https://*.youtube.com/playlist*
// @icon         https://youtube.com
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    GM_registerMenuCommand('Sort videos by length ASC', function() {
        sortVideos('asc');

        alert('Videos sorting done');
    });

    GM_registerMenuCommand('Sort videos by length ASC', function() {
        sortVideos('desc');

        alert('Videos sorting done');
    });
  
    function sortVideos(order) {
      // ===== CONFIG =====
      const ORDER     = order; // 'asc' = shortest first, 'desc' = longest first
      const SORT_ALL  = true;  // true = load every video first; false = only what's loaded
      const SETTLE_MS = 2500;  // wait after each drag for YouTube to save + re-render
      const SCROLL_MS = 700;   // wait between scroll steps while loading
      const MAX_MOVES = 5000;  // safety cap
      // ==================

      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let cancelled = false;
      window.__stopSort = () => { cancelled = true; console.log('Stopping after current move…'); };

      const SEC = 'ytd-item-section-renderer:first-of-type';        // first section = the playlist (excludes "recommended")
      const getHandles = () => [...document.querySelectorAll(`${SEC} yt-icon#reorder`)];
      const getRows    = () => [...document.querySelectorAll(`${SEC} ytd-playlist-video-renderer`)];

      const readSeconds = (row) => {
        let txt = '';
        for (const sel of ['ytd-thumbnail-overlay-time-status-renderer #text', '.badge-shape-wiz__text', 'ytd-thumbnail #text']) {
          const el = row.querySelector(sel);
          if (el && /\d+:\d{2}/.test(el.textContent)) { txt = el.textContent.trim(); break; }
        }
        if (!txt) { const m = row.textContent.match(/\b(?:\d+:)?\d{1,2}:\d{2}\b/); if (m) txt = m[0]; }
        if (!txt) return null; // Shorts / upcoming / live → no real duration
        return txt.split(':').reverse().reduce((a, p, i) => a + Number(p) * 60 ** i, 0);
      };

      // --- drag simulation (mouse + HTML5 drag events) ---
      const fire = (type, el, x, y) => el.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      const center = (el) => { const r = el.getBoundingClientRect(); return [(r.left + r.right) / 2 | 0, (r.top + r.bottom) / 2 | 0]; };
      const drag = (from, to) => {
        const [x1, y1] = center(from), [x2, y2] = center(to);
        fire('mousemove', from, x1, y1); fire('mouseenter', from, x1, y1); fire('mouseover', from, x1, y1); fire('mousedown', from, x1, y1);
        fire('dragstart', from, x1, y1); fire('drag', from, x1, y1); fire('mousemove', from, x1, y1); fire('drag', from, x2, y2); fire('mousemove', to, x2, y2);
        fire('mouseenter', to, x2, y2); fire('dragenter', to, x2, y2); fire('mouseover', to, x2, y2); fire('dragover', to, x2, y2);
        fire('drop', to, x2, y2); fire('dragend', from, x2, y2); fire('mouseup', from, x2, y2);
      };

      // 1) Load all videos
      if (SORT_ALL) {
        console.log('Loading all videos…');
        let last = -1, stable = 0;
        while (stable < 3 && !cancelled) {
          document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
          await sleep(SCROLL_MS);
          const n = getHandles().length;
          if (n === last) stable++; else { stable = 0; console.log(`  ${n} loaded…`); }
          last = n;
        }
        document.scrollingElement.scrollTop = 0;
        await sleep(SCROLL_MS);
      }

      if (!getHandles().length) {
        console.warn('No "#reorder" handles found. Make sure you are SIGNED IN and on a playlist you own (Watch Later counts). If it still fails, YouTube likely changed its markup.');
        return;
      }

      // 2) Selection sort: one move per pass, re-read each time
      const desiredRank = (rows) => rows
        .map((row, i) => ({ i, secs: readSeconds(row) }))
        .sort((a, b) => {
          const av = a.secs ?? (ORDER === 'asc' ? Infinity : -Infinity);
          const bv = b.secs ?? (ORDER === 'asc' ? Infinity : -Infinity);
          return ORDER === 'asc' ? av - bv : bv - av;
        }); // rank[slot].i = the current DOM index that belongs at `slot`

      console.log(`Sorting ${getHandles().length} videos (${ORDER}). Run __stopSort() to cancel.`);
      let moves = 0, lastSig = '', stuck = 0;

      while (moves < MAX_MOVES && !cancelled) {
        const handles = getHandles(), rows = getRows();
        const n = Math.min(handles.length, rows.length);
        if (handles.length !== rows.length)
          console.warn('Row/handle count mismatch — remove any unavailable/[Deleted] videos for a clean sort.');
        if (!n) break;

        const rank = desiredRank(rows);
        let target = -1;
        for (let s = 0; s < n; s++) if (rank[s].i !== s) { target = s; break; }
        if (target === -1) { console.log(`Done ✓ — ${moves} moves. Order saved to YouTube.`); break; }

        const src = rank[target].i;
        const sig = `${src}->${target}`;
        if (sig === lastSig && ++stuck >= 3) {
          console.warn('A move isn\'t taking effect (not converging). Stopping. Likely: tab not focused, list too long/virtualized, or markup change.');
          break;
        }
        if (sig !== lastSig) stuck = 0;
        lastSig = sig;

        drag(handles[src], handles[target]);
        moves++;
        if (moves % 10 === 0) console.log(`  ${moves} moves…`);
        await sleep(SETTLE_MS);
      }
      if (cancelled) console.log(`Stopped after ${moves} moves.`);
    }
})();
