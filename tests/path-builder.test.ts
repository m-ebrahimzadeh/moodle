import { describe, expect, it } from 'vitest';
import {
  MAX_RELATIVE_DOWNLOAD_PATH_LENGTH,
  buildLectureDownloadPath,
  buildMaterialDownloadPath,
  formatDuration,
  formatFileSize,
  sanitizePathSegment,
} from '../src/core/path-builder.js';

describe('path-builder', () => {
  describe('sanitizePathSegment', () => {
    it('removes OS-forbidden characters, control chars, and trailing dots', () => {
      expect(sanitizePathSegment('Unit 1: What? <Measurement> / "Validity"*...')).toBe(
        'Unit 1 What Measurement Validity',
      );
      expect(sanitizePathSegment('Line\u0000Break\tTest\n')).toBe('Line Break Test');
    });

    it('guards path traversal and Windows reserved device names including dotted stems [ARCH-005 / QA-006]', () => {
      expect(sanitizePathSegment('..')).toBe('Untitled');
      expect(sanitizePathSegment('   ...   ')).toBe('Untitled');
      expect(sanitizePathSegment('CON')).toBe('CON_');
      expect(sanitizePathSegment('nul')).toBe('nul_');
      expect(sanitizePathSegment('CON.1')).toBe('CON_.1');
      expect(sanitizePathSegment('NUL.mp4')).toBe('NUL_.mp4');
      expect(sanitizePathSegment('AUX.backup')).toBe('AUX_.backup');
      expect(sanitizePathSegment('com1.txt')).toBe('com1_.txt');
    });

    it('truncates long segments cleanly', () => {
      const longTitle = 'A'.repeat(120);
      expect(sanitizePathSegment(longTitle, 40).length).toBe(40);
    });
  });

  describe('buildLectureDownloadPath', () => {
    it('builds canonical organized path for MP4 with resolution when within MAX_PATH budget', () => {
      const path = buildLectureDownloadPath({
        academicYear: '2026-2027',
        courseCode: 'PSQ4107809',
        courseTitle: 'PSYCHOLOGICAL TESTING',
        sectionIndex: 3,
        sectionTitle: '1. Measurement and Validity',
        activityIndex: 1,
        lectureTitle: 'Recorded Lecture: Unit 1 Introduction',
        resolutionLabel: '1080p',
        ext: 'mp4',
      });

      expect(path).toBe(
        'UniPD/2026-2027/PSQ4107809 - PSYCHOLOGICAL TESTING/03 - 1. Measurement and Validity/01 - Recorded Lecture Unit 1 Introduction (1080p).mp4',
      );
      expect(path.length).toBeLessThanOrEqual(MAX_RELATIVE_DOWNLOAD_PATH_LENGTH);
    });

    it('enforces <= 180-char Windows MAX_PATH budget while preserving hierarchy, resolution suffix, and extension [ARCH-005 / QA-006]', () => {
      const path = buildLectureDownloadPath({
        academicYear: '2026-2027',
        courseCode: 'PSQ4107809',
        courseTitle:
          'PRINCIPLES AND APPLICATIONS OF PSYCHOLOGICAL TESTING AND CLINICAL NEUROPSYCHOLOGICAL ASSESSMENT',
        sectionIndex: 3,
        sectionTitle:
          '1. Introduction: Measurement, Reliability, Construct Validity, and Factor Analysis — Oct 5 - 14',
        activityIndex: 12,
        lectureTitle:
          'Recorded Lecture: Unit 1 Comprehensive Introduction to Psychometric Modeling and Classical Test Theory',
        resolutionLabel: '1080p',
        ext: 'mp4',
      });

      expect(path.length).toBeLessThanOrEqual(180);
      const segments = path.split('/');
      expect(segments).toHaveLength(5);
      expect(segments[0]).toBe('UniPD');
      expect(segments[1]).toBe('2026-2027');
      expect(segments[2]).toMatch(/^PSQ4107809 - .+/);
      expect(segments[3]).toMatch(/^03 - .+/);
      expect(segments[4]).toMatch(/^12 - .+ \(1080p\)\.mp4$/);
    });

    it('builds clean fallback path when academicYear, courseCode, or resolutionLabel are absent', () => {
      const path = buildLectureDownloadPath({
        academicYear: null,
        courseCode: null,
        courseTitle: 'Clinical Seminar',
        sectionIndex: 0,
        sectionTitle: 'General',
        activityIndex: 2,
        lectureTitle: 'Workshop Recording',
        ext: '.VTT',
      });

      expect(path).toBe('UniPD/Unknown-AY/Clinical Seminar/00 - General/02 - Workshop Recording.vtt');
    });
  });

  describe('formatting helpers', () => {
    it('formats byte sizes and durations human-readably', () => {
      expect(formatFileSize(0)).toBe('Size unknown');
      expect(formatFileSize(167_215_572)).toBe('159.5 MB');
      expect(formatFileSize(1_500_000_000)).toBe('1.40 GB');
      expect(formatDuration(2363)).toBe('39m 23s');
      expect(formatDuration(5817)).toBe('1h 36m');
      expect(formatDuration(null)).toBe('');
    });
  });

  describe('buildMaterialDownloadPath (Option A — DEC-005)', () => {
    it('builds Option A path for single mod_resource and deduplicates repeated extensions (.pdf.pdf -> .pdf)', () => {
      const path = buildMaterialDownloadPath({
        academicYear: '2026-2027',
        courseCode: 'PSQ4107809',
        courseTitle: 'PSYCHOLOGICAL TESTING',
        sectionIndex: 3,
        sectionTitle: '1. Measurement',
        activityIndex: 2,
        materialTitle: 'Course Syllabus.pdf.pdf',
        ext: 'PDF',
      });

      expect(path).toBe(
        'UniPD/2026-2027/PSQ4107809 - PSYCHOLOGICAL TESTING/03 - 1. Measurement/Materials/02 - Course Syllabus.pdf',
      );
      expect(path.length).toBeLessThanOrEqual(MAX_RELATIVE_DOWNLOAD_PATH_LENGTH);
    });

    it('builds Option A path for mod_folder files preserving subPath and enforcing Windows reserved stems', () => {
      const path = buildMaterialDownloadPath({
        academicYear: '2026-2027',
        courseCode: 'PSQ4107809',
        courseTitle: 'PSYCHOLOGICAL TESTING',
        sectionIndex: 2,
        sectionTitle: 'Datasets',
        activityIndex: 1,
        materialTitle: 'Lab Datasets',
        folderName: 'Lab Datasets',
        subPath: ['Week 1', '..', 'R Scripts'],
        fileName: 'CON.R',
        ext: 'r',
      });

      expect(path).toBe(
        'UniPD/2026-2027/PSQ4107809 - PSYCHOLOGICAL TESTING/02 - Datasets/Materials/Lab Datasets/Week 1/R Scripts/CON_.r',
      );
      expect(path.length).toBeLessThanOrEqual(MAX_RELATIVE_DOWNLOAD_PATH_LENGTH);
    });

    it('enforces <= 180-char budget on deeply nested folders and long names', () => {
      const path = buildMaterialDownloadPath({
        academicYear: '2026-2027',
        courseCode: 'PSQ4107809',
        courseTitle: 'PRINCIPLES AND APPLICATIONS OF CLINICAL AND DEVELOPMENTAL PSYCHOLOGICAL TESTING',
        sectionIndex: 11,
        sectionTitle: 'Comprehensive Longitudinal Assessment and Psychometric Modeling Methods',
        activityIndex: 4,
        materialTitle: 'Archive Pack',
        folderName: 'Very Long Multi Module Archive Pack For Statistical Analysis',
        subPath: ['Subfolder_Alpha_Long', 'Subfolder_Beta_Long', 'Subfolder_Gamma_Long', 'Subfolder_Delta_Long'],
        fileName: 'extremely_long_survey_dataset_with_many_variables_final_version.sav',
        ext: 'sav',
      });

      expect(path.length).toBeLessThanOrEqual(180);
      expect(path).toMatch(/\.sav$/);
      expect(path.startsWith('UniPD/2026-2027/')).toBe(true);
    });
  });
});
