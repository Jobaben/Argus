import { useProjects, type Project } from "../useProjects";

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function lastSegment(label: string): string {
  const seg = label.split(/[\\/]/).filter(Boolean).pop();
  return seg ?? label;
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <div className="flex flex-col rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-white/20 hover:bg-white/[0.05]">
      <h3 className="truncate text-sm font-semibold text-white" title={project.label}>
        {lastSegment(project.label)}
      </h3>
      <p className="mt-1 truncate font-mono text-xs text-sky-300/70" title={project.label}>
        {project.label}
      </p>
      <div className="mt-4 flex items-center gap-x-3 text-xs text-white/40">
        <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-300 ring-1 ring-emerald-500/20">
          {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
        </span>
        <span className="ml-auto shrink-0">{timeAgo(project.lastActivity)}</span>
      </div>
    </div>
  );
}

export default function Projects() {
  const { projects, loading, error } = useProjects();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <h2 className="text-xl font-semibold text-white">Projects</h2>
        <p className="mt-1 text-sm text-white/45">
          Working directories Claude Code has sessions for
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t load projects: {error}
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading projects…</p>
      ) : projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No projects found yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
