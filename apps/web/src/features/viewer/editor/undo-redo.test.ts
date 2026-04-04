import type { EditOperation } from './edit-log'
import { describe, expect, it } from 'vitest'
import {
  activeEntries,
  applyEdit,
  canRedo,
  canUndo,
  createEditSession,
  redo,
  undo,
} from './undo-redo'

const deleteOp: EditOperation = {
  type: 'deleteBySelection',
  masks: [{ tileId: 't1', mask: new Uint8Array([1, 0, 1]) }],
}

const keepOp: EditOperation = {
  type: 'keepByAABB',
  bounds: { min: [0, 0, 0], max: [5, 5, 5] },
}

const classOp: EditOperation = {
  type: 'filterByClassification',
  classes: [2, 6],
}

describe('undoRedo', () => {
  describe('createEditSession', () => {
    it('starts empty with pointer at 0', () => {
      const s = createEditSession()
      expect(s.entries).toHaveLength(0)
      expect(s.pointer).toBe(0)
      expect(canUndo(s)).toBe(false)
      expect(canRedo(s)).toBe(false)
    })
  })

  describe('applyEdit', () => {
    it('appends an entry and advances pointer', () => {
      const s0 = createEditSession()
      const s1 = applyEdit(s0, deleteOp)

      expect(s1.entries).toHaveLength(1)
      expect(s1.pointer).toBe(1)
      expect(s1.entries[0]!.operation).toEqual(deleteOp)
    })

    it('preserves immutability', () => {
      const s0 = createEditSession()
      const s1 = applyEdit(s0, deleteOp)

      expect(s0.entries).toHaveLength(0)
      expect(s1.entries).toHaveLength(1)
    })
  })

  describe('undo', () => {
    it('moves pointer back', () => {
      let s = createEditSession()
      s = applyEdit(s, deleteOp)
      s = applyEdit(s, keepOp)

      expect(s.pointer).toBe(2)

      s = undo(s)
      expect(s.pointer).toBe(1)
      expect(activeEntries(s)).toHaveLength(1)

      s = undo(s)
      expect(s.pointer).toBe(0)
      expect(activeEntries(s)).toHaveLength(0)
    })

    it('does nothing when already at start', () => {
      const s = createEditSession()
      const after = undo(s)
      expect(after).toBe(s)
    })
  })

  describe('redo', () => {
    it('moves pointer forward after undo', () => {
      let s = createEditSession()
      s = applyEdit(s, deleteOp)
      s = applyEdit(s, keepOp)
      s = undo(s)
      s = undo(s)

      expect(canRedo(s)).toBe(true)

      s = redo(s)
      expect(s.pointer).toBe(1)
      expect(activeEntries(s)).toHaveLength(1)

      s = redo(s)
      expect(s.pointer).toBe(2)
      expect(activeEntries(s)).toHaveLength(2)
    })

    it('does nothing when no redo available', () => {
      let s = createEditSession()
      s = applyEdit(s, deleteOp)
      const after = redo(s)
      expect(after).toBe(s)
    })
  })

  describe('truncation', () => {
    it('new edit after undo truncates redo history', () => {
      let s = createEditSession()
      s = applyEdit(s, deleteOp)
      s = applyEdit(s, keepOp)
      s = undo(s) // pointer at 1, keepOp is in redo

      s = applyEdit(s, classOp) // should truncate keepOp

      expect(s.entries).toHaveLength(2)
      expect(s.pointer).toBe(2)
      expect(s.entries[0]!.operation).toEqual(deleteOp)
      expect(s.entries[1]!.operation).toEqual(classOp)
      expect(canRedo(s)).toBe(false)
    })
  })

  describe('activeEntries', () => {
    it('returns entries up to pointer', () => {
      let s = createEditSession()
      s = applyEdit(s, deleteOp)
      s = applyEdit(s, keepOp)
      s = applyEdit(s, classOp)
      s = undo(s) // pointer at 2

      const active = activeEntries(s)
      expect(active).toHaveLength(2)
      expect(active[0]!.operation).toEqual(deleteOp)
      expect(active[1]!.operation).toEqual(keepOp)
    })
  })
})
