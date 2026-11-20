import type {
  LectureDownloadPathParams,
  MaterialDownloadPathParams,
} from './types.js';

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export const MAX_RELATIVE_DOWNLOAD_PATH_LENGTH = 180;

function guardWindowsReservedStem(segment: string, maxLen: number): string {
  const firstDotIdx = segment.indexOf('.');
  const rawStem = firstDotIdx === -1 ? segment : segment.slice(0, firstDotIdx);
  const stem = rawStem.trim().toUpperCase();

  if (!WINDOWS_RESERVED_NAMES.has(stem)) {
    return segment;
  }

  let guarded =
    firstDotIdx === -1
      ? `${rawStem.trimEnd()}_`
      : `${rawStem.trimEnd()}_${segment.slice(firstDotIdx)}`;

  if (guarded.length > maxLen) {
    guarded = guarded.slice(0, maxLen).replace(/[.\s]+$/g, '').trim();
    const slicedStem = (guarded.split('.')[0] ?? '').trim().toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(slicedStem)) {
      const keep = Math.max(1, maxLen - 1);
      guarded = `${guarded.slice(0, keep).replace(/[.\s]+$/g, '')}_`;
    }
  }

  return guarded || 'Untitled';
}

function trimSegmentToLength(segment: string, targetLen: number): string {
  const limit = Math.max(1, Math.floor(targetLen));
  if (segment.length <= limit) {
    return segment;
  }

  let trimmed = segment.slice(0, limit).replace(/[.\s]+$/g, '').trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    trimmed = limit >= 8 ? 'Untitled' : 'U'.repeat(limit);
  }
  return guardWindowsReservedStem(trimmed, limit);
}

/**
 * Sanitizes a single path segment for safe cross-platform browser download filenames
 * (Windows/macOS/Linux safe).
 */
export function sanitizePathSegment(segment: string, maxLen: number = 90): string {
  const limit = Math.max(8, maxLen);

  let cleaned = segment
    // Remove ASCII control characters
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    // Replace OS-forbidden filename characters (<>:"/\|?*)
    .replace(/[<>:"/\\|?*]+/g, ' ')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim()
    // Strip leading/trailing dots and spaces (forbidden on Windows / prevents ".." traversal)
    .replace(/^[.\s]+|[.\s]+$/g, '');

  if (!cleaned) {
    return 'Untitled';
  }

  if (cleaned.length > limit) {
    cleaned = cleaned.slice(0, limit).replace(/[.\s]+$/g, '').trim();
  }

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'Untitled';
  }

  return guardWindowsReservedStem(cleaned, limit);
}

function sanitizeExtension(ext: string): string {
  const cleaned = ext.replace(/^\.+/, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return cleaned || 'bin';
}

function padTwoDigits(value: number): string {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return String(normalized).padStart(2, '0');
}

function trimProportionally(
  values: readonly string[],
  overflow: number,
  minPerSegment: number,
): string[] {
  const slacks = values.map((v) => Math.max(0, v.length - minPerSegment));
  const totalSlack = slacks.reduce((sum, s) => sum + s, 0);
  if (totalSlack <= 0 || overflow <= 0) {
    return [...values];
  }

  const cuts = slacks.map((s) => Math.min(s, Math.floor((overflow * s) / totalSlack)));
  const allocated = cuts.reduce((sum, c) => sum + c, 0);
  let remainder = Math.min(overflow, totalSlack) - allocated;

  while (remainder > 0) {
    let bestIdx = -1;
    let bestRemaining = 0;
    for (let i = 0; i < values.length; i += 1) {
      const remSlack = slacks[i]! - cuts[i]!;
      const remLen = values[i]!.length - cuts[i]!;
      if (remSlack > 0 && remLen > bestRemaining) {
        bestRemaining = remLen;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      break;
    }
    cuts[bestIdx] = cuts[bestIdx]! + 1;
    remainder -= 1;
  }

  return values.map((v, i) => trimSegmentToLength(v, v.length - cuts[i]!));
}

function stripRepeatedTrailingExtension(name: string, ext: string): string {
  let result = name.trim();
  const suffix = `.${ext.toLowerCase()}`;
  while (result.length > suffix.length && result.toLowerCase().endsWith(suffix)) {
    result = result.slice(0, -suffix.length).replace(/[.\s]+$/g, '');
  }
  return result;
}

interface CoursePathPrefix {
  aySegment: string;
  cleanCourseTitle: string;
  cleanCourseCode: string | null;
}

function resolveCoursePrefix(params: {
  academicYear: string | null;
  courseCode: string | null;
  courseTitle: string;
}): CoursePathPrefix {
  return {
    aySegment: sanitizePathSegment(params.academicYear?.trim() || 'Unknown-AY', 24),
    cleanCourseTitle: sanitizePathSegment(params.courseTitle, 72),
    cleanCourseCode: params.courseCode?.trim()
      ? sanitizePathSegment(params.courseCode, 24)
      : null,
  };
}

function formatCourseFolder(prefix: CoursePathPrefix): string {
  return prefix.cleanCourseCode
    ? `${prefix.cleanCourseCode} - ${prefix.cleanCourseTitle}`
    : prefix.cleanCourseTitle;
}

function trimCoursePrefixToBudget(prefix: CoursePathPrefix, assemble: () => string): string {
  let path = assemble();
  if (path.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH && prefix.cleanCourseCode) {
    const excess = path.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH;
    prefix.cleanCourseCode = trimSegmentToLength(
      prefix.cleanCourseCode,
      Math.max(4, prefix.cleanCourseCode.length - excess),
    );
    path = assemble();
  }
  if (path.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
    const excess = path.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH;
    prefix.aySegment = trimSegmentToLength(
      prefix.aySegment,
      Math.max(4, prefix.aySegment.length - excess),
    );
    path = assemble();
  }
  return path;
}

/**
 * Formats a Unix timestamp in seconds as an ISO `YYYY-MM-DD` (UTC) date string,
 * or returns `null` if absent or invalid.
 */
export function formatUnixSecondsToIsoDate(unixSec: number | null | undefined): string | null {
  if (typeof unixSec !== 'number' || !Number.isFinite(unixSec) || unixSec <= 0) {
    return null;
  }
  const date = new Date(Math.trunc(unixSec) * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Builds a clean course-level relative download path under Chrome's default Downloads folder:
 * `UniPD/{AY}/{CourseCode} - {CourseTitle}/Lectures/{LectureNum} - [{YYYY-MM-DD} - ]{LectureTitle} ({Resolution}).{ext}`
 *
 * Enforces a Windows `MAX_PATH`-safe relative path budget (`<= 180` characters)
 * by proportionally trimming `courseTitle` and `lectureTitle`
 * while preserving the folder hierarchy, date, resolution suffix, and file extension.
 */
export function buildLectureDownloadPath(params: LectureDownloadPathParams): string {
  const prefix = resolveCoursePrefix(params);

  const lectureNum = padTwoDigits(Math.max(1, params.lectureIndex));
  const rawDate = params.lectureDate?.trim() ?? '';
  const datePrefix = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `${rawDate} - ` : '';
  let cleanLectureTitle = sanitizePathSegment(params.lectureTitle, 80);

  const cleanResolution = params.resolutionLabel?.trim()
    ? sanitizePathSegment(params.resolutionLabel, 24)
    : '';
  const resolutionSuffix = cleanResolution ? ` (${cleanResolution})` : '';

  const ext = sanitizeExtension(params.ext);

  const assemble = (): string => {
    const courseFolder = formatCourseFolder(prefix);
    const filename = `${lectureNum} - ${datePrefix}${cleanLectureTitle}${resolutionSuffix}.${ext}`;
    return `UniPD/${prefix.aySegment}/${courseFolder}/Lectures/${filename}`;
  };

  let path = assemble();
  for (const minLen of [12, 1]) {
    if (path.length <= MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
      break;
    }
    const [nextCourseTitle, nextLectureTitle] = trimProportionally(
      [prefix.cleanCourseTitle, cleanLectureTitle],
      path.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH,
      minLen,
    );
    prefix.cleanCourseTitle = nextCourseTitle!;
    cleanLectureTitle = nextLectureTitle!;
    path = assemble();
  }

  return trimCoursePrefixToBudget(prefix, assemble);
}

/**
 * Builds a course-level `Materials/` relative download path (`DSC-002` / `DEC-007`):
 * - Single `mod_resource`: `UniPD/{AY}/{Course}/Materials/{Section}/{Num} - {Title}.{ext}`
 * - `mod_folder` file: `UniPD/{AY}/{Course}/Materials/{Section}/{FolderName}/{subPath}/{FileName}.{ext}`
 *
 * Deduplicates repeated trailing extensions (`.pdf.pdf` -> `.pdf`), enforces
 * Windows stem-based reserved-name guards, and caps total length at `<= 180` chars.
 */
export function buildMaterialDownloadPath(params: MaterialDownloadPathParams): string {
  const prefix = resolveCoursePrefix(params);
  const sectionNum = padTwoDigits(params.sectionIndex);
  let cleanSectionTitle = sanitizePathSegment(params.sectionTitle || 'General', 72);

  const ext = sanitizeExtension(params.ext);
  const rawFolderName = params.folderName?.trim() || '';
  const isFolderFile = rawFolderName.length > 0;

  if (!isFolderFile) {
    const activityNum = padTwoDigits(Math.max(1, params.activityIndex));
    const strippedTitle = stripRepeatedTrailingExtension(params.materialTitle, ext);
    let cleanTitle = sanitizePathSegment(strippedTitle, 80);

    const assemble = (): string => {
      const courseFolder = formatCourseFolder(prefix);
      const sectionFolder = `${sectionNum} - ${cleanSectionTitle}`;
      const filename = `${activityNum} - ${cleanTitle}.${ext}`;
      return `UniPD/${prefix.aySegment}/${courseFolder}/Materials/${sectionFolder}/${filename}`;
    };

    let path = assemble();
    for (const minLen of [12, 1]) {
      if (path.length <= MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
        break;
      }
      const [nextCourseTitle, nextSectionTitle, nextTitle] = trimProportionally(
        [prefix.cleanCourseTitle, cleanSectionTitle, cleanTitle],
        path.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH,
        minLen,
      );
      prefix.cleanCourseTitle = nextCourseTitle!;
      cleanSectionTitle = nextSectionTitle!;
      cleanTitle = nextTitle!;
      path = assemble();
    }

    return trimCoursePrefixToBudget(prefix, assemble);
  }

  let cleanFolderName = sanitizePathSegment(rawFolderName, 64);
  const cleanSubPath = (params.subPath ?? [])
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
    .map((seg) => sanitizePathSegment(seg, 48));

  const rawFileName = params.fileName?.trim() || params.materialTitle;
  const strippedFileName = stripRepeatedTrailingExtension(rawFileName, ext);
  let cleanFileName = sanitizePathSegment(strippedFileName, 80);

  const assembleFolder = (): string => {
    const courseFolder = formatCourseFolder(prefix);
    const sectionFolder = `${sectionNum} - ${cleanSectionTitle}`;
    const parts = [
      'UniPD',
      prefix.aySegment,
      courseFolder,
      'Materials',
      sectionFolder,
      cleanFolderName,
      ...cleanSubPath,
      `${cleanFileName}.${ext}`,
    ];
    return parts.join('/');
  };

  let path = assembleFolder();
  if (path.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
    // Pass 1: trim courseTitle, sectionTitle, and folderName down to min 10
    const [nextCourseTitle, nextSectionTitle, nextFolderName] = trimProportionally(
      [prefix.cleanCourseTitle, cleanSectionTitle, cleanFolderName],
      path.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH,
      10,
    );
    prefix.cleanCourseTitle = nextCourseTitle!;
    cleanSectionTitle = nextSectionTitle!;
    cleanFolderName = nextFolderName!;
    path = assembleFolder();
  }

  if (path.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
    const excess = path.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH;
    const maxFileLen = Math.max(10, cleanFileName.length - excess);
    cleanFileName = trimSegmentToLength(cleanFileName, maxFileLen);
    path = assembleFolder();
  }

  // Trim subPath segments down to min 4, then min 1 if still over budget
  for (const minSubLen of [4, 1]) {
    if (path.length <= MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
      break;
    }
    for (let i = 0; i < cleanSubPath.length && path.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH; i += 1) {
      const current = cleanSubPath[i]!;
      const excess = path.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH;
      if (current.length > minSubLen) {
        cleanSubPath[i] = trimSegmentToLength(
          current,
          Math.max(minSubLen, current.length - excess),
        );
        path = assembleFolder();
      }
    }
  }

  if (path.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
    const [nextCourseTitle, nextSectionTitle, nextFolderName] = trimProportionally(
      [prefix.cleanCourseTitle, cleanSectionTitle, cleanFolderName],
      path.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH,
      1,
    );
    prefix.cleanCourseTitle = nextCourseTitle!;
    cleanSectionTitle = nextSectionTitle!;
    cleanFolderName = nextFolderName!;
    path = assembleFolder();
  }

  if (path.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH) {
    const excess = path.length - MAX_RELATIVE_DOWNLOAD_PATH_LENGTH;
    cleanFileName = trimSegmentToLength(cleanFileName, Math.max(1, cleanFileName.length - excess));
    path = assembleFolder();
  }

  path = trimCoursePrefixToBudget(prefix, assembleFolder);

  // Extreme depth fallback: drop middle subPath directories if path still exceeds 180 chars
  while (path.length > MAX_RELATIVE_DOWNLOAD_PATH_LENGTH && cleanSubPath.length > 0) {
    const removeIdx = Math.floor(cleanSubPath.length / 2);
    cleanSubPath.splice(removeIdx, 1);
    path = assembleFolder();
  }

  return path;
}

export function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return 'Size unknown';
  }
  if (sizeBytes < 1024) {
    return `${Math.round(sizeBytes)} B`;
  }
  const kb = sizeBytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function formatDuration(durationSec: number | null): string {
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) {
    return '';
  }
  const total = Math.round(durationSec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
