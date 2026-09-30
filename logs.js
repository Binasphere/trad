/**
 * The last few hundred log lines, kept in memory for the admin System page.
 *
 * Console output still goes to Render's log stream as before; this only keeps
 * a copy. In-memory and per-instance, so a restart clears it — it answers
 * "what just happened", not "what happened last week".
 */

const MAX_LINES = 300;
const lines = [];

function capture(level, original) {
  return (...args) => {
    original(...args);
    const text = args
      .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
      .join(" ")
      .slice(0, 1000);
    lines.push({ at: new Date().toISOString(), level, text });
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  };
}

let installed = false;

/** Mirrors console.info/warn/error into the buffer. Idempotent. */
export function installLogBuffer() {
  if (installed) return;
  installed = true;
  console.log = capture("info", console.log.bind(console));
  console.info = capture("info", console.info.bind(console));
  console.warn = capture("warn", console.warn.bind(console));
  console.error = capture("error", console.error.bind(console));
}

/** Newest first. */
export function recentLogs(level) {
  const wanted = level && level !== "all" ? level : null;
  return lines.filter((l) => !wanted || l.level === wanted).slice().reverse();
}
