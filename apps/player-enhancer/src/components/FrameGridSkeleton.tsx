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

export function FrameGridSkeleton({ count = 48 }: { count?: number }) {
  return (
    <div className="jfs-fe-scroll">
      <div className="jfs-fe-grid">
        {Array.from({ length: count }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  )
}

export function FrameGridPhaseGate({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
