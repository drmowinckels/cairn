import { Popover } from "./views/popover";
import { ErrorBoundary } from "./error-boundary";

function App() {
  return (
    <ErrorBoundary area="Popover">
      <Popover />
    </ErrorBoundary>
  );
}

export default App;
