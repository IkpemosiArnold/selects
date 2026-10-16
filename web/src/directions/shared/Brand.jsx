import { tc } from "../../lib/time.js";

export function Brand() {
  return (
    <a className="dx-brand" href={"?" + new URLSearchParams(location.search).toString()} aria-label="Selects">
      <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true">
        <path d="M6 4H3v14h3M16 4h3v14h-3" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <rect x="8.5" y="8" width="5" height="6" fill="#f2be22" />
      </svg>
      <span>Selects</span>
    </a>
  );
}

export function FileLabel({ job }) {
  if (!job) return null;
  return (
    <span className="dx-file">
      <span className="dx-file-name">{job.source?.name}</span>{" "}
      <span className="dx-file-dur">{tc(job.source?.duration)}</span>
    </span>
  );
}

export function Loading({ error, className }) {
  return (
    <main className={className} aria-busy={!error}>
      <p style={{ padding: 32, fontFamily: "var(--mono)" }}>{error ? `This job could not be opened. ${error.message}` : "Opening the job"}</p>
    </main>
  );
}
