// Shared PWA lifecycle controller & IndexedDB one-shot handoff for pdfstage and /cast/.
// Classic script (non-module) so local file:// launches never hit ES-module CORS blocks.
(function (global) {
  "use strict";

  var APP_VERSION = "0.8.2";
  var HANDOFF_DB_NAME = "pdfstage-handoff";
  var HANDOFF_DB_VERSION = 1;
  var HANDOFF_STORE = "handoffs";
  var HANDOFF_SESSION_KEY = "pdfstage:handoffId";
  var HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;
  var DEFAULT_CHECK_INTERVAL_MS = 10 * 60 * 1000;

  var currentScript = typeof document !== "undefined" ? document.currentScript : null;
  var scriptBaseUrl = (function () {
    try {
      if (currentScript && currentScript.src) {
        return new URL("./", currentScript.src).href;
      }
      if (typeof location !== "undefined" && location.href) {
        return new URL("./", location.href).href;
      }
    } catch (e) {}
    return "./";
  })();

  function generateHandoffId() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (e) {}
    return "ho-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function setSessionHandoffId(id) {
    try {
      sessionStorage.setItem(HANDOFF_SESSION_KEY, id);
      return true;
    } catch (e) {
      return false;
    }
  }

  function takeSessionHandoffId() {
    try {
      var id = sessionStorage.getItem(HANDOFF_SESSION_KEY);
      if (id) sessionStorage.removeItem(HANDOFF_SESSION_KEY);
      return id || "";
    } catch (e) {
      return "";
    }
  }

  function clearSessionHandoffId() {
    try {
      sessionStorage.removeItem(HANDOFF_SESSION_KEY);
    } catch (e) {}
  }

  function openHandoffDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB nicht verfügbar"));
        return;
      }
      var req;
      try {
        req = indexedDB.open(HANDOFF_DB_NAME, HANDOFF_DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(HANDOFF_STORE)) {
          db.createObjectStore(HANDOFF_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB open fehlgeschlagen")); };
      req.onblocked = function () { reject(new Error("IndexedDB blockiert")); };
    });
  }

  function putRecordOnce(db, record) {
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = db.transaction(HANDOFF_STORE, "readwrite");
      } catch (err) {
        reject(err);
        return;
      }
      var settled = false;
      function fail(err) {
        if (settled) return;
        settled = true;
        reject(err || new Error("IndexedDB-Schreibfehler"));
      }
      tx.oncomplete = function () {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onerror = function () { fail(tx.error); };
      tx.onabort = function () { fail(tx.error || new Error("IndexedDB-Transaktion abgebrochen")); };

      try {
        var req = tx.objectStore(HANDOFF_STORE).put(record);
        req.onerror = function () { fail(req.error); };
      } catch (err) {
        try { tx.abort(); } catch (e) {}
        fail(err);
      }
    });
  }

  async function saveHandoff(record) {
    var db = await openHandoffDb();
    try {
      try {
        await putRecordOnce(db, record);
      } catch (err) {
        if (record && record.fileHandle && err && err.name === "DataCloneError") {
          var withoutHandle = Object.assign({}, record, { fileHandle: null });
          await putRecordOnce(db, withoutHandle);
        } else {
          throw err;
        }
      }
    } finally {
      try { db.close(); } catch (e) {}
    }
  }

  async function consumeHandoff(id) {
    if (!id) return null;
    var db = await openHandoffDb();
    try {
      return await new Promise(function (resolve, reject) {
        var record = null;
        var tx = db.transaction(HANDOFF_STORE, "readwrite");
        var store = tx.objectStore(HANDOFF_STORE);
        var req = store.get(id);
        req.onsuccess = function () {
          record = req.result || null;
          if (record) {
            try { store.delete(id); } catch (e) {}
          }
        };
        req.onerror = function () { reject(req.error || new Error("IndexedDB-Lesefehler")); };
        tx.oncomplete = function () { resolve(record); };
        tx.onerror = function () { reject(tx.error || new Error("IndexedDB-Transaktionsfehler")); };
        tx.onabort = function () { reject(tx.error || new Error("IndexedDB-Transaktion abgebrochen")); };
      });
    } finally {
      try { db.close(); } catch (e) {}
    }
  }

  async function cleanupStaleHandoffs(maxAgeMs) {
    var limit = typeof maxAgeMs === "number" && maxAgeMs >= 0 ? maxAgeMs : HANDOFF_MAX_AGE_MS;
    var cutoff = Date.now() - limit;
    var db = await openHandoffDb();
    try {
      return await new Promise(function (resolve) {
        var deleted = 0;
        var tx = db.transaction(HANDOFF_STORE, "readwrite");
        var store = tx.objectStore(HANDOFF_STORE);
        var req = store.openCursor();
        req.onsuccess = function () {
          var cursor = req.result;
          if (!cursor) return;
          var val = cursor.value;
          if (!val || typeof val.createdAt !== "number" || val.createdAt < cutoff) {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        };
        tx.oncomplete = function () { resolve(deleted); };
        tx.onerror = function () { resolve(deleted); };
        tx.onabort = function () { resolve(deleted); };
      });
    } finally {
      try { db.close(); } catch (e) {}
    }
  }

  function initPwa(options) {
    var opts = options || {};
    var resolvedSwUrl = opts.swUrl || new URL("sw.js", scriptBaseUrl).href;
    var resolvedScope = opts.scope || scriptBaseUrl;
    var checkIntervalMs = typeof opts.updateCheckIntervalMs === "number"
      ? opts.updateCheckIntervalMs
      : DEFAULT_CHECK_INTERVAL_MS;

    var registration = null;
    var isManualUpdate = false;
    var hasReloaded = false;
    var updateInProgress = false;
    var pendingBackgroundActivation = false;
    var updateAvailable = false;
    var lastUpdateCheckAt = 0;
    var supported = typeof location !== "undefined" &&
      location.protocol !== "file:" &&
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator;
    var hadController = supported ? Boolean(navigator.serviceWorker.controller) : false;

    function getState() {
      return {
        supported: supported,
        hadController: hadController,
        hasRegistration: Boolean(registration),
        hasWaiting: Boolean(registration && registration.waiting),
        controllerScript: supported && navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : "",
        updateAvailable: updateAvailable,
        updateInProgress: updateInProgress,
        isManualUpdate: isManualUpdate,
        pendingBackgroundActivation: pendingBackgroundActivation
      };
    }

    function notifyUpdateAvailable() {
      if (updateAvailable) return;
      updateAvailable = true;
      if (typeof opts.onUpdateAvailable === "function") {
        opts.onUpdateAvailable(getState());
      }
    }

    function notifyBusy(busy) {
      if (typeof opts.onBusyChange === "function") {
        opts.onBusyChange(Boolean(busy));
      }
    }

    function bindRegistration(reg) {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) {
        notifyUpdateAvailable();
      }
      reg.addEventListener("updatefound", function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", function () {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            notifyUpdateAvailable();
          }
        });
      });
    }

    async function checkForUpdate(force) {
      if (!supported || !registration) return false;
      var now = Date.now();
      if (!force && now - lastUpdateCheckAt < checkIntervalMs) return false;
      lastUpdateCheckAt = now;
      try {
        await registration.update();
        if (registration.waiting && navigator.serviceWorker.controller) {
          notifyUpdateAvailable();
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    function doReload() {
      if (hasReloaded) return;
      hasReloaded = true;
      window.location.reload();
    }

    async function triggerUpdate() {
      if (!supported || updateInProgress) return false;
      updateInProgress = true;
      notifyBusy(true);

      var waiting = registration && registration.waiting;
      if (!waiting && !pendingBackgroundActivation && registration) {
        try { await registration.update(); } catch (e) {}
        waiting = registration.waiting;
      }

      if (!waiting && !pendingBackgroundActivation) {
        updateInProgress = false;
        updateAvailable = false;
        notifyBusy(false);
        if (typeof opts.onUpdateUnavailable === "function") {
          opts.onUpdateUnavailable();
        }
        return false;
      }

      if (typeof opts.onBeforeReload === "function") {
        try {
          var proceed = await opts.onBeforeReload();
          if (proceed === false) {
            updateInProgress = false;
            notifyBusy(false);
            return false;
          }
        } catch (err) {
          updateInProgress = false;
          notifyBusy(false);
          if (typeof opts.onError === "function") {
            opts.onError(err);
          }
          return false;
        }
      }

      isManualUpdate = true;

      if (waiting) {
        waiting.postMessage({ type: "SKIP_WAITING" });
        // Safety fallback if controllerchange fired subtly or waiting already transitioned to activated.
        setTimeout(function () {
          if (hasReloaded) return;
          if (waiting.state === "activated" || pendingBackgroundActivation) {
            doReload();
          } else if (waiting.state === "redundant") {
            updateInProgress = false;
            isManualUpdate = false;
            notifyBusy(false);
          }
        }, 3500);
        return true;
      }

      if (pendingBackgroundActivation) {
        doReload();
        return true;
      }

      updateInProgress = false;
      isManualUpdate = false;
      notifyBusy(false);
      return false;
    }

    if (supported) {
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (isManualUpdate) {
          doReload();
          return;
        }
        if (!hadController) {
          // Initial installation claim on first visit — not an update.
          hadController = true;
          return;
        }
        // Another tab triggered SKIP_WAITING: keep playing undisturbed until user clicks Update in this tab.
        pendingBackgroundActivation = true;
        notifyUpdateAvailable();
      });

      var startRegister = function () {
        navigator.serviceWorker.register(resolvedSwUrl, {
          scope: resolvedScope,
          updateViaCache: "none"
        }).then(function (reg) {
          lastUpdateCheckAt = Date.now();
          bindRegistration(reg);
        }).catch(function () {});
      };

      if (document.readyState === "complete") {
        startRegister();
      } else {
        window.addEventListener("load", startRegister, { once: true });
      }

      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") checkForUpdate(false);
      });
      window.addEventListener("online", function () {
        checkForUpdate(false);
      });
    }

    return {
      triggerUpdate: triggerUpdate,
      checkForUpdate: checkForUpdate,
      getState: getState,
      getRegistration: function () { return registration; }
    };
  }

  function renderVersionBadges() {
    if (typeof document === "undefined") return;
    var els = document.querySelectorAll("[data-app-version]");
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = "v" + APP_VERSION;
    }
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", renderVersionBadges, { once: true });
    } else {
      renderVersionBadges();
    }
  }

  global.pdfstagePwa = {
    APP_VERSION: APP_VERSION,
    HANDOFF_DB_NAME: HANDOFF_DB_NAME,
    HANDOFF_STORE: HANDOFF_STORE,
    HANDOFF_SESSION_KEY: HANDOFF_SESSION_KEY,
    HANDOFF_MAX_AGE_MS: HANDOFF_MAX_AGE_MS,
    generateHandoffId: generateHandoffId,
    setSessionHandoffId: setSessionHandoffId,
    takeSessionHandoffId: takeSessionHandoffId,
    clearSessionHandoffId: clearSessionHandoffId,
    saveHandoff: saveHandoff,
    consumeHandoff: consumeHandoff,
    cleanupStaleHandoffs: cleanupStaleHandoffs,
    initPwa: initPwa
  };
})(typeof window !== "undefined" ? window : globalThis);
