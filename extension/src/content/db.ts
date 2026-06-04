/**
 * RabbitHole — IndexedDB wrapper
 *
 * Object stores:
 *   courses  — one record per course (id, name, syllabus, processed structure)
 *   readings — individual documents attached to a course
 */

// ── Types ────────────────────────────────────────────────────────────

export interface CourseWeek {
  week: number;
  topic: string;
  concepts: string[];
  readings: string[];
}

export interface ProcessedSyllabus {
  course_name?: string;
  instructor?: string;
  semester?: string;
  weeks: CourseWeek[];
  key_concepts: string[];
  learning_outcomes: string[];
}

export interface Course {
  id: string;
  name: string;
  syllabus: string;
  processed: ProcessedSyllabus;
  created_at: string;
}

export interface Reading {
  id: string;
  course_id: string;
  title: string;
  text: string;
  saved_at: string;
}

// ── DB bootstrap ─────────────────────────────────────────────────────

const DB_NAME = 'rabbithole_db';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('courses')) {
        db.createObjectStore('courses', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('readings')) {
        const store = db.createObjectStore('readings', { keyPath: 'id' });
        store.createIndex('by_course', 'course_id', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
}

// ── Courses ──────────────────────────────────────────────────────────

export async function saveCourse(course: Course): Promise<Course> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('courses', 'readwrite');
    const req = tx.objectStore('courses').put(course);
    req.onsuccess = () => resolve(course);
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

export async function getCourse(id: string): Promise<Course | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('courses', 'readonly');
    const req = tx.objectStore('courses').get(id);
    req.onsuccess = (e) => resolve((e.target as IDBRequest).result || null);
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

export async function deleteCourse(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['courses', 'readings'], 'readwrite');
    tx.objectStore('courses').delete(id);
    const readingsStore = tx.objectStore('readings');
    const idx = readingsStore.index('by_course');
    const req = idx.openCursor(IDBKeyRange.only(id));
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject((e.target as IDBTransaction).error);
  });
}

// ── Active course (chrome.storage.local for fast access) ─────────────

const ACTIVE_COURSE_KEY = 'rabbithole_active_course';

export function getActiveCourseId(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(ACTIVE_COURSE_KEY, (r) =>
      resolve(r[ACTIVE_COURSE_KEY] || null)
    );
  });
}

export function setActiveCourseId(id: string | null): Promise<void> {
  return new Promise((resolve) => {
    if (id) {
      chrome.storage.local.set({ [ACTIVE_COURSE_KEY]: id }, () => resolve());
    } else {
      chrome.storage.local.remove(ACTIVE_COURSE_KEY, () => resolve());
    }
  });
}

export async function getActiveCourse(): Promise<Course | null> {
  const id = await getActiveCourseId();
  if (!id) return null;
  return getCourse(id);
}

// ── Readings ─────────────────────────────────────────────────────────

export async function saveReading(reading: Reading): Promise<Reading> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('readings', 'readwrite');
    const req = tx.objectStore('readings').put(reading);
    req.onsuccess = () => resolve(reading);
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

export async function getReadingsForCourse(courseId: string): Promise<Reading[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('readings', 'readonly');
    const idx = tx.objectStore('readings').index('by_course');
    const req = idx.getAll(courseId);
    req.onsuccess = (e) => resolve((e.target as IDBRequest).result || []);
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}

export async function deleteReading(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('readings', 'readwrite');
    const req = tx.objectStore('readings').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject((e.target as IDBRequest).error);
  });
}
