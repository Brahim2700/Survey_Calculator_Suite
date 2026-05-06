import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, copied: false };
    this._handleCopy = this._handleCopy.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error, copied: false };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack || '');
  }

  _handleCopy() {
    const text = [
      this.props.label ? `Component: ${this.props.label}` : '',
      `Error: ${this.state.error?.message || 'Unexpected rendering error.'}`,
      this.state.error?.stack || '',
    ].filter(Boolean).join('\n');

    navigator.clipboard?.writeText(text).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const label = this.props.label || 'This panel';

    return (
      <div
        role="alert"
        style={{
          padding: '1rem 1.1rem',
          borderRadius: 10,
          border: '1px solid #fca5a5',
          background: 'linear-gradient(135deg, #fef2f2 0%, #fff1f1 100%)',
          color: '#7f1d1d',
          margin: '0.5rem 0',
          fontFamily: 'inherit',
        }}
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.45rem' }}>
          <span style={{ fontSize: '1.1rem' }} aria-hidden="true">⚠️</span>
          <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#991b1b' }}>
            {label} failed to render
          </span>
        </div>

        {/* Error message */}
        <div style={{
          fontSize: '0.85rem',
          color: '#b91c1c',
          background: '#fee2e2',
          borderRadius: 6,
          padding: '0.45rem 0.65rem',
          marginBottom: '0.75rem',
          fontFamily: 'monospace',
          wordBreak: 'break-word',
        }}>
          {this.state.error?.message || 'Unexpected rendering error.'}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            style={{
              padding: '0.35rem 0.85rem',
              borderRadius: 6,
              border: '1px solid #fca5a5',
              background: '#fff',
              color: '#991b1b',
              fontWeight: 600,
              fontSize: '0.82rem',
              cursor: 'pointer',
            }}
            onClick={() => this.setState({ hasError: false, error: null, copied: false })}
          >
            ↩ Retry
          </button>
          {navigator.clipboard && (
            <button
              type="button"
              style={{
                padding: '0.35rem 0.85rem',
                borderRadius: 6,
                border: '1px solid #fca5a5',
                background: this.state.copied ? '#dcfce7' : '#fff',
                color: this.state.copied ? '#166534' : '#6b7280',
                fontWeight: 600,
                fontSize: '0.82rem',
                cursor: 'pointer',
                transition: 'background 0.2s',
              }}
              onClick={this._handleCopy}
            >
              {this.state.copied ? '✓ Copied' : '📋 Copy error'}
            </button>
          )}
        </div>
      </div>
    );
  }
}
