import { AlertStrip, Card, EmptyState, Loading, Page, SkeletonGrid, TimeAgo } from "../ds";
import { useProjects, type Project } from "../useProjects";

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
        <span className="ml-auto shrink-0">
          <TimeAgo iso={project.lastActivity} />
        </span>
      </div>
    </Card>
  );
}

export default function Projects() {
  const { projects, loading, error } = useProjects();

  return (
    <Page title="Projects">
      <p className="mb-6 text-sm text-ink-faint">
        Working directories Claude Code has sessions for
      </p>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Projects" message={`Couldn't load projects: ${error}`} />
        </div>
      )}

      {loading ? (
        <Loading label="projects">
          <SkeletonGrid count={4} columns={2} lines={2} />
        </Loading>
      ) : projects.length === 0 ? (
        <EmptyState>No projects found yet.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </Page>
  );
}
