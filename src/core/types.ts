export const DEFAULT_MOODLE_BASE_URL = 'https://psico.elearning.unipd.it';
export const UNIPD_SHIBBOLETH_LOGIN_PATH = '/auth/shibboleth/index.php';
export const KALTURA_API_BASE_URL = 'https://cdnapisec.kaltura.com';

export type AcademicYear = '2026-2027' | '2025-2026' | (string & {});

export interface MoodleSessionInfo {
  authenticated: boolean;
  userId: number | null;
  sesskey: string | null;
  loginUrl: string;
}

export interface RawMoodleCourse {
  id: number;
  fullname: string;
  shortname: string;
  fullnamedisplay?: string;
  idnumber?: string;
  viewurl?: string;
  coursecategory?: string;
  startdate?: number;
  enddate?: number;
  visible?: boolean;
  isfavourite?: boolean;
  hidden?: boolean;
}

export interface EnrolledCourse {
  id: number;
  fullname: string;
  shortname: string;
  courseCode: string | null;
  title: string;
  academicYear: AcademicYear | null;
  category: string;
  viewUrl: string;
}

export type LectureActivityType = 'kalvidres' | 'videotime' | 'resource';

export interface LectureActivity {
  cmid: number;
  courseId: number;
  sectionIndex: number;
  sectionTitle: string;
  activityIndex: number;
  title: string;
  type: LectureActivityType;
  url: string;
}

export interface CourseSection {
  sectionIndex: number;
  sectionId: string;
  title: string;
  activities: LectureActivity[];
}

export interface KalturaBridgeConfig {
  partnerId: number;
  uiconfId: number;
  entryId: string;
  ks: string;
  isPlaylist: boolean;
}

export interface VideoFlavor {
  id: string;
  width: number;
  height: number;
  bitrateKbps: number;
  sizeBytes: number;
  fileExt: string;
  isOriginal: boolean;
  downloadUrl: string;
}

export interface CaptionTrack {
  label: string;
  languageCode: string;
  vttUrl: string;
}

export interface ResolvedLectureMedia {
  cmid: number;
  entryId: string | null;
  lectureTitle: string;
  durationSec: number | null;
  flavors: VideoFlavor[];
  captions: CaptionTrack[];
  directMp4Url: string | null;
}

export interface LectureDownloadPathParams {
  academicYear: string | null;
  courseCode: string | null;
  courseTitle: string;
  sectionIndex: number;
  sectionTitle: string;
  activityIndex: number;
  lectureTitle: string;
  resolutionLabel?: string;
  ext: string;
}

export type MaterialActivityType = 'resource' | 'folder';

export interface CourseMaterialActivity {
  cmid: number;
  courseId: number;
  sectionIndex: number;
  sectionTitle: string;
  activityIndex: number;
  title: string;
  type: MaterialActivityType;
  url: string;
  fileTypeHint: string | null;
  detailsText: string | null;
}

export interface CourseMaterialSection {
  sectionIndex: number;
  sectionId: string;
  title: string;
  materials: CourseMaterialActivity[];
}

export interface CourseContentScan {
  sections: CourseSection[];
  materialSections: CourseMaterialSection[];
}

export interface FolderFileEntry {
  fileIndex: number;
  name: string;
  subPath: string[];
  ext: string;
  url: string;
}

export interface MaterialDownloadPathParams {
  academicYear: string | null;
  courseCode: string | null;
  courseTitle: string;
  sectionIndex: number;
  sectionTitle: string;
  activityIndex: number;
  materialTitle: string;
  folderName?: string | null;
  subPath?: string[];
  fileName?: string | null;
  ext: string;
}
