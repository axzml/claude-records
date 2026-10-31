// Muted mid-tones that read on both the paper and graphite schemes
const PALETTE = ['#b4532a', '#6f8f73', '#7d7aa8', '#c29a3f', '#5d7f9c', '#a0675a', '#4f8f8f', '#9a6f9e']

/** Stable colour for a project name, used for the small dots that tell projects apart. */
export function projectColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}
