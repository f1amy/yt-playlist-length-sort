// ==UserScript==
// @name         YouTube Playlist Video Length Sorter
// @namespace    https://github.com/f1amy/yt-playlist-length-sort
// @homepageURL  https://github.com/f1amy/yt-playlist-length-sort
// @version      1.3.0
// @description  Sort videos on YouTube playlist page by duration ASC or DESC
// @author       F1amy
// @downloadURL  https://raw.githubusercontent.com/f1amy/yt-playlist-length-sort/main/ytPlaylistDurationSort.user.js
// @match        https://*.youtube.com/playlist*
// @icon         https://youtube.com
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    // -------- non-blocking toast (replaces alert) --------
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

    // -------- fix black thumbnails by re-pointing <img> at the real image --------
    function reloadThumbnails(rows) {
        for (const el of rows) {
            const a = el.querySelector('a#thumbnail') || el.querySelector('a#video-title');
            if (!a || !a.href) continue;

            let id = null;
            try { id = new URL(a.href, location.href).searchParams.get('v'); } catch (e) { /* ignore */ }
            if (!id) { const m = a.href.match(/[?&]v=([\w-]{11})/); if (m) id = m[1]; }
            if (!id) continue;

            const img = el.querySelector('ytd-thumbnail img, yt-image img, yt-img-shadow img, img#img, img.yt-core-image');
            if (!img) continue;

            const cur = img.getAttribute('src') || '';
            // only touch images that are blank / placeholder / pointing at the wrong video
            if (!cur || cur.startsWith('data:') || !cur.includes(id)) {
                if (img.hasAttribute('srcset')) img.removeAttribute('srcset');
                img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
            }
        }
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

      // 4. Repaint thumbnails that YouTube unloaded during the scroll
      reloadThumbnails(ordered.map(d => d.el));

      console.log(`[yt-sort] Done. Sorted ${withDur.length} videos (${ORDER}). ${noDur.length} had no duration.`);
      toast(`Sorted ${withDur.length} videos (${ORDER}). View-only — refresh the page to undo.`, 5000);
    }

    async function sortVideosAndSave(order) {
      // ===== CONFIG =====
      const ORDER     = order; // 'asc' = shortest first, 'desc' = longest first
      const SORT_ALL  = true;  // true = load every video first; false = only what's loaded
      const SETTLE_MS = 2500;  // wait after each drag for YouTube to save + re-render
      const SCROLL_MS = 700;   // wait between scroll steps while loading
      const MAX_MOVES = 5000;  // safety cap
      // ==================

      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let cancelled = false;
      window.__stopSort = () => { cancelled = true; console.log('[yt-sort] Stopping after current move…'); };

      const SEC = 'ytd-item-section-renderer:first-of-type'; // first section = the playlist (excludes "recommended")

      // Pair every row with ITS OWN handle so indexes can never cross between two lists.
      const getEntries = () =>
        [...document.querySelectorAll(`${SEC} ytd-playlist-video-renderer`)]
          .map(row => ({ row, handle: row.querySelector('yt-icon#reorder') }));

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

      // --- drag simulation (same event sequence YouTube's own reorder responds to) ---
      const fire = (type, el, x, y) => el.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      const center = (el) => { const r = el.getBoundingClientRect(); return [Math.floor((r.left + r.right) / 2), Math.floor((r.top + r.bottom) / 2)]; };
      const drag = (from, to) => {
        const [x1, y1] = center(from), [x2, y2] = center(to);
        fire('mousemove', from, x1, y1); fire('mouseenter', from, x1, y1); fire('mouseover', from, x1, y1); fire('mousedown', from, x1, y1);
        fire('dragstart', from, x1, y1); fire('drag', from, x1, y1); fire('mousemove', from, x1, y1); fire('drag', from, x2, y2); fire('mousemove', to, x2, y2);
        fire('mouseenter', to, x2, y2); fire('dragenter', to, x2, y2); fire('mouseover', to, x2, y2); fire('dragover', to, x2, y2);
        fire('drop', to, x2, y2); fire('dragend', from, x2, y2); fire('mouseup', from, x2, y2);
      };

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

        console.log(`[yt-sort] Sorting ${withHandle.length} videos (${ORDER}). Run __stopSort() in the console to cancel.`);

        let moves = 0, lastSig = '', stuck = 0, maxP = -1, sinceProgress = 0;

        while (moves < MAX_MOVES && !cancelled) {
          // Re-read every pass: YouTube rebuilds the rows after each saved move.
          const cur = getEntries().filter(e => e.handle);
          if (!cur.length) break;

          const desired = cur
            .map((e, i) => ({ e, i, secs: readSeconds(e.row) }))
            .sort((a, b) => {
              const av = a.secs ?? (ORDER === 'asc' ? Infinity : -Infinity);
              const bv = b.secs ?? (ORDER === 'asc' ? Infinity : -Infinity);
              return ORDER === 'asc' ? av - bv : bv - av;
            });

          // First slot whose current occupant isn't the video that belongs there.
          let p = -1;
          for (let s = 0; s < cur.length; s++) {
            if (desired[s].e.row !== cur[s].row) { p = s; break; }
          }
          if (p === -1) {
            console.log(`[yt-sort] Done ✓ — ${moves} move(s). New order saved to YouTube.`);
            toast(`Done — sorted ${cur.length} videos (${ORDER}) and saved ✓`, 5000);
            return;
          }

          const fromEl  = desired[p].e.handle; // the video that belongs at slot p
          const toEl    = cur[p].handle;       // the video currently sitting at slot p
          const fromIdx = desired[p].i;        // its current index (for logging / stuck detection)

          // --- convergence guards ---
          // (a) exact same move repeating = the drag is doing nothing
          const sig = `${fromIdx}->${p}`;
          if (sig === lastSig) {
            if (++stuck >= 3) { reportNotConverging(); return; }
          } else { stuck = 0; }
          lastSig = sig;

          // (b) the sorted prefix isn't growing = churning without real progress
          if (p > maxP) { maxP = p; sinceProgress = 0; } else if (++sinceProgress >= 8) { reportNotConverging(); return; }

          if (!fromEl || !toEl) { // safety — shouldn't happen after the handle filter
            console.warn('[yt-sort] Missing handle for a move, skipping pass.');
            await sleep(SETTLE_MS);
            continue;
          }

          drag(fromEl, toEl);
          moves++;
          if (moves % 10 === 0) console.log(`[yt-sort]   ${moves} moves…`);
          await sleep(SETTLE_MS);
        }

        if (cancelled)              { console.log(`[yt-sort] Stopped after ${moves} move(s).`); toast(`Stopped after ${moves} move(s).`, 4000); }
        else if (moves >= MAX_MOVES){ console.warn(`[yt-sort] Hit safety cap (${MAX_MOVES} moves).`); toast('Hit the safety move cap.', 4000); }

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

      } catch (err) {
        console.error('[yt-sort] Crashed:', err);
        toast('Sort crashed — open the console (F12) for details.', 6000);
      }
    }
})();
