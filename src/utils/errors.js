// Single place that surfaces errors to the user.
export function reportError(err) {
  alert('Error: ' + (err?.message || err));
}
