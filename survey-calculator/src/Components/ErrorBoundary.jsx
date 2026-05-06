import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack || '');
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          padding: '1rem',
          borderRadius: 10,
          border: '1px solid #fecaca',
          background: '#fef2f2',
          color: '#991b1b',
          margin: '0.5rem 0',
        }}
      >
        <div style={{ fontWeight: 700 }}>This panel failed to render.</div>
        <div style={{ marginTop: '0.35rem', fontSize: '0.9rem' }}>
          {this.state.error?.message || 'Unexpected rendering error.'}
        </div>
        <button
          type="button"
          style={{ marginTop: '0.75rem' }}
          onClick={() => this.setState({ hasError: false, error: null })}
        >
          Retry
        </button>
      </div>
    );
  }
}
