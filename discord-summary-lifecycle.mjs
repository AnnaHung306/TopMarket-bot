// Coordinates initialization and shutdown when a deployment is interrupted.
export function createSummaryLifecycle({ start, onError = () => {} }) {
  let startup;
  let stop;
  let closing;
  let stopped = false;
  return {
    start() {
      if (stopped || startup) return;
      startup = Promise.resolve().then(start).then(value => { stop = value; }).catch(onError);
    },
    close() {
      if (closing) return closing;
      stopped = true;
      closing = (async () => { if (startup) await startup; if (stop) await stop(); })();
      return closing;
    },
  };
}
