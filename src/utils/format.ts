export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let val = bytes
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  return `${val >= 100 || idx < 2 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`
}

export function formatSpeed(bytesPerSec: number | null | undefined): string | null {
  if (!bytesPerSec || bytesPerSec <= 0) return null
  return `${formatBytes(bytesPerSec)}/s`
}
