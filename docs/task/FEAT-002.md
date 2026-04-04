# FEAT-002 Implement file access layer

- **status**: in_progress
- **priority**: P1
- **owner**: bkd:wtkzwi82
- **createdAt**: 2026-04-04 01:30

## Description

Build the file access layer that supports three input methods:
1. File System Access API (preferred — enables re-read and write-back)
2. Drag-and-drop
3. `<input type="file">`

After file acquisition, detect file type (COPC vs LAS vs LAZ) by reading header bytes.
Output a unified `DatasetDescriptor` with: file type, size, point format, total points, coordinate bounds, available attributes, CRS info.

## ActiveForm

Building file access layer

## Dependencies

- **blocked by**: (none)
- **blocks**: FEAT-003, FEAT-008

## Notes

File System Access API is Chromium-only. Must provide drag-drop fallback for Firefox/Safari.
