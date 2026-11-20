import type {
  CourseSection,
  EnrolledCourse,
  LectureActivity,
} from '../core/types.js';

export interface PublicSessionStatus {
  authenticated: boolean;
  userId: number | null;
  loginUrl: string;
}

/**
 * Secret-free video flavor metadata sent across the SW <-> UI boundary.
 * Signed CDN/Kaltura `downloadUrl` (`?ks=...`) never leaves `service-worker.ts`.
 */
export interface PublicVideoFlavor {
  id: string;
  width: number;
  height: number;
  bitrateKbps: number;
  sizeBytes: number;
  fileExt: string;
  isOriginal: boolean;
}

/**
 * Secret-free caption track metadata sent across the SW <-> UI boundary.
 * Raw caption URLs stay inside `service-worker.ts`.
 */
export interface PublicCaptionTrack {
  label: string;
  languageCode: string;
  index: number;
}

/**
 * Secret-free resolved lecture summary safe for Side Panel UI rendering.
 */
export interface PublicResolvedLectureMedia {
  cmid: number;
  entryId: string | null;
  lectureTitle: string;
  durationSec: number | null;
  flavors: PublicVideoFlavor[];
  captions: PublicCaptionTrack[];
  hasDirectMp4: boolean;
}

export type DownloadKind = 'video' | 'subtitle';

export type DownloadTaskStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Secret-free descriptor persisted in `chrome.storage.session` so queued downloads
 * can lazily re-resolve fresh Kaltura/Moodle URLs after MV3 service worker restarts
 * or >1h batch durations without storing `ks`, `sesskey`, or signed URLs.
 */
export interface DownloadResolutionDescriptor {
  activity: LectureActivity;
  kind: DownloadKind;
  filename: string;
  preferredFlavorId?: string | null;
  preferredHeight?: number | null;
  captionLanguageCode?: string | null;
  captionLabel?: string | null;
  captionIndex?: number | null;
}

export interface EnqueueDownloadItem {
  cmid: number;
  courseId: number;
  lectureTitle: string;
  filename: string;
  kind: DownloadKind;
  sizeBytes?: number;
  descriptor: DownloadResolutionDescriptor;
}

/**
 * Secret-free download task representation safe for UI display and session storage.
 * Signed CDN URLs (`ks`, CloudFront `Policy`/`Signature`) are intentionally omitted.
 */
export interface DownloadQueueItem {
  id: string;
  cmid: number;
  courseId: number;
  lectureTitle: string;
  filename: string;
  kind: DownloadKind;
  status: DownloadTaskStatus;
  downloadId: number | null;
  bytesReceived: number;
  totalBytes: number;
  error: string | null;
  createdAt: number;
}

export interface DownloadQueueState {
  maxConcurrent: number;
  activeCount: number;
  queuedCount: number;
  items: DownloadQueueItem[];
}

export type ExtensionRequest =
  | { type: 'GET_SESSION_STATUS' }
  | { type: 'OPEN_SSO_LOGIN' }
  | { type: 'LIST_COURSES' }
  | { type: 'SCAN_COURSE_LECTURES'; courseId: number }
  | { type: 'RESOLVE_LECTURE_MEDIA'; activity: LectureActivity }
  | { type: 'ENQUEUE_DOWNLOADS'; items: EnqueueDownloadItem[] }
  | { type: 'GET_QUEUE_STATE' }
  | { type: 'CANCEL_DOWNLOAD'; taskId: string }
  | { type: 'CLEAR_FINISHED_DOWNLOADS' };

export type ExtensionResponseMap = {
  GET_SESSION_STATUS: { session: PublicSessionStatus };
  OPEN_SSO_LOGIN: { opened: boolean; tabId: number | null };
  LIST_COURSES: { courses: EnrolledCourse[] };
  SCAN_COURSE_LECTURES: { courseId: number; sections: CourseSection[] };
  RESOLVE_LECTURE_MEDIA: { media: PublicResolvedLectureMedia };
  ENQUEUE_DOWNLOADS: { enqueuedIds: string[]; state: DownloadQueueState };
  GET_QUEUE_STATE: { state: DownloadQueueState };
  CANCEL_DOWNLOAD: { state: DownloadQueueState };
  CLEAR_FINISHED_DOWNLOADS: { state: DownloadQueueState };
};

export type ExtensionResponse<T extends ExtensionRequest['type']> =
  | ({ ok: true } & ExtensionResponseMap[T])
  | { ok: false; error: string };

export type ExtensionBroadcastEvent =
  | { type: 'QUEUE_UPDATED'; state: DownloadQueueState }
  | { type: 'SESSION_UPDATED'; session: PublicSessionStatus };
