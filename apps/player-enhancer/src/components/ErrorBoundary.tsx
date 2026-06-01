import { Component, type ReactNode } from 'react'

interface Props { fallback?: ReactNode; children: ReactNode }
interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }
  static getDerivedStateFromError(e: Error) { return { hasError: true, error: e } }
  render() {
    if (this.state.hasError) return this.props.fallback ?? <div style={{ padding: 16, color: '#ef4444', fontSize: 13 }}>
      {this.state.error?.message ?? 'Something went wrong'}
    </div>
    return this.props.children
  }
}
