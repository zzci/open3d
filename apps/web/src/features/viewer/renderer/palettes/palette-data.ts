// ---------------------------------------------------------------------------
// Production color palette data — 256x1 RGBA Float32 lookup tables
// ---------------------------------------------------------------------------

/** A color stop for linear interpolation: [position 0-1, R, G, B] */
type ColorStop = readonly [number, number, number, number]

/**
 * Build a 256-entry RGBA Float32Array from color stops via linear interpolation.
 * Each entry is [R, G, B, A] in 0-1 range. Alpha is always 1.0.
 */
function buildFromStops(stops: readonly ColorStop[]): Float32Array {
  const size = 256
  const data = new Float32Array(size * 4)

  for (let i = 0; i < size; i++) {
    const t = i / (size - 1)
    // Find surrounding stops
    let lo = 0
    let hi = stops.length - 1
    for (let s = 0; s < stops.length - 1; s++) {
      if (stops[s + 1]![0] >= t) {
        lo = s
        hi = s + 1
        break
      }
    }
    const loStop = stops[lo]!
    const hiStop = stops[hi]!
    const range = hiStop[0] - loStop[0]
    const f = range > 0 ? (t - loStop[0]) / range : 0

    const base = i * 4
    data[base] = loStop[1] + (hiStop[1] - loStop[1]) * f
    data[base + 1] = loStop[2] + (hiStop[2] - loStop[2]) * f
    data[base + 2] = loStop[3] + (hiStop[3] - loStop[3]) * f
    data[base + 3] = 1.0
  }

  return data
}

// ---------------------------------------------------------------------------
// Grayscale — linear black to white
// ---------------------------------------------------------------------------

export function buildGrayscale(): Float32Array {
  const size = 256
  const data = new Float32Array(size * 4)
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1)
    const base = i * 4
    data[base] = t
    data[base + 1] = t
    data[base + 2] = t
    data[base + 3] = 1.0
  }
  return data
}

// ---------------------------------------------------------------------------
// Viridis — perceptually uniform, dark purple → teal → yellow
// Reference: matplotlib viridis, sampled at 17 stops
// ---------------------------------------------------------------------------

const VIRIDIS_STOPS: readonly ColorStop[] = [
  [0.000, 0.267, 0.004, 0.329],
  [0.063, 0.283, 0.035, 0.420],
  [0.125, 0.277, 0.118, 0.478],
  [0.188, 0.254, 0.198, 0.516],
  [0.250, 0.222, 0.268, 0.533],
  [0.313, 0.191, 0.333, 0.535],
  [0.375, 0.163, 0.395, 0.525],
  [0.438, 0.139, 0.456, 0.506],
  [0.500, 0.122, 0.514, 0.479],
  [0.563, 0.118, 0.571, 0.443],
  [0.625, 0.139, 0.627, 0.398],
  [0.688, 0.208, 0.681, 0.341],
  [0.750, 0.329, 0.731, 0.267],
  [0.813, 0.478, 0.773, 0.176],
  [0.875, 0.647, 0.808, 0.090],
  [0.938, 0.825, 0.835, 0.063],
  [1.000, 0.993, 0.906, 0.144],
]

export function buildViridis(): Float32Array {
  return buildFromStops(VIRIDIS_STOPS)
}

// ---------------------------------------------------------------------------
// Turbo — Google's improved rainbow, dark blue → cyan → green → yellow → red
// Reference: Turbo colormap (Mikhailov 2019), sampled at 17 stops
// ---------------------------------------------------------------------------

const TURBO_STOPS: readonly ColorStop[] = [
  [0.000, 0.190, 0.072, 0.232],
  [0.063, 0.234, 0.171, 0.536],
  [0.125, 0.244, 0.296, 0.790],
  [0.188, 0.199, 0.431, 0.960],
  [0.250, 0.118, 0.565, 0.997],
  [0.313, 0.044, 0.688, 0.913],
  [0.375, 0.029, 0.790, 0.733],
  [0.438, 0.118, 0.868, 0.530],
  [0.500, 0.302, 0.921, 0.341],
  [0.563, 0.510, 0.949, 0.186],
  [0.625, 0.707, 0.943, 0.084],
  [0.688, 0.867, 0.893, 0.043],
  [0.750, 0.971, 0.800, 0.054],
  [0.813, 0.996, 0.665, 0.053],
  [0.875, 0.948, 0.497, 0.042],
  [0.938, 0.840, 0.308, 0.021],
  [1.000, 0.660, 0.133, 0.008],
]

export function buildTurbo(): Float32Array {
  return buildFromStops(TURBO_STOPS)
}

// ---------------------------------------------------------------------------
// Inferno — perceptually uniform, black → purple → orange → yellow → white
// Reference: matplotlib inferno, sampled at 17 stops
// ---------------------------------------------------------------------------

const INFERNO_STOPS: readonly ColorStop[] = [
  [0.000, 0.001, 0.000, 0.014],
  [0.063, 0.028, 0.017, 0.130],
  [0.125, 0.106, 0.030, 0.310],
  [0.188, 0.206, 0.039, 0.428],
  [0.250, 0.316, 0.050, 0.461],
  [0.313, 0.424, 0.057, 0.450],
  [0.375, 0.530, 0.069, 0.407],
  [0.438, 0.631, 0.099, 0.339],
  [0.500, 0.724, 0.148, 0.263],
  [0.563, 0.806, 0.216, 0.185],
  [0.625, 0.873, 0.302, 0.114],
  [0.688, 0.926, 0.403, 0.053],
  [0.750, 0.961, 0.516, 0.012],
  [0.813, 0.975, 0.640, 0.039],
  [0.875, 0.970, 0.770, 0.186],
  [0.938, 0.957, 0.893, 0.414],
  [1.000, 0.988, 0.998, 0.645],
]

export function buildInferno(): Float32Array {
  return buildFromStops(INFERNO_STOPS)
}

// ---------------------------------------------------------------------------
// Plasma — perceptually uniform, dark purple → magenta → orange → yellow
// Reference: matplotlib plasma, sampled at 17 stops
// ---------------------------------------------------------------------------

const PLASMA_STOPS: readonly ColorStop[] = [
  [0.000, 0.050, 0.030, 0.528],
  [0.063, 0.155, 0.017, 0.590],
  [0.125, 0.260, 0.012, 0.616],
  [0.188, 0.356, 0.010, 0.610],
  [0.250, 0.447, 0.018, 0.579],
  [0.313, 0.530, 0.034, 0.535],
  [0.375, 0.607, 0.057, 0.481],
  [0.438, 0.677, 0.089, 0.421],
  [0.500, 0.741, 0.131, 0.359],
  [0.563, 0.799, 0.180, 0.298],
  [0.625, 0.851, 0.237, 0.239],
  [0.688, 0.896, 0.302, 0.183],
  [0.750, 0.933, 0.377, 0.131],
  [0.813, 0.960, 0.462, 0.085],
  [0.875, 0.976, 0.560, 0.044],
  [0.938, 0.978, 0.672, 0.023],
  [1.000, 0.940, 0.975, 0.131],
]

export function buildPlasma(): Float32Array {
  return buildFromStops(PLASMA_STOPS)
}

// ---------------------------------------------------------------------------
// Cividis — colorblind-friendly, dark blue → grey → yellow
// Reference: matplotlib cividis, sampled at 17 stops
// ---------------------------------------------------------------------------

const CIVIDIS_STOPS: readonly ColorStop[] = [
  [0.000, 0.000, 0.135, 0.305],
  [0.063, 0.000, 0.167, 0.360],
  [0.125, 0.072, 0.206, 0.397],
  [0.188, 0.155, 0.246, 0.404],
  [0.250, 0.225, 0.286, 0.393],
  [0.313, 0.290, 0.327, 0.381],
  [0.375, 0.351, 0.369, 0.372],
  [0.438, 0.415, 0.411, 0.364],
  [0.500, 0.478, 0.453, 0.352],
  [0.563, 0.541, 0.496, 0.333],
  [0.625, 0.608, 0.541, 0.303],
  [0.688, 0.676, 0.586, 0.264],
  [0.750, 0.748, 0.634, 0.213],
  [0.813, 0.822, 0.684, 0.148],
  [0.875, 0.899, 0.736, 0.060],
  [0.938, 0.964, 0.793, 0.014],
  [1.000, 0.995, 0.864, 0.200],
]

export function buildCividis(): Float32Array {
  return buildFromStops(CIVIDIS_STOPS)
}
