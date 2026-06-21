import React, { useState } from 'react'

interface Props {
  pageIndex: number
  totalPages: number
  totalCount: number
  onPageChange: (index: number) => void
}

export function Pagination({ pageIndex, totalPages, totalCount, onPageChange }: Props) {
  const [jumpInput, setJumpInput] = useState('')

  if (totalPages <= 1) return null

  const isFirst = pageIndex === 0
  const isLast = pageIndex >= totalPages - 1

  function handleJump(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    const n = parseInt(jumpInput, 10)
    if (isNaN(n) || n < 1 || n > totalPages) return
    onPageChange(n - 1)
    setJumpInput('')
  }

  return (
    <nav className="jfs-pagination" aria-label="分页导航">
      <div className="jfs-pagination__btns">
        <button
          className="jfs-pagination__btn jfs-pagination__btn--icon"
          disabled={isFirst}
          onClick={() => onPageChange(0)}
          title="第一页"
        >⏮</button>
        <button
          className="jfs-pagination__btn"
          disabled={isFirst}
          onClick={() => onPageChange(pageIndex - 1)}
          aria-label="上一页"
        >← 上一页</button>
      </div>

      <div className="jfs-pagination__center">
        <div className="jfs-pagination__page-row">
          <span className="jfs-pagination__page">第 {pageIndex + 1} / {totalPages} 页</span>
          <span className="jfs-pagination__sep">·</span>
          <span className="jfs-pagination__count">共 {totalCount} 条</span>
        </div>
        <div className="jfs-pagination__jump">
          跳转到第
          <input
            className="jfs-pagination__jump-input"
            type="number"
            min={1}
            max={totalPages}
            value={jumpInput}
            onInput={(e) => setJumpInput((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={handleJump}
            aria-label="跳转页码"
          />
          页
        </div>
      </div>

      <div className="jfs-pagination__btns">
        <button
          className="jfs-pagination__btn"
          disabled={isLast}
          onClick={() => onPageChange(pageIndex + 1)}
          aria-label="下一页"
        >下一页 →</button>
        <button
          className="jfs-pagination__btn jfs-pagination__btn--icon"
          disabled={isLast}
          onClick={() => onPageChange(totalPages - 1)}
          title="最后一页"
        >⏭</button>
      </div>
    </nav>
  )
}
