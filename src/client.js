// Client half of chat-pace: configurable control over how the conversation
// scrollport follows (or refuses to follow) new agent output.
//
// Modes
//   follow — shipped behavior: snap to the newest output instantly.
//   smooth — keep the newest output in view, gliding at a chosen px/s speed.
//   paced  — read section by section: glide to each settled output section,
//            pause for a time proportional to the section's size (a chosen
//            seconds-per-viewport reading pace), then move to the next.
//   step   — no automatic movement; one section per button press / hotkey.
//   hold   — pin the view; new output never moves it.
//
// Surfaces
//   conversation.input.left            compact controls (pause, next, mode)
//   conversation.composer.dock         ambient status readout + pause progress
//   conversation.session.header.actions  mode menu button
//   settings.section                   full "Chat Pace" settings page
//   global hotkeys                     toggle / next / prev / latest / cycle
//
// How it coexists with the shipped follow logic (ui-conversation ChatView):
// the shipped code snaps scrollTop to the bottom on content growth while the
// reader is at the bottom, and disengages once a scroll event shows the
// reader moved away. This engine recognizes those snaps (big floor-adjacent
// jumps that arrive with scrollHeight growth and no recent user input) and
// restores the reader's anchor position; the restore itself reads as a
// reader scroll to the shipped handler, which then disengages on its own.
// Smooth/paced movement is written frame-by-frame as engine-authored
// scrollTop values, which the shipped handler treats as ordinary reader
// scrolling, so the two never fight for the same frame.
;
(function () {
  window.__ModuleLoader__.load({
    id: 'chat-pace',
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
      var React = require('react')
      var createElement = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useRef = React.useRef
      var useMemo = React.useMemo

      // ------------------------------------------------------------------
      // Settings store (localStorage-backed, module-local)
      // ------------------------------------------------------------------

      var SETTINGS_KEY = 'dsh-chat-pace-settings-v1'

      var MODE_IDS = ['follow', 'smooth', 'paced', 'step', 'hold']
      var MODES = [
        { id: 'follow', name: 'Follow', icon: '\u2b07', hint: 'Default behavior: jump to the newest output the moment it arrives.' },
        { id: 'smooth', name: 'Smooth', icon: '\u2248', hint: 'Keep the newest output in view, gliding continuously at your scroll speed.' },
        { id: 'paced', name: 'Paced', icon: '\u23f1', hint: 'Pause at each finished text section for a time proportional to its size, then continue automatically. Between text sections the view keeps following tool output live.' },
        { id: 'step', name: 'Step', icon: '\u23ed', hint: 'No automatic scrolling. Move exactly one output section per press (button or hotkey).' },
        { id: 'hold', name: 'Hold', icon: '\ud83d\udccc', hint: 'Pin the view where you put it. New output never moves it.' }
      ]
      var KEY_ACTIONS = [
        { id: 'toggle', label: 'Pause / resume auto-scroll' },
        { id: 'next', label: 'Next output section' },
        { id: 'prev', label: 'Previous output section' },
        { id: 'latest', label: 'Jump to latest output' },
        { id: 'cycle', label: 'Cycle scroll mode' }
      ]
      var OPEN_POS = [
        { id: 'top', label: 'Top', hint: 'Open conversations at the very top (shipped default).' },
        { id: 'bottom', label: 'Bottom', hint: 'Open conversations at the newest output.' },
        { id: 'resume', label: 'Where I left it', hint: 'Open each conversation at the position you last left it.' }
      ]
      var OPEN_POS_IDS = ['top', 'bottom', 'resume']

      function clampNum(v, lo, hi, fallback) {
        v = Number(v)
        if (!isFinite(v)) return fallback
        if (v < lo) return lo
        if (v > hi) return hi
        return v
      }

      function normCombo(raw) {
        if (typeof raw !== 'string') return ''
        return raw.toLowerCase().split('+').map(function (p) { return p.trim() }).filter(function (p) { return p.length > 0 }).join('+')
      }

      function defaultSettings() {
        return {
          mode: 'follow',
          speedPxs: 140,
          secsPerViewport: 4,
          minPauseMs: 400,
          maxPauseMs: 20000,
          includeTools: false,
          includeCommands: false,
          jumpOnSend: true,
          releaseOnUserScroll: true,
          resumeAtBottom: false,
          stepSmooth: true,
          openPosition: 'top',
          keys: { toggle: 'f9', next: 'ctrl+arrowdown', prev: 'ctrl+arrowup', latest: 'ctrl+end', cycle: '' }
        }
      }

      function mergeSettings(patch) {
        var base = defaultSettings()
        var out = {}
        for (var k in base) out[k] = base[k]
        if (patch && typeof patch === 'object') {
          for (var k2 in patch) {
            if (!(k2 in base)) continue
            out[k2] = patch[k2]
          }
        }
        out.mode = MODE_IDS.indexOf(out.mode) >= 0 ? out.mode : 'follow'
        out.openPosition = OPEN_POS_IDS.indexOf(out.openPosition) >= 0 ? out.openPosition : 'top'
        out.speedPxs = clampNum(out.speedPxs, 20, 1200, 140)
        out.secsPerViewport = clampNum(out.secsPerViewport, 0.5, 120, 4)
        out.minPauseMs = clampNum(out.minPauseMs, 0, 10000, 400)
        out.maxPauseMs = clampNum(out.maxPauseMs, 100, 120000, 20000)
        if (out.maxPauseMs < out.minPauseMs) out.maxPauseMs = out.minPauseMs
        out.keys = (patch && typeof patch.keys === 'object') ? patch.keys : out.keys
        var keys = {}
        for (var i = 0; i < KEY_ACTIONS.length; i++) {
          var id = KEY_ACTIONS[i].id
          keys[id] = normCombo(out.keys && out.keys[id])
        }
        out.keys = keys
        return out
      }

      function loadSettings() {
        try {
          var raw = window.localStorage.getItem(SETTINGS_KEY)
          if (!raw) return defaultSettings()
          return mergeSettings(JSON.parse(raw))
        } catch (error) {
          return defaultSettings()
        }
      }

      var settings = loadSettings()
      var settingsListeners = new Set()

      function updateSettings(patch) {
        var next = {}
        for (var k in settings) next[k] = settings[k]
        for (var k2 in patch) next[k2] = patch[k2]
        if (patch && patch.keys) {
          var mergedKeys = {}
          for (var kk in settings.keys) mergedKeys[kk] = settings.keys[kk]
          for (var kk2 in patch.keys) mergedKeys[kk2] = patch.keys[kk2]
          next.keys = mergedKeys
        }
        settings = mergeSettings(next)
        try {
          window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
        } catch (error) { /* storage full or blocked: settings stay in-memory */ }
        settingsListeners.forEach(function (fn) { fn() })
      }

      function useSettingValue() {
        var pair = useState(settings)
        useEffect(function () {
          var notify = function () { pair[1](settings) }
          settingsListeners.add(notify)
          return function () { settingsListeners.delete(notify) }
        }, [])
        return pair[0]
      }

      function modeById(id) {
        for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) return MODES[i]
        return MODES[0]
      }

      // ------------------------------------------------------------------
      // Scroll engine
      // ------------------------------------------------------------------

      var USER_WINDOW_MS = 600      // how long after wheel/touch/pointer/key input a scroll counts as reader-driven
      var SNAP_RECENT_MS = 700      // how long after a flow resize a floor-landing jump may be a follow snap
      var SNAP_FLOOR_PX = 40        // how close to the floor a snap lands (the shipped toBottom lands exactly at it)
      var BOTTOM_EPS = 4            // distance-to-floor under which smooth cruising is "caught up"
      var SECTION_TOP_OFFSET = 12   // px below the scrollport top where a section is aligned
      var SCROLL_KEYS = { 'arrowup': 1, 'arrowdown': 1, 'pageup': 1, 'pagedown': 1, 'home': 1, 'end': 1, ' ': 1 }

      var engine = {
        el: null,
        binds: 0,
        ro: null,
        mo: null,
        observedCol: null,
        // reader anchor: the row at the viewport top plus its offset, so
        // pinning survives content appends (and stays idempotent with the
        // shipped loadOlder anchor restore)
        anchor: null,
        anchorAbs: 0,
        lastSeenTop: 0,
        lastScrollHeight: 0,
        lastUserInputAt: 0,
        lastFlowResizeAt: 0,
        holdSendUntil: 0,
        // cruise
        phase: 'idle',            // idle | travel | read | await
        cruiseKind: null,         // bottom | section | manual
        travelTarget: null,       // (el) => absolute scrollTop target | null
        readSectionKey: null,
        readUntil: 0,
        readTotalMs: 0,
        readThroughEnd: null,
        readThroughSpeed: 0,
        readTimer: 0,
        raf: 0,
        lastFrame: 0,
        pendingRetarget: 0,
        // pace state
        paceArmed: false,
        userPaused: false,
        sectionsRead: 0,
        // feeds
        sections: [],
        running: false,
        tipText: false,
        // engine-authored write bookkeeping (so the scroll listener can tell
        // its own writes apart from the shipped code's and the reader's)
        lastEngineWrite: -1,
        lastEngineWriteAt: 0,
        // session open-position state
        sessionId: null,
        lastPosFlush: 0,
        restoring: false,
        restoreGen: 0
      }

      var statusListeners = new Set()
      function notifyStatus() {
        statusListeners.forEach(function (fn) { fn() })
      }
      function useEngineStatus() {
        var pair = useState(0)
        useEffect(function () {
          var bump = function () { pair[1](function (x) { return x + 1 }) }
          statusListeners.add(bump)
          return function () { statusListeners.delete(bump) }
        }, [])
        return engine
      }

      function now() { return Date.now() }

      // bounded ring of recent engine decisions - support diagnostics,
      // readable via window.__chatPaceDebug.scrollLog from the page console
      var SCROLL_LOG = []
      function slog(msg) {
        SCROLL_LOG.push((Date.now() % 100000) + ' ' + msg)
        if (SCROLL_LOG.length > 30) SCROLL_LOG.shift()
      }

      function port() {
        var el = engine.el
        if (el && el.isConnected) return el
        return null
      }

      function floorOf(el) {
        var f = el.scrollHeight - el.clientHeight
        return f > 0 ? f : 0
      }

      function nearFloor(el, px) {
        return floorOf(el) - el.scrollTop <= px
      }

      function rowsOf(el) {
        return el.querySelectorAll('[data-chat-anchor-key]')
      }

      function rowByKey(el, key) {
        var rows = rowsOf(el)
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].dataset.chatAnchorKey === key) return rows[i]
        }
        return null
      }

      function flowTopOf(el, row) {
        return row.getBoundingClientRect().top - el.getBoundingClientRect().top
      }

      function viewportTopRow(el) {
        var rows = rowsOf(el)
        var portTop = el.getBoundingClientRect().top
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].getBoundingClientRect().bottom > portTop + 1) return rows[i]
        }
        return null
      }

      function saveAnchor(el) {
        var row = viewportTopRow(el)
        if (row && row.dataset.chatAnchorKey) {
          engine.anchor = { key: row.dataset.chatAnchorKey, offset: flowTopOf(el, row) }
        } else {
          engine.anchor = null
        }
        engine.anchorAbs = el.scrollTop
        schedulePosFlush()
      }

      function anchorRestoreTop(el) {
        if (engine.anchor) {
          var row = rowByKey(el, engine.anchor.key)
          if (row) return el.scrollTop + flowTopOf(el, row) - engine.anchor.offset
        }
        return engine.anchorAbs
      }

      // ---- per-session open position -------------------------------------
      //
      // Every session's last reading position is remembered in localStorage
      // regardless of the openPosition setting, so turning "Where I left it"
      // on later still restores sessions left before it was enabled.

      var POS_KEY = 'dsh-chat-pace-scrollpos-v1'
      var POS_MAX_SESSIONS = 60

      function readPosStore() {
        try {
          var raw = window.localStorage.getItem(POS_KEY)
          if (!raw) return {}
          var v = JSON.parse(raw)
          return v && typeof v === 'object' ? v : {}
        } catch (error) {
          return {}
        }
      }

      function writePosStore(store) {
        try {
          window.localStorage.setItem(POS_KEY, JSON.stringify(store))
        } catch (error) { /* storage full or blocked: skip */ }
      }

      function flushPosition() {
        if (!engine.sessionId) return
        // while an open-restore owns the placement, the mount-time anchor
        // is not "where the reader left it" - keep the stored entry intact
        if (engine.restoring) return
        var entry = null
        if (engine.anchor) {
          entry = { key: engine.anchor.key, off: Math.round(engine.anchor.offset), abs: Math.round(engine.anchorAbs), at: now() }
        } else if (engine.anchorAbs > 0) {
          entry = { key: '', off: 0, abs: Math.round(engine.anchorAbs), at: now() }
        }
        if (!entry) return
        var store = readPosStore()
        var prev = store[engine.sessionId]
        if (prev && prev.abs === entry.abs && prev.key === entry.key && now() - (prev.at || 0) < 60000) return
        store[engine.sessionId] = entry
        var keys = Object.keys(store)
        if (keys.length > POS_MAX_SESSIONS) {
          keys.sort(function (a, b) { return (store[a].at || 0) - (store[b].at || 0) })
          for (var i = 0; i < keys.length - POS_MAX_SESSIONS; i++) delete store[keys[i]]
        }
        writePosStore(store)
      }

      function schedulePosFlush() {
        var t = now()
        if (t - engine.lastPosFlush < 500) return
        engine.lastPosFlush = t
        flushPosition()
      }

      function setSessionId(id) {
        if (engine.sessionId === id) return
        // persist the outgoing session's position before switching
        flushPosition()
        engine.sessionId = id
        engine.anchor = null
        engine.anchorAbs = 0
        // input on the outgoing session must not read as input on this one
        engine.lastUserInputAt = 0
        scheduleOpenPosition()
      }

      function scheduleOpenPosition() {
        engine.restoreGen++
        var gen = engine.restoreGen
        engine.restoring = true
        // timers, not rAF: session open must place the view even while the
        // tab is hidden (rAF is suspended in background tabs). All three
        // placements are active: the shipped code has its own per-session
        // anchor memory and would otherwise restore the old position.
        var mode0 = settings.openPosition
        setTimeout(function () {
          if (gen !== engine.restoreGen || !engine.restoring) return
          if (mode0 === 'bottom') pinToBottomOnOpen(gen)
          else if (mode0 === 'resume') restorePositionOnOpen(gen)
          else pinToTopOnOpen(gen)
        }, 0)
      }

      function openTick(gen, fn) {
        // 80ms timer loop: works in hidden tabs (throttled to ~1s, still
        // completes), idempotent re-asserts so the pace does not matter
        setTimeout(function () {
          if (gen !== engine.restoreGen || !engine.restoring) return
          fn()
        }, 80)
      }

      function endRestore(gen, applied, label) {
        if (gen !== engine.restoreGen) return
        engine.restoring = false
        slog('open ' + (label || settings.openPosition) + (applied ? ' ok' : ' skip'))
        var el = port()
        if (el) {
          noteEngineWrite(el)
          engine.lastSeenTop = el.scrollTop
          saveAnchor(el)
        }
        notifyStatus()
        // re-arm whatever the active mode wants now that the view is placed
        if (el) scheduleRetarget()
      }

      function userTookOver() {
        return now() - engine.lastUserInputAt < USER_WINDOW_MS
      }

      function restorePositionOnOpen(gen) {
        var saved = engine.sessionId ? readPosStore()[engine.sessionId] : null
        if (!saved) { endRestore(gen, false, 'resume'); return }
        slog('open resume key:' + String(saved.key).slice(-12) + ' abs:' + saved.abs)
        var started = now()
        var attempts = 0
        var stable = 0
        var frames = 0
        function tick() {
          if (userTookOver()) { endRestore(gen, false, 'resume'); return }
          var el = port()
          if (!el) {
            if (++attempts < 100) { openTick(gen, tick); return }
            endRestore(gen, false, 'resume')
            return
          }
          var row = saved.key ? rowByKey(el, saved.key) : null
          if (!row) {
            // snapshot rows may not be rendered yet; wait a bit
            if (++attempts < 100) { openTick(gen, tick); return }
            // row is gone (compacted away): fall back to the absolute
            el.scrollTop = Math.max(0, Math.min(saved.abs || 0, floorOf(el)))
            endRestore(gen, true, 'resume')
            return
          }
          // re-assert the alignment on every tick while the mount churns -
          // the shipped code runs its own anchor restores during layout,
          // and the restore must be the last writer to win
          var abs = el.scrollTop + flowTopOf(el, row) - (saved.off || 0)
          var fl = floorOf(el)
          if (abs > fl - 4) abs = fl
          var want = Math.max(0, abs)
          if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want
          noteEngineWrite(el)
          // settled: the target has been held for several consecutive
          // ticks - hand the view over even if the flow is still streaming
          if (Math.abs(el.scrollTop - want) <= 1) stable++
          else stable = 0
          // hard time cap too: background tabs throttle timers to ~1s, so
          // a tick-count cap alone could hold the restore for minutes
          if (stable >= 12 || now() - started > 12000) { endRestore(gen, true, 'resume'); return }
          if (++frames < 120) openTick(gen, tick)
          else endRestore(gen, true, 'resume')
        }
        openTick(gen, tick)
      }

      function pinToBottomOnOpen(gen) {
        var started = now()
        var stable = 0
        var frames = 0
        function tick() {
          if (userTookOver()) { endRestore(gen, false, 'bottom'); return }
          var el = port()
          if (!el) {
            if (++frames < 100) { openTick(gen, tick); return }
            endRestore(gen, false, 'bottom')
            return
          }
          el.scrollTop = floorOf(el)
          noteEngineWrite(el)
          // settled: the floor has been held for several consecutive ticks
          if (Math.abs(el.scrollTop - floorOf(el)) <= 1) stable++
          else stable = 0
          if (stable >= 12 || now() - started > 12000) { endRestore(gen, true, 'bottom'); return }
          if (++frames < 120) openTick(gen, tick)
          else endRestore(gen, true, 'bottom')
        }
        openTick(gen, tick)
      }

      function pinToTopOnOpen(gen) {
        var started = now()
        var stable = 0
        var frames = 0
        function tick() {
          if (userTookOver()) { endRestore(gen, false, 'top'); return }
          var el = port()
          if (!el) {
            if (++frames < 100) { openTick(gen, tick); return }
            endRestore(gen, false, 'top')
            return
          }
          if (el.scrollTop > 1) el.scrollTop = 0
          noteEngineWrite(el)
          if (el.scrollTop <= 1) stable++
          else stable = 0
          if (stable >= 12 || now() - started > 12000) { endRestore(gen, true, 'top'); return }
          if (++frames < 120) openTick(gen, tick)
          else endRestore(gen, true, 'top')
        }
        openTick(gen, tick)
      }

      function noteEngineWrite(el) {
        engine.lastEngineWrite = el.scrollTop
        engine.lastEngineWriteAt = now()
      }

      function currentSpeed() {
        var v = Number(settings.speedPxs)
        if (!isFinite(v) || v < 20) v = 20
        return v
      }

      // ---- bind / unbind -------------------------------------------------

      function onUserInput() {
        engine.lastUserInputAt = now()
      }

      function onPortScroll() {
        try {
          handlePortScroll()
        } catch (error) {
          console.error('[chat-pace] scroll handler failed:', error)
        }
      }

      function handlePortScroll() {
        var el = port()
        if (!el) return
        var top = el.scrollTop
        var t = now()
        // our own writes: absorb
        if (engine.lastEngineWriteAt > 0 && t - engine.lastEngineWriteAt < 140 && Math.abs(top - engine.lastEngineWrite) < 3) {
          engine.lastSeenTop = top
          return
        }
        var grew = el.scrollHeight !== engine.lastScrollHeight
        engine.lastScrollHeight = el.scrollHeight
        var jump = Math.abs(top - engine.lastSeenTop)
        var userWindow = t - engine.lastUserInputAt < USER_WINDOW_MS
        var floorLand = floorOf(el) - top <= SNAP_FLOOR_PX
        var recentGrowth = grew || t - engine.lastFlowResizeAt < SNAP_RECENT_MS || t - engine.lastEngineWriteAt < SNAP_RECENT_MS
        // The shipped follow snap does not look like a big jump while the
        // model streams: toBottom fires per token batch, each landing exactly
        // at the floor, so each individual snap is tiny. Its true signature
        // is "no reader input in the window + landed at the floor + content
        // just grew". Jump size says nothing - size was the bug.
        var cruising = engine.phase === 'travel' || engine.phase === 'read'
        if (cruising) {
          if (userWindow) {
            if (floorLand) {
              // the reader reached the bottom themselves (or sent a message):
              // accept it and let the mode logic re-arm naturally
              slog('user-floor t' + Math.round(top))
              stopCruise()
              saveAnchor(el)
            } else if (settings.releaseOnUserScroll) {
              slog('user-release t' + Math.round(top))
              stopCruise()
              engine.userPaused = true
              saveAnchor(el)
              notifyStatus()
            } else {
              saveAnchor(el)
            }
          } else if (floorLand && recentGrowth) {
            // shipped snap mid-cruise: restore the cruise position before paint
            var restore = engine.lastEngineWrite >= 0 ? engine.lastEngineWrite : anchorRestoreTop(el)
            el.scrollTop = restore
            noteEngineWrite(el)
            slog('c-snap ' + Math.round(top) + '->' + Math.round(restore))
          } else if (jump > 24) {
            // un-flagged movement we cannot attribute (scrollbar drag tail):
            // hand control back to the reader instead of fighting it
            stopCruise()
            if (settings.releaseOnUserScroll) engine.userPaused = true
            saveAnchor(el)
            notifyStatus()
            slog('c-foreign t' + Math.round(top))
          }
        } else if (!engine.restoring && floorLand && recentGrowth && settings.mode !== 'follow' && (!userWindow || (t < engine.holdSendUntil && !settings.jumpOnSend))) {
          // shipped snap while we own the view: pin back to the reader anchor
          var back = anchorRestoreTop(el)
          if (Math.abs(back - top) > 1) {
            el.scrollTop = back
            noteEngineWrite(el)
            slog('snap ' + Math.round(top) + '->' + Math.round(back))
          } else {
            saveAnchor(el)
          }
        } else {
          saveAnchor(el)
          if (userWindow) slog('accept-user t' + Math.round(top))
          else slog('accept t' + Math.round(top) + (floorLand ? ' floor' : '') + (grew ? ' grew' : ''))
          if (userWindow && settings.resumeAtBottom && engine.userPaused && nearFloor(el, 30)) {
            userResume()
          }
        }
        engine.lastSeenTop = el.scrollTop
      }

      function refreshObserver(el) {
        if (!engine.ro) return
        var col = el.querySelector('[data-chat-flow]')
        if (col === engine.observedCol) return
        if (engine.observedCol) {
          try { engine.ro.unobserve(engine.observedCol) } catch (error) { /* detached node */ }
        }
        if (col) engine.ro.observe(col)
        engine.observedCol = col
      }

      function attach(el) {
        if (engine.el === el) {
          engine.binds++
          return
        }
        if (engine.el !== null) unbindAll()
        engine.el = el
        engine.binds = 1
        el.addEventListener('scroll', onPortScroll, { passive: true })
        el.addEventListener('wheel', onUserInput, { passive: true, capture: true })
        el.addEventListener('touchstart', onUserInput, { passive: true, capture: true })
        el.addEventListener('pointerdown', onUserInput, { passive: true, capture: true })
        engine.lastScrollHeight = el.scrollHeight
        engine.lastSeenTop = el.scrollTop
        saveAnchor(el)
        if (typeof ResizeObserver === 'function') {
          engine.ro = new ResizeObserver(function () {
            engine.lastFlowResizeAt = now()
            scheduleRetarget()
          })
          engine.ro.observe(el)
          refreshObserver(el)
        }
        // subtree childList mutations cover what ResizeObserver cannot see:
        // the flow column being replaced on view switches, and content
        // growth that never scrolls (reader mid-history, follow disengaged)
        if (typeof MutationObserver === 'function') {
          engine.mo = new MutationObserver(function () {
            engine.lastFlowResizeAt = now()
            scheduleRetarget()
          })
          engine.mo.observe(el, { childList: true, subtree: true })
        }
        // a freshly attached session view: re-arm the active mode
        if (settings.mode === 'paced' && !engine.userPaused) {
          engine.paceArmed = true
          scheduleRetarget()
        } else if (settings.mode === 'smooth') {
          scheduleRetarget()
        }
        notifyStatus()
      }

      function detach() {
        engine.binds--
        if (engine.binds <= 0) unbindAll()
      }

      function unbindAll() {
        var el = engine.el
        engine.el = null
        engine.binds = 0
        stopCruise()
        flushPosition()
        if (engine.pendingRetarget) {
          cancelAnimationFrame(engine.pendingRetarget)
          engine.pendingRetarget = 0
        }
        if (engine.ro) {
          engine.ro.disconnect()
          engine.ro = null
        }
        if (engine.mo) {
          engine.mo.disconnect()
          engine.mo = null
        }
        engine.observedCol = null
        engine.paceArmed = false
        if (el) {
          el.removeEventListener('scroll', onPortScroll)
          el.removeEventListener('wheel', onUserInput, { capture: true })
          el.removeEventListener('touchstart', onUserInput, { capture: true })
          el.removeEventListener('pointerdown', onUserInput, { capture: true })
        }
        notifyStatus()
      }

      // ---- cruise loop ---------------------------------------------------

      function scheduleRetarget() {
        if (engine.pendingRetarget) return
        engine.pendingRetarget = requestAnimationFrame(function () {
          engine.pendingRetarget = 0
          retarget()
        })
      }

      function retarget() {
        var el = port()
        if (!el) return
        if (engine.restoring) return
        refreshObserver(el)
        if (engine.userPaused) return
        var m = settings.mode
        if (m === 'smooth' && engine.phase === 'idle') {
          if (floorOf(el) - el.scrollTop > BOTTOM_EPS) {
            startCruise('bottom', function (el2) { return floorOf(el2) })
          }
        } else if (m === 'paced' && engine.paceArmed && (engine.phase === 'idle' || engine.phase === 'await')) {
          nextSectionAuto()
        }
      }

      function startCruise(kind, targetFn) {
        var el = port()
        if (!el) return
        slog('cruise ' + kind + ' t' + Math.round(el.scrollTop))
        engine.phase = 'travel'
        engine.cruiseKind = kind
        engine.travelTarget = targetFn
        engine.readThroughEnd = null
        if (!engine.raf) {
          engine.lastFrame = 0
          engine.raf = requestAnimationFrame(cruiseFrame)
        }
        notifyStatus()
      }

      function stopCruise() {
        if (engine.raf) {
          cancelAnimationFrame(engine.raf)
          engine.raf = 0
        }
        if (engine.readTimer) {
          clearTimeout(engine.readTimer)
          engine.readTimer = 0
        }
        engine.readThroughEnd = null
        if (engine.phase !== 'idle') {
          engine.phase = 'idle'
          notifyStatus()
        }
      }

      function cruiseFrame(ts) {
        engine.raf = 0
        try {
          frameStep(ts)
        } catch (error) {
          console.error('[chat-pace] cruise frame failed:', error)
          stopCruise()
        }
      }

      function frameStep(ts) {
        var el = port()
        if (!el) {
          stopCruise()
          return
        }
        if (engine.phase !== 'travel' && engine.phase !== 'read') return
        var dt = engine.lastFrame ? Math.min(0.06, (ts - engine.lastFrame) / 1000) : 1 / 60
        engine.lastFrame = ts
        if (engine.phase === 'travel') {
          // external revert detector: if something undid our last glide step
          // the view is fighting us - log it once per fight burst
          if (engine.lastEngineWrite >= 0 && cur < engine.lastEngineWrite - 3) {
            if (engine.lastWriteLogged === undefined || Math.abs(cur - engine.lastWriteLogged) > 24) {
              engine.lastWriteLogged = cur
              slog('c-revert ' + Math.round(cur) + '<' + Math.round(engine.lastEngineWrite))
            }
          }
          var target = engine.travelTarget(el)
          if (target === null || target === undefined) {
            stopCruise()
            if (settings.mode === 'paced' && engine.cruiseKind === 'section') nextSectionAuto()
            return
          }
          var floor = floorOf(el)
          if (target > floor) target = floor
          if (target < 0) target = 0
          var cur = el.scrollTop
          var diff = target - cur
          var step = currentSpeed() * dt
          if (Math.abs(diff) <= Math.max(2, step)) {
            el.scrollTop = target
            noteEngineWrite(el)
            arrive(el)
            if (engine.phase === 'travel' && !engine.raf) {
              engine.raf = requestAnimationFrame(cruiseFrame)
            }
          } else {
            el.scrollTop = cur + (diff > 0 ? step : -step)
            noteEngineWrite(el)
            engine.raf = requestAnimationFrame(cruiseFrame)
          }
        } else {
          // read phase: tall sections drift through their remainder
          var endY = engine.readThroughEnd
          if (endY !== null && endY !== undefined && el.scrollTop < endY - 2) {
            var sp = engine.readThroughSpeed > 0 ? engine.readThroughSpeed : currentSpeed()
            el.scrollTop = Math.min(endY, el.scrollTop + sp * dt)
            noteEngineWrite(el)
          }
          if (now() < engine.readUntil) {
            engine.raf = requestAnimationFrame(cruiseFrame)
          } else {
            finishRead()
          }
        }
      }

      function arrive(el) {
        // every deliberate stop becomes the reader anchor, so a later
        // shipped snap is counteracted back HERE - not to a stale position
        // from before the cruise (which would teleport the view)
        saveAnchor(el)
        if (engine.cruiseKind === 'bottom' || engine.cruiseKind === 'manual') {
          engine.phase = 'idle'
          notifyStatus()
          return
        }
        if (engine.cruiseKind === 'section') {
          beginRead(el)
        }
      }

      function beginRead(el) {
        var key = engine.readSectionKey
        var row = key ? rowByKey(el, key) : null
        var vh = el.clientHeight || 600
        var h = row ? row.offsetHeight : Math.round(vh * 0.5)
        var factor = Number(settings.secsPerViewport)
        if (!isFinite(factor) || factor < 0.5) factor = 4
        var pauseMs = Math.round((h / Math.max(120, vh)) * factor * 1000)
        var mn = Number(settings.minPauseMs)
        if (!isFinite(mn) || mn < 0) mn = 400
        var mx = Number(settings.maxPauseMs)
        if (!isFinite(mx) || mx < mn) mx = Math.max(mn, 20000)
        pauseMs = Math.min(mx, Math.max(mn, pauseMs))
        slog('read ' + String(key).slice(-12) + ' ' + pauseMs + 'ms')
        engine.readUntil = now() + pauseMs
        engine.readTotalMs = pauseMs
        engine.phase = 'read'
        engine.sectionsRead++
        engine.readThroughEnd = null
        if (row && h > vh - 24) {
          // section taller than the viewport: spend the pause drifting
          // through it at a speed that makes the drift last exactly pauseMs
          var endY = el.scrollTop + flowTopOf(el, row) + h - vh + 16
          var floor = floorOf(el)
          if (endY > floor) endY = floor
          if (endY > el.scrollTop + 4) {
            engine.readThroughEnd = endY
            engine.readThroughSpeed = (endY - el.scrollTop) / Math.max(0.25, pauseMs / 1000)
            if (!engine.raf) {
              engine.lastFrame = 0
              engine.raf = requestAnimationFrame(cruiseFrame)
            }
          } else {
            armReadTimer(pauseMs)
          }
        } else {
          armReadTimer(pauseMs)
        }
        notifyStatus()
      }

      function armReadTimer(pauseMs) {
        if (engine.readTimer) clearTimeout(engine.readTimer)
        engine.readTimer = setTimeout(function () {
          engine.readTimer = 0
          if (engine.phase === 'read') finishRead()
        }, pauseMs + 30)
      }

      function finishRead() {
        if (engine.readTimer) {
          clearTimeout(engine.readTimer)
          engine.readTimer = 0
        }
        engine.readThroughEnd = null
        engine.phase = 'idle'
        slog('read-done rd:' + engine.sectionsRead)
        notifyStatus()
        nextSectionAuto()
      }

      // ---- sections --------------------------------------------------------

      function findNextSection(el) {
        // the cursor sits past the align offset so a section that was just
        // read (still aligned at the viewport top) is not found again
        var cur = el.scrollTop + SECTION_TOP_OFFSET + 4
        var list = engine.sections
        for (var i = 0; i < list.length; i++) {
          var row = rowByKey(el, list[i])
          if (!row) continue
          var top = el.scrollTop + flowTopOf(el, row)
          // skip sections fully visible in the current view: the reader
          // already watched them arrive, and re-finding them would loop
          // cruise -> read forever without moving the view (the aligned
          // tail section at the floor). Sections that streamed below the
          // fold, or that are taller than the screen, are still read.
          if (top + row.offsetHeight <= el.scrollTop + el.clientHeight + 4) continue
          if (top > cur) return list[i]
        }
        return null
      }

      function findPrevSection(el) {
        var cur = el.scrollTop - SECTION_TOP_OFFSET - 4
        var list = engine.sections
        for (var i = list.length - 1; i >= 0; i--) {
          var row = rowByKey(el, list[i])
          if (!row) continue
          var top = el.scrollTop + flowTopOf(el, row)
          // skip the section the viewport top edge is inside: stepping
          // back from inside one tall section should go to the one before it
          if (top <= el.scrollTop && top + row.offsetHeight > el.scrollTop) continue
          if (top < cur) return list[i]
        }
        return null
      }

      function sectionTarget(key) {
        return function (el) {
          var row = rowByKey(el, key)
          if (!row) return null
          return el.scrollTop + flowTopOf(el, row) - SECTION_TOP_OFFSET
        }
      }

      function nextSectionAuto() {
        var el = port()
        if (!el) return
        if (settings.mode !== 'paced' || engine.userPaused) return
        if (engine.phase === 'travel' || engine.phase === 'read') return
        if (engine.restoring) return
        var next = findNextSection(el)
        if (next !== null) {
          engine.readSectionKey = next
          slog('auto next ' + String(next).slice(-12))
          startCruise('section', sectionTarget(next))
          return
        }
        if (!engine.running) {
          slog('auto done')
          engine.phase = 'idle'
          engine.paceArmed = false
          notifyStatus()
          return
        }
        engine.phase = 'await'
        slog(engine.tipText ? 'auto hold-for-text' : 'auto follow')
        if (!engine.tipText && floorOf(el) - el.scrollTop > BOTTOM_EPS) {
          // nothing readable below - only tool calls and other rows growing:
          // keep following the live tip so the reader stays in the flow
          startCruise('bottom', function (el2) { return floorOf(el2) })
        }
        // a text section streaming at the tip is left to accumulate below the
        // fold; it is cruised to and read once it settles
        if (engine.tipText) saveAnchor(el)
        notifyStatus()
      }

      // ---- feeds -----------------------------------------------------------

      function setSections(keys) {
        var changed = keys.length !== engine.sections.length
        if (!changed) {
          for (var i = 0; i < keys.length; i++) {
            if (keys[i] !== engine.sections[i]) { changed = true; break }
          }
        }
        engine.sections = keys
        if (changed) notifyStatus()
        if (settings.mode === 'paced' && engine.paceArmed && !engine.userPaused &&
          (engine.phase === 'idle' || engine.phase === 'await')) {
          nextSectionAuto()
        }
      }

      function setRunning(running) {
        if (engine.running === running) return
        engine.running = running
        if (running && settings.mode === 'paced' && !engine.userPaused) {
          engine.paceArmed = true
          if (engine.phase === 'idle' || engine.phase === 'await') nextSectionAuto()
        }
        notifyStatus()
      }

      function setTipText(b) {
        if (engine.tipText === b) return
        engine.tipText = b
        slog('tip ' + (b ? 'text' : 'other'))
        if (settings.mode === 'paced' && engine.paceArmed && !engine.userPaused) {
          if (b && engine.phase === 'travel' && engine.cruiseKind === 'bottom') {
            // text started streaming at the tip: stop following before the
            // unread text scrolls past, and anchor where we stopped
            stopCruise()
            var el0 = port()
            if (el0) saveAnchor(el0)
          }
          if (engine.phase === 'idle' || engine.phase === 'await') nextSectionAuto()
        }
        notifyStatus()
      }

      function noteUserSend() {
        engine.holdSendUntil = now() + 900
      }

      // ---- controls ----------------------------------------------------------

      function userResume() {
        engine.userPaused = false
        notifyStatus()
        var el = port()
        if (!el) return
        if (settings.mode === 'paced') {
          engine.paceArmed = true
          nextSectionAuto()
        } else if (settings.mode === 'smooth') {
          retarget()
        }
      }

      function togglePause() {
        if (engine.userPaused) {
          userResume()
          return
        }
        if (settings.mode !== 'smooth' && settings.mode !== 'paced') return
        if (engine.phase === 'travel' || engine.phase === 'read') stopCruise()
        engine.userPaused = true
        var el = port()
        if (el) saveAnchor(el)
        notifyStatus()
      }

      function jumpLatest() {
        var el = port()
        if (!el) return
        el.scrollTop = floorOf(el)
        noteEngineWrite(el)
        saveAnchor(el)
        engine.lastSeenTop = el.scrollTop
        if (settings.mode === 'paced') nextSectionAuto()
        notifyStatus()
      }

      function stepNext() {
        var el = port()
        if (!el) return
        var next = findNextSection(el)
        if (next === null) {
          jumpLatest()
          return
        }
        if (settings.mode === 'paced' && !engine.userPaused) {
          engine.readSectionKey = next
          startCruise('section', sectionTarget(next))
          return
        }
        if (settings.stepSmooth) {
          startCruise('manual', sectionTarget(next))
        } else {
          var target = sectionTarget(next)(el)
          if (target !== null) {
            el.scrollTop = Math.max(0, Math.min(target, floorOf(el)))
            noteEngineWrite(el)
            saveAnchor(el)
            engine.lastSeenTop = el.scrollTop
          }
        }
      }

      function stepPrev() {
        var el = port()
        if (!el) return
        var prev = findPrevSection(el)
        if (prev === null) {
          el.scrollTop = 0
          noteEngineWrite(el)
          saveAnchor(el)
          engine.lastSeenTop = el.scrollTop
          return
        }
        if (settings.stepSmooth) {
          startCruise('manual', sectionTarget(prev))
        } else {
          var target = sectionTarget(prev)(el)
          if (target !== null) {
            el.scrollTop = Math.max(0, Math.min(target, floorOf(el)))
            noteEngineWrite(el)
            saveAnchor(el)
            engine.lastSeenTop = el.scrollTop
          }
        }
      }

      function setMode(m) {
        if (MODE_IDS.indexOf(m) < 0 || m === settings.mode) return
        slog('mode ' + m)
        stopCruise()
        engine.userPaused = false
        engine.paceArmed = false
        engine.sectionsRead = 0
        updateSettings({ mode: m })
        var el = port()
        if (!el) return
        if (m === 'paced') {
          engine.paceArmed = true
          nextSectionAuto()
        } else if (m === 'smooth') {
          retarget()
        } else if (m === 'follow') {
          // "follow the latest" only means something from the bottom
          jumpLatest()
        }
        notifyStatus()
      }

      var CYCLE_NEXT = { follow: 'smooth', smooth: 'paced', paced: 'step', step: 'hold', hold: 'follow' }

      // ---- hotkeys -----------------------------------------------------------

      function comboOf(e) {
        var k = (e.key || '').toLowerCase()
        if (k === 'control' || k === 'shift' || k === 'alt' || k === 'meta') return null
        if (k.length === 0) return null
        var parts = []
        if (e.ctrlKey || e.metaKey) parts.push('ctrl')
        if (e.altKey) parts.push('alt')
        if (e.shiftKey) parts.push('shift')
        parts.push(k)
        return parts.join('+')
      }

      function isEditableTarget(t) {
        if (!t || typeof t.closest !== 'function') return false
        return t.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null
      }

      function onKeyDown(e) {
        var key = (e.key || '').toLowerCase()
        if (SCROLL_KEYS[key] && !isEditableTarget(e.target)) {
          engine.lastUserInputAt = now()
        }
        if (isEditableTarget(e.target)) return
        var combo = comboOf(e)
        if (combo === null) return
        var keys = settings.keys
        if (keys.toggle && combo === keys.toggle) {
          e.preventDefault()
          togglePause()
        } else if (keys.next && combo === keys.next) {
          e.preventDefault()
          stepNext()
        } else if (keys.prev && combo === keys.prev) {
          e.preventDefault()
          stepPrev()
        } else if (keys.latest && combo === keys.latest) {
          e.preventDefault()
          jumpLatest()
        } else if (keys.cycle && combo === keys.cycle) {
          e.preventDefault()
          setMode(CYCLE_NEXT[settings.mode] || 'follow')
        }
      }

      // ------------------------------------------------------------------
      // Shared UI helpers
      // ------------------------------------------------------------------

      function statusText() {
        var m = settings.mode
        if (m === 'follow') return 'Chat pace: Follow (default)'
        if (engine.userPaused) return 'Chat pace: ' + modeById(m).name + ' \u00b7 paused'
        if (m === 'smooth') {
          if (engine.phase === 'travel') return 'Chat pace: gliding to latest \u00b7 ' + Math.round(currentSpeed()) + ' px/s'
          return 'Chat pace: Smooth \u00b7 caught up'
        }
        if (m === 'paced') {
          if (engine.phase === 'travel') {
            return engine.cruiseKind === 'bottom'
              ? 'Chat pace: following live output \u00b7 ' + Math.round(currentSpeed()) + ' px/s'
              : 'Chat pace: moving to next section'
          }
          if (engine.phase === 'read') {
            var left = Math.max(0, Math.ceil((engine.readUntil - now()) / 100) / 10)
            return 'Chat pace: reading \u00b7 ' + left.toFixed(1) + 's on this section'
          }
          if (engine.phase === 'await') {
            return engine.tipText
              ? 'Chat pace: holding while the next section is written\u2026'
              : 'Chat pace: following tool activity\u2026'
          }
          return 'Chat pace: Paced \u00b7 ready'
        }
        if (m === 'step') return 'Chat pace: Step \u00b7 ' + engine.sections.length + ' sections loaded'
        return 'Chat pace: Hold \u00b7 view pinned'
      }

      // Mode menu: shared popover for the composer control and header button.
      function ModeMenu(props) {
        var up = props.up
        var onClose = props.onClose
        useEffect(function () {
          function onDown(e) {
            if (e.target && typeof e.target.closest === 'function' &&
              e.target.closest('.dsh-cp-menu') !== null) return
            onClose()
          }
          function onKey(e) {
            if (e.key === 'Escape') onClose()
          }
          document.addEventListener('pointerdown', onDown, true)
          document.addEventListener('keydown', onKey, true)
          return function () {
            document.removeEventListener('pointerdown', onDown, true)
            document.removeEventListener('keydown', onKey, true)
          }
        }, [onClose])
        var s = useSettingValue()
        var rows = MODES.map(function (m) {
          var selected = s.mode === m.id
          return createElement('button', {
            key: m.id,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected ? 'true' : 'false',
            className: 'dsh-cp-mrow' + (selected ? ' dsh-cp-mrow-on' : ''),
            onClick: function () { setMode(m.id); onClose() }
          },
            createElement('span', { className: 'dsh-cp-micon' }, m.icon),
            createElement('span', { className: 'dsh-cp-mtext' },
              createElement('span', { className: 'dsh-cp-mname' }, m.name),
              createElement('span', { className: 'dsh-cp-mhint' }, m.hint)))
        })
        var canPause = s.mode === 'smooth' || s.mode === 'paced'
        return createElement('div', { className: 'dsh-cp-menu' + (up ? ' dsh-cp-menu-up' : ''), role: 'menu' },
          rows,
          createElement('div', { key: 'sep1', className: 'dsh-cp-msep' }),
          createElement('button', {
            key: 'pause', type: 'button', role: 'menuitem', className: 'dsh-cp-mact',
            disabled: !canPause,
            onClick: function () { togglePause(); onClose() }
          }, canPause ? (engine.userPaused ? '\u25b6 Resume auto-scroll' : '\u23f8 Pause auto-scroll') : '\u23f8 Pause (Smooth/Paced only)'),
          createElement('button', { key: 'next', type: 'button', role: 'menuitem', className: 'dsh-cp-mact', onClick: function () { stepNext(); onClose() } }, '\u23ed Next output section'),
          createElement('button', { key: 'prev', type: 'button', role: 'menuitem', className: 'dsh-cp-mact', onClick: function () { stepPrev(); onClose() } }, '\u23ee Previous output section'),
          createElement('button', { key: 'latest', type: 'button', role: 'menuitem', className: 'dsh-cp-mact', onClick: function () { jumpLatest(); onClose() } }, '\u2b07 Jump to latest output'),
          createElement('div', { key: 'sep2', className: 'dsh-cp-msep' }),
          createElement('div', { key: 'tip', className: 'dsh-cp-mtip' }, 'All options: Settings \u2192 Chat Pace')
        )
      }

      // ------------------------------------------------------------------
      // Entry: conversation.input.left — compact control cluster
      // ------------------------------------------------------------------

      function selectSectionKeys(useSession) {
        // one stable string per distinct section list, so unrelated store
        // ticks (streaming tokens) do not re-render this entry
        return useSession(function (snap) {
          var includeTools = settings.includeTools
          var includeCommands = settings.includeCommands
            var order = snap.chat && snap.chat.order ? snap.chat.order : []
            var nodes = snap.chat && snap.chat.nodes ? snap.chat.nodes : null
            var out = []
            if (!nodes) return ''
            for (var i = 0; i < order.length; i++) {
              var n = nodes.get(order[i])
              if (!n) continue
              if (n.kind === 'assistant-step') {
                var d = n.data
                if (d && (d.status === 'settled' || d.status === 'interrupted')) out.push(n.key)
              } else if (includeTools && n.kind === 'tool-call') {
                var r = n.data
                if (r && r.root && r.root.kind === 'tool-result') out.push(n.key)
              } else if (includeCommands && (n.kind === 'command' || n.kind === 'command-input')) {
                out.push(n.key)
              }
            }
            return out.join('\u0001')
        })
      }

      function PaceBar(props) {
        var useSession = props.useSession
        if (!useSession) return null
        var s = useSettingValue()
        useEngineStatus()
        var rootRef = useRef(null)
        var menuOpen = useState(false)
        var setMenuOpen = menuOpen[1]
        var open = menuOpen[0]

        var sectionSig = selectSectionKeys(useSession)
        var sections = useMemo(function () {
          return sectionSig.length ? sectionSig.split('\u0001') : []
        }, [sectionSig])
        var running = useSession(function (snap) { return !!snap.running })
        var lastNodeInfo = useSession(function (snap) {
          var order = snap.chat && snap.chat.order ? snap.chat.order : []
          if (order.length === 0) return ':'
          var k = order[order.length - 1]
          var n = snap.chat && snap.chat.nodes ? snap.chat.nodes.get(k) : undefined
          var status = (n && n.kind === 'assistant-step' && n.data && n.data.status) ? n.data.status : ''
          return k + ':' + (n ? n.kind : '') + ':' + status
        })
        var seenLastInfo = useRef(null)

        useEffect(function () { setSections(sections) }, [sections])
        useEffect(function () { setRunning(running) }, [running])
        useEffect(function () {
          var i2 = lastNodeInfo.lastIndexOf(':')
          var status = lastNodeInfo.slice(i2 + 1)
          var i1 = lastNodeInfo.lastIndexOf(':', i2 - 1)
          var kind = lastNodeInfo.slice(i1 + 1, i2)
          setTipText(kind === 'assistant-step' && status === 'running')
          if (seenLastInfo.current === null) {
            // first observation (mount / session switch): an old user node at
            // the tip is not a fresh send
            seenLastInfo.current = lastNodeInfo
            return
          }
          if (seenLastInfo.current !== lastNodeInfo) {
            seenLastInfo.current = lastNodeInfo
            if (kind === 'user' || kind === 'steering') noteUserSend()
          }
        }, [lastNodeInfo])
        useEffect(function () { setSessionId(props.sessionId || null) }, [props.sessionId])
        useEffect(function () {
          var root = rootRef.current
          if (!root) return undefined
          var el = root.closest('[data-conversation-scroll]')
          if (!el || !el.isConnected) el = document.querySelector('[data-conversation-scroll]')
          if (!el) return undefined
          attach(el)
          return function () { detach() }
        }, [])

        var mode = modeById(s.mode)
        var canPause = s.mode === 'smooth' || s.mode === 'paced'
        var paused = engine.userPaused
        return createElement('div', { ref: rootRef, className: 'dsh-cp-bar' },
          createElement('button', {
            type: 'button',
            className: 'dsh-cp-btn' + (canPause && paused ? ' dsh-cp-btn-on' : ''),
            disabled: !canPause,
            title: canPause ? (paused ? 'Resume auto-scroll (' + (s.keys.toggle || 'unbound') + ')' : 'Pause auto-scroll (' + (s.keys.toggle || 'unbound') + ')') : 'Pause applies to Smooth and Paced modes',
            'aria-label': 'Pause or resume chat auto-scroll',
            onClick: function () { togglePause() }
          }, canPause ? (paused ? '\u25b6' : '\u23f8') : '\u23f8'),
          createElement('button', {
            type: 'button',
            className: 'dsh-cp-btn',
            title: 'Next output section (' + (s.keys.next || 'unbound') + ')',
            'aria-label': 'Scroll to the next output section',
            onClick: function () { stepNext() }
          }, '\u23ed'),
          createElement('span', { className: 'dsh-cp-wrap' },
            createElement('button', {
              type: 'button',
              className: 'dsh-cp-btn dsh-cp-modebtn',
              title: 'Chat scroll mode: ' + mode.name + ' \u2014 click to change',
              'aria-haspopup': 'menu',
              'aria-expanded': open ? 'true' : 'false',
              onClick: function () { setMenuOpen(!open) }
            }, mode.icon + ' ' + mode.name),
            open ? createElement(ModeMenu, { up: true, onClose: function () { setMenuOpen(false) } }) : null)
        )
      }

      // ------------------------------------------------------------------
      // Entry: conversation.composer.dock — ambient status readout
      // ------------------------------------------------------------------

      function PaceStatus() {
        var s = useSettingValue()
        useEngineStatus()
        var tick = useState(0)
        var setTick = tick[1]
        var reading = engine.phase === 'read'
        useEffect(function () {
          if (!reading) return undefined
          var iv = setInterval(function () { setTick(function (x) { return x + 1 }) }, 250)
          return function () { clearInterval(iv) }
        }, [reading])
        var bar = null
        if (reading && engine.readTotalMs > 0) {
          var left = Math.max(0, engine.readUntil - now())
          var pct = Math.max(0, Math.min(100, Math.round(100 * (1 - left / engine.readTotalMs))))
          bar = createElement('span', { className: 'dsh-cp-prog' },
            createElement('span', { className: 'dsh-cp-progfill', style: { width: pct + '%' } }))
        }
        return createElement('div', { className: 'dsh-cp-status' },
          createElement('span', { className: 'dsh-cp-statustxt' }, statusText()),
          bar)
      }

      // ------------------------------------------------------------------
      // Entry: conversation.session.header.actions — mode menu button
      // ------------------------------------------------------------------

      function PaceHeader(props) {
        var s = useSettingValue()
        useEngineStatus()
        var open = useState(false)
        var setOpen = open[1]
        var mode = modeById(s.mode)
        return createElement('span', { className: 'dsh-cp-header' },
          createElement('button', {
            type: 'button',
            className: 'dsh-cp-hbtn',
            'aria-haspopup': 'menu',
            'aria-expanded': open[0] ? 'true' : 'false',
            title: 'Chat scroll pace: ' + mode.name,
            onClick: function () { setOpen(!open[0]) }
          }, mode.icon + ' Pace \u00b7 ' + mode.name),
          open[0] ? createElement(ModeMenu, { up: false, onClose: function () { setOpen(false) } }) : null)
      }

      // ------------------------------------------------------------------
      // Entry: settings.section — the Chat Pace settings page
      // ------------------------------------------------------------------

      function KeyRow(props) {
        var action = props.action
        var s = useSettingValue()
        var rec = useState(false)
        var setRec = rec[1]
        var recording = rec[0]
        var conflict = ''
        if (s.keys[action.id]) {
          for (var i = 0; i < KEY_ACTIONS.length; i++) {
            var other = KEY_ACTIONS[i]
            if (other.id !== action.id && s.keys[other.id] && s.keys[other.id] === s.keys[action.id]) {
              conflict = 'Also bound to: ' + other.label
              break
            }
          }
        }
        useEffect(function () {
          if (!recording) return undefined
          function onKey(e) {
            e.preventDefault()
            e.stopPropagation()
            if (e.key === 'Escape') { setRec(false); return }
            if (e.key === 'Backspace') {
              var patch = {}
              patch[action.id] = ''
              updateSettings({ keys: patch })
              setRec(false)
              return
            }
            var c = comboOf(e)
            if (c === null) return
            var patch2 = {}
            patch2[action.id] = c
            updateSettings({ keys: patch2 })
            setRec(false)
          }
          document.addEventListener('keydown', onKey, true)
          return function () { document.removeEventListener('keydown', onKey, true) }
        }, [recording])
        return createElement('div', { className: 'dsh-cp-keyrow' },
          createElement('span', { className: 'dsh-cp-keylabel' }, action.label),
          createElement('span', { className: 'dsh-cp-keycombo' + (conflict ? ' dsh-cp-keyconflict' : '') },
            conflict ? s.keys[action.id] + ' \u26a0' : (s.keys[action.id] || 'not set')),
          createElement('button', {
            type: 'button',
            className: 'dsh-cp-keybtn' + (recording ? ' dsh-cp-keybtn-rec' : ''),
            onClick: function () { setRec(!recording) }
          }, recording ? 'press keys\u2026 (Esc cancels, Backspace clears)' : (s.keys[action.id] ? 'rebind' : 'bind')),
          conflict ? createElement('span', { className: 'dsh-cp-keywarn' }, conflict) : null)
      }

      function ToggleRow(props) {
        var label = props.label
        var hint = props.hint
        var value = props.value
        var onToggle = props.onToggle
        var id = props.id
        var disabled = props.disabled === true
        return createElement('label', { className: 'dsh-cp-tog', htmlFor: id },
          createElement('input', { id: id, type: 'checkbox', checked: value, disabled: disabled, onChange: onToggle }),
          createElement('span', { className: 'dsh-cp-togtext' },
            createElement('span', { className: 'dsh-cp-toglabel' }, label),
            hint ? createElement('span', { className: 'dsh-cp-toghint' }, hint) : null))
      }

      function SliderRow(props) {
        var label = props.label
        var hint = props.hint
        var value = props.value
        var min = props.min
        var max = props.max
        var step = props.step
        var fmt = props.fmt
        var onInput = props.onInput
        var id = props.id
        return createElement('div', { className: 'dsh-cp-slider' },
          createElement('label', { className: 'dsh-cp-sliderhead', htmlFor: id },
            createElement('span', { className: 'dsh-cp-toglabel' }, label),
            createElement('span', { className: 'dsh-cp-sliderval' }, fmt(value))),
          createElement('input', { id: id, type: 'range', min: min, max: max, step: step, value: value, onChange: onInput }),
          hint ? createElement('div', { className: 'dsh-cp-toghint' }, hint) : null)
      }

      function PaceSettings() {
        var s = useSettingValue()
        useEngineStatus()
        var set = function (patch) { updateSettings(patch) }
        var modeRows = MODES.map(function (m) {
          var selected = s.mode === m.id
          return createElement('button', {
            key: m.id,
            type: 'button',
            className: 'dsh-cp-modecard' + (selected ? ' dsh-cp-modecard-on' : ''),
            'aria-pressed': selected ? 'true' : 'false',
            onClick: function () { setMode(m.id) }
          },
            createElement('span', { className: 'dsh-cp-modecard-head' },
              createElement('span', { className: 'dsh-cp-micon' }, m.icon),
              createElement('span', { className: 'dsh-cp-mname' }, m.name),
              selected ? createElement('span', { className: 'dsh-cp-modecard-on-mark' }, 'active') : null),
            createElement('span', { className: 'dsh-cp-mhint' }, m.hint))
        })
        return createElement('div', { className: 'dsh-cp-settings' },
          createElement('div', { className: 'dsh-cp-setstatus' },
            createElement('span', { className: 'dsh-cp-statustxt' }, statusText())),
          createElement('h2', { className: 'dsh-cp-h2' }, 'Scroll mode'),
          createElement('div', { className: 'dsh-cp-modecards', role: 'radiogroup' }, modeRows),
          createElement('h2', { className: 'dsh-cp-h2' }, 'Speed \u00b7 Smooth and Paced travel'),
          createElement(SliderRow, {
            id: 'dsh-cp-speed', label: 'Glide speed', min: 20, max: 600, step: 10,
            value: s.speedPxs,
            fmt: function (v) { return Math.round(v) + ' px/s' },
            onInput: function (e) { set({ speedPxs: Number(e.target.value) }) },
            hint: 'How fast the view glides while catching up to new output or moving between sections.'
          }),
          createElement('h2', { className: 'dsh-cp-h2' }, 'Reading pace \u00b7 Paced pauses'),
          createElement(SliderRow, {
            id: 'dsh-cp-read', label: 'Seconds per screen of content', min: 0.5, max: 120, step: 0.5,
            value: s.secsPerViewport,
            fmt: function (v) { return (Math.round(v * 10) / 10) + ' s / screen' },
            onInput: function (e) { set({ secsPerViewport: Number(e.target.value) }) },
            hint: 'Pause time is the section\u2019s height divided by one screen, times this number \u2014 set it to how long you actually need to read a screenful.'
          }),
          createElement(SliderRow, {
            id: 'dsh-cp-minp', label: 'Minimum pause', min: 0, max: 5000, step: 50,
            value: s.minPauseMs,
            fmt: function (v) { return Math.round(v) + ' ms' },
            onInput: function (e) { set({ minPauseMs: Number(e.target.value) }) },
            hint: 'Even tiny sections pause at least this long.'
          }),
          createElement(SliderRow, {
            id: 'dsh-cp-maxp', label: 'Maximum pause', min: 1000, max: 80000, step: 500,
            value: s.maxPauseMs,
            fmt: function (v) { return (Math.round(v) / 1000) + ' s' },
            onInput: function (e) { set({ maxPauseMs: Number(e.target.value) }) },
            hint: 'No section, however huge, pauses longer than this \u2014 up to 80 seconds. (Sections taller than the screen spend the pause drifting through them instead of sitting still.)'
          }),
          createElement('h2', { className: 'dsh-cp-h2' }, 'What counts as an \u201coutput section\u201d'),
          createElement('div', { className: 'dsh-cp-togs' },
            createElement(ToggleRow, {
              id: 'dsh-cp-t-asst', label: 'Agent messages', hint: 'Each finished assistant output between tool calls. Always on \u2014 these are the primary outputs.',
              value: true, disabled: true, onToggle: function () {}
            }),
            createElement(ToggleRow, {
              id: 'dsh-cp-t-tool', label: 'Tool results', hint: 'Settled tool-call cards also count as sections in Paced and Step modes.',
              value: s.includeTools, onToggle: function (e) { set({ includeTools: e.target.checked }) }
            }),
            createElement(ToggleRow, {
              id: 'dsh-cp-t-cmd', label: 'Commands and notices', hint: 'Slash-command rows and system notices also count as sections.',
              value: s.includeCommands, onToggle: function (e) { set({ includeCommands: e.target.checked }) }
            })),
          createElement('h2', { className: 'dsh-cp-h2' }, 'Behavior'),
          createElement('div', { className: 'dsh-cp-togs' },
            createElement(ToggleRow, {
              id: 'dsh-cp-t-send', label: 'Jump when I send a message', hint: 'Your own messages (and steering notes) take the view to the bottom, like the shipped UI.',
              value: s.jumpOnSend, onToggle: function (e) { set({ jumpOnSend: e.target.checked }) }
            }),
            createElement(ToggleRow, {
              id: 'dsh-cp-t-rel', label: 'My scrolling pauses auto-scroll', hint: 'Wheel, touch, or key scrolling takes control away from Smooth/Paced until you resume.',
              value: s.releaseOnUserScroll, onToggle: function (e) { set({ releaseOnUserScroll: e.target.checked }) }
            }),
            createElement(ToggleRow, {
              id: 'dsh-cp-t-res', label: 'Resume when I return to the bottom', hint: 'After a reader-scroll pause, scrolling back to the very bottom resumes auto-scroll automatically.',
              value: s.resumeAtBottom, onToggle: function (e) { set({ resumeAtBottom: e.target.checked }) }
            }),
            createElement(ToggleRow, {
              id: 'dsh-cp-t-stepsm', label: 'Animate section jumps', hint: 'Next/previous section moves glide instead of teleporting.',
              value: s.stepSmooth, onToggle: function (e) { set({ stepSmooth: e.target.checked }) }
            })),
          createElement('h2', { className: 'dsh-cp-h2' }, 'When a session opens'),
          createElement('div', { className: 'dsh-cp-openpos', role: 'radiogroup', 'aria-label': 'Session open position' },
            OPEN_POS.map(function (o) {
              var on = s.openPosition === o.id
              return createElement('button', {
                key: o.id,
                type: 'button',
                role: 'radio',
                'aria-checked': on ? 'true' : 'false',
                className: 'dsh-cp-segbtn' + (on ? ' dsh-cp-segbtn-on' : ''),
                title: o.hint,
                onClick: function () { if (!on) set({ openPosition: o.id }) }
              }, o.label)
            })),
          createElement('p', { className: 'dsh-cp-toghint' }, 'Every conversation remembers where you left it regardless of this setting, so switching to \u201cWhere I left it\u201d later still restores each one.'),
          createElement('h2', { className: 'dsh-cp-h2' }, 'Keyboard shortcuts'),
          createElement('div', { className: 'dsh-cp-keys' },
            KEY_ACTIONS.map(function (a) { return createElement(KeyRow, { key: a.id, action: a }) })),
          createElement('h2', { className: 'dsh-cp-h2' }, 'Maintenance'),
          createElement('div', { className: 'dsh-cp-maint' },
            createElement('button', {
              type: 'button', className: 'dsh-cp-keybtn',
              onClick: function () {
                updateSettings(defaultSettings())
                stopCruise()
                engine.userPaused = false
                engine.paceArmed = false
                notifyStatus()
              }
            }, 'Reset all Chat Pace settings'),
            createElement('span', { className: 'dsh-cp-toghint' }, 'Settings are saved in this browser (localStorage) and survive restarts. This plugin is installed in your DSH profile; remove its profile row to uninstall.'))
        )
      }

      // ------------------------------------------------------------------
      // Styles
      // ------------------------------------------------------------------

      var CSS = [
        '.dsh-cp-bar{align-items:center;gap:4px;display:flex}',
        '.dsh-cp-btn{color:var(--dsw-alias-label-secondary,#555);background:0 0;cursor:pointer;border:none;border-radius:8px;height:26px;min-width:26px;padding:0 5px;font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center}',
        '.dsh-cp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#222)}',
        '.dsh-cp-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#7c8cff);outline-offset:1px}',
        '.dsh-cp-btn:disabled{opacity:.4;cursor:default}',
        '.dsh-cp-btn-on{color:var(--dsw-alias-state-business-primary,#7c8cff)}',
        '.dsh-cp-modebtn{padding:0 8px;font-weight:500;white-space:nowrap}',
        '.dsh-cp-wrap{position:relative;display:inline-flex}',
        '.dsh-cp-menu{color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-tooltip-bg,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));box-shadow:var(--dsw-shadow-lv2,0 6px 24px rgba(0,0,0,.14));border-radius:12px;padding:6px;width:280px;position:absolute;right:0;z-index:60;display:flex;flex-direction:column;gap:2px}',
        '.dsh-cp-menu-up{bottom:calc(100% + 8px)}',
        '.dsh-cp-menu:not(.dsh-cp-menu-up){top:calc(100% + 8px)}',
        '.dsh-cp-mrow{width:100%;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;padding:6px 8px;display:flex;gap:8px;align-items:flex-start}',
        '.dsh-cp-mrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
        '.dsh-cp-mrow-on{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,#7c8cff)}',
        '.dsh-cp-micon{flex:none;width:18px;text-align:center}',
        '.dsh-cp-mtext{display:flex;flex-direction:column;gap:1px;min-width:0}',
        '.dsh-cp-mname{color:var(--dsw-alias-label-primary,#222);font-size:13px;font-weight:500;line-height:18px}',
        '.dsh-cp-mrow-on .dsh-cp-mname{color:var(--dsw-alias-state-business-primary,#7c8cff)}',
        '.dsh-cp-mhint{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:16px}',
        '.dsh-cp-mact{width:100%;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary,#555);padding:6px 8px;font-size:13px;line-height:18px}',
        '.dsh-cp-mact:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#222)}',
        '.dsh-cp-mact:disabled{opacity:.4;cursor:default}',
        '.dsh-cp-msep{height:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.08));margin:4px 6px}',
        '.dsh-cp-mtip{color:var(--dsw-alias-label-caption,#999);font-size:11px;padding:2px 8px 4px}',
        '.dsh-cp-status{align-items:center;gap:8px;justify-content:center;margin:2px auto 0;display:flex;min-height:16px}',
        '.dsh-cp-statustxt{color:var(--dsw-alias-label-caption,#999);font-size:12px;line-height:16px}',
        '.dsh-cp-prog{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));border-radius:99px;height:3px;overflow:hidden;width:110px;display:inline-block}',
        '.dsh-cp-progfill{background:var(--dsw-alias-state-business-primary,#7c8cff);height:100%;display:block}',
        '.dsh-cp-header{position:relative;display:inline-flex}',
        '.dsh-cp-hbtn{color:var(--dsw-alias-label-secondary,#555);background:0 0;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;padding:4px 10px;font-size:13px;line-height:18px;white-space:nowrap}',
        '.dsh-cp-hbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#222)}',
        '.dsh-cp-hbtn:focus-visible,.dsh-cp-keybtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#7c8cff);outline-offset:1px}',
        '.dsh-cp-settings{flex-direction:column;gap:6px;padding:8px 2px 24px;display:flex;max-width:640px}',
        '.dsh-cp-setstatus{color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));border-radius:10px;padding:8px 12px;font-size:13px}',
        '.dsh-cp-h2{color:var(--dsw-alias-label-primary,#222);font-size:14px;font-weight:600;margin:18px 0 4px}',
        '.dsh-cp-modecards{flex-direction:column;gap:6px;display:flex}',
        '.dsh-cp-modecard{text-align:left;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:12px;padding:10px 12px;flex-direction:column;gap:3px;display:flex}',
        '.dsh-cp-modecard:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}',
        '.dsh-cp-modecard-on{border-color:var(--dsw-alias-state-business-primary,#7c8cff);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,#7c8cff)}',
        '.dsh-cp-modecard-head{align-items:center;gap:8px;display:flex}',
        '.dsh-cp-modecard-on-mark{color:var(--dsw-alias-state-business-primary,#7c8cff);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));border-radius:99px;margin-left:auto;font-size:11px;padding:1px 8px}',
        '.dsh-cp-slider{flex-direction:column;gap:4px;padding:6px 0;display:flex}',
        '.dsh-cp-sliderhead{align-items:center;gap:10px;display:flex}',
        '.dsh-cp-sliderval{color:var(--dsw-alias-label-secondary,#555);font-variant-numeric:tabular-nums;font-size:12px;margin-left:auto}',
        '.dsh-cp-slider input[type=range]{accent-color:var(--dsw-alias-state-business-primary,#7c8cff);width:100%}',
        '.dsh-cp-togs{flex-direction:column;gap:10px;display:flex}',
        '.dsh-cp-openpos{align-items:center;gap:8px;display:flex;flex-wrap:wrap}',
        '.dsh-cp-segbtn{color:var(--dsw-alias-label-secondary,#555);background:0 0;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;padding:5px 12px;font-size:12px;line-height:16px;white-space:nowrap}',
        '.dsh-cp-segbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#222)}',
        '.dsh-cp-segbtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#7c8cff);outline-offset:1px}',
        '.dsh-cp-segbtn-on{border-color:var(--dsw-alias-state-business-primary,#7c8cff);color:var(--dsw-alias-state-business-primary,#7c8cff);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,#7c8cff);font-weight:600}',
        '.dsh-cp-tog{align-items:flex-start;gap:10px;cursor:pointer;display:flex}',
        '.dsh-cp-tog input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#7c8cff);margin-top:2px}',
        '.dsh-cp-tog input:disabled{opacity:.5}',
        '.dsh-cp-togtext{flex-direction:column;gap:2px;display:flex}',
        '.dsh-cp-toglabel{color:var(--dsw-alias-label-primary,#222);font-size:13px;font-weight:500;line-height:18px}',
        '.dsh-cp-toghint{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:16px}',
        '.dsh-cp-keys{flex-direction:column;gap:8px;display:flex}',
        '.dsh-cp-keyrow{align-items:center;gap:10px;display:flex;flex-wrap:wrap}',
        '.dsh-cp-keylabel{color:var(--dsw-alias-label-primary,#222);font-size:13px;min-width:220px}',
        '.dsh-cp-keycombo{color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));border-radius:6px;padding:2px 8px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;min-width:60px;text-align:center}',
        '.dsh-cp-keyconflict{color:var(--dsw-alias-state-error-primary,#d33)}',
        '.dsh-cp-keybtn{color:var(--dsw-alias-label-secondary,#555);background:0 0;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;padding:4px 10px;font-size:12px;line-height:16px;white-space:nowrap}',
        '.dsh-cp-keybtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#222)}',
        '.dsh-cp-keybtn-rec{color:var(--dsw-alias-state-business-primary,#7c8cff);border-color:var(--dsw-alias-state-business-primary,#7c8cff)}',
        '.dsh-cp-keywarn{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;width:100%}',
        '.dsh-cp-maint{align-items:center;gap:10px;flex-direction:column;display:flex}'
      ].join('\n')

      // ------------------------------------------------------------------
      // Plugin registration
      // ------------------------------------------------------------------

      exports.name = 'chat-pace'
      exports.inject = ['slots']
      exports.apply = function (ctx) {
        // minimal live diagnostic handle (read-only support surface)
        if (typeof window !== 'undefined') window.__chatPaceDebug = { engine: engine, getSettings: function () { return settings }, scrollLog: SCROLL_LOG }
        ctx.effect(function () {
          var styleEl = document.createElement('style')
          styleEl.dataset.dyn = 'chat-pace'
          styleEl.textContent = CSS
          document.head.appendChild(styleEl)
          return function () { styleEl.remove() }
        })
        ctx.effect(function () {
          document.addEventListener('keydown', onKeyDown, false)
          return function () { document.removeEventListener('keydown', onKeyDown, false) }
        })
        // persist the open-position anchor when the page goes away
        ctx.effect(function () {
          function onHide() { flushPosition() }
          window.addEventListener('pagehide', onHide)
          window.addEventListener('beforeunload', onHide)
          return function () {
            window.removeEventListener('pagehide', onHide)
            window.removeEventListener('beforeunload', onHide)
          }
        })
        var slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('conversation.input.left', function () {
          return slots.register(
            { name: 'conversation.input.left', id: 'chat-pace', order: 40, label: 'Chat pace controls' },
            PaceBar
          )
        })
        slots.inject('conversation.composer.dock', function () {
          return slots.register(
            { name: 'conversation.composer.dock', id: 'chat-pace', order: 30, label: 'Chat pace status' },
            PaceStatus
          )
        })
        slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            { name: 'conversation.session.header.actions', id: 'chat-pace', order: 60, label: 'Chat pace' },
            PaceHeader
          )
        })
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'chat-pace', order: 300, label: 'Chat Pace' },
            PaceSettings
          )
        })
      }
      return module.exports
    }
  })
})()