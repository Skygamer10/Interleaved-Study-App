// Small consistent line-icon set (1.5px strokes, 16px grid). No emoji.
import type { ReactElement } from 'react'

type P = { size?: number; className?: string }
const S = ({ size = 16, className, children }: P & { children: ReactElement | ReactElement[] }): ReactElement => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}
    strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{children}</svg>
)

export const Icon = {
  play: (p: P) => <S {...p}><path d="M5 3.5v9l7-4.5z" /></S>,
  pause: (p: P) => <S {...p}><path d="M5.5 3.5v9M10.5 3.5v9" /></S>,
  skip: (p: P) => <S {...p}><path d="M4 3.5l6 4.5-6 4.5zM12 3.5v9" /></S>,
  stop: (p: P) => <S {...p}><rect x="4" y="4" width="8" height="8" rx="1" /></S>,
  plus: (p: P) => <S {...p}><path d="M8 3v10M3 8h10" /></S>,
  search: (p: P) => <S {...p}><circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2L13.5 13.5" /></S>,
  chevron: (p: P) => <S {...p}><path d="M6 4l4 4-4 4" /></S>,
  close: (p: P) => <S {...p}><path d="M4 4l8 8M12 4l-8 8" /></S>,
  check: (p: P) => <S {...p}><path d="M3.5 8.5l3 3 6-7" /></S>,
  edit: (p: P) => <S {...p}><path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z" /></S>,
  trash: (p: P) => <S {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></S>,
  merge: (p: P) => <S {...p}><path d="M4 3v3.5a3 3 0 003 3h1M12 3v3.5a3 3 0 01-3 3H8v4M6 11.5l2 2 2-2" /></S>,
  split: (p: P) => <S {...p}><path d="M8 13V9.5M8 9.5L4 5.5V3M8 9.5l4-4V3M2.5 4.5L4 3l1.5 1.5M10.5 4.5L12 3l1.5 1.5" /></S>,
  upload: (p: P) => <S {...p}><path d="M8 11V3M5 6l3-3 3 3M3 11v2h10v-2" /></S>,
  download: (p: P) => <S {...p}><path d="M8 3v8M5 8l3 3 3-3M3 11v2h10v-2" /></S>,
  refresh: (p: P) => <S {...p}><path d="M12.5 6A4.75 4.75 0 103.6 9.8M12.5 3v3h-3" /></S>,
  clock: (p: P) => <S {...p}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></S>,
  calendar: (p: P) => <S {...p}><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></S>,
  layers: (p: P) => <S {...p}><path d="M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8L8 11l5.5-3M2.5 10.5L8 13.5l5.5-3" /></S>,
  sliders: (p: P) => <S {...p}><path d="M3 4.5h6M12 4.5h1M3 11.5h1M7 11.5h6" /><circle cx="10.5" cy="4.5" r="1.5" /><circle cx="5.5" cy="11.5" r="1.5" /></S>,
  flag: (p: P) => <S {...p}><path d="M4 14V2.5M4 3h7.5l-1.5 3 1.5 3H4" /></S>,
  sparkle: (p: P) => <S {...p}><path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.5 4.5l1.5 1.5M10 10l1.5 1.5M11.5 4.5L10 6M6 10l-1.5 1.5" /></S>,
  more: (p: P) => <S {...p}><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.2} /></S>,
  grip: (p: P) => <S {...p}><path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" strokeWidth={2} /></S>,
  folderPlus: (p: P) => <S {...p}><path d="M2.5 4.5V12a1 1 0 001 1h9a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5h-3a1 1 0 00-1 1zM8 7.2v3.6M6.2 9h3.6" /></S>,
  folder: (p: P) => <S {...p}><path d="M2.5 4.5V12a1 1 0 001 1h9a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5h-3a1 1 0 00-1 1z" /></S>,
  file: (p: P) => <S {...p}><path d="M4 2.5h5l3 3V13a.5.5 0 01-.5.5h-7.5a.5.5 0 01-.5-.5V3a.5.5 0 01.5-.5zM9 2.5V5.5h3" /></S>,
  target: (p: P) => <S {...p}><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2.5" /></S>,
  quiz: (p: P) => <S {...p}><circle cx="8" cy="8" r="5.5" /><path d="M6.4 6.3a1.7 1.7 0 113 1.1c-.6.4-1.4.8-1.4 1.7M8 11.2v.1" /></S>
}
