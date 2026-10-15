import { useCallback, useEffect, useRef, useState } from "react";
import { api, isMock } from "./lib/api.js";
import { tc } from "./lib/time.js";
import NewJob from "./components/NewJob.jsx";
import Processing from "./components/Processing.jsx";
import Review from "./components/Review.jsx";
import RenderScreen from "./components/RenderScreen.jsx";

function useHashRoute() {
  const parse = () => {
    const m = location.hash.match(/^#\/job\/([\w-]+)(?:\/(\w+))?/);
    return m ? { jobId: m[1], view: m[2] || null } : { jobId: null, view: null };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (hash) => {
  if (location.hash !== hash) location.hash = hash;
};

function readTheme() {
  const q = new URLSearchParams(location.search).get("theme");
  if (q === "dark" || q === "light") return q;
  try {
    return localStorage.getItem("selects-theme") || "auto";
  } catch {
    return "auto";
  }
}

function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "auto") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
  }, [theme]);
  const choose = (t) => {
    setTheme(t);
    try {
      localStorage.setItem("selects-theme", t);
    } catch {}
  };
  const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "auto" && systemDark);
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-pressed={dark}
      onClick={() => choose(dark ? "light" : "dark")}
      title={dark ? "Switch to the light table" : "Switch to the editing bay"}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M9 2.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" />
      </svg>
      <span>{dark ? "Editing bay" : "Light table"}</span>
    </button>
  );
}

// File names differ at the end ("...-v2.mp4" vs "...-v3.mp4"), so they
// truncate in the middle and keep the tail visible.
export function MiddleTruncate({ text = "", tail = 16 }) {
  if (text.length <= tail + 8) return <span className="mt-head">{text}</span>;
  return (
    <>
      <span className="mt-head">{text.slice(0, -tail)}</span>
      <span className="mt-tail">{text.slice(-tail)}</span>
    </>
  );
}

export function Masthead({ job, children }) {
  return (
    <header className="masthead">
      <a className="brand" href="#/" aria-label="Selects, new job">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <path d="M6 4H3v14h3M16 4h3v14h-3" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <rect x="8.5" y="8" width="5" height="6" fill="var(--yellow)" />
        </svg>
        <span>Selects</span>
      </a>
      {job && (
        <div className="masthead-file">
          <span className="file-name" title={job.source?.path}>
            <MiddleTruncate text={job.source?.name} />
          </span>
          <span className="mono dim">{tc(job.source?.duration)}</span>
        </div>
      )}
      <div className="masthead-right">
        {children}
        {isMock && <span className="mock-flag" title="Running against the built-in demo data">Demo data</span>}
        <ThemeToggle />
      </div>
    </header>
  );
}

const STAGE_KEY = { probing: "probe", transcribing: "transcribe", candidates: "candidates", judging: "judge", rendering: "render" };

function JobView({ jobId, view }) {
  const [job, setJob] = useState(null);
  const [words, setWords] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const jobRef = useRef(null);
  jobRef.current = job;

  const refetch = useCallback(async () => {
    const j = await api.getJob(jobId);
    setJob(j);
    return j;
  }, [jobId]);

  useEffect(() => {
    let alive = true;
    setJob(null);
    setWords([]);
    setLoadError(null);
    (async () => {
      try {
        const j = await api.getJob(jobId);
        if (!alive) return;
        setJob(j);
        const w = await api.getWords(jobId).catch(() => []);
        if (alive) setWords(w || []);
      } catch (e) {
        if (alive) setLoadError(e);
      }
    })();
    const off = api.events(jobId, (type, data) => {
      if (!alive) return;
      if (type === "job" && data?.id) {
        setJob(data);
      } else if (type === "words" && Array.isArray(data)) {
        setWords((w) => w.concat(data));
      } else if (type === "progress" && data) {
        // Core sends { name: "transcribe", ...StageState, speed }; the mock sends { stage }.
        const key = data.name || STAGE_KEY[data.stage] || data.stage;
        if (!key) return;
        const { name, stage, ...state } = data;
        setJob((j) => (j ? { ...j, stages: { ...j.stages, [key]: { ...j.stages?.[key], ...state } } } : j));
      } else if (type === "stage" && data) {
        if (data.id && data.stages) setJob(data);
        else
          setJob((j) => {
            if (!j) return j;
            const next = { ...j };
            if (data.stage) next.stage = data.stage;
            if (data.stages) next.stages = data.stages;
            if (data.name && data.state) next.stages = { ...j.stages, [data.name]: data.state };
            if ("error" in data) next.error = data.error;
            return next;
          });
        if (data.stage === "ready" || data.stage === "done") refetch();
      } else if (type === "candidates") {
        refetch();
        api.getWords(jobId).then((w) => alive && w && setWords(w)).catch(() => {});
      } else if (type === "render" && data) {
        setJob((j) => {
          if (!j) return j;
          const { id, title, caption, hashtags, ...render } = data;
          return {
            ...j,
            candidates: j.candidates.map((c) =>
              c.id === id ? { ...c, render: { ...c.render, ...render }, ...(title ? { title, caption, hashtags } : {}) } : c
            ),
          };
        });
      } else if (type === "error" && data) {
        setJob((j) => (j ? { ...j, stage: "error", error: data } : j));
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [jobId, refetch]);

  const updateCandidate = useCallback((c) => {
    setJob((j) => (j ? { ...j, candidates: j.candidates.map((x) => (x.id === c.id ? { ...x, ...c } : x)) } : j));
  }, []);

  if (loadError) {
    return (
      <>
        <Masthead />
        <main className="page notice-page">
          <h1 className="h-24">This job could not be opened</h1>
          <p className="lede">{loadError.status === 404 ? "There is no job with that id on this laptop." : loadError.message}</p>
          <a className="btn" href="#/">Start a new job</a>
        </main>
      </>
    );
  }
  if (!job) {
    return (
      <>
        <Masthead />
        <main className="page loading-page" aria-busy="true">
          <p className="mono dim">Opening the reel</p>
        </main>
      </>
    );
  }

  const processing = ["queued", "probing", "transcribing", "candidates", "judging"].includes(job.stage) ||
    (job.stage === "error" && job.error?.stage !== "render" && !job.candidates?.length);
  if (processing) return <Processing job={job} words={words} onResume={async () => {
    await api.resume(jobId);
    await refetch();
  }} />;

  const renderView = view === "render" || (job.stage === "rendering" && view !== "review");
  if (renderView || (job.stage === "done" && view !== "review")) {
    return <RenderScreen job={job} />;
  }
  return <Review job={job} words={words} onCandidate={updateCandidate} onRender={async (ids) => {
    await api.render(job.id, ids);
    setJob((j) => ({ ...j, stage: "rendering", candidates: j.candidates.map((c) => (ids.includes(c.id) ? { ...c, render: { status: "pending", progress: 0 } } : c)) }));
    go(`#/job/${job.id}/render`);
  }} />;
}

export default function App() {
  const { jobId, view } = useHashRoute();
  return jobId ? <JobView key={jobId} jobId={jobId} view={view} /> : <NewJob />;
}
