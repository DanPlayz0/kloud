import { createRoot } from 'react-dom/client'
import { Lock } from 'lucide-react'
import QuickTip from '../../src/components/quickTip'
import '../../src/styles.css'

createRoot(document.getElementById('root')!).render(
  <main className="flex gap-8 p-8">
    <QuickTip instant portal content="Text tooltip">
      Plain text
    </QuickTip>
    <QuickTip instant portal content="SVG tooltip">
      <svg width="20" height="20" aria-label="Raw SVG" role="img">
        <circle cx="10" cy="10" r="8" fill="currentColor" />
      </svg>
    </QuickTip>
    <QuickTip instant portal content="Lucide tooltip">
      <Lock aria-label="Lucide icon" role="img" />
    </QuickTip>
    <QuickTip instant portal content="Link tooltip">
      <a href="#target">Native link</a>
    </QuickTip>
  </main>,
)
