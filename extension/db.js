'use strict';

/**
 * RabbitHole — IndexedDB wrapper
 *
 * Object stores:
 *   courses  — one record per course (id, name, semester, syllabus, processed structure)
 *   readings — individual documents attached to a course
 */

const DB_NAME    = 'rabbithole_db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('courses')) {
        db.createObjectStore('courses', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('readings')) {
        const store = db.createObjectStore('readings', { keyPath: 'id' });
        store.createIndex('by_course', 'course_id', { unique: false });
      }
    };
    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = (e) => reject(e.target.error);
  });
}

// ── Courses ──────────────────────────────────────────────────────────

async function saveCourse(course) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('courses', 'readwrite');
    const req = tx.objectStore('courses').put(course);
    req.onsuccess = () => resolve(course);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function getCourse(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('courses', 'readonly');
    const req = tx.objectStore('courses').get(id);
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function deleteCourse(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['courses', 'readings'], 'readwrite');
    tx.objectStore('courses').delete(id);
    const readingsStore = tx.objectStore('readings');
    const idx = readingsStore.index('by_course');
    const req = idx.openCursor(IDBKeyRange.only(id));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
  });
}

// ── Active course (stored in chrome.storage.local for fast access) ───

const ACTIVE_COURSE_KEY = 'rabbithole_active_course';

function getActiveCourseId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(ACTIVE_COURSE_KEY, (r) => resolve(r[ACTIVE_COURSE_KEY] || null));
  });
}

function setActiveCourseId(id) {
  return new Promise((resolve) => {
    if (id) {
      chrome.storage.local.set({ [ACTIVE_COURSE_KEY]: id }, resolve);
    } else {
      chrome.storage.local.remove(ACTIVE_COURSE_KEY, resolve);
    }
  });
}

async function getActiveCourse() {
  const id = await getActiveCourseId();
  if (!id) return null;
  return getCourse(id);
}

// ── Readings ─────────────────────────────────────────────────────────

async function saveReading(reading) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('readings', 'readwrite');
    const req = tx.objectStore('readings').put(reading);
    req.onsuccess = () => resolve(reading);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function getReadingsForCourse(courseId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('readings', 'readonly');
    const idx = tx.objectStore('readings').index('by_course');
    const req = idx.getAll(courseId);
    req.onsuccess = (e) => resolve(e.target.result || []);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function deleteReading(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('readings', 'readwrite');
    const req = tx.objectStore('readings').delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}
