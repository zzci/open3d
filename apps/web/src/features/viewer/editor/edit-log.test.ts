import type { EditOperation } from './edit-log'
import { describe, expect, it } from 'vitest'
import {
  appendEntry,
  createEditLog,
  deserializeEntry,
  serializeEntry,
} from './edit-log'

describe('editLog', () => {
  describe('createEditLog', () => {
    it('creates an empty log', () => {
      const log = createEditLog()
      expect(log.entries).toHaveLength(0)
    })
  })

  describe('appendEntry', () => {
    it('appends a deleteBySelection operation', () => {
      const log = createEditLog()
      const op: EditOperation = {
        type: 'deleteBySelection',
        masks: [{ tileId: 'tile-1', mask: new Uint8Array([1, 0, 1]) }],
      }
      const next = appendEntry(log, op)

      expect(next.entries).toHaveLength(1)
      expect(next.entries[0]!.operation).toEqual(op)
      expect(next.entries[0]!.affectedTileIds).toEqual(['tile-1'])
      expect(next.entries[0]!.cameraState).toBeNull()
    })

    it('appends with camera state', () => {
      const log = createEditLog()
      const op: EditOperation = { type: 'keepByAABB', bounds: { min: [0, 0, 0], max: [1, 1, 1] } }
      const cam = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number] }
      const next = appendEntry(log, op, cam)

      expect(next.entries[0]!.cameraState).toEqual(cam)
    })

    it('preserves immutability', () => {
      const log = createEditLog()
      const op: EditOperation = { type: 'filterByClassification', classes: [2, 6] }
      const next = appendEntry(log, op)

      expect(log.entries).toHaveLength(0)
      expect(next.entries).toHaveLength(1)
    })

    it('parametric operations have empty affectedTileIds', () => {
      const log = createEditLog()
      const ops: EditOperation[] = [
        { type: 'keepByAABB', bounds: { min: [0, 0, 0], max: [1, 1, 1] } },
        { type: 'filterByClassification', classes: [2] },
        { type: 'filterByRange', attribute: 'intensity', min: 0, max: 100 },
      ]
      for (const op of ops) {
        const next = appendEntry(log, op)
        expect(next.entries[0]!.affectedTileIds).toEqual([])
      }
    })
  })

  describe('serialization', () => {
    const operations: EditOperation[] = [
      {
        type: 'deleteBySelection',
        masks: [
          { tileId: 't1', mask: new Uint8Array([0, 1, 1, 0]) },
          { tileId: 't2', mask: new Uint8Array([1, 0]) },
        ],
      },
      { type: 'keepByAABB', bounds: { min: [0, 0, 0], max: [10, 10, 10] } },
      { type: 'filterByClassification', classes: [2, 6, 9] },
      { type: 'filterByRange', attribute: 'intensity', min: 50, max: 200 },
    ]

    for (const op of operations) {
      it(`round-trips ${op.type}`, () => {
        let log = createEditLog()
        const cam = { position: [1, 2, 3] as [number, number, number], target: [4, 5, 6] as [number, number, number] }
        log = appendEntry(log, op, cam)
        const entry = log.entries[0]!

        const serialized = serializeEntry(entry)
        const deserialized = deserializeEntry(serialized)

        expect(deserialized.id).toBe(entry.id)
        expect(deserialized.timestamp).toBe(entry.timestamp)
        expect(deserialized.cameraState).toEqual(cam)
        expect(deserialized.operation.type).toBe(op.type)

        if (op.type === 'deleteBySelection' && deserialized.operation.type === 'deleteBySelection') {
          expect(deserialized.operation.masks).toHaveLength(op.masks.length)
          for (let i = 0; i < op.masks.length; i++) {
            expect(deserialized.operation.masks[i]!.tileId).toBe(op.masks[i]!.tileId)
            expect(Array.from(deserialized.operation.masks[i]!.mask)).toEqual(Array.from(op.masks[i]!.mask))
          }
        }
        else {
          expect(deserialized.operation).toEqual(op)
        }
      })
    }
  })
})
