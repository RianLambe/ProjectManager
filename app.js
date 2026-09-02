import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  setDoc,
  enableIndexedDbPersistence,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  getDocs,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

(function () {
  "use strict";

  var board = document.getElementById("board");
  var emptyState = document.getElementById("emptyState");
  var syncStatusEl = document.getElementById("syncStatus");
  var projectNameEl = document.getElementById("projectName");
  var hamburgerBtn = document.getElementById("projectMenuBtn");
  var projectMenu = document.getElementById("projectMenu");
  var projectMenuList = document.getElementById("projectMenuList");
  var addProjectBtn = document.getElementById("addProjectBtn");
  var timelineBtn = document.getElementById("timelineBtn");
  var priorityBtn = document.getElementById("priorityBtn");
  var unblockedBtn = document.getElementById("unblockedBtn");
  var lockedBtn = document.getElementById("lockedBtn");

  var state = normalizeState(null);
  var focusRequest = null; // id of a node to focus+select after next render
  var dragId = null; // id of node currently being dragged
  var detailsId = null; // id of the node currently open in the details panel
  var pendingNewId = null; // id of a just-created, not-yet-named node/tree - discarded if left empty
  var renameOriginalId = null; // id of the node currently being renamed
  var renameOriginalText = null; // its text when editing started, restored on Escape
  var caretClickTimer = null; // used to tell a single click on a caret apart from a double click
  var nodeClickTimer = null; // used to tell a single click on a task apart from a double click

  var ICONS = {
    caret: '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 7h16M9 7V4h6v3M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    menu: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 2l2.9 6.26 6.9.6-5.2 4.53 1.58 6.77L12 16.9l-6.18 3.26L7.4 13.4 2.2 8.86l6.9-.6L12 2z" fill="currentColor"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="12" height="12"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 018 0v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };

  hamburgerBtn.innerHTML = ICONS.menu;
  timelineBtn.innerHTML = ICONS.clock;

  // ---------- persistence (Firestore, live across devices) ----------

  var boardDocRef = null;
  var historyCollectionRef = null;
  var saveTimer = null;
  var pendingRemoteState = null; // a remote update that arrived while the user was mid-edit
  var hasPendingWrite = false; // true from the moment a local change happens until it's confirmed saved

  // ---------- timeline (version history) ----------

  var CHECKPOINT_INTERVAL_MS = 3 * 60 * 1000; // min gap between automatic checkpoints
  var MAX_HISTORY_ENTRIES = 40;
  var historyBaselineSet = false; // becomes true once we've loaded real data to diff against
  var lastCheckpointState = null; // full state as of the last checkpoint
  var lastCheckpointTime = 0;

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // Flattens every project's boards/tasks into id -> {name, completed, parentId, kind}
  // so two states can be diffed by id regardless of where a node moved to.
  function flattenState(s) {
    var map = {};
    (s.projects || []).forEach(function (project) {
      (project.trees || []).forEach(function (tree) {
        walk(tree, null, "board");
      });
    });
    return map;

    function walk(node, parentId, kind) {
      map[node.id] = { name: node.name, completed: !!node.completed, parentId: parentId, kind: kind };
      (node.children || []).forEach(function (child) {
        walk(child, node.id, "task");
      });
    }
  }

  function pathFor(map, id) {
    var names = [];
    var cur = map[id];
    var p = cur ? cur.parentId : null;
    while (p) {
      var pn = map[p];
      if (!pn) break;
      names.unshift(pn.name);
      p = pn.parentId;
    }
    return names;
  }

  function isDescendantOfSet(map, id, idSet) {
    var p = map[id] ? map[id].parentId : null;
    while (p) {
      if (idSet[p]) return true;
      p = map[p] ? map[p].parentId : null;
    }
    return false;
  }

  // Compares two full board states and summarizes what changed: items added,
  // items removed, and completion toggles. When a whole branch was added or
  // removed, only its top-most node is reported (its descendants are implied).
  function diffStates(oldState, newState) {
    var oldMap = flattenState(oldState);
    var newMap = flattenState(newState);

    var addedSet = {};
    Object.keys(newMap).forEach(function (id) { if (!oldMap[id]) addedSet[id] = true; });
    var removedSet = {};
    Object.keys(oldMap).forEach(function (id) { if (!newMap[id]) removedSet[id] = true; });

    var added = [];
    Object.keys(addedSet).forEach(function (id) {
      if (isDescendantOfSet(newMap, id, addedSet)) return;
      added.push({ name: newMap[id].name, kind: newMap[id].kind, path: pathFor(newMap, id) });
    });

    var removed = [];
    Object.keys(removedSet).forEach(function (id) {
      if (isDescendantOfSet(oldMap, id, removedSet)) return;
      removed.push({ name: oldMap[id].name, kind: oldMap[id].kind, path: pathFor(oldMap, id) });
    });

    var checked = [], unchecked = [];
    Object.keys(newMap).forEach(function (id) {
      if (!oldMap[id]) return;
      if (oldMap[id].completed === newMap[id].completed) return;
      var item = { name: newMap[id].name, path: pathFor(newMap, id) };
      if (newMap[id].completed) checked.push(item); else unchecked.push(item);
    });

    return {
      added: added,
      removed: removed,
      checked: checked,
      unchecked: unchecked,
      hasChanges: added.length > 0 || removed.length > 0 || checked.length > 0 || unchecked.length > 0
    };
  }

  function addHistoryEntry(timestamp, snapshotState, summary) {
    if (!historyCollectionRef) return;
    addDoc(historyCollectionRef, { timestamp: timestamp, state: snapshotState, summary: summary })
      .then(pruneHistory)
      .catch(function (err) { console.error("History checkpoint failed", err); });
  }

  function pruneHistory() {
    var q = query(historyCollectionRef, orderBy("timestamp", "desc"), limit(200));
    getDocs(q).then(function (snap) {
      if (snap.docs.length <= MAX_HISTORY_ENTRIES) return;
      snap.docs.slice(MAX_HISTORY_ENTRIES).forEach(function (d) {
        deleteDoc(d.ref).catch(function () {});
      });
    }).catch(function () {});
  }

  // Called after every render. Throttled to at most one checkpoint per
  // CHECKPOINT_INTERVAL_MS, and only writes an entry when something actually
  // changed since the last one.
  function maybeCheckpoint() {
    if (!historyBaselineSet) return;
    var now = Date.now();
    if (now - lastCheckpointTime < CHECKPOINT_INTERVAL_MS) return;
    var diff = diffStates(lastCheckpointState, state);
    if (diff.hasChanges) {
      addHistoryEntry(now, deepClone(state), diff);
      lastCheckpointState = deepClone(state);
    }
    lastCheckpointTime = now;
  }

  function setSyncStatus(text, cls) {
    if (!syncStatusEl) return;
    syncStatusEl.textContent = text;
    syncStatusEl.className = "sync-status" + (cls ? " " + cls : "");
  }

  // True while the user has an editable text field focused - used to avoid
  // a live update from another device yanking focus out from under them.
  function isEditingText() {
    var active = document.activeElement;
    if (!active) return false;
    if (active.getAttribute && active.getAttribute("data-role") === "rename") return true;
    if (active.id === "detailsTitle" || active.id === "detailsNotes") return true;
    return false;
  }

  // Board data is grouped under projects: { projects: [{id, name, trees:[...]}], currentProjectId }.
  // Accepts the old flat { trees: [...] } shape too and wraps it in a default
  // project, so existing boards survive the upgrade to projects.
  function normalizeState(data) {
    if (data && Array.isArray(data.projects) && data.projects.length > 0) {
      var validId = data.currentProjectId && data.projects.some(function (p) { return p.id === data.currentProjectId; });
      return {
        projects: data.projects,
        currentProjectId: validId ? data.currentProjectId : data.projects[0].id
      };
    }
    if (data && Array.isArray(data.trees)) {
      var migrated = { id: uid(), name: "My Project", createdAt: Date.now(), trees: data.trees };
      return { projects: [migrated], currentProjectId: migrated.id };
    }
    var fresh = { id: uid(), name: "My Project", createdAt: Date.now(), trees: [] };
    return { projects: [fresh], currentProjectId: fresh.id };
  }

  function currentProject() {
    var found = state.projects.filter(function (p) { return p.id === state.currentProjectId; })[0];
    return found || state.projects[0];
  }

  function applyRemoteState(data) {
    state = normalizeState(data);
    if (!historyBaselineSet) {
      lastCheckpointState = deepClone(state);
      lastCheckpointTime = Date.now();
      historyBaselineSet = true;
    }
    render();
    if (detailsId) renderDetails();
  }

  // Call after any blur/commit so a remote update that arrived mid-edit gets applied.
  // Deferred to a fresh tick: a blur that's part of Enter-chaining (blur old
  // field -> commit -> create + focus the next field) leaves focus briefly
  // empty *within the same synchronous call*, which would otherwise look
  // "idle" here and let a stale pending update clobber the rename that was
  // just committed, right before the new field takes focus.
  function flushPendingRemoteIfIdle() {
    setTimeout(function () {
      if (pendingRemoteState && !isEditingText() && !hasPendingWrite) {
        var data = pendingRemoteState;
        pendingRemoteState = null;
        applyRemoteState(data);
      }
    }, 0);
  }

  function initFirebaseSync() {
    var app = initializeApp(firebaseConfig);
    var auth = getAuth(app);
    var db = getFirestore(app);
    boardDocRef = doc(db, "boards", "main");
    historyCollectionRef = collection(db, "boards", "main", "history");

    enableIndexedDbPersistence(db).catch(function () {
      // fails silently in unsupported browsers or with multiple tabs open;
      // the app still works, it just won't cache offline in that case
    });

    onAuthStateChanged(auth, function (user) {
      if (!user) return;
      onSnapshot(
        boardDocRef,
        function (snap) {
          if (!snap.exists()) {
            setDoc(boardDocRef, normalizeState(null));
            return;
          }
          var data = snap.data();
          if (isEditingText() || hasPendingWrite) {
            // don't clobber an edit that hasn't been saved yet - apply it
            // once the field is blurred (flushPendingRemoteIfIdle) or once
            // our own write confirms (saveState's callback)
            pendingRemoteState = data;
          } else {
            applyRemoteState(data);
          }
          setSyncStatus("Synced", "synced");
        },
        function (err) {
          console.error("Sync error", err);
          setSyncStatus("Sync error - working offline", "error");
        }
      );
    });

    signInAnonymously(auth).catch(function (err) {
      console.error("Sign-in failed", err);
      setSyncStatus("Offline (sign-in failed)", "error");
    });
  }

  function saveState() {
    hasPendingWrite = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (!boardDocRef) { hasPendingWrite = false; return; }
      setDoc(boardDocRef, state)
        .catch(function (err) {
          console.error("Save failed", err);
          setSyncStatus("Save failed - will retry", "error");
        })
        .finally(function () {
          hasPendingWrite = false;
          flushPendingRemoteIfIdle();
        });
    }, 400);
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  // ---------- tree helpers ----------

  function makeNode(name) {
    return {
      id: uid(),
      name: name || "",
      completed: false,
      collapsed: false,
      notes: "",
      priority: false,
      blockedBy: null,
      createdAt: Date.now(),
      children: []
    };
  }

  function computeProgress(node) {
    if (!node.children || node.children.length === 0) {
      return { done: node.completed ? 1 : 0, total: 1 };
    }
    var done = 0, total = 0;
    for (var i = 0; i < node.children.length; i++) {
      var p = computeProgress(node.children[i]);
      done += p.done;
      total += p.total;
    }
    return { done: done, total: total };
  }

  // A branch counts as "done" the same way it counts as 100% complete -
  // works for leaves (total 1) and branches (sums children) alike.
  function isNodeDone(node) {
    var p = computeProgress(node);
    return p.total > 0 && p.done === p.total;
  }

  // True while a task's declared blocker exists and isn't done yet. A
  // blocker that was deleted no longer blocks anything.
  function isBlocked(node) {
    if (!node.blockedBy) return false;
    var blocker = findNode(node.blockedBy);
    if (!blocker) return false;
    return !isNodeDone(blocker.node);
  }

  // Every board and task in a project, each with the ancestor names leading
  // to it - used for the "Blocked by" picker and the priority/unblocked
  // dashboard, where items from anywhere in the project need to be listed
  // with enough context to tell them apart.
  function flattenProjectNodes(project) {
    var out = [];
    project.trees.forEach(function (tree) { walk(tree, []); });
    return out;

    function walk(node, ancestors) {
      out.push({ id: node.id, name: node.name, node: node, path: ancestors });
      node.children.forEach(function (child) {
        walk(child, ancestors.concat([node.name]));
      });
    }
  }

  // Finds a project, board, or task by id.
  // Returns { node, siblings, index, tree } or null.
  function findNode(id) {
    for (var p = 0; p < state.projects.length; p++) {
      if (state.projects[p].id === id) {
        return { node: state.projects[p], siblings: state.projects, index: p, tree: null };
      }
    }
    var project = currentProject();
    if (!project) return null;
    for (var t = 0; t < project.trees.length; t++) {
      var tree = project.trees[t];
      if (tree.id === id) {
        return { node: tree, siblings: project.trees, index: t, tree: tree };
      }
      var res = findIn(tree.children, id, tree);
      if (res) return res;
    }
    return null;

    function findIn(list, targetId, owningTree) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === targetId) {
          return { node: list[i], siblings: list, index: i, tree: owningTree };
        }
        var deeper = findIn(list[i].children, targetId, owningTree);
        if (deeper) return deeper;
      }
      return null;
    }
  }

  function isDescendant(ancestor, targetId) {
    if (!ancestor.children) return false;
    for (var i = 0; i < ancestor.children.length; i++) {
      if (ancestor.children[i].id === targetId) return true;
      if (isDescendant(ancestor.children[i], targetId)) return true;
    }
    return false;
  }

  // ---------- mutations ----------

  function addTree() {
    var project = currentProject();
    if (!project) return;
    var tree = makeNode("New Board");
    project.trees.push(tree);
    focusRequest = tree.id;
    pendingNewId = tree.id;
    saveState();
    render();
  }

  function addProject() {
    var project = { id: uid(), name: "New Project", createdAt: Date.now(), trees: [] };
    state.projects.push(project);
    state.currentProjectId = project.id;
    focusRequest = project.id;
    pendingNewId = project.id;
    saveState();
    render();
    closeProjectMenu();
  }

  function switchProject(id) {
    closeProjectMenu();
    if (id === state.currentProjectId) return;
    var exists = state.projects.some(function (p) { return p.id === id; });
    if (!exists) return;
    state.currentProjectId = id;
    saveState();
    render();
  }

  function deleteProject(id) {
    if (state.projects.length <= 1) return;
    var proj = state.projects.filter(function (p) { return p.id === id; })[0];
    if (!proj) return;
    showConfirm('Delete project "' + proj.name + '" and everything in it?', function () {
      var idx = -1;
      for (var i = 0; i < state.projects.length; i++) {
        if (state.projects[i].id === id) { idx = i; break; }
      }
      if (idx === -1 || state.projects.length <= 1) return;
      state.projects.splice(idx, 1);
      if (state.currentProjectId === id) {
        state.currentProjectId = state.projects[0].id;
      }
      saveState();
      render();
      renderProjectMenu();
    });
  }

  function renderProjectMenu() {
    projectMenuList.innerHTML = "";
    state.projects.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "project-menu-row" + (p.id === state.currentProjectId ? " active" : "");

      if (state.projects.length > 1) {
        var delBtn = document.createElement("button");
        delBtn.className = "icon-btn danger project-menu-delete";
        delBtn.title = "Delete project";
        delBtn.innerHTML = ICONS.trash;
        delBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          deleteProject(p.id);
        });
        row.appendChild(delBtn);
      }

      var nameBtn = document.createElement("button");
      nameBtn.className = "project-menu-name";
      nameBtn.textContent = p.name;
      nameBtn.addEventListener("click", function () { switchProject(p.id); });
      row.appendChild(nameBtn);

      projectMenuList.appendChild(row);
    });
  }

  function openProjectMenu() {
    renderProjectMenu();
    projectMenu.hidden = false;
  }

  function closeProjectMenu() {
    projectMenu.hidden = true;
  }

  // Removes a node with no confirmation dialog - used to silently discard a
  // just-created, never-named node when the user backs out of creating it.
  function removeNodeSilently(id) {
    var found = findNode(id);
    if (!found) return;
    found.siblings.splice(found.index, 1);
    saveState();
    render();
  }

  // Flips each branch's own collapsed flag independently, rather than
  // forcing every descendant to match one new state - a branch that was
  // already expanded while its sibling was collapsed keeps that difference,
  // it just each flips to the opposite of whatever it currently was.
  function toggleCollapsedDeep(node) {
    node.collapsed = !node.collapsed;
    for (var i = 0; i < node.children.length; i++) {
      if (node.children[i].children.length > 0) toggleCollapsedDeep(node.children[i]);
    }
  }

  // Toggles every descendant's own collapsed flag, but leaves the clicked
  // branch's own state exactly as it was - only its children (and further
  // down) are affected.
  function toggleCollapseRecursive(id) {
    var found = findNode(id);
    if (!found) return;
    for (var i = 0; i < found.node.children.length; i++) {
      if (found.node.children[i].children.length > 0) toggleCollapsedDeep(found.node.children[i]);
    }
    saveState();
    render();
  }

  function deleteTree(id, onDeleted) {
    var found = findNode(id);
    if (!found) return;
    showConfirm('Delete board "' + found.node.name + '" and everything in it?', function () {
      var fresh = findNode(id);
      if (!fresh) return;
      fresh.siblings.splice(fresh.index, 1);
      saveState();
      render();
      if (onDeleted) onDeleted();
    });
  }

  function addChild(parentId, focusBoard, initialName) {
    if (focusBoard === undefined) focusBoard = true;
    var found = findNode(parentId);
    if (!found) return null;
    var child = makeNode(initialName !== undefined ? initialName : "New item");
    found.node.children.push(child);
    found.node.collapsed = false;
    if (focusBoard) {
      focusRequest = child.id;
      pendingNewId = child.id;
    }
    saveState();
    render();
    return child.id;
  }

  function addSiblingAfter(id) {
    var found = findNode(id);
    if (!found) return null;
    var sibling = makeNode("");
    found.siblings.splice(found.index + 1, 0, sibling);
    focusRequest = sibling.id;
    pendingNewId = sibling.id;
    saveState();
    render();
    return sibling.id;
  }

  function deleteNode(id, onDeleted) {
    var found = findNode(id);
    if (!found) return;
    var msg = found.node.children.length > 0
      ? 'Delete "' + found.node.name + '" and its ' + found.node.children.length + ' sub-item(s)?'
      : 'Delete "' + found.node.name + '"?';
    showConfirm(msg, function () {
      var fresh = findNode(id);
      if (!fresh) return;
      fresh.siblings.splice(fresh.index, 1);
      saveState();
      render();
      if (onDeleted) onDeleted();
    });
  }

  function toggleCollapse(id) {
    var found = findNode(id);
    if (!found) return;
    found.node.collapsed = !found.node.collapsed;
    saveState();
    render();
  }

  function toggleCompleted(id, value) {
    var found = findNode(id);
    if (!found) return;
    found.node.completed = value;
    saveState();
    render();
  }

  function togglePriority(id) {
    var found = findNode(id);
    if (!found) return;
    found.node.priority = !found.node.priority;
    saveState();
    render();
  }

  function setBlockedBy(id, blockerId) {
    var found = findNode(id);
    if (!found) return;
    found.node.blockedBy = blockerId || null;
    saveState();
    render();
  }

  function renameNode(id, newName) {
    var found = findNode(id);
    if (!found) return;
    var trimmed = (newName || "").trim();
    found.node.name = trimmed || "Untitled";
    saveState();
    // re-render not strictly needed for text, but keeps percentages/labels in sync
    render();
  }

  function setNotes(id, notes) {
    var found = findNode(id);
    if (!found) return;
    found.node.notes = notes || "";
    saveState();
  }

  // Returns an array of nodes from the root tree down to (and including) id, or [] if not found.
  function buildPath(id) {
    var project = currentProject();
    if (!project) return [];
    for (var t = 0; t < project.trees.length; t++) {
      var path = search(project.trees[t], id, [project.trees[t]]);
      if (path) return path;
    }
    return [];

    function search(node, targetId, acc) {
      if (node.id === targetId) return acc;
      for (var i = 0; i < node.children.length; i++) {
        var res = search(node.children[i], targetId, acc.concat([node.children[i]]));
        if (res) return res;
      }
      return null;
    }
  }

  function moveNode(sourceId, targetId, position) {
    if (sourceId === targetId) return;
    var src = findNode(sourceId);
    if (!src) return;
    // guard: can't move a node into its own subtree
    if (position === "into") {
      var tgt = findNode(targetId);
      if (!tgt) return;
      if (isDescendant(src.node, targetId)) return;
    } else {
      var tgt2 = findNode(targetId);
      if (!tgt2) return;
      if (targetId !== sourceId && isDescendant(src.node, targetId)) return;
    }

    // remove from old location
    src.siblings.splice(src.index, 1);

    if (position === "into") {
      var targetFound = findNode(targetId);
      targetFound.node.collapsed = false;
      targetFound.node.children.push(src.node);
    } else {
      var targetFound2 = findNode(targetId);
      var insertAt = targetFound2.index + (position === "after" ? 1 : 0);
      targetFound2.siblings.splice(insertAt, 0, src.node);
    }

    saveState();
    render();
  }

  function moveNodeToRootEnd(sourceId, treeId) {
    var src = findNode(sourceId);
    if (!src) return;
    if (src.node.id === treeId) return;
    var tree = currentProject().trees.filter(function (t) { return t.id === treeId; })[0];
    if (!tree) return;
    if (isDescendant(src.node, treeId)) return;
    src.siblings.splice(src.index, 1);
    tree.children.push(src.node);
    saveState();
    render();
  }

  // ---------- rendering ----------

  function render() {
    var project = currentProject();

    projectNameEl.textContent = project.name;
    projectNameEl.setAttribute("data-id", project.id);
    document.title = project.name;

    renderDashboard(project);

    board.innerHTML = "";
    emptyState.hidden = project.trees.length > 0;
    for (var i = 0; i < project.trees.length; i++) {
      board.appendChild(renderTreeCard(project.trees[i]));
    }
    if (focusRequest) {
      var toFocus = document.querySelector('[data-id="' + cssEscape(focusRequest) + '"] > .node-row > .node-main > .node-label-wrap > .node-name, [data-tree-id="' + cssEscape(focusRequest) + '"] .tree-name, #projectName[data-id="' + cssEscape(focusRequest) + '"]');
      if (toFocus) {
        toFocus.focus();
        selectAllText(toFocus);
      }
      focusRequest = null;
    }
    maybeCheckpoint();
  }

  // Priority = flagged and not done yet. Unblocked = actionable - not done,
  // not waiting on a blocker - which by default is every task, since a task
  // only counts as blocked once you've explicitly set one on it. Locked is
  // the opposite: not done, and still waiting on an unfinished blocker. All
  // three are scoped to individual tasks, not branch/board heads - a branch
  // is just a container, not something you "do".
  function computeDashItems(project, kind) {
    var flat = flattenProjectNodes(project).filter(function (item) {
      return item.node.children.length === 0;
    });
    if (kind === "priority") {
      return flat.filter(function (item) { return item.node.priority && !isNodeDone(item.node); });
    }
    if (kind === "locked") {
      return flat.filter(function (item) { return !isNodeDone(item.node) && isBlocked(item.node); });
    }
    return flat.filter(function (item) { return !isNodeDone(item.node) && !isBlocked(item.node); });
  }

  function renderDashboard(project) {
    priorityBtn.textContent = "Priority (" + computeDashItems(project, "priority").length + ")";
    unblockedBtn.textContent = "Unblocked (" + computeDashItems(project, "unblocked").length + ")";
    lockedBtn.textContent = "Locked (" + computeDashItems(project, "locked").length + ")";
  }

  function buildDashRow(item) {
    var row = document.createElement("div");
    row.className = "dash-row";

    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "leaf-checkbox";
    cb.checked = !!item.node.completed;
    cb.addEventListener("change", function () { toggleCompleted(item.id, cb.checked); });
    row.appendChild(cb);

    var nameBtn = document.createElement("button");
    nameBtn.className = "dash-row-name";
    if (item.path.length) {
      var pathSpan = document.createElement("span");
      pathSpan.className = "dash-row-path";
      pathSpan.textContent = item.path.join(" / ") + " / ";
      nameBtn.appendChild(pathSpan);
    }
    nameBtn.appendChild(document.createTextNode(item.name));
    nameBtn.addEventListener("click", function () { closeDashFull(); openDetails(item.id); });
    row.appendChild(nameBtn);

    return row;
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function selectAllText(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function pctColorClass(pct) {
    return pct >= 100 ? "complete" : "";
  }

  function hexToRgba(hex, alpha) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    if (!m) return null;
    var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  // Blends hex into baseHex at the given strength and returns a fully OPAQUE
  // color. Used (instead of a translucent rgba) for any fill that something
  // else - like the connector-line mask - may need to sit flush against or
  // stack on top of: two translucent layers of the "same" color still show a
  // seam where they overlap, because compositing them twice isn't the same
  // as compositing once. A solid color has no such seam.
  function blendHex(hex, alpha, baseHex) {
    var c = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    var base = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(baseHex || "");
    if (!c || !base) return null;
    var r = Math.round(parseInt(c[1], 16) * alpha + parseInt(base[1], 16) * (1 - alpha));
    var g = Math.round(parseInt(c[2], 16) * alpha + parseInt(base[2], 16) * (1 - alpha));
    var b = Math.round(parseInt(c[3], 16) * alpha + parseInt(base[3], 16) * (1 - alpha));
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  function renderTreeCard(tree) {
    var card = document.createElement("div");
    card.className = "tree-card";
    card.setAttribute("data-tree-id", tree.id);
    if (tree.color) {
      // set as a custom property (not the background shorthand directly) so
      // anything that needs to blend with the card - like the connector-line
      // mask that hides the trunk past the last item - can reference the same
      // color via var(--card-bg, ...) instead of drifting out of sync with it.
      // Solid (not translucent) so a mask sitting on top of the card's own
      // background doesn't double up into a visibly darker/more saturated patch.
      card.style.setProperty("--card-bg", blendHex(tree.color, 0.12, "#1c1f28"));
      card.style.borderColor = hexToRgba(tree.color, 0.4);
    }

    var header = document.createElement("div");
    header.className = "tree-card-header";
    if (tree.color) header.style.background = blendHex(tree.color, 0.28, "#22262f");

    var top = document.createElement("div");
    top.className = "tree-card-header-top";

    var nameSpan = document.createElement("span");
    nameSpan.className = "tree-name";
    nameSpan.contentEditable = "true";
    nameSpan.spellcheck = false;
    nameSpan.textContent = tree.name;
    nameSpan.setAttribute("data-id", tree.id);
    nameSpan.setAttribute("data-role", "rename");

    var colorBtn = document.createElement("button");
    colorBtn.className = "icon-btn color-swatch";
    colorBtn.title = "Set board color";
    colorBtn.setAttribute("data-id", tree.id);
    colorBtn.setAttribute("data-role", "pick-color");
    colorBtn.style.background = tree.color || "";

    var deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn danger";
    deleteBtn.title = "Delete board";
    deleteBtn.setAttribute("data-id", tree.id);
    deleteBtn.setAttribute("data-role", "delete-tree");
    deleteBtn.innerHTML = ICONS.trash;

    var headerCircle = document.createElement("span");
    headerCircle.className = "header-circle";
    top.appendChild(headerCircle);
    top.appendChild(nameSpan);
    if (tree.notes && tree.notes.trim()) {
      var treeNotesDot = document.createElement("span");
      treeNotesDot.className = "notes-dot";
      treeNotesDot.title = "Has notes";
      top.appendChild(treeNotesDot);
    }
    top.appendChild(colorBtn);
    top.appendChild(deleteBtn);
    header.appendChild(top);

    var progress = computeProgress(tree);
    var progWrap = document.createElement("div");
    progWrap.className = "tree-progress-wrap";
    if (progress.total > 0) {
      var pct = Math.round((progress.done / progress.total) * 100);
      progWrap.innerHTML =
        '<div class="board-progress">' +
          '<div class="progress-bar board-progress-bar"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>' +
          '<span class="progress-pct ' + pctColorClass(pct) + '">' + pct + '% (' + progress.done + '/' + progress.total + ')</span>' +
        '</div>';
    }
    header.appendChild(progWrap);
    card.appendChild(header);


    var body = document.createElement("div");
    body.className = "tree-body";
    body.setAttribute("data-role", "root-body");
    body.setAttribute("data-tree-id", tree.id);

    var list = renderNodeList(tree.children);
    list.classList.add("root-list");
    body.appendChild(list);

    var addBtn = document.createElement("button");
    addBtn.className = "btn btn-ghost";
    addBtn.style.marginTop = "6px";
    addBtn.style.width = "100%";
    addBtn.textContent = "+ Add item";
    addBtn.setAttribute("data-id", tree.id);
    addBtn.setAttribute("data-role", "add-child");
    body.appendChild(addBtn);

    card.appendChild(body);
    return card;
  }

  function renderNodeList(children) {
    var ul = document.createElement("ul");
    ul.className = "node-list";
    for (var i = 0; i < children.length; i++) {
      ul.appendChild(renderNode(children[i]));
    }
    return ul;
  }

  function renderNode(node) {
    var li = document.createElement("li");
    li.className = "node-item";
    li.setAttribute("data-id", node.id);

    var isLeaf = node.children.length === 0;
    if (isLeaf && node.completed) li.classList.add("completed");
    var blockerFound = node.blockedBy ? findNode(node.blockedBy) : null;
    var blocked = blockerFound ? !isNodeDone(blockerFound.node) : false;
    if (blocked) li.classList.add("blocked");

    var row = document.createElement("div");
    row.className = "node-row";
    row.setAttribute("draggable", "true");
    row.setAttribute("data-id", node.id);

    // marker: a leaf gets its checkbox, a branch gets its collapse toggle -
    // both share the same slot so they line up in one horizontal column
    if (isLeaf) {
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "leaf-checkbox";
      cb.checked = !!node.completed;
      cb.setAttribute("data-id", node.id);
      cb.setAttribute("data-role", "toggle-complete");
      row.appendChild(cb);
    } else {
      var caret = document.createElement("button");
      caret.className = "caret" + (node.collapsed ? " collapsed" : "");
      caret.setAttribute("data-id", node.id);
      caret.setAttribute("data-role", "toggle-collapse");
      caret.innerHTML = ICONS.caret;
      row.appendChild(caret);
    }

    var main = document.createElement("div");
    main.className = "node-main";

    var labelWrap = document.createElement("div");
    labelWrap.className = "node-label-wrap";

    var nameSpan = document.createElement("span");
    nameSpan.className = "node-name";
    nameSpan.contentEditable = "true";
    nameSpan.spellcheck = false;
    nameSpan.textContent = node.name;
    nameSpan.setAttribute("data-id", node.id);
    nameSpan.setAttribute("data-role", "rename");
    labelWrap.appendChild(nameSpan);

    var starBtn = document.createElement("button");
    starBtn.className = "icon-btn priority-star" + (node.priority ? " active" : "");
    starBtn.title = node.priority ? "Remove priority" : "Mark as priority";
    starBtn.innerHTML = ICONS.star;
    starBtn.setAttribute("data-id", node.id);
    starBtn.setAttribute("data-role", "toggle-priority");
    labelWrap.appendChild(starBtn);

    if (blocked) {
      var lockIcon = document.createElement("span");
      lockIcon.className = "blocked-lock";
      lockIcon.title = 'Blocked by "' + blockerFound.node.name + '"';
      lockIcon.innerHTML = ICONS.lock;
      labelWrap.appendChild(lockIcon);
    }

    if (node.notes && node.notes.trim()) {
      var notesDot = document.createElement("span");
      notesDot.className = "notes-dot";
      notesDot.title = "Has notes";
      labelWrap.appendChild(notesDot);
    }

    if (!isLeaf) {
      var progress = computeProgress(node);
      var pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      var progDiv = document.createElement("div");
      progDiv.className = "node-progress";
      progDiv.innerHTML =
        '<div class="progress-bar"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="progress-pct ' + pctColorClass(pct) + '">' + pct + '% (' + progress.done + '/' + progress.total + ')</span>';
      labelWrap.appendChild(progDiv);
    }

    main.appendChild(labelWrap);

    var actions = document.createElement("div");
    actions.className = "node-actions";

    var addBtn = document.createElement("button");
    addBtn.className = "icon-btn";
    addBtn.title = "Add sub-item";
    addBtn.innerHTML = ICONS.plus;
    addBtn.setAttribute("data-id", node.id);
    addBtn.setAttribute("data-role", "add-child");
    actions.appendChild(addBtn);

    var delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.title = "Delete";
    delBtn.innerHTML = ICONS.trash;
    delBtn.setAttribute("data-id", node.id);
    delBtn.setAttribute("data-role", "delete-node");
    actions.appendChild(delBtn);

    main.appendChild(actions);
    row.appendChild(main);
    li.appendChild(row);

    if (!isLeaf && !node.collapsed) {
      var filler = document.createElement("span");
      filler.className = "trunk-filler";
      li.appendChild(filler);
      li.appendChild(renderNodeList(node.children));
    }

    return li;
  }

  // ---------- event delegation ----------

  board.addEventListener("click", function (e) {
    var toggle = e.target.closest('[data-role="toggle-collapse"]');
    if (toggle) {
      var toggleId = toggle.getAttribute("data-id");
      if (e.shiftKey) {
        clearTimeout(caretClickTimer);
        toggleCollapseRecursive(toggleId);
      } else if (e.detail >= 2) {
        clearTimeout(caretClickTimer);
        toggleCollapseRecursive(toggleId);
      } else {
        // delay a plain single click briefly in case a second click follows,
        // so a double-click doesn't also fire (and flicker) a single toggle
        clearTimeout(caretClickTimer);
        caretClickTimer = setTimeout(function () { toggleCollapse(toggleId); }, 250);
      }
      return;
    }

    var starToggle = e.target.closest('[data-role="toggle-priority"]');
    if (starToggle) { togglePriority(starToggle.getAttribute("data-id")); return; }

    var addChildBtn = e.target.closest('[data-role="add-child"]');
    if (addChildBtn) { addChild(addChildBtn.getAttribute("data-id")); return; }

    var delNodeBtn = e.target.closest('[data-role="delete-node"]');
    if (delNodeBtn) { deleteNode(delNodeBtn.getAttribute("data-id")); return; }

    var delTreeBtn = e.target.closest('[data-role="delete-tree"]');
    if (delTreeBtn) { deleteTree(delTreeBtn.getAttribute("data-id")); return; }

    var colorBtn = e.target.closest('[data-role="pick-color"]');
    if (colorBtn) {
      var treeId = colorBtn.getAttribute("data-id");
      var found = findNode(treeId);
      colorPickerInput.value = (found && found.node.color) || "#3d4a7a";
      colorPickerTargetId = treeId;
      colorPickerInput.click();
      return;
    }

    if (e.target.closest('[data-role="toggle-complete"]')) return;

    // a task row is one button: a single click opens its details, a double
    // click renames it - same single/double debounce trick as the caret above
    var row = e.target.closest(".node-row");
    if (row) {
      var rowId = row.getAttribute("data-id");
      if (e.detail >= 2) {
        clearTimeout(nodeClickTimer);
        var nameEl = row.querySelector(".node-name");
        if (nameEl) { nameEl.focus(); selectAllText(nameEl); }
      } else {
        clearTimeout(nodeClickTimer);
        nodeClickTimer = setTimeout(function () { openDetails(rowId); }, 250);
      }
      return;
    }

    // board header title keeps its old behavior: click the name to rename it
    if (e.target.closest('[data-role="rename"]')) return;

    var headerHit = e.target.closest(".tree-card-header-top") || e.target.closest(".tree-progress-wrap");
    if (headerHit) {
      var card = e.target.closest(".tree-card");
      if (card) openDetails(card.getAttribute("data-tree-id"));
    }
  });

  // Stops a plain click on a task's name from immediately focusing it for
  // editing (its default behavior as a contenteditable element) - renaming a
  // task now only starts on a double click, handled explicitly in the click
  // listener below.
  board.addEventListener("mousedown", function (e) {
    if (e.target.closest(".node-name")) e.preventDefault();
  });

  board.addEventListener("change", function (e) {
    var cb = e.target.closest('[data-role="toggle-complete"]');
    if (cb) { toggleCompleted(cb.getAttribute("data-id"), cb.checked); return; }
  });

  document.addEventListener("focusin", function (e) {
    var el = e.target.closest('[data-role="rename"]');
    if (!el) return;
    renameOriginalId = el.getAttribute("data-id");
    renameOriginalText = el.textContent;
  });

  document.addEventListener("focusout", function (e) {
    var el = e.target.closest('[data-role="rename"]');
    if (!el) return;
    var id = el.getAttribute("data-id");
    var text = el.textContent;
    if (id === pendingNewId && text.trim() === "") {
      // never given a name - discard it instead of leaving a stray "Untitled"
      pendingNewId = null;
      removeNodeSilently(id);
    } else {
      renameNode(id, text);
      if (id === pendingNewId) pendingNewId = null;
    }
    if (renameOriginalId === id) { renameOriginalId = null; renameOriginalText = null; }
    flushPendingRemoteIfIdle();
  });

  document.addEventListener("keydown", function (e) {
    var el = e.target.closest('[data-role="rename"]');
    if (!el) return;
    var id = el.getAttribute("data-id");
    var isProjectRoot = state.projects.some(function (p) { return p.id === id; });
    var isTreeRoot = !isProjectRoot && currentProject().trees.some(function (t) { return t.id === id; });

    if (e.key === "Enter" && e.shiftKey) {
      // turn the current item into a branch and drop straight into its first child;
      // on a project name, start a new board instead; on a board title, its first task
      e.preventDefault();
      el.blur();
      if (isProjectRoot) addTree();
      else addChild(id, true, "");
    } else if (e.key === "Enter") {
      e.preventDefault();
      el.blur(); // commits the current name via the focusout handler
      if (!isTreeRoot && !isProjectRoot) addSiblingAfter(id);
      // editing a project's or board's own title just commits the rename - it doesn't create a task
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (id === pendingNewId) {
        // never confirmed - cancel creating it, whatever was typed
        pendingNewId = null;
        removeNodeSilently(id);
      } else {
        if (renameOriginalId === id) el.textContent = renameOriginalText;
        el.blur();
      }
    }
  });

  // ---------- drag & drop ----------

  board.addEventListener("dragstart", function (e) {
    var row = e.target.closest(".node-row");
    if (!row) return;
    dragId = row.getAttribute("data-id");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", dragId); } catch (err) { /* ignore */ }
  });

  board.addEventListener("dragend", function () {
    dragId = null;
    var overs = board.querySelectorAll(".drag-over, .drag-over-root");
    for (var i = 0; i < overs.length; i++) overs[i].classList.remove("drag-over", "drag-over-root");
  });

  board.addEventListener("dragover", function (e) {
    if (!dragId) return;
    var li = e.target.closest(".node-item");
    if (li) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDragOverClasses();
      li.classList.add("drag-over");
      return;
    }
    var rootBody = e.target.closest('[data-role="root-body"]');
    if (rootBody) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDragOverClasses();
      rootBody.classList.add("drag-over-root");
    }
  });

  board.addEventListener("drop", function (e) {
    if (!dragId) return;
    var li = e.target.closest(".node-item");
    if (li) {
      e.preventDefault();
      var targetId = li.getAttribute("data-id");
      var row = li.querySelector(":scope > .node-row");
      var rect = row.getBoundingClientRect();
      var offsetY = e.clientY - rect.top;
      var third = rect.height / 3;
      var position;
      if (offsetY < third) position = "before";
      else if (offsetY > third * 2) position = "after";
      else position = "into";
      moveNode(dragId, targetId, position);
      clearDragOverClasses();
      return;
    }
    var rootBody = e.target.closest('[data-role="root-body"]');
    if (rootBody) {
      e.preventDefault();
      moveNodeToRootEnd(dragId, rootBody.getAttribute("data-tree-id"));
      clearDragOverClasses();
    }
  });

  function clearDragOverClasses() {
    var overs = board.querySelectorAll(".drag-over, .drag-over-root");
    for (var i = 0; i < overs.length; i++) overs[i].classList.remove("drag-over", "drag-over-root");
  }

  // ---------- details panel ----------

  var detailsOverlay = document.getElementById("detailsOverlay");
  var detailsPanel = detailsOverlay.querySelector(".details-panel");
  var detailsClose = document.getElementById("detailsClose");
  var detailsBreadcrumb = document.getElementById("detailsBreadcrumb");
  var detailsTitle = document.getElementById("detailsTitle");
  var detailsMeta = document.getElementById("detailsMeta");
  var detailsDeps = document.getElementById("detailsDeps");
  var detailsNotes = document.getElementById("detailsNotes");
  var detailsChildren = document.getElementById("detailsChildren");
  var detailsAddChildBtn = document.getElementById("detailsAddChild");
  var detailsDeleteBtn = document.getElementById("detailsDelete");

  detailsClose.innerHTML = ICONS.close;

  function openDetails(id, focusTitle) {
    var found = findNode(id);
    if (!found) return;
    detailsId = id;
    renderDetails();
    detailsOverlay.hidden = false;
    if (focusTitle) {
      detailsTitle.focus();
      detailsTitle.select();
    }
  }

  function closeDetails() {
    detailsId = null;
    detailsOverlay.hidden = true;
  }

  function renderDetails() {
    if (!detailsId) return;
    var found = findNode(detailsId);
    if (!found) { closeDetails(); return; }
    var node = found.node;
    var isLeaf = node.children.length === 0;

    // breadcrumb
    var path = buildPath(detailsId);
    detailsBreadcrumb.innerHTML = "";
    path.forEach(function (crumbNode, idx) {
      var btn = document.createElement("button");
      btn.className = "crumb-btn";
      btn.textContent = crumbNode.name;
      btn.disabled = idx === path.length - 1;
      btn.addEventListener("click", function () { openDetails(crumbNode.id); });
      detailsBreadcrumb.appendChild(btn);
      if (idx < path.length - 1) {
        var sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = "/";
        detailsBreadcrumb.appendChild(sep);
      }
    });

    detailsTitle.value = node.name;
    detailsNotes.value = node.notes || "";

    // meta: completion state / progress
    detailsMeta.innerHTML = "";
    if (isLeaf) {
      var wrap = document.createElement("label");
      wrap.className = "details-meta-completed";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "leaf-checkbox";
      cb.checked = !!node.completed;
      cb.addEventListener("change", function () {
        toggleCompleted(node.id, cb.checked);
      });
      var span = document.createElement("span");
      span.textContent = "Completed";
      wrap.appendChild(cb);
      wrap.appendChild(span);
      detailsMeta.appendChild(wrap);
    } else {
      var progress = computeProgress(node);
      var pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      var progDiv = document.createElement("div");
      progDiv.className = "node-progress";
      progDiv.innerHTML =
        '<div class="progress-bar"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="progress-pct ' + pctColorClass(pct) + '">' + pct + '% (' + progress.done + '/' + progress.total + ')</span>';
      detailsMeta.appendChild(progDiv);
    }

    if (node.createdAt) {
      var created = document.createElement("div");
      created.className = "details-meta-created";
      created.textContent = "Created " + new Date(node.createdAt).toLocaleDateString();
      detailsMeta.appendChild(created);
    }

    // priority + blocked-by
    detailsDeps.innerHTML = "";

    var priorityLabel = document.createElement("label");
    priorityLabel.className = "details-priority-toggle";
    var priorityCb = document.createElement("input");
    priorityCb.type = "checkbox";
    priorityCb.checked = !!node.priority;
    priorityCb.addEventListener("change", function () { togglePriority(node.id); });
    var prioritySpan = document.createElement("span");
    prioritySpan.textContent = "Priority";
    priorityLabel.appendChild(priorityCb);
    priorityLabel.appendChild(prioritySpan);
    detailsDeps.appendChild(priorityLabel);

    var blockedLabelEl = document.createElement("label");
    blockedLabelEl.className = "details-label";
    blockedLabelEl.textContent = "Blocked by";
    detailsDeps.appendChild(blockedLabelEl);

    var blockedSelect = document.createElement("select");
    blockedSelect.className = "details-blocked-select";
    var noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "None";
    blockedSelect.appendChild(noneOpt);

    var excluded = {};
    excluded[node.id] = true;
    (function collectDescendants(n) {
      n.children.forEach(function (c) { excluded[c.id] = true; collectDescendants(c); });
    })(node);

    flattenProjectNodes(currentProject()).forEach(function (item) {
      if (excluded[item.id]) return;
      var opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = (item.path.length ? item.path.join(" / ") + " / " : "") + item.name;
      if (node.blockedBy === item.id) opt.selected = true;
      blockedSelect.appendChild(opt);
    });

    blockedSelect.addEventListener("change", function () {
      setBlockedBy(node.id, blockedSelect.value || null);
    });
    detailsDeps.appendChild(blockedSelect);

    if (isBlocked(node)) {
      var blockedNote = document.createElement("div");
      blockedNote.className = "details-blocked-note";
      blockedNote.textContent = 'Blocked until "' + findNode(node.blockedBy).node.name + '" is done.';
      detailsDeps.appendChild(blockedNote);
    }

    // children list
    detailsChildren.innerHTML = "";
    if (!isLeaf) {
      var heading = document.createElement("div");
      heading.className = "details-subheading";
      heading.textContent = "Sub-items (" + node.children.length + ")";
      detailsChildren.appendChild(heading);

      var ul = document.createElement("ul");
      ul.className = "details-child-list";
      node.children.forEach(function (child) {
        var li = document.createElement("li");
        li.className = "details-child-row";
        var childIsLeaf = child.children.length === 0;
        if (childIsLeaf) {
          var childCb = document.createElement("input");
          childCb.type = "checkbox";
          childCb.className = "leaf-checkbox";
          childCb.checked = !!child.completed;
          childCb.addEventListener("change", function () {
            toggleCompleted(child.id, childCb.checked);
          });
          li.appendChild(childCb);
        } else {
          var childProgress = computeProgress(child);
          var childPct = childProgress.total > 0 ? Math.round((childProgress.done / childProgress.total) * 100) : 0;
          var pctSpan = document.createElement("span");
          pctSpan.className = "details-child-pct";
          pctSpan.textContent = childPct + "%";
          li.appendChild(pctSpan);
        }
        var nameBtn = document.createElement("button");
        nameBtn.className = "details-child-name";
        nameBtn.textContent = child.name;
        nameBtn.addEventListener("click", function () { openDetails(child.id); });
        li.appendChild(nameBtn);
        ul.appendChild(li);
      });
      detailsChildren.appendChild(ul);
    }
  }

  detailsTitle.addEventListener("input", function () {
    var found = findNode(detailsId);
    if (!found) return;
    found.node.name = detailsTitle.value;
    saveState();
    render();
    var lastCrumb = detailsBreadcrumb.querySelector(".crumb-btn:disabled");
    if (lastCrumb) lastCrumb.textContent = found.node.name;
  });
  detailsTitle.addEventListener("blur", function () {
    var found = findNode(detailsId);
    if (!found) return;
    var trimmed = detailsTitle.value.trim();
    found.node.name = trimmed || "Untitled";
    detailsTitle.value = found.node.name;
    saveState();
    render();
    flushPendingRemoteIfIdle();
  });
  detailsTitle.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); detailsTitle.blur(); }
  });

  detailsNotes.addEventListener("input", function () {
    setNotes(detailsId, detailsNotes.value);
    render();
  });
  detailsNotes.addEventListener("blur", flushPendingRemoteIfIdle);

  detailsAddChildBtn.addEventListener("click", function () {
    var newId = addChild(detailsId, false);
    if (newId) openDetails(newId, true);
  });

  detailsDeleteBtn.addEventListener("click", function () {
    deleteNode(detailsId, closeDetails);
  });

  detailsClose.addEventListener("click", closeDetails);
  detailsOverlay.addEventListener("click", function (e) {
    if (e.target === detailsOverlay) closeDetails();
  });

  // ---------- confirm dialog (replaces window.confirm, which some browsers
  // silently start blocking after a page has shown several native dialogs) ----------

  var confirmOverlay = document.getElementById("confirmOverlay");
  var confirmMessage = document.getElementById("confirmMessage");
  var confirmCancelBtn = document.getElementById("confirmCancelBtn");
  var confirmOkBtn = document.getElementById("confirmOkBtn");
  var confirmCallback = null;

  function showConfirm(message, onConfirm) {
    confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    confirmOverlay.hidden = false;
    confirmOkBtn.focus();
  }

  function closeConfirm() {
    confirmOverlay.hidden = true;
    confirmCallback = null;
  }

  confirmOkBtn.addEventListener("click", function () {
    var cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
  });
  confirmCancelBtn.addEventListener("click", closeConfirm);
  confirmOverlay.addEventListener("click", function (e) {
    if (e.target === confirmOverlay) closeConfirm();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!confirmOverlay.hidden) {
      closeConfirm();
    } else if (!detailsOverlay.hidden) {
      closeDetails();
    } else if (!dashFullOverlay.hidden) {
      closeDashFull();
    } else if (!timelineOverlay.hidden) {
      closeTimeline();
    } else if (!projectMenu.hidden) {
      closeProjectMenu();
    }
  });

  // ---------- timeline panel ----------

  var timelineOverlay = document.getElementById("timelineOverlay");
  var timelineClose = document.getElementById("timelineClose");
  var timelineList = document.getElementById("timelineList");

  timelineClose.innerHTML = ICONS.close;

  function formatRelativeTime(ts) {
    var diffMin = Math.round((Date.now() - ts) / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return diffMin + " minute" + (diffMin === 1 ? "" : "s") + " ago";
    var diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return diffHr + " hour" + (diffHr === 1 ? "" : "s") + " ago";
    var diffDay = Math.round(diffHr / 24);
    return diffDay + " day" + (diffDay === 1 ? "" : "s") + " ago";
  }

  function makeBadge(text, cls) {
    var b = document.createElement("span");
    b.className = "timeline-badge " + cls;
    b.textContent = text;
    return b;
  }

  function appendChanges(ul, list, label) {
    if (!list || list.length === 0) return;
    list.forEach(function (it) {
      var li = document.createElement("li");
      var prefix = it.path && it.path.length ? it.path.join(" / ") + " / " : "";
      li.textContent = label + ": " + prefix + it.name;
      ul.appendChild(li);
    });
  }

  function renderTimelineEntry(id, data) {
    var item = document.createElement("div");
    item.className = "timeline-entry";

    var head = document.createElement("div");
    head.className = "timeline-entry-head";

    var timeSpan = document.createElement("span");
    timeSpan.className = "timeline-entry-time";
    timeSpan.title = new Date(data.timestamp).toLocaleString();
    timeSpan.textContent = formatRelativeTime(data.timestamp);
    head.appendChild(timeSpan);

    var badges = document.createElement("div");
    badges.className = "timeline-badges";
    var s = data.summary || {};
    if (s.added && s.added.length) badges.appendChild(makeBadge("+" + s.added.length + " added", "added"));
    if (s.removed && s.removed.length) badges.appendChild(makeBadge("-" + s.removed.length + " removed", "removed"));
    if (s.checked && s.checked.length) badges.appendChild(makeBadge(s.checked.length + " checked off", "checked"));
    if (s.unchecked && s.unchecked.length) badges.appendChild(makeBadge(s.unchecked.length + " unchecked", "unchecked"));
    head.appendChild(badges);
    item.appendChild(head);

    var details = document.createElement("ul");
    details.className = "timeline-entry-details";
    appendChanges(details, s.added, "Added");
    appendChanges(details, s.removed, "Removed");
    appendChanges(details, s.checked, "Checked off");
    appendChanges(details, s.unchecked, "Unchecked");
    if (details.children.length > 0) item.appendChild(details);

    var revertBtn = document.createElement("button");
    revertBtn.className = "btn btn-ghost timeline-revert-btn";
    revertBtn.textContent = "Revert to this version";
    revertBtn.addEventListener("click", function () { revertToEntry(data.state); });
    item.appendChild(revertBtn);

    return item;
  }

  function openTimeline() {
    timelineOverlay.hidden = false;
    timelineList.innerHTML = '<div class="timeline-loading">Loading...</div>';
    if (!historyCollectionRef) return;
    var q = query(historyCollectionRef, orderBy("timestamp", "desc"), limit(MAX_HISTORY_ENTRIES));
    getDocs(q).then(function (snap) {
      timelineList.innerHTML = "";
      if (snap.empty) {
        timelineList.innerHTML = '<div class="timeline-empty">No history yet. Checkpoints are saved automatically every few minutes as you make changes.</div>';
        return;
      }
      snap.forEach(function (docSnap) {
        timelineList.appendChild(renderTimelineEntry(docSnap.id, docSnap.data()));
      });
    }).catch(function (err) {
      console.error("Failed to load timeline", err);
      timelineList.innerHTML = '<div class="timeline-empty">Failed to load history.</div>';
    });
  }

  function closeTimeline() {
    timelineOverlay.hidden = true;
  }

  function revertToEntry(snapshotState) {
    showConfirm("Revert the board to this version? Your current state will be added to the timeline first so this can be undone.", function () {
      clearTimeout(saveTimer);
      hasPendingWrite = false;
      var diff = diffStates(lastCheckpointState || state, state);
      if (historyBaselineSet && diff.hasChanges) {
        addHistoryEntry(Date.now(), deepClone(state), diff);
      }
      var restored = deepClone(snapshotState);
      state = restored;
      lastCheckpointState = deepClone(restored);
      lastCheckpointTime = Date.now();
      setDoc(boardDocRef, restored).catch(function (err) {
        console.error("Revert failed", err);
        setSyncStatus("Save failed - will retry", "error");
      });
      render();
      closeTimeline();
    });
  }

  timelineBtn.addEventListener("click", openTimeline);
  timelineClose.addEventListener("click", closeTimeline);
  timelineOverlay.addEventListener("click", function (e) {
    if (e.target === timelineOverlay) closeTimeline();
  });

  // ---------- dashboard full-list panel ----------

  var dashFullOverlay = document.getElementById("dashFullOverlay");
  var dashFullTitle = document.getElementById("dashFullTitle");
  var dashFullClose = document.getElementById("dashFullClose");
  var dashFullList = document.getElementById("dashFullList");

  dashFullClose.innerHTML = ICONS.close;

  function openDashFull(title, items, emptyText) {
    dashFullTitle.textContent = title;
    dashFullList.innerHTML = "";
    if (items.length === 0) {
      var empty = document.createElement("div");
      empty.className = "dash-empty";
      empty.textContent = emptyText;
      dashFullList.appendChild(empty);
    } else {
      items.forEach(function (item) { dashFullList.appendChild(buildDashRow(item)); });
    }
    dashFullOverlay.hidden = false;
  }

  function closeDashFull() {
    dashFullOverlay.hidden = true;
  }

  dashFullClose.addEventListener("click", closeDashFull);
  dashFullOverlay.addEventListener("click", function (e) {
    if (e.target === dashFullOverlay) closeDashFull();
  });

  priorityBtn.addEventListener("click", function () {
    openDashFull("Priority", computeDashItems(currentProject(), "priority"), "Nothing prioritized yet.");
  });
  unblockedBtn.addEventListener("click", function () {
    openDashFull("Unblocked", computeDashItems(currentProject(), "unblocked"), "Nothing unblocked - everything is either done or blocked.");
  });
  lockedBtn.addEventListener("click", function () {
    openDashFull("Locked", computeDashItems(currentProject(), "locked"), "Nothing locked.");
  });

  // ---------- top bar actions ----------

  document.getElementById("newTreeBtn").addEventListener("click", addTree);
  document.getElementById("emptyNewTreeBtn").addEventListener("click", addTree);

  hamburgerBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (projectMenu.hidden) openProjectMenu(); else closeProjectMenu();
  });
  addProjectBtn.addEventListener("click", addProject);
  document.addEventListener("click", function (e) {
    if (projectMenu.hidden) return;
    if (projectMenu.contains(e.target) || e.target === hamburgerBtn) return;
    closeProjectMenu();
  });

  var colorPickerInput = document.getElementById("colorPickerInput");
  var colorPickerTargetId = null;
  colorPickerInput.addEventListener("input", function () {
    if (!colorPickerTargetId) return;
    var found = findNode(colorPickerTargetId);
    if (!found) return;
    found.node.color = colorPickerInput.value;
    saveState();
    render();
  });

  // ---------- init ----------

  render();
  initFirebaseSync();
})();
