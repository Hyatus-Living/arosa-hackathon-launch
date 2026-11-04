// Fiber's manual advance uses seconds, while browser performance timestamps use milliseconds.
export function advanceWalkClock(advance, milliseconds = performance.now()) {
  advance(milliseconds / 1000);
}

// A display-synchronized loop, suspended when the page is hidden.
export function startWalkClock(advance, {document, requestAnimationFrame, cancelAnimationFrame}) {
  let frame;
  const tick = timestamp => {
    advanceWalkClock(advance, timestamp);
    frame = requestAnimationFrame(tick);
  };
  const visibility = () => {
    cancelAnimationFrame(frame);
    if (document.visibilityState === 'visible') frame = requestAnimationFrame(tick);
  };
  document.addEventListener('visibilitychange', visibility);
  visibility();
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', visibility);
  };
}
