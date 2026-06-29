import { AlertStrip, Card, EmptyState } from "../ds";
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
    <Card className="flex flex-col">
      <h3 className="truncate text-sm font-semibold text-ink" title={project.label}>
        {lastSegment(project.label)}
      </h3>
      <p className="mt-1 truncate font-mono text-xs text-ink-faint" title={project.label}>
        {project.label}
      </p>
      <div className="mt-4 flex items-center gap-x-3 text-xs text-ink-faint">
        <span className="inline-flex items-center rounded-md bg-ok/12 px-2 py-0.5 font-medium text-ok ring-1 ring-ok/20">
          {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
        </span>
        <span className="ml-auto shrink-0">{timeAgo(project.lastActivity)}</span>
      </div>
    </Card>
  );
}

export default function Projects() {
  const { projects, loading, error } = useProjects();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <h2 className="text-xl font-semibold text-ink">Projects</h2>
        <p className="mt-1 text-sm text-ink-faint">
          Working directories Claude Code has sessions for
        </p>
      </header>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Projects" message={`Couldn't load projects: ${error}`} />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading projects…</p>
      ) : projects.length === 0 ? (
        <EmptyState>No projects found yet.</EmptyState>
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
