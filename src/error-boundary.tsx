import { Component, type ReactNode } from "react";

type Props = { area: string; children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[${this.props.area}]`, error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h2>{this.props.area} crashed</h2>
        <p>Cairn hit an unexpected error in this view.</p>
        <pre className="error-boundary-message">{this.state.error.message}</pre>
        <div className="error-boundary-actions">
          <button onClick={this.reset}>Try again</button>
          <button className="secondary" onClick={() => window.location.reload()}>
            Reload window
          </button>
        </div>
      </div>
    );
  }
}
