import type { DatasetEntry } from './cache-manager'
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import {

  deleteCachedDataset,
  getMaxCacheSize,
  getTotalCacheSize,
  listCachedDatasets,
} from './cache-manager'

interface CacheManagerDialogProps {
  open: boolean
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  )
  const value = bytes / 1024 ** i
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function CacheManagerDialog({ open, onClose }: CacheManagerDialogProps) {
  const [datasets, setDatasets] = useState<DatasetEntry[]>([])
  const [totalSize, setTotalSize] = useState(0)
  const [deleting, setDeleting] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [list, total] = await Promise.all([
      listCachedDatasets(),
      getTotalCacheSize(),
    ])
    setDatasets(list.sort((a, b) => b.lastAccess - a.lastAccess))
    setTotalSize(total)
  }, [])

  useEffect(() => {
    if (open)
      refresh()
  }, [open, refresh])

  async function handleDelete(id: string) {
    setDeleting(id)
    await deleteCachedDataset(id)
    await refresh()
    setDeleting(null)
  }

  if (!open)
    return null

  const maxSize = getMaxCacheSize()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget)
          onClose()
      }}
    >
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-neutral-900">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Cache Manager
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 transition-colors hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
          {formatBytes(totalSize)}
          {' '}
          /
          {formatBytes(maxSize)}
          {' '}
          used
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                totalSize / maxSize > 0.9
                  ? 'bg-red-500'
                  : totalSize / maxSize > 0.7
                    ? 'bg-yellow-500'
                    : 'bg-blue-500',
              )}
              style={{ width: `${Math.min((totalSize / maxSize) * 100, 100)}%` }}
            />
          </div>
        </div>

        {datasets.length === 0
          ? (
              <p className="py-8 text-center text-sm text-neutral-400">
                No cached datasets
              </p>
            )
          : (
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {datasets.map(ds => (
                  <li
                    key={ds.id}
                    className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
                        {ds.fileName}
                      </p>
                      <p className="text-xs text-neutral-400">
                        {formatBytes(ds.cacheSize)}
                        {' \u00B7 '}
                        {new Date(ds.lastAccess).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDelete(ds.id)}
                      disabled={deleting === ds.id}
                      className="ml-3 rounded px-2 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {deleting === ds.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </div>
  )
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
