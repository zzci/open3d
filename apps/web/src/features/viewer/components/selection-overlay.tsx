// ---------------------------------------------------------------------------
// Selection rubber-band rectangle overlay
// Renders a semi-transparent box during drag selection.
// ---------------------------------------------------------------------------

export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

interface SelectionOverlayProps {
  rect: SelectionRect | null
}

export function SelectionOverlay({ rect }: SelectionOverlayProps) {
  if (!rect)
    return null

  return (
    <div
      className="pointer-events-none absolute border-2 border-yellow-400 bg-yellow-400/10"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }}
    />
  )
}
