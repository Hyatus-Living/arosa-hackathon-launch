// A view (3D model, walkthrough, plan editor) that fails while rendering collapses to one line with Retry in its place, instead of
// leaving an empty viewer. Retry mounts the view again from scratch.
import React from 'react';

export class LoadBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {failed: false, attempt: 0};
  }
  static getDerivedStateFromError() {
    return {failed: true};
  }
  componentDidCatch(error) {
    console.warn('[acres] view failed', error);
  }
  render() {
    if (!this.state.failed) return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
    return (
      <div className="core-fail" role="status">
        <span className="core-fail-text">{this.props.message}</span>
        <button type="button" className="core-follow" onClick={() => this.setState((s) => ({failed: false, attempt: s.attempt + 1}))}>Retry</button>
      </div>
    );
  }
}
