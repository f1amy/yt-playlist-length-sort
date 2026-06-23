// ==UserScript==
// @name         YouTube Playlist Video Length Sorter
// @namespace    https://github.com/f1amy/yt-playlist-length-sort
// @homepageURL  https://github.com/f1amy/yt-playlist-length-sort
// @version      1.4.1
// @description  Sort videos on YouTube playlist page by duration ASC or DESC
// @author       F1amy
// @downloadURL  https://raw.githubusercontent.com/f1amy/yt-playlist-length-sort/main/ytPlaylistDurationSort.user.js
// @updateURL    https://raw.githubusercontent.com/f1amy/yt-playlist-length-sort/main/ytPlaylistDurationSort.user.js
// @match        https://*.youtube.com/playlist*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    // -------- non-blocking toast --------
    function toast(msg, ms = 3500) {
        let t = document.getElementById('__ytSortToast');
        if (!t) {
            t = document.createElement('div');
            t.id = '__ytSortToast';
            t.style.cssText =
                'position:fixed;z-index:99999;left:50%;bottom:24px;transform:translateX(-50%);' +
                'background:#202020;color:#fff;padding:10px 16px;border-radius:8px;' +
                'font:14px/1.4 Roboto,Arial,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.45);' +
                'max-width:80vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none;';
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        clearTimeout(t.__hide);
        t.__hide = setTimeout(() => { t.style.opacity = '0'; }, ms);
    }

    // -------- longest already-sorted subsequence --------
    // Returns a boolean[] marking the rows that are ALREADY in the wanted order
    // and therefore should NOT move (asc => longest non-decreasing by seconds,
    // desc => longest non-increasing). O(n log n) patience sorting with parent
    // links. It picks a MAXIMUM-length run, which guarantees every unmarked row
    // genuinely has to move — so the number of drags is the true minimum.
    function longestSortedKeepers(keys, order) {
        const vals = order === 'asc' ? keys : keys.map(v => -v); // reduce both cases to "non-decreasing"
        const n = vals.length;
        const keep = new Array(n).fill(false);
        if (!n) return keep;

        const tailIdx = []; // tailIdx[p] = row index of the current tail of pile p
        const tailVal = []; // its value
        const prev = new Array(n).fill(-1);

        for (let i = 0; i < n; i++) {
            const x = vals[i];
            // upper bound: first pile whose tail is STRICTLY greater than x
            let lo = 0, hi = tailVal.length;
            while (lo < hi) { const m = (lo + hi) >> 1; if (tailVal[m] > x) hi = m; else lo = m + 1; }
            prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
            tailIdx[lo] = i;
            tailVal[lo] = x;
        }

        let k = tailIdx[tailIdx.length - 1];
        while (k !== -1) { keep[k] = true; k = prev[k]; }
        return keep;
    }

    GM_registerMenuCommand('Sort videos by length ASC [temp]',  () => { sortVideosTemporary('asc'); });
    GM_registerMenuCommand('Sort videos by length DESC [temp]', () => { sortVideosTemporary('desc'); });
    GM_registerMenuCommand('Sort videos by length ASC [save]',  () => { sortVideosAndSave('asc'); });
    GM_registerMenuCommand('Sort videos by length DESC [save]', () => { sortVideosAndSave('desc'); });

    async function sortVideosTemporary(order) {
      const ORDER = order;   // 'asc' = shortest first, 'desc' = longest first

      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const getItems = () => Array.from(document.querySelectorAll('ytd-playlist-video-renderer'));

      // 1. Scroll to load ALL videos
      console.log('[yt-sort] Loading all videos... (don\'t touch the page)');
      let last = -1, stable = 0;
      while (stable < 3) {
        window.scrollTo(0, document.scrollingElement.scrollHeight);
        await sleep(900);
        const n = getItems().length;
        if (n === last) { stable++; } else { stable = 0; console.log(`[yt-sort] Loaded ${n}...`); }
        last = n;
      }
      window.scrollTo(0, 0);

      // 2. Read the duration off each video
      const parseDuration = (el) => {
        const sels = [
          'ytd-thumbnail-overlay-time-status-renderer #text',
          'ytd-thumbnail-overlay-time-status-renderer span',
          '.badge-shape-wiz__text',
          'badge-shape div',
        ];
        let text = '';
        for (const s of sels) {
          const node = el.querySelector(s);
          if (node && /\d+:\d{2}/.test(node.textContent)) { text = node.textContent.trim(); break; }
        }
        if (!text) { const m = el.textContent.match(/\b(\d+:)?\d{1,2}:\d{2}\b/); if (m) text = m[0]; }
        if (!text) return null;
        return text.split(':').map(Number).reduce((acc, p) => acc * 60 + p, 0); // -> seconds
      };

      const items = getItems();
      if (!items.length) { console.warn('[yt-sort] No videos found. Are you on the playlist page?'); return; }

      const data = items.map(el => ({ el, secs: parseDuration(el) }));
      const withDur = data.filter(d => d.secs != null);
      const noDur   = data.filter(d => d.secs == null); // shorts/live/unknown go to the end

      withDur.sort((a, b) => ORDER === 'asc' ? a.secs - b.secs : b.secs - a.secs);

      // 3. Reorder them on the page (in-place, keeps nodes attached)
      const ordered = [...withDur, ...noDur];
      const container = items[0].parentNode;
      ordered.forEach(d => container.appendChild(d.el));

      console.log(`[yt-sort] Done. Sorted ${withDur.length} videos (${ORDER}). ${noDur.length} had no duration.`);
      toast(`Sorted ${withDur.length} videos (${ORDER}). View-only — refresh the page to undo.`, 5000);
    }

    async function sortVideosAndSave(order) {
      // ===== CONFIG =====
      const ORDER       = order; // 'asc' = shortest first, 'desc' = longest first
      const SORT_ALL    = true;  // true = load every video first; false = only what's loaded
      const SETTLE_MS   = 2500;  // wait after each drag for YouTube to save + re-render
      const SCROLL_MS   = 700;   // wait between scroll steps while loading
      const MAX_MOVES   = 5000;  // safety cap
      const STALL_LIMIT = 4;     // give up on the smart pass if progress stops this many times
      const FAIL_LIMIT  = 3;     // a drag verifiably not landing this many times => fall back
      // ==================

      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let cancelled = false;

      // Resolve the REAL page window. With @grant GM_*, the script runs in a sandbox
      // where the `window` identifier is a wrapper, not a true Window — passing it as a
      // MouseEvent `view` throws, and properties set on it aren't visible to the console.
      const REAL_WIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || document.defaultView || window;
      REAL_WIN.__stopSort = () => { cancelled = true; console.log('[yt-sort] Stopping after current move…'); };

      const SEC = 'ytd-item-section-renderer:first-of-type'; // first section = the playlist (excludes "recommended")

      // Stable identity that survives YouTube re-rendering the rows after each save.
      // Duplicates (same video added twice) are harmless: identical duration, interchangeable.
      const videoId = (row) => {
        const a = row.querySelector('a#thumbnail[href*="watch"], a[href*="watch?v="], a[href*="/shorts/"]');
        if (!a) return null;
        const m = a.href.match(/[?&]v=([^&]+)/) || a.href.match(/\/shorts\/([^/?&]+)/);
        return m ? m[1] : null;
      };

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

      // Pair every row with ITS OWN handle so indexes can never cross between two lists.
      const getEntries = () =>
        [...document.querySelectorAll(`${SEC} ytd-playlist-video-renderer`)]
          .map(row => ({ row, handle: row.querySelector('yt-icon#reorder'), id: videoId(row), secs: readSeconds(row) }));

      // Sort key per row. Rows with no duration get pushed to the end in both orders.
      const keyOf = (secs) => secs == null ? (ORDER === 'asc' ? Infinity : -Infinity) : secs;

      // --- drag simulation (same event sequence YouTube's own reorder responds to) ---
      // Use a real Window for `view` if the engine accepts it; otherwise omit it
      // (the events still work — YouTube reads clientX/clientY and the target element).
      let VIEW;
      try { new MouseEvent('t', { view: REAL_WIN }); VIEW = REAL_WIN; } catch (e) { VIEW = undefined; }
      const fire = (type, el, x, y) => {
        const init = { bubbles: true, cancelable: true, clientX: x, clientY: y };
        if (VIEW) init.view = VIEW;
        el.dispatchEvent(new MouseEvent(type, init));
      };
      const cx   = (el) => { const r = el.getBoundingClientRect(); return Math.floor((r.left + r.right) / 2); };
      const cy   = (el) => { const r = el.getBoundingClientRect(); return Math.floor((r.top + r.bottom) / 2); };
      // A point near the TOP (frac 0.15) or BOTTOM (frac 0.85) of a row, so the drop lands
      // on the intended SIDE of that row regardless of which direction we're dragging from.
      const yFrac = (el, f) => { const r = el.getBoundingClientRect(); return Math.floor(r.top + (r.bottom - r.top) * f); };

      // Move the dragged handle so its video lands immediately BEFORE / AFTER `toRow`.
      // Choosing the side explicitly (rather than dropping on the row's centre) is what
      // makes a long DOWNWARD move land in one drag instead of off-by-one.
      const dragBeside = (fromHandle, toRow, where) => {
        const x1 = cx(fromHandle), y1 = cy(fromHandle);
        const x2 = cx(toRow),      y2 = yFrac(toRow, where === 'after' ? 0.85 : 0.15);
        fire('mousemove', fromHandle, x1, y1); fire('mouseenter', fromHandle, x1, y1); fire('mouseover', fromHandle, x1, y1); fire('mousedown', fromHandle, x1, y1);
        fire('dragstart', fromHandle, x1, y1); fire('drag', fromHandle, x1, y1); fire('mousemove', fromHandle, x1, y1); fire('drag', fromHandle, x2, y2); fire('mousemove', toRow, x2, y2);
        fire('mouseenter', toRow, x2, y2); fire('dragenter', toRow, x2, y2); fire('mouseover', toRow, x2, y2); fire('dragover', toRow, x2, y2);
        fire('drop', toRow, x2, y2); fire('dragend', fromHandle, x2, y2); fire('mouseup', fromHandle, x2, y2);
      };

      // Exact event sequence of the original up-only sorter (drop onto the occupant's
      // handle => the dragged video lands at that slot). Used by the safe fallback,
      // so the fallback is byte-for-byte the behaviour that already works everywhere.
      const dragOnto = (fromHandle, toHandle) => {
        const x1 = cx(fromHandle), y1 = cy(fromHandle), x2 = cx(toHandle), y2 = cy(toHandle);
        fire('mousemove', fromHandle, x1, y1); fire('mouseenter', fromHandle, x1, y1); fire('mouseover', fromHandle, x1, y1); fire('mousedown', fromHandle, x1, y1);
        fire('dragstart', fromHandle, x1, y1); fire('drag', fromHandle, x1, y1); fire('mousemove', fromHandle, x1, y1); fire('drag', fromHandle, x2, y2); fire('mousemove', toHandle, x2, y2);
        fire('mouseenter', toHandle, x2, y2); fire('dragenter', toHandle, x2, y2); fire('mouseover', toHandle, x2, y2); fire('dragover', toHandle, x2, y2);
        fire('drop', toHandle, x2, y2); fire('dragend', fromHandle, x2, y2); fire('mouseup', fromHandle, x2, y2);
      };

      // After a move, confirm the dragged video really ended up on the wanted side of its
      // neighbour. Returns true/false, or null when it can't tell (missing or duplicate
      // ids) — in which case we lean on the keeper-count progress guard instead.
      const verifyBeside = (xid, nid, where) => {
        if (!xid || !nid) return null;
        const ids = [...document.querySelectorAll(`${SEC} ytd-playlist-video-renderer`)].map(videoId);
        if (ids.filter(v => v === xid).length !== 1 || ids.filter(v => v === nid).length !== 1) return null;
        const ix = ids.indexOf(xid), inx = ids.indexOf(nid);
        return where === 'after' ? ix === inx + 1 : ix === inx - 1;
      };

      function reportNotConverging() {
        console.warn(
          '[yt-sort] A move isn\'t taking effect (order not converging). Stopping.\n' +
          'Most common causes, in order:\n' +
          '  • You\'re on Firefox — simulated drag-and-drop on YouTube only works reliably in Chrome / Edge / Brave.\n' +
          '  • The tab isn\'t focused — keep this tab in the foreground while it runs.\n' +
          '  • Very long / virtualised list, or YouTube changed its markup.'
        );
        toast('Stopped: the reorder isn\'t saving. On Firefox? Use Chrome/Edge and keep the tab focused.', 8000);
      }

      // ---- SAFE FALLBACK: the original up-only selection sort ----
      // Only ever drags a video UPWARD onto the slot it belongs in, which is the exact
      // behaviour the previous versions shipped with. Slower (can be ~N moves), but it
      // finishes the job if the one-drag relocation ever fails to register.
      async function selectionFinish() {
        console.log('[yt-sort] Finishing with the reliable step-by-step method…');
        let moves = 0, lastSig = '', stuck = 0, maxP = -1, sinceProgress = 0;

        while (moves < MAX_MOVES && !cancelled) {
          const cur = getEntries().filter(e => e.handle);
          if (!cur.length) break;

          const desired = cur
            .map((e, i) => ({ e, i, key: keyOf(e.secs) }))
            .sort((a, b) => ORDER === 'asc' ? (a.key - b.key) || (a.i - b.i)
                                            : (b.key - a.key) || (a.i - b.i));

          let p = -1;
          for (let s = 0; s < cur.length; s++) {
            if (desired[s].e.row !== cur[s].row) { p = s; break; }
          }
          if (p === -1) {
            console.log(`[yt-sort] Done ✓ — finished via fallback. New order saved to YouTube.`);
            toast(`Done — sorted ${cur.length} videos (${ORDER}) and saved ✓`, 5000);
            return;
          }

          const fromHandle = desired[p].e.handle; // belongs at p, currently sitting below p
          const toHandle   = cur[p].handle;        // whoever is at p right now

          const sig = `${desired[p].i}->${p}`;
          if (sig === lastSig) { if (++stuck >= 3) { reportNotConverging(); return; } } else { stuck = 0; }
          lastSig = sig;
          if (p > maxP) { maxP = p; sinceProgress = 0; } else if (++sinceProgress >= 8) { reportNotConverging(); return; }

          if (!fromHandle || !toHandle) { await sleep(SETTLE_MS); continue; }

          dragOnto(fromHandle, toHandle); // up-move: lands exactly at slot p
          moves++;
          if (moves % 10 === 0) console.log(`[yt-sort]   ${moves} moves (fallback)…`);
          await sleep(SETTLE_MS);
        }

        if (cancelled)               { console.log(`[yt-sort] Stopped after ${moves} move(s).`); toast(`Stopped after ${moves} move(s).`, 4000); }
        else if (moves >= MAX_MOVES) { console.warn(`[yt-sort] Hit safety cap (${MAX_MOVES} moves).`); toast('Hit the safety move cap.', 4000); }
      }

      try {
        // 1) Load all videos
        if (SORT_ALL) {
          console.log('[yt-sort] Loading all videos…');
          let last = -1, stable = 0;
          while (stable < 3 && !cancelled) {
            document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
            await sleep(SCROLL_MS);
            const n = getEntries().length;
            if (n === last) stable++; else { stable = 0; console.log(`[yt-sort]   ${n} loaded…`); }
            last = n;
          }
          document.scrollingElement.scrollTop = 0;
          await sleep(SCROLL_MS);
        }

        const entries = getEntries();
        const withHandle = entries.filter(e => e.handle);

        if (!withHandle.length) {
          console.warn('[yt-sort] No "#reorder" handles found. You must be SIGNED IN and on a playlist you can edit (your own, or Watch Later). Aborting.');
          toast('Can\'t sort: no reorder handles. Are you signed in, and is this your playlist?', 6000);
          return;
        }
        if (withHandle.length !== entries.length) {
          console.warn(`[yt-sort] ${entries.length - withHandle.length} row(s) have no drag handle (unavailable / [Deleted] / live). They can't be moved — remove them for a clean sort. Continuing with the rest.`);
        }

        // How many moves the minimal plan needs (just a friendly heads-up).
        const planKeep  = longestSortedKeepers(withHandle.map(e => keyOf(e.secs)), ORDER);
        const planMoves = withHandle.length - planKeep.filter(Boolean).length;
        console.log(`[yt-sort] Sorting ${withHandle.length} videos (${ORDER}) — about ${planMoves} drag move(s), the minimum. Run __stopSort() in the console to cancel.`);

        // 2) MINIMAL-MOVE sort.
        // Each pass: recompute the longest already-sorted run (its videos stay put) and
        // move ONE of the remaining videos straight to its final spot — dropped just
        // before the first kept video that must follow it, or just after the last kept
        // video when nothing must follow. Because that move always slots the video into
        // the kept run, the run grows by exactly 1 each time, so the whole list is sorted
        // in (N - initialKept) drags — the provable minimum. A video that's too early
        // (e.g. a long upload sitting at the top of an ASC sort) is sent straight to the
        // end in a single downward drag instead of crawling down one place at a time.
        let moves = 0, bestKept = -1, stall = 0, failStreak = 0;

        while (moves < MAX_MOVES && !cancelled) {
          // Re-read every pass: YouTube rebuilds the rows after each saved move.
          const cur  = getEntries().filter(e => e.handle);
          if (!cur.length) break;
          const key  = cur.map(e => keyOf(e.secs));
          const keep = longestSortedKeepers(key, ORDER);
          const kept = keep.reduce((a, b) => a + (b ? 1 : 0), 0);

          if (kept === cur.length) {
            console.log(`[yt-sort] Done ✓ — ${moves} move(s). New order saved to YouTube.`);
            toast(`Done — sorted ${cur.length} videos (${ORDER}) and saved ✓`, 5000);
            return;
          }

          // Progress guard: an effective move grows the kept run by 1. If it stops
          // growing, the drags aren't landing — hand off to the reliable fallback.
          if (kept > bestKept) { bestKept = kept; stall = 0; }
          else if (++stall >= STALL_LIMIT) { await selectionFinish(); return; }

          // First video that isn't part of the kept run — the one we'll relocate.
          let mi = -1;
          for (let i = 0; i < cur.length; i++) { if (!keep[i]) { mi = i; break; } }
          const X = cur[mi], kx = key[mi];

          // The kept video it should sit in front of (first kept one that must come after it).
          let neighbor = null, where = 'before';
          for (let u = 0; u < cur.length; u++) {
            if (!keep[u]) continue;
            if (ORDER === 'asc' ? key[u] > kx : key[u] < kx) { neighbor = cur[u]; where = 'before'; break; }
          }
          // None must come after it → it belongs at the very end: drop after the last kept video.
          if (!neighbor) {
            let li = -1;
            for (let u = 0; u < cur.length; u++) if (keep[u]) li = u;
            neighbor = cur[li]; where = 'after';
          }

          dragBeside(X.handle, neighbor.row, where); // lands X immediately before/after its neighbour
          moves++;
          if (moves % 10 === 0) console.log(`[yt-sort]   ${moves} moves…`);
          await sleep(SETTLE_MS);

          // Did it actually land where we wanted?
          const verdict = verifyBeside(X.id, neighbor.id, where);
          if (verdict === false) {
            if (++failStreak >= FAIL_LIMIT) {
              console.warn('[yt-sort] One-drag relocation isn\'t landing — switching to the reliable step-by-step method.');
              toast('Switching to the reliable (slower) method to finish…', 5000);
              await selectionFinish();
              return;
            }
          } else if (verdict === true) {
            failStreak = 0;
          } // null => can't tell; the kept-count guard above covers us.
        }

        if (cancelled)               { console.log(`[yt-sort] Stopped after ${moves} move(s).`); toast(`Stopped after ${moves} move(s).`, 4000); }
        else if (moves >= MAX_MOVES) { console.warn(`[yt-sort] Hit safety cap (${MAX_MOVES} moves).`); toast('Hit the safety move cap.', 4000); }

      } catch (err) {
        console.error('[yt-sort] Crashed:', err);
        toast('Sort crashed — open the console (F12) for details.', 6000);
      }
    }
})();
