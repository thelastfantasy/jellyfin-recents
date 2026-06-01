import { useAtomValue } from 'jotai'
import { framesAtom, modalPhaseAtom } from '../core/state'

function SkeletonCard() {
  return (
    <div className="jfs-fe-sk-card">
      <div className="jfs-fe-sk-img" />
      <div className="jfs-fe-sk-foot">
        <div className="jfs-fe-sk-line" />
      </div>
    </div>
  )
}

export function FrameGridSkeleton() {
  const frames = useAtomValue(framesAtom)
  const count = frames.length || 80
  return (
    <div className="jfs-fe-grid">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}

export function FrameGridPhaseGate({ children }: { children: React.ReactNode }) {
  const phase = useAtomValue(modalPhaseAtom)
  if (phase === 'skeleton') return <FrameGridSkeleton />
  return <>{children}</>
}
