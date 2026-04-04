import type { DatasetDescriptor } from '../data/types'
import { useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { useFileAccess } from '../hooks/use-file-access'

interface FileOpenerProps {
  onFileLoaded: (descriptor: DatasetDescriptor) => void
  className?: string
}

export function FileOpener({ onFileLoaded, className }: FileOpenerProps) {
  const {
    isLoading,
    error,
    descriptor,
    inputRef,
    supportsFilePicker,
    openFilePicker,
    handleDrop,
    handleDragOver,
    handleInputChange,
    reset,
  } = useFileAccess()
  const [isDragOver, setIsDragOver] = useState(false)

  if (descriptor) {
    onFileLoaded(descriptor)
  }

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(true)
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault()
    if (e.currentTarget.contains(e.relatedTarget as Node))
      return
    setIsDragOver(false)
  }

  function onDrop(e: React.DragEvent) {
    setIsDragOver(false)
    handleDrop(e)
  }

  return (
    <div className={cn('flex flex-col items-center gap-4', className)}>
      <div
        onDrop={onDrop}
        onDragOver={handleDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        className={cn(
          'flex w-full max-w-lg flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors',
          isDragOver
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-neutral-300 dark:border-neutral-700',
          isLoading && 'pointer-events-none opacity-50',
        )}
      >
        <DropIcon className="h-10 w-10 text-neutral-400" />

        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Drag & drop a point cloud file here
        </p>

        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          .las, .laz, .copc.las
        </p>

        <div className="flex items-center gap-3 pt-2">
          {supportsFilePicker
            ? (
                <button
                  type="button"
                  onClick={openFilePicker}
                  disabled={isLoading}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {isLoading ? 'Reading...' : 'Browse Files'}
                </button>
              )
            : (
                <label className="cursor-pointer rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700">
                  {isLoading ? 'Reading...' : 'Browse Files'}
                  <input
                    ref={inputRef}
                    type="file"
                    accept=".las,.laz"
                    onChange={handleInputChange}
                    disabled={isLoading}
                    className="hidden"
                  />
                </label>
              )}
        </div>

        <input
          ref={supportsFilePicker ? inputRef : undefined}
          type="file"
          accept=".las,.laz"
          onChange={handleInputChange}
          className="hidden"
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-4 py-2 text-sm text-red-600 dark:text-red-400">
          <span>{error}</span>
          <button
            type="button"
            onClick={reset}
            className="ml-2 underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

function DropIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}
